// HTTP wiring: one process, one in-memory store, four surfaces.
//   GET  /healthz                          boot probe
//   /{owner}/{repo}.git/info/refs           git smart HTTP (upload-pack / receive-pack)
//   /{owner}/{repo}.git/git-upload-pack
//   /{owner}/{repo}.git/git-receive-pack
//   /api/v3/...                             REST v3
//   POST /api/graphql                       GraphQL
//   POST /mcp                               MCP (JSON-RPC 2.0, Streamable HTTP)
// Everything else answers JSON 404. A bad request never crashes the server.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './lib/githttp.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { Store } from './lib/store.ts';
import { json, jsonError } from './lib/util.ts';

export function createApp(): { store: Store; handler: (req: IncomingMessage, res: ServerResponse) => void; server: Server } {
  const store = new Store();
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (path === '/healthz' && req.method === 'GET') {
          json(res, 200, { ok: true });
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const name = decodeURIComponent(gitMatch[2]);
          const suffix = gitMatch[3];
          if (suffix === 'info/refs' && req.method === 'GET') {
            handleInfoRefs(req, res, store, owner, name);
            return;
          }
          if (suffix === 'git-upload-pack' && req.method === 'POST') {
            await handleUploadPack(req, res, store, owner, name);
            return;
          }
          if (suffix === 'git-receive-pack' && req.method === 'POST') {
            await handleReceivePack(req, res, store, owner, name);
            return;
          }
          jsonError(res, 404, 'Not Found');
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, store);
          return;
        }
        if (path === '/api/graphql' && req.method === 'POST') {
          await handleGraphQL(req, res, store);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(req, res, store);
          return;
        }

        jsonError(res, 404, 'Not Found');
      } catch (err) {
        console.error('request failed:', err instanceof Error ? err.message : String(err));
        if (!res.headersSent) jsonError(res, 500, 'Internal Server Error');
        else if (!res.writableEnded) res.end();
      }
    })();
  };
  const server = createServer(handler);
  return { store, handler, server };
}
