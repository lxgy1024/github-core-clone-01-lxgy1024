// In-memory store for one forge instance. Everything lives in Maps; nothing touches
// disk per request, which keeps the timed workloads fast. All timestamps are fixed.
import {
  buildCommit,
  buildTag,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './gitcore.ts';
import { FIXED_ISO, VIEWER_LOGIN, ZERO_OID } from './util.ts';

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  closedAt: string | null;
}

export interface Pull {
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
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name -> commit sha
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number; // shared issue/PR counter (GitHub numbering)
  nextCommentId: number;
  nextSeq: number; // creation order for issues/PRs (drives created_at sorting)
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  nextRepoId = 1;
  nextRepoSeq = 1;
  nextIssueId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      nextSeq: 1,
      seq: this.nextRepoSeq++,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Object helpers (per repo)
// ---------------------------------------------------------------------------

export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const { sha } = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function getObject(repo: Repo, sha: string): GitObject | undefined {
  return repo.objects.get(sha);
}

export function refSha(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function headSha(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

// Walk commits from `tips` (BFS over parents), stopping at any commit in `stopAt`.
// Returns the visited commits in BFS order with their depth from the nearest tip.
export function walkCommits(
  repo: Repo,
  tips: string[],
  stopAt: Set<string> = new Set(),
  maxDepth: number | null = null,
): Array<{ sha: string; depth: number }> {
  const seen = new Map<string, number>();
  const queue: Array<{ sha: string; depth: number }> = [];
  for (const tip of tips) {
    if (tip === ZERO_OID) continue;
    if (!seen.has(tip)) {
      seen.set(tip, 0);
      queue.push({ sha: tip, depth: 0 });
    }
  }
  const out: Array<{ sha: string; depth: number }> = [];
  while (queue.length > 0) {
    const { sha, depth } = queue.shift()!;
    if (stopAt.has(sha)) continue;
    out.push({ sha, depth });
    if (maxDepth !== null && depth >= maxDepth) continue;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!seen.has(parent) && !stopAt.has(parent)) {
        seen.set(parent, depth + 1);
        queue.push({ sha: parent, depth: depth + 1 });
      }
    }
  }
  return out;
}

// All ancestors of `tips` (including the tips themselves).
export function ancestors(repo: Repo, tips: string[]): Set<string> {
  const out = new Set<string>();
  for (const { sha } of walkCommits(repo, tips)) out.add(sha);
  return out;
}

export function isAncestor(repo: Repo, maybeAncestor: string, tip: string): boolean {
  if (maybeAncestor === tip) return true;
  if (maybeAncestor === ZERO_OID) return true; // creating a new ref: anything is a fast-forward
  // Targeted search from the tip: a fast-forward's old tip is usually the new tip's
  // parent, found in one step — no need to walk the whole history first.
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === maybeAncestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

// Collect every object reachable from the given object ids — commits contribute their
// trees and blobs, annotated tags contribute themselves plus their target. This does
// NOT walk commit parents: the caller decides exactly which commits are included
// (depth limits, have-exclusion), and this only expands trees/tags.
export function collectReachable(repo: Repo, objectShas: string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const visitTree = (treeSha: string): void => {
    const treeObj = repo.objects.get(treeSha);
    if (!treeObj || treeObj.type !== 'tree' || out.has(treeSha)) return;
    out.set(treeSha, treeObj);
    for (const entry of parseTree(treeObj.data)) {
      const obj = repo.objects.get(entry.sha);
      if (!obj || out.has(entry.sha)) continue;
      if (entry.mode === '40000') visitTree(entry.sha);
      else out.set(entry.sha, obj);
    }
  };
  const visit = (sha: string): void => {
    const obj = repo.objects.get(sha);
    if (!obj || out.has(sha)) return;
    out.set(sha, obj);
    if (obj.type === 'commit') visitTree(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match) visit(match[1]);
    }
  };
  for (const sha of objectShas) visit(sha);
  return out;
}

// Flatten a tree (by sha) to path -> {sha, mode}. Returns null when the tree is missing.
export function flattenTree(repo: Repo, treeSha: string | null): Map<string, { sha: string; mode: string }> | null {
  if (treeSha === null) return new Map();
  const out = new Map<string, { sha: string; mode: string }>();
  const walk = (sha: string, prefix: string): void => {
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.sha, path);
      else out.set(path, { sha: entry.sha, mode: entry.mode });
    }
  };
  walk(treeSha, '');
  return out;
}

// Build a new tree from a flat path map, creating intermediate trees as needed.
// `base` is the tree the new tree derives from (for unchanged subtrees); pass null for empty.
export function buildTreeFromFlat(repo: Repo, flat: Map<string, { sha: string; mode: string }>): string {
  // Group paths by directory.
  const buildDir = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, { sha: string; mode: string }>>();
    for (const [path, value] of flat) {
      if (prefix && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: value.mode, name: rest, sha: value.sha });
      } else {
        const dir = rest.slice(0, slash);
        let sub = subdirs.get(dir);
        if (!sub) {
          sub = new Map();
          subdirs.set(dir, sub);
        }
        sub.set(rest.slice(slash + 1), value);
      }
    }
    for (const [dir, sub] of subdirs) {
      const subFlat = new Map<string, { sha: string; mode: string }>();
      for (const [k, v] of sub) subFlat.set(k, v);
      const subSha = buildDirFlat(subFlat);
      entries.push({ mode: '40000', name: dir, sha: subSha });
    }
    const data = buildTree(entries);
    return putObject(repo, 'tree', data);
  };
  const buildDirFlat = (subFlat: Map<string, { sha: string; mode: string }>): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, { sha: string; mode: string }>>();
    for (const [path, value] of subFlat) {
      const slash = path.indexOf('/');
      if (slash < 0) entries.push({ mode: value.mode, name: path, sha: value.sha });
      else {
        const dir = path.slice(0, slash);
        let sub = subdirs.get(dir);
        if (!sub) {
          sub = new Map();
          subdirs.set(dir, sub);
        }
        sub.set(path.slice(slash + 1), value);
      }
    }
    for (const [dir, sub] of subdirs) entries.push({ mode: '40000', name: dir, sha: buildDirFlat(sub) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return buildDir('');
}

// Create a commit on `ref` (or the default branch) from a new flat tree.
export function commitFlatTree(repo: Repo, ref: string, flat: Map<string, { sha: string; mode: string }>, message: string): string {
  const treeSha = buildTreeFromFlat(repo, flat);
  const parent = repo.refs.get(ref);
  const parents = parent && parent !== ZERO_OID ? [parent] : [];
  const commitSha = putObject(repo, 'commit', buildCommit(treeSha, parents, message));
  repo.refs.set(ref, commitSha);
  return commitSha;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

// Diff two trees (by sha) as flat path maps.
export function diffTrees(repo: Repo, baseTreeSha: string | null, headTreeSha: string | null): FileDiff[] {
  const base = flattenTree(repo, baseTreeSha) ?? new Map();
  const head = flattenTree(repo, headTreeSha) ?? new Map();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const blob = repo.objects.get(b.sha);
      const deletions = blob ? countLines(blob.data) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const blob = repo.objects.get(h.sha);
      const additions = blob ? countLines(blob.data) : 0;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.sha !== h.sha) {
      const blobB = repo.objects.get(b.sha);
      const blobH = repo.objects.get(h.sha);
      const linesB = blobB ? countLines(blobB.data) : 0;
      const linesH = blobH ? countLines(blobH.data) : 0;
      const additions = Math.max(0, linesH - linesB);
      const deletions = Math.max(0, linesB - linesH);
      out.push({
        filename: path,
        status: 'modified',
        additions: additions === 0 && deletions === 0 ? 1 : additions,
        deletions,
        changes: Math.max(1, additions + deletions),
      });
    }
  }
  return out;
}

// Find the merge base of two commits (first common ancestor by BFS depth).
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === ZERO_OID || b === ZERO_OID) return null;
  const depthA = new Map<string, number>();
  for (const { sha, depth } of walkCommits(repo, [a])) depthA.set(sha, depth);
  let best: string | null = null;
  let bestDepth = Infinity;
  for (const { sha, depth } of walkCommits(repo, [b])) {
    if (depthA.has(sha)) {
      const total = depth + (depthA.get(sha) ?? 0);
      if (total < bestDepth) {
        bestDepth = total;
        best = sha;
      }
    }
  }
  return best;
}

// Mergeability: CONFLICTING when both sides changed the same file differently from the base.
export function computeMergeable(repo: Repo, baseSha: string, headSha: string): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (baseSha === ZERO_OID || headSha === ZERO_OID) return 'UNKNOWN';
  const baseObj = repo.objects.get(baseSha);
  const headObj = repo.objects.get(headSha);
  if (!baseObj || baseObj.type !== 'commit' || !headObj || headObj.type !== 'commit') return 'UNKNOWN';
  const base = mergeBase(repo, baseSha, headSha);
  if (base === null) return 'UNKNOWN';
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const baseFlat = flattenTree(repo, baseTree) ?? new Map();
  const headFlat = flattenTree(repo, parseCommit(headObj.data).tree) ?? new Map();
  const baseBranchFlat = flattenTree(repo, parseCommit(baseObj.data).tree) ?? new Map();
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...baseBranchFlat.keys()]);
  for (const path of paths) {
    const inBase = baseFlat.get(path)?.sha ?? null;
    const inHead = headFlat.get(path)?.sha ?? null;
    const inBranch = baseBranchFlat.get(path)?.sha ?? null;
    const headChanged = inHead !== inBase;
    const branchChanged = inBranch !== inBase;
    if (headChanged && branchChanged && inHead !== inBranch) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// Re-resolve the head/base tips (branches move after a PR is opened) and recompute
// mergeability from the current state. Mergeability is a property of the moment, not
// of the creation time: a second PR only becomes conflicted once the first one merges.
export function refreshMergeable(repo: Repo, pull: Pull): void {
  if (pull.state === 'closed') return;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha) pull.headSha = headSha;
  if (baseSha) pull.baseSha = baseSha;
  pull.mergeable = computeMergeable(repo, pull.baseSha, pull.headSha);
}

export function commitTreeSha(repo: Repo, commitSha: string): string | null {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

export function repoJson(repo: Repo, viewerLogin: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === viewerLogin ? 1000 : 1002, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.seq,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    comments_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  refreshMergeable(repo, pull);
  return {
    id: pull.seq,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    mergeable: pull.mergeable === 'MERGEABLE',
    mergeable_state: pull.mergeable === 'MERGEABLE' ? 'clean' : pull.mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
  };
}
