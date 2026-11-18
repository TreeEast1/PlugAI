import {
  getBoard,
  type Circuit,
  type CircuitSolution,
  type CircuitWarning,
  type ComponentState,
  type McuPinInput,
  type McuPinState,
  type NetLevel,
  type NetState,
} from '@plugai/shared';
import { LED_COLORS, pinsOf } from './components.ts';
import { BOARD_COMPONENT_ID } from './model.ts';

/**
 * DC operating-point solver for simple digital circuits.
 *
 * - Nets are formed only from explicit wires (plus the board's internally common GND/3V3/5V pins).
 * - MCU pads are Thevenin sources while their output driver is enabled (level from the simulator),
 *   otherwise high-impedance inputs with the pull-up/pull-down the firmware configured.
 * - LEDs are piecewise-linear diodes (Vf + Rs), iterated until the on/off assignment is consistent.
 * - Nets without any conductive path to a source are reported as floating (Z).
 */

export interface SolveInput {
  circuit: Circuit;
  /** Pad states from the MCU simulator. Missing pins are treated as reset-state inputs (no pull). */
  mcuPins: McuPinState[];
  /** Button component_id -> pressed. */
  buttons?: Record<string, boolean>;
}

const GMIN = 1e-12;
const G_OFF_DIODE = 1e-10;
const LIT_THRESHOLD_MA = 0.3;

interface Source {
  node: number;
  v: number;
  g: number;
  kind: 'mcu-out' | 'rail' | 'pull';
  label: string;
  pin?: string;
}
interface Conductance {
  a: number;
  b: number;
  g: number;
}
interface Diode {
  a: number;
  k: number;
  vf: number;
  rs: number;
  imaxMa: number;
  comp: string;
  channel?: string;
  on: boolean;
}

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let p = this.parent.get(x)!;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function solveLinear(G: number[][], I: number[]): number[] {
  const n = I.length;
  const A = G.map((row, i) => [...row, I[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-30) continue;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) A[r][k] -= f * A[col][k];
    }
  }
  return A.map((row, i) => (Math.abs(row[i]) < 1e-30 ? 0 : row[n] / row[i]));
}

export function solveCircuit(input: SolveInput): CircuitSolution {
  const { circuit } = input;
  const board = getBoard(circuit.board);
  const drive = board.gpioDrive;
  const buttons = input.buttons ?? {};
  const mcu = new Map(input.mcuPins.map((p) => [p.pin, p]));
  const warnings: CircuitWarning[] = [];

  // ---- 1. nets from wires
  const uf = new UnionFind();
  const allPins: string[] = [];
  for (const comp of circuit.components) {
    for (const p of pinsOf(comp.type, comp.board ?? circuit.board)) {
      const ref = `${comp.component_id}.${p.pin_id}`;
      allPins.push(ref);
      uf.find(ref);
    }
  }
  const boardPinDefs = new Map(board.pins.map((p) => [p.id, p]));
  const grounds = board.pins.filter((p) => p.role === 'ground').map((p) => `${BOARD_COMPONENT_ID}.${p.id}`);
  for (const g of grounds.slice(1)) uf.union(grounds[0], g);
  const railGroups = new Map<number, string[]>();
  for (const p of board.pins) if (p.role === 'power' && p.supplyV !== undefined) {
    const arr = railGroups.get(p.supplyV) ?? [];
    arr.push(`${BOARD_COMPONENT_ID}.${p.id}`);
    railGroups.set(p.supplyV, arr);
  }
  for (const arr of railGroups.values()) for (const r of arr.slice(1)) uf.union(arr[0], r);
  for (const w of circuit.wires) uf.union(`${w.from.component_id}.${w.from.pin_id}`, `${w.to.component_id}.${w.to.pin_id}`);

  // name nets deterministically
  const groups = new Map<string, string[]>();
  for (const ref of allPins) {
    const r = uf.find(ref);
    const arr = groups.get(r) ?? [];
    arr.push(ref);
    groups.set(r, arr);
  }
  const netIdOfRoot = new Map<string, string>();
  const usedNames = new Set<string>();
  let anon = 1;
  const sortedRoots = [...groups.entries()].sort((a, b) => a[1].slice().sort()[0].localeCompare(b[1].slice().sort()[0]));
  for (const [root, pins] of sortedRoots) {
    let name: string | undefined;
    const boardPins = pins.filter((p) => p.startsWith(`${BOARD_COMPONENT_ID}.`)).map((p) => p.slice(BOARD_COMPONENT_ID.length + 1));
    if (boardPins.some((p) => boardPinDefs.get(p)?.role === 'ground')) name = 'GND';
    else {
      const rail = boardPins.map((p) => boardPinDefs.get(p)).find((d) => d?.role === 'power');
      if (rail) name = rail.id.replace(/_\d+$/, '');
      else {
        const gpio = boardPins.map((p) => boardPinDefs.get(p)).find((d) => d?.role === 'gpio');
        if (gpio) name = `NET_${gpio.id}`;
      }
    }
    if (!name || usedNames.has(name)) name = name ? `${name}_${anon++}` : `N${anon++}`;
    usedNames.add(name);
    netIdOfRoot.set(root, name);
  }
  const pinNet: Record<string, string> = {};
  for (const ref of allPins) pinNet[ref] = netIdOfRoot.get(uf.find(ref))!;

  // ---- 2. nodes
  const netIds = [...new Set(Object.values(pinNet))].sort();
  const nodes = new Map<string, number>();
  netIds.forEach((n, i) => nodes.set(n, i));
  let nodeCount = netIds.length;
  const internalNode = () => nodeCount++;
  const nodeOf = (ref: string) => nodes.get(pinNet[ref])!;

  const sources: Source[] = [];
  const conds: Conductance[] = [];
  const diodes: Diode[] = [];
  const netPinCount = new Map<string, number>();
  for (const ref of allPins) netPinCount.set(pinNet[ref], (netPinCount.get(pinNet[ref]) ?? 0) + 1);

  // board pins
  for (const p of board.pins) {
    const ref = `${BOARD_COMPONENT_ID}.${p.id}`;
    const n = nodeOf(ref);
    if (p.role === 'ground') sources.push({ node: n, v: 0, g: 100, kind: 'rail', label: 'GND' });
    else if (p.role === 'power' && p.supplyV !== undefined) sources.push({ node: n, v: p.supplyV, g: 20, kind: 'rail', label: p.label });
    else if (p.role === 'gpio') {
      const st = mcu.get(p.id);
      if (st?.output && st.driver === 'peripheral') {
        if ((netPinCount.get(pinNet[ref]) ?? 0) > 1) {
          warnings.push({
            severity: 'warning',
            code: 'NOT_SIMULATED',
            message: `${p.id} is routed to peripheral signal #${st.signal} (e.g. LEDC PWM / UART). This backend does not expose that pad waveform, so the circuit treats it as Hi-Z. Use plain GPIO output (gpio_set_level) for simulated parts.`,
          });
        }
      } else if (st?.output && !(st.openDrain && st.level === 1)) {
        sources.push({ node: n, v: st.level ? board.logicV : 0, g: 1 / (st.level ? drive.rOutHigh : drive.rOutLow), kind: 'mcu-out', label: `${p.id}=${st.level ? 'HIGH' : 'LOW'}`, pin: p.id });
      }
      const driving = st?.output && st.driver !== 'peripheral' && !(st.openDrain && st.level === 1);
      if (driving) {
        // pull resistors are negligible against an active driver
      } else if (st?.pull === 'up') {
        sources.push({ node: n, v: board.logicV, g: 1 / drive.pullUpOhm, kind: 'pull', label: `${p.id} pull-up`, pin: p.id });
      } else if (st?.pull === 'down' && Number.isFinite(drive.pullDownOhm)) {
        sources.push({ node: n, v: 0, g: 1 / drive.pullDownOhm, kind: 'pull', label: `${p.id} pull-down`, pin: p.id });
      }
    }
  }
  // dedupe rail sources (several pins on the same net)
  const seenRail = new Set<string>();
  for (let i = sources.length - 1; i >= 0; i--) {
    const s = sources[i];
    if (s.kind !== 'rail') continue;
    const key = `${s.node}:${s.v}`;
    if (seenRail.has(key)) sources.splice(i, 1);
    else seenRail.add(key);
  }

  // passive components
  for (const comp of circuit.components) {
    const id = comp.component_id;
    if (comp.type === 'resistor') {
      conds.push({ a: nodeOf(`${id}.1`), b: nodeOf(`${id}.2`), g: 1 / Math.max(1e-3, Number(comp.props.ohms ?? 220)) });
    } else if (comp.type === 'button') {
      if (buttons[id]) conds.push({ a: nodeOf(`${id}.1`), b: nodeOf(`${id}.2`), g: 1 / Number(comp.props.r_on_ohm ?? 0.05) });
    } else if (comp.type === 'led') {
      const color = String(comp.props.color ?? 'red');
      diodes.push({
        a: nodeOf(`${id}.A`),
        k: nodeOf(`${id}.K`),
        vf: Number(comp.props.vf ?? LED_COLORS[color]?.vf ?? 2),
        rs: Number(comp.props.rs_ohm ?? 15),
        imaxMa: Number(comp.props.imax_ma ?? 20),
        comp: id,
        on: false,
      });
    } else if (comp.type === 'traffic-light') {
      const r = Number(comp.props.r_ohm ?? 220);
      const k = nodeOf(`${id}.GND`);
      for (const [ch, color] of [['R', 'red'], ['Y', 'yellow'], ['G', 'green']] as const) {
        const mid = internalNode();
        conds.push({ a: nodeOf(`${id}.${ch}`), b: mid, g: 1 / r });
        diodes.push({ a: mid, k, vf: LED_COLORS[color].vf, rs: 15, imaxMa: 20, comp: id, channel: color, on: false });
      }
    }
  }

  // ---- 3. iterate diode states
  let V: number[] = new Array(nodeCount).fill(0);
  let iterations = 0;
  for (; iterations < 40; iterations++) {
    const G = Array.from({ length: nodeCount }, () => new Array(nodeCount).fill(0));
    const I = new Array(nodeCount).fill(0);
    for (let i = 0; i < nodeCount; i++) G[i][i] += GMIN;
    for (const s of sources) {
      G[s.node][s.node] += s.g;
      I[s.node] += s.g * s.v;
    }
    const stamp = (a: number, b: number, g: number) => {
      G[a][a] += g;
      G[b][b] += g;
      G[a][b] -= g;
      G[b][a] -= g;
    };
    for (const c of conds) if (c.a !== c.b) stamp(c.a, c.b, c.g);
    for (const d of diodes) {
      if (d.a === d.k) continue;
      if (d.on) {
        const g = 1 / d.rs;
        stamp(d.a, d.k, g);
        I[d.a] += g * d.vf;
        I[d.k] -= g * d.vf;
      } else stamp(d.a, d.k, G_OFF_DIODE);
    }
    V = solveLinear(G, I);
    let changed = false;
    for (const d of diodes) {
      const vd = V[d.a] - V[d.k];
      if (!d.on && vd > d.vf + 1e-6) {
        d.on = true;
        changed = true;
      } else if (d.on && (vd - d.vf) / d.rs < -1e-9) {
        d.on = false;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // ---- 4. floating analysis (conductive connectivity to any source)
  const cu = new UnionFind();
  for (let i = 0; i < nodeCount; i++) cu.find(String(i));
  for (const c of conds) cu.union(String(c.a), String(c.b));
  for (const d of diodes) if (d.on) cu.union(String(d.a), String(d.k));
  const drivenRoots = new Set(sources.map((s) => cu.find(String(s.node))));
  const isFloating = (node: number) => !drivenRoots.has(cu.find(String(node)));

  const vih = drive.vih;
  const vil = drive.vil;
  const nets: NetState[] = netIds.map((netId) => {
    const node = nodes.get(netId)!;
    const pins = allPins.filter((p) => pinNet[p] === netId);
    const strong = sources.filter((s) => s.node === node && s.kind !== 'pull');
    const floating = isFloating(node);
    let level: NetLevel;
    const conflict = strong.length > 1 && strong.some((s) => Math.abs(s.v - strong[0].v) > 0.05);
    if (pins.length <= 1 && !strong.length && !sources.some((s) => s.node === node)) level = 'UNCONNECTED';
    else if (conflict) level = 'CONFLICT';
    else if (floating) level = 'Z';
    else if (V[node] >= vih) level = 'HIGH';
    else if (V[node] <= vil) level = 'LOW';
    else level = 'UNDEFINED';
    return {
      net_id: netId,
      pins,
      voltage: floating ? null : Math.round(V[node] * 1000) / 1000,
      level,
      floating,
      drivers: sources.filter((s) => s.node === node).map((s) => s.label),
    };
  });
  const netById = new Map(nets.map((n) => [n.net_id, n]));

  for (const n of nets) {
    if (n.level === 'CONFLICT') {
      warnings.push({ severity: 'danger', code: 'NET_CONFLICT', net_id: n.net_id, message: `Net ${n.net_id} is driven to different levels by ${n.drivers.join(' and ')} (short circuit).` });
    }
  }

  // ---- 5. MCU output currents
  for (const s of sources) {
    if (s.kind !== 'mcu-out') continue;
    const iMa = Math.abs((s.v - V[s.node]) * s.g) * 1000;
    if (iMa > drive.maxCurrentMa) {
      warnings.push({ severity: 'danger', code: 'GPIO_OVERCURRENT', message: `${s.pin} sources/sinks ${iMa.toFixed(0)} mA (max ${drive.maxCurrentMa} mA). Check for a short or a missing resistor.` });
    }
  }

  // ---- 6. component states
  const components: Record<string, ComponentState> = {};
  for (const comp of circuit.components) {
    const id = comp.component_id;
    if (comp.type === 'led' || comp.type === 'traffic-light') {
      const ds = diodes.filter((d) => d.comp === id);
      const chans: Record<string, { lit: boolean; brightness: number; currentMa: number }> = {};
      const cw: string[] = [];
      for (const d of ds) {
        const iMa = d.on ? Math.max(0, ((V[d.a] - V[d.k] - d.vf) / d.rs) * 1000) : 0;
        const lit = iMa >= LIT_THRESHOLD_MA;
        const brightness = lit ? Math.min(1, Math.pow(iMa / (d.imaxMa * 0.6), 0.55)) : 0;
        chans[d.channel ?? 'main'] = { lit, brightness: Math.round(brightness * 1000) / 1000, currentMa: Math.round(iMa * 100) / 100 };
        if (iMa > d.imaxMa * 1.15) {
          const msg = `${id}${d.channel ? `:${d.channel}` : ''} forward current ${iMa.toFixed(1)} mA exceeds its ${d.imaxMa} mA rating — add a current-limiting resistor (e.g. 220 Ω).`;
          cw.push(msg);
          warnings.push({ severity: 'danger', code: 'LED_OVERCURRENT', component_id: id, message: msg });
        }
        const aF = isFloating(d.a);
        const kF = isFloating(d.k);
        if (!aF && !kF && V[d.k] - V[d.a] > 1.0) {
          const msg = `${id}${d.channel ? `:${d.channel}` : ''} is reverse-biased (${(V[d.k] - V[d.a]).toFixed(2)} V across K→A): check LED polarity (A/anode is the long leg, to the positive side).`;
          cw.push(msg);
          warnings.push({ severity: 'warning', code: 'LED_REVERSED', component_id: id, message: msg });
        }
      }
      if (comp.type === 'led') {
        const main = chans.main;
        components[id] = { component_id: id, type: 'led', lit: main.lit, brightness: main.brightness, currentMa: main.currentMa, warnings: cw };
        for (const pin of ['A', 'K']) {
          if ((netPinCount.get(pinNet[`${id}.${pin}`]) ?? 0) <= 1) {
            warnings.push({ severity: 'info', code: 'UNCONNECTED_PIN', component_id: id, message: `${id}.${pin} is not connected.` });
          }
        }
        // structural: LED directly between a strong source net and ground with no resistor in the loop
        const aNet = netById.get(pinNet[`${id}.A`]);
        const kNet = netById.get(pinNet[`${id}.K`]);
        const strongNet = (n?: NetState) => !!n && sources.some((s) => nodes.get(n.net_id) === s.node && s.kind !== 'pull');
        if (aNet && kNet && strongNet(aNet) && strongNet(kNet)) {
          warnings.push({ severity: 'danger', code: 'LED_NO_RESISTOR', component_id: id, message: `${id} is wired directly between ${aNet.net_id} and ${kNet.net_id} without a current-limiting resistor.` });
        }
      } else {
        components[id] = {
          component_id: id,
          type: 'traffic-light',
          lit: Object.values(chans).some((c) => c.lit),
          channels: chans,
          warnings: cw,
        };
      }
    } else if (comp.type === 'button') {
      components[id] = { component_id: id, type: 'button', pressed: !!buttons[id] };
    } else if (comp.type === 'resistor') {
      const a = V[nodeOf(`${id}.1`)];
      const b = V[nodeOf(`${id}.2`)];
      const iMa = Math.abs(a - b) / Math.max(1e-3, Number(comp.props.ohms ?? 220)) * 1000;
      components[id] = { component_id: id, type: 'resistor', currentMa: Math.round(iMa * 100) / 100 };
    }
  }

  // LCD modules: power, backlight and SPI bus binding are derived from the actual wiring.
  const boardPinsOnNet = (ref: string) => {
    const net = pinNet[ref];
    return allPins.filter((p) => pinNet[p] === net && p.startsWith(`${BOARD_COMPONENT_ID}.`)).map((p) => p.slice(BOARD_COMPONENT_ID.length + 1));
  };
  for (const comp of circuit.components) {
    if (comp.type !== 'lcd') continue;
    const id = comp.component_id;
    const cw: string[] = [];
    const netOf = (pin: string) => netById.get(pinNet[`${id}.${pin}`])!;
    const vcc = netOf('VCC');
    const gnd = netOf('GND');
    const powered = !vcc.floating && (vcc.voltage ?? 0) >= 2.8 && gnd.net_id === 'GND';
    const backlight = powered && !netOf('BL').floating && (netOf('BL').voltage ?? 0) >= 2.5;
    const gpioOn = (pin: string) => boardPinsOnNet(`${id}.${pin}`).find((p) => boardPinDefs.get(p)?.role === 'gpio') ?? null;
    const sck = circuit.board === 'arduino-uno' && boardPinsOnNet(`${id}.SCK`).includes('D13');
    const mosi = circuit.board === 'arduino-uno' && boardPinsOnNet(`${id}.SDA`).includes('D11');
    const cs = gpioOn('CS') ?? (netOf('CS').net_id === 'GND' ? 'GND' : null);
    const dc = gpioOn('DC');
    const rstNet = netOf('RST');
    const rst = gpioOn('RST') ?? (!rstNet.floating && (rstNet.voltage ?? 0) >= 2.5 ? 'VCC' : null);
    if (circuit.board !== 'arduino-uno') cw.push(`${id}: LCD/SPI devices are only simulated on the Arduino Uno backend (esp-emu does not expose ESP32-C3 SPI pad traffic). The display will stay dark.`);
    else {
      if (!powered) cw.push(`${id}: not powered — wire VCC to 5V (or 3.3V) and GND to GND.`);
      if (powered && !backlight) cw.push(`${id}: backlight (LED/BL pin) is not connected to a supply — the image is invisible.`);
      if (!sck) cw.push(`${id}: SCK must be wired to D13 (hardware SPI clock).`);
      if (!mosi) cw.push(`${id}: SDA (MOSI) must be wired to D11 (hardware SPI data).`);
      if (!cs) cw.push(`${id}: CS is not wired to a GPIO (or GND) — the controller ignores the bus.`);
      if (!dc) cw.push(`${id}: A0/DC is not wired to a GPIO — commands and data cannot be told apart.`);
      if (!rst) cw.push(`${id}: RESET is floating — wire it to a GPIO or to VCC.`);
    }
    for (const m of cw) warnings.push({ severity: 'warning', code: circuit.board !== 'arduino-uno' ? 'NOT_SIMULATED' : 'UNCONNECTED_PIN', component_id: id, message: m });
    components[id] = { component_id: id, type: 'lcd', lcd: { powered, backlight, bus: { sck, mosi, cs, dc, rst }, ready: powered && sck && mosi && !!cs && !!dc && !!rst }, warnings: cw };
  }

  // Uno onboard "L" LED is driven through an op-amp buffer from D13 (does not load the pin).
  if (circuit.board === 'arduino-uno') {
    const d13 = netById.get(pinNet[`${BOARD_COMPONENT_ID}.D13`]);
    const lit = d13?.level === 'HIGH';
    components[BOARD_COMPONENT_ID] = { component_id: BOARD_COMPONENT_ID, type: 'board', channels: { L: { lit, brightness: lit ? 1 : 0, currentMa: 0 } } };
  } else {
    components[BOARD_COMPONENT_ID] = { component_id: BOARD_COMPONENT_ID, type: 'board' };
  }

  // ---- 7. board pin checks and MCU inputs
  const mcuInputs: McuPinInput[] = [];
  for (const p of board.pins) {
    const ref = `${BOARD_COMPONENT_ID}.${p.id}`;
    const net = netById.get(pinNet[ref])!;
    const connectedToSomething = (netPinCount.get(net.net_id) ?? 0) > 1;
    if (net.voltage !== null && net.voltage > p.maxV + 0.1 && p.role === 'gpio') {
      warnings.push({ severity: 'danger', code: 'OVERVOLTAGE', net_id: net.net_id, message: `${p.id} sees ${net.voltage.toFixed(2)} V but tolerates at most ${p.maxV} V (${board.name} is a ${board.logicV} V part).` });
    }
    if (p.role !== 'gpio') continue;
    if (p.reserved && connectedToSomething) {
      warnings.push({ severity: 'info', code: 'RESERVED_PIN', message: `${p.id} is wired, but it is reserved: ${p.notes ?? 'special function'}.` });
    }
    const st = mcu.get(p.id);
    if (st?.output) continue;
    let level: 0 | 1 | null = null;
    if (!net.floating && net.voltage !== null) level = net.voltage >= vih ? 1 : net.voltage <= vil ? 0 : null;
    if (connectedToSomething && net.floating && st) {
      warnings.push({ severity: 'warning', code: 'FLOATING_INPUT', net_id: net.net_id, message: `${p.id} is an input on a floating net — enable a pull-up/pull-down or add an external resistor.` });
    }
    mcuInputs.push({ pin: p.id, level, voltage: net.voltage });
  }

  // fill pin current_state for convenience
  return { nets, components, pinNet, mcuInputs, warnings: dedupeWarnings(warnings), iterations };
}

function dedupeWarnings(ws: CircuitWarning[]): CircuitWarning[] {
  const seen = new Set<string>();
  return ws.filter((w) => {
    const k = `${w.code}|${w.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Flatten component state into "observable" channels used by traces and verification. */
export function observableChannels(sol: CircuitSolution): Record<string, { lit: boolean; brightness: number }> {
  const out: Record<string, { lit: boolean; brightness: number }> = {};
  for (const [id, st] of Object.entries(sol.components)) {
    if (st.type === 'led') out[id] = { lit: !!st.lit, brightness: st.brightness ?? 0 };
    else if (st.channels) for (const [ch, v] of Object.entries(st.channels)) out[`${id}:${ch}`] = { lit: v.lit, brightness: v.brightness };
  }
  return out;
}
