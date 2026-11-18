// Showcase cases: curated, recorded AI runs (prompts, plan, firmware, verification, replay recording).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import express from 'express';
import { applyOps, createCircuit } from '@plugai/circuit';
import { ROOT } from './config.ts';
import { HttpError, ProjectStore } from './projects.ts';

export const SHOWCASE_DIR = resolve(ROOT, 'showcase');

const SLUG = /^[a-z0-9-]{2,60}$/;

export function listCases() {
  if (!existsSync(SHOWCASE_DIR)) return [];
  return readdirSync(SHOWCASE_DIR)
    .filter((d) => SLUG.test(d) && existsSync(join(SHOWCASE_DIR, d, 'case.json')))
    .map((d) => {
      const c = JSON.parse(readFileSync(join(SHOWCASE_DIR, d, 'case.json'), 'utf8'));
      const { turns, final, replay, ...summary } = c;
      return {
        ...summary,
        turns: turns.map((t: any) => ({ prompt: t.prompt, status: t.status })),
        hasVideo: existsSync(join(SHOWCASE_DIR, d, 'video.webm')),
        hasPoster: existsSync(join(SHOWCASE_DIR, d, 'poster.png')),
      };
    })
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

export function readCase(slug: string) {
  if (!SLUG.test(slug)) throw new HttpError(400, 'bad case id');
  const p = join(SHOWCASE_DIR, slug, 'case.json');
  if (!existsSync(p)) throw new HttpError(404, 'case not found');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  c.hasVideo = existsSync(join(SHOWCASE_DIR, slug, 'video.webm'));
  c.hasPoster = existsSync(join(SHOWCASE_DIR, slug, 'poster.png'));
  return c;
}

/** Proof numbers shown on the landing page, read from the latest real test reports. */
export function proof() {
  const out: Record<string, unknown> = {};
  for (const s of ['p0', 'llm', 'e2e']) {
    const p = join(ROOT, 'reports', s, 'latest.json');
    if (!existsSync(p)) continue;
    const d = JSON.parse(readFileSync(p, 'utf8'));
    out[s] = { pass: d.results.filter((r: any) => r.status === 'PASS').length, total: d.results.length, finishedAt: d.finishedAt };
  }
  return out;
}

export function casesRouter(store: ProjectStore) {
  const r = express.Router();
  r.get('/cases', (_req, res) => res.json(listCases()));
  r.get('/proof', (_req, res) => res.json({ ...proof(), cases: listCases().length }));
  r.get('/cases/:slug', (req, res, next) => {
    try {
      res.json(readCase(req.params.slug));
    } catch (e) {
      next(e);
    }
  });
  r.get(/^\/cases\/([a-z0-9-]+)\/assets\/(.+)$/, (req, res, next) => {
    try {
      const base = join(SHOWCASE_DIR, req.params[0]);
      const p = resolve(base, req.params[1]);
      if (!p.startsWith(base + sep) || !existsSync(p)) throw new HttpError(404, 'asset not found');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.sendFile(p);
    } catch (e) {
      next(e);
    }
  });
  r.post('/cases/:slug/fork', express.json(), (req, res, next) => {
    try {
      const c = readCase(req.params.slug);
      const meta = store.create({ name: `${c.title} (fork)`, board: c.board });
      const dir = store.dir(meta.id);
      // circuit + firmware exactly as the case ended
      store.saveCircuit(meta.id, c.final.circuit ?? applyOps(createCircuit(c.board), []).circuit);
      for (const [path, content] of Object.entries<string>(c.final.files ?? {})) store.writeFile(meta.id, path, content);
      // carry the conversation so the planner sees the history when the user continues
      const runsSrc = join(SHOWCASE_DIR, req.params.slug, 'runs');
      if (existsSync(runsSrc)) {
        mkdirSync(join(dir, 'runs'), { recursive: true });
        cpSync(runsSrc, join(dir, 'runs'), { recursive: true });
        for (const rd of readdirSync(join(dir, 'runs'))) {
          const rj = join(dir, 'runs', rd, 'run.json');
          if (!existsSync(rj)) continue;
          const run = JSON.parse(readFileSync(rj, 'utf8'));
          run.projectId = meta.id;
          writeFileSync(rj, JSON.stringify(run, null, 2));
        }
      }
      const m = store.meta(meta.id);
      (m as any).origin = `case:${req.params.slug}`;
      writeFileSync(join(dir, 'project.json'), JSON.stringify(m, null, 2));
      store.commit(meta.id, `fork of showcase case "${c.title}"`);
      res.json(store.meta(meta.id));
    } catch (e) {
      next(e);
    }
  });
  return r;
}
