// DeepSeek-V4.1-Flash agent acceptance (LLM-Test-01..07 + non-preset scenarios A–E + capability boundary).
// Requires the PlugAI server running (npm run dev:server). Every run is real: DeepSeek → tools → real builds → emulator → verification.
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Reporter, ROOT } from './lib.ts';
import { agent, call, describeRun, finalVerification, llmRecords, newProject, ok, serverUp, toolRecords, type RunResult } from './client.ts';
import { llmHealthCheck } from '../probe/llm-health.ts';
import { AgentRun, DeepSeekClient, loadLlmConfig } from '@plugai/agent';

const R = new Reporter('llm');
if (!(await serverUp())) {
  console.error('PlugAI server is not running on 127.0.0.1:8787 — start it with `npm run dev:server`');
  process.exit(2);
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const log = (tag: string) => (s: string) => process.stdout.write(`   [${tag}] ${s}\n`);
const mainOf = async (pid: string, board = 'esp32c3-devkitm-1') => (await ok('GET', `/projects/${pid}/file/${board === 'arduino-uno' ? 'sketch/sketch.ino' : 'main/main.c'}`)).content as string;
const fixtureHashes = new Set<string>();
const walk = (d: string) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.(c|ino)$/.test(f.name)) fixtureHashes.add(sha(readFileSync(p, 'utf8')));
  }
};
walk(join(ROOT, 'firmware-examples'));

// ---------------------------------------------------------------- run all scenario chains concurrently
type Chain = Record<string, any>;
const chains: Record<string, Promise<Chain>> = {};

chains.A = (async () => {
  const p = await newProject('LLM A: SOS light');
  const a = await agent(p.id, '做一个求救灯，连续快速闪三下，停顿一秒，再连续慢闪两下，然后循环。', undefined, log('A'));
  const mainA = await mainOf(p.id);
  // LLM-05: inject a real compile error from outside the agent, confirm the compiler fails, then ask the agent to repair
  const broken = mainA.replace(/vTaskDelay\(/, 'vTaskDelay_typo(').replace(/;\s*\n/, '\n');
  await ok('PUT', `/projects/${p.id}/file/main/main.c`, { content: broken, message: 'test: inject compile error' });
  const bFail = await ok('POST', `/projects/${p.id}/build`);
  const fix = await agent(p.id, '编译失败了，请根据编译器的真实报错修复代码，保持原来的求救灯功能不变。', undefined, log('A-fix'));
  // Test D: wiring mismatch — move the LED's driving wire to an idle GPIO without touching the code
  const proj = await ok('GET', `/projects/${p.id}`);
  const ledWire = proj.circuit.wires.find((w: any) => (w.from.component_id === 'board' && /^GPIO\d+$/.test(w.from.pin_id)) || (w.to.component_id === 'board' && /^GPIO\d+$/.test(w.to.pin_id)));
  let dRun: RunResult | null = null;
  let mismatch: any = null;
  if (ledWire) {
    const boardEnd = ledWire.from.component_id === 'board' ? ledWire.from : ledWire.to;
    const other = ledWire.from.component_id === 'board' ? ledWire.to : ledWire.from;
    const used = new Set(proj.circuit.wires.flatMap((w: any) => [w.from, w.to]).filter((e: any) => e.component_id === 'board').map((e: any) => e.pin_id));
    const idle = ['GPIO7', 'GPIO6', 'GPIO10', 'GPIO3', 'GPIO1'].find((g) => !used.has(g))!;
    mismatch = { from: boardEnd.pin_id, to: idle, part: `${other.component_id}.${other.pin_id}` };
    await ok('POST', `/projects/${p.id}/circuit/ops`, { ops: [{ op: 'disconnect', wire_id: ledWire.wire_id }, { op: 'connect', from: `board.${idle}`, to: `${other.component_id}.${other.pin_id}` }] });
    dRun = await agent(p.id, '灯现在不按程序闪了。请结合真实的 GPIO 信号和电路数据检查是接线问题还是代码问题，修复后重新验证。', undefined, log('D'));
  }
  return { p, a, mainA, bFail, fix, dRun, mismatch, mainFinal: await mainOf(p.id) };
})();

chains.B = (async () => {
  const p = await newProject('LLM B/C: swap two LEDs with a button');
  const b = await agent(p.id, '给两个灯增加一个按钮。每按一次按钮，交换两个灯的亮灭状态。', undefined, log('B'));
  const circB = (await ok('GET', `/projects/${p.id}`)).circuit;
  const mainB = await mainOf(p.id);
  const c = await agent(p.id, '现在改成按住超过两秒才切换。', undefined, log('C'));
  const circC = (await ok('GET', `/projects/${p.id}`)).circuit;
  const hist = await ok('GET', `/projects/${p.id}/history`);
  return { p, b, c, circB, circC, mainB, mainC: await mainOf(p.id), hist };
})();

chains.E = (async () => {
  const p = await newProject('LLM E: heartbeat');
  const e = await agent(p.id, '做一个心跳灯：每 1.2 秒一个周期，先亮 120 毫秒，灭 150 毫秒，再亮 120 毫秒，然后熄灭直到这个周期结束。用绿色的 LED。', undefined, log('E'));
  return { p, e, circuit: (await ok('GET', `/projects/${p.id}`)).circuit };
})();

chains.CAP = (async () => {
  const p = await newProject('LLM capability boundary');
  const r = await agent(p.id, '用一块 OLED 屏幕实时显示当前室温。', undefined, log('CAP'));
  return { p, r, files: await mainOf(p.id) };
})();

chains.R6 = (async () => {
  const reqs = ['两个 LED 交替闪烁，每个各亮 300 毫秒。', '加一个按钮：按住按钮时两个 LED 都亮，松开时两个都灭。', '两个 LED：第一个每 1 秒闪一次，第二个每 0.4 秒闪一次，互不影响。'];
  const out = await Promise.all(
    reqs.map(async (q, i) => {
      const p = await newProject(`LLM-06 #${i + 1}`);
      const r = await agent(p.id, q, undefined, log(`R6-${i + 1}`));
      return { p, r, q, main: await mainOf(p.id) };
    }),
  );
  return { out };
})();

chains.UNO = (async () => {
  const p = await newProject('LLM Uno blink', 'arduino-uno');
  const r = await agent(p.id, '让一个 LED 每 200 毫秒闪一次（亮 100 毫秒，灭 100 毫秒）。', undefined, log('UNO'));
  return { p, r, main: await mainOf(p.id, 'arduino-uno') };
})();

const settled = Object.fromEntries(await Promise.all(Object.entries(chains).map(async ([k, v]) => [k, await v.then((x) => ({ ok: true, x }), (e) => ({ ok: false, e }))]))) as Record<string, { ok: boolean; x?: any; e?: Error }>;
const get = (k: string) => {
  if (!settled[k].ok) throw settled[k].e;
  return settled[k].x;
};
writeFileSync(R.path('raw-chains.json'), JSON.stringify(Object.fromEntries(Object.entries(settled).map(([k, v]) => [k, v.ok ? { ok: true } : { ok: false, error: String(v.e) }])), null, 2));

// ---------------------------------------------------------------- assertions
await R.run('LLM-01', 'Real DeepSeek API connection, auth, model, structured output and tool calling', async ({ log, evidence, data }) => {
  const h: any = await llmHealthCheck();
  writeFileSync(R.path('llm-01-health.json'), JSON.stringify(h, null, 2));
  evidence(R.path('llm-01-health.json'));
  log(`base ${h.baseUrl}, model ${h.model} (${h.modelName}), thinking ${h.thinking}, effort ${h.reasoningEffort}, key ${h.keyConfigured}`);
  log(`structured planning: ${h.structured?.ok} ${JSON.stringify(h.structured?.parsed)}; tool call: ${h.toolCalling?.ok} first=${JSON.stringify(h.toolCalling?.firstCall)}`);
  data(h);
  return !!h.ok;
});

const runEvidence = (pid: string, r: RunResult, evidence: (p: string) => void) => {
  const d = join(ROOT, 'workspaces/projects', pid, 'runs', r.runId);
  evidence(join(d, 'events.jsonl'));
  evidence(join(d, 'run.json'));
};

await R.run('LLM-02', 'Dynamic planning for a non-template requirement (Test A: SOS light)', async ({ log, evidence }) => {
  const { p, a } = get('A');
  describeRun(a).forEach(log);
  runEvidence(p.id, a, evidence);
  const plan = a.events.find((e: any) => e.kind === 'plan')?.plan;
  const plannerCalls = a.events.filter((e: any) => e.kind === 'llm-call' && e.call.role === 'planner' && e.call.status === 'ok');
  log(`planner DeepSeek calls: ${plannerCalls.length} (model ${plannerCalls[0]?.call.model}); firmware plan: ${plan?.firmware_plan?.slice(0, 400)}`);
  return !!plan && plannerCalls.length > 0 && plannerCalls.every((c: any) => c.call.model === 'deepseek-flash') && !!plan.verification && a.summary.status === 'success';
});

await R.run('LLM-03', 'Firmware source comes from the model response and is written to the real project', async ({ log, evidence }) => {
  const { p, a, mainA } = get('A');
  const llm = llmRecords(p.id, a.runId);
  const writes = llm.flatMap((r) => (r.response.tool_calls ?? []).filter((t: any) => t.function.name === 'write_firmware').map((t: any) => JSON.parse(t.function.arguments)));
  const lastMain = writes.filter((w) => w.path === 'main/main.c').pop();
  const same = lastMain?.content === mainA;
  log(`write_firmware calls inside DeepSeek responses: ${writes.length}; final main/main.c (${mainA.length} B, sha256 ${sha(mainA).slice(0, 12)}) identical to the model's tool-call argument: ${same}`);
  log(`main.c matches a hand-written fixture/example: ${fixtureHashes.has(sha(mainA))}`);
  const builds = a.events.filter((e: any) => e.kind === 'build');
  const okBuild = builds.find((b: any) => b.build.status === 'success')?.build;
  log(`compiled by: ${okBuild?.toolVersions.map((v: any) => `${v.name} ${v.version}`).slice(0, 2).join('; ')}; ELF sha256 ${okBuild?.artifacts.find((x: any) => x.kind === 'elf')?.sha256.slice(0, 16)}`);
  evidence(join(ROOT, 'workspaces/projects', p.id, 'runs', a.runId, 'llm'));
  return same && !fixtureHashes.has(sha(mainA)) && !!okBuild;
});

await R.run('LLM-04', 'Tool-calling chain: model requests tools, gets real results, decides next step', async ({ log, evidence }) => {
  const { p, a } = get('A');
  const tools = toolRecords(p.id, a.runId);
  const llm = llmRecords(p.id, a.runId);
  const decidedAfterTool = llm.filter((r) => r.request.lastMessages.some((m: any) => m.role === 'tool'));
  log(`${tools.length} tool executions (${tools.filter((t) => t.role !== 'executor').length} requested by the model, ${tools.filter((t) => t.role === 'executor').length} by the deterministic executor)`);
  for (const t of tools.slice(0, 30)) log(`  ${t.role}:${t.name} ${t.ok ? 'ok' : 'ERR'} → ${String(t.result).replace(/\s+/g, ' ').slice(0, 140)}`);
  log(`model calls whose input contained real tool results: ${decidedAfterTool.length}/${llm.length}`);
  writeFileSync(R.path('llm-04-tool-chain.json'), JSON.stringify(tools.map((t) => ({ role: t.role, name: t.name, args: t.args, ok: t.ok, result: String(t.result).slice(0, 2000) })), null, 2));
  evidence(R.path('llm-04-tool-chain.json'));
  return tools.length >= 4 && decidedAfterTool.length >= 2 && tools.some((t) => t.name === 'build_firmware') && tools.some((t) => t.name === 'verify_behavior');
});

await R.run('LLM-05 / T7', 'Real compile error → DeepSeek reads diagnostics → fixes → rebuild → re-verify', async ({ log, evidence }) => {
  const { p, bFail, fix } = get('A');
  log(`injected error build: ${bFail.status}; diagnostics: ${bFail.diagnostics.filter((d: any) => d.severity === 'error').slice(0, 3).map((d: any) => `${d.file}:${d.line} ${d.message}`).join(' | ')}`);
  describeRun(fix).forEach(log);
  runEvidence(p.id, fix, evidence);
  evidence(join(ROOT, 'workspaces/projects', p.id, 'builds', bFail.buildId, 'build.log'));
  const plan = fix.events.find((e: any) => e.kind === 'plan')?.plan;
  const diagTokens = bFail.diagnostics.filter((d: any) => d.severity === 'error').flatMap((d: any) => [`:${d.line}`, ...(d.message.match(/'([A-Za-z_]\w+)'/g) ?? []).map((x: string) => x.slice(1, -1))]);
  const planText = JSON.stringify(plan ?? {});
  const plannerSawError = diagTokens.some((t: string) => planText.includes(t)) || planText.includes('vTaskDelay_typo');
  log(`plan cites real diagnostics: ${plan?.understanding?.slice(0, 260)}`);
  const wrote = fix.events.some((e: any) => e.kind === 'file-change');
  const builds = fix.events.filter((e: any) => e.kind === 'build').map((e: any) => e.build.status);
  const ver = finalVerification(fix);
  log(`agent saw diagnostics: ${plannerSawError}; wrote code: ${wrote}; builds: ${builds.join('→')}; final verification ${ver?.passed}`);
  return bFail.status === 'failed' && plannerSawError && wrote && builds.includes('success') && fix.summary.status === 'success' && !!ver?.passed;
});

await R.run('TEST-B', 'Conditional interaction: button press swaps two LEDs (edge detection + state)', async ({ log, evidence }) => {
  const { p, b } = get('B');
  describeRun(b).forEach(log);
  runEvidence(p.id, b, evidence);
  const plan = b.events.find((e: any) => e.kind === 'plan')?.plan;
  return b.summary.status === 'success' && (plan?.verification?.stimuli?.length ?? 0) >= 2;
});

await R.run('TEST-C', 'Incremental iteration on the same project: "hold > 2 s to switch"', async ({ log, evidence }) => {
  const { p, c, circB, circC, mainB, mainC, hist } = get('B');
  describeRun(c).forEach(log);
  runEvidence(p.id, c, evidence);
  const idsB = circB.components.map((x: any) => x.component_id).sort().join(',');
  const idsC = circC.components.map((x: any) => x.component_id).sort().join(',');
  const plan = c.events.find((e: any) => e.kind === 'plan')?.plan;
  const holds = (plan?.verification?.stimuli ?? []).reduce((acc: number[], s: any, i: number, arr: any[]) => {
    if (s.action === 'press') {
      const rel = arr.slice(i + 1).find((x: any) => x.action === 'release' && x.component === s.component);
      if (rel) acc.push(rel.at_ms - s.at_ms);
    }
    return acc;
  }, []);
  log(`same project ${p.id}; components before [${idsB}] after [${idsC}]; change_type=${plan?.change_type}; firmware changed: ${mainB !== mainC}`);
  log(`press durations in verification: ${holds.join(', ')} ms (needs ≥ one > 2000 ms and one < 2000 ms to prove the threshold)`);
  log(`history commits: ${hist.length} (latest: ${hist.slice(0, 3).map((h: any) => h.message).join(' | ')})`);
  return c.summary.status === 'success' && idsB === idsC && mainB !== mainC && plan?.change_type !== 'new' && holds.some((h: number) => h > 2000);
});

await R.run('TEST-D', 'Fault analysis: firmware pin ≠ circuit wiring → agent uses GPIO/circuit evidence → fix → re-verify', async ({ log, evidence }) => {
  const { p, dRun, mismatch } = get('A');
  if (!dRun) return false;
  log(`injected wiring fault: ${mismatch.part} moved from board.${mismatch.from} (driven by firmware) to idle board.${mismatch.to}`);
  describeRun(dRun).forEach(log);
  runEvidence(p.id, dRun, evidence);
  const rp = dRun.events.filter((e: any) => e.kind === 'tool-end' && e.record.name === 'repair_project');
  const diagnosis = toolRecords(p.id, dRun.runId).find((t) => t.name === 'repair_project')?.args;
  const plan = dRun.events.find((e: any) => e.kind === 'plan')?.plan;
  log(`planner understanding: ${plan?.understanding?.slice(0, 300)}`);
  if (diagnosis) log(`debugger diagnosis: ${diagnosis.root_cause} — ${String(diagnosis.explanation).slice(0, 400)}`);
  const mentions = JSON.stringify(plan ?? {}).includes(mismatch.from) || JSON.stringify(diagnosis ?? {}).includes(mismatch.from);
  log(`diagnosis references the real pins (${mismatch.from}/${mismatch.to}): ${mentions}; repair rounds ${dRun.summary.repairRounds}; repair_project calls ${rp.length}`);
  return dRun.summary.status === 'success' && !!finalVerification(dRun)?.passed && mentions;
});

await R.run('TEST-E', 'New, unscripted task (heartbeat pattern, green LED)', async ({ log, evidence }) => {
  const { p, e, circuit } = get('E');
  describeRun(e).forEach(log);
  runEvidence(p.id, e, evidence);
  const green = circuit.components.some((c: any) => c.type === 'led' && c.props.color === 'green');
  log(`green LED in circuit: ${green}`);
  return e.summary.status === 'success' && green;
});

await R.run('TEST-CAP', 'Capability boundary: unsupported peripheral (OLED) is reported honestly, nothing is faked', async ({ log, evidence }) => {
  const { p, r, files } = get('CAP');
  describeRun(r).forEach(log);
  runEvidence(p.id, r, evidence);
  const plan = r.events.find((e: any) => e.kind === 'plan')?.plan;
  const builds = r.events.filter((e: any) => e.kind === 'build').length;
  log(`feasible=${plan?.feasible}; gaps: ${plan?.capability_gaps?.join('; ')}`);
  log(`final: ${r.summary.summary?.slice(0, 400)}`);
  return r.summary.status === 'failed' && plan?.feasible === false && builds === 0 && files.includes('empty project');
});

await R.run('LLM-06', 'Anti-rule test: 3 different requests on the same hardware → different plans, code and behaviour', async ({ log, evidence, data }) => {
  const { out } = get('R6');
  const rows = out.map((o: any) => {
    const plan = o.r.events.find((e: any) => e.kind === 'plan')?.plan;
    return { q: o.q, status: o.r.summary.status, codeSha: sha(o.main).slice(0, 12), checks: plan?.verification?.checks.map((c: any) => `${c.type}:${c.component ?? c.components?.join('+') ?? ''}${c.period_ms ? `@${c.period_ms}` : ''}`).join(', '), pins: plan?.pin_plan.map((x: any) => x.board_pin).join(',') };
  });
  for (const r of rows) log(`"${r.q}" → ${r.status}; code ${r.codeSha}; pins ${r.pins}; checks ${r.checks}`);
  out.forEach((o: any) => runEvidence(o.p.id, o.r, evidence));
  data(rows);
  return rows.every((r: any) => r.status === 'success') && new Set(rows.map((r: any) => r.codeSha)).size === 3 && new Set(rows.map((r: any) => r.checks)).size === 3;
});

await R.run('LLM-UNO', 'Same agent on the Arduino Uno backend (arduino-cli + avr8js)', async ({ log, evidence }) => {
  const { p, r, main } = get('UNO');
  describeRun(r).forEach(log);
  runEvidence(p.id, r, evidence);
  log(`sketch uses digitalWrite: ${/digitalWrite/.test(main)}; flash method: ${r.events.filter((e: any) => e.kind === 'flash').map((e: any) => e.flash.method).join(',')}`);
  return r.summary.status === 'success' && r.events.some((e: any) => e.kind === 'flash' && e.flash.method === 'direct-image-load');
});

await R.run('LLM-07', 'AI service failure: invalid key / unreachable API / missing key → explicit failure, no template fallback', async ({ log }) => {
  const { ProjectStore } = await import('../../apps/server/src/projects.ts');
  const { Runtime } = await import('../../apps/server/src/runtime.ts');
  const store = new ProjectStore();
  const rt = new Runtime(store, () => {});
  const results: boolean[] = [];
  for (const [label, cfgPatch] of [
    ['invalid API key', { apiKey: 'sk-invalid-key-for-test', maxRetries: 0 }],
    ['unreachable API (network down)', { baseUrl: 'http://127.0.0.1:9', maxRetries: 1, timeoutMs: 3000 }],
  ] as const) {
    const meta = store.create({ name: `LLM-07 ${label}`, board: 'esp32c3-devkitm-1' });
    const before = store.readFile(meta.id, 'main/main.c');
    const llm = new DeepSeekClient({ ...loadLlmConfig(), ...cfgPatch });
    const run = new AgentRun(rt, llm, rt, meta.id, 'esp32c3-devkitm-1', '让 LED 每秒闪一次。');
    rt.bindRun(run.runId, meta.id);
    const s = await run.execute();
    const after = store.readFile(meta.id, 'main/main.c');
    const builds = rt.listBuilds(meta.id).length;
    const good = s.status === 'failed' && /AI service unavailable/.test(s.summary ?? '') && before === after && builds === 0;
    log(`${label}: status=${s.status}; "${(s.summary ?? '').split('\n')[0].slice(0, 160)}"; firmware unchanged=${before === after}; builds=${builds}`);
    results.push(good);
  }
  try {
    loadLlmConfig({} as NodeJS.ProcessEnv);
    results.push(false);
  } catch (e) {
    log(`missing key: ${(e as Error).message}`);
    results.push(/not configured/.test((e as Error).message));
  }
  return results.every(Boolean);
});

const failed = R.finish('PlugAI DeepSeek agent acceptance (real model, real tools)', `Model: ${process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'} via ${process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'} (thinking enabled, reasoning effort ${process.env.DEEPSEEK_REASONING_EFFORT ?? 'high'}). API key is never written to reports.`);
process.exit(failed ? 1 : 0);
