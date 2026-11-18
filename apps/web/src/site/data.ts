import { useEffect, useState } from 'react';
import { api } from '../api';
import { BASE } from '../router';

export interface CaseSummary {
  id: string;
  order: number;
  kind: 'build' | 'boundary';
  featured: boolean;
  title: string;
  subtitle: string;
  tags: string[];
  board: string;
  boardName: string;
  verified: boolean;
  totals: { wallSec: number; llmCalls: number; toolCalls: number; tokens: number; costUsd: number; repairs: number };
  turns: { prompt: string; status: string }[];
  hasVideo: boolean;
  hasPoster: boolean;
}

let listCache: Promise<CaseSummary[]> | null = null;
const fullCache = new Map<string, Promise<any>>();
let staticList: Promise<CaseSummary[]> | null = null;
let staticFull: Promise<Record<string, any>> | null = null;
let staticProof: Promise<any> | null = null;

/** Public site (GitHub Pages) has no API server; data was exported next to the bundle. */
export const isStaticSite =
  import.meta.env.VITE_STATIC === '1' || (import.meta.env.PROD && location.hostname.endsWith('github.io'));

/** Repository the public site was built from, e.g. https://github.com/owner/PlugAI. Empty locally. */
export const REPO_URL: string = import.meta.env.VITE_REPO_URL || '';

function staticJson<T>(name: string): Promise<T> {
  return fetch(`${BASE}data/${name}`).then((r) => {
    if (!r.ok) throw new Error(`${name}: ${r.status}`);
    return r.json() as Promise<T>;
  });
}

export function useCases(): CaseSummary[] | null {
  const [c, setC] = useState<CaseSummary[] | null>(null);
  useEffect(() => {
    const p = isStaticSite ? (staticList ??= staticJson<CaseSummary[]>('cases.json')) : (listCache ??= api.get('/cases'));
    void p.then(setC).catch(() => setC([]));
  }, []);
  return c;
}

export function loadCase(id: string): Promise<any> {
  if (!fullCache.has(id)) {
    fullCache.set(
      id,
      isStaticSite
        ? (staticFull ??= staticJson<Record<string, any>>('cases-full.json')).then((all) => {
            if (!all[id]) throw new Error('case not found');
            return all[id];
          })
        : api.get(`/cases/${id}`),
    );
  }
  return fullCache.get(id)!;
}

export function useCase(id: string | null): any | null {
  const [c, setC] = useState<any>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    void loadCase(id).then((x) => alive && setC(x));
    return () => {
      alive = false;
    };
  }, [id]);
  return c;
}

export function useProof() {
  const [p, setP] = useState<any>(null);
  useEffect(() => {
    const p = isStaticSite ? (staticProof ??= staticJson('proof.json')) : api.get('/proof');
    void p.then(setP).catch(() => undefined);
  }, []);
  return p;
}

/** Reveal-on-scroll for elements with .reveal inside the scroll container. */
export function useReveal(dep: unknown) {
  useEffect(() => {
    const root = document.querySelector('.site');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      },
      { root, threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    );
    document.querySelectorAll('.site .reveal:not(.in)').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [dep]);
}

/** Where a showcase file lives. The API serves it locally; the static site serves the raw showcase dir. */
export function caseAsset(id: string, file: string): string {
  return isStaticSite ? `${BASE}showcase/${id}/${file}` : `/api/cases/${id}/assets/${file}`;
}

/** Directory prefix for a case's files, with a trailing path separator omitted. */
export const assetBase = (id: string) => caseAsset(id, '').replace(/\/$/, '');

/** Key, human-readable steps from a recorded agent timeline. */
export function keySteps(turn: any): { t: number; text: string; kind: 'ok' | 'llm' | 'err' }[] {
  const out: { t: number; text: string; kind: 'ok' | 'llm' | 'err' }[] = [];
  const roleCn: Record<string, string> = { planner: '规划', coder: '编码', debugger: '调试', executor: '执行' };
  for (const e of turn.timeline) {
    if (e.kind === 'llm') out.push({ t: e.t, text: `DeepSeek ${roleCn[e.role] ?? e.role} · ${(e.ms / 1000).toFixed(1)} s · ${e.tokens.toLocaleString()} tok${e.tools.length ? ` → ${e.tools.join(', ')}` : ''}`, kind: 'llm' });
    else if (e.kind === 'tool' && ['edit_circuit', 'write_firmware', 'plan_hardware', 'run_simulation', 'repair_project'].includes(e.name)) out.push({ t: e.t, text: `${e.name}${e.ok ? '' : ' ✗'} — ${e.preview}`, kind: e.ok ? 'ok' : 'err' });
    else if (e.kind === 'build') out.push({ t: e.t, text: e.status === 'success' ? `真实编译成功 · ${(e.ms / 1000).toFixed(1)} s` : `编译失败 — ${e.error ?? ''}`, kind: e.status === 'success' ? 'ok' : 'err' });
    else if (e.kind === 'flash') out.push({ t: e.t, text: e.method === 'esptool-virtual-uart' ? `esptool 虚拟串口烧录 · ${e.bytes?.toLocaleString() ?? ''} B 校验通过` : '固件载入模拟 Flash（直接加载）', kind: e.status === 'success' ? 'ok' : 'err' });
    else if (e.kind === 'verify') out.push({ t: e.t, text: e.passed ? `信号验证通过 · ${e.results.filter((r: any) => r.passed).length}/${e.results.length} 项` : `验证未通过 → 进入调试`, kind: e.passed ? 'ok' : 'err' });
  }
  return out;
}

export const money = (n: number) => `$${n.toFixed(n < 0.1 ? 3 : 2)}`;
