// SDK reference for the agent: extracted from the locally installed SDK headers.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getBoard, type BoardId } from '@plugai/shared';
import { locateEspToolchain } from '@plugai/backend-esp32';

function prototypes(src: string, filter: RegExp, maxLines = 220): string {
  // keep doc-comment summaries (@brief) + declarations / macros matching the filter
  const lines = src.split('\n');
  const out: string[] = [];
  let brief = '';
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const l = lines[i];
    const b = l.match(/@brief\s+(.*)/);
    if (b) brief = b[1].trim();
    if (filter.test(l) && !/^\s*\*/.test(l)) {
      let decl = l.trim();
      let j = i;
      while (!/[;{)]\s*$/.test(decl) && j < i + 6 && !decl.startsWith('#define')) decl += ' ' + (lines[++j] ?? '').trim();
      out.push((brief ? `// ${brief}\n` : '') + decl);
      brief = '';
    }
  }
  return out.join('\n');
}

const ESP_TOPICS: Record<string, { file: string; filter: RegExp }[]> = {
  gpio: [
    { file: 'components/esp_driver_gpio/include/driver/gpio.h', filter: /^\s*esp_err_t gpio_|^\s*int gpio_get_level|^\s*void gpio_/ },
    { file: 'components/hal/include/hal/gpio_types.h', filter: /GPIO_MODE_|GPIO_PULLUP_|GPIO_PULLDOWN_|GPIO_INTR_|} gpio_|typedef enum/ },
  ],
  freertos: [
    { file: 'components/freertos/FreeRTOS-Kernel/include/freertos/task.h', filter: /^\s*(void|BaseType_t|TickType_t|TaskHandle_t|UBaseType_t)\s+(vTaskDelay|vTaskDelayUntil|xTaskCreate|xTaskGetTickCount|vTaskDelete|xTaskDelayUntil)\b/ },
    { file: 'components/freertos/FreeRTOS-Kernel/include/freertos/projdefs.h', filter: /#define pdMS_TO_TICKS|#define pdTICKS_TO_MS/ },
  ],
  esp_timer: [{ file: 'components/esp_timer/include/esp_timer.h', filter: /^\s*(int64_t|esp_err_t|uint64_t)\s+esp_timer_/ }],
  log: [{ file: 'components/log/include/esp_log.h', filter: /#define ESP_LOG[EWIDV]\(/ }],
  rom_delay: [{ file: 'components/esp_rom/include/esp_rom_sys.h', filter: /esp_rom_delay_us|esp_rom_printf/ }],
};

export async function readSdkReference(board: BoardId, topicRaw: string): Promise<string> {
  const topic = topicRaw.toLowerCase().replace(/[^a-z_]/g, '');
  if (board === 'esp32c3-devkitm-1') {
    const tc = locateEspToolchain();
    const spec = ESP_TOPICS[topic];
    if (!spec) return `Unknown topic "${topicRaw}". Available: ${Object.keys(ESP_TOPICS).join(', ')}`;
    const parts: string[] = [`// Extracted from ESP-IDF ${tc.versions.find((v) => v.name === 'ESP-IDF')?.version} headers`];
    for (const s of spec) {
      const p = join(tc.idfPath, s.file);
      if (!existsSync(p)) continue;
      parts.push(`// ---- ${s.file}\n${prototypes(readFileSync(p, 'utf8'), s.filter)}`);
    }
    return parts.join('\n\n');
  }
  if (topic === 'pins') {
    const b = getBoard(board);
    return b.pins.map((p) => `${p.id}: ${p.role}${p.port ? ` PORT${p.port.name}${p.port.bit}` : ''}${p.notes ? ` — ${p.notes}` : ''}`).join('\n');
  }
  if (topic === 'arduino') {
    const base = join(homedir(), 'Library/Arduino15/packages/arduino/hardware/avr');
    const ver = existsSync(base) ? readdirSync(base).sort().pop() : undefined;
    const p = ver ? join(base, ver, 'cores/arduino/Arduino.h') : '';
    if (!p || !existsSync(p)) return 'Arduino core headers not found';
    return `// Extracted from arduino:avr ${ver} cores/arduino/Arduino.h\n` + prototypes(readFileSync(p, 'utf8'), /^\s*(void|int|unsigned long|long|uint8_t|bool)\s+(pinMode|digitalWrite|digitalRead|analogWrite|analogRead|millis|micros|delay|delayMicroseconds|attachInterrupt|detachInterrupt|tone|noTone|pulseIn)\b|#define (HIGH|LOW|INPUT|OUTPUT|INPUT_PULLUP|CHANGE|FALLING|RISING)\b/);
  }
  return `Unknown topic "${topicRaw}". Available: arduino, pins`;
}
