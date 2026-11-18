import { getBoard, type BoardId, type Circuit, type CircuitComponent, type CircuitOp, type Wire } from '@plugai/shared';
import { COMPONENT_TYPES, LED_COLORS, boardGeometry, pinsOf } from './components.ts';

export const BOARD_COMPONENT_ID = 'board';

export function createCircuit(board: BoardId): Circuit {
  const def = getBoard(board);
  return {
    version: 1,
    board,
    components: [
      {
        component_id: BOARD_COMPONENT_ID,
        type: 'board',
        model: def.name,
        label: def.name,
        appearance: { x: 80, y: 60 },
        props: {},
        board,
      },
    ],
    wires: [],
  };
}

export class CircuitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitError';
  }
}

export function parsePinRef(ref: string): { component_id: string; pin_id: string } {
  const i = ref.indexOf('.');
  if (i <= 0 || i === ref.length - 1) throw new CircuitError(`Invalid pin reference "${ref}". Use "<component_id>.<pin_id>", e.g. "board.GPIO4" or "led1.A".`);
  return { component_id: ref.slice(0, i), pin_id: ref.slice(i + 1) };
}

export function findComponent(c: Circuit, id: string): CircuitComponent | undefined {
  return c.components.find((x) => x.component_id === id);
}

export function assertPin(c: Circuit, ref: string): { component_id: string; pin_id: string } {
  const { component_id, pin_id } = parsePinRef(ref);
  const comp = findComponent(c, component_id);
  if (!comp) throw new CircuitError(`Component "${component_id}" does not exist. Existing: ${c.components.map((x) => x.component_id).join(', ')}`);
  const pins = pinsOf(comp.type, comp.board ?? c.board);
  if (!pins.some((p) => p.pin_id === pin_id)) {
    throw new CircuitError(`Component "${component_id}" (${comp.type}) has no pin "${pin_id}". Valid pins: ${pins.map((p) => p.pin_id).join(', ')}`);
  }
  return { component_id, pin_id };
}

function nextId(c: Circuit, prefix: string): string {
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!findComponent(c, id)) return id;
  }
}

function nextWireId(c: Circuit): string {
  for (let i = 1; ; i++) {
    const id = `w${i}`;
    if (!c.wires.some((w) => w.wire_id === id)) return id;
  }
}

const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

const WIRE_COLORS = ['#ff7a45', '#36cfc9', '#ffd666', '#b37feb', '#5cdbd3', '#ff85c0', '#95de64', '#69c0ff'];

/** Apply a list of operations. Returns a new circuit; throws CircuitError on invalid ops (atomic). */
export function applyOps(input: Circuit, ops: CircuitOp[]): { circuit: Circuit; log: string[] } {
  const c: Circuit = structuredClone(input);
  const log: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'add_component': {
        const def = COMPONENT_TYPES[op.type];
        if (!def) throw new CircuitError(`Unsupported component type "${(op as { type: string }).type}". Supported: ${Object.keys(COMPONENT_TYPES).join(', ')}`);
        const id = op.component_id ?? nextId(c, def.idPrefix);
        if (!ID_RE.test(id)) throw new CircuitError(`Invalid component_id "${id}" (lowercase letters, digits, underscore; start with a letter)`);
        if (findComponent(c, id)) throw new CircuitError(`Component "${id}" already exists`);
        const props = { ...def.defaultProps, ...(op.props ?? {}) };
        if (op.type === 'led') {
          const color = String(props.color ?? 'red');
          if (!LED_COLORS[color]) throw new CircuitError(`Unsupported LED color "${color}". Supported: ${Object.keys(LED_COLORS).join(', ')}`);
          if (op.props?.vf === undefined) props.vf = LED_COLORS[color].vf;
        }
        if (op.type === 'resistor') {
          const ohms = Number(props.ohms);
          if (!(ohms > 0 && ohms < 1e8)) throw new CircuitError(`Resistor ohms must be in (0, 1e8), got ${props.ohms}`);
          props.ohms = ohms;
        }
        c.components.push({
          component_id: id,
          type: op.type,
          model: def.defaultModel,
          label: op.label ?? id,
          appearance: { x: op.x ?? NaN, y: op.y ?? NaN },
          props,
        });
        log.push(`added ${op.type} ${id}`);
        break;
      }
      case 'remove_component': {
        if (op.component_id === BOARD_COMPONENT_ID) throw new CircuitError('The development board cannot be removed');
        if (!findComponent(c, op.component_id)) throw new CircuitError(`Component "${op.component_id}" does not exist`);
        c.components = c.components.filter((x) => x.component_id !== op.component_id);
        const before = c.wires.length;
        c.wires = c.wires.filter((w) => w.from.component_id !== op.component_id && w.to.component_id !== op.component_id);
        log.push(`removed ${op.component_id} and ${before - c.wires.length} wire(s)`);
        break;
      }
      case 'update_component': {
        const comp = findComponent(c, op.component_id);
        if (!comp) throw new CircuitError(`Component "${op.component_id}" does not exist`);
        if (op.label !== undefined) comp.label = op.label;
        if (op.color !== undefined) comp.appearance.color = op.color;
        if (op.props) {
          if (comp.type === 'led' && op.props.color !== undefined) {
            const color = String(op.props.color);
            if (!LED_COLORS[color]) throw new CircuitError(`Unsupported LED color "${color}"`);
            if (op.props.vf === undefined) comp.props.vf = LED_COLORS[color].vf;
          }
          if (comp.type === 'resistor' && op.props.ohms !== undefined && !(Number(op.props.ohms) > 0)) throw new CircuitError('ohms must be > 0');
          Object.assign(comp.props, op.props);
        }
        log.push(`updated ${op.component_id}`);
        break;
      }
      case 'move_component': {
        const comp = findComponent(c, op.component_id);
        if (!comp) throw new CircuitError(`Component "${op.component_id}" does not exist`);
        comp.appearance.x = Math.round(op.x);
        comp.appearance.y = Math.round(op.y);
        if (op.rotation !== undefined) comp.appearance.rotation = op.rotation;
        break;
      }
      case 'connect': {
        const a = assertPin(c, op.from);
        const b = assertPin(c, op.to);
        if (a.component_id === b.component_id && a.pin_id === b.pin_id) throw new CircuitError('Cannot connect a pin to itself');
        const dup = c.wires.find(
          (w) =>
            (w.from.component_id === a.component_id && w.from.pin_id === a.pin_id && w.to.component_id === b.component_id && w.to.pin_id === b.pin_id) ||
            (w.to.component_id === a.component_id && w.to.pin_id === a.pin_id && w.from.component_id === b.component_id && w.from.pin_id === b.pin_id),
        );
        if (dup) {
          log.push(`wire ${dup.wire_id} already connects ${op.from} ↔ ${op.to}`);
          break;
        }
        const wire_id = op.wire_id ?? nextWireId(c);
        if (c.wires.some((w) => w.wire_id === wire_id)) throw new CircuitError(`Wire id ${wire_id} already exists`);
        const wire: Wire = { wire_id, from: a, to: b, color: op.color ?? WIRE_COLORS[c.wires.length % WIRE_COLORS.length] };
        c.wires.push(wire);
        log.push(`connected ${op.from} ↔ ${op.to} (${wire_id})`);
        break;
      }
      case 'disconnect': {
        const before = c.wires.length;
        if (op.wire_id) {
          c.wires = c.wires.filter((w) => w.wire_id !== op.wire_id);
        } else if (op.from && op.to) {
          const a = parsePinRef(op.from);
          const b = parsePinRef(op.to);
          const same = (e: { component_id: string; pin_id: string }, r: { component_id: string; pin_id: string }) => e.component_id === r.component_id && e.pin_id === r.pin_id;
          c.wires = c.wires.filter((w) => !((same(w.from, a) && same(w.to, b)) || (same(w.from, b) && same(w.to, a))));
        } else {
          throw new CircuitError('disconnect requires wire_id or both from and to');
        }
        if (c.wires.length === before) throw new CircuitError(`No matching wire to disconnect (${op.wire_id ?? `${op.from} ↔ ${op.to}`})`);
        log.push(`removed ${before - c.wires.length} wire(s)`);
        break;
      }
      case 'disconnect_pin': {
        const r = assertPin(c, op.pin);
        const before = c.wires.length;
        c.wires = c.wires.filter(
          (w) => !((w.from.component_id === r.component_id && w.from.pin_id === r.pin_id) || (w.to.component_id === r.component_id && w.to.pin_id === r.pin_id)),
        );
        log.push(`removed ${before - c.wires.length} wire(s) from ${op.pin}`);
        break;
      }
      case 'auto_layout': {
        autoLayout(c, true);
        log.push('auto layout');
        break;
      }
      default:
        throw new CircuitError(`Unknown op ${(op as { op: string }).op}`);
    }
  }
  autoLayout(c, false);
  return { circuit: c, log };
}

/** Place components without coordinates (or all components when force=true). */
export function autoLayout(c: Circuit, force: boolean) {
  const board = findComponent(c, BOARD_COMPONENT_ID)!;
  const geo = boardGeometry(c.board);
  if (force) {
    board.appearance.x = 80;
    board.appearance.y = 60;
  }
  const bx = board.appearance.x;
  const by = board.appearance.y;
  const isUno = c.board === 'arduino-uno';
  const startX = isUno ? bx : bx + geo.size.w + 160;
  const startY = isUno ? by - 300 : by;
  // Order: for each wire-connected chain keep related parts near each other.
  const others = c.components.filter((x) => x.type !== 'board');
  let col = 0;
  let row = 0;
  const colW = 130;
  const rowH = 200;
  const perRow = isUno ? 6 : 3;
  for (const comp of others) {
    const missing = !Number.isFinite(comp.appearance.x) || !Number.isFinite(comp.appearance.y);
    if (!force && !missing) continue;
    if (force || missing) {
      // find a free slot
      for (;;) {
        const x = startX + col * colW;
        const y = startY + row * rowH;
        const taken = others.some(
          (o) => o !== comp && Number.isFinite(o.appearance.x) && Math.abs(o.appearance.x - x) < 60 && Math.abs(o.appearance.y - y) < 60 && (!force || others.indexOf(o) < others.indexOf(comp)),
        );
        col++;
        if (col >= perRow) {
          col = 0;
          row++;
        }
        if (!taken) {
          comp.appearance.x = x;
          comp.appearance.y = comp.type === 'resistor' ? y + 30 : y;
          break;
        }
      }
    }
  }
}

export function describeCircuit(c: Circuit): string {
  const lines: string[] = [`board: ${c.board}`];
  for (const comp of c.components) {
    if (comp.type === 'board') continue;
    lines.push(`- ${comp.component_id} (${comp.type}${comp.label && comp.label !== comp.component_id ? `, "${comp.label}"` : ''}) props=${JSON.stringify(comp.props)}`);
  }
  for (const w of c.wires) lines.push(`  wire ${w.wire_id}: ${w.from.component_id}.${w.from.pin_id} ↔ ${w.to.component_id}.${w.to.pin_id}`);
  return lines.join('\n');
}
