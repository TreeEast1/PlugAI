# PlugAI test summary

Generated 2026-10-13T11:10:01.959Z

## P0 — real firmware ↔ MCU emulation ↔ circuit (Tests 1–6, 8)

14/14 PASS — full report: `reports/p0/2026-10-13T11-07-47-112Z/REPORT.md`

| ID | Test | Board | Status |
|---|---|---|---|
| T1 | Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture) | esp32c3-devkitm-1 | **PASS** |
| T2 | MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU) | esp32c3-devkitm-1 | **PASS** |
| T3 | GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit | esp32c3-devkitm-1 | **PASS** |
| T4 | Circuit truthfulness: same running firmware, different wiring | esp32c3-devkitm-1 | **PASS** |
| T5 | Interactive closed loop: button → input pad → firmware → output pad → LED | esp32c3-devkitm-1 | **PASS** |
| T6 | Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps | esp32c3-devkitm-1 | **PASS** |
| T1 | Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture) | arduino-uno | **PASS** |
| T2 | MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU) | arduino-uno | **PASS** |
| T3 | GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit | arduino-uno | **PASS** |
| T4 | Circuit truthfulness: same running firmware, different wiring | arduino-uno | **PASS** |
| T5 | Interactive closed loop: button → input pad → firmware → output pad → LED | arduino-uno | **PASS** |
| T6 | Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps | arduino-uno | **PASS** |
| T8 | Virtual UART flashing (esptool ROM protocol → emulated SPI flash → boot from written flash) | esp32c3-devkitm-1 | **PASS** |
| T11 | LCD over real SPI: firmware SPI bytes → ST7735 model → captured frame; miswired bus shows nothing | arduino-uno | **PASS** |

## DeepSeek agent (LLM-Test-01…07, Tests A–E, capability boundary)

13/13 PASS — full report: `reports/llm/2026-10-13T10-59-48-778Z/REPORT.md`

| ID | Test | Board | Status |
|---|---|---|---|
| LLM-01 | Real DeepSeek API connection, auth, model, structured output and tool calling |  | **PASS** |
| LLM-02 | Dynamic planning for a non-template requirement (Test A: SOS light) |  | **PASS** |
| LLM-03 | Firmware source comes from the model response and is written to the real project |  | **PASS** |
| LLM-04 | Tool-calling chain: model requests tools, gets real results, decides next step |  | **PASS** |
| LLM-05 / T7 | Real compile error → DeepSeek reads diagnostics → fixes → rebuild → re-verify |  | **PASS** |
| TEST-B | Conditional interaction: button press swaps two LEDs (edge detection + state) |  | **PASS** |
| TEST-C | Incremental iteration on the same project: "hold > 2 s to switch" |  | **PASS** |
| TEST-D | Fault analysis: firmware pin ≠ circuit wiring → agent uses GPIO/circuit evidence → fix → re-verify |  | **PASS** |
| TEST-E | New, unscripted task (heartbeat pattern, green LED) |  | **PASS** |
| TEST-CAP | Capability boundary: unsupported peripheral (OLED) is reported honestly, nothing is faked |  | **PASS** |
| LLM-06 | Anti-rule test: 3 different requests on the same hardware → different plans, code and behaviour |  | **PASS** |
| LLM-UNO | Same agent on the Arduino Uno backend (arduino-cli + avr8js) |  | **PASS** |
| LLM-07 | AI service failure: invalid key / unreachable API / missing key → explicit failure, no template fallback |  | **PASS** |

## End-to-end §15 flow, Test 9 anti-cheat, Test 10 regression

14/14 PASS — full report: `reports/e2e/2026-10-13T10-59-48-894Z/REPORT.md`

| ID | Test | Board | Status |
|---|---|---|---|
| E2E-1 | “帮我创建一个 ESP32 的 LED 闪烁项目，每隔一秒闪一次。” → AI plans, wires, codes, compiles, flashes, verifies; live UI feed blinks at 1 s |  | **PASS** |
| E2E-2 | “现在改成每 200 毫秒闪一次。” → same project re-compiled, new firmware hash, live period changes |  | **PASS** |
| E2E-3 | “把 LED 接到没有产生闪烁信号的 GPIO 上。” → LED no longer follows the program (independent check) |  | **PASS** |
| E2E-4 | Repair the wiring → behaviour restored and verified |  | **PASS** |
| T9-a | Anti-cheat: edit source outside the agent → rebuild → UI feed follows the new firmware |  | **PASS** |
| T9-b | Static anti-cheat scan: renderers have no timers/animations; no mock success paths; UART-only checks cannot pass |  | **PASS** |
| T10 | Demo "blink" creates, builds, flashes and verifies | esp32c3-devkitm-1 | **PASS** |
| T10 | Demo "button-led" creates, builds, flashes and verifies | esp32c3-devkitm-1 | **PASS** |
| T10 | Demo "traffic-light" creates, builds, flashes and verifies | esp32c3-devkitm-1 | **PASS** |
| T10 | Demo "blink" creates, builds, flashes and verifies | arduino-uno | **PASS** |
| T10 | Demo "button-led" creates, builds, flashes and verifies | arduino-uno | **PASS** |
| T10 | Demo "traffic-light" creates, builds, flashes and verifies | arduino-uno | **PASS** |
| T10-mod-restore | Modify → rebuild → restore previous version from history → original behaviour back |  | **PASS** |
| T10-stop-restart | Simulator stop / restart and project isolation (two boards running different firmware concurrently) |  | **PASS** |
