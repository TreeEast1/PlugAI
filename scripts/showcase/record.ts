// Record a short video + poster per case by filming the /cases/:id/film page (scripted replay of the recorded run).
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../test/lib.ts';

const BASE = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const SHOW = join(ROOT, 'showcase');
const only = process.argv.slice(2);
const ids = readdirSync(SHOW).filter((d) => existsSync(join(SHOW, d, 'case.json')) && (!only.length || only.includes(d)));
const browser = await chromium.launch();
for (const id of ids) {
  const tmp = join(ROOT, 'workspaces', 'tmp-video', id);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: tmp, size: { width: 1280, height: 720 } } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/cases/${id}/film`);
  await page.waitForFunction(() => (window as any).__filmReady === true, null, { timeout: 30_000 });
  await page.waitForTimeout(11_800);
  await page.screenshot({ path: join(SHOW, id, 'poster.png') });
  await page.waitForTimeout(3_400);
  const video = page.video()!;
  await ctx.close();
  const src = await video.path();
  renameSync(src, join(SHOW, id, 'video.webm'));
  rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ ${id}: video.webm + poster.png`);
}
await browser.close();
