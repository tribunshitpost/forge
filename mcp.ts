// mcp.ts — the Model Context Protocol endpoint at /mcp.
//
// Streamable HTTP, JSON-RPC 2.0, modern revision 2026-07-28 (server/discover
// with supportedVersions) with the legacy initialize handshake also
// answered, so either era the suite negotiates works. Six tools, all acting
// on the same store as REST, so a repository or issue created over MCP reads
// back over /api/v3 as the same object.

import { VIEWER_LOGIN, type Store } from './store.ts';
import { commitFile, issueJson, mergePull, pullJson, repoJson } from './rest.ts';

export const MCP_SERVER_INFO = { name: 'forge', version: '1.0.0' };
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolJson(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  };
}

/** Pick the first present property among synonyms. */
function pick(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function pickString(args: Record<string, unknown>, names: string[]): string | undefined {
  const value = pick(args, names);
  return typeof value === 'string' ? value : undefined;
}

function toolResult(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = pickString(args, ['owner', 'owner_login', 'org', 'login']) ?? VIEWER_LOGIN;
  const repoName = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name']);
  switch (name) {
    case 'create_repo': {
      const repoNameArg = pickString(args, ['name', 'repo', 'repository', 'repository_name']) ?? '';
      if (repoNameArg === '') return toolError('create_repo requires a name');
      if (store.getRepo(owner, repoNameArg)) return toolError(`Repository ${owner}/${repoNameArg} already exists`);
      const repo = store.createRepo(
        owner,
        repoNameArg,
        pickString(args, ['description', 'about', 'summary']) ?? '',
        pick(args, ['private', 'is_private']) === true,
      );
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      if (!repoName) return toolError('get_repo requires a repo');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      if (!repoName) return toolError('create_issue requires a repo');
      const title = pickString(args, ['title', 'issue_title', 'subject']);
      if (!title) return toolError('create_issue requires a title');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const issue = {
        number,
        id: store.globalId('I', `${repo.fullName}/${number}`),
        title,
        body: pickString(args, ['body', 'issue_body', 'description', 'content']) ?? '',
        state: 'open' as const,
        labels: [] as string[],
        seq: number,
        comments: [],
      };
      repo.issues.push(issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      if (!repoName) return toolError('list_issues requires a repo');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = pickString(args, ['state', 'status']) ?? 'open';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      const payload = { issues: list.map((issue) => issueJson(repo, issue)), total_count: list.length };
      return toolResult(payload);
    }
    case 'create_pull_request': {
      if (!repoName) return toolError('create_pull_request requires a repo');
      const title = pickString(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
      const head = pickString(args, ['head', 'head_ref', 'head_branch', 'source_branch', 'from_branch']);
      const base = pickString(args, ['base', 'base_ref', 'base_branch', 'target_branch', 'into_branch']);
      if (!title || !head || !base) return toolError('create_pull_request requires title, head and base');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('Head or base branch does not exist');
      const duplicate = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
      if (duplicate) return toolError('A pull request already exists for this head and base');
      const mergeBase = store.mergeBase(repo, headSha, baseSha);
      const number = repo.nextPull;
      repo.nextPull += 1;
      const pull = {
        number,
        id: store.globalId('P', `${repo.fullName}/${number}`),
        title,
        body: pickString(args, ['body', 'description', 'content']) ?? '',
        state: 'open' as const,
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as string | null,
        head,
        base,
        headSha,
        baseSha,
        mergeBaseSha: mergeBase ?? baseSha,
        seq: number,
      };
      repo.pulls.push(pull);
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      if (!repoName) return toolError('merge_pull_request requires a repo');
      const rawNumber = pick(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']);
      const number = typeof rawNumber === 'number' ? rawNumber : Number(rawNumber);
      if (!Number.isInteger(number)) return toolError('merge_pull_request requires a pull_number');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return toolError(`Pull request #${number} not found`);
      if (pull.state !== 'open') return toolError('Pull request is not open');
      const mergedOk = mergePull(store, repo, pull);
      if (!mergedOk) return toolError('Merge conflict');
      return toolResult({ merged: true, sha: pull.mergeCommitSha, number: pull.number, ...pullJson(repo, pull) });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export interface McpResponse {
  status: number;
  body: string;
  contentType: string;
}

/**
 * Handle one POST /mcp body (already read as text). Auth is decided by the
 * caller: this only speaks JSON-RPC.
 */
export function handleMcp(store: Store, bodyText: string): McpResponse {
  const jsonType = 'application/json';
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      contentType: jsonType,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      contentType: jsonType,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }
  const request = body as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are answered with 202 and no body.
  if (request.id === undefined) {
    return { status: 202, contentType: jsonType, body: '' };
  }

  const okResult = (result: unknown): McpResponse => ({
    status: 200,
    contentType: jsonType,
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  });
  const rpcError = (code: number, message: string): McpResponse => ({
    status: 200,
    contentType: jsonType,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });

  switch (method) {
    case 'server/discover':
      return okResult({
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
      return okResult({ protocolVersion, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
    }
    case 'ping':
      return okResult({});
    case 'tools/list':
      return okResult({ tools: TOOLS.map(toolJson) });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((entry) => entry.name === toolName);
      if (!tool) return rpcError(-32602, `Unknown tool: ${toolName}`);
      const missing = tool.required.filter((prop) => args[prop] === undefined || args[prop] === null || args[prop] === '');
      if (missing.length > 0) {
        return okResult({ content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }], isError: true });
      }
      return okResult(callTool(store, toolName, args));
    }
    default:
      return rpcError(-32601, `Method not found: ${method}`);
  }
}

// Re-exported for the MCP setup path, which commits a file through REST.
export { commitFile };
