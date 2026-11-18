# PlugAI end-to-end acceptance (HTTP + WebSocket, real toolchains, real DeepSeek)

Generated: 2026-10-13T11:06:53.629Z

LED periods in this report are measured from the same live WebSocket frames the browser renders, using simulated-time timestamps.

| ID | Test | Board | Status | Time |
|---|---|---|---|---|
| E2E-1 | “帮我创建一个 ESP32 的 LED 闪烁项目，每隔一秒闪一次。” → AI plans, wires, codes, compiles, flashes, verifies; live UI feed blinks at 1 s |  | **PASS** | 143.0 s |
| E2E-2 | “现在改成每 200 毫秒闪一次。” → same project re-compiled, new firmware hash, live period changes |  | **PASS** | 35.6 s |
| E2E-3 | “把 LED 接到没有产生闪烁信号的 GPIO 上。” → LED no longer follows the program (independent check) |  | **PASS** | 103.8 s |
| E2E-4 | Repair the wiring → behaviour restored and verified |  | **PASS** | 38.6 s |
| T9-a | Anti-cheat: edit source outside the agent → rebuild → UI feed follows the new firmware |  | **PASS** | 14.6 s |
| T9-b | Static anti-cheat scan: renderers have no timers/animations; no mock success paths; UART-only checks cannot pass |  | **PASS** | 2.1 s |
| T10 | Demo "blink" creates, builds, flashes and verifies | esp32c3-devkitm-1 | **PASS** | 18.7 s |
| T10 | Demo "button-led" creates, builds, flashes and verifies | esp32c3-devkitm-1 | **PASS** | 18.9 s |
| T10 | Demo "traffic-light" creates, builds, flashes and verifies | esp32c3-devkitm-1 | **PASS** | 19.5 s |
| T10 | Demo "blink" creates, builds, flashes and verifies | arduino-uno | **PASS** | 2.4 s |
| T10 | Demo "button-led" creates, builds, flashes and verifies | arduino-uno | **PASS** | 2.3 s |
| T10 | Demo "traffic-light" creates, builds, flashes and verifies | arduino-uno | **PASS** | 6.4 s |
| T10-mod-restore | Modify → rebuild → restore previous version from history → original behaviour back |  | **PASS** | 9.8 s |
| T10-stop-restart | Simulator stop / restart and project isolation (two boards running different firmware concurrently) |  | **PASS** | 5.8 s |

## E2E-1 — “帮我创建一个 ESP32 的 LED 闪烁项目，每隔一秒闪一次。” → AI plans, wires, codes, compiles, flashes, verifies; live UI feed blinks at 1 s: PASS

- run run_20261013105952_bbbdc5: success in 139 s; 9 DeepSeek calls (deepseek-flash), 12 tool calls, 1 repair round(s), tokens in/out 76476/12609, cost $0.0099
- plan: 用户要求：在 ESP32-C3-DevKitM-1 上新建一个 LED 闪烁项目，每隔一秒闪一次。理解为：一颗外接红色 LED 串限流电阻由 GPIO 驱动，固件输出 1 s 周期方波 —— 亮 500 ms、灭 500 ms（上升沿间隔 1000 ms，占空比 50%）。项目当前为空模板（无任何元件、无逻辑），故为全新搭建。
- pins: GPIO4=LED_BLINK; J3_GND4=GND
- verification spec: period, state_during, state_during, state_during, state_during, state_during, state_during, toggle_count, uart_contains over 5000 ms
-   ✓ led1: 4 periods, mean 1000 ms (expected 1000 ms ±2%), max deviation 0 ms, duty 50.0% (expected 50% ±5%)
-   ✓ led1 stayed on from 150 to 450 ms
-   ✓ led1 stayed off from 620 to 950 ms
-   ✓ led1 stayed on from 1180 to 1460 ms
-   ✓ led1 stayed off from 1620 to 1950 ms
-   ✓ led1 stayed on from 2180 to 2450 ms
-   ✓ led1 stayed off from 2680 to 2950 ms
-   ✓ led1 toggled 7 time(s) in 50–3950 ms (expected 6–8)
-   ✓ UART output contains "LED blink" (log evidence only — not a physical signal)
- builds: success
- tool chain: p:get_project_state → p:list_supported_hardware → p:plan_hardware → p:plan_hardware → c:edit_circuit → c:write_firmware → c:build_firmware → c:finish_implementation → e:flash_virtual_device → e:verify_behavior → d:inspect_gpio → d:inspect_uart → d:run_simulation → d:repair_project → e:flash_virtual_device → e:verify_behavior
- circuit: LED led1 driven by GPIO4; build b_20261013110018_a6c3, ELF da3cef70f3cbb090; flashed via esptool-virtual-uart
- live WebSocket feed (what the UI renders): 112 frames, 9 LED transitions, measured period 1000.00 ms (simulated time)

Evidence: `reports/e2e/2026-10-13T10-59-48-894Z/e2e-1-live.json`

## E2E-2 — “现在改成每 200 毫秒闪一次。” → same project re-compiled, new firmware hash, live period changes: PASS

- run run_20261013110215_287469: success in 33 s; 4 DeepSeek calls (deepseek-flash), 4 tool calls, 0 repair round(s), tokens in/out 22995/3793, cost $0.0030
- plan: 用户要求把现有 ESP32-C3 的 LED 闪烁从「1 秒一次」改成「每 200 毫秒闪一次」。沿用上一轮的解读口径（周期 = 闪烁间隔）：周期 200 ms，即亮 100 ms、灭 100 ms，占空比 50%。硬件（GPIO4 → 220 Ω → 红色 LED → GND）保持不变，只改固件延时与验证时序。
- pins: GPIO4=LED_BLINK
- verification spec: period, state_during, state_during, state_during, state_during, state_during, toggle_count, uart_contains over 3000 ms
-   ✓ led1: 14 periods, mean 200 ms (expected 200 ms ±2%), max deviation 0 ms, duty 50.0% (expected 50% ±5%)
-   ✓ led1 stayed on from 243 to 283 ms
-   ✓ led1 stayed off from 343 to 383 ms
-   ✓ led1 stayed on from 443 to 483 ms
-   ✓ led1 stayed off from 543 to 583 ms
-   ✓ led1 stayed on from 1243 to 1283 ms
-   ✓ led1 toggled 29 time(s) in 50–2950 ms (expected 26–32)
-   ✓ UART output contains "200 ms period" (log evidence only — not a physical signal)
- builds: success
- tool chain: p:plan_hardware → c:write_firmware → c:build_firmware → c:finish_implementation → e:flash_virtual_device → e:verify_behavior
- build b_20261013110018_a6c3 → b_20261013110233_2265; ELF da3cef70f3cb → 6f8770c9ccb6; live period 200.00 ms

Evidence: `reports/e2e/2026-10-13T10-59-48-894Z/e2e-2-live.json`

## E2E-3 — “把 LED 接到没有产生闪烁信号的 GPIO 上。” → LED no longer follows the program (independent check): PASS

- run run_20261013110250_02577d: success in 102 s; 4 DeepSeek calls (deepseek-flash), 5 tool calls, 0 repair round(s), tokens in/out 24581/13948, cost $0.0091
- plan: 用户要求：把 LED 接到一个“没有产生闪烁信号的 GPIO”上。当前项目里 200 ms 闪烁信号由 GPIO4 产生，led1+r1(220Ω) 接在 GPIO4 上。按字面理解 = 保留 GPIO4 上的 200 ms 闪烁信号不变（100 ms 亮 / 100 ms 灭，即 200 ms 周期），但把 led1 连同限流电阻 r1 从 GPIO4 改接到另一个 GPIO（GPIO5）；GPIO5 上不产生任何闪烁信号，固件把它恒定置高（只有直流电平、没有边沿）→ led1 全程长亮、完全不闪。注意点：① 这是“LED 不再闪烁、改为常亮”的效果；② 闪烁信号仍然存在于 GPIO4，只是
- pins: GPIO5=led1 静态驱动（无闪烁信号）; GPIO4=原有 200 ms 闪烁信号（led1 已不再接这里）; J3_GND4=GND 回路
- verification spec: state_during, toggle_count, uart_contains over 3000 ms
-   ✓ led1 stayed on from 100 to 2900 ms
-   ✓ led1 toggled 0 time(s) in 50–2950 ms (expected 0–0)
-   ✓ UART output contains "no blink signal" (log evidence only — not a physical signal)
- builds: success
- tool chain: p:plan_hardware → c:edit_circuit → c:write_firmware → c:build_firmware → c:finish_implementation → e:flash_virtual_device → e:verify_behavior
- LED led1 now wired to GPIO5 (firmware still toggles GPIO4)
- independent verification "LED still blinks": FAILED as expected — led1 toggled 0 time(s) in 100–3000 ms (expected 2+)
- the firmware keeps toggling GPIO4: 31 edges in 3 s — the circuit, not the UI, decides the LED is dark
- live feed: 0 LED transitions in 1.5 s



## E2E-4 — Repair the wiring → behaviour restored and verified: PASS

- run run_20261013110434_b45a8d: success in 36 s; 5 DeepSeek calls (deepseek-flash), 7 tool calls, 0 repair round(s), tokens in/out 35633/4120, cost $0.0038
- plan: 用户要求把 LED 的连线“修复”，让它重新按照程序以 200 ms（亮 100 ms / 灭 100 ms，占空比 50%）闪烁。当前问题：led1+r1 被接在 GPIO5 上，而 GPIO5 在固件里被恒定置高（无任何边沿），所以 led1 一直常亮、不闪（上一次验证因此 FAIL）。修复方案：把 r1.1 从 board.GPIO5 改回接 board.GPIO4（这条线上才有 200 ms 闪烁信号），led1.K 仍接 GND(J3_GND4)；同时清理固件，去掉 GPIO5 的恒定高电平分支，只保留 GPIO4 的 100 ms 亮 / 100 ms 灭循环。硬件元件不变（led
- pins: GPIO4=LED_BLINK (led1 驱动，200 ms 周期：亮 100 ms / 灭 100 ms); J3_GND4=GND (led1 阴极回路)
- verification spec: period, state_during, state_during, state_during, state_during, state_during, toggle_count, uart_contains over 3000 ms
-   ✓ led1: 14 periods, mean 200 ms (expected 200 ms ±2%), max deviation 0 ms, duty 50.0% (expected 50% ±5%)
-   ✓ led1 stayed on from 243 to 283 ms
-   ✓ led1 stayed off from 343 to 383 ms
-   ✓ led1 stayed on from 443 to 483 ms
-   ✓ led1 stayed off from 543 to 583 ms
-   ✓ led1 stayed on from 643 to 683 ms
-   ✓ led1 toggled 29 time(s) in 50–2950 ms (expected 26–32)
-   ✓ UART output contains "PlugAI LED blink" (log evidence only — not a physical signal)
- builds: success
- tool chain: p:get_project_state → p:list_supported_hardware → p:plan_hardware → c:edit_circuit → c:write_firmware → c:build_firmware → c:finish_implementation → e:flash_virtual_device → e:verify_behavior
- LED wired to GPIO4; live period 200.00 ms



## T9-a — Anti-cheat: edit source outside the agent → rebuild → UI feed follows the new firmware: PASS

- external edit → build success (b_20261013110513_26c6) → flash success (esptool-virtual-uart) → live LED period 600.23 ms (expected 600)
- UART: T9 external firmware: 300 ms on / 300 ms off on GPIO4
- agent runs involved: none (project has 4 earlier runs; no new run started)



## T9-b — Static anti-cheat scan: renderers have no timers/animations; no mock success paths; UART-only checks cannot pass: PASS

- renderer files scanned for timers/animations/chat access; 1 CSS keyframes (spin)
- UART-only scenario: text found=true, verification passed=false (No physical (GPIO/circuit) check in scenario — UART-only checks cannot pass verification.)
- verify with stale build after a source edit: HTTP 200 (sources changed but flashed build unchanged — engine verifies what is actually flashed: 9bd27f79555c)



## T10 — Demo "blink" creates, builds, flashes and verifies (esp32c3-devkitm-1): PASS

- build success 11.4 s; esptool-virtual-uart success; verification PASS: led1: 3 periods, mean 1000 ms (expected 1000 ms ±1%), max deviation 0 ms, duty 50.0% (expected 50% ±3%)



## T10 — Demo "button-led" creates, builds, flashes and verifies (esp32c3-devkitm-1): PASS

- build success 11.4 s; esptool-virtual-uart success; verification PASS: led1 stayed off from 100 to 790 ms | led1 stayed on from 830 to 1790 ms | led1 stayed off from 1830 to 3000 ms



## T10 — Demo "traffic-light" creates, builds, flashes and verifies (esp32c3-devkitm-1): PASS

- build success 11.7 s; esptool-virtual-uart success; verification PASS: Pattern over (tl1:red, tl1:yellow, tl1:green) matched 3 consecutive segment(s) (needed 3); first match at 12.13 ms



## T10 — Demo "blink" creates, builds, flashes and verifies (arduino-uno): PASS

- build success 1.5 s; direct-image-load success; verification PASS: led1: 3 periods, mean 1000.02 ms (expected 1000 ms ±1%), max deviation 0.02 ms, duty 50.0% (expected 50% ±3%)



## T10 — Demo "button-led" creates, builds, flashes and verifies (arduino-uno): PASS

- build success 1.5 s; direct-image-load success; verification PASS: led1 stayed off from 100 to 790 ms | led1 stayed on from 830 to 1790 ms | led1 stayed off from 1830 to 3000 ms



## T10 — Demo "traffic-light" creates, builds, flashes and verifies (arduino-uno): PASS

- build success 1.5 s; direct-image-load success; verification PASS: Pattern over (tl1:red, tl1:yellow, tl1:green) matched 3 consecutive segment(s) (needed 3); first match at 0.14 ms [glitch filter 1 ms: 6 sub-ms transient(s) ignored]



## T10-mod-restore — Modify → rebuild → restore previous version from history → original behaviour back: PASS

- modified: led1: 5 periods, mean 250 ms (expected 250 ms ±1%), max deviation 0 ms
- restored to d499aae9 (source identical: true): led1: 3 periods, mean 1000 ms (expected 1000 ms ±1%), max deviation 0 ms, duty 50.0% (expected 50% ±3%)



## T10-stop-restart — Simulator stop / restart and project isolation (two boards running different firmware concurrently): PASS

- concurrent: ESP32 project period 1000.0 ms, Uno project period 300.0 ms
- after stop: stopped; after start: running, simulated 1497 ms (fresh power-on)


