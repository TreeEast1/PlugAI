import { getBoard, type BoardDef, type BoardId, type ComponentPin, type ComponentType } from '@plugai/shared';

/** Static description of a component type: pins, defaults, geometry, simulation support. */
export interface ComponentTypeDef {
  type: ComponentType;
  name: string;
  defaultModel: string;
  idPrefix: string;
  pins: ComponentPin[];
  defaultProps: Record<string, number | string | boolean>;
  /** Supported operations exposed to the user/agent. */
  operations: string[];
  /** What is really simulated (no visual-only parts are listed as simulated). */
  simulation: { simulated: boolean; model: string; limitations: string[] };
  size: { w: number; h: number };
  pinPos: Record<string, { x: number; y: number }>;
}

export const LED_COLORS: Record<string, { vf: number; hex: string }> = {
  red: { vf: 1.9, hex: '#ff3b3b' },
  yellow: { vf: 2.0, hex: '#ffd23b' },
  orange: { vf: 2.0, hex: '#ff8a1f' },
  green: { vf: 2.1, hex: '#36ff6b' },
  blue: { vf: 2.9, hex: '#3b8bff' },
  white: { vf: 2.9, hex: '#f4f7ff' },
};

export const COMPONENT_TYPES: Record<Exclude<ComponentType, 'board'>, ComponentTypeDef> = {
  led: {
    type: 'led',
    name: '5mm LED',
    defaultModel: 'LED-5MM',
    idPrefix: 'led',
    pins: [
      { pin_id: 'A', label: 'A (+)', signal_type: 'anode', direction: 'passive' },
      { pin_id: 'K', label: 'K (−)', signal_type: 'cathode', direction: 'passive' },
    ],
    defaultProps: { color: 'red', vf: 1.9, rs_ohm: 15, imax_ma: 20 },
    operations: ['observe'],
    simulation: {
      simulated: true,
      model: 'Piecewise-linear diode (Vf + series Rs) solved by nodal analysis; brightness from forward current',
      limitations: ['No thermal model', 'Brightness is a perceptual approximation of forward current'],
    },
    size: { w: 44, h: 84 },
    pinPos: { A: { x: 15, y: 84 }, K: { x: 29, y: 84 } },
  },
  resistor: {
    type: 'resistor',
    name: 'Resistor',
    defaultModel: 'R-AXIAL-1/4W',
    idPrefix: 'r',
    pins: [
      { pin_id: '1', label: '1', signal_type: 'passive', direction: 'passive' },
      { pin_id: '2', label: '2', signal_type: 'passive', direction: 'passive' },
    ],
    defaultProps: { ohms: 220 },
    operations: ['observe'],
    simulation: { simulated: true, model: 'Linear resistor', limitations: ['No power rating check'] },
    size: { w: 96, h: 28 },
    pinPos: { '1': { x: 0, y: 14 }, '2': { x: 96, y: 14 } },
  },
  button: {
    type: 'button',
    name: 'Push button (momentary)',
    defaultModel: 'TACT-6MM',
    idPrefix: 'btn',
    pins: [
      { pin_id: '1', label: '1', signal_type: 'passive', direction: 'passive' },
      { pin_id: '2', label: '2', signal_type: 'passive', direction: 'passive' },
    ],
    defaultProps: { r_on_ohm: 0.05 },
    operations: ['press', 'release'],
    simulation: { simulated: true, model: 'Ideal switch (closed = 0.05 Ω, open = open circuit)', limitations: ['No contact bounce modelled'] },
    size: { w: 64, h: 64 },
    pinPos: { '1': { x: 0, y: 32 }, '2': { x: 64, y: 32 } },
  },
  lcd: {
    type: 'lcd',
    name: '1.8" TFT LCD module, ST7735 controller, 128×160 RGB565, SPI',
    defaultModel: 'TFT-1.8-ST7735',
    idPrefix: 'lcd',
    pins: [
      { pin_id: 'VCC', label: 'VCC', signal_type: 'power', direction: 'power' },
      { pin_id: 'GND', label: 'GND', signal_type: 'ground', direction: 'power' },
      { pin_id: 'CS', label: 'CS', signal_type: 'digital', direction: 'in' },
      { pin_id: 'RST', label: 'RESET', signal_type: 'digital', direction: 'in' },
      { pin_id: 'DC', label: 'A0 (D/C)', signal_type: 'digital', direction: 'in' },
      { pin_id: 'SDA', label: 'SDA (MOSI)', signal_type: 'digital', direction: 'in' },
      { pin_id: 'SCK', label: 'SCK', signal_type: 'digital', direction: 'in' },
      { pin_id: 'BL', label: 'LED (backlight)', signal_type: 'power', direction: 'in' },
    ],
    defaultProps: {},
    operations: ['observe'],
    simulation: {
      simulated: true,
      model:
        'ST7735 controller fed by the MCU hardware SPI peripheral (real SPI bytes; D/C, CS, RESET sampled from the wired GPIOs). Commands: SWRESET, SLPIN/OUT, INVON/OFF, DISPON/OFF, CASET, RASET, RAMWR, MADCTL, COLMOD (16/18-bit). Frame memory 128×160. Arduino Uno backend only.',
      limitations: ['Arduino Uno only (ESP32-C3 SPI pads are not exposed by esp-emu)', 'SCK must be D13 and SDA (MOSI) D11 (hardware SPI)', 'Read-back (MISO) not supported', 'Power/gamma commands accepted without electrical effect'],
    },
    size: { w: 150, h: 214 },
    pinPos: { VCC: { x: 12, y: 214 }, GND: { x: 30, y: 214 }, CS: { x: 48, y: 214 }, RST: { x: 66, y: 214 }, DC: { x: 84, y: 214 }, SDA: { x: 102, y: 214 }, SCK: { x: 120, y: 214 }, BL: { x: 138, y: 214 } },
  },
  'traffic-light': {
    type: 'traffic-light',
    name: 'Traffic light module (R/Y/G, common cathode, 220 Ω on board)',
    defaultModel: 'TL-MODULE-RYG',
    idPrefix: 'tl',
    pins: [
      { pin_id: 'R', label: 'R', signal_type: 'anode', direction: 'passive' },
      { pin_id: 'Y', label: 'Y', signal_type: 'anode', direction: 'passive' },
      { pin_id: 'G', label: 'G', signal_type: 'anode', direction: 'passive' },
      { pin_id: 'GND', label: 'GND', signal_type: 'cathode', direction: 'passive' },
    ],
    defaultProps: { r_ohm: 220 },
    operations: ['observe'],
    simulation: {
      simulated: true,
      model: 'Three LEDs (red/yellow/green) each with an on-board 220 Ω resistor to a common cathode',
      limitations: [],
    },
    size: { w: 64, h: 168 },
    pinPos: { R: { x: 11, y: 168 }, Y: { x: 25, y: 168 }, G: { x: 39, y: 168 }, GND: { x: 53, y: 168 } },
  },
};

export interface BoardGeometry {
  size: { w: number; h: number };
  pinPos: Record<string, { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' }>;
}

export function boardGeometry(board: BoardDef | BoardId): BoardGeometry {
  const def = typeof board === 'string' ? getBoard(board) : board;
  const pinPos: BoardGeometry['pinPos'] = {};
  if (def.id === 'esp32c3-devkitm-1') {
    const w = 264;
    const top = 92;
    const step = 24;
    for (const p of def.pins) {
      const left = p.header === 'J1';
      pinPos[p.id] = { x: left ? 0 : w, y: top + p.index * step, side: left ? 'left' : 'right' };
    }
    return { size: { w, h: top + 15 * step + 40 }, pinPos };
  }
  // Arduino Uno: digital headers on top, power + analog on bottom.
  const w = 470;
  const h = 330;
  const step = 20;
  for (const p of def.pins) {
    let x = 0;
    let y = 0;
    let side: 'top' | 'bottom' = 'top';
    if (p.header === 'DIGITAL_LOW') {
      x = 270 + p.index * step;
      y = 0;
    } else if (p.header === 'DIGITAL_HIGH') {
      x = 60 + p.index * step;
      y = 0;
    } else if (p.header === 'POWER') {
      x = 130 + p.index * step;
      y = h;
      side = 'bottom';
    } else {
      x = 300 + p.index * step;
      y = h;
      side = 'bottom';
    }
    pinPos[p.id] = { x, y, side };
  }
  return { size: { w, h }, pinPos };
}

export function boardPins(boardId: BoardId): ComponentPin[] {
  const def = getBoard(boardId);
  return def.pins.map((p) => ({
    pin_id: p.id,
    label: p.label,
    signal_type: p.role === 'ground' ? 'ground' : p.role === 'power' ? 'power' : 'digital',
    direction: p.role === 'gpio' ? 'inout' : p.role === 'power' || p.role === 'ground' ? 'power' : 'passive',
    voltage_domain: p.logicV ?? p.supplyV,
  }));
}

export function pinsOf(type: ComponentType, board?: BoardId): ComponentPin[] {
  if (type === 'board') return boardPins(board!);
  return COMPONENT_TYPES[type].pins;
}

/** Describe the catalogue for the agent / UI (only types that are genuinely simulated). */
export function catalog() {
  return Object.values(COMPONENT_TYPES).map((t) => ({
    type: t.type,
    name: t.name,
    pins: t.pins.map((p) => `${p.pin_id} (${p.label})`),
    defaultProps: t.defaultProps,
    operations: t.operations,
    simulation: t.simulation,
  }));
}
