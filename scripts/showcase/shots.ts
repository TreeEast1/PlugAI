// Visual review screenshots of the site (landing sections, gallery, a case page, studio).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../test/lib.ts';

const BASE = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const out = join(ROOT, 'reports', 'ui');
mkdirSync(out, { recursive: true });
const which = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const shot = async (name: string) => page.screenshot({ path: join(out, `${name}.png`) });
const scrollSite = async (y: number) => {
  await page.evaluate((y) => document.querySelector('.site')!.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior }), y);
  await page.waitForTimeout(1300);
};

if (!which.length || which.includes('landing')) {
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(4500);
  await shot('landing-01-hero');
  const h = await page.evaluate(() => document.querySelector('.site')!.scrollHeight);
  let i = 2;
  for (let y = 820; y < h - 300; y += 820) {
    await scrollSite(y);
    await shot(`landing-${String(i++).padStart(2, '0')}`);
  }
}
if (!which.length || which.includes('cases')) {
  await page.goto(`${BASE}/cases`);
  await page.waitForTimeout(3500);
  await shot('cases-01');
  await scrollSite(800);
  await shot('cases-02');
}
for (const id of which.filter((w) => w.startsWith('case:')).map((w) => w.slice(5)).concat(!which.length ? ['pikachu-lcd'] : [])) {
  await page.goto(`${BASE}/cases/${id}`);
  await page.waitForTimeout(4000);
  await shot(`case-${id}-01`);
  await scrollSite(700);
  await shot(`case-${id}-02`);
}
await browser.close();
console.log('screenshots in', out);
