import { randomUUID } from 'node:crypto';
import { CheckSchema, ScenarioSchema, nowIso, type AgentEvent, type AgentPhase, type AgentRole, type AgentRunSummary, type BoardId, type BuildRecord, type LlmCallRecord, type Scenario, type ToolCallRecord, type VerificationReport } from '@plugai/shared';
import { DeepSeekClient, LlmError, addUsage, ZERO_USAGE, type ChatMessage } from './deepseek.ts';
import { coderSystem, debuggerSystem, plannerSystem } from './prompts.ts';
import { PlanSchema, ROLE_TOOLS, TOOLS, type Plan, type ProjectStateForAgent, type ToolHost } from './tools.ts';

export interface RunStore {
  event(runId: string, e: AgentEvent): void;
  saveSummary(s: AgentRunSummary): void;
  saveLlmCall(runId: string, rec: LlmCallRecord & { request: { messages: number; lastMessages: unknown[] }; response: { content: string | null; tool_calls?: unknown } }): void;
  saveToolCall(runId: string, rec: ToolCallRecord & { result: string }): void;
}

export interface AgentLimits {
  plannerCalls: number;
  coderCalls: number;
  debuggerCalls: number;
  maxRepairRounds: number;
  maxToolCalls: number;
  maxCoderBuildFailures: number;
  toolResultChars: number;
}

export const DEFAULT_LIMITS: AgentLimits = { plannerCalls: 8, coderCalls: 16, debuggerCalls: 16, maxRepairRounds: 3, maxToolCalls: 90, maxCoderBuildFailures: 3, toolResultChars: 24_000 };

class RunAbort extends Error {}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);

export class AgentRun {
  readonly runId: string;
  summary: AgentRunSummary;
  private toolCount = 0;
  private plan: Plan | null = null;
  private scenario: Scenario | null = null;
  private lastBuild: BuildRecord | null = null;
  private lastReport: VerificationReport | null = null;
  private coderBuildFailures = 0;
  private scenarioRevised: string | null = null;
  readonly abort = new AbortController();

  constructor(
    private host: ToolHost,
    private llm: DeepSeekClient,
    private store: RunStore,
    readonly projectId: string,
    private board: BoardId,
    readonly userMessage: string,
    private limits: AgentLimits = DEFAULT_LIMITS,
    runId?: string,
  ) {
    this.runId = runId ?? `run_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${randomUUID().slice(0, 6)}`;
    this.summary = {
      runId: this.runId,
      projectId,
      userMessage,
      status: 'running',
      phase: 'queued',
      model: llm.cfg.model,
      startedAt: nowIso(),
      usage: { ...ZERO_USAGE },
      llmCalls: 0,
      toolCalls: 0,
      repairRounds: 0,
    };
  }

  private emit(e: AgentEvent) {
    this.store.event(this.runId, e);
  }

  private phase(p: AgentPhase, message: string) {
    this.summary.phase = p;
    this.emit({ kind: 'phase', phase: p, message, at: nowIso() });
    this.store.saveSummary(this.summary);
  }

  cancel() {
    this.abort.abort();
  }

  private checkAbort() {
    if (this.abort.signal.aborted) throw new RunAbort('cancelled by user');
  }

  // ---------------------------------------------------------------- model loop
  private async roleLoop<T>(role: Exclude<AgentRole, 'executor'>, system: string, user: string, maxCalls: number, finalTool: string): Promise<T> {
    const tools = ROLE_TOOLS[role].map((n) => TOOLS[n]);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    let nudges = 0;
    for (let i = 0; i < maxCalls; i++) {
      this.checkAbort();
      const callId = `llm_${randomUUID().slice(0, 8)}`;
      this.emit({ kind: 'llm-start', role, callId, model: this.llm.cfg.model, at: nowIso() });
      const t0 = Date.now();
      let res;
      try {
        res = await this.llm.chat({ messages, tools, signal: this.abort.signal, onProgress: (p) => this.emit({ kind: 'llm-progress', role, callId, ...p, at: nowIso() }) });
      } catch (e) {
        const err = e as LlmError;
        const rec: LlmCallRecord = { callId, role, model: this.llm.cfg.model, startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, status: 'error', attempts: 0, toolCalls: [], error: err.message };
        this.emit({ kind: 'llm-call', call: rec, at: nowIso() });
        throw e;
      }
      this.summary.llmCalls++;
      this.summary.usage = addUsage(this.summary.usage, res.usage);
      const rec: LlmCallRecord = {
        callId,
        role,
        model: res.model,
        startedAt: new Date(t0).toISOString(),
        durationMs: res.durationMs,
        status: 'ok',
        attempts: res.attempts,
        usage: res.usage,
        finishReason: res.finishReason,
        toolCalls: (res.message.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name })),
        contentPreview: (res.message.content ?? '').slice(0, 400),
        reasoningChars: res.message.reasoning_content?.length ?? 0,
      };
      this.emit({ kind: 'llm-call', call: rec, at: nowIso() });
      this.store.saveLlmCall(this.runId, { ...rec, request: { messages: messages.length, lastMessages: messages.slice(-2).map((m) => ({ role: m.role, content: clip(m.content ?? '', 4000), tool_call_id: m.tool_call_id })) }, response: { content: res.message.content, tool_calls: res.message.tool_calls } });
      messages.push(res.message);
      if (res.message.content?.trim()) this.emit({ kind: 'assistant', role, content: res.message.content.trim(), at: nowIso() });
      const calls = res.message.tool_calls ?? [];
      if (!calls.length) {
        if (++nudges > 2) throw new Error(`${role} stopped without calling ${finalTool}`);
        messages.push({ role: 'user', content: `Continue using the tools. When done you must call ${finalTool}.` });
        continue;
      }
      let final: { value: T } | null = null;
      for (const call of calls) {
        this.checkAbort();
        if (++this.toolCount > this.limits.maxToolCalls) throw new Error(`Tool call limit (${this.limits.maxToolCalls}) exceeded`);
        this.summary.toolCalls = this.toolCount;
        let args: Record<string, unknown> = {};
        let content: string;
        const ts = Date.now();
        this.emit({ kind: 'tool-start', role, toolCallId: call.id, name: call.function.name, args: safeArgsPreview(call.function.arguments), at: nowIso() });
        let ok = true;
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          if (!ROLE_TOOLS[role].includes(call.function.name as never)) throw new Error(`Tool ${call.function.name} is not available to the ${role}`);
          const r = await this.dispatch(role, call.function.name, args);
          content = r.content;
          if (r.final !== undefined) final = { value: r.final as T };
        } catch (e) {
          ok = false;
          content = `ERROR: ${(e as Error).message}`;
          if (e instanceof RunAbort || (e instanceof LlmError && e.kind === 'cancelled')) throw e;
        }
        content = clip(content, this.limits.toolResultChars);
        const trec: ToolCallRecord = { toolCallId: call.id, role, name: call.function.name, args: redactArgs(args), startedAt: new Date(ts).toISOString(), durationMs: Date.now() - ts, ok: ok && !content.startsWith('ERROR'), resultPreview: content.slice(0, 600) };
        this.emit({ kind: 'tool-end', record: trec, at: nowIso() });
        this.store.saveToolCall(this.runId, { ...trec, args, result: content });
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
      if (final) return final.value;
    }
    throw new Error(`${role} exceeded ${maxCalls} model calls without calling ${finalTool}`);
  }

  // ---------------------------------------------------------------- tools
  private async dispatch(role: AgentRole, name: string, a: Record<string, any>): Promise<{ content: string; final?: unknown }> {
    const h = this.host;
    const P = this.projectId;
    switch (name) {
      case 'inspect_environment':
        return { content: JSON.stringify(await h.inspectEnvironment(), null, 1) };
      case 'get_project_state':
        return { content: projectStateText(await h.getProjectState(P, { includeFiles: true })) };
      case 'list_supported_hardware':
        return { content: JSON.stringify(h.listSupportedHardware(this.board), null, 1) };
      case 'create_project': {
        const r = await h.createProject(P, a.board, this.runId);
        if (r.ok) this.board = a.board;
        return { content: JSON.stringify(r) };
      }
      case 'plan_hardware': {
        const parsed = PlanSchema.safeParse(a);
        if (!parsed.success) return { content: `INVALID PLAN — fix these issues and call plan_hardware again:\n${parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')}` };
        const plan = parsed.data;
        if (plan.feasible && plan.change_type !== 'none') {
          if (!plan.verification) return { content: 'INVALID PLAN — a feasible change needs a verification scenario with at least one physical check.' };
          const bad = plan.verification.checks.map((c, i) => [i, CheckSchema.safeParse(c)] as const).filter(([, r]) => !r.success);
          if (bad.length) return { content: `INVALID PLAN — verification checks invalid: ${bad.map(([i, r]) => `#${i}: ${(r as any).error.issues.map((x: any) => `${x.path.join('.')} ${x.message}`).join(', ')}`).join('; ')}` };
          if (!plan.verification.checks.some((c) => c.type !== 'uart_contains')) return { content: 'INVALID PLAN — verification must include physical checks (state_during/period/pattern/toggle_count), UART text is not physical evidence.' };
          const timing = scenarioTimingProblems(plan.verification);
          if (timing.length) return { content: `INVALID PLAN — the verification scenario cannot be satisfied as written:\n${timing.map((t) => `- ${t}`).join('\n')}\nFix the durations/windows and call plan_hardware again.` };
        }
        this.plan = plan;
        return { content: 'Plan accepted.', final: plan };
      }
      case 'read_file':
        return { content: await h.readFile(P, String(a.path)) };
      case 'read_sdk_reference':
        return { content: await h.readSdkReference(this.board, String(a.topic)) };
      case 'edit_circuit': {
        const r = await h.editCircuit(P, a.ops ?? [], this.runId);
        return { content: `OK\n${r.log.join('\n')}\n\nCircuit now:\n${r.circuit}\n\nElectrical warnings (with current MCU reset state): ${r.warnings.length ? r.warnings.join(' | ') : 'none'}` };
      }
      case 'write_firmware': {
        const r = await h.writeFile(P, String(a.path), String(a.content ?? ''), this.runId);
        this.emit({ kind: 'file-change', path: String(a.path), bytes: r.bytes, diffStat: { added: r.added, removed: r.removed }, at: nowIso() });
        return { content: `Wrote ${a.path} (${r.bytes} bytes, +${r.added}/-${r.removed} lines).` };
      }
      case 'build_firmware': {
        this.phase('building', 'Compiling firmware with the real cross-compiler');
        const b = await h.build(P, this.runId);
        this.lastBuild = b;
        this.emit({ kind: 'build', build: b, at: nowIso() });
        if (b.status !== 'success' && role === 'coder') {
          this.coderBuildFailures++;
          if (this.coderBuildFailures > this.limits.maxCoderBuildFailures) return { content: buildText(b) + `\n\nBuild attempts exhausted (${this.limits.maxCoderBuildFailures}). Call finish_implementation and describe the remaining errors.` };
        }
        this.phase(role === 'coder' ? 'coding' : 'debugging', b.status === 'success' ? 'Build succeeded' : 'Build failed — analysing diagnostics');
        return { content: buildText(b) };
      }
      case 'finish_implementation': {
        const cur = await h.sourceHash(P);
        if (!this.lastBuild || this.lastBuild.status !== 'success' || this.lastBuild.sourceHash !== cur) {
          if (this.coderBuildFailures > this.limits.maxCoderBuildFailures) return { content: 'Recorded: implementation incomplete (build failing).', final: { summary: String(a.summary ?? ''), buildOk: false } };
          return { content: 'ERROR: the current sources have not been built successfully. Call build_firmware and fix all errors first.' };
        }
        const missing = await this.missingWires();
        if (missing.length) return { content: `ERROR: the circuit does not match the plan; missing connections: ${missing.join(', ')}. Fix with edit_circuit.` };
        return { content: 'Implementation recorded. The platform will now flash and verify independently.', final: { summary: String(a.summary ?? ''), buildOk: true } };
      }
      case 'flash_virtual_device': {
        const f = await h.flash(P, this.runId);
        this.emit({ kind: 'flash', flash: f, at: nowIso() });
        return { content: JSON.stringify({ status: f.status, method: f.method, description: f.description, steps: f.steps.map((s) => `${s.name}: ${s.status}${s.detail ? ` (${s.detail})` : ''}`), error: f.error }, null, 1) };
      }
      case 'run_simulation': {
        const o = await h.runSimulation(P, { durationMs: Math.min(60_000, Number(a.duration_ms ?? 3000)), stimuli: a.stimuli ?? [] });
        return { content: JSON.stringify(o, null, 1) };
      }
      case 'inspect_uart': {
        const o = h.lastObservation(P);
        return { content: o ? `UART (last run):\n${o.uartTail}` : 'No simulation has been run yet.' };
      }
      case 'inspect_gpio': {
        const o = h.lastObservation(P);
        return { content: o ? JSON.stringify({ gpio: o.gpio, finalPins: o.finalPins, nets: o.nets, components: o.components, warnings: o.warnings }, null, 1) : 'No simulation has been run yet.' };
      }
      case 'verify_behavior': {
        if (!this.scenario) return { content: 'ERROR: no verification scenario' };
        const r = await h.verify(P, this.scenario, this.runId);
        this.lastReport = r;
        this.emit({ kind: 'verification', report: r, at: nowIso() });
        return { content: reportText(r) };
      }
      case 'repair_project': {
        let revised: Scenario | undefined;
        if (a.revised_verification) {
          const s = ScenarioSchema.safeParse(a.revised_verification);
          if (!s.success) return { content: `ERROR: revised_verification invalid: ${s.error.issues.map((i) => i.message).join(', ')}` };
          const err = this.checkRevision(s.data);
          if (err) return { content: `ERROR: revision rejected: ${err}` };
          revised = s.data;
        }
        return { content: 'Diagnosis recorded. The platform will rebuild, re-flash and re-verify.', final: { ...a, revised_verification: revised } };
      }
    }
    throw new Error(`Unknown tool ${name}`);
  }

  private checkRevision(s: Scenario): string | null {
    const old = this.scenario!;
    if (this.scenarioRevised) return 'the verification scenario may only be revised once per run';
    const phys = (x: Scenario) => x.checks.filter((c) => c.type !== 'uart_contains');
    if (phys(s).length < phys(old).length) return 'cannot reduce the number of physical checks';
    const types = (x: Scenario) => phys(x).map((c) => c.type).sort().join();
    if (types(s) !== types(old)) return 'check types must stay the same';
    for (const c of s.checks) {
      if ('tolerance_pct' in c && (c as any).tolerance_pct > 10) return 'tolerance_pct must be ≤ 10';
      if ('tolerance_ms' in c && (c as any).tolerance_ms > 100) return 'tolerance_ms must be ≤ 100';
    }
    return null;
  }

  private async missingWires(): Promise<string[]> {
    if (!this.plan) return [];
    const st = await this.host.getProjectState(this.projectId);
    const wires = ((st.circuitJson as any)?.wires ?? []) as { from: { component_id: string; pin_id: string }; to: { component_id: string; pin_id: string } }[];
    const has = (a: string, b: string) => wires.some((w) => {
      const f = `${w.from.component_id}.${w.from.pin_id}`;
      const t = `${w.to.component_id}.${w.to.pin_id}`;
      return (f === a && t === b) || (f === b && t === a);
    });
    // board GND pins are internally common: accept any GND pin as equivalent
    const norm = (r: string) => (/^board\.(J[13]_)?GND\d*$|^board\.GND(_TOP)?\d*$/.test(r) ? 'board.GND' : r);
    const hasNorm = (a: string, b: string) => has(a, b) || wires.some((w) => {
      const f = norm(`${w.from.component_id}.${w.from.pin_id}`);
      const t = norm(`${w.to.component_id}.${w.to.pin_id}`);
      return (f === norm(a) && t === norm(b)) || (f === norm(b) && t === norm(a));
    });
    return this.plan.wiring.filter((w) => !hasNorm(w.from, w.to)).map((w) => `${w.from}↔${w.to}`);
  }

  // ---------------------------------------------------------------- main flow
  async execute(): Promise<AgentRunSummary> {
    const finish = (status: AgentRunSummary['status'], summary: string) => {
      this.summary.status = status;
      this.summary.summary = summary;
      this.summary.finishedAt = nowIso();
      this.summary.phase = status === 'success' ? 'done' : status === 'cancelled' ? 'cancelled' : 'failed';
      this.emit({ kind: 'phase', phase: this.summary.phase, message: status, at: nowIso() });
      this.emit({ kind: 'final', status: status === 'running' ? 'failed' : status, summary, at: nowIso() });
      this.store.saveSummary(this.summary);
      return this.summary;
    };
    try {
      this.summary.commitBefore = (await this.host.commit(this.projectId, `checkpoint before ${this.runId}`)) ?? undefined;
      this.phase('understanding', 'Reading the current project and environment');
      const state = await this.host.getProjectState(this.projectId, { includeFiles: true });
      this.board = state.board;

      this.phase('planning', 'DeepSeek Planner is designing the hardware, pins and verification');
      const plan = await this.roleLoop<Plan>('planner', plannerSystem(this.board), plannerContext(state, this.userMessage), this.limits.plannerCalls, 'plan_hardware');
      this.emit({ kind: 'plan', plan, at: nowIso() });
      if (!plan.feasible) return finish('failed', `${plan.user_summary}\n\nCapability gaps: ${plan.capability_gaps.join('; ') || 'n/a'}`);
      if (plan.change_type === 'none') return finish('success', `${plan.user_summary}\n\n(No hardware or firmware changes were made; nothing was verified.)`);
      this.scenario = plan.verification!;

      this.phase('editing-circuit', 'DeepSeek Coder is wiring the circuit and writing firmware');
      const st2 = await this.host.getProjectState(this.projectId, { includeFiles: true });
      const impl = await this.roleLoop<{ summary: string; buildOk: boolean }>('coder', coderSystem(this.board), coderContext(plan, st2), this.limits.coderCalls, 'finish_implementation');
      await this.host.commit(this.projectId, `agent(${this.runId}): ${plan.understanding.slice(0, 120)}`);

      let buildOk = impl.buildOk;
      for (let round = 0; ; round++) {
        this.checkAbort();
        let failureContext = '';
        if (buildOk) {
          this.phase('flashing', this.board === 'esp32c3-devkitm-1' ? 'Flashing over virtual UART with esptool (ROM download mode)' : 'Loading HEX into simulated flash (direct image load)');
          const f = await this.executor('flash_virtual_device', {});
          if (!/"status": "success"/.test(f)) {
            failureContext = `Flashing failed:\n${f}`;
          } else {
            this.phase('verifying', 'Verification Engine is running the firmware on a fresh simulated MCU');
            const rep = await this.executor('verify_behavior', {});
            if (this.lastReport?.passed) {
              this.summary.finalVerificationId = this.lastReport.verificationId;
              this.summary.finalBuildId = this.lastBuild?.buildId;
              this.phase('running', 'Starting the verified firmware in the live Virtual Hardware Lab');
              await this.host.startLive(this.projectId);
              this.summary.commitAfter = (await this.host.commit(this.projectId, `agent(${this.runId}): verified`)) ?? undefined;
              const lines = this.lastReport.results.map((r) => `${r.passed ? '✓' : '✗'} ${r.detail}`);
              return finish('success', `${plan.user_summary}\n\n虚拟验证通过 (virtual simulation verification passed — not physical hardware):\n${lines.join('\n')}${this.scenarioRevised ? `\n\nNote: the verification scenario was revised by the Debug Agent: ${this.scenarioRevised}` : ''}`);
            }
            failureContext = rep;
          }
        } else {
          failureContext = this.lastBuild ? `The firmware does not compile:\n${buildText(this.lastBuild)}` : 'No successful build.';
        }
        if (round >= this.limits.maxRepairRounds) {
          const why = this.lastReport && !this.lastReport.passed ? this.lastReport.results.filter((r) => !r.passed).map((r) => r.detail).join('\n') : failureContext.slice(0, 1500);
          return finish('failed', `Could not satisfy the requirement after ${this.limits.maxRepairRounds} automatic repair round(s). Last real failure:\n${why}`);
        }
        this.summary.repairRounds++;
        this.phase('debugging', `DeepSeek Debugger is analysing real failure evidence (repair round ${round + 1}/${this.limits.maxRepairRounds})`);
        const st3 = await this.host.getProjectState(this.projectId, { includeFiles: true });
        const diag: any = await this.roleLoop<any>('debugger', debuggerSystem(this.board), debuggerContext(plan, this.scenario!, st3, failureContext, this.host.lastObservation(this.projectId)), this.limits.debuggerCalls, 'repair_project');
        if (diag.revised_verification) {
          this.scenario = diag.revised_verification;
          this.scenarioRevised = String(diag.revision_reason ?? diag.explanation ?? '');
          this.emit({ kind: 'assistant', role: 'debugger', content: `Verification scenario revised: ${this.scenarioRevised}`, at: nowIso() });
        }
        // the executor makes sure the current sources are built
        const cur = await this.host.sourceHash(this.projectId);
        if (!this.lastBuild || this.lastBuild.sourceHash !== cur || this.lastBuild.status !== 'success') {
          await this.executor('build_firmware', {});
        }
        buildOk = this.lastBuild?.status === 'success' && this.lastBuild.sourceHash === (await this.host.sourceHash(this.projectId));
        await this.host.commit(this.projectId, `agent(${this.runId}): repair round ${round + 1} (${diag.root_cause})`);
      }
    } catch (e) {
      if (e instanceof RunAbort || (e instanceof LlmError && e.kind === 'cancelled')) return finish('cancelled', 'Run cancelled by user.');
      if (e instanceof LlmError) {
        this.emit({ kind: 'error', message: e.message, at: nowIso() });
        return finish('failed', `AI service unavailable — ${e.message}\nPlugAI does not fall back to templates; nothing was generated by rules.`);
      }
      this.emit({ kind: 'error', message: (e as Error).message, at: nowIso() });
      return finish('failed', `Agent run failed: ${(e as Error).message}`);
    }
  }

  /** Deterministic tool execution by the orchestrator (logged as role "executor"). */
  private async executor(name: string, args: Record<string, unknown>): Promise<string> {
    const id = `exec_${randomUUID().slice(0, 8)}`;
    const t = Date.now();
    this.emit({ kind: 'tool-start', role: 'executor', toolCallId: id, name, args, at: nowIso() });
    let content: string;
    let ok = true;
    try {
      content = (await this.dispatch('executor', name, args)).content;
    } catch (e) {
      ok = false;
      content = `ERROR: ${(e as Error).message}`;
    }
    const rec: ToolCallRecord = { toolCallId: id, role: 'executor', name, args, startedAt: new Date(t).toISOString(), durationMs: Date.now() - t, ok, resultPreview: content.slice(0, 600) };
    this.emit({ kind: 'tool-end', record: rec, at: nowIso() });
    this.store.saveToolCall(this.runId, { ...rec, result: content });
    return content;
  }
}

/** Deterministic satisfiability checks for a model-proposed scenario (does not judge behaviour). */
export function scenarioTimingProblems(s: Scenario): string[] {
  const out: string[] = [];
  const D = s.duration_ms;
  for (const [i, c] of s.checks.entries()) {
    if (c.type === 'period') {
      const need = (c.from_ms ?? 0) + (c.min_cycles + 1) * c.period_ms * (1 + c.tolerance_pct / 100) + 50;
      if (D < need) out.push(`check #${i} (period ${c.period_ms} ms, min_cycles ${c.min_cycles}, from ${c.from_ms ?? 0} ms) needs ${c.min_cycles + 1} rising edges after from_ms → duration_ms must be ≥ ${Math.ceil(need)} (is ${D})`);
    } else if (c.type === 'pattern') {
      const cycle = c.segments.reduce((a, x) => a + x.duration_ms, 0);
      const need = (c.from_ms ?? 0) + (c.cyclic ? (c.min_repeats + 1) * cycle : cycle) + 100;
      if (D < need) out.push(`check #${i} (pattern, cycle ${cycle} ms, min_repeats ${c.min_repeats}) needs duration_ms ≥ ${Math.ceil(need)} because the first partial segment is discarded (is ${D})`);
    } else if (c.type === 'display') {
      if (c.at_ms > D) out.push(`check #${i} (display) captures at ${c.at_ms} ms, after duration_ms (${D})`);
      if (c.changed_since_ms !== undefined && c.changed_since_ms >= c.at_ms) out.push(`check #${i} (display) changed_since_ms must be earlier than at_ms`);
    } else if (c.type === 'state_during' || c.type === 'toggle_count') {
      if (c.to_ms <= c.from_ms) out.push(`check #${i} has to_ms ≤ from_ms`);
      if (c.from_ms > D) out.push(`check #${i} window starts after duration_ms (${D})`);
    }
  }
  for (const st of s.stimuli) if (st.at_ms > D) out.push(`stimulus at ${st.at_ms} ms is after duration_ms (${D})`);
  return out;
}

// ---------------------------------------------------------------- context builders
function safeArgsPreview(s: string): unknown {
  try {
    return redactArgs(JSON.parse(s));
  } catch {
    return s.slice(0, 200);
  }
}
function redactArgs(a: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...a };
  if (typeof o.content === 'string') o.content = `<${(o.content as string).length} chars>`;
  return o;
}

export function projectStateText(s: ProjectStateForAgent): string {
  return [
    `Project "${s.name}" (${s.projectId}), board ${s.board}${s.isEmpty ? ' — EMPTY project (no firmware logic, no parts yet)' : ''}`,
    '',
    'Circuit:',
    s.circuit,
    `Electrical warnings: ${s.circuitWarnings.length ? s.circuitWarnings.join(' | ') : 'none'}`,
    '',
    'Firmware files:',
    ...s.files.map((f) => (f.content !== undefined ? `--- ${f.path} (${f.bytes} bytes)\n${f.content}` : `--- ${f.path} (${f.bytes} bytes)`)),
    '',
    `Last build: ${s.lastBuild ? `${s.lastBuild.buildId} ${s.lastBuild.status}${s.lastBuild.error ? ` — ${s.lastBuild.error}` : ''}${s.lastBuild.diagnostics.length ? `\n${s.lastBuild.diagnostics.join('\n')}` : ''}` : 'none'}`,
    `Last verification: ${s.lastVerification ? `${s.lastVerification.passed ? 'PASSED' : 'FAILED'}\n${s.lastVerification.summary.join('\n')}` : 'none'}`,
  ].join('\n');
}

function plannerContext(s: ProjectStateForAgent, msg: string): string {
  const conv = s.conversation.slice(-8).map((c) => `${c.role === 'user' ? 'User' : 'PlugAI'}: ${c.text.slice(0, 600)}`).join('\n');
  return `${conv ? `Conversation so far in this project:\n${conv}\n\n` : ''}Current project state:\n${projectStateText(s)}\n\nNEW USER REQUEST:\n${msg}\n\nPlan the change (inspect tools if needed), then call plan_hardware.`;
}

function coderContext(plan: Plan, s: ProjectStateForAgent): string {
  return `Approved plan (JSON):\n${JSON.stringify(plan, null, 1)}\n\nCurrent project state:\n${projectStateText(s)}\n\nImplement it: edit_circuit → write_firmware → build_firmware (fix errors) → finish_implementation.`;
}

function debuggerContext(plan: Plan, sc: Scenario, s: ProjectStateForAgent, failure: string, obs: unknown): string {
  return `Plan (JSON):\n${JSON.stringify({ understanding: plan.understanding, pin_plan: plan.pin_plan, wiring: plan.wiring, firmware_plan: plan.firmware_plan }, null, 1)}\n\nVerification scenario in force:\n${JSON.stringify(sc, null, 1)}\n\nREAL FAILURE EVIDENCE:\n${failure}\n\nObservation of the last run (GPIO/LED/nets/UART):\n${obs ? JSON.stringify(obs, null, 1).slice(0, 12000) : 'n/a'}\n\nCurrent project state:\n${projectStateText(s)}\n\nFind the root cause, fix it, rebuild, then call repair_project.`;
}

export function buildText(b: BuildRecord): string {
  const diags = b.diagnostics.filter((d) => d.severity !== 'note').slice(0, 25).map((d) => `${d.file}:${d.line}${d.column ? `:${d.column}` : ''}: ${d.severity}: ${d.message}`);
  return [
    `Build ${b.buildId}: ${b.status.toUpperCase()} in ${b.durationMs} ms${b.error ? ` — ${b.error}` : ''}`,
    diags.length ? `Diagnostics:\n${diags.join('\n')}` : 'Diagnostics: none',
    b.status === 'success' ? `Artifacts: ${b.artifacts.filter((a) => a.kind !== 'map' && a.kind !== 'other').map((a) => `${a.name} ${a.size}B sha256:${a.sha256.slice(0, 16)}`).join(', ')}` : `Log tail:\n${(b.logTail ?? '').split('\n').filter((l) => !/^\s*$/.test(l)).slice(-40).join('\n')}`,
  ].join('\n');
}

export function reportText(r: VerificationReport): string {
  return [
    `Verification ${r.verificationId}: ${r.passed ? 'PASSED' : 'FAILED'} (virtual simulation, ${r.simulatedMs.toFixed(0)} ms simulated in ${r.wallMs} ms wall, firmware sha256 ${r.firmwareSha256?.slice(0, 12)})`,
    ...r.results.map((x) => `${x.passed ? 'PASS' : 'FAIL'}${x.logOnly ? ' (log-only)' : ''}: ${x.detail}`),
    r.warnings.length ? `Warnings: ${r.warnings.join(' | ')}` : '',
    `UART tail: ${r.uartExcerpt.slice(-800)}`,
  ].join('\n');
}
