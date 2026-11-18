import { randomUUID } from 'node:crypto';
import type { BackendId, BoardId, Check, CheckInput, CheckResult, Circuit, Scenario, VerificationReport } from '@plugai/shared';
import { CheckSchema, ScenarioSchema, nowIso } from '@plugai/shared';
import { VirtualHardware, type DisplayFrame, type FirmwareRef } from './host.ts';
import { decodeFrame, rgb565Png } from './devices/png.ts';
import { rgb565ToRgb } from './devices/st7735.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type FrameSet = Record<string, Record<string, DisplayFrame>>;
const hexRgb = (h: string) => {
  const x = h.replace('#', '');
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
};

function evaluateDisplay(check: Extract<Check, { type: 'display' }>, frames: FrameSet): CheckResult {
  const f = frames[`d@${check.at_ms}`]?.[check.component];
  if (!f) return { check, passed: false, logOnly: false, detail: `No LCD "${check.component}" observed at ${check.at_ms} ms (not in the circuit or not an LCD)` };
  const st = f.stats;
  if (check.on && !(f.powered && f.on && f.backlight)) {
    const why = !f.powered
      ? 'module not powered (VCC/GND wiring)'
      : !f.ready
        ? 'SPI bus wiring incomplete (SCK→D13, SDA→D11, CS/DC/RST to GPIOs)'
        : st.busBytes === 0
          ? 'the firmware never used the hardware SPI peripheral (no bytes on D11/D13)'
          : st.undefinedDc > 0 && st.bytes === 0
            ? `the D/C pin ${st.bus.dc} is never driven by the firmware (${st.undefinedDc} bytes arrived while it was an undriven input) — firmware and wiring disagree`
            : st.deselected > 0 && st.bytes === 0
              ? `CS pin ${st.bus.cs} never went LOW while bytes were sent (${st.deselected} bytes ignored)`
              : st.inReset
                ? `RESET pin ${st.bus.rst} is held LOW`
                : !f.on
                  ? 'controller asleep or display off (needs SLPOUT 0x11 then DISPON 0x29)'
                  : 'backlight (BL) not powered';
    return { check, passed: false, logOnly: false, detail: `${check.component} at ${check.at_ms} ms shows nothing: ${why}. Bus bytes ${st.busBytes}, accepted ${st.bytes}, commands ${st.commands}, pixels ${st.pixels}`, measured: { ...st } };
  }
  const fb = decodeFrame(f.b64);
  const r = check.region ?? { x: 0, y: 0, w: f.w, h: f.h };
  let total = 0;
  let nonblack = 0;
  const targets = check.colors.map((c) => ({ ...c, rgb: hexRgb(c.hex), n: 0 }));
  const hist = new Map<number, number>();
  for (let y = r.y; y < Math.min(f.h, r.y + r.h); y++)
    for (let x = r.x; x < Math.min(f.w, r.x + r.w); x++) {
      const [R, G, B] = rgb565ToRgb(fb[y * f.w + x]);
      total++;
      if (R + G + B > 40) nonblack++;
      for (const t of targets) if (Math.hypot(R - t.rgb[0], G - t.rgb[1], B - t.rgb[2]) <= t.tolerance) t.n++;
      const q = ((R >> 5) << 6) | ((G >> 5) << 3) | (B >> 5);
      hist.set(q, (hist.get(q) ?? 0) + 1);
    }
  const pct = (n: number) => Math.round((n / Math.max(1, total)) * 1000) / 10;
  const fails: string[] = [];
  if (check.min_nonblack_pct !== undefined && pct(nonblack) < check.min_nonblack_pct) fails.push(`non-black ${pct(nonblack)}% < ${check.min_nonblack_pct}%`);
  if (check.max_nonblack_pct !== undefined && pct(nonblack) > check.max_nonblack_pct) fails.push(`non-black ${pct(nonblack)}% > ${check.max_nonblack_pct}%`);
  for (const t of targets) if (pct(t.n) < t.min_pct) fails.push(`colour ${t.hex} covers ${pct(t.n)}% < ${t.min_pct}%`);
  let changed: number | undefined;
  if (check.changed_since_ms !== undefined) {
    const g = frames[`d@${check.changed_since_ms}`]?.[check.component];
    if (!g) fails.push(`no frame captured at ${check.changed_since_ms} ms`);
    else {
      const a = decodeFrame(g.b64);
      let d = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== fb[i]) d++;
      changed = Math.round((d / a.length) * 1000) / 10;
      if (changed < 0.5) fails.push(`frame unchanged since ${check.changed_since_ms} ms (${changed}% pixels differ)`);
    }
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([q, n]) => `#${[(q >> 6) & 7, (q >> 3) & 7, q & 7].map((v) => Math.min(255, v * 36 + 18).toString(16).padStart(2, '0')).join('')} ${pct(n)}%`);
  const measured = { nonBlackPct: pct(nonblack), colors: targets.map((t) => ({ hex: t.hex, pct: pct(t.n) })), dominant: top, changedPct: changed, spiBytes: st.bytes, pixelsWritten: st.pixels };
  const desc = `${check.component} @${check.at_ms} ms: non-black ${pct(nonblack)}%${targets.length ? `, ${targets.map((t) => `${t.hex} ${pct(t.n)}%`).join(', ')}` : ''}${changed !== undefined ? `, ${changed}% pixels changed since ${check.changed_since_ms} ms` : ''}; dominant ${top.slice(0, 3).join(' ')}; ${st.pixels} pixels written over ${st.bytes} SPI bytes`;
  return { check, passed: fails.length === 0, logOnly: false, detail: fails.length ? `${desc} — FAIL: ${fails.join('; ')}` : desc, measured };
}

type Timeline = { simUs: number; lit: boolean }[];

export function normalizeChannel(key: string): string {
  let k = key.trim().replace('.', ':');
  const [c, ch] = k.split(':');
  if (ch) {
    const m: Record<string, string> = { r: 'red', y: 'yellow', g: 'green', red: 'red', yellow: 'yellow', green: 'green', amber: 'yellow' };
    k = `${c}:${m[ch.toLowerCase()] ?? ch.toLowerCase()}`;
  }
  return k;
}

function compress(tl: { simUs: number; lit: boolean }[]): Timeline {
  const out: Timeline = [];
  for (const e of tl) {
    if (out.length && out[out.length - 1].lit === e.lit) continue;
    if (out.length && out[out.length - 1].simUs === e.simUs) out.pop();
    if (out.length && out[out.length - 1].lit === e.lit) continue;
    out.push({ simUs: e.simUs, lit: e.lit });
  }
  return out;
}

function stateAt(tl: Timeline, us: number): boolean {
  let s = false;
  for (const e of tl) {
    if (e.simUs <= us) s = e.lit;
    else break;
  }
  return s;
}

const ms = (us: number) => Math.round(us / 10) / 100;

/** Remove on/off pulses shorter than glitchUs (e.g. µs transients between consecutive digitalWrite calls). */
export function deglitch(tl: Timeline, glitchUs: number): { tl: Timeline; removed: number } {
  if (glitchUs <= 0 || tl.length < 3) return { tl, removed: 0 };
  const out: Timeline = [tl[0]];
  let removed = 0;
  for (let i = 1; i < tl.length; i++) {
    const e = tl[i];
    const next = tl[i + 1];
    if (next && next.simUs - e.simUs < glitchUs && next.lit === out[out.length - 1].lit) {
      removed++;
      i++;
      continue;
    }
    if (out[out.length - 1].lit !== e.lit) out.push(e);
  }
  return { tl: out, removed };
}

export function evaluateCheck(input: CheckInput, rawTimelines: Record<string, Timeline>, endUs: number, uart: string, frames: FrameSet = {}): CheckResult {
  const check: Check = CheckSchema.parse(input);
  if (check.type === 'display') return evaluateDisplay(check, frames);
  const glitchUs = 'glitch_ms' in check ? ((check as { glitch_ms?: number }).glitch_ms ?? 1) * 1000 : 0;
  let glitches = 0;
  const timelines: Record<string, Timeline> = {};
  for (const [k, v] of Object.entries(rawTimelines)) {
    const d = deglitch(v, glitchUs);
    timelines[k] = d.tl;
    glitches += d.removed;
  }
  const r = evaluateCheckInner(check as Exclude<Check, { type: 'display' }>, timelines, endUs, uart, glitchUs);
  if (glitches || r.glitchSegments) r.detail += ` [glitch filter ${glitchUs / 1000} ms: ${glitches + (r.glitchSegments ?? 0)} sub-ms transient(s) ignored]`;
  delete r.glitchSegments;
  return r;
}

function evaluateCheckInner(check: Exclude<Check, { type: 'display' }>, timelines: Record<string, Timeline>, endUs: number, uart: string, glitchUs: number): CheckResult & { glitchSegments?: number } {
  const get = (k: string): Timeline | null => timelines[normalizeChannel(k)] ?? null;
  switch (check.type) {
    case 'uart_contains': {
      const ok = uart.includes(check.text);
      return { check, passed: ok, logOnly: true, detail: ok ? `UART output contains "${check.text}" (log evidence only — not a physical signal)` : `UART output does not contain "${check.text}"` };
    }
    case 'state_during': {
      const tl = get(check.component);
      if (!tl) return { check, passed: false, logOnly: false, detail: `No observable component "${check.component}" in the circuit` };
      const from = check.from_ms * 1000;
      const to = Math.min(check.to_ms * 1000, endUs);
      const want = check.state === 'on';
      if (stateAt(tl, from) !== want) return { check, passed: false, logOnly: false, detail: `${check.component} was ${want ? 'off' : 'on'} at ${check.from_ms} ms (expected ${check.state})` };
      const flip = tl.find((e) => e.simUs > from && e.simUs < to && e.lit !== want);
      if (flip) return { check, passed: false, logOnly: false, detail: `${check.component} turned ${flip.lit ? 'on' : 'off'} at ${ms(flip.simUs)} ms, inside the window ${check.from_ms}–${check.to_ms} ms where it should stay ${check.state}` };
      return { check, passed: true, logOnly: false, detail: `${check.component} stayed ${check.state} from ${check.from_ms} to ${ms(to)} ms` };
    }
    case 'toggle_count': {
      const tl = get(check.component);
      if (!tl) return { check, passed: false, logOnly: false, detail: `No observable component "${check.component}"` };
      const n = tl.filter((e, i) => i > 0 && e.simUs >= check.from_ms * 1000 && e.simUs <= check.to_ms * 1000).length;
      const ok = n >= check.min && (check.max === undefined || n <= check.max);
      return { check, passed: ok, logOnly: false, detail: `${check.component} toggled ${n} time(s) in ${check.from_ms}–${check.to_ms} ms (expected ${check.min}${check.max !== undefined ? `–${check.max}` : '+'})`, measured: { toggles: n } };
    }
    case 'period': {
      const tl = get(check.component);
      if (!tl) return { check, passed: false, logOnly: false, detail: `No observable component "${check.component}"` };
      const from = (check.from_ms ?? 0) * 1000;
      const rises = tl.filter((e, i) => i > 0 && e.lit && e.simUs >= from).map((e) => e.simUs);
      const falls = tl.filter((e, i) => i > 0 && !e.lit && e.simUs >= from).map((e) => e.simUs);
      const periods = rises.slice(1).map((t, i) => t - rises[i]);
      if (periods.length < check.min_cycles) {
        return { check, passed: false, logOnly: false, detail: `Only ${periods.length} complete period(s) of ${check.component} observed (need ${check.min_cycles}); ${rises.length} rising edge(s), ${falls.length} falling edge(s) after ${from / 1000} ms`, measured: { rises: rises.length, falls: falls.length } };
      }
      const exp = check.period_ms * 1000;
      const mean = periods.reduce((a, b) => a + b, 0) / periods.length;
      const maxDev = Math.max(...periods.map((p) => Math.abs(p - exp)));
      const tol = (exp * check.tolerance_pct) / 100;
      let duty: number | undefined;
      const highs: number[] = [];
      for (const r of rises) {
        const f = falls.find((x) => x > r);
        const nextR = rises.find((x) => x > r);
        if (f !== undefined && nextR !== undefined && f < nextR) highs.push((f - r) / (nextR - r));
      }
      if (highs.length) duty = highs.reduce((a, b) => a + b, 0) / highs.length;
      let ok = maxDev <= tol;
      let detail = `${check.component}: ${periods.length} periods, mean ${ms(mean)} ms (expected ${check.period_ms} ms ±${check.tolerance_pct}%), max deviation ${ms(maxDev)} ms`;
      if (check.duty !== undefined) {
        const dOk = duty !== undefined && Math.abs(duty - check.duty) <= check.duty_tolerance;
        ok = ok && dOk;
        detail += `, duty ${duty !== undefined ? (duty * 100).toFixed(1) : '?'}% (expected ${(check.duty * 100).toFixed(0)}% ±${(check.duty_tolerance * 100).toFixed(0)}%)`;
      }
      return { check, passed: ok, logOnly: false, detail, measured: { meanPeriodMs: ms(mean), maxDeviationMs: ms(maxDev), periodsMs: periods.slice(0, 20).map(ms), duty } };
    }
    case 'pattern': {
      const keys = check.components.map(normalizeChannel);
      const missing = keys.filter((k) => !timelines[k]);
      if (missing.length) return { check, passed: false, logOnly: false, detail: `No observable component(s): ${missing.join(', ')}` };
      const from = (check.from_ms ?? 0) * 1000;
      // combined-state segments
      const times = new Set<number>([from]);
      for (const k of keys) for (const e of timelines[k]) if (e.simUs > from && e.simUs < endUs) times.add(e.simUs);
      const sorted = [...times].sort((a, b) => a - b);
      type Seg = { key: string; startUs: number; durUs: number; states: Record<string, 'on' | 'off'> };
      const segs: Seg[] = [];
      let glitchSegments = 0;
      for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i];
        const end = i + 1 < sorted.length ? sorted[i + 1] : endUs;
        const states: Record<string, 'on' | 'off'> = {};
        for (const k of keys) states[k] = stateAt(timelines[k], t) ? 'on' : 'off';
        const key = keys.map((k) => states[k]).join(',');
        if (end - t < glitchUs && i + 1 < sorted.length && segs.length) {
          // transient combined state (channels switching a few µs apart): fold into the previous segment
          segs[segs.length - 1].durUs += end - t;
          glitchSegments++;
          continue;
        }
        if (segs.length && segs[segs.length - 1].key === key) segs[segs.length - 1].durUs += end - t;
        else segs.push({ key, startUs: t, durUs: end - t, states });
      }
      // expected (merge identical neighbours)
      const expSegs: { key: string; durUs: number }[] = [];
      for (const s of check.segments) {
        const norm: Record<string, string> = {};
        for (const [k, v] of Object.entries(s.states)) norm[normalizeChannel(k)] = v;
        const key = keys.map((k) => norm[k] ?? 'off').join(',');
        if (expSegs.length && expSegs[expSegs.length - 1].key === key) expSegs[expSegs.length - 1].durUs += s.duration_ms * 1000;
        else expSegs.push({ key, durUs: s.duration_ms * 1000 });
      }
      if (check.cyclic && expSegs.length > 1 && expSegs[0].key === expSegs[expSegs.length - 1].key) {
        expSegs[0].durUs += expSegs.pop()!.durUs;
      }
      const L = expSegs.length;
      const need = check.cyclic ? Math.max(L, L * check.min_repeats) : L;
      const tolFor = (d: number) => Math.max(check.tolerance_ms * 1000, (d * check.tolerance_pct) / 100);
      // drop the first (possibly partial) segment; the last observed segment is truncated by end of run
      const obs = segs.slice(1);
      let best = { matched: 0, start: -1, rot: 0, firstMismatch: '' };
      for (let j = 0; j < Math.min(obs.length, L + 2); j++) {
        for (let rot = 0; rot < L; rot++) {
          if (!check.cyclic && rot > 0) break;
          let m = 0;
          let mismatch = '';
          while (j + m < obs.length && m < need) {
            const e = expSegs[(rot + m) % L];
            const o = obs[j + m];
            const isLast = j + m === obs.length - 1;
            if (o.key !== e.key) {
              mismatch = `at ${ms(o.startUs)} ms observed [${o.key}] for ${ms(o.durUs)} ms, expected [${e.key}] for ${ms(e.durUs)} ms`;
              break;
            }
            const dOk = Math.abs(o.durUs - e.durUs) <= tolFor(e.durUs) || (isLast && o.durUs <= e.durUs + tolFor(e.durUs));
            if (!dOk) {
              mismatch = `at ${ms(o.startUs)} ms state [${o.key}] lasted ${ms(o.durUs)} ms, expected ${ms(e.durUs)} ms ±${ms(tolFor(e.durUs))} ms`;
              break;
            }
            m++;
          }
          if (m > best.matched) best = { matched: m, start: j, rot, firstMismatch: mismatch };
          if (m >= need) break;
        }
        if (best.matched >= need) break;
      }
      const ok = best.matched >= need;
      const observedSummary = segs.slice(0, 14).map((s) => `[${s.key}] ${ms(s.durUs)}ms`).join(' → ');
      return {
        glitchSegments,
        check,
        passed: ok,
        logOnly: false,
        detail: ok
          ? `Pattern over (${keys.join(', ')}) matched ${best.matched} consecutive segment(s) (needed ${need}); first match at ${ms(obs[best.start].startUs)} ms`
          : `Pattern over (${keys.join(', ')}) matched only ${best.matched}/${need} segments. ${best.firstMismatch || 'Not enough segments observed.'} Observed: ${observedSummary}`,
        measured: { observed: segs.slice(0, 40).map((s) => ({ states: s.key, startMs: ms(s.startUs), durationMs: ms(s.durUs) })), expected: expSegs.map((e) => ({ states: e.key, durationMs: e.durUs / 1000 })), order: keys },
      };
    }
  }
}

export interface VerifyInput {
  backend: BackendId;
  board: BoardId;
  circuit: Circuit;
  image: Uint8Array;
  firmware: FirmwareRef;
  scenario: Scenario;
  tracePath?: string;
}

/** Deterministic verification: fresh MCU instance, fast mode, stimuli at exact simulated times. */
export async function runVerification(input: VerifyInput): Promise<VerificationReport> {
  const scenario = ScenarioSchema.parse(input.scenario);
  const t0 = Date.now();
  const hw = new VirtualHardware({
    backend: input.backend,
    board: input.board,
    circuit: input.circuit,
    image: input.image,
    firmware: input.firmware,
    tracePath: input.tracePath,
    keepFullTimeline: true,
    edgeCapPerTick: 1_000_000,
  });
  const warnings: string[] = [];
  try {
    await hw.loadFirmware();
    const known = new Set(input.circuit.components.filter((c) => c.type === 'button').map((c) => c.component_id));
    const stimuli = scenario.stimuli
      .filter((s) => {
        if (!known.has(s.component)) {
          warnings.push(`stimulus ignored: "${s.component}" is not a button in the circuit`);
          return false;
        }
        return true;
      })
      .map((s) => ({ atUs: s.at_ms * 1000, component: s.component, pressed: s.action === 'press' }));
    const snapTimes = [...new Set(scenario.checks.flatMap((c) => (c.type === 'display' ? [c.at_ms, ...(c.changed_since_ms !== undefined ? [c.changed_since_ms] : [])] : [])))];
    if (stimuli.length || snapTimes.length) hw.schedule(stimuli, snapTimes.map((t) => ({ atUs: t * 1000, tag: `d@${t}` })));
    const endUs = scenario.duration_ms * 1000;
    await hw.runUntil(endUs, Math.max(60_000, scenario.duration_ms * 20));
    const timelines: Record<string, Timeline> = {};
    for (const [k, v] of Object.entries(hw.componentTimeline)) timelines[k] = compress(v.filter((e) => e.simUs <= endUs));
    const frames: FrameSet = Object.fromEntries(Object.entries(hw.displaySnapshots).map(([k, v]) => [k, v.displays]));
    const results = scenario.checks.map((c) => evaluateCheck(c, timelines, endUs, hw.uart, frames));
    const displayEvidence: NonNullable<VerificationReport['displayEvidence']> = [];
    if (input.tracePath) {
      for (const [tag, set] of Object.entries(frames)) {
        for (const [id, f] of Object.entries(set)) {
          const png = join(dirname(input.tracePath), `${input.tracePath.split('/').pop()!.replace('.jsonl', '')}_${id}_${tag.replace('@', '')}ms.png`);
          mkdirSync(dirname(png), { recursive: true });
          writeFileSync(png, rgb565Png(decodeFrame(f.b64), f.w, f.h, 2, !(f.on && f.backlight)));
          displayEvidence.push({ component: id, atMs: Number(tag.slice(2)), png, stats: { on: f.on, backlight: f.backlight, ...f.stats } });
        }
      }
    }
    const physical = results.filter((r) => !r.logOnly);
    for (const r of hw.restarts) warnings.push(`MCU restarted at ${ms(r.simUs)} ms: ${r.reason}`);
    if (/Guru Meditation|abort\(\)|panic'ed|Backtrace:/.test(hw.uart)) warnings.push('Firmware panic detected in UART output');
    for (const w of hw.warnings) warnings.push(`circuit: ${w.message}`);
    const passed = physical.length > 0 && results.every((r) => r.passed) && hw.restarts.length === 0;
    if (!physical.length) warnings.push('No physical (GPIO/circuit) check in scenario — UART-only checks cannot pass verification.');
    return {
      verificationId: `ver_${randomUUID().slice(0, 8)}`,
      scenario,
      passed,
      physicalChecks: physical.length,
      scope: 'virtual-simulation',
      results,
      buildId: input.firmware.buildId,
      firmwareSha256: input.firmware.sha256,
      simulatedMs: hw.getState().clock.simUs / 1000,
      wallMs: Date.now() - t0,
      tracePath: input.tracePath,
      timeline: Object.fromEntries(Object.entries(timelines).map(([k, v]) => [k, v.slice(0, 400).map((e) => ({ simUs: Math.round(e.simUs), on: e.lit }))])),
      uartExcerpt: hw.uart.slice(-4000),
      warnings,
      createdAt: nowIso(),
      gpio: Object.fromEntries(Object.entries(hw.gpioTimeline).map(([k, v]) => [k, v.filter((e) => e.simUs <= endUs).slice(0, 300)])),
      finalPins: hw.getState().pins,
      nets: hw.nets,
      inputs: hw.inputTimeline.slice(0, 300),
      displayEvidence,
    };
  } finally {
    await hw.stop();
  }
}
