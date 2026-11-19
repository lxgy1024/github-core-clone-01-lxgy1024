// MCP: POST /mcp, JSON-RPC 2.0 over Streamable HTTP, modern era 2026-07-28.
// Tools act on the same store as REST, so a repo created over MCP reads back over /api/v3.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { commitFlatTree, commitTreeSha, computeMergeable, flattenTree, issueJson, pullJson, refreshMergeable, repoJson, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { FIXED_ISO, VIEWER_LOGIN, isRecord, parseJsonBody, readBody } from './util.ts';
import { isAuthorized } from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        state: { type: 'string', description: 'open, closed or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

// Precomputed once so two tools/list calls answer byte for byte the same result.
const TOOLS_LIST_RESULT = JSON.stringify({ tools: TOOLS });

function rpcOk(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function sendRpc(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function toolResult(obj: unknown, isError = false): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return {
    content: [{ type: 'text', text }],
    structuredContent: obj,
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message, message }, true);
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner || parts[0];
      repo = repo || parts[1];
    }
  }
  return { owner, repo };
}

function resolveRepo(store: Store, owner: string, repo: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, repo);
}

function required(args: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name || t.name.endsWith(`__${name}`));
  if (!tool) return toolError(`unknown tool: ${name}`);
  const missing = required(args, tool.inputSchema.required);
  if (missing) return toolError(`missing required argument: ${missing}`);

  if (name === 'create_repo' || name.endsWith('__create_repo')) {
    const repoName = String(args.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return toolError('Invalid repository name');
    if (store.getRepo(VIEWER_LOGIN, repoName)) return toolError('Repository already exists');
    const repo = store.createRepo(
      VIEWER_LOGIN,
      repoName,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    return toolResult(repoJson(repo, VIEWER_LOGIN));
  }

  const { owner, repo: repoName } = splitFullName(args);
  const repo = resolveRepo(store, owner, repoName);
  if (!repo) return toolError('Not Found');

  if (name === 'get_repo' || name.endsWith('__get_repo')) {
    return toolResult(repoJson(repo, VIEWER_LOGIN));
  }

  if (name === 'create_issue' || name.endsWith('__create_issue')) {
    const number = repo.nextNumber++;
    const issue: Issue = {
      number,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: repo.nextSeq++,
      closedAt: null,
    };
    repo.issues.set(number, issue);
    return toolResult(issueJson(repo, issue));
  }

  if (name === 'list_issues' || name.endsWith('__list_issues')) {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    issues.sort((a, b) => b.seq - a.seq);
    const list = issues.map((i) => issueJson(repo, i));
    return toolResult({ issues: list });
  }

  if (name === 'create_pull_request' || name.endsWith('__create_pull_request')) {
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha) return toolError(`Invalid head: ${head}`);
    if (!baseSha) return toolError(`Invalid base: ${base}`);
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return toolError('A pull request already exists for this head and base');
      }
    }
    const number = repo.nextNumber++;
    const pull: Pull = {
      number,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
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
    return toolResult(pullJson(repo, pull));
  }

  if (name === 'merge_pull_request' || name.endsWith('__merge_pull_request')) {
    const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? args.number ?? ''), 10);
    const pull = repo.pulls.get(number);
    if (!pull) return toolError('Not Found');
    if (pull.merged) return toolResult({ merged: true, sha: pull.mergeSha, message: 'Pull request already merged' });
    refreshMergeable(repo, pull);
    if (pull.mergeable === 'CONFLICTING') return toolError('Merge conflict');
    const headTree = commitTreeSha(repo, pull.headSha);
    const flat = headTree === null ? new Map() : flattenTree(repo, headTree);
    if (flat === null) return toolError('Cannot merge: head tree not found');
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const commitSha = commitFlatTree(repo, `refs/heads/${pull.baseRef}`, flat, message);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeSha = commitSha;
    return toolResult({ merged: true, sha: commitSha, message });
  }

  return toolError(`unknown tool: ${name}`);
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (!isAuthorized(req)) {
    sendRpc(res, 401, rpcError(null, -32000, 'Requires authentication'));
    return;
  }
  const bodyBuf = await readBody(req);
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) {
    sendRpc(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const body = parsed.value;
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendRpc(res, 400, rpcError(isRecord(body) ? body.id : null, -32600, 'Invalid Request'));
    return;
  }
  const id = body.id ?? null;
  const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};
  const isNotification = body.id === undefined;

  if (body.method === 'notifications/initialized') {
    res.writeHead(202);
    res.end();
    return;
  }
  if (isNotification) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (body.method === 'server/discover') {
    sendRpc(res, 200, rpcOk(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return;
  }
  if (body.method === 'initialize') {
    sendRpc(res, 200, rpcOk(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return;
  }
  if (body.method === 'ping') {
    sendRpc(res, 200, rpcOk(id, {}));
    return;
  }
  if (body.method === 'tools/list') {
    // The result bytes are precomputed, so repeated calls are identical.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${TOOLS_LIST_RESULT}}`);
    return;
  }
  if (body.method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const result = callTool(store, name, args);
    // Unknown tool: JSON-RPC error, never HTTP 500.
    if (name && !TOOLS.some((t) => t.name === name || t.name.endsWith(`__${name}`))) {
      sendRpc(res, 200, rpcError(id, -32602, `unknown tool: ${name}`));
      return;
    }
    sendRpc(res, 200, rpcOk(id, result));
    return;
  }
  sendRpc(res, 200, rpcError(id, -32601, `Method not found: ${body.method}`));
}
