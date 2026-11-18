// Minimal HTTP client for the PlugAI server used by integration / e2e tests.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.ts';

export const BASE = process.env.PLUGAI_URL ?? `http://127.0.0.1:${process.env.PLUGAI_PORT ?? 8787}`;

export async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}
export async function ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await call<T>(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.data).slice(0, 400)}`);
  return r.data;
}

export async function serverUp(): Promise<boolean> {
  try {
    return (await call('GET', '/health')).status === 200;
  } catch {
    return false;
  }
}

export async function newProject(name: string, board: 'esp32c3-devkitm-1' | 'arduino-uno' = 'esp32c3-devkitm-1', example?: string) {
  return ok('POST', '/projects', { name, board, example });
}

export interface RunResult {
  runId: string;
  summary: any;
  events: any[];
  wallMs: number;
}

export async function agent(projectId: string, message: string, timeoutMs = 900_000, onProgress?: (s: string) => void): Promise<RunResult> {
  const t0 = Date.now();
  const { runId } = await ok('POST', `/projects/${projectId}/agent`, { message });
  let last = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const d = await ok('GET', `/projects/${projectId}/runs/${runId}`);
    const p = `${d.summary.phase} llm=${d.summary.llmCalls} tools=${d.summary.toolCalls}`;
    if (p !== last) onProgress?.(p);
    last = p;
    if (!d.active && d.summary.status !== 'running') return { runId, summary: d.summary, events: d.events, wallMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`agent run ${runId} timed out`);
  }
}

export function runDir(projectId: string, runId: string) {
  return join(ROOT, 'workspaces', 'projects', projectId, 'runs', runId);
}

export function toolRecords(projectId: string, runId: string): any[] {
  const d = join(runDir(projectId, runId), 'tools');
  if (!existsSync(d)) return [];
  return readdirSync(d).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')));
}
export function llmRecords(projectId: string, runId: string): any[] {
  const d = join(runDir(projectId, runId), 'llm');
  if (!existsSync(d)) return [];
  return readdirSync(d).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')));
}

export function finalVerification(run: RunResult): any | null {
  const v = run.events.filter((e) => e.kind === 'verification');
  return v.length ? v[v.length - 1].report : null;
}

export function describeRun(run: RunResult): string[] {
  const out: string[] = [];
  const plan = run.events.find((e) => e.kind === 'plan')?.plan;
  out.push(`run ${run.runId}: ${run.summary.status} in ${(run.wallMs / 1000).toFixed(0)} s; ${run.summary.llmCalls} DeepSeek calls (${run.summary.model}), ${run.summary.toolCalls} tool calls, ${run.summary.repairRounds} repair round(s), tokens in/out ${run.summary.usage.promptTokens}/${run.summary.usage.completionTokens}, cost $${(run.summary.usage.costUsd ?? 0).toFixed(4)}`);
  if (plan) {
    out.push(`plan: ${plan.understanding.slice(0, 300)}`);
    out.push(`pins: ${plan.pin_plan.map((p: any) => `${p.board_pin}=${p.signal}`).join('; ')}`);
    if (plan.verification) out.push(`verification spec: ${plan.verification.checks.map((c: any) => c.type).join(', ')} over ${plan.verification.duration_ms} ms${plan.verification.stimuli?.length ? ` with ${plan.verification.stimuli.length} stimuli` : ''}`);
  }
  const ver = finalVerification(run);
  if (ver) for (const r of ver.results) out.push(`  ${r.passed ? '✓' : '✗'} ${r.detail}`);
  const builds = run.events.filter((e) => e.kind === 'build').map((e) => e.build.status);
  out.push(`builds: ${builds.join(' → ') || 'none'}`);
  const seq = run.events.filter((e) => e.kind === 'tool-end').map((e) => `${e.record.role[0]}:${e.record.name}${e.record.ok ? '' : '!'}`);
  out.push(`tool chain: ${seq.join(' → ')}`);
  return out;
}
