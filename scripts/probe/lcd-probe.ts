import { mkdirSync, cpSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildAvr, avrDirectLoad } from '@plugai/backend-avr';
import { applyOps, createCircuit } from '@plugai/circuit';
import { runVerification } from '@plugai/simulator';
const root = resolve(import.meta.dirname, '../..');
const dir = join(root, 'workspaces/tests/lcd-probe');
mkdirSync(join(dir, 'firmware/sketch'), { recursive: true });
cpSync(join(root, 'firmware-examples/fixtures/uno/lcd_face/sketch.ino'), join(dir, 'firmware/sketch/sketch.ino'));
const b = await buildAvr({ projectId: 'lcd', projectDir: dir, buildId: 'b1' });
console.log('build', b.status, b.error ?? '', b.sizeInfo);
const wired = (extra: any[] = []) => applyOps(createCircuit('arduino-uno'), [
  { op: 'add_component', type: 'lcd', component_id: 'lcd1' },
  { op: 'connect', from: 'lcd1.VCC', to: 'board.5V' }, { op: 'connect', from: 'lcd1.GND', to: 'board.GND1' },
  { op: 'connect', from: 'lcd1.SCK', to: 'board.D13' }, { op: 'connect', from: 'lcd1.SDA', to: 'board.D11' },
  { op: 'connect', from: 'lcd1.CS', to: 'board.D10' }, { op: 'connect', from: 'lcd1.DC', to: 'board.D9' },
  { op: 'connect', from: 'lcd1.RST', to: 'board.D8' }, { op: 'connect', from: 'lcd1.BL', to: 'board.5V' }, ...extra]).circuit;
const { image, record } = avrDirectLoad('lcd', dir, b);
for (const [name, circuit] of [['wired', wired()], ['dc-miswired', applyOps(wired(), [{ op: 'disconnect_pin', pin: 'lcd1.DC' }, { op: 'connect', from: 'lcd1.DC', to: 'board.D7' }]).circuit]] as const) {
  const rep = await runVerification({ backend: 'avr8js', board: 'arduino-uno', circuit, image, firmware: { buildId: 'b1', sha256: record.flashImageAfter!.sha256, method: 'direct-image-load', image: 'hex' },
    scenario: { name: 'face', duration_ms: 3500, stimuli: [], checks: [
      { type: 'display', component: 'lcd1', at_ms: 1500, min_nonblack_pct: 30, colors: [{ hex: '#ffff00', min_pct: 20 }, { hex: '#ff0000', min_pct: 2 }] },
      { type: 'display', component: 'lcd1', at_ms: 2000, changed_since_ms: 1500 } as any] },
    tracePath: join(dir, `trace-${name}.jsonl`) });
  console.log(name, rep.passed, rep.wallMs + 'ms', rep.results.map((r) => r.detail).join('\n   '));
  console.log('  png:', rep.displayEvidence?.map((d) => d.png.replace(root + '/', '')).join(', '));
}
