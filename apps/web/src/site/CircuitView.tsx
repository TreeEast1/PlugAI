// Read-only circuit renderer for recorded runs. Every visual state is looked up from the recorded
// emulator timelines at playback time t (ms of simulated time). Nothing is inferred.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { isStaticSite } from './data';
import { BASE } from '../router';
import { ButtonPart, Esp32Board, LcdPart, LedPart, ResistorPart, TrafficLightPart, UnoBoard } from '../lab/parts';
import { LEVEL_COLOR, route, sideOf, type Side } from '../lab/geometry';

let boardsCache: Promise<any> | null = null;
export function useBoards() {
  const [b, setB] = useState<any>(null);
  useEffect(() => {
    boardsCache ??= isStaticSite
      ? fetch(`${BASE}data/boards.json`).then((r) => {
          if (!r.ok) throw new Error(`boards.json: ${r.status}`);
          return r.json();
        })
      : api.get('/boards');
    void boardsCache.then(setB);
  }, []);
  return b;
}

function at<T extends { t: number } = any>(arr: T[] | undefined, t: number): T | undefined {
  if (!arr?.length) return undefined;
  let lo = 0;
  let hi = arr.length - 1;
  if (arr[0].t > t) return undefined;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return arr[lo];
}

export function CircuitView({ kase, t, assetBase, className }: { kase: any; t: number; assetBase: string; className?: string }) {
  const boards = useBoards();
  const circuit = kase.final.circuit;
  const replay = kase.replay;
  const boardDef = boards?.boards.find((b: any) => b.id === circuit.board);
  const compDefs = useMemo(() => Object.fromEntries((boards?.components ?? []).map((c: any) => [c.type, c])), [boards]);
  const box = useMemo(() => {
    if (!boardDef) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of circuit.components) {
      const s = c.type === 'board' ? boardDef.geometry.size : compDefs[c.type]?.size ?? { w: 40, h: 40 };
      minX = Math.min(minX, c.appearance.x - 40);
      minY = Math.min(minY, c.appearance.y - 40);
      maxX = Math.max(maxX, c.appearance.x + s.w + 40);
      maxY = Math.max(maxY, c.appearance.y + s.h + 50);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }, [boardDef, compDefs, circuit]);
  if (!boardDef || !box) return <div className={`cv-loading ${className ?? ''}`} />;

  const pinPos = (ref: string): { p: { x: number; y: number }; side: Side } | null => {
    const i = ref.indexOf('.');
    const cid = ref.slice(0, i);
    const pid = ref.slice(i + 1);
    const c = circuit.components.find((x: any) => x.component_id === cid);
    if (!c) return null;
    if (c.type === 'board') {
      const g = boardDef.geometry.pinPos[pid];
      return g ? { p: { x: c.appearance.x + g.x, y: c.appearance.y + g.y }, side: g.side } : null;
    }
    const d = compDefs[c.type];
    const lp = d?.pinPos[pid];
    return lp ? { p: { x: c.appearance.x + lp.x, y: c.appearance.y + lp.y }, side: sideOf(lp, d.size) } : null;
  };
  const pinNet: Record<string, string> = kase.final.pinNet;
  const netLevel = (net: string): string => {
    const pins = Object.keys(pinNet).filter((k) => pinNet[k] === net && k.startsWith('board.'));
    for (const p of pins) {
      const ev = at<{ t: number; v: 0 | 1 | 'Z' }>(replay?.gpio?.[p.slice(6)], t);
      if (ev) return ev.v === 1 ? 'HIGH' : ev.v === 0 ? 'LOW' : 'Z';
    }
    return kase.final.staticNets[net] ?? 'Z';
  };
  const light = (key: string) => {
    const e = at<{ t: number; on: boolean; b: number }>(replay?.components?.[key], t);
    return e?.on ? Math.max(0.55, e.b || 0.75) : 0;
  };
  const pressed = (id: string) => {
    const s = (replay?.stimuli ?? []).filter((x: any) => x.component === id && x.t <= t);
    return s.length ? s[s.length - 1].pressed : false;
  };
  const frame = at<{ t: number; file: string }>(replay?.frames, t);
  const powered = !!replay;

  return (
    <svg className={`circuit-view ${className ?? ''}`} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <filter id="ledGlow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>
      {circuit.wires.map((w: any, i: number) => {
        const a = pinPos(`${w.from.component_id}.${w.from.pin_id}`);
        const b = pinPos(`${w.to.component_id}.${w.to.pin_id}`);
        if (!a || !b) return null;
        const lv = netLevel(pinNet[`${w.from.component_id}.${w.from.pin_id}`]);
        return <path key={w.wire_id} d={route(a.p, a.side, b.p, b.side, ((i % 5) - 2) * 7)} stroke={LEVEL_COLOR[lv] ?? '#6b7689'} strokeWidth={lv === 'HIGH' ? 3.2 : 2.6} fill="none" strokeLinejoin="round" strokeDasharray={lv === 'Z' ? '6 5' : undefined} />;
      })}
      {circuit.components.map((c: any) => {
        let body: React.ReactNode = null;
        if (c.type === 'board') body = c.board === 'arduino-uno' ? <UnoBoard geometry={boardDef.geometry} pins={boardDef.pins} powered={powered} selected={false} lLed={light('board:L')} /> : <Esp32Board geometry={boardDef.geometry} pins={boardDef.pins} powered={powered} selected={false} />;
        else if (c.type === 'led') body = <LedPart color={String(c.props.color ?? 'red')} intensity={light(c.component_id)} label={c.label ?? c.component_id} selected={false} />;
        else if (c.type === 'resistor') body = <ResistorPart ohms={Number(c.props.ohms ?? 220)} label={c.label ?? c.component_id} selected={false} />;
        else if (c.type === 'button') body = <ButtonPart pressed={pressed(c.component_id)} label={c.label ?? c.component_id} selected={false} interactive />;
        else if (c.type === 'traffic-light') body = <TrafficLightPart channels={{ red: light(`${c.component_id}:red`), yellow: light(`${c.component_id}:yellow`), green: light(`${c.component_id}:green`) }} label={c.label ?? c.component_id} selected={false} />;
        else if (c.type === 'lcd') body = <LcdPart frame={frame ? { dataUrl: `${assetBase}/${frame.file}`, on: true, backlight: true } : undefined} label={c.label ?? c.component_id} selected={false} powered={powered} />;
        return (
          <g key={c.component_id} transform={`translate(${c.appearance.x} ${c.appearance.y})`}>
            {body}
          </g>
        );
      })}
    </svg>
  );
}

/** Playback clock for a recorded replay (simulated ms). */
export function usePlayback(durationMs: number, opts: { autoplay?: boolean; loop?: boolean; speed?: number } = {}) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(opts.autoplay ?? true);
  const [speed, setSpeed] = useState(opts.speed ?? 1);
  useEffect(() => {
    if (!playing || !durationMs) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      setT((x) => {
        const n = x + dt;
        if (n >= durationMs) return opts.loop === false ? durationMs : n % durationMs;
        return n;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationMs, speed, opts.loop]);
  return { t, setT, playing, setPlaying, speed, setSpeed };
}
