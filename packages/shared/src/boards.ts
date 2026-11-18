import type { BackendId, BoardId, ChipId } from './index.ts';

export type BoardPinRole = 'gpio' | 'power' | 'ground' | 'reset' | 'nc';

export interface BoardPinDef {
  /** Pin id used in circuits, e.g. "GPIO4", "D13", "GND1", "3V3". */
  id: string;
  label: string;
  role: BoardPinRole;
  /** MCU GPIO number (ESP32) or Arduino digital pin number (AVR). */
  gpio?: number;
  /** For AVR: port letter + bit, e.g. "D4". */
  port?: { name: 'B' | 'C' | 'D'; bit: number };
  /** Supply voltage for power pins. */
  supplyV?: number;
  header: string;
  /** Position within the header (0-based). */
  index: number;
  /** Absolute max voltage the pin tolerates. */
  maxV: number;
  /** Logic voltage domain for GPIO pins. */
  logicV?: number;
  /** Capabilities that the *simulator backend* actually supports for this pin. */
  simulated: ('digital-out' | 'digital-in' | 'pull-up' | 'pull-down' | 'uart')[];
  /** Capabilities of the real chip that are NOT simulated end-to-end in PlugAI. */
  notSimulated?: string[];
  notes?: string;
  /** Pins the agent should avoid unless explicitly asked. */
  reserved?: boolean;
}

export interface BoardDef {
  id: BoardId;
  name: string;
  chip: ChipId;
  chipName: string;
  backend: BackendId;
  cpu: string;
  clockHz: number;
  logicV: number;
  /** Electrical model for GPIO outputs. */
  gpioDrive: { rOutHigh: number; rOutLow: number; maxCurrentMa: number; pullUpOhm: number; pullDownOhm: number; vih: number; vil: number };
  pins: BoardPinDef[];
  /** Pins the agent should prefer for simple LED/button work. */
  recommendedGpio: string[];
  firmware: {
    framework: 'esp-idf' | 'arduino';
    language: 'c' | 'cpp';
    entryFile: string;
    sdkVersionHint: string;
  };
  flashing: {
    virtual: ('esptool-virtual-uart' | 'direct-image-load')[];
    physical: string;
  };
  onboard: { id: string; description: string; simulated: boolean }[];
}

function espGpio(n: number, header: string, index: number, extra: Partial<BoardPinDef> = {}): BoardPinDef {
  return {
    id: `GPIO${n}`,
    label: `GPIO${n}`,
    role: 'gpio',
    gpio: n,
    header,
    index,
    maxV: 3.6,
    logicV: 3.3,
    simulated: ['digital-out', 'digital-in', 'pull-up', 'pull-down'],
    notSimulated: ['LEDC PWM output to pad', 'ADC', 'RMT', 'I2C/SPI pad routing'],
    ...extra,
  };
}

function power(id: string, label: string, header: string, index: number, role: 'power' | 'ground', supplyV?: number, maxV = 5.5): BoardPinDef {
  return { id, label, role, header, index, supplyV: role === 'ground' ? 0 : supplyV, maxV, simulated: [] };
}

// ESP32-C3-DevKitM-1 header layout per Espressif user guide (J1 left, J3 right).
export const ESP32C3_DEVKITM_1: BoardDef = {
  id: 'esp32c3-devkitm-1',
  name: 'ESP32-C3-DevKitM-1',
  chip: 'esp32c3',
  chipName: 'ESP32-C3 (RISC-V RV32IMC, 160 MHz)',
  backend: 'esp32c3-esp-emu-wasm',
  cpu: 'RISC-V RV32IMC',
  clockHz: 160_000_000,
  logicV: 3.3,
  gpioDrive: { rOutHigh: 40, rOutLow: 30, maxCurrentMa: 40, pullUpOhm: 45_000, pullDownOhm: 45_000, vih: 0.75 * 3.3, vil: 0.25 * 3.3 },
  pins: [
    power('J1_GND1', 'GND', 'J1', 0, 'ground'),
    power('3V3', '3V3', 'J1', 1, 'power', 3.3, 3.6),
    power('3V3_2', '3V3', 'J1', 2, 'power', 3.3, 3.6),
    espGpio(2, 'J1', 3, { notes: 'Strapping pin', reserved: true }),
    espGpio(3, 'J1', 4),
    power('J1_GND2', 'GND', 'J1', 5, 'ground'),
    { id: 'RST', label: 'RST', role: 'reset', header: 'J1', index: 6, maxV: 3.6, simulated: [], notes: 'CHIP_EN' },
    power('J1_GND3', 'GND', 'J1', 7, 'ground'),
    espGpio(0, 'J1', 8),
    espGpio(1, 'J1', 9),
    espGpio(10, 'J1', 10),
    power('J1_GND4', 'GND', 'J1', 11, 'ground'),
    power('5V', '5V', 'J1', 12, 'power', 5.0),
    power('5V_2', '5V', 'J1', 13, 'power', 5.0),
    power('J1_GND5', 'GND', 'J1', 14, 'ground'),

    power('J3_GND1', 'GND', 'J3', 0, 'ground'),
    espGpio(21, 'J3', 1, { label: 'TX', notes: 'UART0 TXD (console)', reserved: true, simulated: ['uart'] }),
    espGpio(20, 'J3', 2, { label: 'RX', notes: 'UART0 RXD (console)', reserved: true, simulated: ['uart'] }),
    power('J3_GND2', 'GND', 'J3', 3, 'ground'),
    espGpio(9, 'J3', 4, { notes: 'Strapping pin / BOOT button', reserved: true }),
    espGpio(8, 'J3', 5, { notes: 'Strapping pin / onboard WS2812 RGB LED', reserved: true }),
    power('J3_GND3', 'GND', 'J3', 6, 'ground'),
    espGpio(7, 'J3', 7),
    espGpio(6, 'J3', 8),
    espGpio(5, 'J3', 9),
    espGpio(4, 'J3', 10),
    power('J3_GND4', 'GND', 'J3', 11, 'ground'),
    espGpio(18, 'J3', 12, { notes: 'USB D-', reserved: true }),
    espGpio(19, 'J3', 13, { notes: 'USB D+', reserved: true }),
    power('J3_GND5', 'GND', 'J3', 14, 'ground'),
  ],
  recommendedGpio: ['GPIO4', 'GPIO5', 'GPIO6', 'GPIO7', 'GPIO10', 'GPIO3', 'GPIO1', 'GPIO0'],
  firmware: { framework: 'esp-idf', language: 'c', entryFile: 'main/main.c', sdkVersionHint: 'ESP-IDF v5.5.x' },
  flashing: {
    virtual: ['esptool-virtual-uart', 'direct-image-load'],
    physical: 'esptool over USB-UART (CP2102) at /dev/cu.* — idf.py -p PORT flash',
  },
  onboard: [
    { id: 'WS2812@GPIO8', description: 'Addressable RGB LED (RMT protocol)', simulated: false },
    { id: 'BOOT@GPIO9', description: 'BOOT button', simulated: false },
  ],
};

function unoPin(n: number, header: string, index: number, extra: Partial<BoardPinDef> = {}): BoardPinDef {
  const port: BoardPinDef['port'] = n <= 7 ? { name: 'D', bit: n } : n <= 13 ? { name: 'B', bit: n - 8 } : { name: 'C', bit: n - 14 };
  const id = n <= 13 ? `D${n}` : `A${n - 14}`;
  return {
    id,
    label: id,
    role: 'gpio',
    gpio: n,
    port,
    header,
    index,
    maxV: 5.5,
    logicV: 5,
    simulated: ['digital-out', 'digital-in', 'pull-up'],
    notSimulated: ['ADC (analogRead)', 'hardware PWM waveform to circuit (analogWrite) — timer registers are simulated, pin compare output is not routed'],
    ...extra,
  };
}

export const ARDUINO_UNO: BoardDef = {
  id: 'arduino-uno',
  name: 'Arduino Uno R3',
  chip: 'atmega328p',
  chipName: 'ATmega328P (AVR, 16 MHz)',
  backend: 'avr8js',
  cpu: 'AVR8',
  clockHz: 16_000_000,
  logicV: 5,
  gpioDrive: { rOutHigh: 25, rOutLow: 25, maxCurrentMa: 40, pullUpOhm: 35_000, pullDownOhm: Infinity, vih: 0.6 * 5, vil: 0.3 * 5 },
  pins: [
    unoPin(0, 'DIGITAL_LOW', 7, { notes: 'USART RX (Serial)', reserved: true, simulated: ['uart'] }),
    unoPin(1, 'DIGITAL_LOW', 6, { notes: 'USART TX (Serial)', reserved: true, simulated: ['uart'] }),
    unoPin(2, 'DIGITAL_LOW', 5),
    unoPin(3, 'DIGITAL_LOW', 4),
    unoPin(4, 'DIGITAL_LOW', 3),
    unoPin(5, 'DIGITAL_LOW', 2),
    unoPin(6, 'DIGITAL_LOW', 1),
    unoPin(7, 'DIGITAL_LOW', 0),
    unoPin(8, 'DIGITAL_HIGH', 9),
    unoPin(9, 'DIGITAL_HIGH', 8),
    unoPin(10, 'DIGITAL_HIGH', 7),
    unoPin(11, 'DIGITAL_HIGH', 6),
    unoPin(12, 'DIGITAL_HIGH', 5),
    unoPin(13, 'DIGITAL_HIGH', 4, { notes: 'Onboard "L" LED' }),
    power('GND_TOP', 'GND', 'DIGITAL_HIGH', 3, 'ground'),
    { id: 'AREF', label: 'AREF', role: 'nc', header: 'DIGITAL_HIGH', index: 2, maxV: 5.5, simulated: [] },
    power('IOREF', 'IOREF', 'POWER', 0, 'power', 5),
    { id: 'RESET', label: 'RESET', role: 'reset', header: 'POWER', index: 1, maxV: 5.5, simulated: [] },
    power('3V3', '3.3V', 'POWER', 2, 'power', 3.3),
    power('5V', '5V', 'POWER', 3, 'power', 5),
    power('GND1', 'GND', 'POWER', 4, 'ground'),
    power('GND2', 'GND', 'POWER', 5, 'ground'),
    power('VIN', 'VIN', 'POWER', 6, 'power', 9, 12),
    unoPin(14, 'ANALOG', 0),
    unoPin(15, 'ANALOG', 1),
    unoPin(16, 'ANALOG', 2),
    unoPin(17, 'ANALOG', 3),
    unoPin(18, 'ANALOG', 4),
    unoPin(19, 'ANALOG', 5),
  ],
  recommendedGpio: ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12'],
  firmware: { framework: 'arduino', language: 'cpp', entryFile: 'sketch/sketch.ino', sdkVersionHint: 'arduino:avr 1.8.x (avr-gcc 7.3.0)' },
  flashing: {
    virtual: ['direct-image-load'],
    physical: 'avrdude -c arduino (STK500v1 via Optiboot) over USB serial — arduino-cli upload -p PORT',
  },
  onboard: [{ id: 'L@D13', description: 'Onboard LED on D13 (modelled as LED+R on D13)', simulated: true }],
};

export const BOARDS: Record<BoardId, BoardDef> = {
  'esp32c3-devkitm-1': ESP32C3_DEVKITM_1,
  'arduino-uno': ARDUINO_UNO,
};

export function getBoard(id: BoardId): BoardDef {
  const b = BOARDS[id];
  if (!b) throw new Error(`Unknown board ${id}`);
  return b;
}
