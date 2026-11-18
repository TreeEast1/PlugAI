// Real DeepSeek connectivity / capability check. Prints only non-sensitive results.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DeepSeekClient, LlmError, type ChatMessage, type ToolDef } from '../../packages/agent/src/deepseek.ts';

export async function llmHealthCheck() {
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  let client: DeepSeekClient;
  try {
    client = DeepSeekClient.fromEnv();
  } catch (e) {
    return { ok: false, error: (e as Error).message, kind: (e as LlmError).kind };
  }
  out.baseUrl = client.cfg.baseUrl;
  out.model = client.cfg.model;
  out.thinking = client.cfg.thinking;
  out.reasoningEffort = client.cfg.reasoningEffort;
  out.keyConfigured = `${client.cfg.apiKey.slice(0, 3)}…(${client.cfg.apiKey.length} chars)`;
  try {
    const models = await fetch(`${client.cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${client.cfg.apiKey}` } });
    const m = await models.json();
    out.modelsEndpoint = models.status;
    out.modelListed = (m.data ?? []).some((x: { id: string }) => x.id === client.cfg.model);
    out.modelName = (m.data ?? []).find((x: { id: string }) => x.id === client.cfg.model)?.name;
  } catch (e) {
    out.modelsEndpoint = `error: ${(e as Error).message}`;
  }
  try {
    const plan = await client.chat({
      messages: [
        { role: 'system', content: 'Reply with a JSON object only.' },
        { role: 'user', content: 'Plan pins for: one LED blinking at 2 Hz on an ESP32-C3. Return {"led_gpio": <int>, "half_period_ms": <int>, "resistor_ohms": <int>}.' },
      ],
      jsonMode: true,
    });
    const parsed = JSON.parse(plan.message.content ?? '{}');
    out.structured = { ok: typeof parsed.led_gpio === 'number' && parsed.half_period_ms === 250, parsed, reasoningChars: plan.message.reasoning_content?.length ?? 0, usage: plan.usage, ms: plan.durationMs, model: plan.model };
  } catch (e) {
    out.structured = { ok: false, error: (e as Error).message };
  }
  try {
    const tools: ToolDef[] = [
      { type: 'function', function: { name: 'measure_period', description: 'Measure the blink period (ms) of a GPIO in the simulator', parameters: { type: 'object', properties: { gpio: { type: 'integer' } }, required: ['gpio'] } } },
    ];
    const messages: ChatMessage[] = [{ role: 'user', content: 'Use the tool to measure GPIO 4, then tell me whether it blinks at 1 Hz. Answer in one sentence.' }];
    const r1 = await client.chat({ messages, tools });
    const call = r1.message.tool_calls?.[0];
    messages.push(r1.message);
    let r2;
    if (call) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ gpio: 4, period_ms: 1000.0, source: 'health-check stub value (not a simulation)' }) });
      r2 = await client.chat({ messages, tools });
    }
    out.toolCalling = { ok: !!call && call.function.name === 'measure_period' && !!r2 && !r2.message.tool_calls, firstCall: call ? { name: call.function.name, args: call.function.arguments } : null, reasoningPassedBack: !!r1.message.reasoning_content, final: r2?.message.content?.slice(0, 200), usage: [r1.usage, r2?.usage] };
  } catch (e) {
    out.toolCalling = { ok: false, error: (e as Error).message };
  }
  out.ok = (out.structured as { ok: boolean }).ok && (out.toolCalling as { ok: boolean }).ok && out.modelListed === true;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await llmHealthCheck();
  const dir = resolve(import.meta.dirname, '../../reports/llm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'health-check.json'), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
}
