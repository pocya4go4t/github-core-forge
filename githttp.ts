// githttp.ts: git smart HTTP — info/refs advertisements (protocol v0 and v2), ls-refs,
// fetch (v2 command protocol, plus the v0 form) and receive-pack pushes, all over the
// shared object store. Packs carry plain full objects only; deltas are accepted on push
// (parsePack resolves them) but never sent, which the protocol allows and keeps fetch
// byte-simple. Fetch computes the exact object closure difference — reachable(wants)
// minus reachable(haves), with the client's shallow list cutting both traversals and a
// deepen request bounding the want walk by parent distance — so an incremental fetch
// re-sends zero objects the client already holds, and a depth-1 clone of a long history
// ships only the tip commit and its tree.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  parsePack,
  pktLine,
  readPktLines,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { treeOfCommit, type RepoRec, type Store } from './store.ts';

export interface GitHttpRequest {
  method: string;
  owner: string;
  repo: string;
  /** 'info/refs' | 'git-upload-pack' | 'git-receive-pack' */
  tail: string;
  query: URLSearchParams;
  gitProtocol: string;
  body: Buffer;
}

export interface GitHttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'github-core-forge/1.0.0';
const UPLOAD_CAPS = `multi_ack_detailed side-band-64k ofs-delta thin-pack shallow agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function jsonError(status: number, message: string): GitHttpResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function textError(status: number, message: string): GitHttpResponse {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(message, 'utf8') };
}

export function handleGitHttp(store: Store, req: GitHttpRequest): GitHttpResponse {
  const repo = store.getRepo(req.owner, req.repo);
  if (repo === undefined) return jsonError(404, 'Not Found');

  if (req.tail === 'info/refs') {
    if (req.method !== 'GET') return textError(405, 'method not allowed');
    const service = req.query.get('service');
    if (service === 'git-upload-pack') return advertiseUpload(store, repo, req);
    if (service === 'git-receive-pack') return advertiseReceive(store, repo);
    return textError(400, 'service parameter required');
  }
  if (req.tail === 'git-upload-pack') {
    if (req.method !== 'POST') return textError(405, 'method not allowed');
    return uploadPack(store, repo, req);
  }
  if (req.tail === 'git-receive-pack') {
    if (req.method !== 'POST') return textError(405, 'method not allowed');
    return receivePack(store, repo, req);
  }
  return jsonError(404, 'Not Found');
}

// ------------------------------------------------------------------ advertisements

/** All refs in advertisement order: name-sorted, with peeled lines after annotated tags. */
function advertisedRefs(store: Store, repo: RepoRec): Array<{ name: string; oid: string; peeled?: string }> {
  const refs: Array<{ name: string; oid: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = store.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match !== null) entry.peeled = match[1]!;
    }
    refs.push(entry);
  }
  return refs;
}

/** The v0 advertisement body shared by both services: preamble, flush, ref lines, flush. */
function v0Advertisement(store: Store, repo: RepoRec, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const capsWithSymref = service === 'git-upload-pack' ? `${caps} symref=HEAD:${headRef}` : caps;
  if (headOid !== undefined) {
    parts.push(pktLine(`${headOid} HEAD\0${capsWithSymref}\n`));
  } else {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capsWithSymref}\n`));
  }
  for (const ref of advertisedRefs(store, repo)) {
    parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertiseUpload(store: Store, repo: RepoRec, req: GitHttpRequest): GitHttpResponse {
  if (req.gitProtocol.split(':').includes('version=2')) {
    const lines = [
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow thin-pack ofs-delta\n',
      'object-format=sha1\n',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-advertisement',
    body: v0Advertisement(store, repo, 'git-upload-pack', UPLOAD_CAPS),
  };
}

function advertiseReceive(store: Store, repo: RepoRec): GitHttpResponse {
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-advertisement',
    body: v0Advertisement(store, repo, 'git-receive-pack', RECEIVE_CAPS),
  };
}

// ------------------------------------------------------------------ upload-pack dispatch

function uploadPack(store: Store, repo: RepoRec, req: GitHttpRequest): GitHttpResponse {
  try {
    if (req.gitProtocol.split(':').includes('version=2')) return uploadPackV2(store, repo, req.body);
    return uploadPackV0(store, repo, req.body);
  } catch (error) {
    // A malformed body must never take the server down; the protocol has no error frame
    // mid-request, so answer a plain 400 and stay healthy.
    return textError(400, `upload-pack: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): V2Request {
  const { frames } = readPktLines(body);
  let command = '';
  const args: string[] = [];
  let phase: 'command' | 'caps' | 'args' = 'command';
  for (const frame of frames) {
    if (frame.kind === 'delim') {
      phase = 'args';
      continue;
    }
    if (frame.kind === 'flush' || frame.kind === 'end') break;
    const line = frame.data.toString('utf8').replace(/\n$/, '');
    if (phase === 'command') {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      phase = 'caps';
    } else if (phase === 'args') {
      args.push(line);
    }
  }
  return { command, args };
}

function uploadPackV2(store: Store, repo: RepoRec, body: Buffer): GitHttpResponse {
  const request = parseV2Request(body);
  if (request.command === 'ls-refs') {
    const lines = lsRefs(store, repo, request.args);
    const out = Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: out };
  }
  if (request.command === 'fetch') {
    const plan = planFetch(store, repo, parseFetchArgs(request.args));
    const parts: Buffer[] = [];
    const ackLines = plan.acks.length > 0 ? plan.acks.map((oid) => `ACK ${oid}\n`) : ['NAK\n'];
    parts.push(pktLine('acknowledgments\n'), ...ackLines.map((line) => pktLine(line)), PKT_DELIM);
    if (plan.shallowLines.length > 0 || plan.unshallowLines.length > 0 || plan.hadShallowArgs) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(plan.pack));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  return textError(400, `unknown command ${request.command}`);
}

/** Chunk pack bytes into band-1 sideband packets (payload at most 65515 bytes each). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    packets.push(pktLine(payload));
  }
  return packets;
}

// ------------------------------------------------------------------ ls-refs

function lsRefs(store: Store, repo: RepoRec, args: string[]): string[] {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(symrefs ? `${headOid} HEAD symref-target:${headRef}\n` : `${headOid} HEAD\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${headRef}\n`);
    }
  }
  for (const ref of advertisedRefs(store, repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return lines;
}

// ------------------------------------------------------------------ fetch planning

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const value = Number.parseInt(arg.slice(7), 10);
      if (Number.isFinite(value) && value > 0) parsed.deepen = value;
    }
  }
  return parsed;
}

interface FetchPlan {
  pack: Buffer;
  acks: string[];
  shallowLines: string[];
  unshallowLines: string[];
  hadShallowArgs: boolean;
}

/** Add a commit's full tree closure (trees and blobs) to a set of object ids. */
function addTreeClosure(store: Store, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const object = store.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  into.add(treeOid);
  const text = object.data;
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(0x20, offset);
    const nul = text.indexOf(0x00, space);
    const mode = text.toString('ascii', offset, space);
    const oid = text.toString('hex', nul + 1, nul + 21);
    if (mode === '40000' || mode === '040000') addTreeClosure(store, oid, into);
    else into.add(oid);
    offset = nul + 21;
  }
}

function planFetch(store: Store, repo: RepoRec, args: FetchArgs): FetchPlan {
  void repo; // Refs live on the repo, but the object closure math is store-wide by design.
  const shallowDeclared = new Set(args.shallow.filter((oid) => store.commitOf(oid) !== undefined));
  // A want may name an annotated tag object rather than a commit: the tag itself is sent,
  // and its target commit joins the want roots.
  const tagWants: string[] = [];
  const wants: string[] = [];
  for (const oid of args.wants) {
    if (store.commitOf(oid) !== undefined) {
      wants.push(oid);
      continue;
    }
    const object = store.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      tagWants.push(oid);
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match !== null && store.commitOf(match[1]!) !== undefined) wants.push(match[1]!);
    }
  }

  // What the client already holds: haves plus its shallow commits, with commit traversal
  // cut at the shallow boundary (a shallow commit's parents are not held).
  const haveCommits = new Set<string>();
  {
    const stack = [...args.haves, ...shallowDeclared];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (haveCommits.has(oid)) continue;
      const commit = store.commitOf(oid);
      if (commit === undefined) continue;
      haveCommits.add(oid);
      if (shallowDeclared.has(oid)) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
  }
  const haveObjects = new Set<string>();
  for (const oid of haveCommits) {
    haveObjects.add(oid);
    const tree = treeOfCommit(store, oid);
    if (tree !== undefined) addTreeClosure(store, tree, haveObjects);
  }

  // What the client asked for: with a deepen bound, commits whose parent distance from a
  // want tip is below the bound; otherwise the full closure, cut at the shallow boundary
  // the client declared (its history ends there unless it asks to deepen).
  const wantCommits = new Set<string>();
  if (args.deepen !== null) {
    const depth = args.deepen;
    const distance = new Map<string, number>();
    const queue: Array<{ oid: string; dist: number }> = wants.map((oid) => ({ oid, dist: 0 }));
    while (queue.length > 0) {
      const { oid, dist } = queue.shift()!;
      if (dist >= depth) continue;
      const known = distance.get(oid);
      if (known !== undefined && known <= dist) continue;
      distance.set(oid, dist);
      wantCommits.add(oid);
      const commit = store.commitOf(oid);
      if (commit !== undefined) for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
    }
  } else {
    const stack = [...wants];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (wantCommits.has(oid)) continue;
      const commit = store.commitOf(oid);
      if (commit === undefined) continue;
      wantCommits.add(oid);
      if (shallowDeclared.has(oid)) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
  }

  const wantObjects = new Set<string>();
  for (const oid of wantCommits) {
    wantObjects.add(oid);
    const tree = treeOfCommit(store, oid);
    if (tree !== undefined) addTreeClosure(store, tree, wantObjects);
  }
  for (const oid of tagWants) wantObjects.add(oid);

  // The new shallow boundary: included commits with a parent that exists but was excluded.
  const boundary = new Set<string>();
  for (const oid of wantCommits) {
    const commit = store.commitOf(oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) {
      if (!wantCommits.has(parent) && store.commitOf(parent) !== undefined) boundary.add(oid);
    }
  }
  const shallowLines = [...boundary].sort();
  const unshallowLines = [...shallowDeclared].filter((oid) => wantCommits.has(oid) && !boundary.has(oid)).sort();

  const sendIds = [...wantObjects].filter((oid) => !haveObjects.has(oid));
  const commits = sendIds.filter((oid) => store.getObject(oid)?.type === 'commit');
  const trees = sendIds.filter((oid) => store.getObject(oid)?.type === 'tree').sort();
  const blobs = sendIds.filter((oid) => store.getObject(oid)?.type === 'blob').sort();
  const others = sendIds.filter((oid) => {
    const type = store.getObject(oid)?.type;
    return type !== 'commit' && type !== 'tree' && type !== 'blob';
  }).sort();
  // Commits newest-first so a reader meets history in order; the rest by id (deterministic).
  const commitOrder = new Map<string, number>();
  for (const oid of commits) {
    const commit = store.commitOf(oid);
    const match = commit === undefined ? null : / (\d+) [+-]\d{4}$/.exec(commit.author);
    commitOrder.set(oid, match === null ? 0 : Number(match[1]));
  }
  commits.sort((a, b) => (commitOrder.get(b)! - commitOrder.get(a)!) || (a < b ? -1 : 1));
  const objects: GitObject[] = [];
  for (const oid of [...commits, ...trees, ...blobs, ...others]) {
    const object = store.getObject(oid);
    if (object !== undefined) objects.push(object);
  }

  const acks = args.haves.filter((oid) => store.commitOf(oid) !== undefined);
  return {
    pack: writePack(objects),
    acks,
    shallowLines,
    unshallowLines,
    hadShallowArgs: args.shallow.length > 0 || args.deepen !== null,
  };
}

// ------------------------------------------------------------------ fetch v0

function uploadPackV0(store: Store, repo: RepoRec, body: Buffer): GitHttpResponse {
  const { frames } = readPktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let caps = '';
  let section: 'wants' | 'haves' = 'wants';
  for (const frame of frames) {
    if (frame.kind === 'flush') {
      section = 'haves';
      continue;
    }
    if (frame.kind !== 'data') continue;
    let line = frame.data.toString('utf8').replace(/\n$/, '');
    if (section === 'wants') {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const value = Number.parseInt(line.slice(7), 10);
        if (Number.isFinite(value) && value > 0) deepen = value;
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  const plan = planFetch(store, repo, { wants, haves, shallow, deepen });
  const parts: Buffer[] = [];
  for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine(plan.acks.length > 0 ? `ACK ${plan.acks[0]}\n` : 'NAK\n'));
  if (caps.includes('side-band-64k')) {
    parts.push(...sidebandPackets(plan.pack), PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat([...parts, plan.pack]) };
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(store: Store, repo: RepoRec, req: GitHttpRequest): GitHttpResponse {
  let commands: PushCommand[] = [];
  let caps = '';
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const { frames, rest } = readPktLines(req.body);
    let first = true;
    for (const frame of frames) {
      if (frame.kind === 'flush') break;
      if (frame.kind !== 'data') continue;
      let line = frame.data.toString('utf8').replace(/\n$/, '');
      if (first) {
        first = false;
        const nul = line.indexOf('\0');
        if (nul !== -1) {
          caps = line.slice(nul + 1);
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    packBytes = rest;
  } catch {
    return textError(400, 'receive-pack: could not parse the command list');
  }

  let unpackLine = 'unpack ok\n';
  const wantsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (wantsPack && packBytes.length > 0) {
    try {
      const parsed = parsePack(packBytes, (oid) => store.getObject(oid));
      parsed.objects.forEach((object, index) => store.putExisting(parsed.oids[index]!, object));
    } catch (error) {
      unpackLine = `unpack ${error instanceof Error ? error.message : String(error)}\n`;
    }
  } else if (wantsPack) {
    unpackLine = 'unpack the push carried no pack\n';
  }

  const reportLines: string[] = [unpackLine];
  const unpackOk = unpackLine === 'unpack ok\n';
  for (const command of commands) {
    reportLines.push(`${applyPushCommand(store, repo, command, unpackOk)}\n`);
  }

  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  let body: Buffer;
  if (caps.includes('side-band-64k')) {
    body = Buffer.concat([...sidebandPackets(reportStream), PKT_FLUSH]);
  } else {
    body = reportStream;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}

/** Apply one ref update; answers its report-status line ("ok <ref>" or "ng <ref> <reason>"). */
function applyPushCommand(store: Store, repo: RepoRec, command: PushCommand, unpackOk: boolean): string {
  const { oldOid, newOid, ref } = command;
  if (!unpackOk) return `ng ${ref} unpack failed`;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) return `ng ${ref} invalid ref`;
  const current = repo.refs.get(ref) ?? ZERO_OID;

  if (newOid === ZERO_OID) {
    // A deletion.
    if (current === ZERO_OID) return `ng ${ref} reference does not exist`;
    if (current !== oldOid) return `ng ${ref} stale info`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }

  const object = store.getObject(newOid);
  if (object === undefined) return `ng ${ref} unknown object`;
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') return `ng ${ref} not a commit`;

  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return `ng ${ref} reference already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) return `ng ${ref} stale info`;
  if (current !== ZERO_OID && object.type === 'commit' && !store.isAncestor(current, newOid)) {
    return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}
