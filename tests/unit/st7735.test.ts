import { describe, expect, it } from 'vitest';
import { St7735, LCD_W } from '../../packages/simulator/src/devices/st7735.ts';
import { applyOps, createCircuit, solveCircuit } from '@plugai/circuit';

const send = (d: St7735, c: number, ...data: number[]) => {
  d.write(c, 0);
  for (const b of data) d.write(b, 1);
};

describe('ST7735 controller model', () => {
  it('is dark until SLPOUT + DISPON and draws RGB565 into the address window', () => {
    const d = new St7735();
    expect(d.visible().every((p) => p === 0)).toBe(true);
    send(d, 0x11);
    send(d, 0x3a, 0x05);
    send(d, 0x29);
    expect(d.visible().some((p) => p !== 0)).toBe(true); // power-on noise is visible until cleared
    send(d, 0x2a, 0, 10, 0, 11);
    send(d, 0x2b, 0, 20, 0, 20);
    send(d, 0x2c, 0xf8, 0x00, 0x07, 0xe0);
    expect(d.fb[20 * LCD_W + 10]).toBe(0xf800);
    expect(d.fb[20 * LCD_W + 11]).toBe(0x07e0);
  });
  it('honours MADCTL mirroring and BGR, and RGB666', () => {
    const d = new St7735();
    send(d, 0x36, 0x40 | 0x08);
    send(d, 0x3a, 0x06);
    send(d, 0x2a, 0, 0, 0, 0);
    send(d, 0x2b, 0, 0, 0, 0);
    send(d, 0x2c, 0xfc, 0x00, 0x00); // red in RGB666 → BGR swap → blue at mirrored x
    expect(d.fb[127]).toBe(0x001f);
  });
  it('circuit binding requires hardware SPI pins and power', () => {
    const base = applyOps(createCircuit('arduino-uno'), [
      { op: 'add_component', type: 'lcd', component_id: 'lcd1' },
      { op: 'connect', from: 'lcd1.VCC', to: 'board.5V' },
      { op: 'connect', from: 'lcd1.GND', to: 'board.GND1' },
      { op: 'connect', from: 'lcd1.SCK', to: 'board.D13' },
      { op: 'connect', from: 'lcd1.SDA', to: 'board.D11' },
      { op: 'connect', from: 'lcd1.CS', to: 'board.D10' },
      { op: 'connect', from: 'lcd1.DC', to: 'board.D9' },
      { op: 'connect', from: 'lcd1.RST', to: 'board.D8' },
      { op: 'connect', from: 'lcd1.BL', to: 'board.5V' },
    ]).circuit;
    expect(solveCircuit({ circuit: base, mcuPins: [] }).components.lcd1.lcd!.ready).toBe(true);
    const wrong = applyOps(base, [{ op: 'disconnect_pin', pin: 'lcd1.SCK' }, { op: 'connect', from: 'lcd1.SCK', to: 'board.D12' }]).circuit;
    const s = solveCircuit({ circuit: wrong, mcuPins: [] });
    expect(s.components.lcd1.lcd!.ready).toBe(false);
    expect(s.warnings.some((w) => /D13/.test(w.message))).toBe(true);
    const esp = applyOps(createCircuit('esp32c3-devkitm-1'), [{ op: 'add_component', type: 'lcd', component_id: 'lcd1' }]).circuit;
    expect(solveCircuit({ circuit: esp, mcuPins: [] }).warnings.some((w) => w.code === 'NOT_SIMULATED')).toBe(true);
  });
});
