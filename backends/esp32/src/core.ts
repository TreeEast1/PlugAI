// ESP32-C3 MCU core: drives Espressif's esp-emu WebAssembly build (Apache-2.0) headless.
// The emulator executes the real mask ROM, the IDF 2nd-stage bootloader and the app from the
// flash image. GPIO pad state is read from the emulated GPIO / IO_MUX registers.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendInfo, GpioEdge, McuPinState, SimClock } from '@plugai/shared';
import { ESP32C3_DEVKITM_1 } from '@plugai/shared';
import type { McuCore, CoreRunResult } from '@plugai/simulator/core';

const here = dirname(fileURLToPath(import.meta.url));
export const PLUGAI_ROOT = process.env.PLUGAI_ROOT ?? resolve(here, '../../..');
export const ESP_WASM_DIR = process.env.ESP_EMU_WASM_DIR ?? resolve(PLUGAI_ROOT, 'third_party/esp-emu-wasm/pkg');

const GPIO_BASE = 0x60004000;
const GPIO_PIN_REG = GPIO_BASE + 0x74;
const GPIO_FUNC_OUT_SEL = GPIO_BASE + 0x554;
const IO_MUX_GPIO0 = 0x60009004;
const SIG_GPIO_OUT_IDX = 128;
const NUM_GPIO = 22;
/** Pins that belong to the board model (strings like "GPIO4"). */
const BOARD_GPIOS = ESP32C3_DEVKITM_1.pins.filter((p) => p.role === 'gpio').map((p) => p.gpio!);
/** UART0 console pads are driven by the UART peripheral; reported separately as UART. */
const UART_PADS = new Set([20, 21]);

let wasmPkg: any = null;
export function wasmVersion(): string {
  try {
    return readFileSync(resolve(ESP_WASM_DIR, '../VERSION'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

async function loadWasm() {
  if (wasmPkg) return wasmPkg;
  const js = resolve(ESP_WASM_DIR, 'esp_emu.js');
  if (!existsSync(js)) throw new Error(`esp-emu WASM bundle not found at ${ESP_WASM_DIR}. Run: npm run setup`);
  const mod = await import(js);
  mod.initSync({ module: readFileSync(resolve(ESP_WASM_DIR, 'esp_emu_bg.wasm')) });
  wasmPkg = mod;
  return mod;
}

export function espBackendInfo(): BackendInfo {
  return {
    id: 'esp32c3-esp-emu-wasm',
    name: 'Espressif esp-emu (WebAssembly core) — ESP32-C3',
    version: wasmVersion(),
    license: 'Apache-2.0 (esp-emu release bundle, unmodified; downloaded at setup time)',
    description:
      'Executes the real ESP32-C3 mask ROM, ESP-IDF bootloader and application (RV32IMC). GPIO pad state is read from GPIO_OUT/GPIO_ENABLE/FUNC_OUT_SEL/IO_MUX registers; inputs are driven with gpio_set_input().',
    capabilities: {
      pause: true,
      step: true,
      inputInjection: true,
      uartRx: true,
      gpioOutputObservation: true,
      pullObservation: true,
      edgeTiming: 'batch-sampled',
      edgeResolutionUs: 12.5,
      virtualFlash: ['esptool-virtual-uart', 'direct-image-load'],
      pwmToCircuit: false,
    },
  };
}

export class Esp32c3Core implements McuCore {
  info = espBackendInfo();
  private emu: any = null;
  private image: Uint8Array | null = null;
  private cyclesPerUs = 160;
  private prevOut = 0;
  private prevEn = 0;
  private pinCache: McuPinState[] = [];
  private batch = 2000;
  private regPollEvery = 8;
  private batchCount = 0;
  private inputs = new Map<number, boolean>();
  instructions = 0;

  async init() {
    await loadWasm();
  }

  load(image: Uint8Array) {
    this.image = image;
    this.powerOn();
  }

  private powerOn() {
    if (!this.image) throw new Error('No firmware image loaded');
    if (this.emu) {
      try {
        this.emu.free();
      } catch {
        /* ignore */
      }
    }
    const emu = new wasmPkg.WasmEmulator('esp32c3');
    emu.load_default_rom();
    emu.set_boot_from_rom(true);
    emu.load_firmware(this.image);
    this.emu = emu;
    this.cyclesPerUs = emu.cycles_per_us();
    this.prevOut = 0;
    this.prevEn = 0;
    this.instructions = 0;
    this.batchCount = 0;
    for (const [pin, high] of this.inputs) emu.gpio_set_input(pin, high);
    this.readPins(true);
  }

  reset() {
    this.powerOn();
  }

  clock(): SimClock {
    const cycles = this.emu ? Number(this.emu.cycles()) : 0;
    return { cycles, cyclesPerUs: this.cyclesPerUs, simUs: cycles / this.cyclesPerUs, wallMs: 0, speed: 0, instructions: this.instructions };
  }

  pc(): number {
    return this.emu ? this.emu.pc() : 0;
  }

  private u32(addr: number, n: number): Uint32Array {
    const bytes: Uint8Array = this.emu.read_memory(addr, n * 4);
    return new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + n * 4));
  }

  private readPins(force: boolean): McuPinState[] {
    const g: Uint32Array = this.emu.gpio_state();
    const out = g[0] >>> 0;
    const en = g[2] >>> 0;
    if (force || this.pinCache.length === 0 || this.batchCount % this.regPollEvery === 0) {
      const mux = this.u32(IO_MUX_GPIO0, NUM_GPIO);
      const sel = this.u32(GPIO_FUNC_OUT_SEL, NUM_GPIO);
      const pinReg = this.u32(GPIO_PIN_REG, NUM_GPIO);
      this.pinCache = BOARD_GPIOS.filter((n) => !UART_PADS.has(n)).map((n) => {
        const m = mux[n];
        const outSel = sel[n] & 0xff;
        const pull: McuPinState['pull'] = m & (1 << 8) ? 'up' : m & (1 << 7) ? 'down' : 'none';
        return {
          pin: `GPIO${n}`,
          output: false,
          level: 0 as 0 | 1,
          pull,
          driver: outSel === SIG_GPIO_OUT_IDX ? 'gpio' : 'peripheral',
          signal: outSel,
          openDrain: !!(pinReg[n] & (1 << 2)),
        };
      });
    }
    for (const p of this.pinCache) {
      const n = Number(p.pin.slice(4));
      p.output = !!(en & (1 << n));
      p.level = out & (1 << n) ? 1 : 0;
    }
    return this.pinCache;
  }

  pins(): McuPinState[] {
    return this.readPins(false).map((p) => ({ ...p }));
  }

  setInput(pin: string, level: 0 | 1 | null) {
    const n = Number(pin.replace(/^GPIO/, ''));
    if (!Number.isInteger(n)) throw new Error(`Bad pin ${pin}`);
    // A floating pad keeps the emulator's default (pulled-high) input.
    const high = level === null ? true : level === 1;
    this.inputs.set(n, high);
    this.emu.gpio_set_input(n, high);
  }

  uartWrite(data: Uint8Array) {
    this.emu.uart_input(data);
  }

  /**
   * Run until `maxUs` of simulated time elapsed or a pad-level change was observed.
   * Pad registers are sampled after every batch of `batch` instructions.
   */
  run(maxUs: number): CoreRunResult {
    const emu = this.emu;
    const target = Number(emu.cycles()) + Math.max(1, Math.floor(maxUs * this.cyclesPerUs));
    let uart = '';
    const edges: GpioEdge[] = [];
    let restarted: string | undefined;
    let pullChanged = false;
    while (Number(emu.cycles()) < target) {
      uart += emu.run_batch(this.batch);
      this.instructions += this.batch;
      this.batchCount++;
      if (emu.needs_restart()) {
        emu.restart();
        restarted = 'firmware requested restart (esp_restart / panic / watchdog)';
        this.readPins(true);
        break;
      }
      const g: Uint32Array = emu.gpio_state();
      const out = g[0] >>> 0;
      const en = g[2] >>> 0;
      const pollRegs = this.batchCount % this.regPollEvery === 0;
      if (out !== this.prevOut || en !== this.prevEn || pollRegs) {
        const before = this.pinCache.map((p) => `${p.pull}${p.driver}${p.openDrain}`).join();
        this.readPins(out !== this.prevOut || en !== this.prevEn);
        if (pollRegs) {
          const after = this.pinCache.map((p) => `${p.pull}${p.driver}${p.openDrain}`).join();
          if (after !== before) pullChanged = true;
        }
        const changed = (out ^ this.prevOut) | (en ^ this.prevEn);
        if (changed) {
          const cycles = Number(emu.cycles());
          for (const n of BOARD_GPIOS) {
            if (UART_PADS.has(n) || !(changed & (1 << n))) continue;
            edges.push({ pin: `GPIO${n}`, level: en & (1 << n) ? (out & (1 << n) ? 1 : 0) : 'Z', simUs: cycles / this.cyclesPerUs, cycles });
          }
          this.prevOut = out;
          this.prevEn = en;
        }
        if (edges.length || pullChanged) break;
      }
    }
    return { uart, edges, restarted, configChanged: pullChanged };
  }

  dispose() {
    try {
      this.emu?.free();
    } catch {
      /* ignore */
    }
    this.emu = null;
  }
}
