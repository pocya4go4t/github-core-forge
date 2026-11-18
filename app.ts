// app.ts: the forge's HTTP server. It owns the socket concerns the surface modules do
// not: reading bodies, the bearer-token gate, the X-GitHub-Request-Id every response
// carries, JSON (de)serialization, and routing between the four surfaces — REST v3
// (rest.ts), git smart HTTP (githttp.ts), GraphQL v4 (graphql.ts) and MCP (mcp.ts) — all
// over one shared store (store.ts), plus GET /healthz for the env's boot probe and a JSON
// 404 for everything else.
//
// Auth: the env presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` on every API call.
// A missing header is 401 "Requires authentication"; a wrong token is 401 "Bad
// credentials". /healthz is the only open route. When the token variable is unset (local
// development), any non-empty bearer token is accepted so the surface stays testable.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGitHttp } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

type AuthVerdict = 'ok' | 'missing' | 'wrong';

function authVerdict(req: IncomingMessage): AuthVerdict {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return 'missing';
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return header === `Bearer ${expected}` ? 'ok' : 'wrong';
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length ? 'ok' : 'wrong';
}

function refuseAuth(res: ServerResponse, verdict: AuthVerdict): void {
  sendJson(res, 401, { message: verdict === 'missing' ? 'Requires authentication' : 'Bad credentials' });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    res.setHeader('x-github-request-id', requestCounter.toString(16).padStart(8, '0').toUpperCase());
    void handle(store, req, res).catch(() => {
      // A handler bug must answer, never hang: the suite's per-check timeout would
      // otherwise eat the whole conformance budget on one route.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The peer is gone; nothing left to answer.
      }
    });
  });
  return server;
}

async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let pathname: string;
  let query: URLSearchParams;
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    pathname = '/';
    query = new URLSearchParams();
  }
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  // The env's boot probe: open, 200 {"ok":true}.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const rawBody = needsBody ? await readBody(req) : Buffer.alloc(0);

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const verdict = authVerdict(req);
    if (verdict !== 'ok') {
      refuseAuth(res, verdict);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'the request body is not JSON' }] });
      return;
    }
    const outcome = handleGraphQL(store, parsed);
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  // MCP over streamable HTTP.
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const verdict = authVerdict(req);
    if (verdict !== 'ok') {
      refuseAuth(res, verdict);
      return;
    }
    const outcome = handleMcp(store, rawBody.toString('utf8'));
    if (outcome.body === undefined) {
      res.writeHead(outcome.status);
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const verdict = authVerdict(req);
    if (verdict !== 'ok') {
      refuseAuth(res, verdict);
      return;
    }
    let body: Record<string, unknown> = {};
    if (rawBody.length > 0) {
      try {
        const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const segments = pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    const host = req.headers.host ?? '127.0.0.1';
    const outcome = handleRest(store, {
      method,
      segments,
      rawPath: pathname,
      query,
      body,
      origin: `http://${host}/api/v3`,
    });
    const headers: Record<string, string> = { ...(outcome.headers ?? {}) };
    if (segments.length === 0 && method === 'GET') headers['x-oauth-scopes'] = 'repo, read:org';
    sendJson(res, outcome.status, outcome.body, headers);
    return;
  }

  // Git smart HTTP.
  const gitMatch = GIT_PATH.exec(pathname);
  if (gitMatch !== null) {
    const verdict = authVerdict(req);
    if (verdict !== 'ok') {
      refuseAuth(res, verdict);
      return;
    }
    const outcome = handleGitHttp(store, {
      method,
      owner: decodeSegment(gitMatch[1]!),
      repo: decodeSegment(gitMatch[2]!),
      tail: gitMatch[3]!,
      query,
      gitProtocol: req.headers['git-protocol'] ?? '',
      body: rawBody,
    });
    sendBuffer(res, outcome.status, outcome.contentType, outcome.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
