import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');

export interface TestResult {
  id: string;
  name: string;
  board?: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'BLOCKED';
  details: string[];
  evidence: string[];
  durationMs: number;
  data?: unknown;
}

export class Reporter {
  results: TestResult[] = [];
  readonly dir: string;
  constructor(readonly suite: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.dir = join(ROOT, 'reports', suite, stamp);
    mkdirSync(this.dir, { recursive: true });
  }
  path(...p: string[]) {
    const f = join(this.dir, ...p);
    mkdirSync(join(f, '..'), { recursive: true });
    return f;
  }
  rel(p: string) {
    return p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
  }
  async run(id: string, name: string, fn: (ctx: { log: (s: string) => void; evidence: (p: string) => void; data: (d: unknown) => void; board?: string }) => Promise<boolean | 'SKIP' | 'BLOCKED'>, board?: string) {
    const t = Date.now();
    const details: string[] = [];
    const evidence: string[] = [];
    let data: unknown;
    process.stdout.write(`\n▶ ${id} ${name}${board ? ` [${board}]` : ''}\n`);
    let status: TestResult['status'];
    try {
      const r = await fn({ log: (s) => { details.push(s); process.stdout.write(`   · ${s}\n`); }, evidence: (p) => evidence.push(this.rel(p)), data: (d) => (data = d), board });
      status = r === 'SKIP' ? 'SKIP' : r === 'BLOCKED' ? 'BLOCKED' : r ? 'PASS' : 'FAIL';
    } catch (e) {
      details.push(`exception: ${(e as Error).stack ?? e}`);
      process.stdout.write(`   ✗ exception: ${(e as Error).message}\n`);
      status = 'FAIL';
    }
    process.stdout.write(`   => ${status} (${Date.now() - t} ms)\n`);
    this.results.push({ id, name, board, status, details, evidence, durationMs: Date.now() - t, data });
  }
  finish(title: string, extra = '') {
    const json = { suite: this.suite, title, finishedAt: new Date().toISOString(), results: this.results };
    writeFileSync(join(this.dir, 'results.json'), JSON.stringify(json, null, 2));
    const md = [
      `# ${title}`,
      '',
      `Generated: ${json.finishedAt}`,
      '',
      extra,
      '',
      '| ID | Test | Board | Status | Time |',
      '|---|---|---|---|---|',
      ...this.results.map((r) => `| ${r.id} | ${r.name} | ${r.board ?? ''} | **${r.status}** | ${(r.durationMs / 1000).toFixed(1)} s |`),
      '',
      ...this.results.flatMap((r) => [`## ${r.id} — ${r.name}${r.board ? ` (${r.board})` : ''}: ${r.status}`, '', ...r.details.map((d) => `- ${d}`), '', r.evidence.length ? `Evidence: ${r.evidence.map((e) => `\`${e}\``).join(', ')}` : '', '']),
    ].join('\n');
    writeFileSync(join(this.dir, 'REPORT.md'), md);
    writeFileSync(join(ROOT, 'reports', this.suite, 'LATEST.md'), md.replace(/`(reports\/[^`]+)`/g, '`$1`'));
    writeFileSync(join(ROOT, 'reports', this.suite, 'latest.json'), JSON.stringify({ ...json, dir: this.rel(this.dir) }, null, 2));
    const failed = this.results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n${title}: ${this.results.filter((r) => r.status === 'PASS').length} pass, ${failed} fail, ${this.results.filter((r) => r.status === 'SKIP' || r.status === 'BLOCKED').length} skipped/blocked`);
    console.log(`Report: ${this.rel(join(this.dir, 'REPORT.md'))}`);
    return failed;
  }
}
