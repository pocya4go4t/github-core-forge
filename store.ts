// store.ts: the forge's state and the operations every surface shares. One in-memory store:
// a global content-addressed object map (so a blob written through the REST contents API is
// the same object the git protocol serves), and per-repository records holding refs, labels,
// issues, pull requests and comments. REST, git smart HTTP, GraphQL and MCP all read and
// write through here, which is what makes the same issue number, repo id and commit sha show
// up identically on every surface.
//
// The forge has one user: the bearer token's owner. The trial's scenario fixes that identity
// (the env's wire.ts buildScenario: viewer id 1000), so it is a constant here, not a lookup.
// State a response prints is derived deterministically — REST-created commits and timestamps
// come from a fixed epoch plus per-repository counters, never from the wall clock — so two
// runs of the same request sequence produce the same bytes.

import {
  buildCommit,
  buildTree,
  hashObject,
  identityLine,
  isTreeMode,
  parseCommit,
  parseTree,
  type CommitInfo,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The fixed epoch REST-created commits and timestamps derive from (wire.ts's scenario epoch). */
export const EPOCH_SEC = 1735689600;

export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

// ------------------------------------------------------------------ records

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref names ('refs/heads/main') to commit oids. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
  /** Deterministic clock for commits and timestamps this repo creates through the API. */
  seq: number;
  createdSeq: number;
}

// ------------------------------------------------------------------ the store

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, RepoRec>();
  private readonly reposById = new Map<number, RepoRec>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private globalSeq = 0;

  /** The next value of the store-wide deterministic sequence. */
  tick(): number {
    this.globalSeq += 1;
    return this.globalSeq;
  }

  // ---- objects ----

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putExisting(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }

  // ---- repositories ----

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, init: { description?: string; isPrivate?: boolean }): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner,
      name,
      description: init.description ?? '',
      isPrivate: init.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: 0,
      createdSeq: this.tick(),
    };
    this.nextRepoId += 1;
    this.repos.set(Store.key(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  getRepoById(id: number): RepoRec | undefined {
    return this.reposById.get(id);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (repo === undefined) return false;
    this.repos.delete(Store.key(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  listRepos(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.createdSeq - b.createdSeq);
  }

  newIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  // ---- commits the API itself creates ----

  /**
   * Commit a whole new tree onto a branch with the given parent (undefined for a root
   * commit), creating or moving the branch ref. The author is the viewer; the timestamp is
   * the scenario epoch plus a per-repo counter, so the resulting sha is a pure function of
   * the request sequence.
   */
  commitTree(repo: RepoRec, branch: string, treeOid: string, message: string, parent: string | undefined): string {
    repo.seq += 1;
    const identity = identityLine(VIEWER.name, VIEWER.email, EPOCH_SEC + repo.seq);
    const commit = buildCommit({
      tree: treeOid,
      parents: parent === undefined ? [] : [parent],
      author: identity,
      committer: identity,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = this.putObject('commit', commit);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** The commit a ref or a branch name points at, or undefined. */
  resolveRef(repo: RepoRec, refOrBranch: string): string | undefined {
    if (/^[0-9a-f]{40}$/.test(refOrBranch)) {
      const object = this.objects.get(refOrBranch);
      return object !== undefined && object.type === 'commit' ? refOrBranch : undefined;
    }
    const full = refOrBranch.startsWith('refs/') ? refOrBranch : `refs/heads/${refOrBranch}`;
    return repo.refs.get(full);
  }

  commitOf(oid: string): CommitInfo | undefined {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  /** Every commit reachable from `tip` via parent links (tip included). */
  ancestors(tip: string, cutAt?: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const commit = this.commitOf(oid);
      if (commit === undefined) continue;
      seen.add(oid);
      if (cutAt !== undefined && cutAt.has(oid)) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(maybeAncestor: string, tip: string): boolean {
    return this.ancestors(tip).has(maybeAncestor);
  }

  /** A common ancestor of two commits (the one closest to `b` in BFS order), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = this.ancestors(a);
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const commit = this.commitOf(oid);
      if (commit !== undefined) queue.push(...commit.parents);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (author time, then discovery order). */
  listCommits(tip: string): string[] {
    const all = this.ancestors(tip);
    const times = new Map<string, number>();
    for (const oid of all) {
      const commit = this.commitOf(oid);
      const match = commit === undefined ? null : / (\d+) [+-]\d{4}$/.exec(commit.author);
      times.set(oid, match === null ? 0 : Number(match![1]));
    }
    // Topological order (children before parents), newest-first within a generation: walk
    // from the tip always expanding the unvisited parent with the largest timestamp.
    const ordered: string[] = [];
    const visited = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      let bestIndex = 0;
      for (let i = 1; i < stack.length; i += 1) {
        if ((times.get(stack[i]!) ?? 0) > (times.get(stack[bestIndex]!) ?? 0)) bestIndex = i;
      }
      const oid = stack.splice(bestIndex, 1)[0]!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      ordered.push(oid);
      const commit = this.commitOf(oid);
      if (commit !== undefined) for (const parent of commit.parents) if (!visited.has(parent)) stack.push(parent);
    }
    return ordered;
  }
}

// ------------------------------------------------------------------ trees as flat path maps

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree (by oid) into a map of slash paths to blob entries. */
export function flattenTree(store: Store, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.getObject(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isTreeMode(entry.mode)) walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) the tree hierarchy for a flat path map; answers the root tree oid. */
export function buildTreeFromFlat(store: Store, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]!;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.putObject('tree', buildTree(entries));
  };
  return build(root);
}

/** The flat entry at `path` in a commit's tree, or undefined. */
export function entryAtCommit(store: Store, commitOid: string, path: string): FlatEntry | undefined {
  const commit = store.commitOf(commitOid);
  if (commit === undefined) return undefined;
  return flattenTree(store, commit.tree).get(path);
}

/** The tree oid of a commit, or undefined. */
export function treeOfCommit(store: Store, commitOid: string): string | undefined {
  return store.commitOf(commitOid)?.tree;
}

// ------------------------------------------------------------------ merges and diffs

export type MergeOutcome = { ok: true; flat: Map<string, FlatEntry> } | { ok: false };

/**
 * A three-way merge of flattened trees: a path changed on only one side takes that side's
 * version; a path changed on both sides to the same blob is fine; changed to different
 * blobs (or changed on one side and deleted on the other) is a conflict.
 */
export function threeWayMerge(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): MergeOutcome {
  const merged = new Map<string, FlatEntry>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (o?.oid === t?.oid && o?.mode === t?.mode) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    if (b?.oid === o?.oid && b?.mode === o?.mode) {
      if (t !== undefined) merged.set(path, t);
      continue;
    }
    if (b?.oid === t?.oid && b?.mode === t?.mode) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    return { ok: false };
  }
  return { ok: true, flat: merged };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a blob (a final line without a newline still counts). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

/** An LCS line diff's (additions, deletions) between two texts; coarse fallback for big files. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // A trailing newline makes the last split element ''; drop exactly one such artefact each side.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  if (oldLines.length > 4000 || newLines.length > 4000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const m = oldLines.length;
  const n = newLines.length;
  const dp = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= n; j += 1) {
      const above = dp[j]!;
      if (oldLines[i - 1] === newLines[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j]!, dp[j - 1]!);
      diagonal = above;
    }
  }
  const common = dp[n]!;
  return { additions: n - common, deletions: m - common };
}

/** The changed files between two commits' trees (the pull-request files view). */
export function diffCommits(store: Store, baseCommit: string, headCommit: string): FileChange[] {
  const baseTree = treeOfCommit(store, baseCommit);
  const headTree = treeOfCommit(store, headCommit);
  const baseFlat = baseTree === undefined ? new Map<string, FlatEntry>() : flattenTree(store, baseTree);
  const headFlat = headTree === undefined ? new Map<string, FlatEntry>() : flattenTree(store, headTree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b?.oid === h?.oid) continue;
    const oldData = b === undefined ? undefined : store.getObject(b.oid)?.data;
    const newData = h === undefined ? undefined : store.getObject(h.oid)?.data;
    let additions = 0;
    let deletions = 0;
    if (b === undefined && newData !== undefined) {
      additions = countLines(newData);
    } else if (h === undefined && oldData !== undefined) {
      deletions = countLines(oldData);
    } else if (oldData !== undefined && newData !== undefined) {
      const diff = lineDiff(oldData.toString('utf8'), newData.toString('utf8'));
      additions = diff.additions;
      deletions = diff.deletions;
    }
    changes.push({
      filename: path,
      status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/**
 * Merge a pull request into its base branch: SQUASH makes one commit on the base whose tree
 * is the three-way merge; MERGE makes a two-parent merge commit with that tree. Returns the
 * new commit's sha, or null when the merge conflicts.
 */
export function mergePull(store: Store, repo: RepoRec, pull: PullRec, method: 'squash' | 'merge'): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return null;
  const base = store.mergeBase(baseTip, headTip) ?? baseTip;
  const baseFlat = flattenTree(store, treeOfCommit(store, base) ?? '');
  const oursFlat = flattenTree(store, treeOfCommit(store, baseTip) ?? '');
  const theirsFlat = flattenTree(store, treeOfCommit(store, headTip) ?? '');
  const outcome = threeWayMerge(baseFlat, oursFlat, theirsFlat);
  if (!outcome.ok) return null;
  const treeOid = buildTreeFromFlat(store, outcome.flat);
  repo.seq += 1;
  const identity = identityLine(VIEWER.name, VIEWER.email, EPOCH_SEC + repo.seq);
  const message =
    method === 'squash' ? `${pull.title} (#${pull.number})\n` : `Merge pull request #${pull.number} from ${pull.headRef}\n`;
  const commit = buildCommit({
    tree: treeOid,
    parents: method === 'squash' ? [baseTip] : [baseTip, headTip],
    author: identity,
    committer: identity,
    message,
  });
  const oid = store.putObject('commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAtSec = EPOCH_SEC + repo.seq;
  pull.mergeCommitSha = oid;
  return oid;
}

/** Whether a pull request would merge cleanly right now (GraphQL's `mergeable`). */
export function pullMergeable(store: Store, repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const base = store.mergeBase(baseTip, headTip) ?? baseTip;
  const outcome = threeWayMerge(
    flattenTree(store, treeOfCommit(store, base) ?? ''),
    flattenTree(store, treeOfCommit(store, baseTip) ?? ''),
    flattenTree(store, treeOfCommit(store, headTip) ?? ''),
  );
  return outcome.ok ? 'MERGEABLE' : 'CONFLICTING';
}

// ------------------------------------------------------------------ GitHub-shaped JSON

export function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${repo.owner}/${repo.name}.git`,
    created_at: isoOf(EPOCH_SEC + repo.createdSeq),
    updated_at: isoOf(EPOCH_SEC + repo.createdSeq),
    has_issues: true,
    fork: false,
    archived: false,
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: null })),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    author: { login: repo.owner, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOf(EPOCH_SEC + issue.seq),
    updated_at: isoOf(EPOCH_SEC + issue.seq),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: RepoRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    author: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: isoOf(EPOCH_SEC + comment.seq),
    updated_at: isoOf(EPOCH_SEC + comment.seq),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const json: Record<string, unknown> = {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAtSec === null ? null : isoOf(pull.mergedAtSec),
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    author: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: isoOf(EPOCH_SEC + pull.seq),
    updated_at: isoOf(EPOCH_SEC + pull.seq),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
  return json;
}

/** Create an issue record (shared by REST, GraphQL and MCP). */
export function createIssueRec(store: Store, repo: RepoRec, init: { title: string; body: string; labels?: string[] }): IssueRec {
  const issue: IssueRec = {
    number: repo.nextNumber,
    id: store.newIssueId(),
    title: init.title,
    body: init.body,
    state: 'open',
    labels: init.labels ?? [],
    comments: [],
    seq: store.tick(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request record (shared by REST, GraphQL and MCP). */
export function createPullRec(
  store: Store,
  repo: RepoRec,
  init: { title: string; body: string; headRef: string; baseRef: string },
): PullRec {
  const pull: PullRec = {
    number: repo.nextNumber,
    id: store.newIssueId(),
    title: init.title,
    body: init.body,
    state: 'open',
    headRef: init.headRef,
    baseRef: init.baseRef,
    merged: false,
    mergedAtSec: null,
    mergeCommitSha: null,
    seq: store.tick(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}
