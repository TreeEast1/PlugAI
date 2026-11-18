// Aggregate the latest suite reports into reports/SUMMARY.md
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.ts';

const suites = [
  ['p0', 'P0 — real firmware ↔ MCU emulation ↔ circuit (Tests 1–6, 8)'],
  ['llm', 'DeepSeek agent (LLM-Test-01…07, Tests A–E, capability boundary)'],
  ['e2e', 'End-to-end §15 flow, Test 9 anti-cheat, Test 10 regression'],
] as const;
const lines = ['# PlugAI test summary', '', `Generated ${new Date().toISOString()}`, ''];
for (const [s, title] of suites) {
  const p = join(ROOT, 'reports', s, 'latest.json');
  if (!existsSync(p)) {
    lines.push(`## ${title}`, '', '_not run_', '');
    continue;
  }
  const d = JSON.parse(readFileSync(p, 'utf8'));
  const pass = d.results.filter((r: any) => r.status === 'PASS').length;
  lines.push(`## ${title}`, '', `${pass}/${d.results.length} PASS — full report: \`${d.dir}/REPORT.md\``, '', '| ID | Test | Board | Status |', '|---|---|---|---|');
  for (const r of d.results) lines.push(`| ${r.id} | ${r.name} | ${r.board ?? ''} | **${r.status}** |`);
  lines.push('');
}
writeFileSync(join(ROOT, 'reports', 'SUMMARY.md'), lines.join('\n'));
console.log(lines.join('\n'));
