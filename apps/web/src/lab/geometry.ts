export type Pt = { x: number; y: number };
export type Side = 'left' | 'right' | 'top' | 'bottom';

export const LEVEL_COLOR: Record<string, string> = {
  HIGH: '#ff6a3d',
  LOW: '#3d8bff',
  Z: '#6b7689',
  UNDEFINED: '#e8c547',
  CONFLICT: '#ff3df2',
  UNCONNECTED: '#6b7689',
};

export function sideOf(p: Pt, size: { w: number; h: number }): Side {
  if (p.y >= size.h - 0.5) return 'bottom';
  if (p.y <= 0.5) return 'top';
  if (p.x <= 0.5) return 'left';
  return 'right';
}

const DIR: Record<Side, Pt> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };

export function route(a: Pt, sa: Side, b: Pt, sb: Side, offset: number): string {
  const L = 22;
  const a1 = { x: a.x + DIR[sa].x * L, y: a.y + DIR[sa].y * L };
  const b1 = { x: b.x + DIR[sb].x * L, y: b.y + DIR[sb].y * L };
  const pts: Pt[] = [a, a1];
  if (sa === 'left' || sa === 'right') {
    const mx = (a1.x + b1.x) / 2 + offset;
    pts.push({ x: mx, y: a1.y }, { x: mx, y: b1.y });
  } else {
    const my = (a1.y + b1.y) / 2 + offset;
    pts.push({ x: a1.x, y: my }, { x: b1.x, y: my });
  }
  pts.push(b1, b);
  return 'M' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L');
}
