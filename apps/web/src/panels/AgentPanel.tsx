import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentRunSummary } from '@plugai/shared';
import { api } from '../api';
import { refreshProject, setState, toast, useStore } from '../store';

const EXAMPLES: Record<string, string[]> = {
  'esp32c3-devkitm-1': ['帮我让一个 LED 亮起来。', '让它每秒闪烁一次。', '给 LED 增加一个按钮，按下点亮，松开熄灭。', '做一个红黄绿交通灯，按照真实交通灯的顺序切换。', '做一个求救灯，连续快速闪三下，停顿一秒，再连续慢闪两下，然后循环。'],
  'arduino-uno': ['帮我让 D4 上的 LED 每 200 毫秒闪一次。', '给两个灯增加一个按钮。每按一次按钮，交换两个灯的亮灭状态。', '用 PWM 做一个呼吸灯。'],
};

type StepState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
const STEP_DEFS: { id: string; label: string }[] = [
  { id: 'understand', label: '理解需求 Understand' },
  { id: 'plan', label: '硬件方案 Plan hardware' },
  { id: 'circuit', label: '修改虚拟电路 Edit circuit' },
  { id: 'code', label: '生成固件 Write firmware' },
  { id: 'build', label: '真实编译 Compile' },
  { id: 'flash', label: '烧录 / 加载 Flash' },
  { id: 'run', label: 'MCU 执行 Run on MCU' },
  { id: 'verify', label: '信号验证 Verify signals' },
  { id: 'debug', label: '自动修复 Repair' },
  { id: 'deliver', label: '交付 Deliver' },
];

function deriveSteps(events: AgentEvent[]): Record<string, StepState> {
  const s: Record<string, StepState> = Object.fromEntries(STEP_DEFS.map((d) => [d.id, 'pending']));
  let phase = '';
  for (const e of events) {
    if (e.kind === 'phase') {
      phase = e.phase;
      if (phase === 'understanding') s.understand = 'active';
      if (phase === 'planning') {
        s.understand = 'done';
        s.plan = 'active';
      }
      if (phase === 'editing-circuit' || phase === 'coding') {
        s.plan = 'done';
        if (s.circuit === 'pending') s.circuit = 'active';
      }
      if (phase === 'building') s.build = 'active';
      if (phase === 'flashing') s.flash = 'active';
      if (phase === 'verifying') {
        s.run = 'active';
        s.verify = 'active';
      }
      if (phase === 'debugging') s.debug = 'active';
      if (phase === 'running') s.deliver = 'active';
    }
    if (e.kind === 'plan') s.plan = 'done';
    if (e.kind === 'tool-end') {
      const n = e.record.name;
      if (n === 'edit_circuit') s.circuit = e.record.ok ? 'done' : 'failed';
      if (n === 'write_firmware') s.code = e.record.ok ? 'done' : 'failed';
      if (n === 'flash_virtual_device') s.flash = /"status": "success"/.test(e.record.resultPreview) ? 'done' : 'failed';
      if (n === 'verify_behavior') {
        const pass = /: PASSED/.test(e.record.resultPreview);
        s.run = 'done';
        s.verify = pass ? 'done' : 'failed';
      }
      if (n === 'repair_project') s.debug = 'done';
    }
    if (e.kind === 'tool-start' && e.name === 'write_firmware') s.code = 'active';
    if (e.kind === 'build') s.build = (e.build as any).status === 'success' ? 'done' : 'failed';
    if (e.kind === 'final') {
      s.deliver = e.status === 'success' ? 'done' : 'failed';
      for (const k of Object.keys(s)) if (s[k] === 'active') s[k] = e.status === 'success' ? 'done' : 'failed';
      for (const k of Object.keys(s)) if (s[k] === 'pending') s[k] = 'skipped';
    }
  }
  return s;
}

function money(n: number | null | undefined) {
  return n === null || n === undefined ? '—' : `$${n.toFixed(4)}`;
}

function RunCard({ run, events, active }: { run: AgentRunSummary; events: AgentEvent[]; active: boolean }) {
  const steps = useMemo(() => deriveSteps(events), [events]);
  const plan = events.find((e) => e.kind === 'plan') as any;
  const final = events.find((e) => e.kind === 'final') as any;
  const usage = useMemo(() => {
    let p = 0, c = 0, cost = 0, calls = 0;
    for (const e of events) if (e.kind === 'llm-call' && e.call.usage) {
      p += e.call.usage.promptTokens;
      c += e.call.usage.completionTokens;
      cost += e.call.usage.costUsd ?? 0;
      calls++;
    }
    return { p, c, cost, calls };
  }, [events]);
  const lastEv: any = events[events.length - 1];
  const thinking = active && lastEv && (lastEv.kind === 'llm-start' || lastEv.kind === 'llm-progress') ? lastEv.role : null;
  const progress = active && lastEv?.kind === 'llm-progress' ? lastEv : null;
  const lastPhase = [...events].reverse().find((e) => e.kind === 'phase') as any;
  const [showLog, setShowLog] = useState(false);
  const pid = useStore((s) => s.project?.meta.id);
  const status = final?.status ?? (active ? 'running' : run.status);
  return (
    <div className={`run-card ${status}`}>
      <div className="run-head">
        <span className={`status ${status === 'success' ? 'success' : status === 'running' ? 'running' : 'failed'}`}>{status === 'success' ? 'VERIFIED (virtual)' : status.toUpperCase()}</span>
        <small className="dim">{run.model} · {usage.calls} LLM calls · {(usage.p + usage.c).toLocaleString()} tok · {money(usage.cost)}</small>
        {active && <button className="ghost sm" onClick={() => void api.post(`/projects/${pid}/agent/${run.runId}/cancel`)}>Cancel</button>}
      </div>
      {active && (
        <div className="now">
          <span className="spin" /> {thinking ? `DeepSeek ${thinking} is ${progress && progress.contentChars + progress.toolArgChars > 0 ? 'writing' : 'thinking'}…` : lastPhase?.message ?? 'Starting…'}
          {progress && <small className="dim"> {((progress.contentChars + progress.toolArgChars) / 1000).toFixed(1)}k chars · reasoning {(progress.reasoningChars / 1000).toFixed(1)}k</small>}
        </div>
      )}
      <ol className="steps">
        {STEP_DEFS.map((d) => (
          <li key={d.id} className={steps[d.id]}>
            <span className="bullet" />
            {d.label}
          </li>
        ))}
      </ol>
      {plan && (
        <details className="plan">
          <summary>AI plan · {plan.plan.change_type} · {plan.plan.feasible ? 'feasible' : 'not feasible'}</summary>
          <p>{plan.plan.understanding}</p>
          {plan.plan.pin_plan?.length > 0 && (
            <table>
              <tbody>
                {plan.plan.pin_plan.map((p: any, i: number) => (
                  <tr key={i}><td><code>{p.board_pin}</code></td><td>{p.direction}</td><td>{p.signal}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {plan.plan.wiring?.length > 0 && <div className="wiring">{plan.plan.wiring.map((w: any) => `${w.from} ↔ ${w.to}`).join(' · ')}</div>}
          {plan.plan.verification && (
            <div className="checks">
              <b>Verification ({plan.plan.verification.duration_ms} ms):</b>
              {plan.plan.verification.checks.map((c: any, i: number) => (
                <div key={i}><code>{c.type}</code> {c.component ?? c.components?.join(',') ?? c.text} {c.period_ms ? `${c.period_ms}ms` : ''} {c.from_ms !== undefined ? `@${c.from_ms}–${c.to_ms ?? ''}ms` : ''}</div>
              ))}
            </div>
          )}
          {plan.plan.capability_gaps?.length > 0 && <div className="warn warning">Gaps: {plan.plan.capability_gaps.join('; ')}</div>}
        </details>
      )}
      <button className="ghost sm" onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide' : 'Show'} activity ({events.filter((e) => e.kind === 'tool-end').length} tool calls)</button>
      {showLog && (
        <div className="activity">
          {events.map((e, i) => {
            if (e.kind === 'tool-end') {
              const r = e.record;
              return (
                <details key={i} className={`act tool ${r.ok ? '' : 'bad'}`}>
                  <summary><span className={`role ${r.role}`}>{r.role}</span> <code>{r.name}</code> <small>{r.durationMs} ms</small> {!r.ok && <b className="bad">error</b>}</summary>
                  <pre>{JSON.stringify(r.args, null, 1).slice(0, 1500)}</pre>
                  <pre>{r.resultPreview}</pre>
                </details>
              );
            }
            if (e.kind === 'llm-call') return <div key={i} className="act llm"><span className={`role ${e.call.role}`}>{e.call.role}</span> DeepSeek <code>{e.call.model}</code> {e.call.status} · {e.call.durationMs} ms · {e.call.usage?.completionTokens ?? 0} out tok{e.call.toolCalls.length ? ` → ${e.call.toolCalls.map((t) => t.name).join(', ')}` : ''}{e.call.error ? ` · ${e.call.error}` : ''}</div>;
            if (e.kind === 'assistant') return <div key={i} className="act say"><span className={`role ${e.role}`}>{e.role}</span> {e.content.slice(0, 600)}</div>;
            if (e.kind === 'error') return <div key={i} className="act err">{e.message}</div>;
            if (e.kind === 'file-change') return <div key={i} className="act file">✎ {e.path} +{e.diffStat.added}/−{e.diffStat.removed}</div>;
            return null;
          })}
        </div>
      )}
      {final && <div className={`final ${final.status}`}>{final.summary}</div>}
    </div>
  );
}

export function AgentPanel() {
  const project = useStore((s) => s.project);
  const events = useStore((s) => s.agentEvents);
  const activeRun = useStore((s) => s.activeRun);
  const env = useStore((s) => s.env);
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const runs = useMemo(() => (project?.runs ?? []).slice().reverse(), [project?.runs]);
  const allIds = useMemo(() => {
    const ids = runs.map((r) => r.runId);
    if (activeRun && !ids.includes(activeRun)) ids.push(activeRun);
    return ids;
  }, [runs, activeRun]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [events, allIds.length]);
  if (!project) return <div className="agent" />;
  const llmOk = env?.llm?.configured;
  const send = async (text = msg) => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const r = await api.post(`/projects/${project.meta.id}/agent`, { message: text.trim() });
      setState((s) => ({ activeRun: r.runId, agentEvents: { ...s.agentEvents, [r.runId]: s.agentEvents[r.runId] ?? [] } }));
      setMsg('');
      setTimeout(() => void refreshProject(), 300);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="agent">
      <div className="agent-head">
        <b>AI Creator</b>
        <span className={`pill ${llmOk ? 'ok' : 'bad'}`} title={llmOk ? `${env.llm.baseUrl}` : 'DEEPSEEK_API_KEY missing in server .env'}>
          {llmOk ? `DeepSeek · ${env.llm.model} · thinking ${env.llm.thinking}/${env.llm.reasoningEffort}` : 'AI unavailable — configure DEEPSEEK_API_KEY'}
        </span>
      </div>
      <div className="thread">
        {allIds.length === 0 && (
          <div className="welcome">
            <h3>Describe the hardware you want.</h3>
            <p className="dim">PlugAI plans the circuit, writes real firmware for the {project.meta.board === 'arduino-uno' ? 'Arduino Uno' : 'ESP32-C3'}, compiles it, flashes the virtual chip, runs it on an instruction-level emulator and verifies the actual GPIO signals.</p>
          </div>
        )}
        {allIds.map((id) => {
          const run = runs.find((r) => r.runId === id) ?? ({ runId: id, userMessage: msg, status: 'running', model: env?.llm?.model ?? '', usage: {} } as any);
          return (
            <div key={id} className="turn">
              <div className="bubble user">{run.userMessage}</div>
              <RunCard run={run} events={events[id] ?? []} active={activeRun === id} />
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <div className="examples">
          {(EXAMPLES[project.meta.board] ?? []).map((e) => (
            <button key={e} className="chip" disabled={!!activeRun || !llmOk} onClick={() => setMsg(e)}>{e}</button>
          ))}
        </div>
        <textarea
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder={llmOk ? '描述你想要的硬件功能… (Enter 发送, Shift+Enter 换行)' : 'AI service not configured — manual mode only (edit Code / circuit directly).'}
          disabled={!llmOk}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!activeRun && !sending) void send();
            }
          }}
        />
        <button className="primary" disabled={!llmOk || !!activeRun || sending || !msg.trim()} onClick={() => void send()}>
          {activeRun ? 'Agent running…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
