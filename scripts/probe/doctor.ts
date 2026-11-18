// Environment check: prints what is really installed and usable.
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { espToolchainStatus, ESP_WASM_DIR, wasmVersion } from '@plugai/backend-esp32';
import { avrToolchainStatus, avr8jsVersion } from '@plugai/backend-avr';

const ok = (b: boolean) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m');
const esp = espToolchainStatus();
console.log(`${ok(esp.ok)} ESP-IDF toolchain ${esp.ok ? esp.versions!.map((v) => `${v.name} ${v.version}`).join(' | ') : esp.error}`);
console.log(`${ok(esp.espEmuNative)} esp-emu native (esptool virtual flashing)`);
const wasm = existsSync(resolve(ESP_WASM_DIR, 'esp_emu_bg.wasm'));
console.log(`${ok(wasm)} esp-emu WASM core ${wasm ? wasmVersion() : `missing at ${ESP_WASM_DIR}`}`);
const avr = avrToolchainStatus();
console.log(`${ok(avr.ok)} Arduino toolchain ${avr.ok ? avr.versions!.map((v) => `${v.name} ${v.version}`).join(' | ') : avr.error}`);
console.log(`${ok(true)} avr8js ${avr8jsVersion()}`);
const key = process.env.DEEPSEEK_API_KEY;
const keyOk = !!key && key !== 'your-deepseek-api-key-here';
console.log(`${ok(keyOk)} DeepSeek key ${keyOk ? `configured (${key!.length} chars), model ${process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'}` : 'NOT configured — AI agent disabled (manual mode only)'}`);
if (keyOk && process.argv.includes('--llm')) {
  const { llmHealthCheck } = await import('./llm-health.ts');
  const h: any = await llmHealthCheck();
  console.log(`${ok(!!h.ok)} DeepSeek live check: models=${h.modelsEndpoint} listed=${h.modelListed} structured=${h.structured?.ok} tools=${h.toolCalling?.ok}`);
}
process.exit(esp.ok && wasm && avr.ok ? 0 : 1);
