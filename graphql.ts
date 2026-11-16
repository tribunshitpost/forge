// graphql.ts — a small, purpose-built GraphQL v4 executor.
//
// It handles exactly the documents gh and github-mcp-server send (see the
// kit's checks-graphql.ts): viewer, repository, __type introspection, issue
// and pull-request reads, the five mutations, node(id:), and batched
// operation arrays. It is a hand-rolled parser, not a library: tokenize,
// build selection trees with arguments, resolve fields against the store.
// Unknown fields are GraphQL errors (HTTP 200 with an errors array), never
// HTTP errors; an unknown repository is data.repository = null.

import { parseCommit } from './git.ts';
import { VIEWER, VIEWER_LOGIN, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { mergePull } from './rest.ts';

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, JsonValue>;
  children: FieldNode[];
  fragmentType: string | null; // for `... on Type` inline fragments
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'var' | 'spread';
  value: string;
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < query.length && query[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && query.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < query.length && /[A-Za-z0-9_]/.test(query[j])) j += 1;
      tokens.push({ kind: 'var', value: query.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < query.length && query[j] !== '"') {
        if (query[j] === '\\' && j + 1 < query.length) {
          const esc = query[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += query[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < query.length && /[0-9.]/.test(query[j])) j += 1;
      tokens.push({ kind: 'number', value: query.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < query.length && /[A-Za-z0-9_]/.test(query[j])) j += 1;
      tokens.push({ kind: 'name', value: query.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  private variables: Record<string, unknown>;

  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token?.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token?.kind === 'punct' && token.value === value;
  }

  /** Parse one operation document into its root selection set. */
  parseOperation(): FieldNode[] {
    // Skip `query` / `mutation` keyword, operation name, variable definitions.
    let token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      token = this.peek();
      if (token?.kind === 'name') this.next(); // operation name
      if (this.isPunct('(')) this.skipBalanced('(', ')');
    }
    return this.parseSelectionSet();
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (!token) return;
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.isPunct('}')) {
      const token = this.next();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        // `... on Type { ... }` or `...Fragment`.
        let fragmentType: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name' && next.value === 'on') {
          this.next();
          fragmentType = this.next()?.value ?? null;
        }
        const children = this.parseSelectionSet();
        for (const child of children) fields.push({ ...child, fragmentType });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`expected field name, got ${token.value}`);
      let alias: string | null = null;
      let name = token.value;
      if (this.isPunct(':')) {
        this.next();
        alias = name;
        name = this.next()?.value ?? '';
      }
      const args: Record<string, JsonValue> = {};
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          const argName = this.next()?.value ?? '';
          this.expectPunct(':');
          args[argName] = this.parseValue();
        }
        this.expectPunct(')');
      }
      let children: FieldNode[] = [];
      if (this.isPunct('{')) children = this.parseSelectionSet();
      fields.push({ alias, name, args, children, fragmentType: null });
    }
    this.expectPunct('}');
    return fields;
  }

  private parseValue(): JsonValue {
    const token = this.next();
    if (!token) throw new Error('unexpected end of value');
    if (token.kind === 'var') {
      const value = this.variables[token.value];
      return toJsonValue(value);
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum literal
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: JsonValue[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: JsonObject = {};
      while (!this.isPunct('}')) {
        const key = this.next()?.value ?? '';
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = toJsonValue(entry);
    return out;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// schema surface
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'author', 'url'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

const KNOWN_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: REPOSITORY_FIELDS,
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_REQUEST_FIELDS,
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author'],
};

function typeFields(typeName: string): string[] {
  if (typeName === 'Issue') return ISSUE_FIELDS;
  if (typeName === 'PullRequest') return PULL_REQUEST_FIELDS;
  if (typeName === 'Repository') return REPOSITORY_FIELDS;
  if (typeName === 'SearchType') return SEARCH_TYPE_VALUES;
  return [];
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface GqlContext {
  store: Store;
  errors: Array<{ message: string }>;
}

function fieldError(ctx: GqlContext, typeName: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return null;
}

function isKnown(ctx: GqlContext, typeName: string, field: string): boolean {
  const known = KNOWN_FIELDS[typeName] ?? [];
  if (known.includes(field)) return true;
  fieldError(ctx, typeName, field);
  return false;
}

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveIssue(ctx: GqlContext, repo: Repo, issue: Issue, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = issue.id;
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'state':
        out[key] = issueStateGql(issue.state);
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'createdAt':
      case 'updatedAt':
        out[key] = '2025-01-01T00:00:00Z';
        break;
      case 'author':
        out[key] = field.children.length > 0 ? resolveUser(ctx, field.children) : { login: VIEWER_LOGIN };
        break;
      case 'labels':
        out[key] = { nodes: issue.labels.map((name) => ({ name })) };
        break;
      case 'comments':
        out[key] = { nodes: issue.comments.map((comment) => ({ id: comment.globalId, body: comment.body })) };
        break;
      case 'url':
        out[key] = `https://example.invalid/${repo.fullName}/issues/${issue.number}`;
        break;
      default:
        isKnown(ctx, 'Issue', field.name);
        break;
    }
  }
  return out;
}

function resolveUser(ctx: GqlContext, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === 'login') out[key] = VIEWER_LOGIN;
    else if (field.name === 'id') out[key] = ctx.store.globalId('U', VIEWER_LOGIN);
    else if (field.name === 'name') out[key] = VIEWER.name;
    else if (field.name === 'email') out[key] = VIEWER.email;
    else isKnown(ctx, 'User', field.name);
  }
  return out;
}

function prMergeable(ctx: GqlContext, repo: Repo, pull: PullRequest): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const mergeBase = ctx.store.mergeBase(repo, headTip, baseTip);
  if (mergeBase === null) return 'CONFLICTING';
  const baseTree = parseCommit(ctx.store.getObject(repo, baseTip)!.data).tree;
  const headTree = parseCommit(ctx.store.getObject(repo, headTip)!.data).tree;
  const mergeBaseTree = parseCommit(ctx.store.getObject(repo, mergeBase)!.data).tree;
  const headChanges = ctx.store.diffTrees(repo, mergeBaseTree, headTree);
  const baseChanges = ctx.store.diffTrees(repo, mergeBaseTree, baseTree);
  const baseByPath = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const baseChange = baseByPath.get(change.path);
    if (baseChange && baseChange.newOid !== change.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function resolvePull(ctx: GqlContext, repo: Repo, pull: PullRequest, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = pull.id;
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'mergeable':
        out[key] = prMergeable(ctx, repo, pull);
        break;
      case 'headRefName':
        out[key] = pull.head;
        break;
      case 'baseRefName':
        out[key] = pull.base;
        break;
      case 'headRefOid':
        out[key] = pull.headSha;
        break;
      case 'baseRefOid':
        out[key] = pull.baseSha;
        break;
      case 'createdAt':
      case 'updatedAt':
        out[key] = '2025-01-01T00:00:00Z';
        break;
      case 'author':
        out[key] = field.children.length > 0 ? resolveUser(ctx, field.children) : { login: VIEWER_LOGIN };
        break;
      case 'url':
        out[key] = `https://example.invalid/${repo.fullName}/pull/${pull.number}`;
        break;
      case 'files': {
        const baseTree = parseCommit(ctx.store.getObject(repo, pull.mergeBaseSha)!.data).tree;
        const headTree = parseCommit(ctx.store.getObject(repo, pull.headSha)!.data).tree;
        const changes = ctx.store.diffTrees(repo, baseTree, headTree);
        const first = typeof field.args.first === 'number' ? field.args.first : changes.length;
        const sliced = changes.slice(0, first);
        const nodesField = field.children.find((child) => child.name === 'nodes');
        if (nodesField) {
          out[key] = {
            nodes: sliced.map((entry) => resolveChangedFile(entry, nodesField.children)),
            pageInfo: { hasNextPage: changes.length > first, endCursor: null },
            totalCount: changes.length,
          };
        } else {
          out[key] = sliced.map((entry) => resolveChangedFile(entry, field.children));
        }
        break;
      }
      default:
        isKnown(ctx, 'PullRequest', field.name);
        break;
    }
  }
  return out;
}

function resolveChangedFile(
  change: { path: string; additions: number; deletions: number; status: string },
  fields: FieldNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === 'path') out[key] = change.path;
    else if (field.name === 'additions') out[key] = change.additions;
    else if (field.name === 'deletions') out[key] = change.deletions;
    else if (field.name === 'changeType') out[key] = change.status.toUpperCase();
  }
  return out;
}

// ---------------------------------------------------------------------------
// repository + query root + mutations
// ---------------------------------------------------------------------------

function decodeGlobalId(id: string): { kind: string; parts: string } | null {
  const match = /^([A-Z])_(.+)$/.exec(id);
  if (!match) return null;
  try {
    return { kind: match[1], parts: Buffer.from(match[2], 'base64url').toString('utf8') };
  } catch {
    return null;
  }
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'R') return null;
  const [owner, name] = decoded.parts.split('/');
  if (!owner || !name) return null;
  return store.getRepo(owner, name) ?? null;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'I') return null;
  const parts = decoded.parts.split('/');
  const number = Number(parts.pop());
  const name = parts.pop();
  const owner = parts.join('/');
  if (!owner || !name || !Number.isInteger(number)) return null;
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  const issue = repo.issues.find((entry) => entry.number === number);
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'P') return null;
  const parts = decoded.parts.split('/');
  const number = Number(parts.pop());
  const name = parts.pop();
  const owner = parts.join('/');
  if (!owner || !name || !Number.isInteger(number)) return null;
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  const pull = repo.pulls.find((entry) => entry.number === number);
  return pull ? { repo, pull } : null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function resolveIssuesConnection(ctx: GqlContext, repo: Repo, field: FieldNode): Record<string, unknown> {
  const args = field.args;
  let list = [...repo.issues];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const hasOrderBy = args.orderBy !== undefined && args.orderBy !== null;
  if (hasOrderBy) {
    const orderField = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
    const direction = orderBy.direction === 'ASC' ? 1 : -1;
    list.sort((a, b) => {
      if (orderField === 'CREATED_AT' || orderField === 'UPDATED_AT') {
        return direction * (a.seq - b.seq) || direction * (a.number - b.number);
      }
      return direction * (a.number - b.number);
    });
  } else {
    // No orderBy: cursor pagination walks creation order, ascending.
    list.sort((a, b) => a.seq - b.seq);
  }
  const afterNumber = numberFromCursor(typeof args.after === 'string' ? args.after : null);
  if (afterNumber !== null) {
    const at = list.findIndex((issue) => issue.number === afterNumber);
    if (at >= 0) list = list.slice(at + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const sliced = list.slice(0, first);
  const nodesField = field.children.find((child) => child.name === 'nodes');
  const pageInfoField = field.children.find((child) => child.name === 'pageInfo');
  const out: Record<string, unknown> = {};
  for (const child of field.children) {
    const key = child.alias ?? child.name;
    if (child.name === 'nodes' && nodesField) {
      out[key] = sliced.map((issue) => resolveIssue(ctx, repo, issue, nodesField.children));
    } else if (child.name === 'pageInfo' && pageInfoField) {
      const info: Record<string, unknown> = {};
      for (const grand of pageInfoField.children) {
        const gkey = grand.alias ?? grand.name;
        if (grand.name === 'hasNextPage') info[gkey] = list.length > first;
        else if (grand.name === 'hasPreviousPage') info[gkey] = afterNumber !== null;
        else if (grand.name === 'endCursor') info[gkey] = sliced.length > 0 ? cursorFor(sliced[sliced.length - 1].number) : null;
        else if (grand.name === 'startCursor') info[gkey] = sliced.length > 0 ? cursorFor(sliced[0].number) : null;
      }
      out[key] = info;
    } else if (child.name === 'totalCount') {
      out[key] = list.length;
    }
  }
  return out;
}

function resolvePullsConnection(ctx: GqlContext, repo: Repo, field: FieldNode): Record<string, unknown> {
  const args = field.args;
  let list = repo.pulls.filter((pull) => pull.state === 'open');
  const first = typeof args.first === 'number' ? args.first : list.length;
  const sliced = list.slice(0, first);
  const out: Record<string, unknown> = {};
  for (const child of field.children) {
    const key = child.alias ?? child.name;
    if (child.name === 'nodes') out[key] = sliced.map((pull) => resolvePull(ctx, repo, pull, child.children));
    else if (child.name === 'pageInfo') out[key] = { hasNextPage: list.length > first, endCursor: null };
    else if (child.name === 'totalCount') out[key] = list.length;
  }
  return out;
}

function resolveRepository(ctx: GqlContext, repo: Repo, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = repo.globalId;
        break;
      case 'databaseId':
        out[key] = repo.databaseId;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = repo.fullName;
        break;
      case 'owner':
        out[key] = field.children.length > 0 ? resolveUser(ctx, field.children) : { login: repo.owner };
        break;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        out[key] = tip ? { name: repo.defaultBranch } : null;
        break;
      }
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'private':
        out[key] = repo.private;
        break;
      case 'url':
        out[key] = `https://example.invalid/${repo.fullName}`;
        break;
      case 'issue': {
        const number = field.args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issues.find((entry) => entry.number === number) : undefined;
        out[key] = issue ? resolveIssue(ctx, repo, issue, field.children) : null;
        break;
      }
      case 'issues':
        out[key] = resolveIssuesConnection(ctx, repo, field);
        break;
      case 'pullRequests':
        out[key] = resolvePullsConnection(ctx, repo, field);
        break;
      case 'pullRequest': {
        const number = field.args.number as number | undefined;
        const pull = typeof number === 'number' ? repo.pulls.find((entry) => entry.number === number) : undefined;
        out[key] = pull ? resolvePull(ctx, repo, pull, field.children) : null;
        break;
      }
      default:
        isKnown(ctx, 'Repository', field.name);
        break;
    }
  }
  return out;
}

function resolveTypeIntrospection(ctx: GqlContext, field: FieldNode): Record<string, unknown> | null {
  const name = field.args.name as string | undefined;
  if (typeof name !== 'string') return null;
  const out: Record<string, unknown> = {};
  for (const child of field.children) {
    const key = child.alias ?? child.name;
    if (child.name === 'fields') {
      const names = typeFields(name);
      out[key] = names.map((fieldName) => ({ name: fieldName }));
    } else if (child.name === 'enumValues') {
      out[key] = name === 'SearchType' ? SEARCH_TYPE_VALUES.map((value) => ({ name: value })) : [];
    } else if (child.name === 'name') {
      out[key] = name;
    } else if (child.name === 'kind') {
      out[key] = name === 'SearchType' ? 'ENUM' : 'OBJECT';
    }
  }
  return out;
}

function resolveNode(ctx: GqlContext, id: unknown, fields: FieldNode[]): Record<string, unknown> | null {
  if (typeof id !== 'string') return null;
  const repo = findRepoByGlobalId(ctx.store, id);
  if (!repo) return null;
  const out: Record<string, unknown> = { id: repo.globalId };
  for (const field of fields) {
    if (field.fragmentType && field.fragmentType !== 'Repository') continue;
    const key = field.alias ?? field.name;
    if (field.name === 'id') out[key] = repo.globalId;
    else if (field.name === 'name') out[key] = repo.name;
    else if (field.name === 'nameWithOwner') out[key] = repo.fullName;
    else if (field.name === '__typename') out[key] = 'Repository';
  }
  return out;
}

function executeOperation(ctx: GqlContext, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const parser = new Parser(tokenize(query), variables);
  const isMutation = /^\s*mutation\b/.test(query);
  const rootFields = parser.parseOperation();
  const data: Record<string, unknown> = {};
  for (const field of rootFields) {
    const key = field.alias ?? field.name;
    if (isMutation) {
      executeMutationField(ctx, field, data, key);
      continue;
    }
    switch (field.name) {
      case 'viewer':
        data[key] = field.children.length > 0 ? resolveUser(ctx, field.children) : { login: VIEWER_LOGIN };
        break;
      case 'repository': {
        const owner = field.args.owner as string | undefined;
        const name = field.args.name as string | undefined;
        const repo = owner && name ? ctx.store.getRepo(owner, name) : undefined;
        if (!repo || owner !== VIEWER_LOGIN) data[key] = null;
        else data[key] = resolveRepository(ctx, repo, field.children);
        break;
      }
      case 'node':
        data[key] = resolveNode(ctx, field.args.id, field.children);
        break;
      case '__type':
        data[key] = resolveTypeIntrospection(ctx, field);
        break;
      case '__schema':
        data[key] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
        break;
      default:
        fieldError(ctx, 'Query', field.name);
        data[key] = null;
        break;
    }
  }
  return data;
}

function executeMutationField(ctx: GqlContext, field: FieldNode, data: Record<string, unknown>, key: string): void {
  const input = (field.args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(ctx.store, input.repositoryId) : null;
      if (!repo || typeof input.title !== 'string') {
        ctx.errors.push({ message: 'createIssue: unknown repository or missing title' });
        data[key] = { issue: null };
        return;
      }
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const issue: Issue = {
        number,
        id: ctx.store.globalId('I', `${repo.fullName}/${number}`),
        title: input.title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        seq: number,
        comments: [],
      };
      repo.issues.push(issue);
      data[key] = { issue: resolveIssue(ctx, repo, issue, field.children[0]?.children ?? []) };
      return;
    }
    case 'closeIssue': {
      const found = typeof input.issueId === 'string' ? findIssueByGlobalId(ctx.store, input.issueId) : null;
      if (!found) {
        ctx.errors.push({ message: 'closeIssue: unknown issue' });
        data[key] = { issue: null };
        return;
      }
      found.issue.state = 'closed';
      data[key] = { issue: resolveIssue(ctx, found.repo, found.issue, field.children[0]?.children ?? []) };
      return;
    }
    case 'createPullRequest': {
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(ctx.store, input.repositoryId) : null;
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (!repo || head === '' || base === '') {
        ctx.errors.push({ message: 'createPullRequest: unknown repository or missing refs' });
        data[key] = { pullRequest: null };
        return;
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        data[key] = { pullRequest: null };
        return;
      }
      const duplicate = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
      if (duplicate) {
        ctx.errors.push({ message: 'createPullRequest: a pull request already exists for this head and base' });
        data[key] = { pullRequest: null };
        return;
      }
      const mergeBase = ctx.store.mergeBase(repo, headSha, baseSha);
      const number = repo.nextPull;
      repo.nextPull += 1;
      const pull: PullRequest = {
        number,
        id: ctx.store.globalId('P', `${repo.fullName}/${number}`),
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head,
        base,
        headSha,
        baseSha,
        mergeBaseSha: mergeBase ?? baseSha,
        seq: number,
      };
      repo.pulls.push(pull);
      data[key] = { pullRequest: resolvePull(ctx, repo, pull, field.children[0]?.children ?? []) };
      return;
    }
    case 'mergePullRequest': {
      const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(ctx.store, input.pullRequestId) : null;
      if (!found) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
        data[key] = { pullRequest: null };
        return;
      }
      if (found.pull.state !== 'open') {
        ctx.errors.push({ message: 'mergePullRequest: pull request is not open' });
        data[key] = { pullRequest: resolvePull(ctx, found.repo, found.pull, field.children[0]?.children ?? []) };
        return;
      }
      const mergedOk = mergePull(ctx.store, found.repo, found.pull);
      if (!mergedOk) {
        ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
        data[key] = { pullRequest: resolvePull(ctx, found.repo, found.pull, field.children[0]?.children ?? []) };
        return;
      }
      data[key] = { pullRequest: resolvePull(ctx, found.repo, found.pull, field.children[0]?.children ?? []) };
      return;
    }
    case 'addComment': {
      const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(ctx.store, input.subjectId) : null;
      if (!found || typeof input.body !== 'string') {
        ctx.errors.push({ message: 'addComment: unknown subject or missing body' });
        data[key] = { commentEdge: null };
        return;
      }
      const id = found.repo.nextComment;
      found.repo.nextComment += 1;
      const comment = {
        id,
        globalId: ctx.store.globalId('C', `${found.repo.fullName}/${found.issue.number}/${id}`),
        body: input.body,
        seq: id,
      };
      found.issue.comments.push(comment);
      const edgeChildren = field.children[0]?.children ?? [];
      const node: Record<string, unknown> = {};
      for (const child of edgeChildren) {
        const childKey = child.alias ?? child.name;
        if (child.name === 'node') {
          const nodeFields = child.children;
          const nodeOut: Record<string, unknown> = {};
          for (const grand of nodeFields) {
            const gkey = grand.alias ?? grand.name;
            if (grand.name === 'id') nodeOut[gkey] = comment.globalId;
            else if (grand.name === 'body') nodeOut[gkey] = comment.body;
          }
          node[childKey] = nodeOut;
        }
      }
      data[key] = { commentEdge: node };
      return;
    }
    default:
      fieldError(ctx, 'Mutation', field.name);
      data[key] = null;
      return;
  }
}

/** Execute one GraphQL operation body. Returns the response object. */
export function executeGraphQL(store: Store, body: unknown): Record<string, unknown> | Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(store, entry));
  }
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): Record<string, unknown> {
  const ctx: GqlContext = { store, errors: [] };
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a query.' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'No query was provided.' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let data: Record<string, unknown>;
  try {
    data = executeOperation(ctx, query, variables);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
