// P0 probe: run a real ESP-IDF merged flash image in the esp-emu WASM core under Node,
// and observe GPIO pad registers + UART output + emulated cycles.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const pkg = await import(resolve(root, 'third_party/esp-emu-wasm/pkg/esp_emu.js'));
pkg.initSync({ module: readFileSync(resolve(root, 'third_party/esp-emu-wasm/pkg/esp_emu_bg.wasm')) });

const fw = process.argv[2] ?? '/tmp/plugai-probe/esp_blink/build/merged.bin';
const simSeconds = Number(process.argv[3] ?? 3);
const batch = Number(process.argv[4] ?? 2000);

const emu = new pkg.WasmEmulator('esp32c3');
emu.load_default_rom();
emu.set_boot_from_rom(true);
emu.load_firmware(new Uint8Array(readFileSync(fw)));
const cpu = emu.cycles_per_us();
console.log('cycles_per_us', cpu, 'pc', emu.pc().toString(16));

let uart = '';
let prev = Array.from(emu.gpio_state() as Uint32Array);
const edges: { t_ms: number; cycles: number; out: string; en: string }[] = [];
const t0 = performance.now();
let batches = 0;
let pressedAt = -1;
while (emu.cycles() / cpu / 1e6 < simSeconds) {
  uart += emu.run_batch(batch);
  batches++;
  const g = Array.from(emu.gpio_state() as Uint32Array);
  if (g[0] !== prev[0] || g[2] !== prev[2]) {
    edges.push({ t_ms: emu.cycles() / cpu / 1000, cycles: emu.cycles(), out: g[0].toString(2), en: g[2].toString(2) });
    prev = g;
  }
  const tMs = emu.cycles() / cpu / 1000;
  if (pressedAt < 0 && tMs > 1200) { emu.gpio_set_input(5, false); pressedAt = tMs; }
  if (pressedAt > 0 && tMs > 2200) { emu.gpio_set_input(5, true); pressedAt = 1e12; }
  if (emu.needs_restart()) { console.log('needs_restart'); break; }
}
const wall = performance.now() - t0;
// IO_MUX GPIO5 register (pull-up bit 8) and GPIO_IN register
const iomux5 = new DataView(emu.read_memory(0x60009000 + 4 + 4 * 5, 4).buffer).getUint32(0, true);
const gpioIn = new DataView(emu.read_memory(0x6000403c, 4).buffer).getUint32(0, true);
console.log(uart.split('\n').filter((l: string) => /PLUGAI|led=|app_main/.test(l)).join('\n'));
console.log('edges', edges.length);
for (const e of edges.slice(0, 12)) console.log(e);
const led = edges.filter((e) => true);
console.log({ simSeconds, wallMs: Math.round(wall), speed: (simSeconds * 1000) / wall, batches, cycles: emu.cycles(), iomux5: iomux5.toString(16), pullUp: !!(iomux5 & (1 << 8)), gpioIn: gpioIn.toString(2) });
mkdirSync(resolve(root, 'reports/p0'), { recursive: true });
writeFileSync(resolve(root, 'reports/p0/esp-wasm-probe.json'), JSON.stringify({ fw, simSeconds, batch, wallMs: wall, edges: led, uart }, null, 2));
