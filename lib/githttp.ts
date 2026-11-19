// Git smart HTTP: info/refs, upload-pack (protocol v2 and v0), receive-pack (v0).
// Wire formats follow the kit's git-client.ts parser exactly.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decodePktLines,
  isOid,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO,
  type GitObject,
  type Pkt,
} from './gitcore.ts';
import { ancestors, collectReachable, getObject, isAncestor, walkCommits, type Repo, type Store } from './store.ts';
import { readBody, ZERO_OID } from './util.ts';

const AGENT = 'github-core-clone/1.0.0';
const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message }));
}

function sidebandPackets(pack: Buffer): Buffer[] {
  // Sideband band 1: each pkt-line carries at most 65520 bytes total.
  const out: Buffer[] = [];
  const maxData = 65520 - 5; // pkt header + band byte
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function sortedRefs(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [name, sha] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out.push({ name, sha });
  }
  return out;
}

function peeledSha(repo: Repo, refSha: string): string | null {
  const obj = repo.objects.get(refSha);
  if (!obj) return null;
  if (obj.type === 'tag') {
    const text = obj.data.toString('utf8');
    const match = /^object ([0-9a-f]{40})$/m.exec(text);
    if (match) {
      const target = repo.objects.get(match[1]);
      if (target && target.type === 'commit') return match[1];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const service = url.searchParams.get('service');
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJsonError(res, 404, 'Not Found');
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJsonError(res, 400, 'service parameter is required');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
  const parts: Buffer[] = [];
  const isReceive = service === 'git-receive-pack';
  if (wantsV2) {
    parts.push(pktLine('# service=git-upload-pack\n'));
    parts.push(PKT_FLUSH);
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(PKT_FLUSH);
    send(res, 200, UPLOAD_AD_CT, Buffer.concat(parts));
    return;
  }
  // v0 advertisement.
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(PKT_FLUSH);
  const caps = isReceive
    ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`
    : `side-band-64k multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headRef = `refs/heads/${repo.defaultBranch}`;
    const headSha = repo.refs.get(headRef);
    // HEAD first, carrying the capabilities.
    if (headSha) parts.push(pktLine(`${headSha} HEAD\0${caps}\n`));
    for (const ref of refs) {
      if (headSha && ref.name === 'HEAD') continue;
      let line = `${ref.sha} ${ref.name}\n`;
      const peeled = peeledSha(repo, ref.sha);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      if (!headSha && ref === refs[0]) line = `${ref.sha} ${ref.name}\0${caps}\n`;
      parts.push(pktLine(line));
    }
    if (!headSha && refs.length > 0) {
      // No default-branch tip: capabilities rode on the first ref line already.
    }
  }
  parts.push(PKT_FLUSH);
  send(res, 200, isReceive ? RECEIVE_AD_CT : UPLOAD_AD_CT, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowIn: string[];
  depth: number | null;
}

function planFetch(repo: Repo, plan: FetchPlan): {
  commits: Array<{ sha: string; depth: number }>;
  shallow: string[];
  unshallow: string[];
  objects: Map<string, GitObject>;
} {
  // Walk the commit graph from the wants, honouring only the depth limit. The walk
  // deliberately goes through haves: a deepen fetch asks for the parents of a commit
  // the client already holds. Objects the client has are removed afterwards by set
  // difference, which is exactly git's rule (reachable(wants) minus reachable(haves)).
  // A tag want also walks from its peeled commit, so the tag's history is included.
  const walkTips: string[] = [];
  for (const want of plan.wants) {
    walkTips.push(want);
    const obj = repo.objects.get(want);
    if (obj?.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match) walkTips.push(match[1]);
    }
  }
  const walked = walkCommits(repo, walkTips, new Set(), plan.depth === null ? null : plan.depth - 1);
  const commits = walked;
  // Boundary commits are the deepest included generation when depth-limited.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (plan.depth !== null) {
    const maxDepth = plan.depth - 1;
    for (const { sha, depth } of commits) {
      if (depth === maxDepth) shallow.push(sha);
    }
    for (const old of plan.shallowIn) {
      const inPack = commits.some((c) => c.sha === old);
      if (inPack && !shallow.includes(old)) unshallow.push(old);
    }
  } else {
    // No depth limit: any old shallow boundary whose parents are now included unshallows.
    for (const old of plan.shallowIn) {
      const obj = repo.objects.get(old);
      if (obj && obj.type === 'commit') unshallow.push(old);
    }
  }
  const included = collectReachable(repo, commits.map((c) => c.sha));
  const haveObjects = plan.haves.length > 0 ? collectReachable(repo, plan.haves) : new Map<string, GitObject>();
  const objects = new Map<string, GitObject>();
  for (const [sha, obj] of included) {
    if (!haveObjects.has(sha)) objects.set(sha, obj);
  }
  return { commits, shallow, unshallow, objects };
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]);
  }
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim && line.startsWith('command=')) command = line.slice('command='.length);
    else if (seenDelim) args.push(line);
  }
  if (command === 'ls-refs') {
    const peel = args.includes('peel');
    const symrefs = args.includes('symrefs');
    const unborn = args.includes('unborn');
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
    const out: Buffer[] = [];
    const refs = sortedRefs(repo);
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (refs.length === 0) {
      if (unborn && keep('HEAD')) {
        out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
    } else {
      const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (headSha && keep('HEAD') && symrefs) {
        out.push(pktLine(`${headSha} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
      for (const ref of refs) {
        if (!keep(ref.name)) continue;
        let line = `${ref.sha} ${ref.name}`;
        if (peel) {
          const peeled = peeledSha(repo, ref.sha);
          if (peeled) line += ` peeled:${peeled}`;
        }
        out.push(pktLine(`${line}\n`));
      }
    }
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  }
  if (command === 'fetch') {
    const plan: FetchPlan = { wants: [], haves: [], shallowIn: [], depth: null };
    for (const arg of args) {
      if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) plan.shallowIn.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) plan.depth = parseInt(arg.slice(7), 10);
    }
    const validWants = plan.wants.filter((w) => isOid(w) && repo.objects.has(w));
    const out: Buffer[] = [];
    out.push(pktLine('acknowledgments\n'));
    const covered = validWants.filter((w) => ancestors(repo, plan.haves).has(w));
    // A want the client already holds needs no pack — unless a deepen asks for more
    // generations below it, in which case the plan below still has work to do.
    if (plan.depth === null && covered.length === validWants.length && validWants.length > 0) {
      for (const w of covered) out.push(pktLine(`ACK ${w}\n`));
      out.push(PKT_FLUSH);
      return Buffer.concat(out);
    }
    out.push(pktLine('NAK\n'));
    out.push(PKT_DELIM);
    const { shallow, unshallow, objects } = planFetch(repo, { ...plan, wants: validWants });
    if (shallow.length > 0 || unshallow.length > 0) {
      out.push(pktLine('shallow-info\n'));
      for (const s of shallow) out.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
      out.push(PKT_DELIM);
    }
    if (objects.size > 0) {
      const pack = writePack([...objects.values()]);
      out.push(pktLine('packfile\n'));
      out.push(...sidebandPackets(pack));
    }
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  }
  // Unknown command: answer an empty fetch-style response so the client gets a protocol error
  // it can report, rather than a hanging connection.
  return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]);
}

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    return Buffer.concat([pktLine('NAK\n'), PKT_FLUSH]);
  }
  // v0 is two sections: wants (+shallow/deepen) then haves/done, each ended by a flush.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const validWants = wants.filter((w) => isOid(w) && repo.objects.has(w));
  const out: Buffer[] = [];
  const haveAncestors = ancestors(repo, haves);
  const covered = validWants.filter((w) => haveAncestors.has(w));
  // Same deepen caveat as the v2 path: a deepen fetch still needs its extra generations.
  if (depth === null && validWants.length > 0 && covered.length === validWants.length) {
    for (const w of covered) out.push(pktLine(`ACK ${w}\n`));
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  }
  out.push(pktLine('NAK\n'));
  const { shallow, unshallow, objects } = planFetch(repo, { wants: validWants, haves, shallowIn, depth });
  for (const s of shallow) out.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
  if (objects.size > 0) {
    const pack = writePack([...objects.values()]);
    out.push(...sidebandPackets(pack));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

export async function handleUploadPack(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): Promise<void> {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJsonError(res, 404, 'Not Found');
    return;
  }
  const body = await readBody(req);
  const isV2 = req.headers['git-protocol'] === 'version=2';
  const out = isV2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
  send(res, 200, UPLOAD_RESULT_CT, out);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export async function handleReceivePack(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): Promise<void> {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJsonError(res, 404, 'Not Found');
    return;
  }
  const body = await readBody(req);
  const reportLines: string[] = [];
  let unpackOk = true;
  try {
    // Parse pkt-lines one at a time until the first flush; everything after it is the
    // packfile, which must never be read as pkt-lines (it starts with "PACK").
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let packStart = body.length;
    let offset = 0;
    while (offset + 4 <= body.length) {
      const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) throw new Error('bad pkt-line length');
      if (len === 0) {
        packStart = offset + 4;
        break;
      }
      if (len === 1 || len === 2) {
        offset += 4;
        continue;
      }
      if (offset + len > body.length) throw new Error('pkt-line truncated');
      const line = body.subarray(offset + 4, offset + len).toString('utf8');
      const nul = line.indexOf('\0');
      const head = nul >= 0 ? line.slice(0, nul) : line.replace(/\n$/, '');
      const parts = head.trim().split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      offset += len;
    }
    const packBytes = body.subarray(packStart);
    const hasUpdate = commands.some((c) => c.newOid !== ZERO_OID);
    if (hasUpdate) {
      if (packBytes.length === 0) throw new Error('missing packfile');
      if (!verifyPackChecksum(packBytes)) throw new Error('pack checksum mismatch');
      const { objects } = readPack(packBytes, (sha) => getObject(repo, sha));
      for (const [sha, obj] of objects) {
        if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
      }
    }
    // Validate and apply commands, collecting per-ref results.
    const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not match' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      const newObj = repo.objects.get(cmd.newOid);
      if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        // New ref: allowed only when the command's old is zero.
        if (cmd.oldOid !== ZERO_OID) {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not match' });
        continue;
      }
      // Fast-forward check: the new tip must descend from the old tip.
      const tip = newObj.type === 'tag' ? tagTarget(repo, cmd.newOid) : cmd.newOid;
      if (tip === null || !isAncestor(repo, current, tip)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
    // If this is the first push, the default branch follows the first branch created.
    if (repo.refs.size > 0 && !repo.refs.has(`refs/heads/${repo.defaultBranch}`)) {
      const firstBranch = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort()[0];
      if (firstBranch) repo.defaultBranch = firstBranch.slice('refs/heads/'.length);
    }
    reportLines.push('unpack ok');
    for (const result of results) {
      reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
    }
  } catch (err) {
    unpackOk = false;
    reportLines.push(`unpack ${err instanceof Error ? err.message : 'error'}`);
  }
  void unpackOk;
  const inner = Buffer.concat(reportLines.map((line) => pktLine(`${line}\n`)));
  const out = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
  send(res, 200, RECEIVE_RESULT_CT, out);
}

function tagTarget(repo: Repo, tagSha: string): string | null {
  const obj = repo.objects.get(tagSha);
  if (!obj || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match ? match[1] : null;
}
