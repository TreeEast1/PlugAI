// Logic-analyzer view of recorded edges. X axis = SIMULATED time (from MCU cycles), not wall clock.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type SignalPoint } from '../store';
import { LED_HEX } from '../lab/parts';

const WINDOWS = [500, 1000, 2000, 5000, 10000, 30000];

function measure(points: SignalPoint[]): string {
  const rises = points.filter((p, i) => i > 0 && p.v === 1 && points[i - 1].v !== 1).map((p) => p.t);
  if (rises.length < 3) return '';
  const last = rises.slice(-6);
  const per = (last[last.length - 1] - last[0]) / (last.length - 1) / 1000;
  return `T≈${per >= 100 ? per.toFixed(1) : per.toFixed(3)} ms`;
}

export function Signals() {
  const signals = useStore((s) => s.signals);
  const clock = useStore((s) => s.sim.clock);
  const circuit = useStore((s) => s.project?.circuit);
  const [win, setWin] = useState(5000);
  const [freeze, setFreeze] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const nowUs = freeze ?? clock?.simUs ?? 0;

  const rows = useMemo(() => {
    const r: { key: string; label: string; color: string; points: SignalPoint[]; kind: 'comp' | 'gpio' | 'input' }[] = [];
    for (const [k, pts] of Object.entries(signals.comp)) {
      const [cid, ch] = k.split(':');
      if (cid === 'board' && ch !== 'L') continue;
      const comp = circuit?.components.find((c) => c.component_id === cid);
      const color = ch ? LED_HEX[ch] ?? '#ffb020' : LED_HEX[String(comp?.props.color ?? 'red')] ?? '#ff3b3b';
      r.push({ key: `c:${k}`, label: `${k} (light)`, color, points: pts, kind: 'comp' });
    }
    for (const [pin, pts] of Object.entries(signals.gpio).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) r.push({ key: `g:${pin}`, label: `${pin} out`, color: '#37e2c4', points: pts, kind: 'gpio' });
    for (const [pin, pts] of Object.entries(signals.inputs).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
      if (pts.length < 2) continue;
      r.push({ key: `i:${pin}`, label: `${pin} in`, color: '#ffb36e', points: pts, kind: 'input' });
    }
    return r;
  }, [signals, circuit]);

  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const rowH = 34;
    const H = Math.max(120, rows.length * rowH + 30);
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0a0f18';
    ctx.fillRect(0, 0, W, H);
    const left = 120;
    const plotW = W - left - 10;
    const t1 = nowUs;
    const t0 = Math.max(0, t1 - win * 1000);
    const x = (t: number) => left + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
    // time grid
    ctx.font = '10px ui-monospace, Menlo, monospace';
    const steps = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
    const step = steps.find((s) => (s / win) * plotW >= 64) ?? 10000;
    for (let ms = Math.ceil(t0 / 1000 / step) * step; ms <= t1 / 1000; ms += step) {
      const xx = x(ms * 1000);
      ctx.strokeStyle = '#162033';
      ctx.beginPath();
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, H - 18);
      ctx.stroke();
      ctx.fillStyle = '#5b6b84';
      ctx.fillText(`${ms >= 1000 ? (ms / 1000).toFixed(ms % 1000 ? 2 : 0) + 's' : ms + 'ms'}`, xx + 2, H - 6);
    }
    rows.forEach((row, i) => {
      const y0 = 8 + i * rowH;
      const hi = y0 + 4;
      const lo = y0 + rowH - 10;
      ctx.fillStyle = row.kind === 'gpio' ? '#9fb0c8' : row.color;
      ctx.fillText(row.label.slice(0, 18), 6, y0 + 14);
      ctx.fillStyle = '#5b6b84';
      if (row.kind !== 'input') ctx.fillText(measure(row.points), 6, y0 + 26);
      const pts = row.points;
      let idx = pts.findIndex((p) => p.t > t0);
      if (idx === -1) idx = pts.length;
      let cur: SignalPoint['v'] = idx > 0 ? pts[idx - 1].v : row.kind === 'comp' ? 0 : 'Z';
      let cx = left;
      ctx.lineWidth = 1.6;
      const yOf = (v: SignalPoint['v']) => (v === 1 ? hi : v === 0 ? lo : (hi + lo) / 2);
      const seg = (xa: number, xb: number, v: SignalPoint['v']) => {
        if (v === 1 && row.kind === 'comp') {
          ctx.fillStyle = row.color + '33';
          ctx.fillRect(xa, hi, xb - xa, lo - hi);
        }
        ctx.strokeStyle = v === 'Z' ? '#4a5568' : row.kind === 'gpio' ? '#37e2c4' : row.color;
        ctx.setLineDash(v === 'Z' ? [3, 3] : []);
        ctx.beginPath();
        ctx.moveTo(xa, yOf(v));
        ctx.lineTo(xb, yOf(v));
        ctx.stroke();
      };
      for (let j = idx; j < pts.length && pts[j].t <= t1; j++) {
        const px = x(pts[j].t);
        seg(cx, px, cur);
        ctx.setLineDash([]);
        ctx.strokeStyle = row.kind === 'gpio' ? '#37e2c4' : row.color;
        ctx.beginPath();
        ctx.moveTo(px, yOf(cur));
        ctx.lineTo(px, yOf(pts[j].v));
        ctx.stroke();
        cur = pts[j].v;
        cx = px;
      }
      seg(cx, left + plotW, cur);
      ctx.setLineDash([]);
      ctx.strokeStyle = '#141c2b';
      ctx.beginPath();
      ctx.moveTo(0, y0 + rowH - 4);
      ctx.lineTo(W, y0 + rowH - 4);
      ctx.stroke();
    });
    for (const a of signals.actions) {
      if (a.t < t0 || a.t > t1) continue;
      const xx = x(a.t);
      ctx.strokeStyle = '#ff9f43';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, H - 18);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff9f43';
      ctx.fillText(a.label, xx + 3, 10);
    }
  }, [rows, nowUs, win, signals.actions]);

  return (
    <div className="signals-tab">
      <div className="sig-bar">
        <span className="dim">Window</span>
        {WINDOWS.map((w) => (
          <button key={w} className={`chip ${w === win ? 'on' : ''}`} onClick={() => setWin(w)}>
            {w >= 1000 ? `${w / 1000}s` : `${w}ms`}
          </button>
        ))}
        <button className={`chip ${freeze !== null ? 'on' : ''}`} onClick={() => setFreeze(freeze === null ? (clock?.simUs ?? 0) : null)}>
          {freeze !== null ? 'Frozen' : 'Live'}
        </button>
        <span className="dim">t = {(nowUs / 1000).toFixed(1)} ms (simulated)</span>
      </div>
      <div ref={wrapRef} className="sig-canvas">
        {rows.length === 0 ? <div className="dim pad">No signal edges recorded yet. Run the MCU — rows appear for every GPIO pad that changes and every observable LED channel.</div> : <canvas ref={canvasRef} />}
      </div>
      <div className="note">"out" rows: pad output-register edges from the MCU emulator. "in" rows: input level the circuit drives into the pad. Light rows: LED state computed by the circuit solver. Orange markers: user/scenario button actions.</div>
    </div>
  );
}
