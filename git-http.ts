// git-http.ts — git smart HTTP: info/refs advertisements, protocol v2
// ls-refs / fetch, protocol v0 fetch, and receive-pack pushes.
//
// The wire rules, from the suite's git client:
//   - upload-pack speaks v2 when the request carries `Git-Protocol:
//     version=2`, else v0. receive-pack is v0 only.
//   - info/refs answers the smart-HTTP content type and the `# service=`
//     preamble; a missing repository is 404 and the server stays up.
//   - v2 fetch answers acknowledgments, shallow-info and packfile sections;
//     v0 fetch answers NAK/ACK lines, shallow lines and a sideband pack.
//   - A fetch sends only objects the client does not already hold; a
//     shallow fetch sends only the generations the depth asks for.
//   - A push applies per ref: fast-forward updates move, anything else is
//     an `ng` line, and the report arrives in sideband band 1.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktFlush,
  readPack,
  splitAtFlush,
  writePack,
  type GitObject,
  type PktPacket,
} from './git.ts';
import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitResponse {
  status: number;
  body: Buffer;
  contentType: string;
}

function resp(status: number, body: Buffer, contentType: string): GitResponse {
  return { status, body, contentType };
}

function textLines(packets: PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** The refs a repo advertises, in a stable order: HEAD first, then sorted. */
function advertisedRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
  const sorted = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [name, oid] of sorted) {
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const tag = parseTag(object.data);
      if (repo.objects.get(tag.object)?.type === 'commit') entry.peeled = tag.object;
    }
    refs.push(entry);
  }
  return refs;
}

function defaultTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k thin-pack ofs-delta multi_ack_detailed symref=HEAD:refs/heads/main agent=forge/1.0'
      : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const parts: Array<string | Buffer | 'flush'> = [`# service=${service}\n`];
  const tip = defaultTip(repo);
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    parts.push(`${tip ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const ref of refs) {
      parts.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) parts.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  parts.push('flush');
  return encodePktLines(parts);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'agent=forge/1.0\n',
    'flush',
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string,
): GitResponse {
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (!repo) return resp(404, Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'), 'application/json');
  if (service === 'git-upload-pack') {
    if (gitProtocol.includes('version=2')) return resp(200, v2Advertisement(), UPLOAD_AD);
    return resp(200, v0Advertisement(repo, 'git-upload-pack'), UPLOAD_AD);
  }
  if (service === 'git-receive-pack') {
    return resp(200, v0Advertisement(repo, 'git-receive-pack'), RECEIVE_AD);
  }
  return resp(400, Buffer.from(JSON.stringify({ message: 'Unknown service' }), 'utf8'), 'application/json');
}

// ---------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchPlan {
  objects: GitObject[];
  boundary: string[];
  unshallow: string[];
}

function planFetch(store: Store, repo: Repo, request: FetchRequest): FetchPlan {
  if (request.depth !== null) {
    const { objects, boundary } = store.shallowObjects(repo, request.wants, request.haves, request.depth, request.shallow);
    const unshallow = request.shallow.filter((oid) => !boundary.includes(oid));
    return { objects, boundary, unshallow };
  }
  return { objects: store.objectsToSend(repo, request.wants, request.haves), boundary: [], unshallow: [] };
}

function packCacheKey(request: FetchRequest): string {
  return [
    request.wants.slice().sort().join(','),
    request.haves.slice().sort().join(','),
    request.shallow.slice().sort().join(','),
    String(request.depth),
  ].join('|');
}

/** Chunk pack bytes into sideband band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack (v2)
// ---------------------------------------------------------------------------

function handleFetchV2(store: Store, repo: Repo, packets: PktPacket[]): GitResponse {
  const lines = textLines(packets);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let seenDelim = false;
  for (const line of lines) {
    if (line === 'command=fetch') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') continue;
    if (line.startsWith('filter ')) continue;
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) request.depth = request.depth ?? 1;
    else if (line === 'done') seenDelim = true;
    void seenDelim;
  }
  for (const want of request.wants) {
    if (!isObjectId(want)) return resp(400, Buffer.alloc(0), UPLOAD_RESULT);
  }
  const plan = planFetch(store, repo, request);
  const parts: Buffer[] = [];
  const ackLines: Array<string | Buffer | 'flush' | 'delim'> = ['acknowledgments\n', 'NAK\n', 'delim'];
  parts.push(encodePktLines(ackLines));
  if (request.depth !== null) {
    const shallowLines: Array<string | Buffer | 'flush' | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.boundary) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push('delim');
    parts.push(encodePktLines(shallowLines));
  }
  if (plan.objects.length > 0) {
    const pack = store.fetchPack(repo, `v2|${packCacheKey(request)}`, () => writePack(plan.objects));
    const packLines: Array<string | Buffer | 'flush' | 'delim'> = ['packfile\n'];
    parts.push(encodePktLines(packLines));
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return resp(200, Buffer.concat(parts), UPLOAD_RESULT);
}

function handleLsRefs(repo: Repo, packets: PktPacket[]): GitResponse {
  const lines = textLines(packets);
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const line of lines) {
    if (line === 'command=ls-refs') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') continue;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = advertisedRefs(repo);
  const tip = defaultTip(repo);
  const out: Array<string | Buffer | 'flush'> = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (keep('HEAD')) {
    if (tip) out.push(`${tip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    else out.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush');
  return resp(200, encodePktLines(out), UPLOAD_RESULT);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer, gitProtocol: string): GitResponse {
  let packets: PktPacket[];
  try {
    packets = decodePktLines(body);
  } catch {
    return resp(400, Buffer.alloc(0), UPLOAD_RESULT);
  }
  const lines = textLines(packets);
  if (gitProtocol.includes('version=2')) {
    const command = lines.find((line) => line.startsWith('command=')) ?? '';
    if (command === 'command=ls-refs') return handleLsRefs(repo, packets);
    if (command === 'command=fetch') return handleFetchV2(store, repo, packets);
    return resp(400, Buffer.alloc(0), UPLOAD_RESULT);
  }
  // v0: wants section, flush, haves/done section.
  const flushIndex = packets.findIndex((packet) => packet.kind === 'flush');
  const firstSection = flushIndex === -1 ? packets : packets.slice(0, flushIndex);
  const secondSection = flushIndex === -1 ? [] : packets.slice(flushIndex + 1);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of textLines(firstSection)) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const oid = rest.split(' ')[0];
      request.wants.push(oid);
    } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
  }
  for (const line of textLines(secondSection)) {
    if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
  }
  for (const want of request.wants) {
    if (!isObjectId(want)) return resp(400, Buffer.alloc(0), UPLOAD_RESULT);
  }
  const plan = planFetch(store, repo, request);
  const parts: Buffer[] = [];
  const ackLines: Array<string | Buffer | 'flush'> = ['NAK\n'];
  for (const oid of plan.boundary) ackLines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) ackLines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(ackLines));
  if (plan.objects.length > 0) {
    const pack = store.fetchPack(repo, `v0|${packCacheKey(request)}`, () => writePack(plan.objects));
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return resp(200, Buffer.concat(parts), UPLOAD_RESULT);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  let split: { packets: PktPacket[]; rest: Buffer };
  try {
    split = splitAtFlush(body);
  } catch {
    return resp(400, Buffer.alloc(0), RECEIVE_RESULT);
  }
  const commands: PushCommand[] = [];
  for (const line of textLines(split.packets)) {
    const nul = line.indexOf('\0');
    const clean = nul === -1 ? line : line.slice(0, nul);
    const parts = clean.split(' ');
    if (parts.length < 3) return resp(400, Buffer.alloc(0), RECEIVE_RESULT);
    const [oldOid, newOid, ref] = parts;
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
      return resp(400, Buffer.alloc(0), RECEIVE_RESULT);
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return resp(400, Buffer.alloc(0), RECEIVE_RESULT);

  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (hasUpdates) {
    if (split.rest.length === 0) {
      unpackError = 'unpacker error: no packfile';
    } else {
      try {
        const objects = readPack(split.rest, (oid) => repo.objects.get(oid));
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (error) {
        unpackError = `unpacker error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const result = applyPushCommand(store, repo, command);
      if (result.ok) reportLines.push(`ok ${command.ref}\n`);
      else reportLines.push(`ng ${command.ref} ${result.reason}\n`);
    }
    repo.version += 1;
    repo.packCache.clear();
  }

  // The report-status stream is itself pkt-lined inside sideband band 1.
  const reportStream = encodePktLines(reportLines);
  const parts: Buffer[] = [sidebandPack(reportStream), pktFlush()];
  return resp(200, Buffer.concat(parts), RECEIVE_RESULT);
}

function applyPushCommand(store: Store, repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'object not found' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
  if (command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'object not found' };
  const newCommit = store.peelToCommit(repo, command.newOid);
  if (newCommit === null) return { ok: false, reason: 'object is not a commit' };
  const oldCommit = store.peelToCommit(repo, command.oldOid);
  if (oldCommit === null) return { ok: false, reason: 'object is not a commit' };
  if (!store.isAncestor(repo, oldCommit, newCommit)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

// Re-exported so the tree walkers stay in one place for the git checks.
export { parseTree };
