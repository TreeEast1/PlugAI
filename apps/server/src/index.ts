import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerPush } from '@plugai/shared';
import { PORT, ROOT } from './config.ts';
import { ProjectStore } from './projects.ts';
import { Runtime } from './runtime.ts';
import { createApi } from './api.ts';
import { casesRouter } from './cases.ts';

const store = new ProjectStore();
const subs = new Map<WebSocket, Set<string>>();
const broadcast = (projectId: string, msg: ServerPush) => {
  const data = JSON.stringify(msg);
  for (const [ws, set] of subs) if (set.has(projectId) && ws.readyState === ws.OPEN) ws.send(data);
};
const rt = new Runtime(store, broadcast);
// Runs that were active when the server stopped can never finish: record that honestly.
for (const p of store.list()) {
  for (const run of rt.listRuns(p.id)) {
    if (run.status !== 'running') continue;
    rt.bindRun(run.runId, p.id);
    const summary = 'Interrupted: the PlugAI server stopped while this run was active. Nothing from this run was verified.';
    rt.event(run.runId, { kind: 'final', status: 'failed', summary, at: new Date().toISOString() });
    rt.saveSummary({ ...run, status: 'failed', phase: 'failed', summary, finishedAt: new Date().toISOString() });
  }
}
const { router } = createApi(store, rt);

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  // local single-user app: only accept same-machine browser origins
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return res.status(403).json({ error: 'origin not allowed' });
  next();
});
app.use('/api', casesRouter(store));
app.use('/api', router);
const dist = join(ROOT, 'apps/web/dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return ws.close(1008, 'origin');
  subs.set(ws, new Set());
  ws.send(JSON.stringify({ type: 'hello', serverTime: new Date().toISOString() } satisfies ServerPush));
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(String(raw));
      if (m.subscribe) subs.get(ws)!.add(String(m.subscribe));
      if (m.unsubscribe) subs.get(ws)!.delete(String(m.unsubscribe));
    } catch {
      /* ignore */
    }
  });
  ws.on('close', () => subs.delete(ws));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PlugAI server listening on http://127.0.0.1:${PORT} (data: ${store.list().length} project(s))`);
});

const shutdown = async () => {
  console.log('PlugAI server shutting down: stopping simulators and tool processes');
  await rt.stopAll();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
