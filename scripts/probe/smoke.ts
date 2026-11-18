import 'dotenv/config';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildEsp32, ensureEspScaffold } from '@plugai/backend-esp32';
import { applyOps, createCircuit } from '@plugai/circuit';
import { runVerification } from '@plugai/simulator';

const root = resolve(import.meta.dirname, '../..');
const dir = join(root, 'workspaces', 'smoke', 'esp_blink');
mkdirSync(dir, { recursive: true });
ensureEspScaffold(dir);
writeFileSync(
  join(dir, 'firmware/main/main.c'),
  `#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include <stdio.h>
void app_main(void) {
  gpio_reset_pin(4); gpio_set_direction(4, GPIO_MODE_OUTPUT);
  int on = 0;
  while (1) { on = !on; gpio_set_level(4, on); printf("led %d\\n", on); vTaskDelay(pdMS_TO_TICKS(500)); }
}
`,
);
const t = Date.now();
const b = await buildEsp32({ projectId: 'smoke', projectDir: dir, buildId: 'b1', onLog: () => {} });
console.log('build', b.status, b.error, Date.now() - t, 'ms', b.artifacts.map((a) => `${a.name}:${a.sha256.slice(0, 8)}`));
if (b.status !== 'success') process.exit(1);
const circuit = applyOps(createCircuit('esp32c3-devkitm-1'), [
  { op: 'add_component', type: 'led', component_id: 'led1' },
  { op: 'add_component', type: 'resistor', component_id: 'r1' },
  { op: 'connect', from: 'board.GPIO4', to: 'r1.1' },
  { op: 'connect', from: 'r1.2', to: 'led1.A' },
  { op: 'connect', from: 'led1.K', to: 'board.J3_GND4' },
]).circuit;
const merged = b.artifacts.find((a) => a.kind === 'merged-bin')!;
const rep = await runVerification({
  backend: 'esp32c3-esp-emu-wasm',
  board: 'esp32c3-devkitm-1',
  circuit,
  image: new Uint8Array(readFileSync(join(dir, merged.path))),
  firmware: { buildId: b.buildId, sha256: merged.sha256, method: 'direct-image-load', image: merged.path },
  scenario: { name: 'blink', duration_ms: 4000, stimuli: [], checks: [{ type: 'period', component: 'led1', period_ms: 1000, tolerance_pct: 2, min_cycles: 2, duty: 0.5, duty_tolerance: 0.05 } as any] },
  tracePath: join(dir, 'trace.jsonl'),
});
console.log(JSON.stringify({ passed: rep.passed, results: rep.results.map((r) => r.detail), wallMs: rep.wallMs, simMs: rep.simulatedMs, warnings: rep.warnings, tl: rep.timeline.led1?.slice(0, 6) }, null, 2));
