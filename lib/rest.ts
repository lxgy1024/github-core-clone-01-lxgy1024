// REST v3: /api/v3 — repos, git refs, contents, labels, issues, pull requests.
// Every reply is application/json with a non-empty X-GitHub-Request-Id; errors carry a
// string `message`. Everything except the root and /meta needs the bearer token.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorOfCommit, buildCommit, hashObject, parseCommit, parseTree } from './gitcore.ts';
import {
  commitFlatTree,
  commitTreeSha,
  computeMergeable,
  diffTrees,
  flattenTree,
  getObject,
  issueJson,
  pullJson,
  putObject,
  refreshMergeable,
  repoJson,
  walkCommits,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  FIXED_ISO,
  VIEWER_ID,
  VIEWER_LOGIN,
  b64decode,
  isRecord,
  json,
  jsonError,
  parseJsonBody,
  readBody,
  wrapBase64,
} from './util.ts';

export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const expected = expectedToken();
  return expected === '' ? match[1].length > 0 : match[1] === expected;
}

function oauthHeaders(): Record<string, string> {
  return { 'x-oauth-scopes': 'repo, read:org' };
}

function absoluteUrl(req: IncomingMessage, path: string): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}${path}`;
}

function paginate<T>(req: IncomingMessage, res: ServerResponse, items: T[], query: URLSearchParams, basePath: string): T[] {
  const perPageRaw = parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${basePath}?${q.toString()}`;
  };
  if (page < totalPages) {
    links.push(`<${absoluteUrl(req, urlFor(page + 1))}>; rel="next"`);
    links.push(`<${absoluteUrl(req, urlFor(totalPages))}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${absoluteUrl(req, urlFor(page - 1))}>; rel="prev"`);
    links.push(`<${absoluteUrl(req, urlFor(1))}>; rel="first"`);
  }
  if (links.length > 0) res.setHeader('link', links.join(', '));
  return slice;
}

// Resolve a repo under the viewer; any other owner is 404 (never 403).
function resolveRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, name);
}

function resolveRefSha(repo: Repo, ref: string): string | undefined {
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const branchRef = `refs/heads/${ref}`;
  if (repo.refs.has(branchRef)) return repo.refs.get(branchRef);
  return undefined;
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const parsed = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const author = obj ? authorOfCommit(obj.data) : { name: VIEWER_LOGIN, email: '' };
  return {
    sha,
    commit: {
      message: parsed?.message ?? '',
      author: { name: author.name, email: author.email, date: FIXED_ISO },
      committer: { name: author.name, email: author.email, date: FIXED_ISO },
    },
    parents: (parsed?.parents ?? []).map((p) => ({ sha: p })),
    url: `/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const query = url.searchParams;

  // Public roots.
  if (path === '/api/v3/' || path === '/api/v3') {
    json(res, 200, {
      current_user_url: '/api/v3/user',
      user_url: '/api/v3/users/{user}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    }, oauthHeaders());
    return;
  }
  if (path === '/api/v3/meta') {
    json(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false }, oauthHeaders());
    return;
  }

  if (!isAuthorized(req)) {
    jsonError(res, 401, 'Requires authentication');
    return;
  }

  const bodyBuf = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const parsedBody = bodyBuf.length > 0 ? parseJsonBody(bodyBuf) : { ok: true as const, value: {} as unknown };
  if (!parsedBody.ok) {
    jsonError(res, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsedBody.value) ? parsedBody.value : {};

  const segments = path.split('/').filter((s) => s.length > 0);
  // segments[0] = 'api', segments[1] = 'v3', then the resource path.

  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === 'user' && method === 'GET') {
    json(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: 'ada iversen',
      email: 'adaiversen@example.invalid',
      type: 'User',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      url: `/users/${VIEWER_LOGIN}`,
    });
    return;
  }

  // /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const repos = store.listReposByOwner(VIEWER_LOGIN).map((r) => repoJson(r, VIEWER_LOGIN));
      const page = paginate(req, res, repos, query, '/api/v3/user/repos');
      json(res, 200, page);
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        jsonError(res, 422, 'Invalid repository name');
        return;
      }
      if (store.getRepo(VIEWER_LOGIN, name)) {
        jsonError(res, 422, 'Repository already exists');
        return;
      }
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      json(res, 201, repoJson(repo, VIEWER_LOGIN));
      return;
    }
  }

  // /api/v3/repos/{owner}/{name}/...
  if (segments.length >= 5 && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3]);
    const repoName = decodeURIComponent(segments[4]);
    const repo = resolveRepo(store, owner, repoName);
    if (!repo) {
      jsonError(res, 404, 'Not Found');
      return;
    }
    const rest = segments.slice(5);

    // GET/PATCH/DELETE the repo itself.
    if (rest.length === 0) {
      if (method === 'GET') {
        json(res, 200, repoJson(repo, VIEWER_LOGIN));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
          repo.defaultBranch = body.default_branch;
        }
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        json(res, 200, repoJson(repo, VIEWER_LOGIN));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        res.writeHead(204, { 'x-github-request-id': 'req-deleted' });
        res.end();
        return;
      }
    }

    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort((a, b) => (a === repo.defaultBranch ? -1 : b === repo.defaultBranch ? 1 : a < b ? -1 : 1))
          .map((name) => ({
            name,
            commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '', url: '' },
            protected: false,
          }));
        json(res, 200, branches);
        return;
      }
      if (rest.length >= 2 && method === 'GET') {
        const branch = decodeURIComponent(rest.slice(1).join('/'));
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          jsonError(res, 404, 'Branch not found');
          return;
        }
        json(res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
        return;
      }
    }

    // Commits.
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      const tip = shaParam ? resolveRefSha(repo, shaParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) {
        json(res, 200, []);
        return;
      }
      const commits = walkCommits(repo, [tip]).map(({ sha }) => commitJson(repo, sha));
      json(res, 200, commits);
      return;
    }

    // Git refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = decodeURIComponent(rest.slice(3).join('/'));
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        json(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
        return;
      }
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
          jsonError(res, 422, 'Invalid ref or sha');
          return;
        }
        if (repo.refs.has(ref)) {
          jsonError(res, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        json(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return;
      }
    }

    // Contents.
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refParam = query.get('ref');
      const branchRef = refParam ? resolveRefSha(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      const branchName = refParam && repo.refs.has(`refs/heads/${refParam}`) ? refParam : repo.defaultBranch;
      if (method === 'GET') {
        const treeSha = branchRef ? commitTreeSha(repo, branchRef) : null;
        const flat = treeSha === null ? new Map() : flattenTree(repo, treeSha);
        if (flat === null) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        if (contentPath === '') {
          const entries = dirEntries(repo, flat, '');
          json(res, 200, entries);
          return;
        }
        const file = flat.get(contentPath);
        if (file) {
          const blob = repo.objects.get(file.sha);
          const data = blob ? blob.data : Buffer.alloc(0);
          json(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: wrapBase64(data.toString('base64')),
            sha: file.sha,
            size: data.length,
            name: contentPath.split('/').pop(),
            path: contentPath,
          });
          return;
        }
        // Directory?
        const prefix = `${contentPath}/`;
        const hasChildren = [...flat.keys()].some((p) => p.startsWith(prefix));
        if (hasChildren) {
          json(res, 200, dirEntries(repo, flat, contentPath));
          return;
        }
        jsonError(res, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const content = typeof body.content === 'string' ? body.content : '';
        const branch = typeof body.branch === 'string' ? body.branch : branchName;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        const treeSha = tip ? commitTreeSha(repo, tip) : null;
        const flat = treeSha === null ? new Map() : flattenTree(repo, treeSha);
        if (flat === null) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        const existing = flat.get(contentPath);
        if (existing) {
          if (typeof body.sha !== 'string') {
            jsonError(res, 422, 'sha wasn\'t supplied');
            return;
          }
          if (body.sha !== existing.sha) {
            jsonError(res, 409, 'sha does not match the current file');
            return;
          }
        }
        const blobSha = putObject(repo, 'blob', b64decode(content));
        flat.set(contentPath, { sha: blobSha, mode: '100644' });
        const commitSha = commitFlatTree(repo, refName, flat, message);
        json(res, existing ? 200 : 201, {
          content: { name: contentPath.split('/').pop(), path: contentPath, sha: blobSha, size: b64decode(content).length, encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const branch = typeof body.branch === 'string' ? body.branch : branchName;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (!tip) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        const treeSha = commitTreeSha(repo, tip);
        const flat = treeSha === null ? new Map() : flattenTree(repo, treeSha);
        if (flat === null) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        const existing = flat.get(contentPath);
        if (!existing) {
          jsonError(res, 404, 'Not Found');
          return;
        }
        if (typeof body.sha === 'string' && body.sha !== existing.sha) {
          jsonError(res, 409, 'sha does not match the current file');
          return;
        }
        flat.delete(contentPath);
        const commitSha = commitFlatTree(repo, refName, flat, message);
        json(res, 200, { commit: { sha: commitSha, message } });
        return;
      }
    }

    // Labels.
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        json(res, 200, [...repo.labels.values()]);
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const name = typeof body.name === 'string' ? body.name : '';
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        if (!name) {
          jsonError(res, 422, 'Label name is required');
          return;
        }
        if (repo.labels.has(name)) {
          jsonError(res, 422, 'Label already exists');
          return;
        }
        const label = { name, color };
        repo.labels.set(name, label);
        json(res, 201, label);
        return;
      }
    }

    // Issues and pull requests.
    if (rest[0] === 'issues' || rest[0] === 'pulls') {
      const isPull = rest[0] === 'pulls';
      if (!isPull) return handleIssues(req, res, repo, rest, method, query, body);
      return handlePulls(req, res, repo, rest, method, query, body);
    }
  }

  jsonError(res, 404, 'Not Found');
}

function dirEntries(repo: Repo, flat: Map<string, { sha: string; mode: string }>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: 'file' | 'dir'; sha: string; size?: number }>();
  for (const [path, value] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const blob = repo.objects.get(value.sha);
      seen.set(rest, { type: 'file', sha: value.sha, size: blob ? blob.data.length : 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { type: 'dir', sha: '' });
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const name of [...seen.keys()].sort()) {
    const entry = seen.get(name)!;
    out.push({
      type: entry.type,
      name,
      path: prefix + name,
      sha: entry.sha,
      ...(entry.type === 'file' ? { size: entry.size ?? 0 } : {}),
    });
  }
  return out;
}

function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
): void {
  // /issues/{n}/comments
  if (rest.length >= 3 && rest[2] === 'comments') {
    const number = parseInt(rest[1], 10);
    const issue = repo.issues.get(number);
    if (!issue) {
      jsonError(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      json(res, 200, issue.comments.map((c) => ({
        id: c.id,
        body: c.body,
        user: { login: c.userLogin, id: 1000, type: 'User' },
        created_at: FIXED_ISO,
        updated_at: FIXED_ISO,
      })));
      return;
    }
    if (method === 'POST') {
      const text = typeof body.body === 'string' ? body.body : '';
      const comment = { id: repo.nextCommentId++, body: text, userLogin: VIEWER_LOGIN };
      issue.comments.push(comment);
      json(res, 201, {
        id: comment.id,
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
        created_at: FIXED_ISO,
        updated_at: FIXED_ISO,
      });
      return;
    }
  }
  // /issues/{n}
  if (rest.length === 2) {
    const number = parseInt(rest[1], 10);
    const issue = repo.issues.get(number);
    if (!issue) {
      jsonError(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      json(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? FIXED_ISO : null;
      }
      json(res, 200, issueJson(repo, issue));
      return;
    }
  }
  // /issues
  if (rest.length === 1) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) {
        jsonError(res, 422, 'Title is required');
        return;
      }
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          jsonError(res, 422, `Label does not exist: ${label}`);
          return;
        }
      }
      const number = repo.nextNumber++;
      const issue: Issue = {
        number,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        comments: [],
        seq: repo.nextSeq++,
        closedAt: null,
      };
      repo.issues.set(number, issue);
      json(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      json(res, 200, issues.map((i) => issueJson(repo, i)));
      return;
    }
  }
  jsonError(res, 404, 'Not Found');
}

function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
): void {
  // /pulls/{n}/files
  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
    const number = parseInt(rest[1], 10);
    const pull = repo.pulls.get(number);
    if (!pull) {
      jsonError(res, 404, 'Not Found');
      return;
    }
    const baseTree = commitTreeSha(repo, pull.baseSha);
    const headTree = commitTreeSha(repo, pull.headSha);
    json(res, 200, diffTrees(repo, baseTree, headTree));
    return;
  }
  // /pulls/{n}/merge
  if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
    const number = parseInt(rest[1], 10);
    const pull = repo.pulls.get(number);
    if (!pull) {
      jsonError(res, 404, 'Not Found');
      return;
    }
    if (pull.state === 'closed' && pull.merged) {
      json(res, 200, { merged: true, sha: pull.mergeSha, message: 'Pull request already merged' });
      return;
    }
    refreshMergeable(repo, pull);
    if (pull.mergeable === 'CONFLICTING') {
      jsonError(res, 405, 'Merge conflict');
      return;
    }
    const headTree = commitTreeSha(repo, pull.headSha);
    const flat = headTree === null ? new Map() : flattenTree(repo, headTree);
    if (flat === null) {
      jsonError(res, 422, 'Cannot merge: head tree not found');
      return;
    }
    const baseRef = `refs/heads/${pull.baseRef}`;
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const commitSha = commitFlatTree(repo, baseRef, flat, message);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeSha = commitSha;
    json(res, 200, { merged: true, sha: commitSha, message });
    return;
  }
  // /pulls/{n}
  if (rest.length === 2) {
    const number = parseInt(rest[1], 10);
    const pull = repo.pulls.get(number);
    if (!pull) {
      jsonError(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      json(res, 200, pullJson(repo, pull));
      return;
    }
  }
  // /pulls
  if (rest.length === 1) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      if (!title || !head || !base) {
        jsonError(res, 422, 'title, head and base are required');
        return;
      }
      const headSha = resolveRefSha(repo, head);
      const baseSha = resolveRefSha(repo, base);
      if (!headSha) {
        jsonError(res, 422, `Invalid head: ${head}`);
        return;
      }
      if (!baseSha) {
        jsonError(res, 422, `Invalid base: ${base}`);
        return;
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          jsonError(res, 422, 'A pull request already exists for this head and base');
          return;
        }
      }
      const number = repo.nextNumber++;
      const pull: Pull = {
        number,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeable: computeMergeable(repo, baseSha, headSha),
        seq: repo.nextSeq++,
      };
      repo.pulls.set(number, pull);
      json(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => b.seq - a.seq);
      json(res, 200, pulls.map((p) => pullJson(repo, p)));
      return;
    }
  }
  jsonError(res, 404, 'Not Found');
}
