import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type {
  BackendId,
  BackendInfo,
  BoardId,
  Circuit,
  CircuitWarning,
  ComponentEdge,
  ComponentState,
  FlashMethod,
  GpioEdge,
  InputApplied,
  McuPinState,
  NetLevel,
  SimClock,
  SimSnapshot,
  SimStatus,
  TraceEvent,
} from '@plugai/shared';

export interface FirmwareRef {
  buildId: string;
  sha256: string;
  method: FlashMethod;
  /** Path of the image actually executed (merged bin, virtual flash file or HEX). */
  image: string;
}

export interface TickEvent {
  clock: SimClock;
  edges: GpioEdge[];
  componentEdges: ComponentEdge[];
  inputsApplied: InputApplied[];
  userActions: { simUs: number; component: string; pressed: boolean; source: string }[];
  uart: string;
  truncatedEdges: number;
  pins: McuPinState[];
  components: Record<string, ComponentState>;
  nets: { net_id: string; level: NetLevel; voltage: number | null }[];
  warnings?: CircuitWarning[];
  duty: Record<string, number>;
  pc: number;
  displays?: Record<string, DisplayFrame>;
}

export interface DisplayFrame {
  w: number;
  h: number;
  seq: number;
  powered: boolean;
  on: boolean;
  backlight: boolean;
  ready: boolean;
  /** RGB565 little-endian frame as base64 (what the glass shows). */
  b64: string;
  stats: { bytes: number; commands: number; pixels: number; unknown: number[]; lastCommand: number | null; undefinedDc: number; busBytes: number; deselected: number; inReset: boolean; bus: { cs: string | null; dc: string | null; rst: string | null } };
}

export type HardwareEvent =
  | { type: 'tick'; tick: TickEvent }
  | { type: 'status'; status: SimStatus; reason?: string; error?: string }
  | { type: 'restart'; reason: string; simUs: number };

export interface VirtualHardwareOptions {
  backend: BackendId;
  board: BoardId;
  circuit: Circuit;
  image: Uint8Array;
  firmware: FirmwareRef;
  tracePath?: string;
  /** Max raw GPIO edges forwarded per tick (component edges are never dropped). */
  edgeCapPerTick?: number;
  /** Keep full timelines in memory (verification); otherwise ring-buffered. */
  keepFullTimeline?: boolean;
}

const RING = 20_000;

/**
 * Main-thread handle of one virtual board: MCU core + circuit running in a worker thread.
 * Implements the unified MCUSimulator contract (loadFirmware/start/pause/reset/stop/getState/subscribeEvents/setInputPin).
 */
export class VirtualHardware {
  readonly opts: VirtualHardwareOptions;
  private worker: Worker | null = null;
  private emitter = new EventEmitter();
  private status: SimStatus = 'idle';
  private clock: SimClock = { simUs: 0, cycles: 0, cyclesPerUs: 1, wallMs: 0, speed: 0 };
  private pins: McuPinState[] = [];
  private pc = 0;
  private error?: string;
  info?: BackendInfo;
  components: Record<string, ComponentState> = {};
  nets: TickEvent['nets'] = [];
  warnings: CircuitWarning[] = [];
  lastDuty: Record<string, number> = {};
  /** channel key ("led1", "tl1:red") -> transitions */
  componentTimeline: Record<string, { simUs: number; lit: boolean; brightness: number }[]> = {};
  gpioTimeline: Record<string, { simUs: number; level: 0 | 1 | 'Z' }[]> = {};
  inputTimeline: InputApplied[] = [];
  userActions: TickEvent['userActions'] = [];
  uart = '';
  restarts: { reason: string; simUs: number }[] = [];
  displays: Record<string, DisplayFrame> = {};
  displaySnapshots: Record<string, { simUs: number; displays: Record<string, DisplayFrame> }> = {};
  private snapshotWaiters = new Map<string, (v: Record<string, DisplayFrame>) => void>();
  private seq = 0;
  private trace: WriteStream | null = null;
  private wallStart = Date.now();
  private runForWaiters = new Map<number, (c: SimClock) => void>();
  private reqId = 0;
  edgeCount = 0;

  constructor(opts: VirtualHardwareOptions) {
    this.opts = opts;
  }

  subscribeEvents(cb: (e: HardwareEvent) => void): () => void {
    this.emitter.on('event', cb);
    return () => this.emitter.off('event', cb);
  }

  private emit(e: HardwareEvent) {
    this.emitter.emit('event', e);
  }

  private record(kind: TraceEvent['kind'], simUs: number, data: Record<string, unknown>) {
    if (!this.trace) return;
    const ev: TraceEvent = { seq: this.seq++, simUs: Math.round(simUs * 1000) / 1000, wallMs: Date.now() - this.wallStart, kind, data };
    this.trace.write(JSON.stringify(ev) + '\n');
  }

  async loadFirmware(): Promise<{ info: BackendInfo; clock: SimClock; pins: McuPinState[] }> {
    if (this.worker) throw new Error('Firmware already loaded; stop() first');
    this.status = 'loading';
    this.emit({ type: 'status', status: 'loading' });
    if (this.opts.tracePath) {
      mkdirSync(dirname(this.opts.tracePath), { recursive: true });
      this.trace = createWriteStream(this.opts.tracePath, { flags: 'w' });
    }
    const worker = new Worker(new URL('./hw-worker.ts', import.meta.url), {
      workerData: { backend: this.opts.backend, circuit: this.opts.circuit, image: this.opts.image, edgeCapPerTick: this.opts.edgeCapPerTick ?? 4000 },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    this.worker = worker;
    return await new Promise((resolve, reject) => {
      const onExit = (code: number) => {
        if (this.status !== 'stopped') {
          this.status = code === 0 ? 'stopped' : 'crashed';
          this.error = this.error ?? `Simulator worker exited with code ${code}`;
          this.emit({ type: 'status', status: this.status, error: this.error });
          reject(new Error(this.error));
        }
        this.worker = null;
        this.trace?.end();
        this.trace = null;
      };
      worker.on('exit', onExit);
      worker.on('error', (err) => {
        this.error = `Simulator worker error: ${err.message}`;
        this.status = 'crashed';
        this.emit({ type: 'status', status: 'crashed', error: this.error });
        reject(err);
      });
      worker.on('message', (m: any) => {
        switch (m.type) {
          case 'loaded':
            this.info = m.info;
            this.clock = m.clock;
            this.pins = m.pins;
            this.status = 'loaded';
            if (m.solution) {
              this.components = m.solution.components;
              this.warnings = m.solution.warnings;
              this.nets = m.solution.nets.map((n: any) => ({ net_id: n.net_id, level: n.level, voltage: n.voltage }));
            }
            this.record('status', 0, { status: 'loaded', firmware: this.opts.firmware, backend: m.info?.id, backendVersion: m.info?.version });
            this.emit({ type: 'status', status: 'loaded' });
            resolve({ info: m.info, clock: m.clock, pins: m.pins });
            break;
          case 'tick':
            this.onTick(m);
            break;
          case 'status':
            if (m.clock) this.clock = m.clock;
            this.status = m.status;
            this.record('status', this.clock.simUs, { status: m.status, reason: m.reason });
            this.emit({ type: 'status', status: m.status, reason: m.reason });
            break;
          case 'restart':
            this.restarts.push({ reason: m.reason, simUs: m.clock.simUs });
            this.record('status', m.clock.simUs, { restart: m.reason });
            this.emit({ type: 'restart', reason: m.reason, simUs: m.clock.simUs });
            break;
          case 'display-snapshot': {
            this.displaySnapshots[m.tag] = { simUs: m.simUs, displays: m.displays };
            for (const [k, v] of Object.entries(m.displays as Record<string, DisplayFrame>)) this.displays[k] = v;
            const w = this.snapshotWaiters.get(m.tag);
            this.snapshotWaiters.delete(m.tag);
            w?.(m.displays);
            break;
          }
          case 'runFor-done': {
            this.clock = m.clock;
            const w = this.runForWaiters.get(m.requestId);
            this.runForWaiters.delete(m.requestId);
            w?.(m.clock);
            break;
          }
          case 'error':
            this.error = m.message;
            this.record('error', this.clock.simUs, { message: m.message, fatal: m.fatal });
            if (m.fatal) {
              this.status = this.status === 'loading' ? 'error' : 'crashed';
              this.emit({ type: 'status', status: this.status, error: m.message });
              if (this.status === 'error') reject(new Error(m.message));
              for (const w of this.runForWaiters.values()) w(this.clock);
              this.runForWaiters.clear();
            } else this.emit({ type: 'status', status: this.status, error: m.message });
            break;
        }
      });
    });
  }

  private pushRing<T>(arr: T[], v: T) {
    arr.push(v);
    if (!this.opts.keepFullTimeline && arr.length > RING) arr.splice(0, arr.length - RING);
  }

  private onTick(t: TickEvent) {
    this.clock = t.clock;
    this.pins = t.pins;
    this.pc = t.pc;
    this.components = t.components;
    this.nets = t.nets;
    this.lastDuty = t.duty;
    if (t.warnings) this.warnings = t.warnings;
    if (t.displays) for (const [k, v] of Object.entries(t.displays)) this.displays[k] = v;
    for (const e of t.edges) {
      this.edgeCount++;
      this.pushRing((this.gpioTimeline[e.pin] ??= []), { simUs: e.simUs, level: e.level });
      this.record('gpio', e.simUs, { pin: e.pin, level: e.level, cycles: e.cycles });
    }
    for (const c of t.componentEdges) {
      const key = c.channel ? `${c.component_id}:${c.channel}` : c.component_id;
      this.pushRing((this.componentTimeline[key] ??= []), { simUs: c.simUs, lit: c.lit, brightness: c.brightness });
      this.record('component', c.simUs, { component: key, lit: c.lit, brightness: c.brightness });
    }
    for (const i of t.inputsApplied) {
      this.pushRing(this.inputTimeline, i);
      this.record('input', i.simUs, { pin: i.pin, level: i.level });
    }
    for (const u of t.userActions) {
      this.pushRing(this.userActions, u);
      this.record('user-action', u.simUs, u as unknown as Record<string, unknown>);
    }
    if (t.uart) {
      this.uart += t.uart;
      if (this.uart.length > 2_000_000) this.uart = this.uart.slice(-1_000_000);
      this.record('uart', t.clock.simUs, { text: t.uart });
    }
    if (t.warnings) this.record('circuit', t.clock.simUs, { warnings: t.warnings.map((w) => w.code) });
    this.emit({ type: 'tick', tick: t });
  }

  private send(msg: Record<string, unknown>) {
    if (!this.worker) throw new Error('Simulator is not running (load firmware first)');
    this.worker.postMessage(msg);
  }

  start(mode: 'realtime' | 'fast' = 'realtime', speed = 1) {
    this.send({ cmd: 'start', mode, speed });
  }
  pause() {
    this.send({ cmd: 'pause' });
  }
  reset() {
    this.componentTimeline = {};
    this.gpioTimeline = {};
    this.inputTimeline = [];
    this.userActions = [];
    this.uart = '';
    this.send({ cmd: 'reset' });
  }
  setCircuit(circuit: Circuit) {
    this.opts.circuit = circuit;
    this.send({ cmd: 'setCircuit', circuit });
  }
  pressButton(component: string, pressed: boolean, source = 'user') {
    this.send({ cmd: 'button', component, pressed, source });
  }
  /** Low-level pad override (test hook); null releases the override back to the circuit. */
  setInputPin(pin: string, level: 0 | 1 | null) {
    this.send({ cmd: 'forceInput', pin, level });
  }
  schedule(stimuli: { atUs: number; component: string; pressed: boolean }[], snapshots: { atUs: number; tag: string }[] = []) {
    this.send({ cmd: 'schedule', stimuli, snapshots });
  }
  /** Current display frames (forces a fresh copy from the worker). */
  readDisplays(): Promise<Record<string, DisplayFrame>> {
    const tag = `now_${++this.reqId}`;
    return new Promise((resolve) => {
      this.snapshotWaiters.set(tag, resolve);
      this.send({ cmd: 'displays', tag });
    });
  }
  uartWrite(text: string) {
    this.send({ cmd: 'uart', data: Array.from(Buffer.from(text, 'utf8')) });
  }
  /** Run (as fast as possible) until the given simulated time and pause. */
  runUntil(untilUs: number, timeoutMs = 120_000): Promise<SimClock> {
    const requestId = ++this.reqId;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this.runForWaiters.delete(requestId);
        reject(new Error(`Simulation did not reach ${untilUs / 1000} ms within ${timeoutMs} ms wall time (speed too low or core stalled)`));
      }, timeoutMs);
      this.runForWaiters.set(requestId, (c) => {
        clearTimeout(to);
        if (this.status === 'crashed') reject(new Error(this.error ?? 'simulator crashed'));
        else resolve(c);
      });
      this.send({ cmd: 'runFor', requestId, untilUs });
    });
  }

  async stop(): Promise<void> {
    const w = this.worker;
    if (!w) return;
    this.status = 'stopped';
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        void w.terminate();
        resolve();
      }, 1500);
      w.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        w.postMessage({ cmd: 'stop' });
      } catch {
        void w.terminate();
      }
    });
    this.worker = null;
    this.trace?.end();
    this.trace = null;
    this.emit({ type: 'status', status: 'stopped' });
  }

  get running() {
    return this.status === 'running';
  }

  getState(): SimSnapshot {
    return {
      status: this.status,
      backend: this.opts.backend,
      board: this.opts.board,
      firmware: this.opts.firmware,
      clock: this.clock,
      pins: this.pins,
      pc: this.pc,
      error: this.error,
    };
  }
}
