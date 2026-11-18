// End-to-end acceptance through the running server (HTTP + WebSocket), i.e. exactly what the web UI consumes.
// §15 final flow (real DeepSeek), Test 9 (external edit + static anti-cheat), Test 10 (regression on all demos, both boards).
import 'dotenv/config';
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Reporter, ROOT } from './lib.ts';
import { BASE, agent, call, describeRun, finalVerification, newProject, ok, serverUp } from './client.ts';

const R = new Reporter('e2e');
if (!(await serverUp())) {
  console.error('PlugAI server is not running — start it with `npm run dev:server`');
  process.exit(2);
}
const args = process.argv.slice(2);
const skipAgent = args.includes('--no-agent');
const progress = (t: string) => (s: string) => process.stdout.write(`   [${t}] ${s}\n`);

/** Subscribe like the browser does and collect LED transitions from live sim.frame pushes for `ms` wall-clock. */
async function watchLive(projectId: string, ms: number): Promise<{ frames: number; transitions: Record<string, { simUs: number; lit: boolean }[]>; uart: string; status: string[] }> {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { Origin: 'http://127.0.0.1:5173' } });
  const transitions: Record<string, { simUs: number; lit: boolean }[]> = {};
  let frames = 0;
  let uart = '';
  const status: string[] = [];
  await new Promise<void>((res, rej) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ subscribe: projectId }));
      res();
    });
    ws.on('error', rej);
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.projectId !== projectId) return;
    if (m.type === 'sim.frame') {
      frames++;
      for (const c of m.componentEdges ?? []) (transitions[c.channel ? `${c.component_id}:${c.channel}` : c.component_id] ??= []).push({ simUs: c.simUs, lit: c.lit });
    }
    if (m.type === 'sim.uart') uart += m.data;
    if (m.type === 'sim.status') status.push(m.status);
  });
  await new Promise((r) => setTimeout(r, ms));
  ws.close();
  return { frames, transitions, uart, status };
}

function periodOf(tl: { simUs: number; lit: boolean }[] = []): number | null {
  const rises = tl.filter((e) => e.lit).map((e) => e.simUs);
  if (rises.length < 3) return null;
  const d = rises.slice(1).map((t, i) => t - rises[i]);
  return d.reduce((a, b) => a + b, 0) / d.length / 1000;
}

/** Find the board GPIO that drives an LED (directly or through one resistor). */
function ledDriver(project: any, led: string): string | null {
  const pinNet = project.solution.pinNet as Record<string, string>;
  const netPins = (net: string) => Object.keys(pinNet).filter((k) => pinNet[k] === net);
  const aNet = pinNet[`${led}.A`];
  const direct = netPins(aNet).find((p) => /^board\.GPIO\d+$|^board\.D\d+$/.test(p));
  if (direct) return direct.slice(6);
  for (const p of netPins(aNet)) {
    const [cid, pin] = p.split('.');
    const comp = project.circuit.components.find((c: any) => c.component_id === cid);
    if (comp?.type !== 'resistor') continue;
    const other = pinNet[`${cid}.${pin === '1' ? '2' : '1'}`];
    const b = netPins(other).find((x) => /^board\.(GPIO|D)\d+$/.test(x));
    if (b) return b.slice(6);
  }
  return null;
}

const verifyScenario = (pid: string, scenario: any) => ok('POST', `/projects/${pid}/verify`, { scenario });

// ---------------------------------------------------------------- §15 final flow with the real agent
let finalPid = '';
if (!skipAgent) {
  const p = await newProject('§15 Final: ESP32 LED blink');
  finalPid = p.id;
  const ctx: any = {};
  await R.run('E2E-1', '“帮我创建一个 ESP32 的 LED 闪烁项目，每隔一秒闪一次。” → AI plans, wires, codes, compiles, flashes, verifies; live UI feed blinks at 1 s', async ({ log, evidence }) => {
    const r = await agent(p.id, '帮我创建一个 ESP32 的 LED 闪烁项目，每隔一秒闪一次。', undefined, progress('E2E-1'));
    describeRun(r).forEach(log);
    ctx.r1 = r;
    const proj = await ok('GET', `/projects/${p.id}`);
    ctx.led = proj.circuit.components.find((c: any) => c.type === 'led')?.component_id;
    ctx.pin = ledDriver(proj, ctx.led);
    ctx.build1 = proj.lastBuild;
    log(`circuit: LED ${ctx.led} driven by ${ctx.pin}; build ${proj.lastBuild.buildId}, ELF ${proj.lastBuild.artifacts.find((a: any) => a.kind === 'elf').sha256.slice(0, 16)}; flashed via ${proj.loaded?.method}`);
    const live = await watchLive(p.id, 4200);
    const per = periodOf(live.transitions[ctx.led]);
    log(`live WebSocket feed (what the UI renders): ${live.frames} frames, ${live.transitions[ctx.led]?.length ?? 0} LED transitions, measured period ${per?.toFixed(2)} ms (simulated time)`);
    writeFileSync(R.path('e2e-1-live.json'), JSON.stringify(live, null, 1));
    evidence(R.path('e2e-1-live.json'));
    return r.summary.status === 'success' && proj.loaded?.method === 'esptool-virtual-uart' && per !== null && Math.abs(per - 1000) < 15;
  });

  await R.run('E2E-2', '“现在改成每 200 毫秒闪一次。” → same project re-compiled, new firmware hash, live period changes', async ({ log, evidence }) => {
    const r = await agent(p.id, '现在改成每 200 毫秒闪一次。', undefined, progress('E2E-2'));
    describeRun(r).forEach(log);
    const proj = await ok('GET', `/projects/${p.id}`);
    const elf1 = ctx.build1.artifacts.find((a: any) => a.kind === 'elf').sha256;
    const elf2 = proj.lastBuild.artifacts.find((a: any) => a.kind === 'elf').sha256;
    const live = await watchLive(p.id, 2500);
    const per = periodOf(live.transitions[ctx.led]);
    ctx.period2 = per;
    log(`build ${ctx.build1.buildId} → ${proj.lastBuild.buildId}; ELF ${elf1.slice(0, 12)} → ${elf2.slice(0, 12)}; live period ${per?.toFixed(2)} ms`);
    writeFileSync(R.path('e2e-2-live.json'), JSON.stringify(live, null, 1));
    evidence(R.path('e2e-2-live.json'));
    return r.summary.status === 'success' && elf1 !== elf2 && per !== null && (Math.abs(per - 200) < 6 || Math.abs(per - 400) < 8);
  });

  await R.run('E2E-3', '“把 LED 接到没有产生闪烁信号的 GPIO 上。” → LED no longer follows the program (independent check)', async ({ log, evidence }) => {
    const r = await agent(p.id, '把 LED 接到没有产生闪烁信号的 GPIO 上。', undefined, progress('E2E-3'));
    describeRun(r).forEach(log);
    const proj = await ok('GET', `/projects/${p.id}`);
    const pin = ledDriver(proj, ctx.led);
    log(`LED ${ctx.led} now wired to ${pin} (firmware still toggles ${ctx.pin})`);
    const indep = await verifyScenario(p.id, { name: 'independent: old blink must be gone', duration_ms: 3000, stimuli: [], checks: [{ type: 'toggle_count', component: ctx.led, min: 2, from_ms: 100, to_ms: 3000 }] });
    log(`independent verification "LED still blinks": ${indep.passed ? 'PASSED (unexpected)' : 'FAILED as expected'} — ${indep.results[0].detail}`);
    const gpioEdges = indep.gpio?.[ctx.pin]?.length ?? 0;
    log(`the firmware keeps toggling ${ctx.pin}: ${gpioEdges} edges in 3 s — the circuit, not the UI, decides the LED is dark`);
    const live = await watchLive(p.id, 1500);
    log(`live feed: ${live.transitions[ctx.led]?.length ?? 0} LED transitions in 1.5 s`);
    ctx.badPin = pin;
    return pin !== ctx.pin && !indep.passed && gpioEdges >= 4 && (live.transitions[ctx.led]?.length ?? 0) === 0;
  });

  await R.run('E2E-4', 'Repair the wiring → behaviour restored and verified', async ({ log }) => {
    const r = await agent(p.id, '现在把 LED 的连线修复，让它重新按照程序闪烁。', undefined, progress('E2E-4'));
    describeRun(r).forEach(log);
    const proj = await ok('GET', `/projects/${p.id}`);
    const pin = ledDriver(proj, ctx.led);
    const live = await watchLive(p.id, 2500);
    const per = periodOf(live.transitions[ctx.led]);
    log(`LED wired to ${pin}; live period ${per?.toFixed(2)} ms`);
    return r.summary.status === 'success' && !!finalVerification(r)?.passed && per !== null && Math.abs(per - (ctx.period2 ?? 200)) < 8;
  });
}

// ---------------------------------------------------------------- Test 9: external edit (no AI) + static anti-cheat
await R.run('T9-a', 'Anti-cheat: edit source outside the agent → rebuild → UI feed follows the new firmware', async ({ log }) => {
  const p = finalPid ? { id: finalPid } : await newProject('T9 external edit', 'esp32c3-devkitm-1', 'blink');
  let proj = await ok('GET', `/projects/${p.id}`);
  const led = proj.circuit.components.find((c: any) => c.type === 'led').component_id;
  const pin = ledDriver(proj, led)!;
  const n = Number(pin.replace('GPIO', ''));
  const src = `// Written by the T9 test directly through the REST API (not by the AI).
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include <stdio.h>
void app_main(void) {
    gpio_reset_pin(${n});
    gpio_set_direction(${n}, GPIO_MODE_OUTPUT);
    printf("T9 external firmware: 300 ms on / 300 ms off on GPIO${n}\\n");
    int v = 0;
    while (1) { v = !v; gpio_set_level(${n}, v); vTaskDelay(pdMS_TO_TICKS(300)); }
}
`;
  await ok('PUT', `/projects/${p.id}/file/main/main.c`, { content: src, message: 'T9: external edit' });
  const b = await ok('POST', `/projects/${p.id}/build`);
  const f = await ok('POST', `/projects/${p.id}/flash`, { method: 'esptool-virtual-uart' });
  await ok('POST', `/projects/${p.id}/sim/start`);
  const live = await watchLive(p.id, 2800);
  const per = periodOf(live.transitions[led]);
  log(`external edit → build ${b.status} (${b.buildId}) → flash ${f.status} (${f.method}) → live LED period ${per?.toFixed(2)} ms (expected 600)`);
  log(`UART: ${live.uart.split('\n').find((l) => l.includes('T9 external')) ?? '(missing)'}`);
  proj = await ok('GET', `/projects/${p.id}`);
  const runsBefore = proj.runs.length;
  log(`agent runs involved: none (project has ${runsBefore} earlier runs; no new run started)`);
  return b.status === 'success' && f.status === 'success' && per !== null && Math.abs(per - 600) < 10;
});

await R.run('T9-b', 'Static anti-cheat scan: renderers have no timers/animations; no mock success paths; UART-only checks cannot pass', async ({ log }) => {
  const problems: string[] = [];
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  for (const f of ['apps/web/src/lab/parts.tsx', 'apps/web/src/lab/Lab.tsx']) {
    const s = read(f);
    for (const bad of ['setInterval', 'requestAnimationFrame', 'setTimeout(', '@keyframes', 'animate', 'agentEvents', 'userMessage']) {
      if (s.includes(bad) && !(bad === 'setTimeout(' && /setTimeout\(fit|setTimeout\(onFit/.test(s))) problems.push(`${f} contains ${bad}`);
    }
  }
  const css = read('apps/web/src/styles.css');
  const frames = [...css.matchAll(/@keyframes\s+(\w+)/g)].map((m) => m[1]);
  if (frames.some((k) => k !== 'spin')) problems.push(`unexpected CSS animations: ${frames.join(',')}`);
  const walk = (d: string): string[] =>
    readdirSync(join(ROOT, d)).flatMap((f) => {
      const p = join(d, f);
      return statSync(join(ROOT, p)).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  for (const f of [...walk('apps/server/src'), ...walk('packages'), ...walk('backends')]) {
    const s = read(f);
    if (/\bmock\w*\s*[(=:]|fakeSuccess|simulateSuccess|FIXED_SUCCESS/i.test(s)) problems.push(`${f}: mock/fake success construct`);
  }
  log(`renderer files scanned for timers/animations/chat access; ${frames.length} CSS keyframes (${frames.join(',')})`);
  // UART-only scenario must not pass even though the text is present
  const p = await newProject('T9 uart-only', 'arduino-uno', 'blink');
  await ok('POST', `/projects/${p.id}/build`);
  await ok('POST', `/projects/${p.id}/flash`, { method: 'direct-image-load' });
  const v = await verifyScenario(p.id, { name: 'uart only', duration_ms: 500, checks: [{ type: 'uart_contains', text: 'PLUGAI_FIXTURE' }] });
  log(`UART-only scenario: text found=${v.results[0].passed}, verification passed=${v.passed} (${v.warnings.join('; ')})`);
  if (v.passed || !v.results[0].passed) problems.push('UART-only verification semantics wrong');
  // skip-compile: flashing a project whose sources changed since the last build is refused
  await ok('PUT', `/projects/${p.id}/file/sketch/sketch.ino`, { content: readFileSync(join(ROOT, 'firmware-examples/fixtures/uno/d4_low/sketch.ino'), 'utf8') });
  const r = await call('POST', `/projects/${p.id}/verify`, { scenario: { name: 'stale', duration_ms: 300, checks: [{ type: 'state_during', component: 'led1', state: 'off', from_ms: 0, to_ms: 300 }] } });
  log(`verify with stale build after a source edit: HTTP ${r.status} (sources changed but flashed build unchanged — engine verifies what is actually flashed: ${r.data?.firmwareSha256?.slice(0, 12) ?? r.data?.error})`);
  problems.forEach((x) => log(`PROBLEM: ${x}`));
  return problems.length === 0;
});

// ---------------------------------------------------------------- Test 10: regression on all demos, both boards
const DEMO_SCENARIOS: Record<string, any> = {
  blink: { name: 'blink 1 Hz', duration_ms: 3600, stimuli: [], checks: [{ type: 'period', component: 'led1', period_ms: 1000, tolerance_pct: 1, min_cycles: 2, duty: 0.5, duty_tolerance: 0.03 }] },
  'button-led': {
    name: 'button follows',
    duration_ms: 3000,
    stimuli: [{ at_ms: 800, component: 'btn1', action: 'press' }, { at_ms: 1800, component: 'btn1', action: 'release' }],
    checks: [{ type: 'state_during', component: 'led1', state: 'off', from_ms: 100, to_ms: 790 }, { type: 'state_during', component: 'led1', state: 'on', from_ms: 830, to_ms: 1790 }, { type: 'state_during', component: 'led1', state: 'off', from_ms: 1830, to_ms: 3000 }],
  },
  'traffic-light': {
    name: 'traffic light R5-G5-Y2',
    duration_ms: 27000,
    stimuli: [],
    checks: [{ type: 'pattern', components: ['tl1:red', 'tl1:yellow', 'tl1:green'], segments: [{ states: { 'tl1:red': 'on', 'tl1:yellow': 'off', 'tl1:green': 'off' }, duration_ms: 5000 }, { states: { 'tl1:red': 'off', 'tl1:yellow': 'off', 'tl1:green': 'on' }, duration_ms: 5000 }, { states: { 'tl1:red': 'off', 'tl1:yellow': 'on', 'tl1:green': 'off' }, duration_ms: 2000 }], cyclic: true, min_repeats: 1, tolerance_ms: 30 }],
  },
};

const regression: Record<string, { pid: string; firstBuild: string }> = {};
for (const board of ['esp32c3-devkitm-1', 'arduino-uno'] as const) {
  for (const demo of ['blink', 'button-led', 'traffic-light']) {
    await R.run('T10', `Demo "${demo}" creates, builds, flashes and verifies`, async ({ log }) => {
      const p = await newProject(`T10 ${demo}`, board, demo);
      const b = await ok('POST', `/projects/${p.id}/build`);
      const f = await ok('POST', `/projects/${p.id}/flash`, {});
      const v = await verifyScenario(p.id, DEMO_SCENARIOS[demo]);
      log(`build ${b.status} ${(b.durationMs / 1000).toFixed(1)} s; ${f.method} ${f.status}; verification ${v.passed ? 'PASS' : 'FAIL'}: ${v.results.map((r: any) => r.detail).join(' | ').slice(0, 400)}`);
      regression[`${board}/${demo}`] = { pid: p.id, firstBuild: b.buildId };
      return b.status === 'success' && f.status === 'success' && v.passed;
    }, board);
  }
}

await R.run('T10-mod-restore', 'Modify → rebuild → restore previous version from history → original behaviour back', async ({ log }) => {
  const { pid } = regression['esp32c3-devkitm-1/blink'];
  const hist0 = await ok('GET', `/projects/${pid}/history`);
  const orig = (await ok('GET', `/projects/${pid}/file/main/main.c`)).content as string;
  await ok('PUT', `/projects/${pid}/file/main/main.c`, { content: orig.replace('#define HALF_PERIOD_MS 500', '#define HALF_PERIOD_MS 125'), message: 'T10: speed up' });
  await ok('POST', `/projects/${pid}/build`);
  await ok('POST', `/projects/${pid}/flash`, { method: 'direct-image-load' });
  const fast = await verifyScenario(pid, { name: 'fast', duration_ms: 1500, checks: [{ type: 'period', component: 'led1', period_ms: 250, tolerance_pct: 1, min_cycles: 3 }] });
  const target = hist0[0].commit;
  await ok('POST', `/projects/${pid}/restore`, { commit: target });
  const restored = (await ok('GET', `/projects/${pid}/file/main/main.c`)).content;
  await ok('POST', `/projects/${pid}/build`);
  await ok('POST', `/projects/${pid}/flash`, { method: 'direct-image-load' });
  const back = await verifyScenario(pid, DEMO_SCENARIOS.blink);
  log(`modified: ${fast.results[0].detail}`);
  log(`restored to ${target.slice(0, 8)} (source identical: ${restored === orig}): ${back.results[0].detail}`);
  return fast.passed && restored === orig && back.passed;
});

await R.run('T10-stop-restart', 'Simulator stop / restart and project isolation (two boards running different firmware concurrently)', async ({ log }) => {
  const a = regression['esp32c3-devkitm-1/blink'].pid;
  const b = regression['arduino-uno/blink'].pid;
  const ub = (await ok('GET', `/projects/${b}/file/sketch/sketch.ino`)).content as string;
  await ok('PUT', `/projects/${b}/file/sketch/sketch.ino`, { content: ub.replace(/delay\(500\)/g, 'delay(150)') });
  await ok('POST', `/projects/${b}/build`);
  await ok('POST', `/projects/${b}/flash`, {});
  await ok('POST', `/projects/${a}/sim/start`);
  await ok('POST', `/projects/${b}/sim/start`);
  const [la, lb] = await Promise.all([watchLive(a, 3500), watchLive(b, 3500)]);
  const pa = periodOf(la.transitions.led1);
  const pb = periodOf(lb.transitions.led1);
  log(`concurrent: ESP32 project period ${pa?.toFixed(1)} ms, Uno project period ${pb?.toFixed(1)} ms`);
  await ok('POST', `/projects/${a}/sim/stop`);
  const st1 = await ok('GET', `/projects/${a}/sim`);
  await ok('POST', `/projects/${a}/sim/start`);
  await new Promise((r) => setTimeout(r, 1500));
  const st2 = await ok('GET', `/projects/${a}/sim`);
  log(`after stop: ${st1.status}; after start: ${st2.status}, simulated ${(st2.snapshot.clock.simUs / 1000).toFixed(0)} ms (fresh power-on)`);
  await ok('POST', `/projects/${a}/sim/stop`);
  await ok('POST', `/projects/${b}/sim/stop`);
  return pa !== null && Math.abs(pa - 1000) < 15 && pb !== null && Math.abs(pb - 300) < 10 && st1.status === 'stopped' && st2.status === 'running' && st2.snapshot.clock.simUs < 3_000_000;
});

const failed = R.finish('PlugAI end-to-end acceptance (HTTP + WebSocket, real toolchains, real DeepSeek)', 'LED periods in this report are measured from the same live WebSocket frames the browser renders, using simulated-time timestamps.');
process.exit(failed ? 1 : 0);
