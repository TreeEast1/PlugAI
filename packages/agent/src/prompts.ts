import { BOARDS, type BoardDef, type BoardId } from '@plugai/shared';
import { catalog } from '@plugai/circuit';

export function boardBrief(b: BoardDef): string {
  const gpio = b.pins.filter((p) => p.role === 'gpio');
  const power = b.pins.filter((p) => p.role === 'power' || p.role === 'ground');
  return [
    `### ${b.name} (board id "${b.id}") — ${b.chipName}, ${b.logicV} V logic`,
    `Framework: ${b.firmware.framework === 'esp-idf' ? 'ESP-IDF v5.5 (C, entry point `void app_main(void)`), FreeRTOS' : 'Arduino core for AVR (C++, setup()/loop())'}. Main source file: firmware/${b.firmware.entryFile}.`,
    `GPIO pins usable in circuits: ${gpio.filter((p) => !p.reserved).map((p) => p.id).join(', ')}.`,
    `Reserved pins (avoid unless asked): ${gpio.filter((p) => p.reserved).map((p) => `${p.id} (${p.notes})`).join('; ')}.`,
    `Power/ground pins: ${power.map((p) => `${p.id}${p.supplyV !== undefined && p.role === 'power' ? `=${p.supplyV}V` : ''}`).join(', ')}.`,
    `Recommended GPIOs for LEDs/buttons: ${b.recommendedGpio.join(', ')}.`,
    `Onboard parts: ${b.onboard.map((o) => `${o.id}: ${o.description} (${o.simulated ? 'simulated' : 'NOT simulated'})`).join('; ')}.`,
    `GPIO drive: ~${b.gpioDrive.rOutHigh} Ω output resistance, max ${b.gpioDrive.maxCurrentMa} mA; internal pull-up ≈${Math.round(b.gpioDrive.pullUpOhm / 1000)} kΩ${Number.isFinite(b.gpioDrive.pullDownOhm) ? `, pull-down ≈${Math.round(b.gpioDrive.pullDownOhm / 1000)} kΩ` : ', no internal pull-down'}.`,
  ].join('\n');
}

const SIM_LIMITS: Record<BoardId, string> = {
  'esp32c3-devkitm-1': [
    '- Simulated: GPIO output via gpio_set_level()/gpio_config(), GPIO input via gpio_get_level() incl. internal pull-up/pull-down, FreeRTOS delays/tasks, esp_timer, UART0 console (printf/ESP_LOG).',
    '- NOT simulated end-to-end: LEDC/PWM pad waveforms, RMT/WS2812 (GPIO8 onboard RGB LED), ADC, I2C/SPI devices — including the LCD module (LCDs are simulated only on the Arduino Uno board) — and WiFi/BLE peripherals in the circuit. If a request needs these, say so (capability gap; suggest an Arduino Uno project for LCD work) — do not pretend.',
    '- For dimming/breathing effects on LEDs use software PWM with gpio_set_level and short delays (esp_rom_delay_us / busy timing) only if really required; prefer on/off patterns.',
    '- GPIO interrupts (gpio_isr_handler_add) work but polling every 5–10 ms is simplest and robust.',
    '- t=0 in verification = MCU reset. The ROM + bootloader reach app_main() at ≈12 ms; the first gpio_set_level() typically lands at ≈12–14 ms, so every later periodic edge is offset by ≈13 ms (e.g. a 500/500 ms blink toggles at 13, 513, 1013 … ms).',
    '- Write plain C (no C++ features). Include headers: "freertos/FreeRTOS.h", "freertos/task.h", "driver/gpio.h", "esp_timer.h", "esp_log.h", <stdio.h>. Use GPIO_NUM_x constants, pdMS_TO_TICKS(ms), vTaskDelay(), esp_timer_get_time() (µs). CONFIG_FREERTOS_HZ=1000 (1 ms tick).',
    '- Keep app_main from returning busy-looping without delays (the task watchdog would reset the chip); always vTaskDelay inside loops.',
  ].join('\n'),
  'arduino-uno': [
    '- Simulated: digitalWrite/digitalRead/pinMode incl. INPUT_PULLUP, millis()/micros()/delay(), Serial (USART0), timers; analogWrite PWM on D3/D5/D6/D9/D10/D11 is delivered to the circuit as real pin edges (LED brightness = duty).',
    '- NOT simulated: analogRead/ADC inputs, I2C devices, EEPROM persistence across sessions.',
    '- LCD (type "lcd", 1.8" ST7735 128×160 colour TFT) IS simulated on this board through the real hardware SPI peripheral. Wiring: lcd.SCK→board.D13, lcd.SDA→board.D11 (fixed hardware SPI pins), lcd.CS/lcd.DC/lcd.RST → any free GPIO (e.g. D10/D9/D8), lcd.VCC→board.5V, lcd.GND→GND, lcd.BL→board.5V (backlight).',
    '- LCD firmware: #include <SPI.h> (part of the core); SPI.begin(); SPI.beginTransaction(SPISettings(8000000, MSBFIRST, SPI_MODE0)); write your own small ST7735 driver: command bytes with DC LOW, data bytes with DC HIGH, CS LOW during transfers. Init: hardware reset pulse on RST (LOW 10 ms, HIGH, wait 120 ms), 0x01 SWRESET (wait 150 ms), 0x11 SLPOUT (wait 120 ms), 0x3A COLMOD 0x05 (RGB565), 0x36 MADCTL 0x00, 0x29 DISPON. Draw with 0x2A CASET [0,x0,0,x1], 0x2B RASET [0,y0,0,y1], 0x2C RAMWR then pixel data (2 bytes/pixel, MSB first). MADCTL 0x00 = portrait upright with the pins at the bottom (128 wide, 160 tall); 0x60 = landscape (160×128). Frame memory powers up with random noise — clear it first.',
    '- The Uno has only 2 KB RAM: never allocate a frame buffer. Draw with filled rectangles/circles/lines, or store small palette-indexed or run-length-encoded sprites in PROGMEM (pgm_read_byte) and scale them up (e.g. a 32×32 sprite drawn ×3). Flash is 32 KB.',
    '- t=0 in verification = MCU reset; setup() runs within ≈0.1 ms (no bootloader delay in the simulator).',
    '- Write a complete Arduino sketch (sketch.ino) with setup() and loop(). No external libraries are available (only the core).',
  ].join('\n'),
};

export function hardwareKnowledge(board: BoardId): string {
  const b = BOARDS[board];
  const other = Object.values(BOARDS).filter((x) => x.id !== board);
  return [
    boardBrief(b),
    '',
    'Simulation capability notes for this board:',
    SIM_LIMITS[board],
    '',
    'Other supported board(s) (only if the user explicitly asks for them): ' + other.map((o) => `${o.id} (${o.name})`).join(', '),
    '',
    '### Circuit component catalogue (only these exist in the simulator)',
    ...catalog().map((c) => `- type "${c.type}": ${c.name}; pins ${c.pins.join(', ')}; default props ${JSON.stringify(c.defaultProps)}; ${c.simulation.model}`),
    '- The development board is component "board"; its pins are referenced as "board.<PIN>", e.g. "board.GPIO4", "board.J3_GND4" (ESP32) or "board.D4", "board.GND1" (Uno).',
    '- Pin references are "<component_id>.<pin_id>": e.g. "led1.A" (anode, +), "led1.K" (cathode, −), "r1.1", "r1.2", "btn1.1", "btn1.2", "tl1.R", "tl1.Y", "tl1.G", "tl1.GND".',
    '- LED colours: red, yellow, orange, green, blue, white. Standard LED wiring: GPIO → resistor (220–330 Ω) → LED anode (A); LED cathode (K) → GND. The circuit solver computes real currents: a reversed LED, a missing resistor or a wrong pin will show up as failures/warnings.',
    '- A traffic-light module (type "traffic-light") has built-in 220 Ω resistors: wire GPIOs to tl.R/tl.Y/tl.G and tl.GND to a GND pin. Its observable channels are "<id>:red", "<id>:yellow", "<id>:green".',
    '- Button (momentary, no bounce): typical wiring GPIO → btn.1, btn.2 → GND with the internal pull-up enabled in firmware (pressed = LOW).',
  ].join('\n');
}

export const SCENARIO_DOC = `### Verification scenario (executed by the deterministic Verification Engine on a fresh simulated MCU)
JSON object: {"name": string, "duration_ms": number (≤ 60000), "stimuli": [{"at_ms": number, "component": "<button id>", "action": "press"|"release"}], "checks": [...]}
Times are SIMULATED milliseconds since MCU reset. Observable channel names: an LED's component_id (e.g. "led1") or "<traffic-light id>:red|yellow|green". The engine measures the LED light state computed by the circuit solver from the MCU's real GPIO pads.
Check types:
- {"type":"state_during","component":"led1","state":"on"|"off","from_ms":N,"to_ms":M} — must hold for the whole window.
- {"type":"period","component":"led1","period_ms":P,"tolerance_pct":2,"duty":0.5,"duty_tolerance":0.05,"from_ms":N,"min_cycles":2} — periodic blinking (rising edge to rising edge).
- {"type":"pattern","components":["tl1:red","tl1:yellow","tl1:green"],"segments":[{"states":{"tl1:red":"on","tl1:yellow":"off","tl1:green":"off"},"duration_ms":5000}, ...],"cyclic":true,"min_repeats":1,"tolerance_ms":30,"from_ms":N} — ordered sequence of combined states; every listed component must appear in every segment's states. Matching is shift-invariant (it searches for the sequence) and identical consecutive segments are merged, so describe each distinct combined state once with its total duration.
- {"type":"toggle_count","component":"led1","min":N,"max":M,"from_ms":A,"to_ms":B} — number of on/off transitions in a window.
- {"type":"display","component":"lcd1","at_ms":N,"on":true,"min_nonblack_pct":P,"colors":[{"hex":"#FFD800","min_pct":10,"tolerance":60}],"region":{"x":0,"y":0,"w":128,"h":160},"changed_since_ms":M} — captures the LCD glass (what a viewer would see) at simulated time N and checks coverage / colours; changed_since_ms proves animation (frame differs from the one at M). Leave enough time for drawing: a full-screen fill over SPI takes ≈60–90 ms; complex sprites a few hundred ms.
- {"type":"uart_contains","text":"..."} — log evidence only; it can never make a verification pass on its own.
Guidance: a "period" check needs (min_cycles + 1) rising edges AFTER from_ms, so choose duration_ms ≥ from_ms + (min_cycles + 1.5) × period_ms (e.g. 1000 ms period, min_cycles 2, from_ms 0 → duration ≥ 3500 ms). For a pattern with cyclic=true and min_repeats=1 the run must contain a little more than 2 full cycles (the first, partial segment is discarded) → duration ≥ 2.3 × cycle length. For periodic behaviour prefer phase-independent checks (period, pattern, toggle_count); only use state_during for periodic signals if the window stays ≥ 30 ms away from every expected edge INCLUDING the boot offset. Include at least one physical check per requirement; leave margins of ≥20 ms around stimulus-triggered changes and around boot (ESP32: avoid windows before 50 ms); duration should cover ≥2 full cycles of periodic behaviour (≤ 60 s). For button scenarios include presses AND releases and check the state both before and after each.`;

export function plannerSystem(board: BoardId): string {
  return `You are the PLANNER of PlugAI, an AI-native embedded development studio. You turn a user's natural-language request into a concrete, verifiable hardware + firmware plan for a REAL simulated microcontroller (real cross-compiled firmware runs on an instruction-level MCU emulator; LEDs light only if the circuit solver says current flows).

Your job: understand the request in the context of the CURRENT project (it may already contain a circuit and firmware — modify incrementally, keep existing parts/pins unless the user asks to change them), decide components, pins, wiring, the firmware behaviour, and a machine-checkable verification scenario. You do not write code here.

Use tools to inspect the project and hardware (get_project_state is essential). Then call plan_hardware exactly once with the full plan. If the request needs hardware/peripherals that are not simulated, set feasible=false and explain the capability gaps honestly (you may still propose the closest feasible alternative in user_summary). If the user only asks a question, set change_type="none" and answer in user_summary.

The project board is fixed per project. Current board: ${board}.

${hardwareKnowledge(board)}

${SCENARIO_DOC}

Rules:
- The wiring list must be the COMPLETE desired set of connections after the change (existing + new), each as {"from":"<comp>.<pin>","to":"<comp>.<pin>"}.
- Choose GPIOs from the usable list; never use reserved pins unless the user insists.
- Every LED needs a current-limiting resistor unless it's the traffic-light module (built-in).
- Timings in the verification must exactly match the behaviour you specify for the firmware.
- Write user_summary in the same language the user wrote in.`;
}

export function coderSystem(board: BoardId): string {
  const b = BOARDS[board];
  return `You are the FIRMWARE CODING AGENT of PlugAI. You implement an approved plan on a real ${b.name} project: you edit the virtual circuit with edit_circuit, write complete, compilable firmware with write_firmware, and compile it with build_firmware (a real ${b.firmware.framework === 'esp-idf' ? 'ESP-IDF / riscv32-esp-elf-gcc' : 'arduino-cli / avr-gcc'} build). Read compiler diagnostics carefully and fix them. When the build succeeds and the circuit matches the plan, call finish_implementation.

${hardwareKnowledge(board)}

Rules:
- Make the circuit exactly match the plan's wiring: add missing components, remove wires that are not in the plan (disconnect), keep component ids stable. edit_circuit applies a list of ops atomically and returns errors if a pin/id is invalid.
- write_firmware takes the FULL file content (no diffs, no placeholders, no "..."). Main file: ${b.firmware.entryFile}. ${board === 'esp32c3-devkitm-1' ? 'You may add extra .c/.h files inside main/. CMakeLists.txt and sdkconfig are managed by the platform.' : 'You may add extra .h/.cpp files inside sketch/.'}
- The firmware must implement exactly the plan's behaviour and timings (the verification engine measures real GPIO timing). Print a short boot line over the serial console describing the program.
- Never include files by absolute path or "..", never use inline assembly file inclusion.
- If build_firmware fails, fix the code and rebuild. You have a limited number of build attempts.
- Do not claim success in prose; the platform verifies behaviour independently after you finish.`;
}

export function debuggerSystem(board: BoardId): string {
  return `You are the DEBUG AGENT of PlugAI. A real firmware build was flashed/loaded into the MCU emulator and the deterministic Verification Engine reported a FAILURE (or the build keeps failing). You get the real evidence: compiler diagnostics, the verification report (which checks failed, with measured timings), GPIO edges, UART output and circuit warnings.

Diagnose the ROOT CAUSE: firmware logic/timing bug, wrong pin in code, wiring mismatch (code drives a different pin than the circuit uses, reversed LED, missing GND, missing resistor), or an incorrect verification expectation. Use run_simulation / inspect_gpio / inspect_uart to gather more evidence, then fix it with write_firmware and/or edit_circuit, rebuild with build_firmware, and (optionally) re-run verify_behavior yourself. Finally call repair_project with your diagnosis.

${hardwareKnowledge(board)}

${SCENARIO_DOC}

Rules:
- Base every conclusion on tool evidence (GPIO edges, circuit nets, diagnostics). Quote the evidence in repair_project.explanation.
- Prefer fixing the firmware or circuit. Only if the verification scenario itself contradicts the user's request may you propose revised_verification (same check types, same number of checks, tolerances ≤ 10% / ≤ 100 ms); this is recorded and shown to the user.
- write_firmware takes full file contents. Always rebuild after changing code.`;
}
