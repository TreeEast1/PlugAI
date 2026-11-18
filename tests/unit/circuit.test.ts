import { describe, expect, it } from 'vitest';
import { applyOps, createCircuit, solveCircuit, CircuitError } from '@plugai/circuit';
import type { Circuit, McuPinState } from '@plugai/shared';

const out = (pin: string, level: 0 | 1): McuPinState => ({ pin, output: true, level, pull: 'none' });
const inp = (pin: string, pull: 'up' | 'down' | 'none' = 'none'): McuPinState => ({ pin, output: false, level: 0, pull });

function ledCircuit(gpio = 'GPIO4', reversed = false): Circuit {
  return applyOps(createCircuit('esp32c3-devkitm-1'), [
    { op: 'add_component', type: 'led', component_id: 'led1', props: { color: 'red' } },
    { op: 'add_component', type: 'resistor', component_id: 'r1', props: { ohms: 220 } },
    { op: 'connect', from: `board.${gpio}`, to: 'r1.1' },
    { op: 'connect', from: 'r1.2', to: reversed ? 'led1.K' : 'led1.A' },
    { op: 'connect', from: reversed ? 'led1.A' : 'led1.K', to: 'board.J3_GND4' },
  ]).circuit;
}

describe('circuit solver', () => {
  it('lights an LED when GPIO is HIGH and not when LOW', () => {
    const c = ledCircuit();
    const hi = solveCircuit({ circuit: c, mcuPins: [out('GPIO4', 1)] });
    expect(hi.components.led1.lit).toBe(true);
    expect(hi.components.led1.currentMa!).toBeGreaterThan(4);
    expect(hi.components.led1.currentMa!).toBeLessThan(8);
    const lo = solveCircuit({ circuit: c, mcuPins: [out('GPIO4', 0)] });
    expect(lo.components.led1.lit).toBe(false);
    expect(lo.nets.find((n) => n.net_id === 'NET_GPIO4')!.level).toBe('LOW');
  });

  it('does not light when the GPIO pad is an input (Hi-Z)', () => {
    const s = solveCircuit({ circuit: ledCircuit(), mcuPins: [inp('GPIO4')] });
    expect(s.components.led1.lit).toBe(false);
  });

  it('reversed LED does not light and warns', () => {
    const s = solveCircuit({ circuit: ledCircuit('GPIO4', true), mcuPins: [out('GPIO4', 1)] });
    expect(s.components.led1.lit).toBe(false);
    expect(s.warnings.some((w) => w.code === 'LED_REVERSED')).toBe(true);
  });

  it('disconnected LED never lights', () => {
    const c = applyOps(ledCircuit(), [{ op: 'disconnect_pin', pin: 'board.GPIO4' }]).circuit;
    const s = solveCircuit({ circuit: c, mcuPins: [out('GPIO4', 1)] });
    expect(s.components.led1.lit).toBe(false);
  });

  it('LED wired to a different (idle) GPIO does not follow GPIO4', () => {
    const c = ledCircuit('GPIO6');
    const s = solveCircuit({ circuit: c, mcuPins: [out('GPIO4', 1), inp('GPIO6')] });
    expect(s.components.led1.lit).toBe(false);
  });

  it('flags a missing current-limiting resistor', () => {
    const c = applyOps(createCircuit('esp32c3-devkitm-1'), [
      { op: 'add_component', type: 'led', component_id: 'led1' },
      { op: 'connect', from: 'board.GPIO4', to: 'led1.A' },
      { op: 'connect', from: 'led1.K', to: 'board.J3_GND1' },
    ]).circuit;
    const s = solveCircuit({ circuit: c, mcuPins: [out('GPIO4', 1)] });
    expect(s.warnings.some((w) => w.code === 'LED_NO_RESISTOR')).toBe(true);
    expect(s.warnings.some((w) => w.code === 'LED_OVERCURRENT')).toBe(true);
  });

  it('button with internal pull-up reads HIGH released, LOW pressed', () => {
    const c = applyOps(createCircuit('esp32c3-devkitm-1'), [
      { op: 'add_component', type: 'button', component_id: 'btn1' },
      { op: 'connect', from: 'board.GPIO5', to: 'btn1.1' },
      { op: 'connect', from: 'btn1.2', to: 'board.J3_GND2' },
    ]).circuit;
    const rel = solveCircuit({ circuit: c, mcuPins: [inp('GPIO5', 'up')], buttons: { btn1: false } });
    expect(rel.mcuInputs.find((i) => i.pin === 'GPIO5')!.level).toBe(1);
    const pr = solveCircuit({ circuit: c, mcuPins: [inp('GPIO5', 'up')], buttons: { btn1: true } });
    expect(pr.mcuInputs.find((i) => i.pin === 'GPIO5')!.level).toBe(0);
    const noPull = solveCircuit({ circuit: c, mcuPins: [inp('GPIO5', 'none')], buttons: { btn1: false } });
    expect(noPull.mcuInputs.find((i) => i.pin === 'GPIO5')!.level).toBe(null);
    expect(noPull.warnings.some((w) => w.code === 'FLOATING_INPUT')).toBe(true);
  });

  it('detects output conflicts and over-voltage', () => {
    const c = applyOps(createCircuit('esp32c3-devkitm-1'), [
      { op: 'connect', from: 'board.GPIO4', to: 'board.GPIO5' },
      { op: 'connect', from: 'board.GPIO6', to: 'board.5V' },
    ]).circuit;
    const s = solveCircuit({ circuit: c, mcuPins: [out('GPIO4', 1), out('GPIO5', 0), inp('GPIO6')] });
    expect(s.warnings.some((w) => w.code === 'NET_CONFLICT')).toBe(true);
    expect(s.warnings.some((w) => w.code === 'OVERVOLTAGE')).toBe(true);
  });

  it('traffic light module channels follow their pins', () => {
    const c = applyOps(createCircuit('esp32c3-devkitm-1'), [
      { op: 'add_component', type: 'traffic-light', component_id: 'tl1' },
      { op: 'connect', from: 'board.GPIO4', to: 'tl1.R' },
      { op: 'connect', from: 'board.GPIO5', to: 'tl1.Y' },
      { op: 'connect', from: 'board.GPIO6', to: 'tl1.G' },
      { op: 'connect', from: 'tl1.GND', to: 'board.J3_GND4' },
    ]).circuit;
    const s = solveCircuit({ circuit: c, mcuPins: [out('GPIO4', 1), out('GPIO5', 0), out('GPIO6', 1)] });
    expect(s.components.tl1.channels!.red.lit).toBe(true);
    expect(s.components.tl1.channels!.yellow.lit).toBe(false);
    expect(s.components.tl1.channels!.green.lit).toBe(true);
  });

  it('rejects invalid operations atomically', () => {
    const c = createCircuit('esp32c3-devkitm-1');
    expect(() => applyOps(c, [{ op: 'connect', from: 'board.GPIO99', to: 'board.GND' }])).toThrow(CircuitError);
    expect(() => applyOps(c, [{ op: 'add_component', type: 'led', component_id: 'x1' }, { op: 'connect', from: 'x1.Z', to: 'board.GPIO4' }])).toThrow(CircuitError);
    expect(c.components.length).toBe(1);
  });

  it('Arduino Uno 5V LED circuit', () => {
    const c = applyOps(createCircuit('arduino-uno'), [
      { op: 'add_component', type: 'led', component_id: 'led1' },
      { op: 'add_component', type: 'resistor', component_id: 'r1', props: { ohms: 330 } },
      { op: 'connect', from: 'board.D4', to: 'r1.1' },
      { op: 'connect', from: 'r1.2', to: 'led1.A' },
      { op: 'connect', from: 'led1.K', to: 'board.GND1' },
    ]).circuit;
    const s = solveCircuit({ circuit: c, mcuPins: [out('D4', 1)] });
    expect(s.components.led1.lit).toBe(true);
    expect(s.components.led1.currentMa!).toBeGreaterThan(7);
  });
});
