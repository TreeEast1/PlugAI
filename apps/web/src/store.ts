import { useSyncExternalStore } from 'react';
import type { AgentEvent, AgentRunSummary, BuildRecord, Circuit, CircuitSolution, ComponentState, FlashRecord, McuPinState, NetLevel, ProjectMeta, SimClock, VerificationReport } from '@plugai/shared';
import { api, socket } from './api';

export interface BoardsResp {
  boards: any[];
  components: any[];
}

export interface ProjectDetail {
  meta: ProjectMeta & { origin: string };
  circuit: Circuit;
  solution: CircuitSolution;
  files: { path: string; bytes: number; editable: boolean }[];
  lastBuild: BuildRecord | null;
  flashes: FlashRecord[];
  loaded: { buildId: string; method: string; image: string; sha256: string; flashId: string } | null;
  runs: AgentRunSummary[];
  lastVerification: VerificationReport | null;
  head: string | null;
  sourceHash: string;
}

export interface SignalPoint {
  t: number; // simUs
  v: 0 | 1 | 'Z';
}

export interface SimView {
  status: string;
  clock: SimClock | null;
  pins: McuPinState[];
  components: Record<string, ComponentState> | null;
  nets: Record<string, { level: NetLevel; voltage: number | null }>;
  duty: Record<string, number>;
  warnings: { code: string; message: string; severity: string }[];
  error?: string;
  info?: any;
  displays: Record<string, DisplayView>;
}

export interface DisplayView {
  w: number;
  h: number;
  dataUrl: string;
  on: boolean;
  backlight: boolean;
  powered: boolean;
  ready: boolean;
  stats: any;
}

/** Turn the RGB565 frame streamed by the simulator into an image (pure conversion, no drawing logic). */
const cvs = typeof document !== 'undefined' ? document.createElement('canvas') : null;
export function frameToView(f: any): DisplayView {
  const bin = atob(f.b64);
  const n = f.w * f.h;
  const img = new ImageData(f.w, f.h);
  for (let i = 0; i < n; i++) {
    const c = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    img.data[4 * i] = ((c >> 11) & 31) * 8.226;
    img.data[4 * i + 1] = ((c >> 5) & 63) * 4.048;
    img.data[4 * i + 2] = (c & 31) * 8.226;
    img.data[4 * i + 3] = 255;
  }
  cvs!.width = f.w;
  cvs!.height = f.h;
  cvs!.getContext('2d')!.putImageData(img, 0, 0);
  return { w: f.w, h: f.h, dataUrl: cvs!.toDataURL(), on: f.on, backlight: f.backlight, powered: f.powered, ready: f.ready, stats: f.stats };
}
function mergeDisplays(prev: Record<string, DisplayView>, incoming?: Record<string, any>) {
  if (!incoming) return prev;
  const out = { ...prev };
  for (const [k, v] of Object.entries(incoming)) out[k] = frameToView(v);
  return out;
}

export interface AppState {
  connected: boolean;
  env: any | null;
  boards: BoardsResp | null;
  projects: (ProjectMeta & { origin: string })[];
  project: ProjectDetail | null;
  sim: SimView;
  signals: { gpio: Record<string, SignalPoint[]>; comp: Record<string, SignalPoint[]>; inputs: Record<string, SignalPoint[]>; actions: { t: number; label: string }[]; epoch: number };
  uart: string;
  build: { running: boolean; buildId?: string; log: string };
  flash: { running: boolean; steps: { step: string; status: string; detail?: string }[]; last?: FlashRecord };
  agentEvents: Record<string, AgentEvent[]>;
  activeRun: string | null;
  fileVersion: number;
  toast: { kind: 'error' | 'info' | 'ok'; text: string; at: number } | null;
}

const emptySim: SimView = { status: 'idle', clock: null, pins: [], components: null, nets: {}, duty: {}, warnings: [], displays: {} };

let state: AppState = {
  connected: false,
  env: null,
  boards: null,
  projects: [],
  project: null,
  sim: emptySim,
  signals: { gpio: {}, comp: {}, inputs: {}, actions: [], epoch: 0 },
  uart: '',
  build: { running: false, log: '' },
  flash: { running: false, steps: [] },
  agentEvents: {},
  activeRun: null,
  fileVersion: 0,
  toast: null,
};

const listeners = new Set<() => void>();
export function getState() {
  return state;
}
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}
export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => sel(state),
  );
}

export function toast(kind: 'error' | 'info' | 'ok', text: string) {
  setState({ toast: { kind, text, at: Date.now() } });
}

const MAX_POINTS = 6000;
function pushPoint(map: Record<string, SignalPoint[]>, key: string, p: SignalPoint) {
  const arr = (map[key] ??= []);
  if (arr.length && arr[arr.length - 1].v === p.v) return;
  arr.push(p);
  if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
}

export async function refreshProject(id = state.project?.meta.id) {
  if (!id) return;
  const p = await api.get<ProjectDetail & { sim: any }>(`/projects/${id}`);
  const { sim, ...rest } = p;
  setState({ project: rest });
  applySimState(sim);
}

function applySimState(sim: any) {
  if (!sim) return;
  const nets: SimView['nets'] = {};
  for (const n of sim.nets ?? []) nets[n.net_id] = { level: n.level, voltage: n.voltage };
  const signals = { gpio: {} as Record<string, SignalPoint[]>, comp: {} as Record<string, SignalPoint[]>, inputs: {} as Record<string, SignalPoint[]>, actions: [] as { t: number; label: string }[], epoch: state.signals.epoch + 1 };
  if (sim.history) {
    for (const [pin, arr] of Object.entries<any[]>(sim.history.gpio ?? {})) for (const e of arr) pushPoint(signals.gpio, pin, { t: e.simUs, v: e.level });
    for (const [k, arr] of Object.entries<any[]>(sim.history.components ?? {})) for (const e of arr) pushPoint(signals.comp, k, { t: e.simUs, v: e.lit ? 1 : 0 });
    for (const i of sim.history.inputs ?? []) pushPoint(signals.inputs, i.pin, { t: i.simUs, v: i.level === null ? 'Z' : i.level });
    for (const a of sim.history.actions ?? []) signals.actions.push({ t: a.simUs, label: `${a.component} ${a.pressed ? 'press' : 'release'}` });
  }
  setState({
    sim: {
      status: sim.status,
      clock: sim.snapshot?.clock ?? null,
      pins: sim.snapshot?.pins ?? [],
      components: sim.components ?? null,
      nets,
      duty: {},
      warnings: sim.warnings ?? [],
      error: sim.snapshot?.error,
      info: sim.info,
      displays: mergeDisplays({}, sim.displays),
    },
    signals,
    uart: sim.uart ?? '',
  });
}

export async function openProject(id: string) {
  localStorage.setItem('plugai.project', id);
  setState({ project: null, sim: emptySim, uart: '', signals: { gpio: {}, comp: {}, inputs: {}, actions: [], epoch: state.signals.epoch + 1 }, build: { running: false, log: '' }, flash: { running: false, steps: [] }, agentEvents: {}, activeRun: null });
  socket.subscribe(id);
  await refreshProject(id);
  const p = state.project;
  if (p?.lastBuild) {
    try {
      const log = await api.text(`/projects/${id}/builds/${p.lastBuild.buildId}/log`);
      setState({ build: { running: false, buildId: p.lastBuild.buildId, log } });
    } catch {
      /* ignore */
    }
  }
  // load events of recent runs (incl. an active one)
  const runs = p?.runs ?? [];
  for (const r of runs.slice(0, 8)) {
    const d = await api.get(`/projects/${id}/runs/${r.runId}`);
    setState((s) => ({ agentEvents: { ...s.agentEvents, [r.runId]: d.events }, activeRun: d.active ? r.runId : s.activeRun }));
  }
}

export async function loadProjects() {
  const projects = await api.get('/projects');
  setState({ projects });
  return projects;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshProject(), 250);
}

export function initSocket() {
  socket.onStatus = (c) => setState({ connected: c });
  socket.on((m) => {
    const pid = state.project?.meta.id;
    if (m.projectId && m.projectId !== pid) return;
    switch (m.type) {
      case 'sim.frame': {
        const nets: SimView['nets'] = {};
        for (const n of m.nets) nets[n.net_id] = { level: n.level, voltage: n.voltage };
        const sig = state.signals;
        for (const e of m.edges) pushPoint(sig.gpio, e.pin, { t: e.simUs, v: e.level });
        for (const c of m.componentEdges ?? []) pushPoint(sig.comp, c.channel ? `${c.component_id}:${c.channel}` : c.component_id, { t: c.simUs, v: c.lit ? 1 : 0 });
        for (const i of m.inputs ?? []) pushPoint(sig.inputs, i.pin, { t: i.simUs, v: i.level === null ? 'Z' : i.level });
        for (const a of m.actions ?? []) sig.actions.push({ t: a.simUs, label: `${a.component} ${a.pressed ? 'press' : 'release'}` });
        setState((s) => ({ sim: { ...s.sim, clock: m.clock, pins: m.pins, components: m.components, nets, duty: m.duty, displays: mergeDisplays(s.sim.displays, m.displays) }, signals: { ...sig } }));
        break;
      }
      case 'sim.uart':
        setState((s) => ({ uart: (s.uart + m.data).slice(-60000) }));
        break;
      case 'sim.status':
        setState((s) => ({ sim: { ...s.sim, status: m.status, error: m.error ?? (m.status === 'crashed' ? s.sim.error : undefined) } }));
        if (m.error) toast('error', m.error);
        if (m.status === 'loaded' || m.status === 'stopped') debouncedRefresh();
        break;
      case 'sim.snapshot':
        setState((s) => ({ sim: { ...s.sim, status: m.snapshot.status, clock: m.snapshot.clock, pins: m.snapshot.pins }, uart: '', signals: { gpio: {}, comp: {}, inputs: {}, actions: [], epoch: s.signals.epoch + 1 } }));
        void api.get(`/projects/${pid}/sim`).then(applySimState);
        break;
      case 'circuit.updated':
        setState((s) => (s.project ? { project: { ...s.project, circuit: m.circuit, solution: m.solution }, sim: { ...s.sim, warnings: m.solution.warnings } } : {}));
        break;
      case 'project.updated':
        setState((s) => ({ fileVersion: s.fileVersion + 1 }));
        debouncedRefresh();
        break;
      case 'build.log':
        setState((s) => ({ build: { running: true, buildId: m.buildId, log: s.build.buildId === m.buildId ? (s.build.log + m.chunk).slice(-400000) : m.chunk } }));
        break;
      case 'build.done':
        setState((s) => ({ build: { ...s.build, running: false } }));
        debouncedRefresh();
        break;
      case 'flash.progress':
        setState((s) => {
          const steps = s.flash.steps.filter((x) => x.step !== m.step);
          return { flash: { ...s.flash, running: true, steps: [...steps, { step: m.step, status: m.status, detail: m.detail }] } };
        });
        break;
      case 'flash.done':
        setState((s) => ({ flash: { ...s.flash, running: false, last: m.flash } }));
        debouncedRefresh();
        break;
      case 'agent.event': {
        const ev = m.event as AgentEvent;
        setState((s) => ({
          agentEvents: { ...s.agentEvents, [m.runId]: [...(s.agentEvents[m.runId] ?? []), ev] },
          activeRun: ev.kind === 'final' ? null : m.runId,
        }));
        if (ev.kind === 'final' || ev.kind === 'plan' || (ev.kind === 'tool-end' && ['edit_circuit', 'write_firmware'].includes(ev.record.name))) debouncedRefresh();
        break;
      }
    }
  });
  socket.connect();
}
