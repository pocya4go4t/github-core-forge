// rest.ts: the GitHub REST v3 surface — repositories, branches, commits, contents, labels,
// issues, comments and pull requests — over the shared store. Handlers are pure functions of
// (store, request) returning {status, body, headers}; app.ts owns the socket, the auth gate
// and JSON parsing (a body that is not JSON is a 400 before routing, as GitHub answers).
//
// Shapes follow GitHub's: error bodies are {"message": ...}, a missing repository (or one
// addressed under another owner) is a 404, a duplicate repository name is a 422 whose text
// says "already exists", a stale contents sha is a 409, and list endpoints paginate with
// per_page/page and an absolute Link header, like GitHub's.

import {
  buildTreeFromFlat,
  commentJson,
  createIssueRec,
  createPullRec,
  diffCommits,
  flattenTree,
  issueJson,
  labelJson,
  mergePull,
  pullJson,
  repoJson,
  treeOfCommit,
  userJson,
  VIEWER,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Store,
} from './store.ts';
import { isTreeMode, parseTree } from './gitobj.ts';

/** A commit message as the REST API presents it: the stored text minus one trailing newline. */
function restMessage(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

/** "Name <email> ts +0000" as {name, email, date} for commit JSON. */
function identityJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> \d+ [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(/ (\d+) [+-]\d{4}$/.exec(line)?.[1] ?? 0) * 1000).toISOString() };
}

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3 (empty for the root). */
  segments: string[];
  /** The raw remainder after a fixed prefix, for routes whose tail is a path (contents, branch names). */
  rawPath: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** The request's absolute base for this route collection, e.g. http://127.0.0.1:5/api/v3/user/repos. */
  origin: string;
}

export interface RestResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const NOT_FOUND: RestResponse = { status: 404, body: { message: 'Not Found' } };

function error(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Slice one page out of a list and build GitHub's Link header for it. */
function paginate<T>(items: T[], req: RestRequest, pagePath: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, intParam(req.query, 'per_page', 30));
  const page = intParam(req.query, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const urlFor = (p: number): string => `${req.origin}${pagePath}?per_page=${perPage}&page=${p}`;
  if (start + perPage < items.length) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  }
  return { page: slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

// ------------------------------------------------------------------ entry point

export function handleRest(store: Store, req: RestRequest): RestResponse {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return NOT_FOUND;
    return ok(200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      user_url: '/api/v3/users/{user}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
    });
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return NOT_FOUND;
    return ok(200, { installed_version: '3.19.0-forge', verifiable_password_authentication: false, github_connect: false });
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return NOT_FOUND;
    return ok(200, userJson());
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') return listUserRepos(store, req, VIEWER.login);
    if (method === 'POST') return createUserRepo(store, req);
    return NOT_FOUND;
  }

  if (seg[0] === 'users' && seg[2] === 'repos' && seg.length === 3) {
    if (method !== 'GET') return NOT_FOUND;
    return listUserRepos(store, req, seg[1]!);
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = store.getRepo(seg[1]!, seg[2]!);
    if (repo === undefined) return NOT_FOUND;
    return handleRepo(store, repo, req, seg.slice(3));
  }

  return NOT_FOUND;
}

function listUserRepos(store: Store, req: RestRequest, owner: string): RestResponse {
  const repos = store.listRepos(owner).map(repoJson);
  const { page, headers } = paginate(repos, req, '/user/repos');
  return ok(200, page, headers);
}

function createUserRepo(store: Store, req: RestRequest): RestResponse {
  const name = str(req.body.name);
  if (name === undefined || name === '') return error(422, 'Repository creation failed: name is required');
  if (store.getRepo(VIEWER.login, name) !== undefined) {
    return error(422, `Repository creation failed: a repository named "${name}" already exists on this account`);
  }
  const repo = store.createRepo(VIEWER.login, name, {
    description: str(req.body.description) ?? '',
    isPrivate: req.body.private === true,
  });
  if (req.body.auto_init === true) {
    const blob = store.putObject('blob', Buffer.from(`# ${name}\n`, 'utf8'));
    const flat = new Map([['README.md', { mode: '100644', oid: blob }]]);
    const tree = buildTreeFromFlat(store, flat);
    store.commitTree(repo, repo.defaultBranch, tree, 'Initial commit', undefined);
  }
  return ok(201, repoJson(repo));
}

// ------------------------------------------------------------------ one repository

function handleRepo(store: Store, repo: RepoRec, req: RestRequest, rest: string[]): RestResponse {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      const description = str(req.body.description);
      if (description !== undefined) repo.description = description;
      if (typeof req.body.private === 'boolean') repo.isPrivate = req.body.private;
      const defaultBranch = str(req.body.default_branch);
      if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return NOT_FOUND;
  }

  const head = rest[0]!;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') return listBranches(store, repo);
    if (rest.length >= 2 && method === 'GET') return getBranch(store, repo, rest.slice(1).join('/'));
    return NOT_FOUND;
  }

  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') return listCommits(store, repo, req);
    return NOT_FOUND;
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(store, repo, req, path);
    if (method === 'PUT') return putContents(store, repo, req, path);
    if (method === 'DELETE') return deleteContents(store, repo, req, path);
    return NOT_FOUND;
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'POST') return createRef(store, repo, req);
      if (method === 'GET') return ok(200, [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: 'commit' } })));
      return NOT_FOUND;
    }
    if (method === 'GET') return getRef(repo, rest.slice(2).join('/'));
    return NOT_FOUND;
  }

  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') return ok(200, [...repo.labels.values()].map(labelJson));
      if (method === 'POST') {
        const name = str(req.body.name);
        if (name === undefined || name === '') return error(422, 'Validation Failed: name is required');
        if (repo.labels.has(name)) return error(422, `Validation Failed: a label named "${name}" already exists`);
        const label = { name, color: str(req.body.color) ?? 'ededed', description: str(req.body.description) ?? null };
        repo.labels.set(name, label);
        return ok(201, labelJson(label));
      }
      return NOT_FOUND;
    }
    if (rest.length === 2 && method === 'GET') {
      const label = repo.labels.get(rest[1]!);
      return label === undefined ? NOT_FOUND : ok(200, labelJson(label));
    }
    return NOT_FOUND;
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return listIssues(store, repo, req);
      if (method === 'POST') return createIssue(store, repo, req);
      return NOT_FOUND;
    }
    const number = Number.parseInt(rest[1]!, 10);
    const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) return NOT_FOUND;
      if (method === 'GET') return ok(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const state = str(req.body.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = str(req.body.title);
        if (title !== undefined) issue.title = title;
        const body = str(req.body.body);
        if (body !== undefined) issue.body = body;
        if (Array.isArray(req.body.labels)) {
          const names = req.body.labels.filter((entry): entry is string => typeof entry === 'string');
          for (const name of names) if (!repo.labels.has(name)) return error(422, `Validation Failed: label "${name}" does not exist`);
          issue.labels = names;
        }
        return ok(200, issueJson(repo, issue));
      }
      return NOT_FOUND;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return NOT_FOUND;
      if (method === 'GET') return ok(200, issue.comments.map((comment) => commentJson(repo, comment)));
      if (method === 'POST') {
        const body = str(req.body.body);
        if (body === undefined) return error(422, 'Validation Failed: body is required');
        const comment = { id: repo.nextCommentId, body, seq: store.tick() };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        return ok(201, commentJson(repo, comment));
      }
      return NOT_FOUND;
    }
    return NOT_FOUND;
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') return listPulls(store, repo, req);
      if (method === 'POST') return createPull(store, repo, req);
      return NOT_FOUND;
    }
    const number = Number.parseInt(rest[1]!, 10);
    const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2) {
      if (pull === undefined) return NOT_FOUND;
      if (method === 'GET') return ok(200, pullJson(repo, pull));
      return NOT_FOUND;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) return NOT_FOUND;
      return pullFiles(store, repo, pull);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return NOT_FOUND;
      return mergePullRequest(store, repo, pull, req);
    }
    return NOT_FOUND;
  }

  return NOT_FOUND;
}

// ------------------------------------------------------------------ branches, commits, refs

function branchJson(store: Store, repo: RepoRec, name: string, tip: string): Record<string, unknown> {
  const commit = store.commitOf(tip);
  return {
    name,
    sha: tip,
    commit: {
      sha: tip,
      commit: {
        message: commit === undefined ? '' : restMessage(commit.message),
        author: commit === undefined ? { name: '', email: '', date: '' } : identityJson(commit.author),
        committer: commit === undefined ? { name: '', email: '', date: '' } : identityJson(commit.committer),
      },
      author: { login: repo.owner },
      committer: { login: repo.owner },
    },
    protected: false,
  };
}

function listBranches(store: Store, repo: RepoRec): RestResponse {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) branches.push(branchJson(store, repo, ref.slice('refs/heads/'.length), oid));
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return ok(200, branches);
}

function getBranch(store: Store, repo: RepoRec, name: string): RestResponse {
  const tip = repo.refs.get(`refs/heads/${name}`);
  if (tip === undefined) return NOT_FOUND;
  return ok(200, branchJson(store, repo, name, tip));
}

function listCommits(store: Store, repo: RepoRec, req: RestRequest): RestResponse {
  const shaParam = req.query.get('sha');
  const tip = shaParam === null || shaParam === '' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : store.resolveRef(repo, shaParam);
  if (tip === undefined) return ok(200, []);
  const entries = store.listCommits(tip).map((oid) => {
    const commit = store.commitOf(oid)!;
    return {
      sha: oid,
      commit: {
        message: restMessage(commit.message),
        author: identityJson(commit.author),
        committer: identityJson(commit.committer),
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
      author: { login: repo.owner },
      committer: { login: repo.owner },
    };
  });
  const { page, headers } = paginate(entries, req, `/repos/${repo.owner}/${repo.name}/commits`);
  return ok(200, page, headers);
}

function createRef(store: Store, repo: RepoRec, req: RestRequest): RestResponse {
  const ref = str(req.body.ref);
  const sha = str(req.body.sha);
  if (ref === undefined || sha === undefined) return error(422, 'Validation Failed: ref and sha are required');
  const object = store.getObject(sha);
  if (object === undefined || object.type !== 'commit') return error(422, `Validation Failed: ${sha} is not a commit`);
  if (repo.refs.has(ref)) return error(422, `Validation Failed: reference ${ref} already exists`);
  repo.refs.set(ref, sha);
  return ok(201, { ref, object: { sha, type: 'commit' } });
}

function getRef(repo: RepoRec, tail: string): RestResponse {
  // The tail arrives as "heads/<branch...>" (from /git/refs/heads/...) or a full ref path.
  const full = tail.startsWith('refs/') ? tail : `refs/${tail}`;
  const oid = repo.refs.get(full);
  if (oid === undefined) return NOT_FOUND;
  return ok(200, { ref: full, object: { sha: oid, type: 'commit' } });
}

// ------------------------------------------------------------------ contents

/** The branch a contents call works on, its tip (branching from the default when new), and its flat tree. */
function contentsBase(store: Store, repo: RepoRec, branch: string): { tip: string | undefined; flat: Map<string, { mode: string; oid: string }> } {
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  if (tip === undefined) return { tip: undefined, flat: new Map() };
  const tree = treeOfCommit(store, tip);
  return { tip, flat: tree === undefined ? new Map() : flattenTree(store, tree) };
}

function getContents(store: Store, repo: RepoRec, req: RestRequest, path: string): RestResponse {
  const refParam = req.query.get('ref');
  const tip = refParam === null || refParam === '' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : store.resolveRef(repo, refParam);
  if (tip === undefined) return NOT_FOUND;
  const tree = treeOfCommit(store, tip);
  if (tree === undefined) return NOT_FOUND;
  if (path === '') return ok(200, dirListing(store, tree, ''));
  // A file at the exact path?
  const flat = flattenTree(store, tree);
  const entry = flat.get(path);
  if (entry !== undefined) {
    const object = store.getObject(entry.oid);
    if (object === undefined) return NOT_FOUND;
    return ok(200, {
      type: 'file',
      name: path.split('/').pop(),
      path,
      sha: entry.oid,
      size: object.data.length,
      encoding: 'base64',
      content: object.data.toString('base64'),
    });
  }
  // A directory?
  const listing = dirListing(store, tree, path);
  if (listing === null) return NOT_FOUND;
  return ok(200, listing);
}

/** The immediate children of `dirPath` in a tree ('' for the root), or null when not a directory. */
function dirListing(store: Store, rootTree: string, dirPath: string): Record<string, unknown>[] | null {
  let treeOid = rootTree;
  if (dirPath !== '') {
    let current = rootTree;
    for (const segment of dirPath.split('/')) {
      const object = store.getObject(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment && isTreeMode(candidate.mode));
      if (entry === undefined) return null;
      current = entry.oid;
    }
    treeOid = current;
  }
  const object = store.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return null;
  return parseTree(object.data).map((entry) => ({
    type: isTreeMode(entry.mode) ? 'dir' : 'file',
    name: entry.name,
    path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
    sha: entry.oid,
    size: isTreeMode(entry.mode) ? 0 : (store.getObject(entry.oid)?.data.length ?? 0),
  }));
}

function putContents(store: Store, repo: RepoRec, req: RestRequest, path: string): RestResponse {
  if (path === '') return error(422, 'Validation Failed: a file path is required');
  const content = str(req.body.content);
  const message = str(req.body.message);
  if (content === undefined || message === undefined) return error(422, 'Validation Failed: content and message are required');
  const branch = str(req.body.branch) ?? repo.defaultBranch;
  const { tip, flat } = contentsBase(store, repo, branch);
  const existing = flat.get(path);
  const shaParam = str(req.body.sha);
  if (existing !== undefined) {
    if (shaParam === undefined) return error(422, 'Validation Failed: sha is required when updating a file');
    if (shaParam !== existing.oid) return error(409, `${path} does not match ${shaParam}`);
  }
  const data = Buffer.from(content, 'base64');
  const blobOid = store.putObject('blob', data);
  flat.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
  const tree = buildTreeFromFlat(store, flat);
  const commitSha = store.commitTree(repo, branch, tree, message, tip);
  return ok(existing === undefined ? 201 : 200, {
    content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitSha, message },
  });
}

function deleteContents(store: Store, repo: RepoRec, req: RestRequest, path: string): RestResponse {
  const message = str(req.body.message);
  const sha = str(req.body.sha);
  if (message === undefined || sha === undefined) return error(422, 'Validation Failed: message and sha are required');
  const branch = str(req.body.branch) ?? repo.defaultBranch;
  const { tip, flat } = contentsBase(store, repo, branch);
  const existing = flat.get(path);
  if (existing === undefined || tip === undefined) return NOT_FOUND;
  if (sha !== existing.oid) return error(409, `${path} does not match ${sha}`);
  flat.delete(path);
  const tree = buildTreeFromFlat(store, flat);
  const commitSha = store.commitTree(repo, branch, tree, message, tip);
  return ok(200, { content: null, commit: { sha: commitSha, message } });
}

// ------------------------------------------------------------------ issues

function listIssues(store: Store, repo: RepoRec, req: RestRequest): RestResponse {
  const state = req.query.get('state') ?? 'open';
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  const labelFilter = req.query.get('labels');
  if (labelFilter !== null && labelFilter !== '') {
    const wanted = labelFilter.split(',').map((name) => name.trim());
    issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
  }
  void sort;
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { page, headers } = paginate(issues.map((issue) => issueJson(repo, issue)), req, `/repos/${repo.owner}/${repo.name}/issues`);
  return ok(200, page, headers);
}

function createIssue(store: Store, repo: RepoRec, req: RestRequest): RestResponse {
  const title = str(req.body.title);
  if (title === undefined || title === '') return error(422, 'Validation Failed: title is required');
  const labels: string[] = [];
  if (Array.isArray(req.body.labels)) {
    for (const entry of req.body.labels) {
      const name = typeof entry === 'string' ? entry : isRecord(entry) ? str(entry.name) : undefined;
      if (name === undefined) return error(422, 'Validation Failed: labels must be names');
      if (!repo.labels.has(name)) return error(422, `Validation Failed: label "${name}" does not exist`);
      labels.push(name);
    }
  }
  const issue = createIssueRec(store, repo, { title, body: str(req.body.body) ?? '', labels });
  return ok(201, issueJson(repo, issue));
}

// ------------------------------------------------------------------ pull requests

function listPulls(store: Store, repo: RepoRec, req: RestRequest): RestResponse {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => a.number - b.number);
  const { page, headers } = paginate(pulls.map((pull) => pullJson(repo, pull)), req, `/repos/${repo.owner}/${repo.name}/pulls`);
  return ok(200, page, headers);
}

function createPull(store: Store, repo: RepoRec, req: RestRequest): RestResponse {
  const title = str(req.body.title);
  const head = str(req.body.head);
  const base = str(req.body.base);
  if (title === undefined || head === undefined || base === undefined) {
    return error(422, 'Validation Failed: title, head and base are required');
  }
  const headBranch = head.includes(':') ? head.split(':').pop()! : head;
  const baseBranch = base.includes(':') ? base.split(':').pop()! : base;
  if (repo.refs.get(`refs/heads/${headBranch}`) === undefined) return error(422, `Validation Failed: head branch "${headBranch}" does not exist`);
  if (repo.refs.get(`refs/heads/${baseBranch}`) === undefined) return error(422, `Validation Failed: base branch "${baseBranch}" does not exist`);
  if (headBranch === baseBranch) return error(422, 'Validation Failed: head and base are the same branch');
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === headBranch && pull.baseRef === baseBranch) {
      return error(422, `Validation Failed: a pull request already exists for ${headBranch} into ${baseBranch}`);
    }
  }
  const pull = createPullRec(store, repo, { title, body: str(req.body.body) ?? '', headRef: headBranch, baseRef: baseBranch });
  return ok(201, pullJson(repo, pull));
}

function pullFiles(store: Store, repo: RepoRec, pull: PullRec): RestResponse {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return ok(200, []);
  const mergeBase = store.mergeBase(baseTip, headTip) ?? baseTip;
  const changes = diffCommits(store, mergeBase, headTip);
  return ok(
    200,
    changes.map((change) => {
      const headTree = treeOfCommit(store, headTip);
      const headFlat = headTree === undefined ? new Map() : flattenTree(store, headTree);
      return {
        filename: change.filename,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
        sha: headFlat.get(change.filename)?.oid ?? null,
      };
    }),
  );
}

function mergePullRequest(store: Store, repo: RepoRec, pull: PullRec, req: RestRequest): RestResponse {
  if (pull.merged) return error(405, 'Pull Request is not mergeable: it has already been merged');
  if (pull.state !== 'open') return error(405, 'Pull Request is not mergeable: it is closed');
  const method = str(req.body.merge_method) ?? 'merge';
  const sha = mergePull(store, repo, pull, method === 'merge' ? 'merge' : 'squash');
  if (sha === null) return error(405, 'Pull Request is not mergeable: merge conflict');
  return ok(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// Keep the type imports referenced for the module's public surface documentation.
export type { IssueRec, PullRec, RepoRec };
