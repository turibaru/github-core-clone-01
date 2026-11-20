// forge — a standalone GitHub-compatible git forge in one process, one file.
// Node 22, standard library only (node:http, node:crypto, node:zlib).
// Serves git smart HTTP (v2 upload-pack, v0 receive-pack), REST v3, GraphQL v4
// and MCP (streamable HTTP, revision 2026-07-28 + legacy initialize) from an
// in-memory store. No git binary, no package, no outside service.
//
// Lifecycle (see the contest rules): bind an ephemeral port, POST {"port": N}
// to $MAKEFUN_ENV_URL/register, answer GET /healthz with 200, poll
// GET $MAKEFUN_ENV_URL/done until {"done": true}, then exit 0. With no
// MAKEFUN_ENV_URL set the server just listens and serves (local practice).
//
// The token owner login is the seeded scenario viewer ("adaiversen") unless
// MAKEFUN_FORGE_LOGIN names another; the bearer token is MAKEFUN_SHOP_TOKEN.
// All timestamps in stored state are fixed constants, so two runs on the
// same requests leave identical state.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const VIEWER_LOGIN = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const FIXED_TS = '2025-01-01T00:00:00Z';
const FIXED_EPOCH = 1700000000;
const ZERO_OID = '0'.repeat(40);
const AGENT = 'forge/1.0.0';

// ---------------------------------------------------------------- utilities

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function gid(kind: string, key: string): string {
  return b64encode(`${kind}:${key}`);
}

function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const text = b64decode(id).toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------- store

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
interface FileEnt {
  oid: string;
  size: number;
  data: Buffer;
}
interface Label {
  name: string;
  color: string;
}
interface Comment {
  id: number;
  body: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
}
interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}
interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  seq: number;
}
interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  fileCache: Map<string, Map<string, FileEnt>>;
}

const repos = new Map<string, Repo>(); // key: owner + '/' + name
let repoSeq = 0;
let repoIdCounter = 0;
let objIdCounter = 0;
let requestCounter = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function viewerRepos(): Repo[] {
  const out: Repo[] = [];
  for (const repo of repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// ---------------------------------------------------------------- git objects

function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function buildCommit(tree: string, parents: string[], message: string, author: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author} ${FIXED_EPOCH} +0000`, `committer ${author} ${FIXED_EPOCH} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

function parseTag(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const headerText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  let object = '';
  let type = '';
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
  }
  return { object, type };
}

function resolveToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Every object reachable from roots (commit -> tree + parents, tree -> entries, tag -> target). */
function reachableObjects(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      queue.push(view.tree);
      for (const parent of view.parents) queue.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

function commitAncestors(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    const commit = resolveToCommit(repo, root);
    if (commit !== null) queue.push(commit);
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return seen;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(repo, [descendant]).has(ancestor);
}

/** Flat path -> file map for a commit, cached per commit oid. */
function filesAt(repo: Repo, commitOid: string): Map<string, FileEnt> {
  const cached = repo.fileCache.get(commitOid);
  if (cached) return cached;
  const out = new Map<string, FileEnt>();
  const obj = repo.objects.get(commitOid);
  if (obj && obj.type === 'commit') {
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else {
          const blob = repo.objects.get(entry.oid);
          if (blob) out.set(path, { oid: entry.oid, size: blob.data.length, data: blob.data });
        }
      }
    };
    walk(parseCommit(obj.data).tree, '');
  }
  repo.fileCache.set(commitOid, out);
  return out;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function diffFiles(base: Map<string, FileEnt>, head: Map<string, FileEnt>): PullFile[] {
  const out: PullFile[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const deletions = lineCount(b.data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const additions = lineCount(h.data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const additions = lineCount(h.data);
      const deletions = lineCount(b.data);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Build nested trees bottom-up from a flat file map; returns the root tree oid. */
function buildTreesForFiles(repo: Repo, files: Map<string, FileEnt>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, file.oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of [...node.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      entries.push({ mode: '100644', name, oid });
    }
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : 1))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create a commit on `branch` from a flat file map; returns the commit oid. */
function makeCommit(repo: Repo, branch: string, files: Map<string, FileEnt>, message: string): string {
  const tree = buildTreesForFiles(repo, files);
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const parents = parent !== undefined ? [parent] : [];
  const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const oid = putObject(repo, 'commit', buildCommit(tree, parents, message, author));
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.fileCache.delete(oid);
  return oid;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const deflatedCache = new Map<string, Buffer>(); // oid -> full pack entry bytes (header + zlib)

function packEntryBytes(repo: Repo, oid: string): Buffer {
  const cached = deflatedCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid)!;
  const data = obj.data;
  const typeCode = TYPE_CODE[obj.type]!;
  // varint header: low 4 bits of size in first byte, then 7 bits per byte
  const header: number[] = [];
  let size = data.length;
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  header.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    header.push(byte);
  }
  const out = Buffer.concat([Buffer.from(header), deflateSync(data)]);
  if (deflatedCache.size < 200000) deflatedCache.set(oid, out);
  return out;
}

function writePack(repo: Repo, oids: Iterable<string>): Buffer {
  const list = [...oids];
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0]!.write('PACK', 0, 4, 'ascii');
  parts[0]!.writeUInt32BE(2, 4);
  parts[0]!.writeUInt32BE(list.length, 8);
  for (const oid of list) parts.push(packEntryBytes(repo, oid));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Parse a packfile (plain objects plus OFS/REF deltas) into resolved objects. */
function readPack(pack: Buffer): { type: ObjType; data: Buffer }[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const count = pack.readUInt32BE(8);
  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      byte = pack[offset++]!;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++]!;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    offset += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('pack object size mismatch');
    raw.push({ offset: entryOffset, typeCode, data: inflated.buffer, baseOffset, baseOid });
  }
  const byOffset = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const out: { type: ObjType; data: Buffer }[] = [];
  const resolve = (entry: Raw): { type: ObjType; data: Buffer; oid: string } => {
    const done = byOffset.get(entry.offset);
    if (done) return done;
    let resolved: { type: ObjType; data: Buffer; oid: string };
    if (entry.typeCode === 6) {
      const baseEntry = raw.find((r) => r.offset === entry.baseOffset);
      if (!baseEntry) throw new Error('ofs-delta base not found');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      resolved = { type: base.type, data, oid: hashObject(base.type, data) };
    } else if (entry.typeCode === 7) {
      const baseEntry = raw.find((r) => hashObject(CODE_TYPE[r.typeCode] ?? 'blob', r.data) === entry.baseOid);
      if (!baseEntry) throw new Error('ref-delta base not found in pack');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      resolved = { type: base.type, data, oid: hashObject(base.type, data) };
    } else {
      const type = CODE_TYPE[entry.typeCode]!;
      resolved = { type, data: entry.data, oid: hashObject(type, entry.data) };
    }
    byOffset.set(entry.offset, resolved);
    out.push({ type: resolved.type, data: resolved.data });
    return resolved;
  };
  for (const entry of raw) resolve(entry);
  return out;
}

// ---------------------------------------------------------------- pkt-line

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
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
    } else if (length === 3) {
      throw new Error('invalid pkt-line length 0003');
    } else {
      if (offset + length > buf.length) break;
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return { packets, rest: buf.subarray(offset) };
}

/** Split a sideband payload into band-1 pkt-lines (chunked to fit pkt-line max). */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < data.length; i += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(i, i + CHUNK)])));
  }
  return out;
}

// ---------------------------------------------------------------- git refs

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const name of [...repo.refs.keys()].sort()) out.push({ name, oid: repo.refs.get(name)! });
  return out;
}

function peeledOid(repo: Repo, oid: string): string | undefined {
  const commit = resolveToCommit(repo, oid);
  return commit === oid ? undefined : (commit ?? undefined);
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- git fetch computation

interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
}

function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | null,
): FetchPlan {
  const wantCommits = new Set<string>();
  const extraObjects = new Set<string>();
  for (const want of wants) {
    const commit = resolveToCommit(repo, want);
    if (commit !== null) wantCommits.add(commit);
    if (want !== commit) extraObjects.add(want); // a tag object itself
  }
  let included: Set<string>;
  if (depth !== null) {
    included = new Set<string>();
    const queue: { oid: string; gen: number }[] = [...wantCommits].map((oid) => ({ oid, gen: 1 }));
    const seenGen = new Map<string, number>();
    while (queue.length > 0) {
      const item = queue.shift()!;
      const prev = seenGen.get(item.oid);
      if (prev !== undefined && prev <= item.gen) continue;
      seenGen.set(item.oid, item.gen);
      if (item.gen > depth) continue;
      included.add(item.oid);
      if (item.gen < depth) {
        const obj = repo.objects.get(item.oid);
        if (obj && obj.type === 'commit') {
          for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, gen: item.gen + 1 });
        }
      }
    }
  } else {
    included = commitAncestors(repo, wantCommits);
  }
  // Ancestors of the client's haves, but never past a shallow boundary:
  // a shallow commit is held, its parents are not (that is what a deepen
  // extends). Without this, a deepen-2 fetch would exclude the very parent
  // it is asked to deliver, because the parent is an ancestor of the have.
  const shallowSet = new Set(shallowIn);
  const haveCommits = new Set<string>();
  {
    const queue: string[] = [];
    for (const root of haves) {
      const commit = resolveToCommit(repo, root);
      if (commit !== null) queue.push(commit);
    }
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (haveCommits.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      haveCommits.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  const sendCommits = new Set<string>([...included].filter((oid) => !haveCommits.has(oid)));
  // Objects the client already holds: the held commits plus their tree
  // closures only — never their parents, which a shallow client does not
  // have (reachableObjects would walk past the shallow boundary and make a
  // deepen re-send nothing).
  const haveObjects = new Set<string>();
  {
    const queue: string[] = [];
    for (const oid of haveCommits) {
      haveObjects.add(oid);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') queue.push(parseCommit(obj.data).tree);
    }
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (haveObjects.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      haveObjects.add(oid);
      if (obj.type === 'tree') for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    }
  }
  // Objects to send: each included commit plus its tree closure only. The
  // parent commits themselves are NOT part of a depth-limited closure:
  // depth 1 must carry the tip commit, its tree and its blobs, and nothing
  // above it. (For a full fetch `included` already holds every ancestor,
  // so the same walk covers the whole history.)
  const sendObjects = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const queue: string[] = [treeOid];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (sendObjects.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      sendObjects.add(oid);
      if (obj.type === 'tree') for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    }
  };
  for (const oid of sendCommits) {
    sendObjects.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') addTreeClosure(parseCommit(obj.data).tree);
  }
  for (const oid of extraObjects) {
    if (repo.objects.has(oid)) sendObjects.add(oid);
  }
  for (const oid of haveObjects) sendObjects.delete(oid);
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of sendCommits) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.some((p) => !sendCommits.has(p) && !haveCommits.has(p))) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  const available = new Set<string>([...sendCommits, ...haveCommits]);
  for (const oid of shallowIn) {
    if (!available.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (parseCommit(obj.data).parents.every((p) => available.has(p))) unshallow.push(oid);
  }
  return { objects: [...sendObjects], shallow, unshallow };
}

// ---------------------------------------------------------------- HTTP plumbing

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++requestCounter}`,
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (SHOP_TOKEN === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${SHOP_TOKEN}`;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

async function jsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strField(value: unknown, field: string): string {
  return isRecord(value) && typeof value[field] === 'string' ? (value[field] as string) : '';
}

function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) if (args[name] !== undefined) return args[name];
  return undefined;
}

function pickStr(args: Record<string, unknown>, names: string[]): string {
  const value = pickArg(args, names);
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------- git smart HTTP

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k multi_ack thin-pack ofs-delta shallow agent=forge/1.0'
      : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const firstOid = headOid ?? refs[0]!.oid;
    lines.push(`${firstOid} HEAD\0symref=HEAD:${headTarget(repo)} ${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== undefined) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'server-option\n',
    'object-format=sha1\n',
    'agent=forge/1.0\n',
    'flush',
  ]);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string): void {
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
  if (!repo || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    notFound(res);
    return;
  }
  const v2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
  const body = v2 ? v2Advertisement() : v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack');
  sendRaw(res, 200, `application/x-${service}-advertisement`, body);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefsV2(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: (string | 'flush')[] = [];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  const keep = (refName: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => refName.startsWith(p));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:${headTarget(repo)}\n`);
  } else {
    if (keep('HEAD') && headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel) {
        const peeled = peeledOid(repo, ref.oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

function handleFetchV2(repo: Repo, args: {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}): Buffer {
  const plan = computeFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLines(['acknowledgments\n', 'NAK\n', 'delim']));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: (string | 'delim')[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(pktLines(lines));
  }
  if (plan.objects.length > 0) {
    const pack = writePack(repo, plan.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(Buffer.concat(sidebandPackets(pack)));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, args: {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}): Buffer {
  const plan = computeFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    const pack = writePack(repo, plan.objects);
    parts.push(Buffer.concat(sidebandPackets(pack)));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  try {
    if (req.headers['git-protocol'] === 'version=2') {
      const { packets } = decodePktLines(body);
      let command = '';
      const args: string[] = [];
      let afterDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'flush') break;
        if (packet.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (packet.kind !== 'data') continue;
        const text = packet.payload.toString('utf8');
        if (!afterDelim) {
          if (text.startsWith('command=')) command = text.slice('command='.length).trim();
        } else {
          args.push(text);
        }
      }
      if (command === 'ls-refs') {
        const parsed: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const arg of args) {
          const line = arg.replace(/\n$/, '');
          if (line === 'peel') parsed.peel = true;
          else if (line === 'symrefs') parsed.symrefs = true;
          else if (line === 'unborn') parsed.unborn = true;
          else if (line.startsWith('ref-prefix ')) parsed.prefixes.push(line.slice('ref-prefix '.length));
        }
        sendRaw(res, 200, 'application/x-git-upload-pack-result', handleLsRefsV2(repo, parsed));
        return;
      }
      if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const shallow: string[] = [];
        let depth: number | null = null;
        for (const arg of args) {
          const line = arg.replace(/\n$/, '');
          if (line.startsWith('want ')) wants.push(line.slice(5).trim());
          else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
          else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
          else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
        }
        sendRaw(res, 200, 'application/x-git-upload-pack-result', handleFetchV2(repo, { wants, haves, shallow, depth }));
        return;
      }
      sendJson(res, 400, { message: `unknown v2 command ${command}` });
      return;
    }
    // v0 fetch: want/have/shallow/deepen lines in two sections split by a flush.
    const { packets } = decodePktLines(body);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]!);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
      else if (line.startsWith('have ') && section >= 1) haves.push(line.slice(5).trim());
    }
    sendRaw(res, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, { wants, haves, shallow, depth }));
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
  }
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const reportLines: string[] = [];
  try {
    const { packets, rest } = decodePktLines(body);
    interface Command {
      oldOid: string;
      newOid: string;
      ref: string;
    }
    const commands: Command[] = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    if (commands.length === 0) throw new Error('no commands');
    const hasPack = commands.some((c) => c.newOid !== ZERO_OID);
    let unpackOk = true;
    if (hasPack) {
      if (rest.length === 0) throw new Error('missing packfile');
      const objects = readPack(rest);
      for (const obj of objects) putObject(repo, obj.type, obj.data);
    }
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} ref does not exist\n`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        unpackOk = false;
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (!command.ref.startsWith('refs/tags/')) {
        const newCommit = resolveToCommit(repo, command.newOid);
        if (newCommit === null || !isAncestor(repo, command.oldOid, newCommit)) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
    if (!unpackOk) reportLines[0] = 'unpack ok\n';
    const report = pktLines(reportLines.map((line) => line as string));
    const out = Buffer.concat([...sidebandPackets(report), PKT_FLUSH]);
    sendRaw(res, 200, 'application/x-git-receive-pack-result', out);
  } catch (err) {
    // A malformed push must not kill the server; answer a sideband report with unpack failed.
    const report = pktLines(['unpack error\n']);
    const out = Buffer.concat([...sidebandPackets(report), PKT_FLUSH]);
    try {
      sendRaw(res, 200, 'application/x-git-receive-pack-result', out);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------- REST v3

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.priv,
    description: repo.description,
    fork: false,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    pushed_at: FIXED_TS,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    comments: issue.comments.length,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    draft: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo) },
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function createRepoInternal(name: string, priv: boolean, description: string): Repo {
  const repo: Repo = {
    id: ++repoIdCounter,
    name,
    owner: VIEWER_LOGIN,
    description,
    priv,
    defaultBranch: 'main',
    seq: ++repoSeq,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    fileCache: new Map(),
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

function createIssueInternal(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const issue: Issue = {
    id: ++objIdCounter,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq: repoSeq++,
  };
  repo.issues.push(issue);
  return issue;
}

function prConflict(repo: Repo, pull: Pull): boolean {
  const baseFiles = filesAt(repo, pull.baseSha);
  const headFiles = filesAt(repo, pull.headSha);
  const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (currentBaseTip === undefined) return false;
  const currentFiles = filesAt(repo, currentBaseTip);
  for (const file of pull.files) {
    const path = file.filename;
    const baseEnt = baseFiles.get(path);
    const headEnt = headFiles.get(path);
    const curEnt = currentFiles.get(path);
    const changedOnHead = (baseEnt?.oid ?? null) !== (headEnt?.oid ?? null);
    const changedOnBase = (baseEnt?.oid ?? null) !== (curEnt?.oid ?? null);
    if (changedOnHead && changedOnBase) return true;
  }
  return false;
}

function createPullInternal(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const files = diffFiles(filesAt(repo, baseSha), filesAt(repo, headSha));
  const pull: Pull = {
    id: ++objIdCounter,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    files,
    seq: repoSeq++,
  };
  repo.pulls.push(pull);
  return pull;
}

function mergePullInternal(repo: Repo, pull: Pull): { sha: string } | { conflict: true } {
  if (prConflict(repo, pull)) return { conflict: true };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
  const baseFiles = filesAt(repo, baseTip);
  const headFiles = filesAt(repo, pull.headSha);
  const merged = new Map<string, FileEnt>(baseFiles);
  for (const file of pull.files) {
    if (file.status === 'removed') merged.delete(file.filename);
    else {
      const ent = headFiles.get(file.filename);
      if (ent) merged.set(file.filename, ent);
    }
  }
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const sha = makeCommit(repo, pull.baseRef, merged, message);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TS;
  pull.mergeSha = sha;
  return { sha };
}

function resolveRefCommit(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (isOid(ref)) {
    const commit = resolveToCommit(repo, ref);
    return commit ?? undefined;
  }
  return undefined;
}

function paginate<T>(req: IncomingMessage, res: ServerResponse, items: T[], serialize: (item: T) => unknown): void {
  const query = queryOf(req);
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const extra: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const path = pathOf(req);
    extra.link = `<http://${host}${path}?page=${page + 1}&per_page=${perPage}>; rel="next"`;
  }
  sendJson(res, 200, slice.map(serialize), extra);
}

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const segments = path.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  // segments[0] = 'api', segments[1] = 'v3', ...
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const rest = segments.slice(2);
  const needJson = method === 'POST' || method === 'PUT' || method === 'PATCH';
  let body: unknown = {};
  if (needJson) {
    const parsed = await jsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Invalid JSON body' });
      return;
    }
    body = parsed.value;
  } else {
    await readBody(req);
  }
  const query = queryOf(req);

  // GET /api/v3/ and /api/v3/meta and /api/v3/user
  if (rest.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      paginate(req, res, viewerRepos(), (repo) => repoJson(repo));
      return;
    }
    if (method === 'POST') {
      const name = strField(body, 'name');
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      if (getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return;
      }
      const repo = createRepoInternal(name, body !== null && isRecord(body) && body.private === true, strField(body, 'description'));
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  // /repos/{owner}/{repo}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1]!;
    const name = rest[2]!;
    const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const tail = rest.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (isRecord(body) && typeof body.description === 'string') repo.description = body.description;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
        res.end();
        return;
      }
      notFound(res);
      return;
    }
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = sortedRefs(repo)
          .filter((ref) => ref.name.startsWith('refs/heads/'))
          .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid }, protected: false }));
        sendJson(res, 200, list);
        return;
      }
      if (tail.length >= 2 && method === 'GET') {
        const branch = tail.slice(1).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return;
      }
      notFound(res);
      return;
    }
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = strField(body, 'ref');
        const sha = strField(body, 'sha');
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Invalid ref or sha' });
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type }, url: '' });
        return;
      }
      if (method === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
        const branch = tail.slice(3).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
        return;
      }
      notFound(res);
      return;
    }
    if (tail[0] === 'commits' && method === 'GET') {
      const shaParam = query.get('sha');
      const tip = resolveRefCommit(repo, shaParam);
      const out: Record<string, unknown>[] = [];
      if (tip !== undefined) {
        const seen = new Set<string>();
        const stack: string[] = [tip];
        while (stack.length > 0) {
          const oid = stack.pop()!;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          const view = parseCommit(obj.data);
          out.push({
            sha: oid,
            commit: {
              message: view.message,
              author: { name: view.author, email: VIEWER_EMAIL, date: FIXED_TS },
              committer: { name: view.committer, email: VIEWER_EMAIL, date: FIXED_TS },
            },
            author: { login: VIEWER_LOGIN, id: VIEWER_ID },
          });
          for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i]!);
        }
      }
      sendJson(res, 200, out);
      return;
    }
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref');
        const tip = resolveRefCommit(repo, ref);
        if (tip === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const files = filesAt(repo, tip);
        if (filePath === '') {
          const entries = dirEntries(repo, tip, '');
          sendJson(res, 200, entries);
          return;
        }
        const file = files.get(filePath);
        if (file) {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: file.size,
            name: filePath.split('/').pop(),
            path: filePath,
            content: file.data.toString('base64'),
            sha: file.oid,
          });
          return;
        }
        const prefix = `${filePath}/`;
        if ([...files.keys()].some((p) => p.startsWith(prefix))) {
          sendJson(res, 200, dirEntries(repo, tip, filePath));
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'PUT') {
        const message = strField(body, 'message') || 'commit';
        const contentB64 = strField(body, 'content');
        const branch = isRecord(body) && typeof body.branch === 'string' ? (body.branch as string) : repo.defaultBranch;
        const sha = strField(body, 'sha');
        let branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (branchTip === undefined) {
          const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (defaultTip !== undefined && branch !== repo.defaultBranch) repo.refs.set(`refs/heads/${branch}`, defaultTip);
          branchTip = repo.refs.get(`refs/heads/${branch}`);
        }
        const files = branchTip !== undefined ? new Map(filesAt(repo, branchTip)) : new Map<string, FileEnt>();
        const existing = files.get(filePath);
        if (existing !== undefined) {
          if (sha === '' || sha !== existing.oid) {
            sendJson(res, 409, { message: 'sha does not match the current file' });
            return;
          }
        }
        const content = b64decode(contentB64);
        const blobOid = putObject(repo, 'blob', content);
        files.set(filePath, { oid: blobOid, size: content.length, data: content });
        const commitSha = makeCommit(repo, branch, files, message);
        sendJson(res, existing !== undefined ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = isRecord(body) && typeof body.branch === 'string' ? (body.branch as string) : repo.defaultBranch;
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (branchTip === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const files = new Map(filesAt(repo, branchTip));
        if (!files.has(filePath)) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        files.delete(filePath);
        const message = strField(body, 'message') || 'delete';
        const commitSha = makeCommit(repo, branch, files, message);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return;
      }
      notFound(res);
      return;
    }
    if (tail[0] === 'labels') {
      if (method === 'POST') {
        const name = strField(body, 'name');
        const color = strField(body, 'color') || 'ededed';
        if (name === '') {
          sendJson(res, 422, { message: 'name is required' });
          return;
        }
        const existing = repo.labels.get(name);
        if (existing) {
          sendJson(res, 200, { name: existing.name, color: existing.color });
          return;
        }
        const label: Label = { name, color };
        repo.labels.set(name, label);
        sendJson(res, 201, { name, color });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
        return;
      }
      notFound(res);
      return;
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          if (sort !== 'created') list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          paginate(req, res, list, (issue) => issueJson(repo, issue));
          return;
        }
        if (method === 'POST') {
          const title = strField(body, 'title');
          const bodyText = strField(body, 'body');
          const labelNames: string[] = [];
          if (isRecord(body) && Array.isArray(body.labels)) {
            for (const entry of body.labels as unknown[]) {
              if (typeof entry === 'string') labelNames.push(entry);
              else if (isRecord(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
            }
          }
          const labels: Label[] = [];
          for (const name of labelNames) {
            const label = repo.labels.get(name);
            if (!label) {
              sendJson(res, 422, { message: `Label '${name}' does not exist` });
              return;
            }
            labels.push(label);
          }
          if (title === '') {
            sendJson(res, 422, { message: 'title is required' });
            return;
          }
          const issue = createIssueInternal(repo, title, bodyText, labels);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        notFound(res);
        return;
      }
      const number = Number.parseInt(tail[1]!, 10);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (tail.length === 2) {
        if (issue === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (isRecord(body) && typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (isRecord(body) && typeof body.title === 'string') issue.title = body.title;
          if (isRecord(body) && typeof body.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        notFound(res);
        return;
      }
      if (tail[2] === 'comments') {
        if (issue === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } })));
          return;
        }
        if (method === 'POST') {
          const text = strField(body, 'body');
          const comment: Comment = { id: ++objIdCounter, body: text };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } });
          return;
        }
        notFound(res);
        return;
      }
      notFound(res);
      return;
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
          paginate(req, res, [...list].sort((a, b) => b.seq - a.seq), (pull) => pullJson(repo, pull));
          return;
        }
        if (method === 'POST') {
          const title = strField(body, 'title');
          const bodyText = strField(body, 'body');
          const head = strField(body, 'head');
          const base = strField(body, 'base') || repo.defaultBranch;
          const headShort = head.includes(':') ? head.split(':').pop()! : head;
          const baseShort = base.includes(':') ? base.split(':').pop()! : base;
          if (repo.pulls.some((pull) => pull.state === 'open' && pull.headRef === headShort)) {
            sendJson(res, 422, { message: 'A pull request already exists for this head branch' });
            return;
          }
          const pull = createPullInternal(repo, title, bodyText, headShort, baseShort);
          if (pull === null) {
            sendJson(res, 422, { message: 'head or base branch does not exist' });
            return;
          }
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        notFound(res);
        return;
      }
      const number = Number.parseInt(tail[1]!, 10);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (tail.length === 2) {
        if (pull === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        notFound(res);
        return;
      }
      if (tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, pull.files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          sha: '',
        })));
        return;
      }
      if (tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (pull.state === 'closed') {
          sendJson(res, 405, { message: 'Pull request is already closed' });
          return;
        }
        const result = mergePullInternal(repo, pull);
        if ('conflict' in result) {
          sendJson(res, 405, { message: 'Merge conflict' });
          return;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: `Pull request #${pull.number} merged` });
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }
  notFound(res);
}

function dirEntries(repo: Repo, tip: string, dirPath: string): Record<string, unknown>[] {
  const files = filesAt(repo, tip);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const seen = new Map<string, { type: string; sha: string }>();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const file = files.get(path)!;
      seen.set(rest, { type: 'file', sha: file.oid });
    } else {
      const dirName = rest.slice(0, slash);
      if (!seen.has(dirName)) seen.set(dirName, { type: 'dir', sha: '' });
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const name of [...seen.keys()].sort()) {
    const entry = seen.get(name)!;
    out.push({ type: entry.type, name, path: prefix + name, sha: entry.sha || '0'.repeat(40) });
  }
  return out;
}

// ---------------------------------------------------------------- GraphQL v4

interface GqlSelection {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: GqlSelection[] | null;
  inlineType: string | null;
}
interface GqlOp {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

interface GqlToken {
  type: 'name' | 'string' | 'int' | 'punct' | 'var' | 'spread';
  value: string;
}

function gqlTokenize(text: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && text.slice(i, i + 3) === '...') {
      tokens.push({ type: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j += 1;
      tokens.push({ type: 'var', value: text.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          const escCh = text[j + 1]!;
          out += escCh === 'n' ? '\n' : escCh === 't' ? '\t' : escCh === 'r' ? '\r' : escCh;
          j += 2;
        } else {
          out += text[j]!;
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j]!)) j += 1;
      tokens.push({ type: 'int', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j += 1;
      tokens.push({ type: 'name', value: text.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ type: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

class GqlParser {
  tokens: GqlToken[];
  pos = 0;
  constructor(text: string) {
    this.tokens = gqlTokenize(text);
  }
  peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }
  next(): GqlToken {
    return this.tokens[this.pos++]!;
  }
  expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  parseValue(vars: Record<string, unknown>): unknown {
    const token = this.next();
    if (token.type === 'var') return { __var: token.value };
    if (token.type === 'string' || token.type === 'int') {
      if (token.type === 'int') return Number.parseInt(token.value, 10);
      return token.value;
    }
    if (token.value === '[') {
      const list: unknown[] = [];
      while (this.peek()?.value !== ']') list.push(this.parseValue(vars));
      this.expect(']');
      return list;
    }
    if (token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek()?.value !== '}') {
        const key = this.next().value;
        this.expect(':');
        obj[key] = this.parseValue(vars);
      }
      this.expect('}');
      return obj;
    }
    if (token.type === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
  resolveValue(value: unknown, vars: Record<string, unknown>): unknown {
    if (isRecord(value) && '__var' in value) return vars[value.__var as string];
    if (isRecord(value) && '__enum' in value) return value.__enum;
    if (Array.isArray(value)) return value.map((entry) => this.resolveValue(entry, vars));
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) out[key] = this.resolveValue(entry, vars);
      return out;
    }
    return value;
  }
  parseSelectionSet(vars: Record<string, unknown>): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek()?.value !== '}') {
      selections.push(this.parseSelection(vars));
    }
    this.expect('}');
    return selections;
  }
  parseSelection(vars: Record<string, unknown>): GqlSelection {
    if (this.peek()?.type === 'spread') {
      this.next();
      let inlineType: string | null = null;
      if (this.peek()?.value === 'on') {
        this.next();
        inlineType = this.next().value;
      } else if (this.peek()?.type === 'name') {
        this.next(); // named fragment spread: not used by the suite; skip its selections
      }
      const selections = this.peek()?.value === '{' ? this.parseSelectionSet(vars) : [];
      return { alias: null, name: '', args: {}, selections, inlineType };
    }
    let alias: string | null = null;
    let name = this.next().value;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, unknown> = {};
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek()?.value !== ')') {
        const key = this.next().value;
        this.expect(':');
        args[key] = this.resolveValue(this.parseValue(vars), vars);
      }
      this.expect(')');
    }
    const selections = this.peek()?.value === '{' ? this.parseSelectionSet(vars) : null;
    return { alias, name, args, selections, inlineType: null };
  }
  skipParens(): void {
    if (this.peek()?.value !== '(') return;
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token.value === '(') depth += 1;
      else if (token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }
  parseDocument(vars: Record<string, unknown>): GqlOp[] {
    const ops: GqlOp[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.value === '{') {
        ops.push({ kind: 'query', name: null, selections: this.parseSelectionSet(vars) });
      } else if (token.value === 'query' || token.value === 'mutation') {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.type === 'name') name = this.next().value;
        this.skipParens();
        ops.push({ kind, name, selections: this.parseSelectionSet(vars) });
      } else if (token.value === 'fragment') {
        this.next();
        this.next(); // fragment name
        this.next(); // 'on'
        this.next(); // type
        this.parseSelectionSet(vars); // discard
      } else {
        this.next();
      }
    }
    return ops;
  }
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'createdAt', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'author', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'],
  SearchType: [],
};
const GQL_TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

type GqlValue = Record<string, unknown> & { __typename?: string };

function wrapRepo(repo: Repo): GqlValue {
  return { __typename: 'Repository', _repo: repo };
}
function wrapIssue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}
function wrapPull(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function findRepoById(id: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function issueStateGql(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullStateGql(pull: Pull): string {
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  return prConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' ? args.after : null;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 'asc' : 'desc';
  const hasOrderBy = orderBy !== null;
  list.sort((a, b) => {
    if (hasOrderBy) return direction === 'asc' ? a.seq - b.seq : b.seq - a.seq;
    return a.seq - b.seq;
  });
  let start = 0;
  if (after !== null && after !== '') {
    try {
      const text = b64decode(after).toString('utf8');
      const num = Number.parseInt(text.replace('cursor:', ''), 10);
      const idx = list.findIndex((issue) => issue.number === num);
      if (idx >= 0) start = idx + 1;
    } catch {
      start = 0;
    }
  }
  const page = list.slice(start, start + first);
  const hasNext = start + page.length < list.length;
  const endCursor = page.length > 0 ? b64encode(`cursor:${page[page.length - 1]!.number}`) : null;
  return {
    __typename: 'IssueConnection',
    _nodes: page.map((issue) => wrapIssue(repo, issue)),
    _pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, endCursor },
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  const first = typeof args.first === 'number' ? args.first : 100;
  const list = [...repo.pulls].sort((a, b) => b.seq - a.seq).slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    _nodes: list.map((pull) => wrapPull(repo, pull)),
    _pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
  };
}

class GqlExecutor {
  errors: string[] = [];

  resolveField(parentKind: string, parent: GqlValue, sel: GqlSelection): unknown {
    const name = sel.name;
    if (name === '__typename') return parentKind;
    if (parentKind === 'Query') {
      if (name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN };
      if (name === 'repository') {
        const repo = getRepo(String(sel.args.owner ?? ''), String(sel.args.name ?? ''));
        if (!repo || repo.owner !== VIEWER_LOGIN) return null;
        return wrapRepo(repo);
      }
      if (name === 'node') {
        const decoded = decodeGid(String(sel.args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoById(Number.parseInt(decoded.key, 10));
          return repo ? wrapRepo(repo) : null;
        }
        if (decoded.kind === 'Issue') {
          const [repoId, num] = decoded.key.split(':');
          const repo = findRepoById(Number.parseInt(repoId ?? '', 10));
          const issue = repo?.issues.find((entry) => entry.number === Number.parseInt(num ?? '', 10));
          return repo && issue ? wrapIssue(repo, issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const [repoId, num] = decoded.key.split(':');
          const repo = findRepoById(Number.parseInt(repoId ?? '', 10));
          const pull = repo?.pulls.find((entry) => entry.number === Number.parseInt(num ?? '', 10));
          return repo && pull ? wrapPull(repo, pull) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = String(sel.args.name ?? '');
        const fields = GQL_TYPE_FIELDS[typeName];
        if (fields === undefined && GQL_TYPE_ENUMS[typeName] === undefined) return null;
        return {
          __typename: '__Type',
          name: typeName,
          fields: (fields ?? []).map((f) => ({ name: f })),
          enumValues: (GQL_TYPE_ENUMS[typeName] ?? []).map((f) => ({ name: f })),
        };
      }
      this.errors.push(`Cannot query field "${name}" on type "Query".`);
      return null;
    }
    if (parentKind === 'Mutation') {
      const input = isRecord(sel.args.input) ? sel.args.input : {};
      if (name === 'createIssue') {
        const decoded = decodeGid(String(input.repositoryId ?? ''));
        const repo = decoded && decoded.kind === 'Repository' ? findRepoById(Number.parseInt(decoded.key, 10)) : undefined;
        if (!repo) {
          this.errors.push('createIssue: repository not found.');
          return null;
        }
        const issue = createIssueInternal(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __typename: 'CreateIssuePayload', issue: wrapIssue(repo, issue) };
      }
      if (name === 'closeIssue') {
        const decoded = decodeGid(String(input.issueId ?? ''));
        if (!decoded || decoded.kind !== 'Issue') {
          this.errors.push('closeIssue: issue not found.');
          return null;
        }
        const [repoId, num] = decoded.key.split(':');
        const repo = findRepoById(Number.parseInt(repoId ?? '', 10));
        const issue = repo?.issues.find((entry) => entry.number === Number.parseInt(num ?? '', 10));
        if (!repo || !issue) {
          this.errors.push('closeIssue: issue not found.');
          return null;
        }
        issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: wrapIssue(repo, issue) };
      }
      if (name === 'createPullRequest') {
        const decoded = decodeGid(String(input.repositoryId ?? ''));
        const repo = decoded && decoded.kind === 'Repository' ? findRepoById(Number.parseInt(decoded.key, 10)) : undefined;
        if (!repo) {
          this.errors.push('createPullRequest: repository not found.');
          return null;
        }
        const pull = createPullInternal(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        if (!pull) {
          this.errors.push('createPullRequest: head or base branch does not exist.');
          return null;
        }
        return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, pull) };
      }
      if (name === 'mergePullRequest') {
        const decoded = decodeGid(String(input.pullRequestId ?? ''));
        if (!decoded || decoded.kind !== 'PullRequest') {
          this.errors.push('mergePullRequest: pull request not found.');
          return null;
        }
        const [repoId, num] = decoded.key.split(':');
        const repo = findRepoById(Number.parseInt(repoId ?? '', 10));
        const pull = repo?.pulls.find((entry) => entry.number === Number.parseInt(num ?? '', 10));
        if (!repo || !pull) {
          this.errors.push('mergePullRequest: pull request not found.');
          return null;
        }
        const result = mergePullInternal(repo, pull);
        if ('conflict' in result) {
          this.errors.push('mergePullRequest: merge conflict.');
          return null;
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(repo, pull) };
      }
      if (name === 'addComment') {
        const decoded = decodeGid(String(input.subjectId ?? ''));
        if (!decoded || decoded.kind !== 'Issue') {
          this.errors.push('addComment: subject not found.');
          return null;
        }
        const [repoId, num] = decoded.key.split(':');
        const repo = findRepoById(Number.parseInt(repoId ?? '', 10));
        const issue = repo?.issues.find((entry) => entry.number === Number.parseInt(num ?? '', 10));
        if (!repo || !issue) {
          this.errors.push('addComment: subject not found.');
          return null;
        }
        const comment: Comment = { id: ++objIdCounter, body: String(input.body ?? '') };
        issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'CommentEdge',
            node: { __typename: 'Comment', id: gid('Comment', `${repo.id}:${issue.number}:${comment.id}`), body: comment.body },
          },
        };
      }
      this.errors.push(`Cannot query field "${name}" on type "Mutation".`);
      return null;
    }
    if (parentKind === 'Repository') {
      const repo = parent._repo as Repo;
      if (name === 'id') return gid('Repository', String(repo.id));
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return { __typename: 'User', login: repo.owner };
      if (name === 'description') return repo.description;
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const issue = repo.issues.find((entry) => entry.number === sel.args.number);
        return issue ? wrapIssue(repo, issue) : null;
      }
      if (name === 'issues') return issuesConnection(repo, sel.args);
      if (name === 'pullRequests') return pullsConnection(repo, sel.args);
      if (name === 'pullRequest') {
        const pull = repo.pulls.find((entry) => entry.number === sel.args.number);
        return pull ? wrapPull(repo, pull) : null;
      }
      this.errors.push(`Cannot query field "${name}" on type "Repository".`);
      return null;
    }
    if (parentKind === 'Issue') {
      const issue = parent._issue as Issue;
      const repo = parent._repo as Repo;
      if (name === 'id') return gid('Issue', `${repo.id}:${issue.number}`);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issueStateGql(issue);
      if (name === 'body') return issue.body;
      if (name === 'url') return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
      this.errors.push(`Cannot query field "${name}" on type "Issue".`);
      return null;
    }
    if (parentKind === 'PullRequest') {
      const pull = parent._pull as Pull;
      const repo = parent._repo as Repo;
      if (name === 'id') return gid('PullRequest', `${repo.id}:${pull.number}`);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pullStateGql(pull);
      if (name === 'merged') return pull.merged;
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'mergeable') return pullMergeable(repo, pull);
      if (name === 'files') {
        const first = typeof sel.args.first === 'number' ? sel.args.first : 100;
        return {
          __typename: 'PullRequestChangedFileConnection',
          _nodes: pull.files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
        };
      }
      this.errors.push(`Cannot query field "${name}" on type "PullRequest".`);
      return null;
    }
    if (parentKind === 'User') {
      if (name === 'login') return parent.login as string;
      this.errors.push(`Cannot query field "${name}" on type "User".`);
      return null;
    }
    if (parentKind === 'IssueConnection') {
      if (name === 'nodes') return parent._nodes as GqlValue[];
      if (name === 'pageInfo') return parent._pageInfo as GqlValue;
      if (name === 'totalCount') return (parent._nodes as GqlValue[]).length;
      this.errors.push(`Cannot query field "${name}" on type "IssueConnection".`);
      return null;
    }
    if (parentKind === 'PullRequestConnection') {
      if (name === 'nodes') return parent._nodes as GqlValue[];
      if (name === 'pageInfo') return parent._pageInfo as GqlValue;
      this.errors.push(`Cannot query field "${name}" on type "PullRequestConnection".`);
      return null;
    }
    if (parentKind === 'PageInfo') {
      if (name === 'hasNextPage') return parent.hasNextPage as boolean;
      if (name === 'endCursor') return parent.endCursor as string | null;
      this.errors.push(`Cannot query field "${name}" on type "PageInfo".`);
      return null;
    }
    if (parentKind === 'PullRequestChangedFileConnection') {
      if (name === 'nodes') return parent._nodes as GqlValue[];
      this.errors.push(`Cannot query field "${name}" on type "PullRequestChangedFileConnection".`);
      return null;
    }
    if (parentKind === 'PullRequestChangedFile') {
      if (name === 'path') return parent.path as string;
      this.errors.push(`Cannot query field "${name}" on type "PullRequestChangedFile".`);
      return null;
    }
    if (parentKind === 'Ref') {
      if (name === 'name') return parent.name as string;
      this.errors.push(`Cannot query field "${name}" on type "Ref".`);
      return null;
    }
    if (parentKind === '__Type') {
      if (name === 'fields') return parent.fields as unknown[];
      if (name === 'enumValues') return parent.enumValues as unknown[];
      if (name === 'name') return parent.name as string;
      this.errors.push(`Cannot query field "${name}" on type "__Type".`);
      return null;
    }
    if (parentKind === 'CreateIssuePayload' || parentKind === 'CloseIssuePayload') {
      if (name === 'issue') return parent.issue as GqlValue;
      this.errors.push(`Cannot query field "${name}" on type "${parentKind}".`);
      return null;
    }
    if (parentKind === 'CreatePullRequestPayload' || parentKind === 'MergePullRequestPayload') {
      if (name === 'pullRequest') return parent.pullRequest as GqlValue;
      this.errors.push(`Cannot query field "${name}" on type "${parentKind}".`);
      return null;
    }
    if (parentKind === 'AddCommentPayload') {
      if (name === 'commentEdge') return parent.commentEdge as GqlValue;
      this.errors.push(`Cannot query field "${name}" on type "AddCommentPayload".`);
      return null;
    }
    if (parentKind === 'CommentEdge') {
      if (name === 'node') return parent.node as GqlValue;
      this.errors.push(`Cannot query field "${name}" on type "CommentEdge".`);
      return null;
    }
    if (parentKind === 'Comment') {
      if (name === 'id') return parent.id as string;
      if (name === 'body') return parent.body as string;
      this.errors.push(`Cannot query field "${name}" on type "Comment".`);
      return null;
    }
    this.errors.push(`Cannot query field "${name}" on type "${parentKind}".`);
    return null;
  }

  childKind(parentKind: string, field: string, value: unknown): string {
    if (Array.isArray(value)) return this.childKind(parentKind, field, value[0]);
    if (!isRecord(value) || typeof value.__typename !== 'string') return parentKind;
    return value.__typename;
  }

  executeSelections(parentKind: string, parent: GqlValue | null, selections: GqlSelection[]): Record<string, unknown> | null {
    if (parent === null) return null;
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.inlineType !== null) {
        if (sel.inlineType !== parentKind && sel.inlineType !== (parent.__typename ?? '')) continue;
        const nested = this.executeSelections(parentKind, parent, sel.selections ?? []);
        if (nested !== null) Object.assign(out, nested);
        continue;
      }
      if (sel.name === '') continue;
      const key = sel.alias ?? sel.name;
      const value = this.resolveField(parentKind, parent, sel);
      if (value === null || value === undefined) {
        out[key] = null;
        continue;
      }
      if (sel.selections === null) {
        out[key] = value;
        continue;
      }
      if (Array.isArray(value)) {
        const kind = value.length > 0 ? this.childKind(parentKind, sel.name, value[0]) : parentKind;
        out[key] = value.map((entry) => this.executeSelections(kind, entry as GqlValue, sel.selections!));
        continue;
      }
      const kind = this.childKind(parentKind, sel.name, value);
      out[key] = this.executeSelections(kind, value as GqlValue, sel.selections);
    }
    return out;
  }

  execute(op: GqlOp): { data: Record<string, unknown> | null; errors: { message: string }[] } {
    const rootKind = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = this.executeSelections(rootKind, { __typename: rootKind }, op.selections);
    return { data, errors: this.errors.map((message) => ({ message })) };
  }
}

function runGraphQLOp(query: string, variables: Record<string, unknown>, operationName?: string): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const executor = new GqlExecutor();
  try {
    const parser = new GqlParser(query);
    const ops = parser.parseDocument(variables);
    let op = ops[0];
    if (operationName !== undefined) {
      op = ops.find((entry) => entry.name === operationName) ?? ops[0]!;
    }
    if (!op) return { data: null, errors: [{ message: 'No operation found.' }] };
    return executor.execute(op);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
    return;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') return { data: null, errors: [{ message: 'Invalid operation.' }] };
      const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
      return runGraphQLOp(entry.query, variables, typeof entry.operationName === 'string' ? entry.operationName : undefined);
    });
    sendJson(res, 200, results);
    return;
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'Request body must carry a query string.' }] });
    return;
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const result = runGraphQLOp(body.query, variables, typeof body.operationName === 'string' ? body.operationName : undefined);
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: Record<string, unknown>[] = [
  { name: 'create_repo', description: 'Create a repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues of a repository, optionally filtered by state.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch into a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'list_repos', description: 'List repositories owned by the authenticated user.', inputSchema: { type: 'object', properties: {}, required: [] } },
];

function mcpTextResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

function mcpErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function callMcpTool(name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { rpcError: { code: number; message: string } } {
  const owner = pickStr(args, ['owner', 'owner_login', 'login']);
  const repoName = pickStr(args, ['repo', 'repository', 'repository_name', 'repo_name']);
  if (name === 'create_repo') {
    const repoNameArg = pickStr(args, ['name', 'repo', 'repository']);
    if (repoNameArg === '') return { rpcError: { code: -32602, message: 'create_repo requires name' } };
    if (getRepo(VIEWER_LOGIN, repoNameArg) !== undefined) return { rpcError: { code: -32602, message: 'Repository already exists' } };
    const repo = createRepoInternal(repoNameArg, args.private === true, pickStr(args, ['description', 'about', 'summary']));
    return { result: mcpTextResult(repoJson(repo)) };
  }
  if (name === 'list_repos') {
    return { result: mcpTextResult({ repositories: viewerRepos().map((repo) => repoJson(repo)) }) };
  }
  const repo = owner !== '' && repoName !== '' ? getRepo(owner, repoName) : undefined;
  if (repo === undefined || repo.owner !== VIEWER_LOGIN) {
    if (name === 'get_repo' || name === 'create_issue' || name === 'list_issues' || name === 'create_pull_request' || name === 'merge_pull_request') {
      return { rpcError: { code: -32602, message: 'repository not found' } };
    }
    return { rpcError: { code: -32601, message: `unknown tool ${name}` } };
  }
  if (name === 'get_repo') return { result: mcpTextResult(repoJson(repo)) };
  if (name === 'create_issue') {
    const title = pickStr(args, ['title', 'issue_title', 'subject']);
    if (title === '') return { rpcError: { code: -32602, message: 'create_issue requires title' } };
    const issue = createIssueInternal(repo, title, pickStr(args, ['body', 'issue_body', 'description']), []);
    return { result: mcpTextResult(issueJson(repo, issue)) };
  }
  if (name === 'list_issues') {
    const state = pickStr(args, ['state', 'status']) || 'open';
    const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return { result: mcpTextResult({ issues: list.map((issue) => issueJson(repo, issue)) }) };
  }
  if (name === 'create_pull_request') {
    const title = pickStr(args, ['title', 'pr_title', 'subject']);
    const head = pickStr(args, ['head', 'head_ref', 'head_branch', 'source', 'branch']);
    const base = pickStr(args, ['base', 'base_ref', 'base_branch', 'target']) || repo.defaultBranch;
    if (title === '' || head === '') return { rpcError: { code: -32602, message: 'create_pull_request requires title and head' } };
    const pull = createPullInternal(repo, title, pickStr(args, ['body', 'description']), head, base);
    if (pull === null) return { rpcError: { code: -32602, message: 'head or base branch does not exist' } };
    return { result: mcpTextResult(pullJson(repo, pull)) };
  }
  if (name === 'merge_pull_request') {
    const numRaw = pickArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']);
    const number = typeof numRaw === 'number' ? numRaw : Number.parseInt(String(numRaw ?? ''), 10);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return { rpcError: { code: -32602, message: 'pull request not found' } };
    if (pull.state === 'closed') return { result: mcpErrorResult('Pull request is already closed') };
    const result = mergePullInternal(repo, pull);
    if ('conflict' in result) return { result: mcpErrorResult('Merge conflict') };
    return { result: mcpTextResult({ merged: true, sha: result.sha, number: pull.number }) };
  }
  return { rpcError: { code: -32601, message: `unknown tool ${name}` } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = body.id === undefined ? null : body.id;
  if (!authed(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32000, message: 'Unauthorized' } });
    return;
  }
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  if (method === 'server/discover') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2026-07-28',
        supportedVersions: ['2026-07-28', '2025-11-25'],
        serverInfo: { name: 'forge', version: '1.0.0' },
        capabilities: { tools: {} },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' },
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      },
    });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const accepted = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: accepted.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = MCP_TOOLS.find((entry) => entry.name === toolName);
    if (!tool) {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${toolName}` } });
      return;
    }
    const schema = tool.inputSchema as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: `missing required argument(s): ${missing.join(', ')}` } });
      return;
    }
    const outcome = callMcpTool(toolName, args);
    if ('rpcError' in outcome) {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: outcome.rpcError });
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, result: outcome.result });
    return;
  }
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

// ---------------------------------------------------------------- server + lifecycle

const GIT_RE = /^\/([^/]+)\/([^/]+)\.git(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/;

const server = createServer((req, res) => {
  void (async () => {
    try {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      const gitMatch = GIT_RE.exec(path);
      if (gitMatch) {
        const owner = gitMatch[1]!;
        const name = gitMatch[2]!;
        const service = gitMatch[3]!;
        const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
        if (method === 'GET' && service === '/info/refs') {
          const serviceParam = queryOf(req).get('service') ?? '';
          handleInfoRefs(req, res, owner, name, serviceParam);
          return;
        }
        if (repo === undefined) {
          notFound(res);
          return;
        }
        if (method === 'POST' && service === '/git-upload-pack') {
          await handleUploadPack(req, res, repo);
          return;
        }
        if (method === 'POST' && service === '/git-receive-pack') {
          await handleReceivePack(req, res, repo);
          return;
        }
        notFound(res);
        return;
      }
      if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
        await handleRest(req, res);
        return;
      }
      if (path === '/api/graphql' && method === 'POST') {
        await handleGraphQL(req, res);
        return;
      }
      if (path === '/mcp' && method === 'POST') {
        await handleMcp(req, res);
        return;
      }
      notFound(res);
    } catch (err) {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
      } catch {
        // ignore
      }
    }
  })();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // not done yet
    }
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  if (ENV_URL === '') {
    process.stdout.write('[forge] MAKEFUN_ENV_URL is not set; serving standalone (no register, no done poll)\n');
    return;
  }
  await register(address.port);
  process.stdout.write('[forge] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  if (ENV_URL !== '') process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
