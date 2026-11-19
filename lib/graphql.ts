// GraphQL: POST /api/graphql. A small parser and executor for the documents the
// suite sends (gh / github-mcp-server shapes), plus __type introspection.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitFlatTree,
  commitTreeSha,
  computeMergeable,
  diffTrees,
  flattenTree,
  issueJson,
  pullJson,
  refreshMergeable,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { FIXED_ISO, VIEWER_ID, VIEWER_LOGIN, b64decode, b64encode, isRecord, json, jsonError, parseJsonBody, readBody } from './util.ts';
import { isAuthorized } from './rest.ts';

// ---------------------------------------------------------------------------
// Parser (subset of GraphQL)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, ValueNode | undefined>;
  selections: SelectionNode[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const tok = this.tokens[this.pos];
    this.pos += 1;
    return tok;
  }

  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
    }
    const variables = new Map<string, ValueNode | undefined>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        // Type: a name, possibly wrapped in [] or suffixed with !.
        while (this.peek() !== undefined && this.peek() !== '=' && this.peek() !== ')' && this.peek() !== '$') {
          this.next();
          if (this.peek() === '!') this.next();
        }
        let defaultValue: ValueNode | undefined;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.set(varName, defaultValue);
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      } else {
        // Named fragment spread — not used by the suite; skip its name.
        this.next();
        return { kind: 'fragment', typeCondition: null, selections: [] };
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    const first = this.next();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  parseValue(): ValueNode {
    const tok = this.next();
    if (tok === '$') return { kind: 'variable', name: this.next() };
    if (tok === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (tok === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (/^-?[0-9]+$/.test(tok)) return { kind: 'int', value: parseInt(tok, 10) };
    if (/^-?[0-9]*\.[0-9]+([eE][+-]?[0-9]+)?$/.test(tok)) return { kind: 'float', value: parseFloat(tok) };
    return { kind: 'enum', value: tok };
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema (field sets for validation) and global ids
// ---------------------------------------------------------------------------

const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'url'],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name', 'id'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileChangeConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  FileChangeEdge: ['node', 'cursor'],
  FileChange: ['path'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args'],
  __EnumValue: ['name', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
};

function globalId(kind: string, key: string): string {
  return b64encode(`${kind}:${key}`);
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = b64decode(id).toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// Keys look like "owner/name" or "owner/name:number" — split on '/' first, then ':'.
function parseRepoKey(key: string): { owner: string; name: string; number: number | null } | null {
  const slash = key.indexOf('/');
  if (slash < 0) return null;
  const owner = key.slice(0, slash);
  const rest = key.slice(slash + 1);
  const colon = rest.indexOf(':');
  if (colon < 0) return { owner, name: rest, number: null };
  const number = parseInt(rest.slice(colon + 1), 10);
  return { owner, name: rest.slice(0, colon), number: Number.isFinite(number) ? number : null };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

type TypedValue = { __typename: string; value: unknown };

function repoValue(repo: Repo): TypedValue {
  return { __typename: 'Repository', value: repo };
}

function issueValue(repo: Repo, issue: Issue): TypedValue {
  return { __typename: 'Issue', value: { repo, issue } };
}

function pullValue(repo: Repo, pull: Pull): TypedValue {
  return { __typename: 'PullRequest', value: { repo, pull } };
}

function argsMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function encodeCursor(number: number): string {
  return b64encode(`cursor:${number}`);
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = b64decode(cursor).toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function paginateNodes<T extends { number: number }>(ordered: T[], args: Record<string, unknown>): Page<T> {
  let list = ordered;
  const after = decodeCursor(args.after);
  if (after !== null) {
    const idx = list.findIndex((item) => item.number === after);
    if (idx >= 0) list = list.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const nodes = list.slice(0, first);
  return {
    nodes,
    hasNextPage: list.length > first,
    endCursor: nodes.length > 0 ? encodeCursor(nodes[nodes.length - 1].number) : null,
  };
}

function connectionValue<T extends { number: number }>(
  typename: string,
  nodes: T[],
  wrap: (item: T) => TypedValue,
  args: Record<string, unknown>,
): TypedValue {
  const page = paginateNodes(nodes, args);
  return {
    __typename: typename,
    value: {
      nodes: page.nodes.map(wrap),
      page: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
    },
  };
}

function resolveField(ctx: Ctx, parent: TypedValue, field: FieldNode, variables: Record<string, unknown>): TypedValue | null {
  const args = argsMap(field, variables);
  const type = parent.__typename;
  const value = parent.value;

  if (type === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', value: { login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid' } };
    }
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== VIEWER_LOGIN) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoValue(repo) : null;
    }
    if (field.name === 'node') {
      const decoded = decodeGlobalId(args.id as string);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const [owner, name] = decoded.key.split('/');
        const repo = ctx.store.getRepo(owner, name);
        return repo ? repoValue(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const parsed = parseRepoKey(decoded.key);
        if (!parsed || parsed.number === null) return null;
        const repo = ctx.store.getRepo(parsed.owner, parsed.name);
        const issue = repo?.issues.get(parsed.number);
        return repo && issue ? issueValue(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const parsed = parseRepoKey(decoded.key);
        if (!parsed || parsed.number === null) return null;
        const repo = ctx.store.getRepo(parsed.owner, parsed.name);
        const pull = repo?.pulls.get(parsed.number);
        return repo && pull ? pullValue(repo, pull) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name as string;
      return { __typename: '__Type', value: { name } };
    }
    return null;
  }

  if (type === '__Type') {
    const name = (value as { name: string }).name;
    if (field.name === 'name') return { __typename: 'String', value: name };
    if (field.name === 'kind') return { __typename: 'String', value: ENUM_VALUES[name] ? 'ENUM' : 'OBJECT' };
    if (field.name === 'fields') {
      const fields = TYPE_FIELDS[name] ?? [];
      return { __typename: 'List', value: fields.map((f) => ({ __typename: '__Field', value: { name: f } })) };
    }
    if (field.name === 'enumValues') {
      const values = ENUM_VALUES[name] ?? [];
      return { __typename: 'List', value: values.map((v) => ({ __typename: '__EnumValue', value: { name: v } })) };
    }
    return null;
  }

  if (type === '__Field' || type === '__EnumValue') {
    if (field.name === 'name') return { __typename: 'String', value: (value as { name: string }).name };
    return null;
  }

  if (type === 'User') {
    const user = value as Record<string, unknown>;
    if (field.name === 'login' || field.name === 'name' || field.name === 'email') {
      return { __typename: 'String', value: user[field.name] ?? null };
    }
    if (field.name === 'id') return { __typename: 'String', value: String(user.id ?? '') };
    return null;
  }

  if (type === 'Ref') {
    const ref = value as { name: string };
    if (field.name === 'name') return { __typename: 'String', value: ref.name };
    if (field.name === 'id') return { __typename: 'String', value: globalId('Ref', ref.name) };
    return null;
  }

  if (type === 'Repository') {
    const repo = value as Repo;
    switch (field.name) {
      case 'id':
        return { __typename: 'String', value: globalId('Repository', `${repo.owner}/${repo.name}`) };
      case 'databaseId':
        return { __typename: 'Int', value: repo.id };
      case 'name':
        return { __typename: 'String', value: repo.name };
      case 'nameWithOwner':
        return { __typename: 'String', value: `${repo.owner}/${repo.name}` };
      case 'owner':
        return { __typename: 'User', value: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002, name: repo.owner } };
      case 'defaultBranchRef':
        return { __typename: 'Ref', value: { name: repo.defaultBranch } };
      case 'viewerPermission':
        return { __typename: 'String', value: 'ADMIN' };
      case 'hasIssuesEnabled':
        return { __typename: 'Boolean', value: true };
      case 'issue': {
        const issue = repo.issues.get(args.number as number);
        return issue ? issueValue(repo, issue) : null;
      }
      case 'issues': {
        let issues = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states) issues = issues.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : null;
        const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        return connectionValue('IssueConnection', issues, (i) => issueValue(repo, i), args);
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(args.number as number);
        return pull ? pullValue(repo, pull) : null;
      }
      case 'pullRequests': {
        const pulls = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
        return connectionValue('PullRequestConnection', pulls, (p) => pullValue(repo, p), args);
      }
      default:
        return null;
    }
  }

  if (type === 'Issue') {
    const { repo, issue } = value as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id':
        return { __typename: 'String', value: globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`) };
      case 'number':
        return { __typename: 'Int', value: issue.number };
      case 'title':
        return { __typename: 'String', value: issue.title };
      case 'body':
        return { __typename: 'String', value: issue.body };
      case 'state':
        return { __typename: 'String', value: issue.state === 'open' ? 'OPEN' : 'CLOSED' };
      case 'createdAt':
      case 'updatedAt':
        return { __typename: 'String', value: FIXED_ISO };
      case 'url':
        return { __typename: 'String', value: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}` };
      default:
        return null;
    }
  }

  if (type === 'PullRequest') {
    const { repo, pull } = value as { repo: Repo; pull: Pull };
    switch (field.name) {
      case 'id':
        return { __typename: 'String', value: globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`) };
      case 'number':
        return { __typename: 'Int', value: pull.number };
      case 'title':
        return { __typename: 'String', value: pull.title };
      case 'body':
        return { __typename: 'String', value: pull.body };
      case 'state':
        return { __typename: 'String', value: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED' };
      case 'headRefName':
        return { __typename: 'String', value: pull.headRef };
      case 'baseRefName':
        return { __typename: 'String', value: pull.baseRef };
      case 'mergeable':
        refreshMergeable(repo, pull);
        return { __typename: 'String', value: pull.mergeable };
      case 'merged':
        return { __typename: 'Boolean', value: pull.merged };
      case 'createdAt':
        return { __typename: 'String', value: FIXED_ISO };
      case 'url':
        return { __typename: 'String', value: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}` };
      case 'files': {
        const baseTree = commitTreeSha(repo, pull.baseSha);
        const headTree = commitTreeSha(repo, pull.headSha);
        const files = diffTrees(repo, baseTree, headTree).map((f) => ({ number: 0, path: f.filename }));
        // File changes have no numbers; paginate by index instead of number.
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first);
        return {
          __typename: 'FileChangeConnection',
          value: {
            nodes: nodes.map((f) => ({ __typename: 'FileChange', value: f })),
            page: { hasNextPage: files.length > first, endCursor: null },
          },
        };
      }
      default:
        return null;
    }
  }

  if (type === 'FileChange') {
    if (field.name === 'path') return { __typename: 'String', value: (value as { path: string }).path };
    return null;
  }

  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'FileChangeConnection') {
    const conn = value as { nodes: TypedValue[]; page: { hasNextPage: boolean; endCursor: string | null } };
    if (field.name === 'nodes') return { __typename: 'List', value: conn.nodes };
    if (field.name === 'pageInfo') {
      return {
        __typename: 'PageInfo',
        value: {
          hasNextPage: conn.page.hasNextPage,
          hasPreviousPage: false,
          endCursor: conn.page.endCursor,
          startCursor: null,
        },
      };
    }
    if (field.name === 'totalCount') return { __typename: 'Int', value: conn.nodes.length };
    return null;
  }

  if (type === 'PageInfo') {
    const page = value as Record<string, unknown>;
    if (field.name === 'hasNextPage') return { __typename: 'Boolean', value: page.hasNextPage ?? false };
    if (field.name === 'hasPreviousPage') return { __typename: 'Boolean', value: false };
    if (field.name === 'endCursor') return { __typename: 'String', value: page.endCursor ?? null };
    if (field.name === 'startCursor') return { __typename: 'String', value: null };
    return null;
  }

  if (type === 'Mutation') {
    return resolveMutation(ctx, field, variables);
  }

  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (field.name === 'issue') return value as TypedValue;
    return null;
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return value as TypedValue;
    return null;
  }
  if (type === 'AddCommentPayload') {
    if (field.name === 'commentEdge') {
      return { __typename: 'IssueCommentEdge', value: value as TypedValue };
    }
    return null;
  }
  if (type === 'IssueCommentEdge') {
    if (field.name === 'node') return value as TypedValue;
    return null;
  }
  if (type === 'IssueComment') {
    const comment = value as { id: number; body: string };
    if (field.name === 'id') return { __typename: 'String', value: globalId('IssueComment', `comment:${comment.id}`) };
    if (field.name === 'body') return { __typename: 'String', value: comment.body };
    if (field.name === 'createdAt') return { __typename: 'String', value: FIXED_ISO };
    return null;
  }

  return null;
}

function resolveMutation(ctx: Ctx, field: FieldNode, variables: Record<string, unknown>): TypedValue | null {
  const args = argsMap(field, variables);
  const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};

  if (field.name === 'createIssue') {
    const decoded = decodeGlobalId(input.repositoryId as string);
    const repo = decoded ? ctx.store.getRepo(...(decoded.key.split('/') as [string, string])) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const number = repo.nextNumber++;
    const issue: Issue = {
      number,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      comments: [],
      seq: repo.nextSeq++,
      closedAt: null,
    };
    repo.issues.set(number, issue);
    return { __typename: 'CreateIssuePayload', value: issueValue(repo, issue) };
  }

  if (field.name === 'closeIssue') {
    const decoded = decodeGlobalId(input.issueId as string);
    if (!decoded) return null;
    const parsed = parseRepoKey(decoded.key);
    if (!parsed || parsed.number === null) return null;
    const repo = ctx.store.getRepo(parsed.owner, parsed.name);
    const issue = repo?.issues.get(parsed.number);
    if (!repo || !issue) return null;
    issue.state = 'closed';
    issue.closedAt = FIXED_ISO;
    return { __typename: 'CloseIssuePayload', value: issueValue(repo, issue) };
  }

  if (field.name === 'createPullRequest') {
    const decoded = decodeGlobalId(input.repositoryId as string);
    const repo = decoded ? ctx.store.getRepo(...(decoded.key.split('/') as [string, string])) : undefined;
    if (!repo) return null;
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: `Could not resolve head or base ref: ${headRef} / ${baseRef}` });
      return null;
    }
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
        ctx.errors.push({ message: 'A pull request already exists for this head and base' });
        return null;
      }
    }
    const number = repo.nextNumber++;
    const pull: Pull = {
      number,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      headRef: headRef,
      baseRef: baseRef,
      headSha,
      baseSha,
      mergeable: computeMergeable(repo, baseSha, headSha),
      seq: repo.nextSeq++,
    };
    repo.pulls.set(number, pull);
    return { __typename: 'CreatePullRequestPayload', value: pullValue(repo, pull) };
  }

  if (field.name === 'mergePullRequest') {
    const decoded = decodeGlobalId(input.pullRequestId as string);
    if (!decoded) return null;
    const parsed = parseRepoKey(decoded.key);
    if (!parsed || parsed.number === null) return null;
    const repo = ctx.store.getRepo(parsed.owner, parsed.name);
    const pull = repo?.pulls.get(parsed.number);
    if (!repo || !pull) return null;
    refreshMergeable(repo, pull);
    if (pull.mergeable === 'CONFLICTING') {
      ctx.errors.push({ message: 'Merge conflict' });
      return null;
    }
    const headTree = commitTreeSha(repo, pull.headSha);
    const flat = headTree === null ? new Map() : flattenTree(repo, headTree);
    if (flat === null) return null;
    if (!doMerge(repo, pull)) return null;
    return { __typename: 'MergePullRequestPayload', value: pullValue(repo, pull) };
  }

  if (field.name === 'addComment') {
    const decoded = decodeGlobalId(input.subjectId as string);
    if (!decoded) return null;
    const parsed = parseRepoKey(decoded.key);
    if (!parsed || parsed.number === null) return null;
    const repo = ctx.store.getRepo(parsed.owner, parsed.name);
    const issue = repo?.issues.get(parsed.number);
    if (!repo || !issue) return null;
    const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), userLogin: VIEWER_LOGIN };
    issue.comments.push(comment);
    return {
      __typename: 'AddCommentPayload',
      value: { __typename: 'IssueComment', value: comment },
    };
  }

  return null;
}

// The actual merge: squash the head tree onto the base branch.
function doMerge(repo: Repo, pull: Pull): boolean {
  const headTree = commitTreeSha(repo, pull.headSha);
  const flat = headTree === null ? new Map() : flattenTree(repo, headTree);
  if (flat === null) return false;
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const commitSha = commitFlatTree(repo, `refs/heads/${pull.baseRef}`, flat, message);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeSha = commitSha;
  return true;
}

function executeSelections(
  ctx: Ctx,
  parent: TypedValue,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      const sub = executeSelections(ctx, parent, selection.selections, variables);
      if (sub) Object.assign(out, sub);
      continue;
    }
    const allowed = SCHEMA[parent.__typename];
    if (allowed && !allowed.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parent.__typename}".` });
      return null;
    }
    const resolved = resolveField(ctx, parent, selection, variables);
    if (ctx.errors.length > 0) return null;
    const key = selection.alias ?? selection.name;
    out[key] = materialize(ctx, resolved, selection.selections, variables);
  }
  return out;
}

function materialize(
  ctx: Ctx,
  value: TypedValue | null,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): unknown {
  if (value === null) return null;
  if (value.__typename === 'List') {
    const list = value.value as TypedValue[];
    return list.map((item) => materialize(ctx, item, selections, variables));
  }
  if (selections.length === 0) return value.value;
  if (typeof value.value === 'object' && value.value !== null) {
    return executeSelections(ctx, value, selections, variables);
  }
  return value.value;
}

function executeOperation(ctx: Ctx, operation: OperationNode, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: TypedValue = { __typename: rootType, value: {} };
  const data = executeSelections(ctx, root, operation.selections, variables);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data };
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (!isAuthorized(req)) {
    jsonError(res, 401, 'Requires authentication');
    return;
  }
  const bodyBuf = await readBody(req);
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) {
    jsonError(res, 400, 'Problems parsing JSON');
    return;
  }
  const runOne = (doc: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { data: null, errors: [{ message: 'A query is required.' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let operations: OperationNode[];
    try {
      operations = new Parser(tokenize(doc.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse query' }] };
    }
    const operation = operations[0];
    if (!operation) return { data: null, errors: [{ message: 'Empty query.' }] };
    const ctx: Ctx = { store, errors: [] };
    return executeOperation(ctx, operation, variables);
  };
  if (Array.isArray(parsed.value)) {
    json(res, 200, parsed.value.map(runOne));
    return;
  }
  json(res, 200, runOne(parsed.value));
}

export { issueJson, pullJson };
