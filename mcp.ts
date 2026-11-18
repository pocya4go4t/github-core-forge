// mcp.ts: the Model Context Protocol endpoint (POST /mcp, streamable HTTP, plain JSON
// answers). Both protocol eras are served: the modern one, where server/discover answers
// identity, capabilities and supportedVersions in one request and every later request is
// self-describing, and the legacy handshake era (initialize + notifications/initialized,
// 2025-11-25 and earlier). There are no sessions: every request stands alone, which both
// eras permit a server to do.
//
// The six tools are the forge's own operations over the same store REST serves, so an
// object created over MCP reads back over REST with the same id (the suite checks exactly
// that). tools/list is built once and returned as the same object every time, so two calls
// are byte-identical. Errors follow JSON-RPC: an unknown tool or missing required
// arguments are -32602, an unknown method -32601, and a body that is not JSON is an
// HTTP 400 carrying -32700 (app.ts has already answered 401 before this module runs when
// the Authorization header is missing or wrong).

import {
  createIssueRec,
  createPullRec,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
  VIEWER,
  type RepoRec,
  type Store,
} from './store.ts';

export interface McpOutcome {
  status: number;
  /** The JSON body to send; undefined answers with an empty body (notifications). */
  body?: unknown;
}

const SERVER_INFO = Object.freeze({ name: 'github-core-forge', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (store: Store, args: Record<string, unknown>) => Record<string, unknown> | unknown[];
}

function argString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function repoOrError(store: Store, args: Record<string, unknown>): RepoRec | string {
  const owner = argString(args, 'owner');
  const repo = argString(args, 'repo');
  if (owner === undefined || repo === undefined) return 'owner and repo are required';
  const found = store.getRepo(owner, repo);
  return found === undefined ? `repository ${owner}/${repo} not found` : found;
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run(store, args) {
      const name = argString(args, 'name')!;
      if (store.getRepo(VIEWER.login, name) !== undefined) throw new Error(`a repository named "${name}" already exists`);
      const repo = store.createRepo(VIEWER.login, name, {
        description: argString(args, 'description') ?? '',
        isPrivate: args.private === true,
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run(store, args) {
      const repo = repoOrError(store, args);
      if (typeof repo === 'string') throw new Error(repo);
      return repoJson(repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run(store, args) {
      const repo = repoOrError(store, args);
      if (typeof repo === 'string') throw new Error(repo);
      const issue = createIssueRec(store, repo, { title: argString(args, 'title')!, body: argString(args, 'body') ?? '' });
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\u2019s issues, optionally filtered by state (open, closed or all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
    run(store, args) {
      const repo = repoOrError(store, args);
      if (typeof repo === 'string') throw new Error(repo);
      const state = argString(args, 'state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return issues.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run(store, args) {
      const repo = repoOrError(store, args);
      if (typeof repo === 'string') throw new Error(repo);
      const head = argString(args, 'head')!;
      const base = argString(args, 'base')!;
      if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new Error(`head branch "${head}" does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new Error(`base branch "${base}" does not exist`);
      const pull = createPullRec(store, repo, {
        title: argString(args, 'title')!,
        body: argString(args, 'body') ?? '',
        headRef: head,
        baseRef: base,
      });
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run(store, args) {
      const repo = repoOrError(store, args);
      if (typeof repo === 'string') throw new Error(repo);
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) throw new Error(`pull request ${String(raw)} not found`);
      if (pull.merged) throw new Error(`pull request #${pull.number} is already merged`);
      const sha = mergePull(store, repo, pull, 'squash');
      if (sha === null) throw new Error(`pull request #${pull.number} has merge conflicts`);
      return { ...pullJson(repo, pull), sha };
    },
  },
]);

/** The tools/list answer: one frozen object, so every call serializes byte-identically. */
const TOOLS_LIST_RESULT = Object.freeze({
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
});

function rpcResult(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown, isError: boolean): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  else result.structuredContent = value;
  return result;
}

function callTool(store: Store, id: unknown, params: Record<string, unknown>): McpOutcome {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name === '' ? '(missing name)' : name}`);
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return rpcError(id, -32602, `Missing required argument: ${required}`);
    }
  }
  try {
    return rpcResult(id, toolResult(tool.run(store, args), false));
  } catch (error) {
    return rpcResult(id, toolResult(error instanceof Error ? error.message : String(error), true));
  }
}

function dispatch(store: Store, request: Record<string, unknown>): McpOutcome | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined || method.startsWith('notifications/');
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call':
      return callTool(store, id, params);
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one POST /mcp body (auth has already been checked by the caller). */
export function handleMcp(store: Store, rawBody: string): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON' } },
    };
  }
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const outcome = dispatch(store, entry as Record<string, unknown>);
      if (outcome !== null && outcome.body !== undefined) answers.push(outcome.body);
    }
    return { status: 200, body: answers };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const outcome = dispatch(store, parsed as Record<string, unknown>);
  if (outcome === null || outcome.body === undefined) return { status: 202 };
  return outcome;
}
