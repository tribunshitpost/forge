// git.ts — the git object model and wire codecs for the forge.
//
// Everything here is pure computation over Buffers: SHA-1 object ids exactly
// as git computes them, pkt-line framing, packfile read/write (plain objects
// plus OFS_DELTA / REF_DELTA resolution on read), and commit/tree/tag
// parsing. No I/O, no clock, no randomness: the same bytes always hash,
// parse and pack the same way, which is what makes two trial runs replay
// byte for byte.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** git's object id: sha1("<type> <size>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function hashObjectOf(type: GitObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every pkt-line in a complete buffer. Throws on a malformed header. */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Split a buffer at the first flush packet: [packets before it, bytes after it]. */
export function splitAtFlush(buffer: Buffer): { packets: PktPacket[]; rest: Buffer } {
  let offset = 0;
  const packets: PktPacket[] = [];
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) return { packets, rest: buffer.subarray(offset + 4) };
    if (length === 1 || length === 2) {
      packets.push(length === 1 ? { kind: 'delim' } : { kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------

function readPackVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = buffer[offset] & 0x7f;
  let shift = 7;
  let pos = offset + 1;
  while (buffer[offset] & 0x80) {
    value |= (buffer[pos] & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { value, next: pos };
}

function readPackSize(buffer: Buffer, offset: number): { size: number; first: number; next: number } {
  const first = buffer[offset];
  let size = first & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  let b = first;
  while (b & 0x80) {
    b = buffer[pos];
    pos += 1;
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { size, first, next: pos };
}

/**
 * The original entry-boundary search: binary-search the smallest end that
 * inflates to the declared size. Correct on every Node, but each probe below
 * the true end throws (a truncated stream), and every throw captures a stack
 * trace — on the push workload that is thousands of throws per round.
 * Kept verbatim as the fallback when the fast path below is unavailable.
 */
function inflateAtBinarySearch(buffer: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  // Node's inflateSync ignores trailing bytes but throws on a truncated
  // stream, so the stream's end is the smallest end that inflates to the
  // declared size. Binary-search it (log n inflates, each linear).
  let lo = offset + 1;
  let hi = buffer.length;
  let answer = -1;
  let answerData: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buffer.subarray(offset, mid));
      if (data.length === expectedSize) {
        answer = mid;
        answerData = data;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (answer === -1 || answerData === null) throw new Error('could not inflate pack entry');
  return { data: answerData, next: answer };
}

/**
 * Whether this Node's inflateSync reports how much input it consumed.
 * Probe once, at first use: inflate a known stream with trailing bytes and
 * check that `engine.bytesWritten` is exactly the stream's length. When the
 * runtime does not support the `info` option (or reports anything else),
 * the probe fails and every call uses the binary search above — same bytes
 * in, same bytes out, just slower.
 */
let inflateReportsLength: boolean | null = null;

/**
 * The probe itself, with no caching: inflate a known stream with trailing
 * bytes and report whether `engine.bytesWritten` is exactly the stream's
 * length. Any failure (no `info` support, a wrong value, a throw) is false.
 */
function probeInflateReportsConsumedLength(): boolean {
  try {
    const probe = deflateSync(Buffer.from('forge-probe'));
    const tailed = Buffer.concat([probe, Buffer.from('trailing-bytes')]);
    const result = inflateSync(tailed, { info: true }) as unknown as {
      buffer: Buffer;
      engine?: { bytesWritten?: unknown };
    };
    return (
      result.buffer.toString('utf8') === 'forge-probe' &&
      typeof result.engine?.bytesWritten === 'number' &&
      result.engine.bytesWritten === probe.length
    );
  } catch {
    return false;
  }
}

function inflateReportsConsumedLength(): boolean {
  if (inflateReportsLength === null) inflateReportsLength = probeInflateReportsConsumedLength();
  return inflateReportsLength;
}

function inflateAt(buffer: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  if (inflateReportsConsumedLength()) {
    try {
      // One inflate, no throws on the good path: inflateSync stops at the
      // end of the deflate stream and ignores the bytes after it (the next
      // entries), and `engine.bytesWritten` is exactly how many input bytes
      // the stream consumed — the entry's end. The size check rejects a
      // corrupt entry before its end is trusted.
      const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
        buffer: Buffer;
        engine?: { bytesWritten?: unknown };
      };
      const consumed = result.engine?.bytesWritten;
      if (
        result.buffer.length === expectedSize &&
        typeof consumed === 'number' &&
        Number.isInteger(consumed) &&
        consumed > 0 &&
        offset + consumed <= buffer.length
      ) {
        return { data: result.buffer, next: offset + consumed };
      }
    } catch {
      // A truncated or corrupt entry: fall through to the binary search,
      // which raises the same error the old code raised.
    }
  }
  return inflateAtBinarySearch(buffer, offset, expectedSize);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos];
      pos += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  readVarint(); // source size
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || written !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    const sizeInfo = readPackSize(pack, offset);
    offset = sizeInfo.next;
    const typeCode = (sizeInfo.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: sizeInfo.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      let b = pack[offset];
      offset += 1;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = entryOffset - baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack entry type ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset, sizeInfo.size);
    if (inflated.data.length !== sizeInfo.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject & { oid: string } => {
    const cached = (entry as unknown as { _resolved?: GitObject & { oid: string } })._resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let result: GitObject & { oid: string };
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing from pack');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data, oid: hashObject(base.type, data) };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      let base: GitObject;
      if (baseEntry) base = resolve(baseEntry);
      else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} not available`);
        base = external;
      }
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data, oid: hashObject(base.type, data) };
    } else {
      const type = CODE_TYPE[entry.typeCode];
      result = { type, data: entry.data, oid: hashObject(type, entry.data) };
    }
    (entry as unknown as { _resolved?: GitObject & { oid: string } })._resolved = result;
    resolvedByOid.set(result.oid, entry);
    resolving.delete(entry.offset);
    return result;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Order is the caller's. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// object parsing
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build a commit object body (no hashing here; the caller hashes). */
export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}
