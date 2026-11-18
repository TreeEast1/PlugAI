// DeepSeek (OpenAI-compatible) Chat Completions client with thinking mode + function calling.
// The API key is only read from the server environment and never logged or returned.
import type { LlmUsage } from '@plugai/shared';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: 'low' | 'high' | 'max';
  thinking: boolean;
  timeoutMs: number;
  maxRetries: number;
  maxTokens?: number;
  price?: { inputPerM?: number; cachedPerM?: number; outputPerM?: number };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'auth' | 'rate-limit' | 'network' | 'timeout' | 'bad-request' | 'server' | 'insufficient-balance' | 'cancelled',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = (env.DEEPSEEK_API_KEY ?? '').trim();
  if (!apiKey || apiKey === 'your-deepseek-api-key-here') throw new LlmError('DEEPSEEK_API_KEY is not configured on the server (.env). The AI agent is unavailable; no template fallback is used.', 'config');
  const num = (v: string | undefined) => (v && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    apiKey,
    baseUrl: (env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    reasoningEffort: (env.DEEPSEEK_REASONING_EFFORT as LlmConfig['reasoningEffort']) ?? 'high',
    thinking: (env.DEEPSEEK_THINKING ?? 'enabled') !== 'disabled',
    timeoutMs: num(env.DEEPSEEK_TIMEOUT_MS) ?? 240_000,
    maxRetries: num(env.DEEPSEEK_MAX_RETRIES) ?? 4,
    price: { inputPerM: num(env.DEEPSEEK_PRICE_INPUT_PER_M), cachedPerM: num(env.DEEPSEEK_PRICE_INPUT_CACHED_PER_M), outputPerM: num(env.DEEPSEEK_PRICE_OUTPUT_PER_M) },
  };
}

/** DeepSeek-V4.1-Flash list prices (USD / 1M tokens), peak = 01-04 & 06-10 UTC Mon-Fri. */
export function flashPrice(at = new Date()) {
  const h = at.getUTCHours();
  const d = at.getUTCDay();
  const peak = d >= 1 && d <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
  return peak ? { inputPerM: 0.3, cachedPerM: 0.006, outputPerM: 1.2, peak } : { inputPerM: 0.15, cachedPerM: 0.003, outputPerM: 0.6, peak };
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string;
  usage: LlmUsage;
  attempts: number;
  durationMs: number;
  model: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new LlmError('cancelled', 'cancelled'));
    });
  });

export class DeepSeekClient {
  constructor(readonly cfg: LlmConfig) {}

  static fromEnv() {
    return new DeepSeekClient(loadLlmConfig());
  }

  private cost(u: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number }): number | null {
    const p = { ...flashPrice(), ...Object.fromEntries(Object.entries(this.cfg.price ?? {}).filter(([, v]) => v !== undefined)) } as { inputPerM: number; cachedPerM: number; outputPerM: number };
    if (this.cfg.model !== 'deepseek-flash' && !this.cfg.price?.inputPerM) return null;
    const hit = u.prompt_cache_hit_tokens ?? 0;
    const miss = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - hit);
    return (hit * p.cachedPerM + miss * p.inputPerM + (u.completion_tokens ?? 0) * p.outputPerM) / 1e6;
  }

  /** Parse an SSE stream from /chat/completions into a single assistant message. */
  private async readStream(res: Response, onActivity: () => void, onProgress?: (p: { contentChars: number; reasoningChars: number; toolArgChars: number }) => void) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning = '';
    let finish = '';
    let usage: any = {};
    let model = this.cfg.model;
    const tools: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
    let lastProg = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity();
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const chunk = JSON.parse(data);
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const ch = chunk.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        const d = ch.delta ?? {};
        if (d.content) content += d.content;
        if (d.reasoning_content) reasoning += d.reasoning_content;
        for (const tc of d.tool_calls ?? []) {
          const slot = (tools[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
      if (onProgress && Date.now() - lastProg > 3000) {
        lastProg = Date.now();
        onProgress({ contentChars: content.length, reasoningChars: reasoning.length, toolArgChars: tools.reduce((a, t) => a + t.function.arguments.length, 0) });
      }
    }
    return { content, reasoning, tools: tools.filter(Boolean), finish, usage, model };
  }

  async chat(req: { messages: ChatMessage[]; tools?: ToolDef[]; signal?: AbortSignal; maxTokens?: number; jsonMode?: boolean; stream?: boolean; onProgress?: (p: { contentChars: number; reasoningChars: number; toolArgChars: number }) => void }): Promise<ChatResult> {
    if (req.stream !== false) return this.chatStream(req);
    return this.chatOnce(req);
  }

  private async chatStream(req: { messages: ChatMessage[]; tools?: ToolDef[]; signal?: AbortSignal; maxTokens?: number; jsonMode?: boolean; onProgress?: (p: { contentChars: number; reasoningChars: number; toolArgChars: number }) => void }): Promise<ChatResult> {
    const body = this.buildBody(req);
    body.stream = true;
    body.stream_options = { include_usage: true };
    const started = Date.now();
    let attempt = 0;
    let lastErr: LlmError | null = null;
    const idleMs = Math.max(60_000, Math.min(this.cfg.timeoutMs, 180_000));
    while (attempt <= this.cfg.maxRetries) {
      attempt++;
      if (req.signal?.aborted) throw new LlmError('cancelled', 'cancelled');
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      req.signal?.addEventListener('abort', onAbort);
      let idle: ReturnType<typeof setTimeout> | null = null;
      let idleFired = false;
      const bump = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          idleFired = true;
          ctrl.abort();
        }, idleMs);
      };
      const hard = setTimeout(() => ctrl.abort(), 20 * 60_000);
      bump();
      try {
        const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` }, body: JSON.stringify(body), signal: ctrl.signal });
        if (!res.ok) {
          const text = await res.text();
          lastErr = this.httpError(res.status, text);
          if (['auth', 'bad-request', 'insufficient-balance'].includes(lastErr.kind)) throw lastErr;
        } else {
          const r = await this.readStream(res, bump, req.onProgress);
          const u = r.usage ?? {};
          return {
            message: { role: 'assistant', content: r.content, reasoning_content: r.reasoning || null, tool_calls: r.tools.length ? r.tools : undefined },
            finishReason: r.finish,
            usage: { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0, cachedTokens: u.prompt_cache_hit_tokens ?? 0, costUsd: this.cost(u) },
            attempts: attempt,
            durationMs: Date.now() - started,
            model: r.model,
          };
        }
      } catch (e) {
        if (e instanceof LlmError && ['auth', 'bad-request', 'insufficient-balance', 'config', 'cancelled'].includes(e.kind)) throw e;
        if (req.signal?.aborted) throw new LlmError('cancelled', 'cancelled');
        if (e instanceof LlmError) lastErr = e;
        else if ((e as Error).name === 'AbortError') lastErr = new LlmError(idleFired ? `DeepSeek stream stalled (no data for ${idleMs / 1000} s)` : 'DeepSeek request exceeded 20 min', 'timeout');
        else lastErr = new LlmError(`Network error contacting DeepSeek: ${(e as Error).message}${(e as { cause?: Error }).cause ? ` (${(e as { cause?: Error }).cause!.message})` : ''}`, 'network');
      } finally {
        if (idle) clearTimeout(idle);
        clearTimeout(hard);
        req.signal?.removeEventListener('abort', onAbort);
      }
      if (attempt > this.cfg.maxRetries) break;
      await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (lastErr?.kind === 'rate-limit' ? 2 : 1) + Math.random() * 500, req.signal);
    }
    throw lastErr ?? new LlmError('DeepSeek request failed', 'server');
  }

  private httpError(status: number, text: string): LlmError {
    const msg = (() => {
      try {
        return JSON.parse(text).error?.message ?? text.slice(0, 300);
      } catch {
        return text.slice(0, 300);
      }
    })();
    if (status === 401 || status === 403) return new LlmError(`DeepSeek authentication failed (${status}): ${msg}`, 'auth', status);
    if (status === 402) return new LlmError(`DeepSeek account balance insufficient: ${msg}`, 'insufficient-balance', 402);
    if (status === 400 || status === 422) return new LlmError(`DeepSeek rejected the request (${status}): ${msg}`, 'bad-request', status);
    if (status === 429) return new LlmError(`DeepSeek rate limit (429): ${msg}`, 'rate-limit', 429);
    return new LlmError(`DeepSeek server error ${status}: ${msg}`, 'server', status);
  }

  private buildBody(req: { messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number; jsonMode?: boolean }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages.map((m) => {
        const o: Record<string, unknown> = { role: m.role, content: m.content ?? '' };
        if (m.role === 'assistant') {
          if (m.reasoning_content) o.reasoning_content = m.reasoning_content;
          if (m.tool_calls?.length) o.tool_calls = m.tool_calls;
        }
        if (m.role === 'tool') o.tool_call_id = m.tool_call_id;
        return o;
      }),
    };
    if (this.cfg.thinking) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = this.cfg.reasoningEffort;
    } else body.thinking = { type: 'disabled' };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    if (req.maxTokens ?? this.cfg.maxTokens) body.max_tokens = req.maxTokens ?? this.cfg.maxTokens;
    return body;
  }

  private async chatOnce(req: { messages: ChatMessage[]; tools?: ToolDef[]; signal?: AbortSignal; maxTokens?: number; jsonMode?: boolean }): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages.map((m) => {
        const o: Record<string, unknown> = { role: m.role, content: m.content ?? '' };
        if (m.role === 'assistant') {
          if (m.reasoning_content) o.reasoning_content = m.reasoning_content;
          if (m.tool_calls?.length) o.tool_calls = m.tool_calls;
        }
        if (m.role === 'tool') o.tool_call_id = m.tool_call_id;
        return o;
      }),
      stream: false,
    };
    if (this.cfg.thinking) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = this.cfg.reasoningEffort;
    } else body.thinking = { type: 'disabled' };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = 'auto'; // 'required' is not supported in thinking mode
    }
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    if (req.maxTokens ?? this.cfg.maxTokens) body.max_tokens = req.maxTokens ?? this.cfg.maxTokens;

    const started = Date.now();
    let attempt = 0;
    let lastErr: LlmError | null = null;
    while (attempt <= this.cfg.maxRetries) {
      attempt++;
      if (req.signal?.aborted) throw new LlmError('cancelled', 'cancelled');
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      req.signal?.addEventListener('abort', onAbort);
      const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
      try {
        const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          const msg = (() => {
            try {
              return JSON.parse(text).error?.message ?? text.slice(0, 300);
            } catch {
              return text.slice(0, 300);
            }
          })();
          if (res.status === 401 || res.status === 403) throw new LlmError(`DeepSeek authentication failed (${res.status}): ${msg}`, 'auth', res.status);
          if (res.status === 402) throw new LlmError(`DeepSeek account balance insufficient: ${msg}`, 'insufficient-balance', 402);
          if (res.status === 400 || res.status === 422) throw new LlmError(`DeepSeek rejected the request (${res.status}): ${msg}`, 'bad-request', res.status);
          if (res.status === 429) {
            lastErr = new LlmError(`DeepSeek rate limit (429): ${msg}`, 'rate-limit', 429);
          } else lastErr = new LlmError(`DeepSeek server error ${res.status}: ${msg}`, 'server', res.status);
        } else {
          const data = JSON.parse(text);
          const choice = data.choices?.[0];
          if (!choice?.message) throw new LlmError('DeepSeek returned no choices', 'server');
          const u = data.usage ?? {};
          const usage: LlmUsage = {
            promptTokens: u.prompt_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
            reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
            cachedTokens: u.prompt_cache_hit_tokens ?? 0,
            costUsd: this.cost(u),
          };
          const m = choice.message;
          return {
            message: { role: 'assistant', content: m.content ?? '', reasoning_content: m.reasoning_content ?? null, tool_calls: m.tool_calls?.length ? m.tool_calls : undefined },
            finishReason: choice.finish_reason,
            usage,
            attempts: attempt,
            durationMs: Date.now() - started,
            model: data.model ?? this.cfg.model,
          };
        }
      } catch (e) {
        if (e instanceof LlmError && ['auth', 'bad-request', 'insufficient-balance', 'config', 'cancelled'].includes(e.kind)) throw e;
        if (req.signal?.aborted) throw new LlmError('cancelled', 'cancelled');
        if (e instanceof LlmError) lastErr = e;
        else if ((e as Error).name === 'AbortError') lastErr = new LlmError(`DeepSeek request timed out after ${this.cfg.timeoutMs} ms`, 'timeout');
        else lastErr = new LlmError(`Network error contacting DeepSeek: ${(e as Error).message}${(e as { cause?: Error }).cause ? ` (${(e as { cause?: Error }).cause!.message})` : ''}`, 'network');
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }
      if (attempt > this.cfg.maxRetries) break;
      const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (lastErr?.kind === 'rate-limit' ? 2 : 1) + Math.random() * 500;
      await sleep(backoff, req.signal);
    }
    throw lastErr ?? new LlmError('DeepSeek request failed', 'server');
  }
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? (a.costUsd ?? b.costUsd) : a.costUsd + b.costUsd,
  };
}

export const ZERO_USAGE: LlmUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 };
