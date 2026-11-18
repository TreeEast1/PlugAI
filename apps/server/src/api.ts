import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentRun, DeepSeekClient, LlmError } from '@plugai/agent';
import { BOARDS, ScenarioSchema, type BoardId, type CircuitOp } from '@plugai/shared';
import { catalog, boardGeometry, COMPONENT_TYPES } from '@plugai/circuit';
import { HttpError, ProjectStore } from './projects.ts';
import { Runtime } from './runtime.ts';
import { ROOT } from './config.ts';

type H = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: H) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    next(e);
  }
};

export function createApi(store: ProjectStore, rt: Runtime) {
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));
  const activeRuns = new Map<string, AgentRun>();

  r.get('/health', wrap(() => ({ ok: true, time: new Date().toISOString() })));
  r.get('/environment', wrap(() => rt.inspectEnvironment()));
  r.get('/boards', wrap(() => ({
    boards: Object.values(BOARDS).map((b) => ({ ...b, geometry: boardGeometry(b) })),
    components: catalog().map((c) => ({ ...c, size: COMPONENT_TYPES[c.type as keyof typeof COMPONENT_TYPES].size, pinPos: COMPONENT_TYPES[c.type as keyof typeof COMPONENT_TYPES].pinPos })),
  })));
  r.get('/examples', wrap(() => {
    const dir = join(ROOT, 'firmware-examples');
    return readdirSync(dir)
      .filter((d) => d !== 'fixtures' && existsSync(join(dir, d, 'README.md')))
      .map((d) => ({ id: d, title: readFileSync(join(dir, d, 'README.md'), 'utf8').split('\n')[0].replace(/^#\s*/, ''), boards: ['esp32c3', 'uno'].filter((b) => existsSync(join(dir, d, b))) }));
  }));

  r.get('/llm/health', wrap(async () => {
    const { llmHealthCheck } = await import('../../../scripts/probe/llm-health.ts');
    return llmHealthCheck();
  }));

  // ---------------- projects
  r.get('/projects', wrap(() => store.list()));
  r.post('/projects', wrap((req) => {
    const b = z.object({ name: z.string().default('Untitled'), board: z.enum(['esp32c3-devkitm-1', 'arduino-uno']), example: z.string().regex(/^[a-z0-9-]+$/).optional() }).parse(req.body);
    return store.create(b);
  }));
  r.get('/projects/:id', wrap(async (req) => {
    const id = req.params.id;
    const meta = store.meta(id);
    return {
      meta,
      circuit: store.circuit(id),
      solution: rt.staticSolution(id),
      files: store.listFiles(id),
      lastBuild: rt.latestBuild(id),
      flashes: rt.listFlashes(id).slice(0, 10),
      loaded: rt.loadedFirmware(id),
      sim: rt.simState(id),
      runs: rt.listRuns(id).slice(0, 50),
      lastVerification: rt.lastVerification(id),
      head: store.head(id),
      sourceHash: await rt.sourceHash(id),
    };
  }));
  r.delete('/projects/:id', wrap(async (req) => {
    await rt.stopLive(req.params.id);
    store.delete(req.params.id);
  }));

  // files
  r.get('/projects/:id/files', wrap((req) => store.listFiles(req.params.id)));
  r.get(/^\/projects\/([^/]+)\/file\/(.+)$/, wrap((req) => ({ path: req.params[1], content: store.readFile(req.params[0], req.params[1]) })));
  r.put(/^\/projects\/([^/]+)\/file\/(.+)$/, wrap(async (req) => {
    const { content, message } = z.object({ content: z.string().max(400_000), message: z.string().optional() }).parse(req.body);
    const id = req.params[0];
    const rel = req.params[1];
    const res = await rt.writeFile(id, rel, content, 'user');
    const commit = store.commit(id, message ?? `user edit: ${rel}`);
    return { ...res, commit };
  }));
  r.delete(/^\/projects\/([^/]+)\/file\/(.+)$/, wrap((req) => {
    store.deleteFile(req.params[0], req.params[1]);
    return { commit: store.commit(req.params[0], `user delete: ${req.params[1]}`) };
  }));

  // circuit
  r.get('/projects/:id/circuit', wrap((req) => ({ circuit: store.circuit(req.params.id), solution: rt.staticSolution(req.params.id) })));
  r.post('/projects/:id/circuit/ops', wrap(async (req) => {
    const { ops } = z.object({ ops: z.array(z.record(z.any())).min(1).max(200) }).parse(req.body);
    const res = await rt.editCircuit(req.params.id, ops as unknown as CircuitOp[], 'user');
    return { ...res, circuitJson: store.circuit(req.params.id), solution: rt.staticSolution(req.params.id) };
  }));

  // history
  r.get('/projects/:id/history', wrap((req) => store.history(req.params.id)));
  r.get('/projects/:id/history/:commit', wrap((req) => ({ diff: store.diff(req.params.id, req.params.commit) })));
  r.post('/projects/:id/restore', wrap(async (req) => {
    const { commit } = z.object({ commit: z.string() }).parse(req.body);
    await rt.stopLive(req.params.id);
    const head = store.restore(req.params.id, commit);
    return { head };
  }));

  // build
  r.post('/projects/:id/build', wrap((req) => rt.build(req.params.id, 'user')));
  r.get('/projects/:id/builds', wrap((req) => rt.listBuilds(req.params.id)));
  r.get('/projects/:id/builds/:bid', wrap((req) => rt.getBuild(req.params.id, req.params.bid)));
  r.get('/projects/:id/builds/:bid/log', (req, res, next) => {
    try {
      const b = rt.getBuild(req.params.id, req.params.bid);
      res.type('text/plain').send(readFileSync(join(store.dir(req.params.id), b.logPath), 'utf8'));
    } catch (e) {
      next(e);
    }
  });
  r.get('/projects/:id/builds/:bid/artifacts/:name', (req, res, next) => {
    try {
      const b = rt.getBuild(req.params.id, req.params.bid);
      const a = b.artifacts.find((x) => x.name === req.params.name);
      if (!a) throw new HttpError(404, 'artifact not found');
      res.download(join(store.dir(req.params.id), a.path), `${store.meta(req.params.id).name.replace(/[^A-Za-z0-9_-]/g, '_')}-${b.buildId}-${a.name}`);
    } catch (e) {
      next(e);
    }
  });

  // flash / load
  r.post('/projects/:id/flash', wrap(async (req) => {
    const b = z.object({ method: z.enum(['esptool-virtual-uart', 'direct-image-load']).optional(), buildId: z.string().optional() }).parse(req.body ?? {});
    return rt.flash(req.params.id, 'user', b.method, b.buildId);
  }));
  r.get('/projects/:id/flashes', wrap((req) => rt.listFlashes(req.params.id)));
  r.get('/projects/:id/flashes/:fid/log', (req, res, next) => {
    try {
      if (!/^[a-z_0-9]+$/.test(req.params.fid)) throw new HttpError(400, 'bad id');
      res.type('text/plain').send(readFileSync(join(store.dir(req.params.id), 'flashes', req.params.fid, 'flash.log'), 'utf8'));
    } catch (e) {
      next(e);
    }
  });

  r.get('/projects/:id/traces/:file', (req, res, next) => {
    try {
      if (!/^[A-Za-z0-9_\-.]+\.(png|jsonl)$/.test(req.params.file)) throw new HttpError(400, 'bad file');
      const p = join(store.dir(req.params.id), 'traces', req.params.file);
      if (!existsSync(p)) throw new HttpError(404, 'not found');
      res.sendFile(p);
    } catch (e) {
      next(e);
    }
  });

  // simulation
  r.get('/projects/:id/sim', wrap((req) => rt.simState(req.params.id)));
  r.post('/projects/:id/sim/:action(start|pause|reset|stop)', wrap((req) => rt.simAction(req.params.id, req.params.action as 'start', Number(req.body?.speed ?? 1))));
  r.post('/projects/:id/sim/button', wrap((req) => {
    const b = z.object({ component: z.string(), pressed: z.boolean() }).parse(req.body);
    rt.pressButton(req.params.id, b.component, b.pressed);
  }));
  r.post('/projects/:id/sim/uart', wrap((req) => {
    rt.uartWrite(req.params.id, z.object({ text: z.string().max(4096) }).parse(req.body).text);
  }));
  r.post('/projects/:id/verify', wrap((req) => rt.verify(req.params.id, ScenarioSchema.parse(req.body.scenario), 'user')));
  r.get('/projects/:id/verifications', wrap((req) => {
    const d = join(store.dir(req.params.id), 'verifications');
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((f) => f.startsWith('ver_')).sort().reverse().slice(0, 30).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')));
  }));

  // agent
  r.post('/projects/:id/agent', wrap(async (req, res) => {
    const id = req.params.id;
    const { message } = z.object({ message: z.string().min(1).max(4000) }).parse(req.body);
    if ([...activeRuns.values()].some((r) => r.projectId === id)) throw new HttpError(409, 'An agent run is already active for this project');
    let llm: DeepSeekClient;
    try {
      llm = DeepSeekClient.fromEnv();
    } catch (e) {
      res.status(503);
      return { error: (e as LlmError).message, kind: 'llm-config' };
    }
    const board = store.meta(id).board as BoardId;
    const run = new AgentRun(rt, llm, rt, id, board, message);
    rt.bindRun(run.runId, id);
    rt.saveSummary(run.summary);
    activeRuns.set(run.runId, run);
    run
      .execute()
      .catch(() => undefined)
      .finally(() => activeRuns.delete(run.runId));
    return { runId: run.runId };
  }));
  r.post('/projects/:id/agent/:runId/cancel', wrap((req) => {
    const run = activeRuns.get(req.params.runId);
    if (!run) throw new HttpError(404, 'run not active');
    run.cancel();
  }));
  r.get('/projects/:id/runs', wrap((req) => rt.listRuns(req.params.id)));
  r.get('/projects/:id/runs/:runId', wrap((req) => ({ ...rt.getRun(req.params.id, req.params.runId), active: activeRuns.has(req.params.runId) })));

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    console.error('[api]', err);
    res.status(500).json({ error: (err as Error).message });
  });
  return { router: r, activeRuns };
}
