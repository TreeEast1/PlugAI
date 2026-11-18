// Pure renderers: they draw whatever state they are given (from the server's circuit solution).
// No timers, no animations, no inference about what the hardware "should" do.
import React from 'react';

export const LED_HEX: Record<string, string> = {
  red: '#ff3b3b',
  yellow: '#ffd23b',
  orange: '#ff8a1f',
  green: '#36ff6b',
  blue: '#3b8bff',
  white: '#f4f7ff',
};

const BAND = ['#111', '#7b4a12', '#e0261b', '#f07f12', '#f5d90a', '#25a244', '#1f5fd6', '#8b3fd1', '#8d8d8d', '#f2f2f2'];

export function resistorBands(ohms: number): string[] {
  if (!(ohms > 0)) return [BAND[0], BAND[0], BAND[0]];
  const exp = Math.floor(Math.log10(ohms)) - 1;
  const sig = Math.round(ohms / 10 ** exp);
  const d1 = Math.floor(sig / 10) % 10;
  const d2 = sig % 10;
  return [BAND[d1], BAND[d2], BAND[Math.max(0, Math.min(9, exp))] ?? BAND[0]];
}

export function fmtOhms(o: number) {
  return o >= 1e6 ? `${+(o / 1e6).toFixed(2)}MΩ` : o >= 1e3 ? `${+(o / 1e3).toFixed(2)}kΩ` : `${o}Ω`;
}

export function LedPart({ color, intensity, label, selected }: { color: string; intensity: number; label: string; selected: boolean }) {
  const hex = LED_HEX[color] ?? LED_HEX.red;
  const lit = intensity > 0.01;
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  return (
    <g>
      <defs>
        <radialGradient id={id} cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#fff" stopOpacity={lit ? 0.95 : 0.35} />
          <stop offset="45%" stopColor={hex} stopOpacity={lit ? 1 : 0.55} />
          <stop offset="100%" stopColor={hex} stopOpacity={lit ? 0.85 : 0.3} />
        </radialGradient>
      </defs>
      {lit && <circle cx={22} cy={26} r={20 + 22 * intensity} fill={hex} opacity={0.18 + 0.4 * intensity} filter="url(#ledGlow)" />}
      <line x1={15} y1={48} x2={15} y2={84} stroke="#b8c0cc" strokeWidth={2.4} />
      <line x1={29} y1={48} x2={29} y2={78} stroke="#b8c0cc" strokeWidth={2.4} />
      <line x1={29} y1={78} x2={29} y2={84} stroke="#b8c0cc" strokeWidth={2.4} />
      <path d="M8 48 V24 a14 14 0 0 1 28 0 V48 Z" fill={`url(#${id})`} stroke={selected ? '#37e2c4' : lit ? hex : '#3a4558'} strokeWidth={selected ? 2 : 1.2} />
      <rect x={6} y={46} width={32} height={5} rx={1.5} fill={lit ? hex : '#2a3343'} opacity={lit ? 0.9 : 1} />
      {lit && <ellipse cx={18} cy={20} rx={4} ry={7} fill="#fff" opacity={0.55 * intensity} />}
      <text x={22} y={-6} textAnchor="middle" className="part-label">{label}</text>
      <text x={11} y={70} className="pin-mini">+</text>
      <text x={32} y={70} className="pin-mini">−</text>
    </g>
  );
}

export function ResistorPart({ ohms, label, selected, currentMa }: { ohms: number; label: string; selected: boolean; currentMa?: number }) {
  const bands = resistorBands(ohms);
  return (
    <g>
      <line x1={0} y1={14} x2={24} y2={14} stroke="#b8c0cc" strokeWidth={2.4} />
      <line x1={72} y1={14} x2={96} y2={14} stroke="#b8c0cc" strokeWidth={2.4} />
      <rect x={22} y={4} width={52} height={20} rx={8} fill="#d9c49a" stroke={selected ? '#37e2c4' : '#8c7b55'} strokeWidth={selected ? 2 : 1} />
      {bands.map((b, i) => (
        <rect key={i} x={31 + i * 9} y={4} width={5} height={20} fill={b} />
      ))}
      <rect x={60} y={4} width={4} height={20} fill="#c9a227" />
      <text x={48} y={-4} textAnchor="middle" className="part-label">{label} · {fmtOhms(ohms)}</text>
      {currentMa !== undefined && currentMa > 0.01 && <text x={48} y={38} textAnchor="middle" className="part-sub">{currentMa.toFixed(2)} mA</text>}
    </g>
  );
}

export function ButtonPart({ pressed, label, selected, interactive }: { pressed: boolean; label: string; selected: boolean; interactive: boolean }) {
  return (
    <g style={{ cursor: interactive ? 'pointer' : 'not-allowed' }}>
      <line x1={0} y1={32} x2={10} y2={32} stroke="#b8c0cc" strokeWidth={2.4} />
      <line x1={54} y1={32} x2={64} y2={32} stroke="#b8c0cc" strokeWidth={2.4} />
      <rect x={8} y={8} width={48} height={48} rx={6} fill="#1d2431" stroke={selected ? '#37e2c4' : '#3a4558'} strokeWidth={selected ? 2 : 1.2} />
      {[12, 46].map((x) => [12, 46].map((y) => <circle key={`${x}${y}`} cx={x + 3} cy={y + 3} r={2.4} fill="#4a5568" />))}
      <circle cx={32} cy={32} r={pressed ? 13 : 15} fill={pressed ? '#0e8f7c' : '#2fd1b4'} stroke={pressed ? '#0a6b5d' : '#8ff5e2'} strokeWidth={pressed ? 3 : 1.5} />
      {!pressed && <circle cx={28} cy={27} r={5} fill="#fff" opacity={0.25} />}
      <text x={32} y={-4} textAnchor="middle" className="part-label">{label}</text>
      <text x={32} y={76} textAnchor="middle" className="part-sub">{pressed ? 'PRESSED' : interactive ? 'hold to press' : 'run MCU to press'}</text>
    </g>
  );
}

export function TrafficLightPart({ channels, label, selected }: { channels: Record<string, number>; label: string; selected: boolean }) {
  const lamps: [string, string, number][] = [
    ['red', LED_HEX.red, 30],
    ['yellow', LED_HEX.yellow, 74],
    ['green', LED_HEX.green, 118],
  ];
  return (
    <g>
      <rect x={10} y={150} width={44} height={18} fill="#232a36" />
      {[11, 25, 39, 53].map((x) => (
        <line key={x} x1={x} y1={156} x2={x} y2={168} stroke="#b8c0cc" strokeWidth={2.2} />
      ))}
      <rect x={4} y={4} width={56} height={148} rx={12} fill="#141922" stroke={selected ? '#37e2c4' : '#3a4558'} strokeWidth={selected ? 2 : 1.4} />
      {lamps.map(([k, hex, cy]) => {
        const v = channels[k] ?? 0;
        return (
          <g key={k}>
            {v > 0.01 && <circle cx={32} cy={cy} r={18 + 14 * v} fill={hex} opacity={0.25 + 0.35 * v} filter="url(#ledGlow)" />}
            <circle cx={32} cy={cy} r={16} fill={v > 0.01 ? hex : '#262d3a'} opacity={v > 0.01 ? 0.45 + 0.55 * v : 1} stroke="#0a0d12" strokeWidth={3} />
            {v <= 0.01 && <circle cx={32} cy={cy} r={11} fill={hex} opacity={0.12} />}
          </g>
        );
      })}
      <text x={32} y={-4} textAnchor="middle" className="part-label">{label}</text>
      {['R', 'Y', 'G', '⏚'].map((t, i) => (
        <text key={t} x={11 + i * 14} y={147} textAnchor="middle" className="pin-mini">{t}</text>
      ))}
    </g>
  );
}

export function Esp32Board({ geometry, pins, powered, selected }: { geometry: any; pins: any[]; powered: boolean; selected: boolean }) {
  const { w, h } = geometry.size;
  return (
    <g>
      <rect x={0} y={0} width={w} height={h} rx={10} fill="#10151d" stroke={selected ? '#37e2c4' : '#2b3442'} strokeWidth={selected ? 2 : 1.5} />
      <rect x={6} y={6} width={w - 12} height={h - 12} rx={7} fill="none" stroke="#1b2330" />
      {/* ESP32-C3-MINI-1 module */}
      <rect x={w / 2 - 62} y={14} width={124} height={58} rx={4} fill="#c9ced6" stroke="#8e97a4" />
      <rect x={w / 2 - 55} y={20} width={110} height={46} rx={2} fill="#dfe3e9" />
      <text x={w / 2} y={38} textAnchor="middle" className="silk-dark">ESP32-C3-MINI-1</text>
      <text x={w / 2} y={52} textAnchor="middle" className="silk-dark small">RISC-V · 160 MHz · 4MB</text>
      <path d={`M${w / 2 - 50} 22 h18 v6 h-12 v6 h12`} stroke="#9aa3ae" fill="none" />
      <text x={w / 2} y={h / 2 - 20} textAnchor="middle" className="silk" transform={`rotate(-90 ${w / 2} ${h / 2 - 20})`}>ESP32-C3-DevKitM-1</text>
      <text x={w / 2 - 26} y={112} textAnchor="middle" className="silk small">J1</text>
      <text x={w / 2 + 26} y={112} textAnchor="middle" className="silk small">J3</text>
      {/* onboard WS2812 (not simulated) */}
      <rect x={w / 2 - 9} y={h - 120} width={18} height={18} rx={3} fill="#e8e8e8" stroke="#999" />
      <text x={w / 2} y={h - 92} textAnchor="middle" className="silk small">RGB@IO8</text>
      <text x={w / 2} y={h - 82} textAnchor="middle" className="silk small">(not simulated)</text>
      {/* buttons */}
      <rect x={w / 2 - 70} y={h - 64} width={26} height={18} rx={3} fill="#2a2f39" stroke="#444" />
      <text x={w / 2 - 57} y={h - 36} textAnchor="middle" className="silk small">BOOT</text>
      <rect x={w / 2 + 44} y={h - 64} width={26} height={18} rx={3} fill="#2a2f39" stroke="#444" />
      <text x={w / 2 + 57} y={h - 36} textAnchor="middle" className="silk small">RST</text>
      {/* USB */}
      <rect x={w / 2 - 20} y={h - 22} width={40} height={24} rx={3} fill="#b9bec7" stroke="#7d8591" />
      {/* power LED: lit while a virtual board is powered (firmware loaded in the emulator) */}
      <circle cx={w / 2 - 6} cy={h - 50} r={4} fill={powered ? '#ff4b4b' : '#3a1515'} />
      <text x={w / 2 + 2} y={h - 47} className="silk small">PWR</text>
      {/* header pin labels */}
      {pins.map((p: any) => {
        const pos = geometry.pinPos[p.id];
        const left = pos.side === 'left';
        return (
          <g key={p.id}>
            <rect x={left ? 4 : w - 18} y={pos.y - 7} width={14} height={14} rx={2} fill="#1d1d1d" stroke="#3a3a3a" />
            <rect x={left ? 8 : w - 14} y={pos.y - 3} width={6} height={6} fill="#d4af37" />
            <text x={left ? 24 : w - 24} y={pos.y + 4} textAnchor={left ? 'start' : 'end'} className={`pin-label ${p.role}`}>
              {p.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function UnoBoard({ geometry, pins, powered, selected, lLed }: { geometry: any; pins: any[]; powered: boolean; selected: boolean; lLed: number }) {
  const { w, h } = geometry.size;
  return (
    <g>
      <path d={`M0 10 a10 10 0 0 1 10 -10 H${w - 30} l30 30 V${h - 10} a10 10 0 0 1 -10 10 H10 a10 10 0 0 1 -10 -10 Z`} fill="#0f6e8c" stroke={selected ? '#37e2c4' : '#0a4f66'} strokeWidth={selected ? 2.5 : 1.5} />
      <rect x={-14} y={40} width={58} height={56} rx={3} fill="#c0c5cc" stroke="#7f8790" />
      <text x={16} y={110} textAnchor="middle" className="silk small">USB</text>
      <rect x={-8} y={220} width={48} height={60} rx={4} fill="#151515" />
      <rect x={210} y={150} width={180} height={44} rx={3} fill="#161616" />
      {Array.from({ length: 14 }).map((_, i) => (
        <g key={i}>
          <rect x={214 + i * 12.5} y={144} width={5} height={7} fill="#bbb" />
          <rect x={214 + i * 12.5} y={193} width={5} height={7} fill="#bbb" />
        </g>
      ))}
      <text x={300} y={177} textAnchor="middle" className="silk">ATMEGA328P</text>
      <text x={120} y={150} className="silk big">UNO</text>
      <text x={120} y={172} className="silk small">ARDUINO · 16 MHz · 5 V</text>
      <circle cx={120} cy={70} r={5} fill={lLed > 0.01 ? '#ffb020' : '#3d3010'} />
      {lLed > 0.01 && <circle cx={120} cy={70} r={12} fill="#ffb020" opacity={0.35} filter="url(#ledGlow)" />}
      <text x={130} y={74} className="silk small">L (D13)</text>
      <circle cx={420} cy={70} r={5} fill={powered ? '#3dff6b' : '#103d1a'} />
      <text x={406} y={74} textAnchor="end" className="silk small">ON</text>
      {pins.map((p: any) => {
        const pos = geometry.pinPos[p.id];
        const top = pos.side === 'top';
        return (
          <g key={p.id}>
            <rect x={pos.x - 7} y={top ? 2 : h - 16} width={14} height={14} fill="#1d1d1d" stroke="#3a3a3a" />
            <rect x={pos.x - 3} y={top ? 6 : h - 12} width={6} height={6} fill="#d4af37" />
            <text x={pos.x + 4} y={top ? 22 : h - 22} textAnchor={top ? 'end' : 'start'} transform={`rotate(-90 ${pos.x + 4} ${top ? 22 : h - 22})`} className={`pin-label ${p.role}`}>
              {p.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** ST7735 module. The screen shows exactly the frame decoded by the simulator's controller model. */
export function LcdPart({ frame, label, selected, powered }: { frame?: { dataUrl: string; on: boolean; backlight: boolean }; label: string; selected: boolean; powered: boolean }) {
  const lit = !!frame && frame.on && frame.backlight;
  return (
    <g>
      <rect x={0} y={0} width={150} height={204} rx={6} fill="#b3261e" stroke={selected ? '#37e2c4' : '#7a1912'} strokeWidth={selected ? 2 : 1.2} />
      {[12, 30, 48, 66, 84, 102, 120, 138].map((x) => (
        <g key={x}>
          <line x1={x} y1={196} x2={x} y2={214} stroke="#b8c0cc" strokeWidth={2.2} />
          <circle cx={x} cy={194} r={3.2} fill="#d4af37" />
        </g>
      ))}
      {['VCC', 'GND', 'CS', 'RST', 'A0', 'SDA', 'SCK', 'LED'].map((t, i) => (
        <text key={t} x={12 + i * 18} y={186} textAnchor="middle" fill="#ffd9d4" style={{ fontSize: 7, fontFamily: 'ui-monospace, monospace' }}>{t}</text>
      ))}
      <rect x={9} y={8} width={132} height={164} rx={2} fill="#05070a" stroke="#2a2a2a" />
      {frame && powered && <image href={frame.dataUrl} x={11} y={10} width={128} height={160} style={{ imageRendering: 'pixelated', opacity: lit ? 1 : frame.on ? 0.06 : 0 }} preserveAspectRatio="none" />}
      {lit && <rect x={11} y={10} width={128} height={160} fill="none" stroke="#ffffff22" />}
      <text x={75} y={-4} textAnchor="middle" className="part-label">{/st7735|lcd|tft/i.test(label) && label.length > 6 ? label : `${label} · ST7735 128×160`}</text>
      {!lit && <text x={75} y={92} textAnchor="middle" className="part-sub">{!powered ? 'no power' : !frame ? 'waiting for MCU' : !frame.on ? 'display off / sleeping' : 'backlight off'}</text>}
    </g>
  );
}
