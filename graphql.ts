// graphql.ts: the GraphQL v4 surface (POST /api/graphql) — a small but real GraphQL
// implementation (tokenizer, parser, executor) covering the documents gh and
// github-mcp-server send: viewer and repository reads, issue/pull-request connections with
// cursor pagination, the create/close/merge/comment mutations, Relay node(id:) reads,
// __type introspection, and operation batching (a JSON array of documents answered by an
// array of results, in order). It executes over the same store as REST, so ids are stable
// across surfaces: a repository's global id is an opaque encoding of its record id, never
// the plain databaseId.
//
// Error behaviour follows GitHub's: an unknown field is an HTTP 200 whose body carries an
// errors array naming the field (with partial data beside it); an unknown repository is
// data.repository = null with no errors. Authentication is the caller's job (401 first).

import {
  createIssueRec,
  createPullRec,
  diffCommits,
  isoOf,
  mergePull,
  pullMergeable,
  treeOfCommit,
  EPOCH_SEC,
  VIEWER,
  type CommentRec,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Store,
} from './store.ts';

// ------------------------------------------------------------------ tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1]!;
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            value += escapes[esc] ?? esc;
            j += 2;
          }
        } else {
          value += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// ------------------------------------------------------------------ AST and parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        let name: string | undefined;
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.atPunct('(')) {
          this.next();
          while (!this.atPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.atPunct('=')) {
              this.next();
              variableDefaults.set(varName, this.parseValue());
            }
            this.parseDirectives();
          }
          this.next();
        }
        this.parseDirectives();
        operations.push({ type: token.value, name, variableDefaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName();
        this.parseDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseDirectives(): FieldNode['directives'] {
    const directives: FieldNode['directives'] = [];
    while (this.atPunct('@')) {
      this.next();
      const name = this.expectName();
      const args = this.atPunct('(') ? this.parseArgs() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArgs(): FieldNode['args'] {
    this.expectPunct('(');
    const args: FieldNode['args'] = [];
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.next();
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name' && nextToken.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.parseDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'fragmentSpread', name: this.expectName() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | undefined;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args = this.atPunct('(') ? this.parseArgs() : [];
      const directives = this.parseDirectives();
      const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', alias, name, args, directives, selectionSet });
    }
    this.next();
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

// ------------------------------------------------------------------ global ids

function encodeId(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function decodeId(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

function repoGlobalId(repo: RepoRec): string {
  return encodeId(`R:${repo.id}`);
}

function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return encodeId(`I:${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return encodeId(`P:${repo.id}:${pull.number}`);
}

function commentGlobalId(repo: RepoRec, issueNumber: number, comment: CommentRec): string {
  return encodeId(`C:${repo.id}:${issueNumber}:${comment.id}`);
}

// ------------------------------------------------------------------ executor

/** A domain value tagged with its GraphQL type, so nested selections know how to resolve. */
interface GObj {
  __type: string;
  value: unknown;
}

function gobj(type: string, value: unknown): GObj {
  return { __type: type, value };
}

function isGObj(value: unknown): value is GObj {
  return typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>);
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  defaults: Map<string, ValueNode>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in ctx.variables) return ctx.variables[node.name];
      const fallback = ctx.defaults.get(node.name);
      return fallback === undefined ? undefined : resolveValue(fallback, ctx);
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx);
  return args;
}

function strArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  return typeof value === 'number' ? value : 0;
}

type Resolver = (ctx: Ctx, source: never, args: Record<string, unknown>) => unknown;

// The schema: one resolver map per type. The same key sets answer __type introspection,
// so the schema gh probes is exactly the schema that executes.
const FIELDS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => gobj('User', { login: VIEWER.login }),
    repository: (ctx, _source, args) => {
      const repo = ctx.store.getRepo(strArg(args, 'owner'), strArg(args, 'name'));
      return repo === undefined ? null : gobj('Repository', repo);
    },
    node: (ctx, _source, args) => nodeById(ctx, strArg(args, 'id')),
    __type: (_ctx, _source, args) => typeByName(strArg(args, 'name')),
    __schema: () => null,
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (repo === undefined) {
        ctx.errors.push({ message: 'createIssue: repository not found' });
        return null;
      }
      const issue = createIssueRec(ctx.store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return gobj('CreateIssuePayload', { repo, issue });
    },
    closeIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx, typeof input.issueId === 'string' ? input.issueId : '');
      if (found === undefined) {
        ctx.errors.push({ message: 'closeIssue: issue not found' });
        return null;
      }
      found.issue.state = 'closed';
      return gobj('CloseIssuePayload', found);
    },
    createPullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (repo === undefined) {
        ctx.errors.push({ message: 'createPullRequest: repository not found' });
        return null;
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        return null;
      }
      const pull = createPullRec(ctx.store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef: head,
        baseRef: base,
      });
      return gobj('CreatePullRequestPayload', { repo, pull });
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGlobalId(ctx, typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
      if (found === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
        return null;
      }
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const sha = mergePull(ctx.store, found.repo, found.pull, method === 'MERGE' ? 'merge' : 'squash');
      if (sha === null) {
        ctx.errors.push({ message: 'mergePullRequest: the pull request has conflicts' });
        return null;
      }
      return gobj('MergePullRequestPayload', found);
    },
    addComment: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx, typeof input.subjectId === 'string' ? input.subjectId : '');
      if (found === undefined) {
        ctx.errors.push({ message: 'addComment: subject not found' });
        return null;
      }
      const comment: CommentRec = {
        id: found.repo.nextCommentId,
        body: typeof input.body === 'string' ? input.body : '',
        seq: ctx.store.tick(),
      };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      return gobj('AddCommentPayload', { repo: found.repo, issue: found.issue, comment });
    },
  },
  User: {
    id: (_ctx, source) => encodeId(`U:${(source as { login: string }).login}`),
    login: (_ctx, source) => (source as { login: string }).login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: (_ctx, source) => `https://forge.invalid/${(source as { login: string }).login}`,
  },
  Repository: {
    id: (_ctx, source) => repoGlobalId(source as RepoRec),
    databaseId: (_ctx, source) => (source as RepoRec).id,
    name: (_ctx, source) => (source as RepoRec).name,
    nameWithOwner: (_ctx, source) => `${(source as RepoRec).owner}/${(source as RepoRec).name}`,
    description: (_ctx, source) => (source as RepoRec).description,
    isPrivate: (_ctx, source) => (source as RepoRec).isPrivate,
    owner: (_ctx, source) => gobj('User', { login: (source as RepoRec).owner }),
    defaultBranchRef: (_ctx, source) => {
      const repo = source as RepoRec;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? gobj('Ref', { name: repo.defaultBranch }) : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    url: (_ctx, source) => `https://forge.invalid/${(source as RepoRec).owner}/${(source as RepoRec).name}`,
    createdAt: (_ctx, source) => isoOf(EPOCH_SEC + (source as RepoRec).createdSeq),
    updatedAt: (_ctx, source) => isoOf(EPOCH_SEC + (source as RepoRec).createdSeq),
    issue: (_ctx, source, args) => {
      const repo = source as RepoRec;
      const issue = repo.issues.get(intArg(args, 'number'));
      return issue === undefined ? null : gobj('Issue', { repo, issue });
    },
    issues: (ctx, source, args) => issuesConnection(ctx, source as RepoRec, args),
    pullRequest: (_ctx, source, args) => {
      const repo = source as RepoRec;
      const pull = repo.pulls.get(intArg(args, 'number'));
      return pull === undefined ? null : gobj('PullRequest', { repo, pull });
    },
    pullRequests: (_ctx, source, args) => {
      const repo = source as RepoRec;
      const first = typeof args.first === 'number' ? args.first : 30;
      const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number).slice(0, first);
      return gobj('PullRequestConnection', {
        nodes: pulls.map((pull) => gobj('PullRequest', { repo, pull })),
        pageInfo: { hasNextPage: false, endCursor: null },
      });
    },
  },
  Ref: {
    name: (_ctx, source) => (source as { name: string }).name,
    target: (ctx, source) => {
      void ctx;
      void source;
      return null;
    },
  },
  Issue: {
    id: (_ctx, source) => issueGlobalId((source as { repo: RepoRec }).repo, (source as { issue: IssueRec }).issue),
    number: (_ctx, source) => (source as { issue: IssueRec }).issue.number,
    title: (_ctx, source) => (source as { issue: IssueRec }).issue.title,
    body: (_ctx, source) => (source as { issue: IssueRec }).issue.body,
    state: (_ctx, source) => ((source as { issue: IssueRec }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    url: (_ctx, source) => {
      const { repo, issue } = source as { repo: RepoRec; issue: IssueRec };
      return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
    createdAt: (_ctx, source) => isoOf(EPOCH_SEC + (source as { issue: IssueRec }).issue.seq),
    updatedAt: (_ctx, source) => isoOf(EPOCH_SEC + (source as { issue: IssueRec }).issue.seq),
    author: (_ctx, source) => gobj('User', { login: (source as { repo: RepoRec }).repo.owner }),
    labels: (_ctx, source) => {
      const { repo, issue } = source as { repo: RepoRec; issue: IssueRec };
      return gobj('LabelConnection', { nodes: issue.labels.map((name) => gobj('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' })) });
    },
  },
  Label: {
    name: (_ctx, source) => (source as { name: string }).name,
    color: (_ctx, source) => (source as { color: string }).color,
  },
  LabelConnection: {
    nodes: (_ctx, source) => (source as { nodes: GObj[] }).nodes,
    totalCount: (_ctx, source) => (source as { nodes: GObj[] }).nodes.length,
  },
  IssueConnection: {
    nodes: (_ctx, source) => (source as { nodes: GObj[] }).nodes,
    pageInfo: (_ctx, source) => gobj('PageInfo', (source as { pageInfo: unknown }).pageInfo),
    totalCount: (_ctx, source) => (source as { totalCount: number }).totalCount,
  },
  PageInfo: {
    hasNextPage: (_ctx, source) => (source as { hasNextPage: boolean }).hasNextPage,
    endCursor: (_ctx, source) => (source as { endCursor: string | null }).endCursor,
    hasPreviousPage: () => false,
    startCursor: (_ctx, source) => (source as { endCursor: string | null }).endCursor,
  },
  PullRequest: {
    id: (_ctx, source) => pullGlobalId((source as { repo: RepoRec }).repo, (source as { pull: PullRec }).pull),
    number: (_ctx, source) => (source as { pull: PullRec }).pull.number,
    title: (_ctx, source) => (source as { pull: PullRec }).pull.title,
    body: (_ctx, source) => (source as { pull: PullRec }).pull.body,
    state: (_ctx, source) => {
      const pull = (source as { pull: PullRec }).pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (_ctx, source) => (source as { pull: PullRec }).pull.merged,
    mergeable: (ctx, source) => {
      const { repo, pull } = source as { repo: RepoRec; pull: PullRec };
      return pullMergeable(ctx.store, repo, pull);
    },
    headRefName: (_ctx, source) => (source as { pull: PullRec }).pull.headRef,
    baseRefName: (_ctx, source) => (source as { pull: PullRec }).pull.baseRef,
    headRef: (_ctx, source) => gobj('Ref', { name: (source as { pull: PullRec }).pull.headRef }),
    baseRef: (_ctx, source) => gobj('Ref', { name: (source as { pull: PullRec }).pull.baseRef }),
    url: (_ctx, source) => {
      const { repo, pull } = source as { repo: RepoRec; pull: PullRec };
      return `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
    },
    createdAt: (_ctx, source) => isoOf(EPOCH_SEC + (source as { pull: PullRec }).pull.seq),
    updatedAt: (_ctx, source) => isoOf(EPOCH_SEC + (source as { pull: PullRec }).pull.seq),
    author: (_ctx, source) => gobj('User', { login: (source as { repo: RepoRec }).repo.owner }),
    files: (_ctx, source, args) => {
      const { repo, pull } = source as { repo: RepoRec; pull: PullRec };
      const first = typeof args.first === 'number' ? args.first : 30;
      return gobj('PullRequestChangedFileConnection', { repo, pull, first });
    },
    mergeCommit: () => null,
  },
  PullRequestConnection: {
    nodes: (_ctx, source) => (source as { nodes: GObj[] }).nodes,
    pageInfo: (_ctx, source) => gobj('PageInfo', (source as { pageInfo: unknown }).pageInfo),
    totalCount: (_ctx, source) => (source as { nodes: GObj[] }).nodes.length,
  },
  PullRequestChangedFileConnection: {
    nodes: (ctx, source) => {
      const { repo, pull, first } = source as { repo: RepoRec; pull: PullRec; first: number };
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (headTip === undefined || baseTip === undefined) return [];
      const mergeBase = ctx.store.mergeBase(baseTip, headTip) ?? baseTip;
      return diffCommits(ctx.store, mergeBase, headTip)
        .slice(0, first)
        .map((change) => gobj('PullRequestChangedFile', { path: change.filename, additions: change.additions, deletions: change.deletions }));
    },
    totalCount: (ctx, source) => {
      const { repo, pull } = source as { repo: RepoRec; pull: PullRec };
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (headTip === undefined || baseTip === undefined) return 0;
      const mergeBase = ctx.store.mergeBase(baseTip, headTip) ?? baseTip;
      void treeOfCommit;
      return diffCommits(ctx.store, mergeBase, headTip).length;
    },
  },
  PullRequestChangedFile: {
    path: (_ctx, source) => (source as { path: string }).path,
    additions: (_ctx, source) => (source as { additions: number }).additions,
    deletions: (_ctx, source) => (source as { deletions: number }).deletions,
  },
  Comment: {
    id: (_ctx, source) => {
      const { repo, issueNumber, comment } = source as { repo: RepoRec; issueNumber: number; comment: CommentRec };
      return commentGlobalId(repo, issueNumber, comment);
    },
    body: (_ctx, source) => (source as { comment: CommentRec }).comment.body,
    createdAt: (_ctx, source) => isoOf(EPOCH_SEC + (source as { comment: CommentRec }).comment.seq),
    author: (_ctx, source) => gobj('User', { login: (source as { repo: RepoRec }).repo.owner }),
  },
  CreateIssuePayload: {
    issue: (_ctx, source) => gobj('Issue', source as { repo: RepoRec; issue: IssueRec }),
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (_ctx, source) => gobj('Issue', source as { repo: RepoRec; issue: IssueRec }),
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, source) => gobj('PullRequest', source as { repo: RepoRec; pull: PullRec }),
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, source) => gobj('PullRequest', source as { repo: RepoRec; pull: PullRec }),
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, source) => gobj('CommentEdge', source as { repo: RepoRec; issue: IssueRec; comment: CommentRec }),
    clientMutationId: () => null,
  },
  CommentEdge: {
    node: (_ctx, source) => {
      const { repo, issue, comment } = source as { repo: RepoRec; issue: IssueRec; comment: CommentRec };
      return gobj('Comment', { repo, issueNumber: issue.number, comment });
    },
    cursor: () => '',
  },
  __Type: {
    name: (_ctx, source) => (source as { name: string }).name,
    kind: (_ctx, source) => (source as { kind: string }).kind,
    description: () => null,
    fields: (_ctx, source) => {
      const descriptor = source as { name: string; kind: string };
      if (descriptor.kind !== 'OBJECT') return null;
      const fields = FIELDS[descriptor.name];
      if (fields === undefined) return [];
      return Object.keys(fields).map((name) => gobj('__Field', { name }));
    },
    enumValues: (_ctx, source) => {
      const descriptor = source as { name: string; kind: string };
      if (descriptor.kind !== 'ENUM') return null;
      return (ENUMS[descriptor.name] ?? []).map((name) => gobj('__EnumValue', { name }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    interfaces: () => [],
    ofType: () => null,
  },
  __Field: {
    name: (_ctx, source) => (source as { name: string }).name,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (_ctx, source) => (source as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function typeByName(name: string): GObj | null {
  if (name in FIELDS) return gobj('__Type', { name, kind: 'OBJECT' });
  if (name in ENUMS) return gobj('__Type', { name, kind: 'ENUM' });
  if (SCALARS.has(name)) return gobj('__Type', { name, kind: 'SCALAR' });
  if (name === 'Node') return gobj('__Type', { name, kind: 'INTERFACE' });
  return null;
}

function repoByGlobalId(ctx: Ctx, id: string): RepoRec | undefined {
  const parts = decodeId(id);
  if (parts === null || parts[0] !== 'R') return undefined;
  return ctx.store.getRepoById(Number(parts[1]));
}

function issueByGlobalId(ctx: Ctx, id: string): { repo: RepoRec; issue: IssueRec } | undefined {
  const parts = decodeId(id);
  if (parts === null || parts[0] !== 'I') return undefined;
  const repo = ctx.store.getRepoById(Number(parts[1]));
  const issue = repo?.issues.get(Number(parts[2]));
  return repo === undefined || issue === undefined ? undefined : { repo, issue };
}

function pullByGlobalId(ctx: Ctx, id: string): { repo: RepoRec; pull: PullRec } | undefined {
  const parts = decodeId(id);
  if (parts === null || parts[0] !== 'P') return undefined;
  const repo = ctx.store.getRepoById(Number(parts[1]));
  const pull = repo?.pulls.get(Number(parts[2]));
  return repo === undefined || pull === undefined ? undefined : { repo, pull };
}

function nodeById(ctx: Ctx, id: string): GObj | null {
  const parts = decodeId(id);
  if (parts === null) return null;
  if (parts[0] === 'R') {
    const repo = ctx.store.getRepoById(Number(parts[1]));
    return repo === undefined ? null : gobj('Repository', repo);
  }
  if (parts[0] === 'I') {
    const found = issueByGlobalId(ctx, id);
    return found === undefined ? null : gobj('Issue', found);
  }
  if (parts[0] === 'P') {
    const found = pullByGlobalId(ctx, id);
    return found === undefined ? null : gobj('PullRequest', found);
  }
  if (parts[0] === 'U') return gobj('User', { login: parts[1]! });
  return null;
}

function issuesConnection(ctx: Ctx, repo: RepoRec, args: Record<string, unknown>): GObj {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const totalCount = issues.length;
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64url').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match !== null) start = Number(match[1]) + 1;
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = issues.slice(start, start + first);
  const hasNextPage = start + page.length < totalCount;
  const endCursor = page.length > 0 ? encodeId(`cursor:${start + page.length - 1}`) : null;
  return gobj('IssueConnection', {
    nodes: page.map((issue) => gobj('Issue', { repo, issue })),
    pageInfo: { hasNextPage, endCursor },
    totalCount,
  });
}

function completeValue(value: unknown, selectionSet: SelectionNode[] | undefined, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selectionSet, ctx));
  if (isGObj(value)) {
    if (selectionSet === undefined) return null;
    const out: Record<string, unknown> = {};
    executeSelections(value.__type, value.value, selectionSet, ctx, out);
    return out;
  }
  return value;
}

function executeSelections(typeName: string, source: unknown, selections: SelectionNode[], ctx: Ctx, out: Record<string, unknown>): void {
  const typeFields = FIELDS[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        executeSelections(typeName, source, selection.selectionSet, ctx, out);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) executeSelections(typeName, source, fragment, ctx, out);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    let skipped = false;
    for (const directive of selection.directives) {
      const ifArg = directive.args.find((arg) => arg.name === 'if');
      const flag = ifArg === undefined ? undefined : resolveValue(ifArg.value, ctx);
      if (directive.name === 'skip' && flag === true) skipped = true;
      if (directive.name === 'include' && flag === false) skipped = true;
    }
    if (skipped) continue;
    const resolver = typeFields[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const value = (resolver as (ctx: Ctx, source: unknown, args: Record<string, unknown>) => unknown)(ctx, source, argsOf(selection, ctx));
    out[key] = completeValue(value, selection.selectionSet, ctx);
  }
}

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>, fragments: Map<string, SelectionNode[]>): Record<string, unknown> {
  const ctx: Ctx = { store, variables, defaults: operation.variableDefaults, fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  executeSelections(rootType, null, operation.selectionSet, ctx, data);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return body;
}

function executeOne(store: Store, entry: Record<string, unknown>): Record<string, unknown> {
  const query = typeof entry.query === 'string' ? entry.query : '';
  const variables = (typeof entry.variables === 'object' && entry.variables !== null ? entry.variables : {}) as Record<string, unknown>;
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Syntax error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'the document holds no operation' }] };
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
  const operation =
    operationName === undefined ? document.operations[0]! : document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0]!;
  return executeOperation(store, operation, variables, document.fragments);
}

/** Handle one POST /api/graphql body (auth has already been checked by the caller). */
export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(store, (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>)) };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { errors: [{ message: 'the request body must be a JSON object or an array of operations' }] } };
  }
  return { status: 200, body: executeOne(store, body as Record<string, unknown>) };
}
