// Virtual hardware worker: one MCU core + the board's circuit, isolated in its own thread.
// Every component state is derived from (MCU pad state -> circuit solve). Inputs flow back
// (button -> net voltage -> MCU pad input) at the simulated instant the solve happens.
import { parentPort, workerData } from 'node:worker_threads';
import { observableChannels, solveCircuit } from '@plugai/circuit';
import type { Circuit, CircuitSolution, ComponentEdge, GpioEdge, InputApplied, McuPinState } from '@plugai/shared';
import type { McuCore } from './core.ts';
import { St7735, LCD_W, LCD_H } from './devices/st7735.ts';

type Mode = 'realtime' | 'fast';

interface InitData {
  backend: 'esp32c3-esp-emu-wasm' | 'avr8js';
  circuit: Circuit;
  image: Uint8Array;
  edgeCapPerTick: number;
}

const port = parentPort!;
const init = workerData as InitData;

let core: McuCore;
let circuit: Circuit = init.circuit;
const buttons: Record<string, boolean> = {};
let running = false;
let mode: Mode = 'realtime';
let speed = 1;
let baseWall = 0;
let baseSimUs = 0;
let lastTickWall = 0;
let lastTickSimUs = 0;
let measuredSpeed = 0;
let wallRunMs = 0;
let runFor: { requestId: number; untilUs: number } | null = null;
let scheduled: { atUs: number; component: string; pressed: boolean }[] = [];
let solution!: CircuitSolution;
let channels: Record<string, { lit: boolean; brightness: number }> = {};
const appliedInputs = new Map<string, 0 | 1 | null>();
const forcedInputs = new Map<string, 0 | 1>();
let lastWarnKey = '';

// ---- bus-attached display devices
interface DisplayEntry {
  dev: St7735;
  powered: boolean;
  backlight: boolean;
  ready: boolean;
  bus: { cs: string | null; dc: string | null; rst: string | null };
  inReset: boolean;
  sentSeq: number;
  undefinedDc: number;
  busBytes: number;
  deselected: number;
}
const displays = new Map<string, DisplayEntry>();
let snapshotsDue: { atUs: number; tag: string }[] = [];
let lastDisplaySend = 0;

function syncDisplays() {
  const seen = new Set<string>();
  for (const st of Object.values(solution.components)) {
    if (st.type !== 'lcd' || !st.lcd) continue;
    seen.add(st.component_id);
    let d = displays.get(st.component_id);
    if (!d) {
      d = { dev: new St7735(), powered: false, backlight: false, ready: false, bus: { cs: null, dc: null, rst: null }, inReset: false, sentSeq: -1, undefinedDc: 0, busBytes: 0, deselected: 0 };
      displays.set(st.component_id, d);
    }
    if (st.lcd.powered && !d.powered) d.dev.powerOn();
    d.powered = st.lcd.powered;
    d.backlight = st.lcd.backlight;
    d.ready = st.lcd.ready;
    d.bus = { cs: st.lcd.bus.cs, dc: st.lcd.bus.dc, rst: st.lcd.bus.rst };
    if (d.bus.rst && d.bus.rst !== 'VCC' && core.pinLevel) {
      const lv = core.pinLevel(d.bus.rst);
      if (lv === 0 && !d.inReset) d.inReset = true;
      else if (lv === 1 && d.inReset) {
        d.inReset = false;
        d.dev.softReset();
      }
    }
  }
  for (const k of [...displays.keys()]) if (!seen.has(k)) displays.delete(k);
}

function onSpiByte(b: number) {
  for (const d of displays.values()) {
    d.busBytes++;
    if (!d.ready || !d.powered || d.inReset) continue;
    const cs = d.bus.cs === 'GND' ? 0 : core.pinLevel!(d.bus.cs!);
    if (cs !== 0) {
      d.deselected++;
      continue;
    }
    const dc = core.pinLevel!(d.bus.dc!);
    if (dc === null) {
      d.undefinedDc++;
      continue;
    }
    d.dev.write(b, dc);
  }
}

function displayPayload(force: boolean) {
  const out: Record<string, unknown> = {};
  for (const [id, d] of displays) {
    if (!force && d.dev.seq === d.sentSeq) continue;
    d.sentSeq = d.dev.seq;
    const on = d.powered && !d.dev.sleep && d.dev.displayOn;
    out[id] = { w: LCD_W, h: LCD_H, seq: d.dev.seq, powered: d.powered, on, backlight: d.backlight, ready: d.ready, b64: Buffer.from(d.dev.visible().buffer).toString('base64'), stats: { ...d.dev.stats, undefinedDc: d.undefinedDc, busBytes: d.busBytes, deselected: d.deselected, inReset: d.inReset, bus: d.bus } };
  }
  return Object.keys(out).length ? out : undefined;
}

function takeDueSnapshots() {
  const now = simUs();
  while (snapshotsDue.length && snapshotsDue[0].atUs <= now) {
    const s = snapshotsDue.shift()!;
    port.postMessage({ type: 'display-snapshot', tag: s.tag, simUs: now, displays: displayPayload(true) ?? {} });
  }
}

// per-tick buffers
let tEdges: GpioEdge[] = [];
let tComp: ComponentEdge[] = [];
let tInputs: InputApplied[] = [];
let tUart = '';
let tUser: { simUs: number; component: string; pressed: boolean; source: string }[] = [];
let truncated = 0;
const dutyOnUs: Record<string, number> = {};
let dutyLastUs = 0;

function simUs() {
  return core.clock().simUs;
}

function accumulateDuty(nowUs: number) {
  const dt = nowUs - dutyLastUs;
  if (dt > 0) for (const [k, v] of Object.entries(channels)) if (v.lit) dutyOnUs[k] = (dutyOnUs[k] ?? 0) + dt;
  dutyLastUs = nowUs;
}

function resolve(atUs: number) {
  const pins: McuPinState[] = core.pins();
  solution = solveCircuit({ circuit, mcuPins: pins, buttons });
  accumulateDuty(atUs);
  const next = observableChannels(solution);
  for (const [k, v] of Object.entries(next)) {
    const prev = channels[k];
    if (!prev || prev.lit !== v.lit || Math.abs(prev.brightness - v.brightness) > 0.02) {
      const [component_id, channel] = k.split(':');
      tComp.push({ component_id, channel, lit: v.lit, brightness: v.brightness, simUs: atUs });
    }
  }
  for (const k of Object.keys(channels)) if (!next[k]) tComp.push({ component_id: k.split(':')[0], channel: k.split(':')[1], lit: false, brightness: 0, simUs: atUs });
  channels = next;
  syncDisplays();
  for (const inp of solution.mcuInputs) {
    const level = forcedInputs.has(inp.pin) ? forcedInputs.get(inp.pin)! : inp.level;
    const prev = appliedInputs.get(inp.pin);
    if (prev === level && appliedInputs.has(inp.pin)) continue;
    appliedInputs.set(inp.pin, level);
    core.setInput(inp.pin, level);
    tInputs.push({ pin: inp.pin, level, simUs: atUs });
  }
}

function applyDueStimuli() {
  const now = simUs();
  let changed = false;
  while (scheduled.length && scheduled[0].atUs <= now) {
    const s = scheduled.shift()!;
    buttons[s.component] = s.pressed;
    tUser.push({ simUs: now, component: s.component, pressed: s.pressed, source: 'scenario' });
    changed = true;
  }
  if (changed) resolve(now);
}

function step(budgetUs: number) {
  applyDueStimuli();
  const now = simUs();
  let chunk = Math.min(budgetUs, 5000);
  if (scheduled.length) chunk = Math.max(1, Math.min(chunk, scheduled[0].atUs - now));
  if (snapshotsDue.length) chunk = Math.max(1, Math.min(chunk, snapshotsDue[0].atUs - now));
  const r = core.run(chunk);
  tUart += r.uart;
  if (r.edges.length) {
    if (tEdges.length < init.edgeCapPerTick) tEdges.push(...r.edges.slice(0, init.edgeCapPerTick - tEdges.length));
    else truncated += r.edges.length;
  }
  if (r.restarted) port.postMessage({ type: 'restart', reason: r.restarted, clock: clockNow() });
  if (r.edges.length || r.configChanged || r.restarted) resolve(r.edges.length ? r.edges[r.edges.length - 1].simUs : simUs());
  if (snapshotsDue.length) takeDueSnapshots();
}

function clockNow() {
  const c = core.clock();
  return { ...c, wallMs: wallRunMs, speed: measuredSpeed };
}

function postTick() {
  const now = simUs();
  accumulateDuty(now);
  const span = now - lastTickSimUs;
  const duty: Record<string, number> = {};
  for (const k of Object.keys(channels)) duty[k] = span > 0 ? Math.min(1, (dutyOnUs[k] ?? 0) / span) : channels[k].lit ? 1 : 0;
  for (const k of Object.keys(dutyOnUs)) dutyOnUs[k] = 0;
  const wallNow = performance.now();
  if (lastTickWall && wallNow > lastTickWall) {
    const inst = span / ((wallNow - lastTickWall) * 1000);
    measuredSpeed = measuredSpeed ? measuredSpeed * 0.7 + inst * 0.3 : inst;
  }
  if (running && lastTickWall) wallRunMs += wallNow - lastTickWall;
  lastTickWall = wallNow;
  lastTickSimUs = now;
  const warnKey = JSON.stringify(solution.warnings.map((w) => w.code + w.message));
  port.postMessage({
    type: 'tick',
    clock: clockNow(),
    edges: tEdges,
    componentEdges: tComp,
    inputsApplied: tInputs,
    userActions: tUser,
    uart: tUart,
    truncatedEdges: truncated,
    pins: core.pins(),
    components: solution.components,
    nets: solution.nets.map((n) => ({ net_id: n.net_id, level: n.level, voltage: n.voltage })),
    warnings: warnKey !== lastWarnKey ? solution.warnings : undefined,
    duty,
    pc: core.pc(),
    displays: mode === 'realtime' && wallNow - lastDisplaySend > 66 ? ((lastDisplaySend = wallNow), displayPayload(false)) : undefined,
  });
  lastWarnKey = warnKey;
  tEdges = [];
  tComp = [];
  tInputs = [];
  tUart = '';
  tUser = [];
  truncated = 0;
}

let gen = 0;
function loop(g = gen) {
  if (!running || g !== gen) return;
  try {
    const sliceStart = performance.now();
    if (mode === 'fast') {
      const until = runFor ? runFor.untilUs : Infinity;
      while (simUs() < until && performance.now() - sliceStart < 40) step(until - simUs());
      postTick();
      if (runFor && simUs() >= runFor.untilUs) {
        const rf = runFor;
        runFor = null;
        running = false;
        port.postMessage({ type: 'runFor-done', requestId: rf.requestId, clock: clockNow() });
        port.postMessage({ type: 'status', status: 'paused', clock: clockNow(), reason: 'runFor complete' });
        return;
      }
      setImmediate(() => loop(g));
      return;
    }
    const wallNow = performance.now();
    let target = baseSimUs + (wallNow - baseWall) * 1000 * speed;
    // never fall more than 250 ms of simulated time behind: report slower-than-real-time honestly
    if (target - simUs() > 250_000 * speed) {
      baseSimUs = simUs();
      baseWall = wallNow;
      target = baseSimUs + 16_000 * speed;
    }
    while (simUs() < target && performance.now() - sliceStart < 14) step(target - simUs());
    postTick();
    setTimeout(() => loop(g), simUs() >= target ? 10 : 0);
  } catch (e) {
    running = false;
    port.postMessage({ type: 'error', message: `MCU core fault: ${(e as Error).message}`, fatal: true, clock: safeClock() });
  }
}

function safeClock() {
  try {
    return clockNow();
  } catch {
    return undefined;
  }
}

function start(m: Mode, s = 1) {
  mode = m;
  speed = s;
  baseWall = performance.now();
  baseSimUs = simUs();
  lastTickWall = performance.now();
  running = true;
  gen++;
  port.postMessage({ type: 'status', status: 'running', clock: clockNow() });
  loop(gen);
}

port.on('message', (msg: any) => {
  try {
    switch (msg.cmd) {
      case 'start':
        if (!running) start(msg.mode ?? 'realtime', msg.speed ?? 1);
        break;
      case 'pause':
        running = false;
        runFor = null;
        postTick();
        port.postMessage({ type: 'status', status: 'paused', clock: clockNow() });
        break;
      case 'reset': {
        const was = running;
        running = false;
        core.reset();
        for (const d of displays.values()) d.dev.powerOn();
        appliedInputs.clear();
        channels = {};
        dutyLastUs = 0;
        lastTickSimUs = 0;
        wallRunMs = 0;
        scheduled = [];
        resolve(0);
        postTick();
        port.postMessage({ type: 'status', status: was ? 'running' : 'loaded', clock: clockNow(), reason: 'reset' });
        if (was) start(mode, speed);
        break;
      }
      case 'setCircuit':
        circuit = msg.circuit;
        for (const k of Object.keys(buttons)) if (!circuit.components.some((c) => c.component_id === k)) delete buttons[k];
        resolve(simUs());
        if (!running) postTick();
        break;
      case 'button': {
        buttons[msg.component] = !!msg.pressed;
        const now = simUs();
        tUser.push({ simUs: now, component: msg.component, pressed: !!msg.pressed, source: msg.source ?? 'user' });
        resolve(now);
        if (!running) postTick();
        break;
      }
      case 'forceInput':
        if (msg.level === null) forcedInputs.delete(msg.pin);
        else forcedInputs.set(msg.pin, msg.level);
        tUser.push({ simUs: simUs(), component: `pin:${msg.pin}`, pressed: msg.level === 0, source: 'force-input' });
        resolve(simUs());
        if (!running) postTick();
        break;
      case 'schedule':
        scheduled = [...scheduled, ...(msg.stimuli ?? [])].sort((a, b) => a.atUs - b.atUs);
        snapshotsDue = [...snapshotsDue, ...(msg.snapshots ?? [])].sort((a, b) => a.atUs - b.atUs);
        break;
      case 'displays':
        port.postMessage({ type: 'display-snapshot', tag: msg.tag ?? 'now', simUs: simUs(), displays: displayPayload(true) ?? {} });
        break;
      case 'uart':
        core.uartWrite(new Uint8Array(msg.data));
        break;
      case 'runFor':
        runFor = { requestId: msg.requestId, untilUs: msg.untilUs };
        if (running && mode !== 'fast') running = false;
        if (!running) start('fast');
        break;
      case 'stop':
        running = false;
        core.dispose();
        port.postMessage({ type: 'status', status: 'stopped', clock: undefined });
        setTimeout(() => process.exit(0), 5);
        break;
    }
  } catch (e) {
    port.postMessage({ type: 'error', message: (e as Error).message, fatal: false });
  }
});

(async () => {
  try {
    if (init.backend === 'avr8js') {
      const { AvrCore } = await import('@plugai/backend-avr/core');
      core = new AvrCore();
    } else {
      const { Esp32c3Core } = await import('@plugai/backend-esp32/core');
      core = new Esp32c3Core();
    }
    await core.init();
    core.load(init.image);
    if ('onSpiByte' in core) core.onSpiByte = onSpiByte;
    resolve(0);
    port.postMessage({ type: 'loaded', info: core.info, pins: core.pins(), clock: clockNow(), solution: solution! });
  } catch (e) {
    port.postMessage({ type: 'error', message: `Load failed: ${(e as Error).message}`, fatal: true });
  }
})();
