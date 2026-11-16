// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Every reply is JSON and carries X-GitHub-Request-Id (app.ts adds the
// header). Errors are {message: string} with the status the suite expects:
// 401 without a token, 404 for a missing object (never 403 for a foreign
// owner), 409 on a stale contents sha, 422 on an unknown label or a
// duplicate repository / pull request, 400 on a malformed JSON body
// (app.ts parses the body first).

import { ZERO_OID, parseCommit } from './git.ts';
import { VIEWER, VIEWER_LOGIN, type Comment, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.globalId,
    databaseId: repo.databaseId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', default: false };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.globalId,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body ?? '',
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? true : null,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}`, user: { login: repo.owner } },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}`, user: { login: repo.owner } },
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> {
  const object = store.getObject(repo, sha);
  const info = object && object.type === 'commit' ? parseCommit(object.data) : null;
  return {
    sha,
    commit: {
      message: info?.message ?? '',
      author: { name: VIEWER.name, email: VIEWER.email, date: '2025-01-01T00:00:00Z' },
      committer: { name: VIEWER.name, email: VIEWER.email, date: '2025-01-01T00:00:00Z' },
      tree: { sha: info?.tree ?? ZERO_OID },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

function pageOf<T>(items: T[], query: URLSearchParams): { page: T[]; totalPages: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages: Math.max(1, Math.ceil(items.length / perPage)), pageNum, perPage };
}

function linkHeader(base: string, path: string, query: URLSearchParams, pageNum: number, totalPages: number, perPage: number): string {
  const parts: string[] = [];
  const build = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(page));
    q.set('per_page', String(perPage));
    return `${base}${path}?${q.toString()}`;
  };
  if (pageNum < totalPages) parts.push(`<${build(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) parts.push(`<${build(pageNum - 1)}>; rel="prev"`);
  parts.push(`<${build(1)}>; rel="first"`);
  parts.push(`<${build(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

/** Resolve a repo the token may read: only the viewer's own repos exist. */
function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function resolveRef(repo: Repo, ref: string): string | undefined {
  // A branch name, a full ref, or a commit sha.
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch) return byBranch;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}

/** Write one file into a branch's tree and commit it. Returns the commit sha. */
export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string; isNewBranch: boolean } {
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  let isNewBranch = false;
  if (tip === undefined) {
    // A new branch starts from the default branch's tip (or nothing).
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    isNewBranch = true;
  }
  const baseTree = tip ? parseCommit(store.getObject(repo, tip)!.data).tree : '';
  const files = tip ? store.treeToMap(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  const blobSha = store.putObject(repo, 'blob', content);
  files.set(path, { oid: blobSha, mode: '100644' });
  const tree = store.mapToTree(repo, files);
  const parents = tip ? [tip] : [];
  const commitSha = store.makeCommit(repo, tree, parents, message);
  repo.refs.set(refName, commitSha);
  repo.version += 1;
  repo.packCache.clear();
  return { commitSha, blobSha, isNewBranch };
}

function deleteFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  message: string,
): string | null {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (!tip) return null;
  const baseTree = parseCommit(store.getObject(repo, tip)!.data).tree;
  const files = store.treeToMap(repo, baseTree);
  if (!files.has(path)) return null;
  files.delete(path);
  const tree = store.mapToTree(repo, files);
  const commitSha = store.makeCommit(repo, tree, [tip], message);
  repo.refs.set(refName, commitSha);
  repo.version += 1;
  repo.packCache.clear();
  return commitSha;
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * Handle one REST request. `segments` are the path parts after /api/v3,
 * `query` the parsed query string, `body` the parsed JSON body (or null),
 * `base` the request's own origin for pagination Link headers.
 * Returns null when the path is not a REST route at all.
 */
export function routeRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  base: string,
): RestResult | null {
  const seg = (index: number): string => segments[index] ?? '';
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0', version: '1.0.0' });
  }

  // GET /api/v3/user and POST /api/v3/user/repos
  if (seg(0) === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return ok({ login: VIEWER_LOGIN, id: VIEWER.id, node_id: store.globalId('U', VIEWER_LOGIN), name: VIEWER.name, email: VIEWER.email, type: 'User' });
    }
    if (segments.length === 2 && seg(1) === 'repos') {
      if (method === 'GET') {
        const repos = store.listViewerRepos();
        const { page, totalPages, pageNum, perPage } = pageOf(repos, query);
        const headers: Record<string, string> = {};
        if (totalPages > 1) headers.link = linkHeader(base, '/api/v3/user/repos', query, pageNum, totalPages, perPage);
        return ok(page.map(repoJson), 200, headers);
      }
      if (method === 'POST') {
        if (!body || typeof body.name !== 'string' || body.name === '') return err(422, 'Repository name is required');
        const name = body.name as string;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'Invalid repository name');
        if (store.getRepo(VIEWER_LOGIN, name)) return err(422, 'Repository already exists');
        const repo = store.createRepo(
          VIEWER_LOGIN,
          name,
          typeof body.description === 'string' ? body.description : '',
          body.private === true,
        );
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        return ok(repoJson(repo), 201);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg(0) === 'repos' && segments.length >= 3) {
    const owner = decode(seg(1));
    const name = decode(seg(2));
    const repo = lookupRepo(store, owner, name);
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return err(404, 'Not Found');
        return ok(repoJson(repo));
      }
      if (method === 'PATCH') {
        if (!repo) return err(404, 'Not Found');
        if (!body) return err(400, 'Invalid JSON body');
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return err(404, 'Not Found');
        store.deleteRepo(owner, name);
        return { status: 204, body: '' };
      }
      return err(404, 'Not Found');
    }

    if (!repo) return err(404, 'Not Found');

    // Branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
        return ok(list);
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decode(rest[1]);
        const sha = branchTip(repo, branch);
        if (!sha) return err(404, 'Not Found');
        return ok({ name: branch, commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // Commits
    if (rest[0] === 'commits') {
      if (method !== 'GET') return err(404, 'Not Found');
      if (rest.length === 2) {
        const sha = decode(rest[1]);
        const object = store.getObject(repo, sha);
        if (!object || object.type !== 'commit') return err(404, 'Not Found');
        return ok(commitJson(store, repo, sha));
      }
      if (rest.length === 1) {
        const ref = query.get('sha') ?? repo.defaultBranch;
        const tip = resolveRef(repo, ref);
        if (!tip) return ok([]);
        const peeled = store.peelToCommit(repo, tip);
        if (!peeled) return ok([]);
        const commits = store.commitWalk(repo, peeled).map((sha) => commitJson(store, repo, sha));
        const { page } = pageOf(commits, query);
        return ok(page);
      }
      return err(404, 'Not Found');
    }

    // Git Data API: refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (!body || typeof body.ref !== 'string' || typeof body.sha !== 'string') return err(422, 'ref and sha are required');
        const ref = body.ref as string;
        const sha = body.sha as string;
        if (!ref.startsWith('refs/')) return err(422, 'Invalid ref');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        const object = store.getObject(repo, sha);
        if (!object) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        repo.version += 1;
        repo.packCache.clear();
        return ok({ ref, object: { sha, type: object.type, url: '' } }, 201);
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
          return ok(list);
        }
        // GET /git/refs/heads/{branch} (branch names may contain slashes)
        const ref = `refs/${rest.slice(2).map(decode).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) return err(404, 'Not Found');
        return ok({ ref, object: { sha, type: 'commit' } });
      }
      if (method === 'PATCH' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).map(decode).join('/')}`;
        if (!repo.refs.has(ref)) return err(404, 'Not Found');
        if (!body || typeof body.sha !== 'string') return err(422, 'sha is required');
        repo.refs.set(ref, body.sha as string);
        repo.version += 1;
        repo.packCache.clear();
        return ok({ ref, object: { sha: body.sha as string, type: 'commit' } });
      }
      if (method === 'DELETE' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).map(decode).join('/')}`;
        if (!repo.refs.delete(ref)) return err(404, 'Not Found');
        repo.version += 1;
        repo.packCache.clear();
        return { status: 204, body: '' };
      }
      return err(404, 'Not Found');
    }

    // Contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decode).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const tip = resolveRef(repo, ref);
        if (!tip) return err(404, 'Not Found');
        const commit = store.peelToCommit(repo, tip);
        if (!commit) return err(404, 'Not Found');
        const treeOid = parseCommit(store.getObject(repo, commit)!.data).tree;
        const files = store.treeToMap(repo, treeOid);
        const file = files.get(path);
        if (file) {
          const data = store.getObject(repo, file.oid)?.data ?? Buffer.alloc(0);
          const name = path.split('/').pop() ?? path;
          return ok({
            type: 'file', encoding: 'base64', size: data.length, name, path,
            sha: file.oid, content: data.toString('base64'),
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
          });
        }
        // Directory listing: immediate children of `path` ('' is the root).
        const prefix = path === '' ? '' : `${path}/`;
        const children = new Map<string, { type: string; oid: string; path: string }>();
        for (const [filePath, entry] of files) {
          if (!filePath.startsWith(prefix)) continue;
          const rest2 = filePath.slice(prefix.length);
          const slash = rest2.indexOf('/');
          if (slash === -1) {
            children.set(rest2, { type: 'file', oid: entry.oid, path: filePath });
          } else {
            const dirName = rest2.slice(0, slash);
            if (!children.has(dirName)) {
              // The directory's tree oid, for the sha field.
              children.set(dirName, { type: 'dir', oid: '', path: `${prefix}${dirName}` });
            }
          }
        }
        if (children.size === 0) return err(404, 'Not Found');
        const list = [...children.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([childName, child]) => ({
            type: child.type, name: childName, path: child.path,
            sha: child.oid === '' ? ZERO_OID : child.oid, size: child.type === 'file' ? (store.getObject(repo, child.oid)?.data.length ?? 0) : 0,
            url: `/api/v3/repos/${owner}/${name}/contents/${child.path}`,
          }));
        return ok(list);
      }
      if (method === 'PUT') {
        if (!body || typeof body.content !== 'string') return err(422, 'content is required');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
        let content: Buffer;
        try {
          content = Buffer.from(body.content as string, 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const tip = branchTip(repo, branch);
        let existingSha: string | null = null;
        if (tip) {
          const treeOid = parseCommit(store.getObject(repo, tip)!.data).tree;
          const files = store.treeToMap(repo, treeOid);
          const entry = files.get(path);
          if (entry) existingSha = entry.oid;
        }
        if (existingSha !== null) {
          if (typeof body.sha !== 'string') return err(422, 'sha is required to update a file');
          if (body.sha !== existingSha) return err(409, 'sha does not match the current file');
        }
        const { commitSha, blobSha } = commitFile(store, repo, branch, path, content, message);
        const name = path.split('/').pop() ?? path;
        return ok(
          {
            content: { type: 'file', encoding: 'base64', size: content.length, name, path, sha: blobSha, content: content.toString('base64') },
            commit: { sha: commitSha, message },
          },
          existingSha !== null ? 200 : 201,
        );
      }
      if (method === 'DELETE') {
        const branch = body && typeof body.branch === 'string' && body.branch !== '' ? (body.branch as string) : repo.defaultBranch;
        const message = body && typeof body.message === 'string' && body.message !== '' ? (body.message as string) : `Delete ${path}`;
        const tip = branchTip(repo, branch);
        if (!tip) return err(404, 'Not Found');
        const treeOid = parseCommit(store.getObject(repo, tip)!.data).tree;
        const files = store.treeToMap(repo, treeOid);
        const entry = files.get(path);
        if (!entry) return err(404, 'Not Found');
        if (body && typeof body.sha === 'string' && body.sha !== entry.oid) return err(409, 'sha does not match the current file');
        const commitSha = deleteFile(store, repo, branch, path, message);
        if (!commitSha) return err(404, 'Not Found');
        return ok({ commit: { sha: commitSha, message } });
      }
      return err(404, 'Not Found');
    }

    // Labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
      }
      if (method === 'POST' && rest.length === 1) {
        if (!body || typeof body.name !== 'string' || body.name === '') return err(422, 'Label name is required');
        const name = body.name as string;
        const existing = repo.labels.get(name);
        if (existing) return ok({ name: existing.name, color: existing.color, default: false }, 200);
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        repo.labels.set(name, { name, color });
        return ok({ name, color, default: false }, 201);
      }
      return err(404, 'Not Found');
    }

    // Issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          if (!body || typeof body.title !== 'string' || body.title === '') return err(422, 'Title is required');
          const labels = Array.isArray(body.labels) ? (body.labels as unknown[]) : [];
          for (const label of labels) {
            const name = typeof label === 'string' ? label : (label as Record<string, unknown>)?.name;
            if (typeof name !== 'string' || !repo.labels.has(name)) return err(422, `Label does not exist: ${String(name)}`);
          }
          const number = repo.nextIssue;
          repo.nextIssue += 1;
          const issue: Issue = {
            number,
            id: store.globalId('I', `${repo.fullName}/${number}`),
            title: body.title as string,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels: labels.map((label) => (typeof label === 'string' ? label : (label as Record<string, string>).name)),
            seq: repo.nextIssue,
            comments: [],
          };
          issue.seq = number;
          repo.issues.push(issue);
          return ok(issueJson(repo, issue), 201);
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page } = pageOf(list, query);
          return ok(page.map((issue) => issueJson(repo, issue)));
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const issue = repo.issues.find((entry) => entry.number === number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!issue) return err(404, 'Not Found');
          return ok(issueJson(repo, issue));
        }
        if (method === 'PATCH') {
          if (!issue) return err(404, 'Not Found');
          if (!body) return err(400, 'Invalid JSON body');
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          return ok(issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (rest.length === 3 && method === 'GET') {
          return ok(issue.comments.map((comment) => commentJson(repo, issue, comment)));
        }
        if (rest.length === 3 && method === 'POST') {
          if (!body || typeof body.body !== 'string') return err(422, 'body is required');
          const id = repo.nextComment;
          repo.nextComment += 1;
          const comment: Comment = {
            id,
            globalId: store.globalId('C', `${repo.fullName}/${issue.number}/${id}`),
            body: body.body as string,
            seq: id,
          };
          issue.comments.push(comment);
          return ok(commentJson(repo, issue, comment), 201);
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // Pull requests
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          if (!body || typeof body.title !== 'string') return err(422, 'Title is required');
          const head = typeof body.head === 'string' ? body.head.split(':').pop()! : '';
          const base = typeof body.base === 'string' ? body.base.split(':').pop()! : '';
          const headSha = branchTip(repo, head);
          const baseSha = branchTip(repo, base);
          if (!headSha || !baseSha) return err(422, 'Head or base branch does not exist');
          const duplicate = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
          if (duplicate) return err(422, 'A pull request already exists for this head and base');
          const mergeBase = store.mergeBase(repo, headSha, baseSha);
          const number = repo.nextPull;
          repo.nextPull += 1;
          const pull: PullRequest = {
            number,
            id: store.globalId('P', `${repo.fullName}/${number}`),
            title: body.title as string,
            body: typeof body.body === 'string' ? body.body : '',
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
          return ok(pullJson(repo, pull), 201);
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((pull) => pull.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page } = pageOf(list, query);
          return ok(page.map((pull) => pullJson(repo, pull)));
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!pull) return err(404, 'Not Found');
          return ok(pullJson(repo, pull));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'files' && method === 'GET') {
        if (!pull) return err(404, 'Not Found');
        const baseTree = parseCommit(store.getObject(repo, pull.mergeBaseSha)!.data).tree;
        const headTree = parseCommit(store.getObject(repo, pull.headSha)!.data).tree;
        const changes = store.diffTrees(repo, baseTree, headTree);
        return ok(
          changes.map((change) => ({
            filename: change.path,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.additions + change.deletions,
            sha: change.newOid ?? change.oldOid ?? ZERO_OID,
          })),
        );
      }
      if (rest[2] === 'merge') {
        if (method === 'PUT') {
          if (!pull) return err(404, 'Not Found');
          if (pull.state !== 'open') return err(405, 'Pull request is not open');
          const merged = mergePull(store, repo, pull);
          if (!merged) return err(405, 'Merge conflict');
          return ok({ sha: pull.mergeCommitSha, merged: true, message: `Merge pull request #${pull.number} from ${pull.head}` });
        }
        if (method === 'GET') {
          if (!pull) return err(404, 'Not Found');
          if (pull.merged) return { status: 204, body: '' };
          return err(404, 'Not Found');
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return null;
}

/** Squash-merge a pull request onto its base branch. False on conflict. */
export function mergePull(store: Store, repo: Repo, pull: PullRequest): boolean {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (!baseTip || !headTip) return false;
  // Refresh the tips (branches may have moved since the PR opened).
  pull.baseSha = baseTip;
  pull.headSha = headTip;
  const mergeBase = store.mergeBase(repo, headTip, baseTip);
  if (mergeBase === null) return false;
  pull.mergeBaseSha = mergeBase;
  const baseTree = parseCommit(store.getObject(repo, baseTip)!.data).tree;
  const headTree = parseCommit(store.getObject(repo, headTip)!.data).tree;
  const mergeBaseTree = parseCommit(store.getObject(repo, mergeBase)!.data).tree;
  const headChanges = store.diffTrees(repo, mergeBaseTree, headTree);
  const baseChanges = store.diffTrees(repo, mergeBaseTree, baseTree);
  const baseByPath = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const baseChange = baseByPath.get(change.path);
    if (!baseChange) continue;
    // Both sides changed the same path: a conflict unless they agree.
    if (baseChange.newOid !== change.newOid) return false;
  }
  // Apply the head's changes onto the base tree.
  const files = store.treeToMap(repo, baseTree);
  for (const change of headChanges) {
    if (change.status === 'removed') files.delete(change.path);
    else if (change.newOid) files.set(change.path, { oid: change.newOid, mode: '100644' });
  }
  const tree = store.mapToTree(repo, files);
  const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
  const commitSha = store.makeCommit(repo, tree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.base}`, commitSha);
  repo.version += 1;
  repo.packCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.fixedIso();
  pull.mergeCommitSha = commitSha;
  pull.baseSha = commitSha;
  return true;
}
