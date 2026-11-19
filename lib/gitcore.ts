// Git object model, pkt-line framing, and packfile read/write — Node standard library only.
// Objects are plain (no deltas) on the wire; packs we read may carry deltas, which we apply.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { FIXED_EPOCH, VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME, ZERO_OID } from './util.ts';

export const ZERO = ZERO_OID;

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): { sha: string; raw: Buffer } {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const raw = Buffer.concat([header, data]);
  return { sha: sha1Hex(raw), raw };
}

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// Commits, trees, tags
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = ZERO;
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message, raw: data };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // git sorts trees as if directory names ended in '/'.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`);
  lines.push(`committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`);
  lines.push('');
  lines.push(message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function buildTag(object: string, type: string, tag: string, message: string): Buffer {
  const lines = [
    `object ${object}`,
    `type ${type}`,
    `tag ${tag}`,
    `tagger ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`,
    '',
    message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function authorOfCommit(data: Buffer): { name: string; email: string } {
  const text = data.toString('utf8');
  const match = /^author ([^<]+) <([^>]+)>/m.exec(text);
  if (match) return { name: match[1].trim(), email: match[2] };
  return { name: VIEWER_NAME, email: VIEWER_EMAIL };
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    if (len === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) throw new Error('pkt-line truncated');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, GitObject['type']> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const TYPE_NUMBERS: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = buf[offset] & 0x7f;
  let shift = 7;
  let pos = offset + 1;
  while (buf[offset] & 0x80) {
    value |= (buf[pos] & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { value, next: pos };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVar = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVar();
  if (baseSize !== base.length) throw new Error(`delta expects a ${baseSize}-byte base, got ${base.length}`);
  const targetSize = readVar();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) copyOffset |= delta[offset++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) copySize |= delta[offset++] << (8 * i);
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert truncated');
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

export function readPack(pack: Buffer, resolveBase?: (sha: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const deltas: Array<{ delta: Buffer; baseSha: string | null; baseOffset: number | null }> = [];
  let offset = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    const startOffset = offset;
    const first = pack[offset];
    const typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while (pack[offset - 1] & 0x80) {
      size |= (pack[offset] & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    if (typeNum === 6 || typeNum === 7) {
      deltaCount += 1;
      let baseSha: string | null = null;
      let baseOffset: number | null = null;
      if (typeNum === 7) {
        baseSha = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      } else {
        const firstByte = pack[offset++];
        let base = firstByte & 0x7f;
        let byte = firstByte;
        while (byte & 0x80) {
          byte = pack[offset++];
          base = ((base + 1) << 7) | (byte & 0x7f);
        }
        baseOffset = startOffset - base;
      }
      const { data, consumed } = inflateBounded(pack, offset, size);
      offset += consumed;
      deltas.push({ delta: data, baseSha, baseOffset });
      continue;
    }
    const type = PACK_TYPES[typeNum];
    if (!type) throw new Error(`unknown pack object type ${typeNum}`);
    const { data, consumed } = inflateBounded(pack, offset, size);
    offset += consumed;
    const { sha } = hashObject(type, data);
    const obj: GitObject = { type, data };
    objects.set(sha, obj);
    byOffset.set(startOffset, obj);
  }
  // Resolve deltas (bases may appear later in the pack, or live in the repo already).
  for (const entry of deltas) {
    let base: GitObject | undefined;
    if (entry.baseOffset !== null) base = byOffset.get(entry.baseOffset);
    if (!base && entry.baseSha !== null) base = objects.get(entry.baseSha) ?? resolveBase?.(entry.baseSha);
    if (!base) throw new Error('delta base not found');
    const data = applyDelta(base.data, entry.delta);
    const { sha } = hashObject(base.type, data);
    objects.set(sha, { type: base.type, data });
  }
  return { objects, deltaCount };
}

// Inflate a zlib stream starting at `offset`, expecting `size` bytes out; returns the data and
// the number of input bytes consumed. One inflateSync call: with `{info: true}` Node reports
// `engine.bytesWritten`, the input bytes the stream actually consumed, so trailing bytes
// (the next object) are left untouched.
export function inflateBounded(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (result.buffer.length !== expectedSize) {
    throw new Error(`inflate produced ${result.buffer.length} bytes, expected ${expectedSize}`);
  }
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

export function writePack(objects: Array<{ type: GitObject['type']; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeNum = TYPE_NUMBERS[obj.type];
    const size = obj.data.length;
    const bytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    bytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  return expected === actual;
}
