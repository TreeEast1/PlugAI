// P0 acceptance: proves real cross-compiled firmware drives the virtual circuit through real MCU emulation.
// Tests 1-6 on ESP32-C3 (esp-emu WASM) and Arduino Uno (avr8js), Test 8 (virtual UART flashing) on ESP32-C3.
import 'dotenv/config';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEsp32, ensureEspScaffold, flashEsp32Virtual, deviceFlashPath } from '@plugai/backend-esp32';
import { buildAvr, avrDirectLoad } from '@plugai/backend-avr';
import { applyOps, createCircuit } from '@plugai/circuit';
import { VirtualHardware, evaluateCheck } from '@plugai/simulator';
import type { BoardId, BuildRecord, Circuit, CheckInput as Check } from '@plugai/shared';
import { Reporter, ROOT } from './lib.ts';

const R = new Reporter('p0');
const only = process.argv.slice(2);
const boards: BoardId[] = only.includes('--esp-only') ? ['esp32c3-devkitm-1'] : only.includes('--avr-only') ? ['arduino-uno'] : ['esp32c3-devkitm-1', 'arduino-uno'];

const B = {
  'esp32c3-devkitm-1': { short: 'esp32c3', out: 'GPIO4', btn: 'GPIO5', alt: 'GPIO6', gnd: 'J3_GND4', fixtures: { A: 'gpio4_high', B: 'gpio4_low', C: 'gpio4_blink_1000', C200: 'gpio4_blink_200', BTN: 'button_led', ERR: 'compile_error' } },
  'arduino-uno': { short: 'uno', out: 'D4', btn: 'D5', alt: 'D6', gnd: 'GND1', fixtures: { A: 'd4_high', B: 'd4_low', C: 'd4_blink_1000', C200: 'd4_blink_200', BTN: 'button_led', ERR: 'compile_error' } },
} as const;

const projDir = (b: BoardId) => join(ROOT, 'workspaces', 'tests', `p0-${B[b].short}`);
for (const b of boards) {
  rmSync(projDir(b), { recursive: true, force: true });
  mkdirSync(projDir(b), { recursive: true });
  if (b === 'esp32c3-devkitm-1') ensureEspScaffold(projDir(b));
}

const builds = new Map<string, BuildRecord>();
let buildSeq = 0;
async function build(board: BoardId, fixture: string): Promise<BuildRecord> {
  const key = `${board}/${fixture}`;
  if (builds.has(key)) return builds.get(key)!;
  const dir = projDir(board);
  const src = join(ROOT, 'firmware-examples', 'fixtures', B[board].short, fixture);
  const buildId = `b${++buildSeq}_${fixture}`;
  let rec: BuildRecord;
  if (board === 'esp32c3-devkitm-1') {
    cpSync(join(src, 'main.c'), join(dir, 'firmware', 'main', 'main.c'));
    rec = await buildEsp32({ projectId: 'p0', projectDir: dir, buildId });
  } else {
    mkdirSync(join(dir, 'firmware', 'sketch'), { recursive: true });
    cpSync(join(src, 'sketch.ino'), join(dir, 'firmware', 'sketch', 'sketch.ino'));
    rec = await buildAvr({ projectId: 'p0', projectDir: dir, buildId });
  }
  builds.set(key, rec);
  return rec;
}

function imageOf(board: BoardId, rec: BuildRecord): { image: Uint8Array; sha: string; path: string } {
  const dir = projDir(board);
  if (board === 'esp32c3-devkitm-1') {
    const m = rec.artifacts.find((a) => a.kind === 'merged-bin')!;
    return { image: new Uint8Array(readFileSync(join(dir, m.path))), sha: m.sha256, path: m.path };
  }
  const { image } = avrDirectLoad('p0', dir, rec);
  const h = rec.artifacts.find((a) => a.kind === 'hex')!;
  return { image, sha: h.sha256, path: h.path };
}

type Variant = 'connected' | 'disconnected' | 'alt-gpio' | 'reversed';
function ledCircuit(board: BoardId, variant: Variant = 'connected', withButton = false, buttonWired = true): Circuit {
  const b = B[board];
  const ops: Parameters<typeof applyOps>[1] = [
    { op: 'add_component', type: 'led', component_id: 'led1', props: { color: 'red' } },
    { op: 'add_component', type: 'resistor', component_id: 'r1', props: { ohms: board === 'arduino-uno' ? 330 : 220 } },
    { op: 'connect', from: 'r1.2', to: variant === 'reversed' ? 'led1.K' : 'led1.A' },
    { op: 'connect', from: variant === 'reversed' ? 'led1.A' : 'led1.K', to: `board.${b.gnd}` },
  ];
  if (variant === 'connected' || variant === 'reversed') ops.push({ op: 'connect', from: `board.${b.out}`, to: 'r1.1' });
  if (variant === 'alt-gpio') ops.push({ op: 'connect', from: `board.${b.alt}`, to: 'r1.1' });
  if (withButton) {
    ops.push({ op: 'add_component', type: 'button', component_id: 'btn1' });
    if (buttonWired) ops.push({ op: 'connect', from: `board.${b.btn}`, to: 'btn1.1' }, { op: 'connect', from: 'btn1.2', to: `board.${b.gnd}` });
  }
  return applyOps(createCircuit(board), ops).circuit;
}

interface Obs {
  timeline: Record<string, { simUs: number; lit: boolean }[]>;
  gpio: Record<string, { simUs: number; level: 0 | 1 | 'Z' }[]>;
  inputs: { pin: string; level: 0 | 1 | null; simUs: number }[];
  actions: { simUs: number; component: string; pressed: boolean; source: string }[];
  uart: string;
  clockSamples: { simUs: number; cycles: number; pc: number }[];
  warnings: string[];
  restarts: number;
  endUs: number;
  trace: string;
}

async function observe(board: BoardId, circuit: Circuit, rec: BuildRecord, durationMs: number, tag: string, opts: { stimuli?: { atUs: number; component: string; pressed: boolean }[]; rewireAtMs?: number; rewireTo?: Circuit; image?: Uint8Array; imageSha?: string; method?: 'direct-image-load' | 'esptool-virtual-uart' } = {}): Promise<Obs> {
  const img = opts.image ? { image: opts.image, sha: opts.imageSha!, path: 'device flash' } : imageOf(board, rec);
  const trace = R.path('traces', `${tag}.jsonl`);
  const hw = new VirtualHardware({
    backend: board === 'arduino-uno' ? 'avr8js' : 'esp32c3-esp-emu-wasm',
    board,
    circuit,
    image: img.image,
    firmware: { buildId: rec.buildId, sha256: img.sha, method: opts.method ?? 'direct-image-load', image: img.path },
    tracePath: trace,
    keepFullTimeline: true,
    edgeCapPerTick: 1_000_000,
  });
  const warnings = new Set<string>();
  hw.subscribeEvents((e) => {
    if (e.type === 'tick' && e.tick.warnings) for (const w of e.tick.warnings) warnings.add(`${w.code}: ${w.message}`);
  });
  await hw.loadFirmware();
  for (const w of hw.warnings) warnings.add(`${w.code}: ${w.message}`);
  if (opts.stimuli?.length) hw.schedule(opts.stimuli);
  const clockSamples: Obs['clockSamples'] = [];
  const endUs = durationMs * 1000;
  const marks = [0.25, 0.5, 0.75, 1].map((f) => Math.round(endUs * f));
  let rewired = false;
  for (const m of marks) {
    if (opts.rewireAtMs && !rewired && m >= opts.rewireAtMs * 1000) {
      await hw.runUntil(opts.rewireAtMs * 1000);
      hw.setCircuit(opts.rewireTo!);
      rewired = true;
    }
    const c = await hw.runUntil(m);
    clockSamples.push({ simUs: c.simUs, cycles: c.cycles, pc: hw.getState().pc ?? 0 });
  }
  const compress = (arr: { simUs: number; lit: boolean }[]) => {
    const out: { simUs: number; lit: boolean }[] = [];
    for (const e of arr) {
      if (e.simUs > endUs) break;
      if (out.length && out[out.length - 1].lit === e.lit) continue;
      out.push({ simUs: e.simUs, lit: e.lit });
    }
    return out;
  };
  const obs: Obs = {
    timeline: Object.fromEntries(Object.entries(hw.componentTimeline).map(([k, v]) => [k, compress(v)])),
    gpio: hw.gpioTimeline,
    inputs: hw.inputTimeline,
    actions: hw.userActions,
    uart: hw.uart,
    clockSamples,
    warnings: [...warnings],
    restarts: hw.restarts.length,
    endUs,
    trace,
  };
  await hw.stop();
  return obs;
}

const check = (c: Check, o: Obs) => evaluateCheck(c, o.timeline, o.endUs, o.uart);
const signature = (o: Obs, k = 'led1') => (o.timeline[k] ?? []).map((e) => `${Math.round(e.simUs / 1000)}:${e.lit ? 1 : 0}`).join(' ');

for (const board of boards) {
  const b = B[board];
  const f = b.fixtures;

  await R.run('T1', 'Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture)', async ({ log, evidence }) => {
    let ok = true;
    for (const fx of [f.A, f.B, f.C]) {
      const r = await build(board, fx);
      const elf = r.artifacts.find((a) => a.kind === 'elf');
      const img = r.artifacts.find((a) => a.kind === (board === 'arduino-uno' ? 'hex' : 'merged-bin'));
      const good = r.status === 'success' && !!elf && !!img && /^[0-9a-f]{64}$/.test(elf.sha256) && r.commands.length > 0 && r.toolVersions.length > 0;
      ok &&= good;
      log(`${fx}: ${r.status} in ${r.durationMs} ms; ELF ${elf?.size} B sha256 ${elf?.sha256.slice(0, 16)}…; ${img?.name} sha256 ${img?.sha256.slice(0, 16)}…`);
      log(`  command: ${r.commands.map((c) => c.slice(-6).join(' ')).join(' && ')}`);
      evidence(join(projDir(board), 'builds', r.buildId, 'build.json'));
    }
    log(`toolchain: ${(await build(board, f.A)).toolVersions.map((v) => `${v.name} ${v.version}`).join('; ')}`);
    const hashes = new Set([f.A, f.B, f.C].map((x) => builds.get(`${board}/${x}`)!.artifacts.find((a) => a.kind === 'elf')!.sha256));
    if (hashes.size !== 3) {
      log('different sources produced identical ELF hashes');
      ok = false;
    }
    const err = await build(board, f.ERR);
    const errs = err.diagnostics.filter((d) => d.severity === 'error');
    log(`compile_error fixture: status=${err.status}, ${errs.length} error diagnostic(s): ${errs.slice(0, 3).map((d) => `${d.file}:${d.line}: ${d.message}`).join(' | ')}`);
    log(`compile_error produced artifacts: ${err.artifacts.length}`);
    evidence(join(projDir(board), 'builds', err.buildId, 'build.log'));
    return ok && err.status === 'failed' && errs.length > 0 && err.artifacts.length === 0;
  }, board);

  await R.run('T2', 'MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU)', async ({ log, evidence }) => {
    const r = await build(board, f.A);
    const o = await observe(board, ledCircuit(board), r, 1200, `${b.short}-T2`);
    evidence(o.trace);
    const cyc = o.clockSamples.map((c) => c.cycles);
    const increasing = cyc.every((c, i) => i === 0 || c > cyc[i - 1]);
    log(`cycle counter samples: ${cyc.join(' → ')} (${increasing ? 'strictly increasing' : 'NOT increasing'})`);
    log(`PC samples: ${o.clockSamples.map((c) => '0x' + c.pc.toString(16)).join(', ')}`);
    const entry = board === 'arduino-uno' ? /PLUGAI_FIXTURE d4_high/.test(o.uart) : /main_task: Calling app_main\(\)/.test(o.uart) && /PLUGAI_FIXTURE gpio4_high fib\(24\)=46368/.test(o.uart);
    const uartLines = o.uart.split(/\r?\n/).filter((l) => /PLUGAI|app_main|ESP-IDF|boot:/.test(l)).slice(0, 8);
    log(`UART (from emulated UART peripheral): ${uartLines.join(' | ')}`);
    writeFileSync(R.path(`${b.short}-T2-uart.txt`), o.uart);
    evidence(R.path(`${b.short}-T2-uart.txt`));
    const pcOk = board === 'arduino-uno' ? o.clockSamples.every((c) => c.pc < 0x8000) : o.clockSamples.every((c) => (c.pc >= 0x40380000 && c.pc < 0x403e0000) || (c.pc >= 0x42000000 && c.pc < 0x42800000));
    log(`PC within target code regions: ${pcOk}`);
    return increasing && entry && pcOk;
  }, board);

  await R.run('T3', 'GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit', async ({ log, evidence, data }) => {
    const c = ledCircuit(board);
    const oA = await observe(board, c, await build(board, f.A), 3000, `${b.short}-T3-A`);
    const oB = await observe(board, c, await build(board, f.B), 3000, `${b.short}-T3-B`);
    const oC = await observe(board, c, await build(board, f.C), 3000, `${b.short}-T3-C`);
    [oA, oB, oC].forEach((o) => evidence(o.trace));
    const a = check({ type: 'state_during', component: 'led1', state: 'on', from_ms: 300, to_ms: 3000 }, oA);
    const bb = check({ type: 'state_during', component: 'led1', state: 'off', from_ms: 0, to_ms: 3000 }, oB);
    const cc = check({ type: 'period', component: 'led1', period_ms: 1000, tolerance_pct: 1, min_cycles: 2, duty: 0.5, duty_tolerance: 0.02 } as Check, oC);
    log(`A (always HIGH): ${a.detail}`);
    log(`B (always LOW):  ${bb.detail}`);
    log(`C (toggle):      ${cc.detail}`);
    const sigs = [signature(oA), signature(oB), signature(oC)];
    log(`LED signatures: A=[${sigs[0]}] B=[${sigs[1]}] C=[${sigs[2].slice(0, 80)}…]`);
    log(`GPIO ${b.out} edges: A=${oA.gpio[b.out]?.length ?? 0}, B=${oB.gpio[b.out]?.length ?? 0}, C=${oC.gpio[b.out]?.length ?? 0}`);
    data({ A: oA.timeline.led1, B: oB.timeline.led1, C: oC.timeline.led1 });
    return a.passed && bb.passed && cc.passed && new Set(sigs).size === 3;
  }, board);

  await R.run('T4', 'Circuit truthfulness: same running firmware, different wiring', async ({ log, evidence }) => {
    const r = await build(board, f.C);
    const per: Check = { type: 'period', component: 'led1', period_ms: 1000, tolerance_pct: 1, min_cycles: 2 } as Check;
    const offAll: Check = { type: 'state_during', component: 'led1', state: 'off', from_ms: 0, to_ms: 3000 };
    const res: boolean[] = [];
    for (const v of ['connected', 'disconnected', 'alt-gpio', 'reversed'] as Variant[]) {
      const o = await observe(board, ledCircuit(board, v), r, 3000, `${b.short}-T4-${v}`);
      evidence(o.trace);
      const c = check(v === 'connected' ? per : offAll, o);
      const extra = v === 'reversed' ? ` | warnings: ${o.warnings.filter((w) => w.startsWith('LED_REVERSED')).length ? 'LED_REVERSED reported' : 'none'}` : '';
      log(`${v.padEnd(12)} (${b.out} edges: ${o.gpio[b.out]?.length ?? 0}): ${c.detail}${extra}`);
      res.push(c.passed && (v !== 'reversed' || o.warnings.some((w) => w.startsWith('LED_REVERSED'))));
    }
    // live re-wire while firmware keeps running: move the LED from the blinking pin to an idle pin at t=2.0s
    const o = await observe(board, ledCircuit(board, 'connected'), r, 4000, `${b.short}-T4-live-rewire`, { rewireAtMs: 2000, rewireTo: ledCircuit(board, 'alt-gpio') });
    evidence(o.trace);
    const before = check({ type: 'toggle_count', component: 'led1', min: 2, from_ms: 0, to_ms: 2000 }, o);
    const after = check({ type: 'state_during', component: 'led1', state: 'off', from_ms: 2001, to_ms: 4000 }, o);
    const gpioStill = (o.gpio[b.out] ?? []).filter((e) => e.simUs > 2_000_000).length;
    log(`live rewire @2000 ms: before → ${before.detail}; after → ${after.detail}; ${b.out} kept toggling (${gpioStill} edges after rewire)`);
    res.push(before.passed && after.passed && gpioStill >= 2);
    return res.every(Boolean);
  }, board);

  await R.run('T5', 'Interactive closed loop: button → input pad → firmware → output pad → LED', async ({ log, evidence, data }) => {
    const r = await build(board, f.BTN);
    const stim = [
      { atUs: 1_000_000, component: 'btn1', pressed: true },
      { atUs: 2_000_000, component: 'btn1', pressed: false },
    ];
    const o = await observe(board, ledCircuit(board, 'connected', true), r, 3000, `${b.short}-T5`, { stimuli: stim });
    evidence(o.trace);
    const c1 = check({ type: 'state_during', component: 'led1', state: 'off', from_ms: 300, to_ms: 999 }, o);
    const c2 = check({ type: 'state_during', component: 'led1', state: 'on', from_ms: 1020, to_ms: 1999 }, o);
    const c3 = check({ type: 'state_during', component: 'led1', state: 'off', from_ms: 2020, to_ms: 3000 }, o);
    [c1, c2, c3].forEach((c) => log(c.detail));
    const press = o.actions.find((a) => a.pressed);
    const inLow = o.inputs.find((i) => i.pin === b.btn && i.level === 0);
    const outHigh = (o.gpio[b.out] ?? []).find((e) => e.level === 1 && e.simUs >= 1_000_000);
    const ledOn = (o.timeline.led1 ?? []).find((e) => e.lit && e.simUs >= 1_000_000);
    const chain = press && inLow && outHigh && ledOn && press.simUs <= inLow.simUs && inLow.simUs <= outHigh.simUs && outHigh.simUs <= ledOn.simUs;
    const fmt = (x?: { simUs: number }) => (x ? `${(x.simUs / 1000).toFixed(3)} ms` : 'MISSING');
    log(`causal chain: user press @${fmt(press)} → ${b.btn} input=0 applied @${fmt(inLow)} → firmware drives ${b.out}=1 @${fmt(outHigh)} → led1 lit @${fmt(ledOn)}`);
    writeFileSync(R.path(`${b.short}-T5-event-chain.json`), JSON.stringify({ press, inLow, outHigh, ledOn, inputs: o.inputs, gpio: o.gpio[b.out], led: o.timeline.led1 }, null, 2));
    evidence(R.path(`${b.short}-T5-event-chain.json`));
    // controls: (1) button not wired, (2) firmware that ignores the button
    const n1 = await observe(board, ledCircuit(board, 'connected', true, false), r, 3000, `${b.short}-T5-control-unwired`, { stimuli: stim });
    const n2 = await observe(board, ledCircuit(board, 'connected', true), await build(board, f.B), 3000, `${b.short}-T5-control-firmware-ignores`, { stimuli: stim });
    const k1 = check({ type: 'state_during', component: 'led1', state: 'off', from_ms: 300, to_ms: 3000 }, n1);
    const k2 = check({ type: 'state_during', component: 'led1', state: 'off', from_ms: 300, to_ms: 3000 }, n2);
    log(`control (button unwired): ${k1.detail}`);
    log(`control (firmware ignores button): ${k2.detail}`);
    data({ chain: { press, inLow, outHigh, ledOn } });
    return c1.passed && c2.passed && c3.passed && !!chain && k1.passed && k2.passed;
  }, board);

  await R.run('T6', 'Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps', async ({ log, evidence, data }) => {
    const o1 = await observe(board, ledCircuit(board), await build(board, f.C), 4200, `${b.short}-T6-1000`);
    const o2 = await observe(board, ledCircuit(board), await build(board, f.C200), 2200, `${b.short}-T6-200`);
    evidence(o1.trace);
    evidence(o2.trace);
    const tol = board === 'arduino-uno' ? 1 : 0.5;
    const p1 = check({ type: 'period', component: 'led1', period_ms: 1000, tolerance_pct: tol, min_cycles: 3, duty: 0.5, duty_tolerance: 0.02 } as Check, o1);
    const p2 = check({ type: 'period', component: 'led1', period_ms: 200, tolerance_pct: tol, min_cycles: 5, duty: 0.5, duty_tolerance: 0.02 } as Check, o2);
    log(`1000 ms firmware: ${p1.detail}`);
    log(`200 ms firmware:  ${p2.detail}`);
    log(`tolerance ±${tol}%: ${board === 'arduino-uno' ? 'avr8js edges are cycle-exact (62.5 ns); Arduino delay() uses Timer0 millis() (1.024 ms tick granularity)' : 'esp-emu pads sampled every 2000 instructions (≈12.5 µs at 160 MHz); FreeRTOS tick 1 ms'}`);
    data({ p1: p1.measured, p2: p2.measured });
    return p1.passed && p2.passed;
  }, board);
}

if (boards.includes('esp32c3-devkitm-1')) {
  await R.run('T8', 'Virtual UART flashing (esptool ROM protocol → emulated SPI flash → boot from written flash)', async ({ log, evidence, data }) => {
    const board: BoardId = 'esp32c3-devkitm-1';
    const dir = projDir(board);
    rmSync(deviceFlashPath(dir), { force: true });
    const r1 = await build(board, 'gpio4_blink_1000');
    const f1 = await flashEsp32Virtual({ projectId: 'p0', projectDir: dir, build: r1, onProgress: (s, st) => st !== 'running' && log(`  [flash#1] ${s}: ${st}`) });
    evidence(join(dir, 'flashes', f1.flashId, 'flash.json'));
    evidence(join(dir, 'flashes', f1.flashId, 'flash.log'));
    log(`flash#1 ${f1.status}: esptool ${f1.esptoolVersion}, transport ${f1.transport}, ${f1.bytesWritten} bytes; before ${f1.flashImageBefore?.sha256.slice(0, 12)}… → after ${f1.flashImageAfter?.sha256.slice(0, 12)}…; readback ${f1.readBackSha256?.slice(0, 12)}…`);
    log(`  command: ${f1.commands.find((c) => c.includes('write_flash'))?.slice(1).join(' ')}`);
    log(`  ${f1.bootEvidence ?? f1.error}`);
    if (f1.status !== 'success') return false;
    const dev1 = new Uint8Array(readFileSync(deviceFlashPath(dir)));
    const o1 = await observe(board, ledCircuit(board), r1, 3000, 'esp32c3-T8-run-after-flash1', { image: dev1, imageSha: f1.flashImageAfter!.sha256, method: 'esptool-virtual-uart' });
    const p1 = check({ type: 'period', component: 'led1', period_ms: 1000, tolerance_pct: 0.5, min_cycles: 2 } as Check, o1);
    log(`running the written virtual flash: ${p1.detail}`);
    const r2 = await build(board, 'gpio4_blink_200');
    const f2 = await flashEsp32Virtual({ projectId: 'p0', projectDir: dir, build: r2 });
    evidence(join(dir, 'flashes', f2.flashId, 'flash.json'));
    log(`flash#2 ${f2.status}: before ${f2.flashImageBefore?.sha256.slice(0, 12)}… (= after#1: ${f2.flashImageBefore?.sha256 === f1.flashImageAfter?.sha256}) → after ${f2.flashImageAfter?.sha256.slice(0, 12)}…; ${f2.bootEvidence ?? f2.error}`);
    if (f2.status !== 'success') return false;
    const o2 = await observe(board, ledCircuit(board), r2, 2000, 'esp32c3-T8-run-after-flash2', { image: new Uint8Array(readFileSync(deviceFlashPath(dir))), imageSha: f2.flashImageAfter!.sha256, method: 'esptool-virtual-uart' });
    const p2 = check({ type: 'period', component: 'led1', period_ms: 200, tolerance_pct: 0.5, min_cycles: 3 } as Check, o2);
    log(`re-flashed device now runs: ${p2.detail}`);
    evidence(o1.trace);
    evidence(o2.trace);
    data({ flash1: f1, flash2: f2 });
    return p1.passed && p2.passed && f2.flashImageBefore?.sha256 === f1.flashImageAfter?.sha256 && f1.flashImageAfter?.sha256 !== f2.flashImageAfter?.sha256 && f1.verified && f2.verified;
  }, 'esp32c3-devkitm-1');
}

if (boards.includes('arduino-uno')) {
  await R.run('T11', 'LCD over real SPI: firmware SPI bytes → ST7735 model → captured frame; miswired bus shows nothing', async ({ log, evidence }) => {
    const board: BoardId = 'arduino-uno';
    const r = await build(board, 'lcd_face');
    const lcdOps = (dc = 'D9', sck = 'D13'): Parameters<typeof applyOps>[1] => [
      { op: 'add_component', type: 'lcd', component_id: 'lcd1' },
      { op: 'connect', from: 'lcd1.VCC', to: 'board.5V' },
      { op: 'connect', from: 'lcd1.GND', to: 'board.GND1' },
      { op: 'connect', from: 'lcd1.SCK', to: `board.${sck}` },
      { op: 'connect', from: 'lcd1.SDA', to: 'board.D11' },
      { op: 'connect', from: 'lcd1.CS', to: 'board.D10' },
      { op: 'connect', from: 'lcd1.DC', to: `board.${dc}` },
      { op: 'connect', from: 'lcd1.RST', to: 'board.D8' },
      { op: 'connect', from: 'lcd1.BL', to: 'board.5V' },
    ];
    const { image } = avrDirectLoad('p0', projDir(board), r);
    const { runVerification } = await import('@plugai/simulator');
    const scen = { name: 'lcd', duration_ms: 2200, stimuli: [], checks: [{ type: 'display', component: 'lcd1', at_ms: 1500, min_nonblack_pct: 30, colors: [{ hex: '#ffff00', min_pct: 20 }, { hex: '#ff0000', min_pct: 2 }] }, { type: 'display', component: 'lcd1', at_ms: 2000, changed_since_ms: 1500 }] } as any;
    const ok: boolean[] = [];
    for (const [name, dc, sck, expect] of [['correct wiring', 'D9', 'D13', true], ['DC on D7 (firmware drives D9)', 'D7', 'D13', false], ['SCK on D12 (not hardware SPI)', 'D9', 'D12', false]] as const) {
      const rep = await runVerification({ backend: 'avr8js', board, circuit: applyOps(createCircuit(board), lcdOps(dc, sck)).circuit, image, firmware: { buildId: r.buildId, sha256: r.artifacts[0].sha256, method: 'direct-image-load', image: 'hex' }, scenario: scen, tracePath: R.path('traces', `uno-T11-${dc}-${sck}.jsonl`) });
      log(`${name}: verification ${rep.passed ? 'PASS' : 'FAIL'} — ${rep.results[0].detail}`);
      rep.displayEvidence?.forEach((d) => evidence(d.png));
      ok.push(rep.passed === expect);
    }
    return ok.every(Boolean);
  }, 'arduino-uno');
}

const failed = R.finish('PlugAI P0 acceptance — real firmware ↔ MCU emulation ↔ virtual circuit', 'All results below come from real cross-compilation and MCU emulation; LED states are computed by the circuit solver from emulated GPIO pad registers.');
process.exit(failed ? 1 : 0);
