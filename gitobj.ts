// gitobj.ts: the git object model in pure Node — SHA-1 object ids, zlib (de)compression,
// packfile reading (plain objects plus OFS/REF deltas) and writing (plain objects), tree and
// commit parsing/building, and the pkt-line framing the smart-HTTP protocol speaks.
// No state lives here; store.ts keeps the objects. Everything is deterministic: the same
// bytes in give the same object id out, which is what lets the REST contents API and the git
// protocol agree on blob ids.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 object id of an object: sha1("<type> <length>\0" + data), as 40 lowercase hex. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  /** git's on-disk spelling: '100644', '100755', '120000', '40000' for a subtree, '160000'. */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('ascii', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort key: entries sort by name, with directories sorting as if named "name/". */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object: headers (tree, parents, author, committer), a blank line, the message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** A "Name <email> ts +0000" identity line. */
export function identityLine(name: string, email: string, timestampSec: number): string {
  return `${name} <${email}> ${timestampSec} +0000`;
}

/** Build a commit object's bytes. */
export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let header = `tree ${info.tree}\n`;
  for (const parent of info.parents) header += `parent ${parent}\n`;
  header += `author ${info.author}\ncommitter ${info.committer}\n`;
  return Buffer.from(`${header}\n${info.message}`, 'utf8');
}

/** The author timestamp (seconds) of a commit, or 0 when unparseable. */
export function commitTimestamp(commit: CommitInfo): number {
  const match = / (\d+) [+-]\d{4}$/.exec(commit.author);
  return match === null ? 0 : Number(match[1]);
}

// ------------------------------------------------------------------ zlib streams in packs

/** adler32, the zlib trailer checksum (chunked so the mod stays cheap on large blobs). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(data.length, offset + 5552);
    for (; offset < end; offset += 1) {
      a += data[offset]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the one zlib stream that starts at `start` in `buffer`, returning its data and the
 * offset just past the stream. Node's inflateSync ignores trailing bytes and throws on any
 * truncation (even one missing adler byte), so "prefix of length L inflates" is a monotone
 * predicate whose first success is exactly the stream's end. Fast path: inflate the whole
 * remainder once, then find the stream's end by locating the data's adler32 trailer in the
 * raw bytes (a deflated stream is never much larger than its data) and verifying that one
 * candidate prefix. Fallback: exponential probing plus binary search on the predicate.
 */
export function inflateExact(buffer: Buffer, start: number, size: number): { data: Buffer; nextOffset: number } {
  const remaining = buffer.length - start;
  const attempt = (length: number): Buffer | null => {
    try {
      const out = inflateSync(buffer.subarray(start, start + length));
      return out.length === size ? out : null;
    } catch {
      return null;
    }
  };

  const full = attempt(remaining);
  if (full !== null) {
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32BE(adler32(full), 0);
    // The stream ends with its adler32; the deflated form is at most the data size plus a
    // stored-block overhead, so the trailer sits inside this window in practice.
    const windowEnd = Math.min(remaining, size + 4096 + Math.floor(size / 8));
    let searchFrom = 6; // 2 header bytes + at least an empty final block + 4 trailer bytes
    while (searchFrom <= windowEnd) {
      const at = buffer.indexOf(trailer, start + searchFrom);
      if (at === -1 || at - start + 4 > windowEnd) break;
      const candidate = at - start + 4;
      const check = attempt(candidate);
      if (check !== null && check.equals(full)) return { data: full, nextOffset: start + candidate };
      searchFrom = at - start + 1;
    }
  }

  let hi = Math.min(remaining, Math.max(16, size + 64));
  let found = attempt(hi);
  let lo = 1;
  while (found === null) {
    if (hi >= remaining) throw new Error('pack object stream does not terminate');
    lo = hi + 1;
    hi = Math.min(remaining, hi * 2);
    found = attempt(hi);
  }
  // The smallest succeeding length in (lo-1, hi] is the stream end.
  let low = lo - 1; // known failure (or 0)
  let high = hi; // known success
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (attempt(mid) === null) low = mid;
    else high = mid;
  }
  const data = attempt(high);
  if (data === null) throw new Error('pack object stream vanished during search');
  return { data, nextOffset: start + high };
}

// ------------------------------------------------------------------ packs

/** Serialize objects into a version-2 packfile: header, deflated plain objects, SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodePackObjectHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A pack object header: type and size in git's variable-length encoding. */
function encodePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Apply a git delta (as carried by OFS_DELTA / REF_DELTA pack entries) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: delta expects ${sourceSize}, base is ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset]!;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          copyOffset += delta[offset]! * 2 ** (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          copySize += delta[offset]! * 2 ** (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode > 0) {
      out.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

export interface ParsedPack {
  objects: GitObject[];
  /** Object ids in pack order, parallel to `objects`. */
  oids: string[];
}

/**
 * Parse a packfile fully into memory, resolving OFS/REF deltas. `resolveExternal` supplies
 * base objects a thin pack deltas against but does not carry. Throws on structural problems
 * (including a checksum mismatch).
 */
export function parsePack(pack: Buffer, resolveExternal?: (oid: string) => GitObject | undefined): ParsedPack {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum does not verify');

  interface RawEntry {
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset: number;
    baseOid: string;
    offset: number;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseOid = '';
    if (typeCode === 6) {
      byte = pack[offset]!;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset]!;
        offset += 1;
        back = (back + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeCode === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateExact(pack, offset, size);
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    raw.push({ typeCode, size, data: inflated.data, baseOffset, baseOid, offset: entryOffset });
    offset = inflated.nextOffset;
  }

  const resolved: Array<GitObject | undefined> = raw.map(() => undefined);
  const indexByOffset = new Map<number, number>();
  raw.forEach((entry, index) => indexByOffset.set(entry.offset, index));
  const byOid = new Map<string, GitObject>();

  const resolve = (index: number): GitObject => {
    const done = resolved[index];
    if (done !== undefined) return done;
    const entry = raw[index]!;
    let object: GitObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseIndex = indexByOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('OFS_DELTA base is not in the pack');
        base = resolve(baseIndex);
      } else {
        base = byOid.get(entry.baseOid) ?? resolveExternal?.(entry.baseOid);
        if (base === undefined) throw new Error(`REF_DELTA base ${entry.baseOid} is not available`);
      }
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data };
    } else {
      const type = CODE_TYPES[entry.typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.typeCode}`);
      object = { type, data: entry.data };
    }
    resolved[index] = object;
    byOid.set(hashObject(object.type, object.data), object);
    return object;
  };

  const objects: GitObject[] = [];
  const oids: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const object = resolve(index);
    objects.push(object);
    oids.push(hashObject(object.type, object.data));
  }
  return { objects, oids };
}

// ------------------------------------------------------------------ pkt-line

/** One pkt-line frame: a data payload, or one of the three control frames. */
export type PktLine = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Encode one data pkt-line (4-hex length including the header, payload up to 65516 bytes). */
export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (payload.length > 65516) throw new Error('pkt-line payload too large');
  const header = (payload.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

/** Read pkt-lines from the front of `buffer`; returns the frames and the unconsumed rest. */
export function readPktLines(buffer: Buffer, maxFrames = 100000): { frames: PktLine[]; rest: Buffer } {
  const frames: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && frames.length < maxFrames) {
    const header = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      frames.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      frames.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      frames.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    frames.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { frames, rest: buffer.subarray(offset) };
}
