// app.ts — the HTTP server: one process, one store, four surfaces.
//
//   GET  /healthz                     the env's boot probe (no auth)
//   /{owner}/{repo}.git/...           git smart HTTP (git-http.ts)
//   /api/v3/...                       REST v3 (rest.ts)
//   POST /api/graphql                 GraphQL v4 (graphql.ts)
//   POST /mcp                         MCP (mcp.ts)
//
// Auth: every surface except /healthz requires `Authorization: Bearer
// <token>`, where <token> is the trial's MAKEFUN_SHOP_TOKEN. A request
// without it (or with the wrong one, when a token is configured) is 401
// with a JSON body. Every REST/GraphQL/MCP reply is JSON and carries a
// non-empty X-GitHub-Request-Id; unknown routes are JSON 404s, never HTML;
// a malformed JSON body is a 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { routeRest, type RestResult } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (expected === '') return true;
  return token === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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

export function createApp(): Server {
  const store = new Store();
  let requestSeq = 0;

  const sendJson = (res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void => {
    const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
    const headers: Record<string, string> = {
      'content-type': JSON_TYPE,
      'x-github-request-id': `req-${(requestSeq += 1)}`,
      ...extraHeaders,
    };
    if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
    res.writeHead(status, headers);
    res.end(text);
  };

  const sendBuffer = (res: ServerResponse, status: number, body: Buffer, contentType: string): void => {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(body.length),
      'x-github-request-id': `req-${(requestSeq += 1)}`,
    });
    res.end(body);
  };

  const sendRest = (res: ServerResponse, result: RestResult): void => {
    if (result.status === 204) {
      res.writeHead(204, { 'x-github-request-id': `req-${(requestSeq += 1)}` });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers ?? {});
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot probe: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const suffix = gitMatch[3];
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const query = queryOf(req);
          if (method === 'GET' && suffix === '/info/refs') {
            const result = handleInfoRefs(store, owner, repoName, query.get('service') ?? '', req.headers['git-protocol'] ?? '');
            sendBuffer(res, result.status, result.body, result.contentType);
            return;
          }
          if (method === 'POST' && suffix === '/git-upload-pack') {
            const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
            if (!repo) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const body = await readBody(req);
            const result = handleUploadPack(store, repo, body, req.headers['git-protocol'] ?? '');
            sendBuffer(res, result.status, result.body, result.contentType);
            return;
          }
          if (method === 'POST' && suffix === '/git-receive-pack') {
            const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
            if (!repo) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const body = await readBody(req);
            const result = handleReceivePack(store, repo, body);
            sendBuffer(res, result.status, result.body, result.contentType);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Invalid JSON body' });
            return;
          }
          const result = executeGraphQL(store, body);
          sendJson(res, 200, result);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(store, raw.toString('utf8'));
          if (result.status === 202) {
            res.writeHead(202, { 'x-github-request-id': `req-${(requestSeq += 1)}` });
            res.end();
            return;
          }
          res.writeHead(result.status, {
            'content-type': result.contentType,
            'content-length': String(Buffer.byteLength(result.body)),
            'x-github-request-id': `req-${(requestSeq += 1)}`,
          });
          res.end(result.body);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = restPath === '' ? [] : restPath.split('/').filter((part) => part !== '');
          const query = queryOf(req);
          const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
          let body: Record<string, unknown> | null = null;
          if (hasBody) {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                const parsed: unknown = JSON.parse(raw.toString('utf8'));
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  sendJson(res, 400, { message: 'Request body must be a JSON object' });
                  return;
                }
                body = parsed as Record<string, unknown>;
              } catch {
                sendJson(res, 400, { message: 'Invalid JSON body' });
                return;
              }
            }
          }
          const host = req.headers.host ?? 'localhost';
          const base = `http://${host}`;
          const result = routeRest(store, method, segments, query, body, base);
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendRest(res, result);
          return;
        }

        // Everything else: a JSON 404, never HTML.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        try {
          sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
        } catch {
          // The socket is gone; nothing more to do.
        }
      }
    })();
  });
}
