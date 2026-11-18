import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { applyOps, catalog, describeCircuit, solveCircuit, CircuitError } from '@plugai/circuit';
import { VirtualHardware, runVerification, type TickEvent } from '@plugai/simulator';
import { buildEsp32, flashEsp32Virtual, directLoadRecord, deviceFlashPath, espToolchainStatus, hashSources, ensureEspScaffold, espBackendInfo } from '@plugai/backend-esp32';
import { buildAvr, avrDirectLoad, avrToolchainStatus, avrBackendInfo, avrSourceHash } from '@plugai/backend-avr';
import { BOARDS, getBoard, nowIso, type AgentEvent, type AgentRunSummary, type BoardId, type BuildRecord, type CircuitOp, type FlashMethod, type FlashRecord, type Scenario, type ServerPush, type VerificationReport } from '@plugai/shared';
import type { Observation, ProjectStateForAgent, ToolHost, RunStore } from '@plugai/agent';
import { HttpError, ProjectStore, SCAFFOLD } from './projects.ts';
import { readSdkReference } from './sdkref.ts';

export type Broadcast = (projectId: string, msg: ServerPush) => void;

interface LoadedFirmware {
  buildId: string;
  method: FlashMethod;
  image: string; // absolute path
  sha256: string;
  flashId: string;
}

interface Live {
  hw: VirtualHardware;
  simId: string;
  unsub: () => void;
  pending: { edges: TickEvent['edges']; comp: TickEvent['componentEdges']; uart: string; inputs: TickEvent['inputsApplied']; actions: TickEvent['userActions']; displays?: Record<string, unknown> };
  lastFlush: number;
  timer: NodeJS.Timeout | null;
  last?: TickEvent;
}

class Mutex {
  private p = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.p.then(fn, fn);
    this.p = r.then(
      () => undefined,
      () => undefined,
    );
    return r;
  }
}

const json = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null);

export class Runtime implements ToolHost, RunStore {
  private locks = new Map<string, Mutex>();
  private live = new Map<string, Live>();
  private loaded = new Map<string, LoadedFirmware>();
  private observations = new Map<string, Observation>();
  constructor(
    readonly store: ProjectStore,
    readonly broadcast: Broadcast,
  ) {}

  private lock(id: string) {
    let m = this.locks.get(id);
    if (!m) this.locks.set(id, (m = new Mutex()));
    return m;
  }

  // ------------------------------------------------------------------ environment
  async inspectEnvironment() {
    const esp = espToolchainStatus();
    const avr = avrToolchainStatus();
    let llm: Record<string, unknown> = { configured: false };
    const key = process.env.DEEPSEEK_API_KEY;
    if (key && key !== 'your-deepseek-api-key-here') llm = { configured: true, provider: 'DeepSeek', baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', thinking: process.env.DEEPSEEK_THINKING ?? 'enabled', reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT ?? 'high' };
    return {
      host: { platform: process.platform, arch: process.arch, node: process.version },
      boards: Object.values(BOARDS).map((b) => ({ id: b.id, name: b.name, chip: b.chipName, backend: b.backend, virtualFlash: b.flashing.virtual, physicalFlashing: b.flashing.physical })),
      toolchains: { esp32: esp, avr },
      simulators: [espBackendInfo(), avrBackendInfo()],
      llm,
      notes: [
        'Virtual results are "virtual verification" only; no physical hardware is attached.',
        'ESP32-C3: esptool virtual-UART flashing uses the ROM loader (--no-stub); esptool flasher stub faults in esp-emu 0.48.',
      ],
    };
  }

  listSupportedHardware(board: BoardId) {
    const b = getBoard(board);
    return { board: { id: b.id, name: b.name, chip: b.chipName, pins: b.pins.map((p) => ({ id: p.id, role: p.role, reserved: !!p.reserved, notes: p.notes, simulated: p.simulated })), recommendedGpio: b.recommendedGpio, onboard: b.onboard }, components: catalog() };
  }

  // ------------------------------------------------------------------ project state
  latestBuild(id: string, successOnly = false): BuildRecord | null {
    const dir = join(this.store.dir(id), 'builds');
    if (!existsSync(dir)) return null;
    const recs = readdirSync(dir)
      .map((b) => json<BuildRecord>(join(dir, b, 'build.json')))
      .filter((r): r is BuildRecord => !!r && r.status !== 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const f = successOnly ? recs.filter((r) => r.status === 'success') : recs;
    return f[f.length - 1] ?? null;
  }

  listBuilds(id: string): BuildRecord[] {
    const dir = join(this.store.dir(id), 'builds');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((b) => json<BuildRecord>(join(dir, b, 'build.json')))
      .filter((r): r is BuildRecord => !!r)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getBuild(id: string, buildId: string): BuildRecord {
    if (!/^[A-Za-z0-9_\-]+$/.test(buildId)) throw new HttpError(400, 'bad build id');
    const r = json<BuildRecord>(join(this.store.dir(id), 'builds', buildId, 'build.json'));
    if (!r) throw new HttpError(404, 'build not found');
    return r;
  }

  listFlashes(id: string): FlashRecord[] {
    const dir = join(this.store.dir(id), 'flashes');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => json<FlashRecord>(join(dir, f, 'flash.json')))
      .filter((r): r is FlashRecord => !!r)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  lastVerification(id: string): VerificationReport | null {
    const dir = join(this.store.dir(id), 'verifications');
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.startsWith('ver_') && f.endsWith('.json')).sort();
    return files.length ? json<VerificationReport>(join(dir, files[files.length - 1])) : null;
  }

  async sourceHash(id: string): Promise<string> {
    const d = this.store.dir(id);
    const board = this.store.meta(id).board;
    if (board === 'esp32c3-devkitm-1') {
      ensureEspScaffold(d);
      return hashSources(join(d, 'firmware'));
    }
    return avrSourceHash(join(d, 'firmware', 'sketch'));
  }

  staticSolution(id: string) {
    const live = this.live.get(id);
    const circuit = this.store.circuit(id);
    const pins = live ? live.hw.getState().pins : [];
    return solveCircuit({ circuit, mcuPins: pins });
  }

  async getProjectState(id: string, opts: { includeFiles?: boolean } = {}): Promise<ProjectStateForAgent> {
    const meta = this.store.meta(id);
    const circuit = this.store.circuit(id);
    const sol = solveCircuit({ circuit, mcuPins: [] });
    const lb = this.latestBuild(id);
    const lv = this.lastVerification(id);
    const files = this.store.listFiles(id).filter((f) => f.editable || f.path === 'sdkconfig.defaults');
    return {
      projectId: id,
      name: meta.name,
      board: meta.board,
      circuit: describeCircuit(circuit),
      circuitJson: circuit,
      circuitWarnings: sol.warnings.filter((w) => w.code !== 'RESERVED_PIN').map((w) => w.message),
      files: files.map((f) => ({ path: f.path, bytes: f.bytes, content: opts.includeFiles && f.bytes < 60_000 ? this.store.readFile(id, f.path) : undefined })),
      lastBuild: lb ? { buildId: lb.buildId, status: lb.status, error: lb.error, diagnostics: lb.diagnostics.filter((d) => d.severity === 'error').slice(0, 15).map((d) => `${d.file}:${d.line}: ${d.message}`) } : undefined,
      lastVerification: lv ? { passed: lv.passed, summary: lv.results.map((r) => `${r.passed ? 'PASS' : 'FAIL'}: ${r.detail}`) } : undefined,
      conversation: this.conversation(id),
      isEmpty: this.store.isEmpty(id),
    };
  }

  conversation(id: string): { role: 'user' | 'agent'; text: string; at: string }[] {
    return this.listRuns(id)
      .slice()
      .reverse()
      .flatMap((r) => [
        { role: 'user' as const, text: r.userMessage, at: r.startedAt },
        ...(r.summary ? [{ role: 'agent' as const, text: `[${r.status}] ${r.summary}`, at: r.finishedAt ?? r.startedAt }] : []),
      ]);
  }

  async createProject(id: string, board: BoardId, runId: string) {
    if (this.store.meta(id).board === board) return { ok: true, message: `Project already targets ${board}` };
    if (!this.store.isEmpty(id)) return { ok: false, message: 'Project already has content; create a new project in the UI to use a different board.' };
    await this.stopLive(id);
    this.store.reinit(id, board);
    this.broadcast(id, { type: 'project.updated', projectId: id, reason: `board changed to ${board} by ${runId}` });
    return { ok: true, message: `Project re-initialised for ${board}` };
  }

  // ------------------------------------------------------------------ circuit
  async editCircuit(id: string, ops: CircuitOp[], source: string) {
    let res;
    try {
      res = applyOps(this.store.circuit(id), ops);
    } catch (e) {
      if (e instanceof CircuitError) throw new HttpError(400, e.message);
      throw e;
    }
    this.store.saveCircuit(id, res.circuit);
    const live = this.live.get(id);
    if (live) live.hw.setCircuit(res.circuit);
    const sol = this.staticSolution(id);
    this.broadcast(id, { type: 'circuit.updated', projectId: id, circuit: res.circuit, solution: sol });
    if (!ops.every((o) => o.op === 'move_component')) this.store.commit(id, `circuit (${source}): ${res.log.join('; ').slice(0, 200)}`);
    return { log: res.log, circuit: describeCircuit(res.circuit), warnings: sol.warnings.filter((w) => w.code !== 'RESERVED_PIN').map((w) => `${w.code}: ${w.message}`) };
  }

  // ------------------------------------------------------------------ files
  async readFile(id: string, path: string) {
    return this.store.readFile(id, path);
  }
  async writeFile(id: string, path: string, content: string, source: string) {
    const r = this.store.writeFile(id, path, content);
    this.broadcast(id, { type: 'project.updated', projectId: id, reason: `file ${path} written by ${source}` });
    return r;
  }
  async readSdkReference(board: BoardId, topic: string) {
    return readSdkReference(board, topic);
  }
  async commit(id: string, message: string) {
    return this.store.commit(id, message);
  }

  // ------------------------------------------------------------------ build / flash
  async build(id: string, source: string): Promise<BuildRecord> {
    return this.lock(id).run(async () => {
      const dir = this.store.dir(id);
      const board = this.store.meta(id).board;
      const commit = this.store.commit(id, `snapshot for build (${source})`);
      const buildId = `b_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${randomUUID().slice(0, 4)}`;
      const onLog = (chunk: string) => this.broadcast(id, { type: 'build.log', projectId: id, buildId, chunk });
      this.broadcast(id, { type: 'build.log', projectId: id, buildId, chunk: `[plugai] build ${buildId} started (${source})\n` });
      const rec = board === 'esp32c3-devkitm-1' ? await buildEsp32({ projectId: id, projectDir: dir, buildId, sourceCommit: commit ?? undefined, onLog }) : await buildAvr({ projectId: id, projectDir: dir, buildId, sourceCommit: commit ?? undefined, onLog });
      this.broadcast(id, { type: 'build.done', projectId: id, build: rec });
      return rec;
    });
  }

  async flash(id: string, source: string, method?: FlashMethod, buildId?: string): Promise<FlashRecord> {
    return this.lock(id).run(async () => {
      const dir = this.store.dir(id);
      const board = this.store.meta(id).board;
      const build = buildId ? this.getBuild(id, buildId) : this.latestBuild(id, true);
      if (!build || build.status !== 'success') throw new HttpError(409, 'No successful build to flash — build the firmware first');
      await this.stopLive(id);
      const m: FlashMethod = method ?? (board === 'esp32c3-devkitm-1' ? 'esptool-virtual-uart' : 'direct-image-load');
      let rec: FlashRecord;
      let image: string;
      if (board === 'arduino-uno') {
        if (m !== 'direct-image-load') throw new HttpError(400, 'Arduino Uno backend (avr8js) only supports direct image load; serial bootloader flashing is not emulated');
        const { record } = avrDirectLoad(id, dir, build);
        rec = record;
        image = join(dir, build.artifacts.find((a) => a.kind === 'hex')!.path);
      } else if (m === 'esptool-virtual-uart') {
        rec = await flashEsp32Virtual({ projectId: id, projectDir: dir, build, onProgress: (step, status, detail) => this.broadcast(id, { type: 'flash.progress', projectId: id, flashId: '', step, status, detail }) });
        image = deviceFlashPath(dir);
        if (rec.status === 'success') copyFileSync(image, join(dir, 'flashes', rec.flashId, 'device-after.bin'));
      } else {
        rec = directLoadRecord(id, dir, build);
        image = join(dir, build.artifacts.find((a) => a.kind === 'merged-bin')!.path);
      }
      if (rec.method === 'direct-image-load') {
        mkdirSync(join(dir, 'flashes', rec.flashId), { recursive: true });
        writeFileSync(join(dir, 'flashes', rec.flashId, 'flash.json'), JSON.stringify(rec, null, 2));
      }
      this.broadcast(id, { type: 'flash.done', projectId: id, flash: rec });
      if (rec.status === 'success') {
        const sha = createHash('sha256').update(readFileSync(image)).digest('hex');
        const lf: LoadedFirmware = { buildId: build.buildId, method: rec.method, image, sha256: board === 'arduino-uno' ? build.artifacts.find((a) => a.kind === 'hex')!.sha256 : sha, flashId: rec.flashId };
        this.loaded.set(id, lf);
        mkdirSync(join(dir, 'device'), { recursive: true });
        writeFileSync(join(dir, 'device', 'loaded.json'), JSON.stringify({ ...lf, imageFileSha256: sha }, null, 2));
        await this.loadLive(id, false);
      }
      return rec;
    });
  }

  loadedFirmware(id: string): LoadedFirmware | null {
    if (!this.loaded.has(id)) {
      // restore after a server restart, only if the image on disk is unchanged
      const rec = json<LoadedFirmware & { imageFileSha256: string }>(join(this.store.dir(id), 'device', 'loaded.json'));
      if (rec && existsSync(rec.image) && createHash('sha256').update(readFileSync(rec.image)).digest('hex') === rec.imageFileSha256) {
        const { imageFileSha256: _, ...lf } = rec;
        this.loaded.set(id, lf);
      }
    }
    return this.loaded.get(id) ?? null;
  }

  private imageBytes(id: string, lf: LoadedFirmware): Uint8Array {
    const board = this.store.meta(id).board;
    if (board === 'arduino-uno') return avrDirectLoad(id, this.store.dir(id), this.getBuild(id, lf.buildId)).image;
    return new Uint8Array(readFileSync(lf.image));
  }

  // ------------------------------------------------------------------ live simulation
  private async loadLive(id: string, start: boolean) {
    const lf = this.loadedFirmware(id);
    if (!lf) throw new HttpError(409, 'No firmware loaded — Flash / Load firmware first');
    await this.stopLive(id);
    const meta = this.store.meta(id);
    const simId = `sim_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${randomUUID().slice(0, 4)}`;
    const hw = new VirtualHardware({
      backend: getBoard(meta.board).backend,
      board: meta.board,
      circuit: this.store.circuit(id),
      image: this.imageBytes(id, lf),
      firmware: { buildId: lf.buildId, sha256: lf.sha256, method: lf.method, image: lf.image.replace(this.store.dir(id) + '/', '') },
      tracePath: join(this.store.dir(id), 'traces', `${simId}.jsonl`),
      edgeCapPerTick: 3000,
    });
    const live: Live = { hw, simId, unsub: () => {}, pending: { edges: [], comp: [], uart: '', inputs: [], actions: [] }, lastFlush: 0, timer: null };
    live.unsub = hw.subscribeEvents((e) => {
      if (e.type === 'tick') {
        const t = e.tick;
        live.last = t;
        live.pending.edges.push(...t.edges);
        live.pending.comp.push(...t.componentEdges);
        live.pending.inputs.push(...t.inputsApplied);
        live.pending.actions.push(...t.userActions);
        live.pending.uart += t.uart;
        if (t.displays) live.pending.displays = { ...(live.pending.displays ?? {}), ...t.displays };
        if (t.warnings) this.broadcast(id, { type: 'circuit.updated', projectId: id, circuit: this.store.circuit(id), solution: { ...this.staticSolution(id), warnings: t.warnings } });
        const now = Date.now();
        if (now - live.lastFlush >= 33) this.flushFrame(id, live);
        else if (!live.timer) live.timer = setTimeout(() => this.flushFrame(id, live), 34);
      } else if (e.type === 'status') {
        this.broadcast(id, { type: 'sim.status', projectId: id, status: e.status, reason: e.reason, error: e.error });
      } else if (e.type === 'restart') {
        this.broadcast(id, { type: 'sim.uart', projectId: id, data: `\r\n[plugai] MCU restarted at ${(e.simUs / 1000).toFixed(1)} ms: ${e.reason}\r\n`, simUs: e.simUs });
      }
    });
    this.live.set(id, live);
    await hw.loadFirmware();
    this.broadcast(id, { type: 'sim.snapshot', projectId: id, snapshot: hw.getState() });
    if (start) hw.start('realtime', 1);
  }

  private flushFrame(id: string, live: Live) {
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    live.lastFlush = Date.now();
    const t = live.last;
    if (!t) return;
    const p = live.pending;
    this.broadcast(id, {
      type: 'sim.frame',
      projectId: id,
      clock: t.clock,
      pins: t.pins,
      edges: p.edges.slice(-2000),
      components: t.components,
      nets: t.nets,
      duty: t.duty,
      ...({ componentEdges: p.comp, inputs: p.inputs, actions: p.actions, truncated: t.truncatedEdges, displays: p.displays } as object),
    } as ServerPush);
    if (p.uart) this.broadcast(id, { type: 'sim.uart', projectId: id, data: p.uart, simUs: t.clock.simUs });
    live.pending = { edges: [], comp: [], uart: '', inputs: [], actions: [] };
  }

  async startLive(id: string) {
    let live = this.live.get(id);
    if (!live) {
      await this.loadLive(id, true);
      return;
    }
    if (live.hw.getState().status === 'crashed' || live.hw.getState().status === 'stopped') {
      await this.loadLive(id, true);
      return;
    }
    live.hw.start('realtime', 1);
  }

  async simAction(id: string, action: 'start' | 'pause' | 'reset' | 'stop', speed = 1) {
    const live = this.live.get(id);
    if (action === 'start') {
      if (!live) {
        if (!this.loadedFirmware(id)) throw new HttpError(409, 'No firmware loaded — use Flash / Load Firmware first');
        await this.loadLive(id, true);
      } else live.hw.start('realtime', speed);
    } else if (action === 'pause') {
      if (!live) throw new HttpError(409, 'Simulator not running');
      live.hw.pause();
    } else if (action === 'reset') {
      if (!live) throw new HttpError(409, 'Simulator not loaded');
      live.hw.reset();
    } else if (action === 'stop') await this.stopLive(id);
    return this.simState(id);
  }

  async stopLive(id: string) {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    live.unsub();
    if (live.timer) clearTimeout(live.timer);
    await live.hw.stop();
    this.broadcast(id, { type: 'sim.status', projectId: id, status: 'stopped' });
  }

  async stopAll() {
    await Promise.all([...this.live.keys()].map((k) => this.stopLive(k)));
  }

  pressButton(id: string, component: string, pressed: boolean) {
    const live = this.live.get(id);
    if (!live) throw new HttpError(409, 'Simulator not running — the button can only act on a running MCU');
    const c = this.store.circuit(id).components.find((x) => x.component_id === component);
    if (!c || c.type !== 'button') throw new HttpError(404, `No button ${component}`);
    live.hw.pressButton(component, pressed, 'ui');
  }

  uartWrite(id: string, text: string) {
    const live = this.live.get(id);
    if (!live) throw new HttpError(409, 'Simulator not running');
    live.hw.uartWrite(text);
  }

  simState(id: string) {
    const live = this.live.get(id);
    const lf = this.loadedFirmware(id);
    if (!live) return { status: lf ? 'stopped' : 'idle', loaded: lf, snapshot: null, components: null, nets: null, warnings: [] };
    return {
      status: live.hw.getState().status,
      loaded: lf,
      simId: live.simId,
      snapshot: live.hw.getState(),
      components: live.hw.components,
      nets: live.hw.nets,
      warnings: live.hw.warnings,
      info: live.hw.info,
      history: { gpio: live.hw.gpioTimeline, components: live.hw.componentTimeline, inputs: live.hw.inputTimeline.slice(-500), actions: live.hw.userActions.slice(-200) },
      uart: live.hw.uart.slice(-20000),
      displays: live.hw.displays,
    };
  }

  // ------------------------------------------------------------------ verification & observation
  private requireLoaded(id: string): LoadedFirmware {
    const lf = this.loadedFirmware(id);
    if (!lf) throw new HttpError(409, 'No firmware has been flashed/loaded yet');
    const lb = this.latestBuild(id, true);
    if (lb && lb.buildId !== lf.buildId) throw new HttpError(409, `The flashed firmware (${lf.buildId}) is older than the latest successful build (${lb.buildId}); flash again first`);
    return lf;
  }

  async verify(id: string, scenario: Scenario, source: string): Promise<VerificationReport> {
    const lf = this.requireLoaded(id);
    const meta = this.store.meta(id);
    const dir = this.store.dir(id);
    mkdirSync(join(dir, 'verifications'), { recursive: true });
    const tag = `${source === 'observation' ? 'obs' : 'ver'}_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17)}`;
    const rep = await runVerification({
      backend: getBoard(meta.board).backend,
      board: meta.board,
      circuit: this.store.circuit(id),
      image: this.imageBytes(id, lf),
      firmware: { buildId: lf.buildId, sha256: lf.sha256, method: lf.method, image: lf.image },
      scenario,
      tracePath: join(dir, 'traces', `${tag}.jsonl`),
    });
    (rep as any).source = source;
    (rep as any).flashMethod = lf.method;
    writeFileSync(join(dir, 'verifications', `${tag}_${rep.verificationId}.json`), JSON.stringify(rep, null, 2));
    this.observations.set(id, observationFromReport(rep));
    return rep;
  }

  async runSimulation(id: string, opts: { durationMs: number; stimuli: Scenario['stimuli'] }): Promise<Observation> {
    // Observation run: same engine, with a trivial log-only check (no pass/fail semantics).
    const lcds = this.store.circuit(id).components.filter((c) => c.type === 'lcd').map((c) => c.component_id);
    const dur = Math.max(100, opts.durationMs);
    const checks: any[] = [{ type: 'uart_contains', text: '\u0000never' }, ...lcds.flatMap((l) => [{ type: 'display', component: l, at_ms: Math.round(dur / 2), on: false }, { type: 'display', component: l, at_ms: dur, on: false }])];
    const rep = await this.verify(id, { name: 'observation', duration_ms: dur, stimuli: opts.stimuli ?? [], checks }, 'observation');
    return observationFromReport(rep);
  }

  lastObservation(id: string) {
    return this.observations.get(id) ?? null;
  }

  // ------------------------------------------------------------------ agent run store
  private runDir(projectId: string, runId: string) {
    if (!/^run_[A-Za-z0-9_]+$/.test(runId)) throw new HttpError(400, 'bad run id');
    const d = join(this.store.dir(projectId), 'runs', runId);
    mkdirSync(d, { recursive: true });
    return d;
  }
  private runProject = new Map<string, string>();
  bindRun(runId: string, projectId: string) {
    this.runProject.set(runId, projectId);
  }
  event(runId: string, e: AgentEvent) {
    const pid = this.runProject.get(runId)!;
    appendFileSync(join(this.runDir(pid, runId), 'events.jsonl'), JSON.stringify(e) + '\n');
    this.broadcast(pid, { type: 'agent.event', projectId: pid, runId, event: e });
  }
  saveSummary(s: AgentRunSummary) {
    writeFileSync(join(this.runDir(s.projectId, s.runId), 'run.json'), JSON.stringify(s, null, 2));
  }
  saveLlmCall(runId: string, rec: any) {
    const d = join(this.runDir(this.runProject.get(runId)!, runId), 'llm');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${rec.startedAt.replace(/[:.]/g, '-')}_${rec.callId}.json`), JSON.stringify(rec, null, 2));
  }
  saveToolCall(runId: string, rec: any) {
    const d = join(this.runDir(this.runProject.get(runId)!, runId), 'tools');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${rec.startedAt.replace(/[:.]/g, '-')}_${rec.name}_${rec.toolCallId.slice(-8)}.json`), JSON.stringify(rec, null, 2));
  }
  listRuns(projectId: string): AgentRunSummary[] {
    const d = join(this.store.dir(projectId), 'runs');
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .map((r) => json<AgentRunSummary>(join(d, r, 'run.json')))
      .filter((r): r is AgentRunSummary => !!r)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  getRun(projectId: string, runId: string) {
    const d = this.runDir(projectId, runId);
    const summary = json<AgentRunSummary>(join(d, 'run.json'));
    if (!summary) throw new HttpError(404, 'run not found');
    const events = existsSync(join(d, 'events.jsonl')) ? readFileSync(join(d, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { summary, events };
  }
}

export function observationFromReport(rep: VerificationReport): Observation {
  const components: Observation['components'] = {};
  for (const [k, tl] of Object.entries(rep.timeline)) {
    components[k] = { transitions: Math.max(0, tl.length - 1), timeline: tl.slice(0, 40).map((e) => `${(e.simUs / 1000).toFixed(1)}ms:${e.on ? 'ON' : 'off'}`).join(' ') };
  }
  const gpio: Observation['gpio'] = {};
  for (const [pin, edges] of Object.entries(rep.gpio ?? {})) gpio[pin] = { edges: edges.length, first: edges.slice(0, 24).map((e) => `${(e.simUs / 1000).toFixed(2)}ms→${e.level}`).join(' ') };
  return {
    durationMs: rep.scenario.duration_ms,
    components,
    gpio,
    finalPins: (rep.finalPins ?? []).filter((p) => p.output || p.pull !== 'none').map((p) => `${p.pin}:${p.output ? `OUT=${p.level}` : `IN(pull-${p.pull})`}${p.driver === 'peripheral' ? '(peripheral)' : ''}`).join(', ') || 'all pads are un-configured inputs',
    nets: (rep.nets ?? []).filter((n) => n.level !== 'UNCONNECTED').map((n) => `${n.net_id}=${n.level}${n.voltage !== null ? `(${n.voltage}V)` : ''}`).join(', '),
    uartTail: rep.uartExcerpt.slice(-3000),
    warnings: rep.warnings,
    restarts: rep.warnings.filter((w) => w.startsWith('MCU restarted')),
    displays: rep.results.filter((r) => r.check.type === 'display').map((r) => ({ component: (r.check as any).component, atMs: (r.check as any).at_ms, summary: r.detail })),
  };
}
