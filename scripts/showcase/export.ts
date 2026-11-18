// Export recorded AI runs into showcase cases (showcase/<slug>/). Everything comes from real project data:
// run logs, final sources, build records, verification reports, and a fresh emulator recording of the final firmware.
import 'dotenv/config';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { solveCircuit } from '@plugai/circuit';
import { VirtualHardware } from '@plugai/simulator';
import { avrDirectLoad } from '@plugai/backend-avr';
import { getBoard, type BuildRecord, type Circuit } from '@plugai/shared';
import { decodeFrame, rgb565Png } from '../../packages/simulator/src/devices/png.ts';
import { ROOT } from '../test/lib.ts';

interface CaseDef {
  slug: string;
  project: string; // project name
  title: string;
  subtitle: string;
  tags: string[];
  order: number;
  kind?: 'build' | 'boundary';
  featured?: boolean;
}

export const CASES: CaseDef[] = [
  { slug: 'pikachu-lcd', project: 'Pikachu on LCD', title: 'LCD 像素皮卡丘', subtitle: 'AI 手写 ST7735 驱动，硬件 SPI 绘制像素图并每秒眨眼', tags: ['Arduino Uno', 'LCD · SPI', 'PROGMEM 精灵图'], order: 1, featured: true },
  { slug: 'esp32-blink-iteration', project: '§15 Final: ESP32 LED blink', title: '一句话点亮 ESP32', subtitle: '1 s 闪烁 → 改成 200 ms → 故意接错 GPIO → 修复连线，四轮对话同一工程', tags: ['ESP32-C3', '多轮迭代', 'esptool 虚拟烧录', '故障注入'], order: 2, featured: true },
  { slug: 'traffic-light', project: 'AI traffic light', title: '红黄绿交通灯 + 行人按钮', subtitle: '状态机 5 s / 4 s / 2 s，第二轮加入行人按钮提前结束绿灯', tags: ['ESP32-C3', '状态机', '按钮交互'], order: 3, featured: true },
  { slug: 'lcd-pet', project: 'LCD pixel pet', title: '像素电子宠物', subtitle: '橘猫坐在草地上，尾巴每 500 ms 摆动，顶部像素字 HI', tags: ['Arduino Uno', 'LCD · SPI', '动画'], order: 4 },
  { slug: 'sos-light', project: 'LLM A: SOS light', title: '求救灯 SOS', subtitle: '三快两慢的循环节奏；随后注入编译错误与接线故障，AI 读真实报错与 GPIO 证据修复', tags: ['ESP32-C3', '自动修复', '非模板需求'], order: 5 },
  { slug: 'button-swap-hold', project: 'LLM B/C: swap two LEDs with a button', title: '按钮交换两灯', subtitle: '每按一次交换亮灭；第二轮增量改为长按 2 秒才切换', tags: ['ESP32-C3', '边沿检测', '增量修改'], order: 6 },
  { slug: 'heartbeat', project: 'LLM E: heartbeat', title: '心跳灯', subtitle: '1.2 s 周期：120 ms 亮 / 150 ms 灭 / 120 ms 亮，绿色 LED', tags: ['ESP32-C3', '节奏图案'], order: 7 },
  { slug: 'dual-rate', project: 'LLM-06 #3', title: '双灯不同频率', subtitle: '一个 1 s、一个 0.4 s，互不阻塞的非阻塞定时', tags: ['ESP32-C3', '并发定时'], order: 8 },
  { slug: 'alternate-blink', project: 'LLM-06 #1', title: '双灯交替闪烁', subtitle: '两灯各亮 300 ms 交替', tags: ['ESP32-C3'], order: 9 },
  { slug: 'hold-both', project: 'LLM-06 #2', title: '按住全亮', subtitle: '按住按钮两灯全亮，松开全灭', tags: ['ESP32-C3', '按钮交互'], order: 10 },
  { slug: 'uno-blink-200', project: 'LLM Uno blink', title: 'Arduino Uno 200 ms 闪烁', subtitle: 'arduino-cli + avr8js，周期误差 0.02 ms', tags: ['Arduino Uno'], order: 11 },
  { slug: 'oled-boundary', project: 'LLM capability boundary', title: '能力边界：OLED 温度显示', subtitle: '平台没有温度传感器与 I2C OLED 模型——AI 如实拒绝，不伪造结果', tags: ['诚实边界', 'ESP32-C3'], order: 12, kind: 'boundary' },
];

const PROJ = join(ROOT, 'workspaces', 'projects');
const OUT = join(ROOT, 'showcase');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

function findProject(name: string, needSuccess: boolean): string | null {
  const cands = readdirSync(PROJ)
    .filter((d) => existsSync(join(PROJ, d, 'project.json')))
    .map((d) => ({ d, m: json(join(PROJ, d, 'project.json')) }))
    .filter((x) => x.m.name === name)
    .sort((a, b) => b.m.createdAt.localeCompare(a.m.createdAt));
  for (const c of cands) {
    const rd = join(PROJ, c.d, 'runs');
    if (!existsSync(rd)) continue;
    const runs = readdirSync(rd).filter((r) => existsSync(join(rd, r, 'run.json'))).map((r) => json(join(rd, r, 'run.json')));
    if (!runs.length) continue;
    if (needSuccess && !runs.every((r) => r.status === 'success')) continue;
    return c.d;
  }
  return null;
}

function condense(events: any[], t0: number) {
  const out: any[] = [];
  for (const e of events) {
    const t = Math.max(0, Date.parse(e.at) - t0);
    if (e.kind === 'phase') out.push({ t, kind: 'phase', phase: e.phase, label: e.message });
    else if (e.kind === 'llm-call') out.push({ t, kind: 'llm', role: e.call.role, ms: e.call.durationMs, tokens: (e.call.usage?.promptTokens ?? 0) + (e.call.usage?.completionTokens ?? 0), tools: e.call.toolCalls.map((x: any) => x.name) });
    else if (e.kind === 'tool-end') out.push({ t, kind: 'tool', role: e.record.role, name: e.record.name, ok: e.record.ok, ms: e.record.durationMs, preview: String(e.record.resultPreview).split('\n')[0].slice(0, 160) });
    else if (e.kind === 'build') out.push({ t, kind: 'build', status: e.build.status, ms: e.build.durationMs, error: e.build.error });
    else if (e.kind === 'flash') out.push({ t, kind: 'flash', method: e.flash.method, status: e.flash.status, bytes: e.flash.bytesWritten });
    else if (e.kind === 'verification') out.push({ t, kind: 'verify', passed: e.report.passed, results: e.report.results.map((r: any) => ({ passed: r.passed, detail: r.detail, type: r.check.type })) });
    else if (e.kind === 'file-change') out.push({ t, kind: 'file', path: e.path, added: e.diffStat.added, removed: e.diffStat.removed });
    else if (e.kind === 'assistant') out.push({ t, kind: 'say', role: e.role, text: e.content.slice(0, 400) });
    else if (e.kind === 'final') out.push({ t, kind: 'final', status: e.status });
  }
  return out;
}

async function recordReplay(pid: string, board: string, circuit: Circuit, build: BuildRecord, scenario: any, slugDir: string) {
  const dir = join(PROJ, pid);
  let image: Uint8Array;
  let method = 'direct-image-load';
  const loaded = existsSync(join(dir, 'device', 'loaded.json')) ? json(join(dir, 'device', 'loaded.json')) : null;
  if (board === 'arduino-uno') image = avrDirectLoad(pid, dir, build).image;
  else if (loaded && loaded.buildId === build.buildId && existsSync(loaded.image)) {
    image = new Uint8Array(readFileSync(loaded.image));
    method = loaded.method;
  } else image = new Uint8Array(readFileSync(join(dir, build.artifacts.find((a) => a.kind === 'merged-bin')!.path)));
  const def = getBoard(board as any);
  const hasLcd = circuit.components.some((c) => c.type === 'lcd');
  const durationMs = Math.min(24_000, Math.max(hasLcd ? 5000 : 4000, scenario?.duration_ms ?? 4000));
  const hw = new VirtualHardware({ backend: def.backend, board: def.id, circuit, image, firmware: { buildId: build.buildId, sha256: build.artifacts[0].sha256, method: method as any, image: 'case' }, keepFullTimeline: true, edgeCapPerTick: 1_000_000 });
  await hw.loadFirmware();
  const stimuli = (scenario?.stimuli ?? []).filter((s: any) => circuit.components.some((c) => c.component_id === s.component)).map((s: any) => ({ atUs: s.at_ms * 1000, component: s.component, pressed: s.action === 'press' }));
  const snaps = hasLcd ? Array.from({ length: Math.floor(durationMs / 100) + 1 }, (_, i) => ({ atUs: i * 100_000, tag: `f@${i * 100}` })) : [];
  hw.schedule(stimuli, snaps);
  await hw.runUntil(durationMs * 1000, 180_000);
  const frames: { t: number; file: string }[] = [];
  if (hasLcd) {
    mkdirSync(join(slugDir, 'frames'), { recursive: true });
    let last = '';
    for (const [tag, snap] of Object.entries(hw.displaySnapshots).sort((a, b) => a[1].simUs - b[1].simUs)) {
      if (!tag.startsWith('f@')) continue;
      for (const [id, f] of Object.entries(snap.displays)) {
        const lit = f.on && f.backlight;
        const h = createHash('sha1').update(f.b64 + lit).digest('hex').slice(0, 10);
        if (h === last) continue;
        last = h;
        const file = `frames/${id}_${String(Math.round(snap.simUs / 1000)).padStart(6, '0')}.png`;
        writeFileSync(join(slugDir, file), rgb565Png(decodeFrame(f.b64), f.w, f.h, 1, !lit));
        frames.push({ t: Math.round(snap.simUs / 1000), file });
      }
    }
  }
  const comp: Record<string, { t: number; on: boolean; b: number }[]> = {};
  for (const [k, arr] of Object.entries(hw.componentTimeline)) {
    const o: { t: number; on: boolean; b: number }[] = [];
    for (const e of arr) {
      if (o.length && o[o.length - 1].on === e.lit) continue;
      o.push({ t: Math.round(e.simUs / 100) / 10, on: e.lit, b: Math.round(e.brightness * 100) / 100 });
    }
    comp[k] = o.slice(0, 4000);
  }
  const gpio: Record<string, { t: number; v: 0 | 1 | 'Z' }[]> = {};
  for (const [k, arr] of Object.entries(hw.gpioTimeline)) gpio[k] = arr.slice(0, 4000).map((e) => ({ t: Math.round(e.simUs / 100) / 10, v: e.level }));
  const uart = hw.uart.slice(0, 6000);
  await hw.stop();
  return { durationMs, method, components: comp, gpio, stimuli: stimuli.map((s: any) => ({ t: s.atUs / 1000, component: s.component, pressed: s.pressed })), frames, uart };
}

async function exportCase(def: CaseDef) {
  const pid = findProject(def.project, def.kind !== 'boundary');
  if (!pid) {
    console.log(`✗ ${def.slug}: no project named "${def.project}" with successful runs`);
    return null;
  }
  const dir = join(PROJ, pid);
  const slugDir = join(OUT, def.slug);
  const keepMedia = ['video.webm', 'poster.png'].filter((f) => existsSync(join(slugDir, f))).map((f) => [f, readFileSync(join(slugDir, f))] as const);
  rmSync(slugDir, { recursive: true, force: true });
  mkdirSync(slugDir, { recursive: true });
  for (const [f, b] of keepMedia) writeFileSync(join(slugDir, f), b);
  const meta = json(join(dir, 'project.json'));
  const runIds = readdirSync(join(dir, 'runs')).filter((r) => existsSync(join(dir, 'runs', r, 'run.json'))).sort();
  const turns: any[] = [];
  mkdirSync(join(slugDir, 'runs'), { recursive: true });
  for (const rid of runIds) {
    const s = json(join(dir, 'runs', rid, 'run.json'));
    const events = readFileSync(join(dir, 'runs', rid, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const plan = events.find((e) => e.kind === 'plan')?.plan;
    const ver = [...events].reverse().find((e) => e.kind === 'verification')?.report;
    const t0 = Date.parse(s.startedAt);
    if (ver?.displayEvidence?.length) {
      mkdirSync(join(slugDir, 'evidence'), { recursive: true });
      for (const d of ver.displayEvidence) if (existsSync(d.png)) cpSync(d.png, join(slugDir, 'evidence', d.png.split('/').pop()));
    }
    turns.push({
      runId: rid,
      prompt: s.userMessage,
      status: s.status,
      startedAt: s.startedAt,
      wallSec: s.finishedAt ? Math.round((Date.parse(s.finishedAt) - t0) / 1000) : null,
      model: s.model,
      metrics: { llmCalls: s.llmCalls, toolCalls: s.toolCalls, repairRounds: s.repairRounds, promptTokens: s.usage.promptTokens, completionTokens: s.usage.completionTokens, reasoningTokens: s.usage.reasoningTokens, costUsd: s.usage.costUsd },
      summary: s.summary,
      plan: plan ? { understanding: plan.understanding, change_type: plan.change_type, feasible: plan.feasible, capability_gaps: plan.capability_gaps, pin_plan: plan.pin_plan, wiring: plan.wiring, firmware_plan: plan.firmware_plan, verification: plan.verification, hardware: plan.hardware } : null,
      verification: ver ? { passed: ver.passed, simulatedMs: ver.simulatedMs, wallMs: ver.wallMs, firmwareSha256: ver.firmwareSha256, scenario: ver.scenario, results: ver.results.map((r: any) => ({ passed: r.passed, logOnly: r.logOnly, detail: r.detail, type: r.check.type })), evidence: (ver.displayEvidence ?? []).map((d: any) => ({ component: d.component, atMs: d.atMs, file: `evidence/${d.png.split('/').pop()}` })) } : null,
      timeline: condense(events, t0),
    });
    mkdirSync(join(slugDir, 'runs', rid), { recursive: true });
    cpSync(join(dir, 'runs', rid, 'run.json'), join(slugDir, 'runs', rid, 'run.json'));
    cpSync(join(dir, 'runs', rid, 'events.jsonl'), join(slugDir, 'runs', rid, 'events.jsonl'));
  }
  const circuit: Circuit = json(join(dir, 'circuit.json'));
  const fwRoot = join(dir, 'firmware');
  const files: Record<string, string> = {};
  const sub = meta.board === 'arduino-uno' ? 'sketch' : 'main';
  for (const f of readdirSync(join(fwRoot, sub))) if (/\.(c|cpp|h|hpp|ino)$/.test(f)) files[`${sub}/${f}`] = readFileSync(join(fwRoot, sub, f), 'utf8');
  const builds = existsSync(join(dir, 'builds')) ? readdirSync(join(dir, 'builds')).map((b) => (existsSync(join(dir, 'builds', b, 'build.json')) ? json(join(dir, 'builds', b, 'build.json')) : null)).filter(Boolean).sort((a: any, b: any) => a.startedAt.localeCompare(b.startedAt)) : [];
  const build: BuildRecord | undefined = builds.filter((b: any) => b.status === 'success').pop();
  const lastVer = [...turns].reverse().find((t) => t.verification)?.verification;
  let replay = null;
  if (build && def.kind !== 'boundary') replay = await recordReplay(pid, meta.board, circuit, build, lastVer?.scenario, slugDir);
  const sol = solveCircuit({ circuit, mcuPins: [] });
  const totals = turns.reduce((a, t) => ({ wallSec: a.wallSec + (t.wallSec ?? 0), llmCalls: a.llmCalls + t.metrics.llmCalls, toolCalls: a.toolCalls + t.metrics.toolCalls, tokens: a.tokens + t.metrics.promptTokens + t.metrics.completionTokens, costUsd: a.costUsd + (t.metrics.costUsd ?? 0), repairs: a.repairs + t.metrics.repairRounds }), { wallSec: 0, llmCalls: 0, toolCalls: 0, tokens: 0, costUsd: 0, repairs: 0 });
  const c = {
    id: def.slug,
    order: def.order,
    kind: def.kind ?? 'build',
    featured: !!def.featured,
    title: def.title,
    subtitle: def.subtitle,
    tags: def.tags,
    board: meta.board,
    boardName: getBoard(meta.board).name,
    sourceProject: pid,
    exportedAt: new Date().toISOString(),
    verified: def.kind === 'boundary' ? false : turns.every((t) => t.status === 'success'),
    totals,
    turns,
    final: {
      circuit,
      pinNet: sol.pinNet,
      staticNets: Object.fromEntries(sol.nets.map((n) => [n.net_id, n.level])),
      files,
      build: build ? { buildId: build.buildId, durationMs: build.durationMs, toolVersions: build.toolVersions, artifacts: build.artifacts.filter((a) => a.kind !== 'map' && a.kind !== 'other').map((a) => ({ name: a.name, kind: a.kind, size: a.size, sha256: a.sha256 })), sizeInfo: build.sizeInfo } : null,
    },
    replay,
  };
  writeFileSync(join(slugDir, 'case.json'), JSON.stringify(c, null, 1));
  console.log(`✓ ${def.slug}: project ${pid}, ${turns.length} turn(s), replay ${replay ? `${replay.durationMs} ms, ${replay.frames.length} LCD frames, ${Object.keys(replay.components).length} light channels` : 'none'}`);
  return c;
}

const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
for (const d of CASES) if (!only.length || only.includes(d.slug)) await exportCase(d);
