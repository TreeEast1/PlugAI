import type { BoardId } from './index.ts';

export type ComponentType = 'board' | 'led' | 'resistor' | 'button' | 'traffic-light' | 'lcd';

export type SignalType = 'digital' | 'power' | 'ground' | 'passive' | 'anode' | 'cathode';
export type PinDirection = 'in' | 'out' | 'inout' | 'passive' | 'power';

export interface ComponentPin {
  pin_id: string;
  label: string;
  signal_type: SignalType;
  direction: PinDirection;
  /** Filled by the solver: id of the net this pin belongs to (null = unconnected). */
  connected_net?: string | null;
  voltage_domain?: number;
  /** Filled by the solver. */
  current_state?: NetLevel;
}

export interface CircuitComponent {
  component_id: string;
  type: ComponentType;
  /** Part number / model, e.g. "LED-5MM-RED", "R-0603", "ESP32-C3-DevKitM-1". */
  model: string;
  label?: string;
  /** Visual parameters only (position, rotation, colour). */
  appearance: { x: number; y: number; rotation?: 0 | 90 | 180 | 270; color?: string };
  /** Electrical properties (resistance, forward voltage, ...). */
  props: Record<string, number | string | boolean>;
  board?: BoardId;
}

export interface WireEnd {
  component_id: string;
  pin_id: string;
}

export interface Wire {
  wire_id: string;
  from: WireEnd;
  to: WireEnd;
  color?: string;
  /** Optional intermediate waypoints for rendering only. */
  points?: { x: number; y: number }[];
}

export interface Circuit {
  version: 1;
  board: BoardId;
  components: CircuitComponent[];
  wires: Wire[];
}

/** Digital interpretation of a net. */
export type NetLevel = 'HIGH' | 'LOW' | 'Z' | 'UNDEFINED' | 'CONFLICT' | 'UNCONNECTED';

export interface NetState {
  net_id: string;
  pins: string[]; // "component_id.pin_id"
  voltage: number | null;
  level: NetLevel;
  floating: boolean;
  drivers: string[];
}

export interface ComponentState {
  component_id: string;
  type: ComponentType;
  /** LEDs: is the diode conducting enough to emit visible light? */
  lit?: boolean;
  /** 0..1 instantaneous relative brightness (from forward current). */
  brightness?: number;
  currentMa?: number;
  forwardV?: number;
  /** Buttons: pressed? */
  pressed?: boolean;
  /** Per-channel state for multi-LED parts. */
  channels?: Record<string, { lit: boolean; brightness: number; currentMa: number }>;
  /** LCD: power, backlight and the SPI bus binding derived from the wiring. */
  lcd?: { powered: boolean; backlight: boolean; bus: { sck: boolean; mosi: boolean; cs: string | null; dc: string | null; rst: string | null }; ready: boolean };
  warnings?: string[];
}

export interface CircuitWarning {
  severity: 'info' | 'warning' | 'danger';
  code:
    | 'LED_REVERSED'
    | 'LED_NO_RESISTOR'
    | 'LED_OVERCURRENT'
    | 'GPIO_OVERCURRENT'
    | 'NET_CONFLICT'
    | 'OVERVOLTAGE'
    | 'FLOATING_INPUT'
    | 'UNCONNECTED_PIN'
    | 'SHORT_CIRCUIT'
    | 'RESERVED_PIN'
    | 'NOT_SIMULATED';
  message: string;
  component_id?: string;
  net_id?: string;
}

/** MCU pad state as reported by a simulator backend (source of truth for outputs). */
export interface McuPinState {
  /** Board pin id, e.g. "GPIO4" or "D13". */
  pin: string;
  /** Pad output driver enabled. */
  output: boolean;
  /** Output register level (meaningful when output=true). */
  level: 0 | 1;
  pull: 'up' | 'down' | 'none';
  /**
   * 'gpio' = level comes from the GPIO output register (observable).
   * 'peripheral' = pad is routed to a peripheral signal (e.g. LEDC/UART) whose pad waveform
   * the backend does not expose; the circuit treats it as not simulated (Hi-Z + warning).
   */
  driver?: 'gpio' | 'peripheral';
  signal?: number;
  openDrain?: boolean;
}

/** Input levels the circuit drives back into MCU pads. */
export interface McuPinInput {
  pin: string;
  level: 0 | 1 | null; // null = floating / undefined (leave pad default)
  voltage: number | null;
}

export interface CircuitSolution {
  nets: NetState[];
  components: Record<string, ComponentState>;
  pinNet: Record<string, string>; // "comp.pin" -> net_id
  mcuInputs: McuPinInput[];
  warnings: CircuitWarning[];
  iterations: number;
}

export type CircuitOp =
  | { op: 'add_component'; type: Exclude<ComponentType, 'board'>; component_id?: string; label?: string; props?: Record<string, number | string | boolean>; x?: number; y?: number; color?: string }
  | { op: 'remove_component'; component_id: string }
  | { op: 'update_component'; component_id: string; label?: string; props?: Record<string, number | string | boolean>; color?: string }
  | { op: 'move_component'; component_id: string; x: number; y: number; rotation?: 0 | 90 | 180 | 270 }
  | { op: 'connect'; from: string; to: string; wire_id?: string; color?: string }
  | { op: 'disconnect'; wire_id?: string; from?: string; to?: string }
  | { op: 'disconnect_pin'; pin: string }
  | { op: 'auto_layout' };
