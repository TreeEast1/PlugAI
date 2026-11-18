import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Circuit, CircuitComponent, NetLevel, Wire } from '@plugai/shared';
import { api } from '../api';
import { getState, refreshProject, setState, toast, useStore } from '../store';
import { ButtonPart, Esp32Board, LcdPart, LedPart, ResistorPart, TrafficLightPart, UnoBoard, LED_HEX, fmtOhms } from './parts';

import { LEVEL_COLOR, route, sideOf, type Pt, type Side } from './geometry';

async function ops(list: any[]) {
  const pid = getState().project?.meta.id;
  if (!pid) return;
  try {
    const r = await api.post(`/projects/${pid}/circuit/ops`, { ops: list });
    setState((s) => (s.project ? { project: { ...s.project, circuit: r.circuitJson, solution: r.solution } } : {}));
  } catch (e) {
    toast('error', (e as Error).message);
    void refreshProject();
  }
}

export function Lab() {
  const project = useStore((s) => s.project);
  const boards = useStore((s) => s.boards);
  const sim = useStore((s) => s.sim);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 40, y: 40, k: 0.9 });
  const [drag, setDrag] = useState<null | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number } | { kind: 'move'; id: string; dx: number; dy: number; moved: boolean }>(null);
  const [localPos, setLocalPos] = useState<Record<string, Pt>>({});
  const [wiring, setWiring] = useState<null | { from: string; cursor: Pt }>(null);
  const [sel, setSel] = useState<null | { kind: 'comp' | 'wire'; id: string }>(null);
  const [hover, setHover] = useState<null | { kind: 'wire' | 'pin'; id: string; at: Pt }>(null);
  const [pressed, setPressed] = useState<Record<string, boolean>>({});
  const brightRef = useRef<Record<string, number>>({});

  const circuit = project?.circuit;
  const boardDef = useMemo(() => boards?.boards.find((b) => b.id === circuit?.board), [boards, circuit?.board]);
  const compDefs = useMemo(() => Object.fromEntries((boards?.components ?? []).map((c: any) => [c.type, c])), [boards]);
  const running = sim.status === 'running';
  const simLoaded = ['running', 'paused', 'loaded'].includes(sim.status);

  const sizeOf = useCallback(
    (c: CircuitComponent) => (c.type === 'board' ? boardDef?.geometry.size : compDefs[c.type]?.size) ?? { w: 40, h: 40 },
    [boardDef, compDefs],
  );
  const posOf = useCallback((c: CircuitComponent): Pt => localPos[c.component_id] ?? { x: c.appearance.x, y: c.appearance.y }, [localPos]);
  const pinLocal = useCallback(
    (c: CircuitComponent, pin: string): Pt | null => {
      if (c.type === 'board') return boardDef?.geometry.pinPos[pin] ?? null;
      return compDefs[c.type]?.pinPos[pin] ?? null;
    },
    [boardDef, compDefs],
  );
  const pinAbs = useCallback(
    (ref: string): { p: Pt; side: Side } | null => {
      if (!circuit) return null;
      const [cid, pid] = [ref.slice(0, ref.indexOf('.')), ref.slice(ref.indexOf('.') + 1)];
      const c = circuit.components.find((x) => x.component_id === cid);
      if (!c) return null;
      const lp = pinLocal(c, pid);
      if (!lp) return null;
      const o = posOf(c);
      const side = c.type === 'board' ? ((boardDef?.geometry.pinPos[pid]?.side as Side) ?? 'left') : sideOf(lp, sizeOf(c));
      return { p: { x: o.x + lp.x, y: o.y + lp.y }, side };
    },
    [circuit, pinLocal, posOf, boardDef, sizeOf],
  );

  // live net levels: from the simulator frame if loaded, else the static solution
  const netLevel = useCallback(
    (netId: string | undefined): { level: NetLevel; voltage: number | null } | null => {
      if (!netId || !project) return null;
      if (simLoaded && sim.nets[netId]) return sim.nets[netId];
      const n = project.solution?.nets.find((x) => x.net_id === netId);
      return n ? { level: n.level, voltage: n.voltage } : null;
    },
    [project, sim.nets, simLoaded],
  );
  const pinNet = project?.solution?.pinNet ?? {};
  const comps = (simLoaded && sim.components) || project?.solution?.components || {};

  const toWorld = (cx: number, cy: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,.cm-editor')) return;
      if (e.key === 'Escape') {
        setWiring(null);
        setSel(null);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        if (sel.kind === 'wire') void ops([{ op: 'disconnect', wire_id: sel.id }]);
        else if (sel.id !== 'board') void ops([{ op: 'remove_component', component_id: sel.id }]);
        setSel(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel]);

  const fit = useCallback(() => {
    if (!circuit || !svgRef.current) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of circuit.components) {
      const p = posOf(c);
      const s = sizeOf(c);
      minX = Math.min(minX, p.x - 30);
      minY = Math.min(minY, p.y - 40);
      maxX = Math.max(maxX, p.x + s.w + 30);
      maxY = Math.max(maxY, p.y + s.h + 60);
    }
    const r = svgRef.current.getBoundingClientRect();
    const k = Math.min(1.4, Math.max(0.3, Math.min(r.width / (maxX - minX), r.height / (maxY - minY)) * 0.92));
    setView({ k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k });
  }, [circuit, posOf, sizeOf]);
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (circuit && boardDef && fitted.current !== project?.meta.id) {
      fitted.current = project!.meta.id;
      setTimeout(fit, 30);
    }
  }, [circuit, boardDef, fit, project]);

  if (!project || !circuit || !boardDef) return <div className="lab empty">Select or create a project</div>;

  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (wiring) {
      setWiring(null);
      return;
    }
    setSel(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
  };
  const onMove = (e: React.PointerEvent) => {
    if (wiring) setWiring({ ...wiring, cursor: toWorld(e.clientX, e.clientY) });
    if (!drag) return;
    if (drag.kind === 'pan') setView((v) => ({ ...v, x: drag.vx + e.clientX - drag.sx, y: drag.vy + e.clientY - drag.sy }));
    else {
      const w = toWorld(e.clientX, e.clientY);
      setLocalPos((lp) => ({ ...lp, [drag.id]: { x: Math.round(w.x - drag.dx), y: Math.round(w.y - drag.dy) } }));
      if (!drag.moved) setDrag({ ...drag, moved: true });
    }
  };
  const onUp = () => {
    if (drag?.kind === 'move' && drag.moved && localPos[drag.id]) {
      const p = localPos[drag.id];
      void ops([{ op: 'move_component', component_id: drag.id, x: p.x, y: p.y }]).then(() => setLocalPos((lp) => {
        const n = { ...lp };
        delete n[drag.id];
        return n;
      }));
    }
    setDrag(null);
  };
  const onWheel = (e: React.WheelEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k2 = Math.min(3, Math.max(0.25, view.k * Math.exp(-e.deltaY * 0.0015)));
    setView({ k: k2, x: mx - ((mx - view.x) / view.k) * k2, y: my - ((my - view.y) / view.k) * k2 });
  };
  const startMove = (e: React.PointerEvent, c: CircuitComponent) => {
    e.stopPropagation();
    if (wiring) return;
    setSel({ kind: 'comp', id: c.component_id });
    const w = toWorld(e.clientX, e.clientY);
    const p = posOf(c);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: 'move', id: c.component_id, dx: w.x - p.x, dy: w.y - p.y, moved: false });
  };
  const onPinClick = (e: React.PointerEvent, ref: string) => {
    e.stopPropagation();
    if (!wiring) {
      setWiring({ from: ref, cursor: toWorld(e.clientX, e.clientY) });
      return;
    }
    if (wiring.from !== ref) void ops([{ op: 'connect', from: wiring.from, to: ref }]);
    setWiring(null);
  };
  const press = async (id: string, down: boolean) => {
    if (!running && down) {
      toast('info', 'The button acts on the running MCU — press Run first.');
      return;
    }
    setPressed((p) => ({ ...p, [id]: down }));
    try {
      await api.post(`/projects/${project.meta.id}/sim/button`, { component: id, pressed: down });
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const intensity = (key: string, st: any): number => {
    if (!st) return 0;
    const b = st.brightness ?? (st.lit ? 0.7 : 0);
    if (b > 0) brightRef.current[key] = b;
    const d = sim.duty?.[key];
    if (simLoaded && d !== undefined) return d * (brightRef.current[key] ?? 0.7);
    return st.lit ? b : 0;
  };

  const wires = circuit.wires;
  const selectedWire = sel?.kind === 'wire' ? wires.find((w) => w.wire_id === sel.id) : undefined;
  const selectedComp = sel?.kind === 'comp' ? circuit.components.find((c) => c.component_id === sel.id) : undefined;
  const warnings = (simLoaded ? sim.warnings : project.solution?.warnings) ?? [];

  return (
    <div className="lab">
      <Palette board={circuit.board} onFit={fit} />
      <SimBadge />
      <svg
        ref={svgRef}
        className={`lab-svg ${drag?.kind === 'pan' ? 'panning' : ''} ${wiring ? 'wiring' : ''}`}
        onPointerDown={onBgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
      >
        <defs>
          <pattern id="grid" width={20 * view.k} height={20 * view.k} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={1} cy={1} r={0.9} fill="#1f2a3a" />
          </pattern>
          <filter id="ledGlow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {/* wires below parts */}
          {wires.map((w: Wire, i) => {
            const a = pinAbs(`${w.from.component_id}.${w.from.pin_id}`);
            const b = pinAbs(`${w.to.component_id}.${w.to.pin_id}`);
            if (!a || !b) return null;
            const net = pinNet[`${w.from.component_id}.${w.from.pin_id}`];
            const nl = netLevel(net);
            const color = nl ? LEVEL_COLOR[nl.level] : '#6b7689';
            const d = route(a.p, a.side, b.p, b.side, ((i % 5) - 2) * 7);
            const isSel = sel?.kind === 'wire' && sel.id === w.wire_id;
            return (
              <g key={w.wire_id} className="wire" onPointerDown={(e) => { e.stopPropagation(); setSel({ kind: 'wire', id: w.wire_id }); }} onPointerEnter={(e) => setHover({ kind: 'wire', id: w.wire_id, at: toWorld(e.clientX, e.clientY) })} onPointerLeave={() => setHover(null)}>
                <path d={d} stroke="transparent" strokeWidth={12} fill="none" />
                {isSel && <path d={d} stroke="#37e2c4" strokeWidth={7} fill="none" opacity={0.35} />}
                <path d={d} stroke={color} strokeWidth={nl?.level === 'HIGH' ? 3.2 : 2.6} fill="none" strokeLinejoin="round" strokeDasharray={nl?.level === 'Z' || !nl ? '6 5' : undefined} opacity={0.95} />
              </g>
            );
          })}
          {wiring && (() => {
            const a = pinAbs(wiring.from);
            return a ? <line x1={a.p.x} y1={a.p.y} x2={wiring.cursor.x} y2={wiring.cursor.y} stroke="#37e2c4" strokeWidth={2} strokeDasharray="5 4" /> : null;
          })()}
          {/* components */}
          {circuit.components.map((c) => {
            const p = posOf(c);
            const isSel = sel?.kind === 'comp' && sel.id === c.component_id;
            const st: any = (comps as any)[c.component_id];
            let body: React.ReactNode = null;
            if (c.type === 'board') {
              body = c.board === 'arduino-uno' ? (
                <UnoBoard geometry={boardDef.geometry} pins={boardDef.pins} powered={simLoaded} selected={isSel} lLed={st?.channels?.L ? intensity('board:L', st.channels.L) : 0} />
              ) : (
                <Esp32Board geometry={boardDef.geometry} pins={boardDef.pins} powered={simLoaded} selected={isSel} />
              );
            } else if (c.type === 'led') body = <LedPart color={String(c.props.color ?? 'red')} intensity={intensity(c.component_id, st)} label={c.label ?? c.component_id} selected={isSel} />;
            else if (c.type === 'resistor') body = <ResistorPart ohms={Number(c.props.ohms ?? 220)} label={c.label ?? c.component_id} selected={isSel} currentMa={simLoaded ? st?.currentMa : undefined} />;
            else if (c.type === 'button') body = <ButtonPart pressed={!!(st?.pressed ?? pressed[c.component_id])} label={c.label ?? c.component_id} selected={isSel} interactive={running} />;
            else if (c.type === 'lcd') body = <LcdPart frame={simLoaded ? sim.displays[c.component_id] : undefined} label={c.label ?? c.component_id} selected={isSel} powered={!!st?.lcd?.powered} />;
            else if (c.type === 'traffic-light') {
              const ch: Record<string, number> = {};
              for (const k of ['red', 'yellow', 'green']) ch[k] = st?.channels?.[k] ? intensity(`${c.component_id}:${k}`, st.channels[k]) : 0;
              body = <TrafficLightPart channels={ch} label={c.label ?? c.component_id} selected={isSel} />;
            }
            const size = sizeOf(c);
            const pinIds: string[] = c.type === 'board' ? boardDef.pins.map((x: any) => x.id) : compDefs[c.type]?.pins.map((x: string) => x.split(' ')[0]) ?? [];
            return (
              <g key={c.component_id} transform={`translate(${p.x} ${p.y})`}>
                <g onPointerDown={(e) => startMove(e, c)} style={{ cursor: 'move' }}>
                  <rect x={-4} y={-4} width={size.w + 8} height={size.h + 8} fill="transparent" />
                  {body}
                </g>
                {c.type === 'button' && (
                  <circle
                    cx={32}
                    cy={32}
                    r={17}
                    fill="transparent"
                    style={{ cursor: running ? 'pointer' : 'not-allowed' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.target as Element).setPointerCapture?.(e.pointerId);
                      void press(c.component_id, true);
                    }}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                      if (pressed[c.component_id]) void press(c.component_id, false);
                    }}
                  />
                )}
                {pinIds.map((pid) => {
                  const lp = pinLocal(c, pid);
                  if (!lp) return null;
                  const ref = `${c.component_id}.${pid}`;
                  const nl = netLevel(pinNet[ref]);
                  const connected = wires.some((w) => (w.from.component_id === c.component_id && w.from.pin_id === pid) || (w.to.component_id === c.component_id && w.to.pin_id === pid));
                  const isWiringFrom = wiring?.from === ref;
                  return (
                    <circle
                      key={pid}
                      cx={lp.x}
                      cy={lp.y}
                      r={isWiringFrom ? 6 : 4.2}
                      className={`pin ${connected ? 'connected' : ''} ${wiring ? 'target' : ''}`}
                      fill={connected && nl ? LEVEL_COLOR[nl.level] : '#0b0f16'}
                      stroke={isWiringFrom ? '#37e2c4' : '#8fa3bf'}
                      strokeWidth={1.4}
                      onPointerDown={(e) => onPinClick(e, ref)}
                      onPointerEnter={(e) => setHover({ kind: 'pin', id: ref, at: toWorld(e.clientX, e.clientY) })}
                      onPointerLeave={() => setHover(null)}
                    />
                  );
                })}
              </g>
            );
          })}
          {hover && <HoverTip hover={hover} circuit={circuit} pinNet={pinNet} netLevel={netLevel} />}
        </g>
      </svg>
      {warnings.length > 0 && (
        <div className="lab-warnings">
          {warnings.filter((w: any) => w.code !== 'RESERVED_PIN' || warnings.length < 4).slice(0, 6).map((w: any, i: number) => (
            <div key={i} className={`warn ${w.severity}`}>
              <b>{w.code}</b> {w.message}
            </div>
          ))}
        </div>
      )}
      {(selectedComp || selectedWire) && <Inspector comp={selectedComp} wire={selectedWire} comps={comps} pinNet={pinNet} netLevel={netLevel} onClose={() => setSel(null)} />}
      <div className="lab-hint">
        {wiring ? `Wiring from ${wiring.from} — click a target pin (Esc to cancel)` : 'Drag parts · click a pin to start a wire · click a wire then Delete to remove · scroll to zoom'}
      </div>
    </div>
  );
}

function HoverTip({ hover, circuit, pinNet, netLevel }: { hover: { kind: string; id: string; at: Pt }; circuit: Circuit; pinNet: Record<string, string>; netLevel: (n?: string) => any }) {
  let netId: string | undefined;
  let title = hover.id;
  if (hover.kind === 'wire') {
    const w = circuit.wires.find((x) => x.wire_id === hover.id);
    if (!w) return null;
    netId = pinNet[`${w.from.component_id}.${w.from.pin_id}`];
    title = `${w.from.component_id}.${w.from.pin_id} ↔ ${w.to.component_id}.${w.to.pin_id}`;
  } else netId = pinNet[hover.id];
  const nl = netLevel(netId);
  return (
    <g transform={`translate(${hover.at.x + 12} ${hover.at.y - 34})`} pointerEvents="none">
      <rect width={230} height={46} rx={6} fill="#0b1220" stroke="#2c3a52" opacity={0.96} />
      <text x={8} y={17} className="tip">{title}</text>
      <text x={8} y={35} className="tip dim">
        {netId ?? 'no net'} · {nl ? `${nl.level}${nl.voltage !== null && nl.voltage !== undefined ? ` · ${nl.voltage.toFixed(2)} V` : ''}` : '—'}
      </text>
    </g>
  );
}

function Inspector({ comp, wire, comps, pinNet, netLevel, onClose }: any) {
  const project = useStore((s) => s.project)!;
  if (wire) {
    const net = pinNet[`${wire.from.component_id}.${wire.from.pin_id}`];
    const nl = netLevel(net);
    const pins = project.solution.nets.find((n) => n.net_id === net)?.pins ?? [];
    return (
      <div className="inspector">
        <div className="insp-head">
          <b>Wire {wire.wire_id}</b>
          <button className="ghost" onClick={onClose}>×</button>
        </div>
        <div className="kv"><span>From</span><code>{wire.from.component_id}.{wire.from.pin_id}</code></div>
        <div className="kv"><span>To</span><code>{wire.to.component_id}.{wire.to.pin_id}</code></div>
        <div className="kv"><span>Net</span><code>{net}</code></div>
        <div className="kv"><span>Live level</span><b style={{ color: LEVEL_COLOR[nl?.level ?? 'Z'] }}>{nl?.level ?? '—'}{nl?.voltage != null ? ` · ${nl.voltage.toFixed(3)} V` : ''}</b></div>
        <div className="kv"><span>Net pins</span><small>{pins.join(', ')}</small></div>
        <button className="danger sm" onClick={() => { void ops([{ op: 'disconnect', wire_id: wire.wire_id }]); onClose(); }}>Delete wire</button>
      </div>
    );
  }
  const c: CircuitComponent = comp;
  const st = comps[c.component_id];
  return (
    <div className="inspector">
      <div className="insp-head">
        <b>{c.label ?? c.component_id}</b> <small>{c.type} · {c.model}</small>
        <button className="ghost" onClick={onClose}>×</button>
      </div>
      {c.type === 'led' && (
        <div className="kv">
          <span>Colour</span>
          <select value={String(c.props.color)} onChange={(e) => void ops([{ op: 'update_component', component_id: c.component_id, props: { color: e.target.value } }])}>
            {Object.keys(LED_HEX).map((k) => <option key={k}>{k}</option>)}
          </select>
        </div>
      )}
      {c.type === 'resistor' && (
        <div className="kv">
          <span>Resistance</span>
          <select value={String(c.props.ohms)} onChange={(e) => void ops([{ op: 'update_component', component_id: c.component_id, props: { ohms: Number(e.target.value) } }])}>
            {[0.1, 10, 47, 100, 150, 220, 330, 470, 680, 1000, 2200, 4700, 10000, 47000].map((o) => <option key={o} value={o}>{fmtOhms(o)}</option>)}
          </select>
        </div>
      )}
      {st?.currentMa !== undefined && <div className="kv"><span>Current</span><b>{st.currentMa.toFixed(2)} mA</b></div>}
      {st?.lit !== undefined && c.type === 'led' && <div className="kv"><span>State</span><b>{st.lit ? 'LIT (from circuit solve)' : 'off'}</b></div>}
      {st?.channels && <div className="kv"><span>Channels</span><small>{Object.entries(st.channels).map(([k, v]: any) => `${k}:${v.lit ? 'on' : 'off'} ${v.currentMa ? `${v.currentMa}mA` : ''}`).join(' · ')}</small></div>}
      {c.type !== 'board' && (
        <div className="insp-pins">
          {Object.keys(pinNet).filter((k) => k.startsWith(c.component_id + '.')).map((k) => {
            const nl = netLevel(pinNet[k]);
            return <div key={k} className="kv"><span>{k.split('.')[1]}</span><code>{pinNet[k]}</code><b style={{ color: LEVEL_COLOR[nl?.level ?? 'Z'] }}>{nl?.level}</b></div>;
          })}
        </div>
      )}
      {c.type !== 'board' && <button className="danger sm" onClick={() => { void ops([{ op: 'remove_component', component_id: c.component_id }]); onClose(); }}>Remove part</button>}
      {c.type === 'board' && <small className="dim">Board pins are fixed. GND pins are internally common.</small>}
    </div>
  );
}

function Palette({ board, onFit }: { board: string; onFit: () => void }) {
  const [color, setColor] = useState('red');
  return (
    <div className="palette">
      <span className="pal-title">Parts</span>
      <button onClick={() => void ops([{ op: 'add_component', type: 'led', props: { color } }])} title="Add LED">
        <span className="dot" style={{ background: LED_HEX[color] }} /> LED
      </button>
      <select value={color} onChange={(e) => setColor(e.target.value)} title="LED colour">
        {Object.keys(LED_HEX).map((k) => <option key={k}>{k}</option>)}
      </select>
      <button onClick={() => void ops([{ op: 'add_component', type: 'resistor', props: { ohms: board === 'arduino-uno' ? 330 : 220 } }])}>Resistor</button>
      <button onClick={() => void ops([{ op: 'add_component', type: 'button' }])}>Button</button>
      <button onClick={() => void ops([{ op: 'add_component', type: 'traffic-light' }])}>Traffic light</button>
      <button disabled={board !== 'arduino-uno'} title={board !== 'arduino-uno' ? 'LCD/SPI devices are only simulated on the Arduino Uno backend' : 'ST7735 1.8" TFT over hardware SPI'} onClick={() => void ops([{ op: 'add_component', type: 'lcd' }])}>LCD</button>
      <span className="sep" />
      <button onClick={() => void ops([{ op: 'auto_layout' }]).then(() => setTimeout(onFit, 50))}>Auto layout</button>
      <button onClick={onFit}>Fit</button>
    </div>
  );
}

function SimBadge() {
  const sim = useStore((s) => s.sim);
  const loaded = useStore((s) => s.project?.loaded);
  const c = sim.clock;
  const cls = sim.status === 'running' ? 'run' : sim.status === 'crashed' || sim.status === 'error' ? 'err' : sim.status === 'paused' || sim.status === 'loaded' ? 'pause' : 'idle';
  return (
    <div className={`sim-badge ${cls}`}>
      <span className="led-dot" />
      <b>MCU {sim.status.toUpperCase()}</b>
      {c && <span>t<sub>sim</sub> {(c.simUs / 1e6).toFixed(3)} s</span>}
      {c && sim.status === 'running' && <span>×{c.speed ? c.speed.toFixed(2) : '—'} real-time</span>}
      {c && <span>{(c.cycles / 1e6).toFixed(1)} M cycles</span>}
      {loaded && <span className="tag">{loaded.method === 'esptool-virtual-uart' ? 'flashed via esptool · virtual UART' : 'direct image load'}</span>}
    </div>
  );
}
