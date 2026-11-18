// ATmega328P core on avr8js (MIT): real AVR instruction execution with timers, USART and GPIO ports.
// Edges are timestamped with the exact CPU cycle at which the port register changed.
import {
  AVRIOPort,
  AVRSPI,
  spiConfig,
  AVRTimer,
  AVRUSART,
  CPU,
  PinState,
  avrInstruction,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from 'avr8js';
import { createRequire } from 'node:module';
import type { BackendInfo, GpioEdge, McuPinState, SimClock } from '@plugai/shared';
import { ARDUINO_UNO } from '@plugai/shared';
import type { CoreRunResult, McuCore } from '@plugai/simulator/core';

const FREQ = 16_000_000;
const FLASH_BYTES = 0x8000;

export function avr8jsVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    return req('avr8js/package.json').version;
  } catch {
    return 'unknown';
  }
}

export function avrBackendInfo(): BackendInfo {
  return {
    id: 'avr8js',
    name: 'avr8js — ATmega328P (Arduino Uno)',
    version: avr8jsVersion(),
    license: 'MIT',
    description: 'Executes the compiled AVR machine code instruction-by-instruction with Timer0/1/2, USART0 and PORTB/C/D peripherals. Pin changes are captured with exact cycle timestamps (including timer compare-output PWM).',
    capabilities: {
      pause: true,
      step: true,
      inputInjection: true,
      uartRx: true,
      gpioOutputObservation: true,
      pullObservation: true,
      edgeTiming: 'exact-cycle',
      edgeResolutionUs: 1 / 16,
      virtualFlash: ['direct-image-load'],
      pwmToCircuit: true,
    },
  };
}

/** Parse Intel HEX into a flash byte array. Throws on checksum errors. */
export function parseIntelHex(text: string, size = FLASH_BYTES): { flash: Uint8Array; bytes: number } {
  const flash = new Uint8Array(size).fill(0xff);
  let base = 0;
  let bytes = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== ':') throw new Error(`Invalid HEX line: ${line.slice(0, 20)}`);
    const rec = Buffer.from(line.slice(1), 'hex');
    const len = rec[0];
    const addr = (rec[1] << 8) | rec[2];
    const type = rec[3];
    let sum = 0;
    for (const b of rec) sum = (sum + b) & 0xff;
    if (sum !== 0) throw new Error(`HEX checksum error at line ${line.slice(0, 20)}`);
    if (type === 0) {
      for (let i = 0; i < len; i++) {
        const a = base + addr + i;
        if (a >= size) throw new Error(`HEX address 0x${a.toString(16)} beyond flash size`);
        flash[a] = rec[4 + i];
      }
      bytes += len;
    } else if (type === 1) break;
    else if (type === 2) base = ((rec[4] << 8) | rec[5]) << 4;
    else if (type === 4) base = ((rec[4] << 8) | rec[5]) << 16;
  }
  return { flash, bytes };
}

const PORTS = [
  { name: 'B' as const, cfg: portBConfig },
  { name: 'C' as const, cfg: portCConfig },
  { name: 'D' as const, cfg: portDConfig },
];

const PIN_MAP = ARDUINO_UNO.pins.filter((p) => p.role === 'gpio' && p.port).map((p) => ({ id: p.id, port: p.port!.name, bit: p.port!.bit }));
const UART_PINS = new Set(['D0', 'D1']);

export class AvrCore implements McuCore {
  info = avrBackendInfo();
  private flash: Uint8Array | null = null;
  private cpu!: CPU;
  private ports = new Map<string, AVRIOPort>();
  private usart!: AVRUSART;
  private uartOut = '';
  private pendingEdges: GpioEdge[] = [];
  private lastState = new Map<string, string>();
  private inputs = new Map<string, boolean>();
  private rxQueue: number[] = [];
  private spi!: AVRSPI;
  /** Called for every byte the SPI peripheral shifts out (master mode). */
  onSpiByte: ((byte: number, cycles: number) => void) | null = null;
  spiBytes = 0;
  instructions = 0;

  async init() {}

  load(image: Uint8Array) {
    this.flash = image;
    this.powerOn();
  }

  private powerOn() {
    if (!this.flash) throw new Error('No firmware loaded');
    const prog = new Uint16Array(this.flash.buffer.slice(this.flash.byteOffset, this.flash.byteOffset + FLASH_BYTES));
    this.cpu = new CPU(prog, 0x800);
    new AVRTimer(this.cpu, timer0Config);
    new AVRTimer(this.cpu, timer1Config);
    new AVRTimer(this.cpu, timer2Config);
    this.usart = new AVRUSART(this.cpu, usart0Config, FREQ);
    this.usart.onByteTransmit = (b) => {
      this.uartOut += String.fromCharCode(b);
    };
    this.usart.onRxComplete = () => this.feedRx();
    this.spi = new AVRSPI(this.cpu, spiConfig, FREQ);
    this.spi.onByte = (value) => {
      this.spiBytes++;
      this.onSpiByte?.(value, this.cpu.cycles);
      this.cpu.addClockEvent(() => this.spi.completeTransfer(0xff), this.spi.transferCycles);
    };
    this.ports.clear();
    for (const p of PORTS) {
      const port = new AVRIOPort(this.cpu, p.cfg);
      this.ports.set(p.name, port);
      port.addListener(() => this.capture());
    }
    this.lastState.clear();
    this.pendingEdges = [];
    this.uartOut = '';
    this.instructions = 0;
    for (const m of PIN_MAP) {
      this.lastState.set(m.id, this.stateKey(m.id));
      this.ports.get(m.port)!.setPin(m.bit, this.inputs.get(m.id) ?? false);
    }
  }

  private feedRx() {
    if (this.rxQueue.length && !this.usart.rxBusy) this.usart.writeByte(this.rxQueue.shift()!);
  }

  private stateKey(id: string) {
    const m = PIN_MAP.find((x) => x.id === id)!;
    return String(this.ports.get(m.port)!.pinState(m.bit));
  }

  private capture() {
    const cycles = this.cpu.cycles;
    for (const m of PIN_MAP) {
      if (UART_PINS.has(m.id)) continue;
      const s = this.ports.get(m.port)!.pinState(m.bit);
      const key = String(s);
      if (this.lastState.get(m.id) === key) continue;
      const prev = this.lastState.get(m.id);
      this.lastState.set(m.id, key);
      const level: 0 | 1 | 'Z' = s === PinState.High ? 1 : s === PinState.Low ? 0 : 'Z';
      const prevLevel = prev === String(PinState.High) ? 1 : prev === String(PinState.Low) ? 0 : 'Z';
      // pull-up toggles (Input <-> InputPullUp) are config changes, still reported as 'Z' edges once
      if (level === prevLevel && level !== 'Z') continue;
      this.pendingEdges.push({ pin: m.id, level, simUs: cycles / 16, cycles });
    }
  }

  reset() {
    this.powerOn();
  }

  clock(): SimClock {
    const cycles = this.cpu ? this.cpu.cycles : 0;
    return { cycles, cyclesPerUs: 16, simUs: cycles / 16, wallMs: 0, speed: 0, instructions: this.instructions };
  }

  pc() {
    return this.cpu ? this.cpu.pc * 2 : 0;
  }

  pins(): McuPinState[] {
    return PIN_MAP.filter((m) => !UART_PINS.has(m.id)).map((m) => {
      const s = this.ports.get(m.port)!.pinState(m.bit);
      return {
        pin: m.id,
        output: s === PinState.High || s === PinState.Low,
        level: s === PinState.High ? 1 : 0,
        pull: s === PinState.InputPullUp ? 'up' : 'none',
        driver: 'gpio',
      };
    });
  }

  /** Current electrical output of a pad: 0/1 when driven, null when it is an input. */
  pinLevel(pin: string): 0 | 1 | null {
    const m = PIN_MAP.find((x) => x.id === pin);
    if (!m) return null;
    const s = this.ports.get(m.port)!.pinState(m.bit);
    return s === PinState.High ? 1 : s === PinState.Low ? 0 : null;
  }

  setInput(pin: string, level: 0 | 1 | null) {
    const m = PIN_MAP.find((x) => x.id === pin);
    if (!m) throw new Error(`Unknown pin ${pin}`);
    // Floating input on real silicon is undefined; avr8js needs a value — keep LOW unless pulled (circuit supplies the pull).
    const v = level === 1;
    this.inputs.set(pin, v);
    this.ports.get(m.port)!.setPin(m.bit, v);
  }

  uartWrite(data: Uint8Array) {
    this.rxQueue.push(...data);
    this.feedRx();
  }

  run(maxUs: number): CoreRunResult {
    const cpu = this.cpu;
    const target = cpu.cycles + Math.max(1, Math.floor(maxUs * 16));
    let n = 0;
    while (cpu.cycles < target) {
      avrInstruction(cpu);
      cpu.tick();
      n++;
      if (this.pendingEdges.length && (n & 15) === 0) break;
    }
    this.instructions += n;
    const edges = this.pendingEdges;
    this.pendingEdges = [];
    const uart = this.uartOut;
    this.uartOut = '';
    const configChanged = edges.some((e) => e.level === 'Z');
    return { uart, edges, configChanged };
  }

  dispose() {}
}
