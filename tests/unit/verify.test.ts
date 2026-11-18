import { describe, expect, it } from 'vitest';
import { evaluateCheck, normalizeChannel } from '@plugai/simulator';
import { ScenarioSchema } from '@plugai/shared';

const blink = (half: number, n: number, start = 10_000) => {
  const tl = [{ simUs: 0, lit: false }];
  for (let i = 0; i < n; i++) tl.push({ simUs: start + i * half * 1000, lit: i % 2 === 0 });
  return tl;
};

describe('verification engine checks', () => {
  it('period check measures from timestamps and rejects wrong periods', () => {
    const tl = { led1: blink(500, 10) };
    const ok = evaluateCheck({ type: 'period', component: 'led1', period_ms: 1000, tolerance_pct: 1, min_cycles: 2, duty_tolerance: 0.1 } as any, tl, 6_000_000, '');
    expect(ok.passed).toBe(true);
    const bad = evaluateCheck({ type: 'period', component: 'led1', period_ms: 200, tolerance_pct: 5, min_cycles: 2, duty_tolerance: 0.1 } as any, tl, 6_000_000, '');
    expect(bad.passed).toBe(false);
  });

  it('state_during detects flips inside the window', () => {
    const tl = { led1: [{ simUs: 0, lit: false }, { simUs: 1_000_000, lit: true }, { simUs: 1_500_000, lit: false }] };
    expect(evaluateCheck({ type: 'state_during', component: 'led1', state: 'on', from_ms: 1100, to_ms: 1400 }, tl, 3e6, '').passed).toBe(true);
    expect(evaluateCheck({ type: 'state_during', component: 'led1', state: 'on', from_ms: 1100, to_ms: 1600 }, tl, 3e6, '').passed).toBe(false);
  });

  it('pattern check matches a cyclic multi-channel sequence shift-invariantly', () => {
    // red 5s, green 5s, yellow 2s, repeated, starting at 20 ms
    const mk = (on: [number, number][]) => {
      const tl = [{ simUs: 0, lit: false }];
      for (const [a, b] of on) tl.push({ simUs: a, lit: true }, { simUs: b, lit: false });
      return tl;
    };
    const s = 20_000;
    const C = 12_000_000;
    const red = mk([0, 1, 2].map((k) => [s + k * C, s + k * C + 5e6] as [number, number]));
    const green = mk([0, 1, 2].map((k) => [s + k * C + 5e6, s + k * C + 10e6] as [number, number]));
    const yellow = mk([0, 1, 2].map((k) => [s + k * C + 10e6, s + k * C + 12e6] as [number, number]));
    const tl = { 'tl1:red': red, 'tl1:green': green, 'tl1:yellow': yellow };
    const check: any = { type: 'pattern', components: ['tl1:red', 'tl1:yellow', 'tl1:green'], segments: [{ states: { 'tl1:red': 'on', 'tl1:yellow': 'off', 'tl1:green': 'off' }, duration_ms: 5000 }, { states: { 'tl1:red': 'off', 'tl1:yellow': 'off', 'tl1:green': 'on' }, duration_ms: 5000 }, { states: { 'tl1:red': 'off', 'tl1:yellow': 'on', 'tl1:green': 'off' }, duration_ms: 2000 }], cyclic: true, min_repeats: 1, tolerance_ms: 30, tolerance_pct: 3 };
    expect(evaluateCheck(check, tl, 30e6, '').passed).toBe(true);
    const wrongOrder = { ...check, segments: [check.segments[0], check.segments[2], check.segments[1]] };
    expect(evaluateCheck(wrongOrder, tl, 30e6, '').passed).toBe(false);
  });

  it('glitch filter ignores µs transients between sequential pin writes but not real pulses', () => {
    // red off at 5.000000 s, green on 8 µs later: combined state [off,off,off] for 8 µs
    const red = [{ simUs: 0, lit: false }, { simUs: 100, lit: true }, { simUs: 5_000_100, lit: false }, { simUs: 12_000_100, lit: true }, { simUs: 17_000_100, lit: false }, { simUs: 24_000_100, lit: true }];
    const green = [{ simUs: 0, lit: false }, { simUs: 5_000_108, lit: true }, { simUs: 10_000_100, lit: false }, { simUs: 17_000_108, lit: true }, { simUs: 22_000_100, lit: false }];
    const yellow = [{ simUs: 0, lit: false }, { simUs: 10_000_109, lit: true }, { simUs: 12_000_100, lit: false }, { simUs: 22_000_109, lit: true }, { simUs: 24_000_100, lit: false }];
    const check: any = { type: 'pattern', components: ['tl1:red', 'tl1:yellow', 'tl1:green'], segments: [{ states: { 'tl1:red': 'on', 'tl1:yellow': 'off', 'tl1:green': 'off' }, duration_ms: 5000 }, { states: { 'tl1:red': 'off', 'tl1:yellow': 'off', 'tl1:green': 'on' }, duration_ms: 5000 }, { states: { 'tl1:red': 'off', 'tl1:yellow': 'on', 'tl1:green': 'off' }, duration_ms: 2000 }], cyclic: true, min_repeats: 1, tolerance_ms: 30, tolerance_pct: 3, glitch_ms: 1 };
    const tl = { 'tl1:red': red, 'tl1:green': green, 'tl1:yellow': yellow };
    const r = evaluateCheck(check, tl, 26e6, '');
    expect(r.passed).toBe(true);
    expect(r.detail).toMatch(/glitch filter/);
    expect(evaluateCheck({ ...check, glitch_ms: 0 }, tl, 26e6, '').passed).toBe(false);
    // a real 5 ms pulse is not filtered by a 1 ms glitch filter
    const led = { led1: [{ simUs: 0, lit: false }, { simUs: 1_000_000, lit: true }, { simUs: 1_005_000, lit: false }] };
    expect(evaluateCheck({ type: 'state_during', component: 'led1', state: 'off', from_ms: 500, to_ms: 2000, glitch_ms: 1 }, led, 3e6, '').passed).toBe(false);
  });

  it('UART checks are log-only and channels normalise', () => {
    const r = evaluateCheck({ type: 'uart_contains', text: 'LED ON' }, {}, 1e6, 'LED ON\n');
    expect(r.passed).toBe(true);
    expect(r.logOnly).toBe(true);
    expect(normalizeChannel('tl1.R')).toBe('tl1:red');
    expect(normalizeChannel('tl1:amber')).toBe('tl1:yellow');
  });

  it('scenario schema rejects missing checks and absurd durations', () => {
    expect(ScenarioSchema.safeParse({ name: 'x', duration_ms: 1000, checks: [] }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ name: 'x', duration_ms: 10_000_000, checks: [{ type: 'uart_contains', text: 'a' }] }).success).toBe(false);
  });
});
