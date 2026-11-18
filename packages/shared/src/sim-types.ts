import type { BackendId, BoardId, FlashMethod } from './index.ts';
import type { CircuitSolution, ComponentState, McuPinState, NetLevel } from './circuit-types.ts';

export type SimStatus = 'idle' | 'loading' | 'loaded' | 'running' | 'paused' | 'stopped' | 'crashed' | 'error';

export interface BackendCapabilities {
  pause: boolean;
  step: boolean;
  inputInjection: boolean;
  uartRx: boolean;
  gpioOutputObservation: boolean;
  pullObservation: boolean;
  /** How GPIO edges are timestamped. */
  edgeTiming: 'exact-cycle' | 'batch-sampled';
  /** Worst-case edge timestamp error in microseconds (documented). */
  edgeResolutionUs: number;
  virtualFlash: FlashMethod[];
  pwmToCircuit: boolean;
}

export interface BackendInfo {
  id: BackendId;
  name: string;
  version: string;
  license: string;
  description: string;
  capabilities: BackendCapabilities;
}

export interface SimClock {
  /** Simulated time since MCU reset, microseconds (derived from CPU cycles). */
  simUs: number;
  cycles: number;
  cyclesPerUs: number;
  /** Wall-clock ms the MCU has been running (excludes paused time). */
  wallMs: number;
  /** simulated / wall speed ratio over the last window. */
  speed: number;
  instructions?: number;
}

export interface GpioEdge {
  pin: string;
  /** new level of the pad output (or 'Z' when output disabled) */
  level: 0 | 1 | 'Z';
  simUs: number;
  cycles: number;
}

export interface SimSnapshot {
  status: SimStatus;
  backend: BackendId;
  board: BoardId;
  firmware?: { buildId: string; sha256: string; method: FlashMethod; image: string };
  clock: SimClock;
  pins: McuPinState[];
  pc?: number;
  error?: string;
}

export type SimWorkerEvent =
  | { type: 'loaded'; info: Record<string, unknown>; pins: McuPinState[]; clock: SimClock }
  | { type: 'tick'; clock: SimClock; edges: GpioEdge[]; pins: McuPinState[]; uart: string; inputsApplied: InputApplied[]; pc?: number }
  | { type: 'status'; status: SimStatus; clock: SimClock; reason?: string }
  | { type: 'error'; message: string; fatal: boolean; clock?: SimClock }
  | { type: 'restart'; reason: string; clock: SimClock }
  | { type: 'runFor-done'; requestId: number; clock: SimClock };

export interface InputApplied {
  pin: string;
  level: 0 | 1 | null;
  simUs: number;
}

/** A component-level state change derived by the circuit solver from MCU outputs. */
export interface ComponentEdge {
  component_id: string;
  channel?: string;
  lit: boolean;
  brightness: number;
  simUs: number;
}

export interface TraceEvent {
  seq: number;
  simUs: number;
  wallMs: number;
  kind: 'gpio' | 'input' | 'component' | 'uart' | 'status' | 'circuit' | 'user-action' | 'error';
  data: Record<string, unknown>;
}

/** Messages the server pushes to the browser over WebSocket. */
export type ServerPush =
  | { type: 'sim.snapshot'; projectId: string; snapshot: SimSnapshot }
  | { type: 'sim.frame'; projectId: string; clock: SimClock; pins: McuPinState[]; edges: GpioEdge[]; components: Record<string, ComponentState>; nets: { net_id: string; level: NetLevel; voltage: number | null }[]; duty: Record<string, number> }
  | { type: 'sim.uart'; projectId: string; data: string; simUs: number }
  | { type: 'sim.status'; projectId: string; status: SimStatus; reason?: string; error?: string }
  | { type: 'circuit.updated'; projectId: string; circuit: unknown; solution: CircuitSolution }
  | { type: 'project.updated'; projectId: string; reason: string }
  | { type: 'build.log'; projectId: string; buildId: string; chunk: string }
  | { type: 'build.done'; projectId: string; build: unknown }
  | { type: 'flash.progress'; projectId: string; flashId: string; step: string; status: string; detail?: string }
  | { type: 'flash.done'; projectId: string; flash: unknown }
  | { type: 'agent.event'; projectId: string; runId: string; event: unknown }
  | { type: 'hello'; serverTime: string };
