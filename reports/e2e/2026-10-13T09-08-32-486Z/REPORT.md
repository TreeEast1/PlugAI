# PlugAI end-to-end acceptance (HTTP + WebSocket, real toolchains, real DeepSeek)

Generated: 2026-10-13T09:13:52.869Z

LED periods in this report are measured from the same live WebSocket frames the browser renders, using simulated-time timestamps.

| ID | Test | Board | Status | Time |
|---|---|---|---|---|
| E2E-1 | “帮我创建一个 ESP32 的 LED 闪烁项目，每隔一秒闪一次。” → AI plans, wires, codes, compiles, flashes, verifies; live UI feed blinks at 1 s |  | **PASS** | 73.7 s |
| E2E-2 | “现在改成每 200 毫秒闪一次。” → same project re-compiled, new firmware hash, live period changes |  | **PASS** | 47.6 s |
| E2E-3 | “把 LED 接到没有产生闪烁信号的 GPIO 上。” → LED no longer follows the program (independent check) |  | **PASS** | 61.8 s |
| E2E-4 | Repair the wiring → behaviour restored and verified |  | **PASS** | 41.6 s |
| T9-a | Anti-cheat: edit source outside the agent → rebuild → UI feed follows the new firmware |  | **PASS** | 13.9 s |
| T9-b | Static anti-cheat scan: renderers have no timers/animations; no mock success paths; UART-only checks cannot pass |  | **PASS** | 1.9 s |
| T10 | Demo "blink" creates, builds, flashes and verifies | esp32c3-devkitm-1 | **PASS** | 17.9 s |
| T10 | Demo "button-led" creates, builds, flashes and verifies | esp32c3-devkitm-1 | **PASS** | 18.1 s |
| T10 | Demo "traffic-light" creates, builds, flashes and verifies | esp32c3-devkitm-1 | **PASS** | 18.4 s |
| T10 | Demo "blink" creates, builds, flashes and verifies | arduino-uno | **PASS** | 2.2 s |
| T10 | Demo "button-led" creates, builds, flashes and verifies | arduino-uno | **PASS** | 2.2 s |
| T10 | Demo "traffic-light" creates, builds, flashes and verifies | arduino-uno | **PASS** | 6.0 s |
| T10-mod-restore | Modify → rebuild → restore previous version from history → original behaviour back |  | **PASS** | 9.1 s |
| T10-stop-restart | Simulator stop / restart and project isolation (two boards running different firmware concurrently) |  | **PASS** | 5.8 s |

## E2E-1 — “帮我创建一个 ESP32 的 LED 闪烁项目，每隔一秒闪一次。” → AI plans, wires, codes, compiles, flashes, verifies; live UI feed blinks at 1 s: PASS

- run run_20261013090832_8413ac: success in 70 s; 6 DeepSeek calls (deepseek-flash), 8 tool calls, 0 repair round(s), tokens in/out 33985/3452, cost $0.0079
- plan: 用户要求在 ESP32-C3-DevKitM-1 上新建一个 LED 闪烁项目：LED 每隔 1 秒闪一次，即经典的 500 ms 亮 / 500 ms 灭（周期 1000 ms，占空比 50%）。项目目前是空的（只有 starter 固件，无任何元器件），所以这是一次全新搭建：添加一颗红色 5mm LED + 220 Ω 限流电阻接在 GPIO4，阴极接 GND，固件用 vTaskDelay(pdMS_TO_TICKS(500)) 交替翻转 GPIO4 电平，并在串口打印状态。
- pins: GPIO4=LED1_BLINK; J1_GND4=GND
- verification spec: period, state_during, state_during, toggle_count, uart_contains over 5000 ms
-   ✓ led1: 3 periods, mean 1000 ms (expected 1000 ms ±2%), max deviation 0 ms, duty 50.0% (expected 50% ±5%)
-   ✓ led1 stayed on from 150 to 480 ms
-   ✓ led1 stayed off from 550 to 980 ms
-   ✓ led1 toggled 9 time(s) in 50–4900 ms (expected 8–12)
-   ✓ UART output contains "LED ON" (log evidence only — not a physical signal)
- builds: success
- tool chain: p:get_project_state → p:list_supported_hardware → p:inspect_environment → p:plan_hardware → c:edit_circuit → c:write_firmware → c:build_firmware → c:finish_implementation → e:flash_virtual_device → e:verify_behavior
- circuit: LED led1 driven by GPIO4; build b_20261013090851_3063, ELF 752de22edec876b2; flashed via esptool-virtual-uart
- live WebSocket feed (what the UI renders): 117 frames, 8 LED transitions, measured period 1000.00 ms (simulated time)

Evidence: `reports/e2e/2026-10-13T09-08-32-486Z/e2e-1-live.json`

## E2E-2 — “现在改成每 200 毫秒闪一次。” → same project re-compiled, new firmware hash, live period changes: PASS

- run run_20261013090946_3a2bf6: success in 45 s; 6 DeepSeek calls (deepseek-flash), 7 tool calls, 0 repair round(s), tokens in/out 38643/5614, cost $0.0091
- plan: 在现有 ESP32-C3-DevKitM-1 项目上把 LED 闪烁速度从 1 Hz 改为 200 ms 一个完整周期：与之前「每隔一秒闪一次 = 周期 1000 ms（500 ms 亮 / 500 ms 灭）」的换算保持一致，本次解释为「每 200 ms 闪一次 = 周期 200 ms，即 100 ms 亮 + 100 ms 灭，占空比 50%」。硬件（led1 红色 LED + r1 220 Ω 限流电阻，GPIO4 → r1 → LED 阳极 A，阴极 K → J1_GND4，回路电流约 6 mA）保持不变；只改固件中的 ON_MS/OFF_MS 常量与注释，并在每次翻转时打印日志。仿真
- pins: GPIO4=LED_BLINK (led1 anode drive)
- verification spec: period, state_during, state_during, toggle_count, uart_contains over 3000 ms
-   ✓ led1: 14 periods, mean 199.99 ms (expected 200 ms ±2%), max deviation 0.12 ms, duty 50.0% (expected 50% ±5%)
-   ✓ led1 stayed on from 45 to 85 ms
-   ✓ led1 stayed off from 145 to 185 ms
-   ✓ led1 toggled 29 time(s) in 50–2950 ms (expected 26–32)
-   ✓ UART output contains "LED ON" (log evidence only — not a physical signal)
- builds: success
- tool chain: p:get_project_state → p:inspect_environment → p:plan_hardware → c:edit_circuit → c:write_firmware → c:build_firmware → c:finish_implementation → e:flash_virtual_device → e:verify_behavior
- build b_20261013090851_3063 → b_20261013091016_a439; ELF 752de22edec8 → 7f709d0fcc41; live period 200.00 ms

Evidence: `reports/e2e/2026-10-13T09-08-32-486Z/e2e-2-live.json`

## E2E-3 — “把 LED 接到没有产生闪烁信号的 GPIO 上。” → LED no longer follows the program (independent check): PASS

- run run_20261013091033_758a31: success in 60 s; 5 DeepSeek calls (deepseek-flash), 7 tool calls, 0 repair round(s), tokens in/out 37814/7817, cost $0.0121
- plan: 用户当前项目：ESP32-C3-DevKitM-1，外接红色 LED(led1) + 220 Ω(r1) 接在 GPIO4 上，固件在 GPIO4 输出 100 ms 亮 / 100 ms 灭（周期 200 ms，占空比 50%）的闪烁信号，验证已通过。\n\n本次要求：“把 LED 接到没有产生闪烁信号的 GPIO 上” —— 即把 led1/r1 从正在闪烁的 GPIO4 挪到另一个不产生闪烁信号的 GPIO。做法：改接 w1 为 GPIO5（保留限流电阻与阴极接地的拓扑），闪烁程序仍留在 GPIO4 不变（100 ms/100 ms，周期 200 ms），GPIO5 仅配置为输出并恒定拉
- pins: GPIO4=LED_BLINK（200 ms 周期闪烁，本次不再接负载）; GPIO5=led1 阳极驱动（恒定低电平，无闪烁）; J1_GND4=GND 回路
- verification spec: state_during, toggle_count, uart_contains over 3000 ms
-   ✓ led1 stayed off from 50 to 2950 ms
-   ✓ led1 toggled 0 time(s) in 50–2950 ms (expected 0–0)
-   ✓ UART output contains "LED ON" (log evidence only — not a physical signal)
- builds: success
- tool chain: p:get_project_state → p:list_supported_hardware → p:plan_hardware → c:edit_circuit → c:write_firmware → c:build_firmware → c:finish_implementation → e:flash_virtual_device → e:verify_behavior
- LED led1 now wired to GPIO5 (firmware still toggles GPIO4)
- independent verification "LED still blinks": FAILED as expected — led1 toggled 0 time(s) in 100–3000 ms (expected 2+)
- the firmware keeps toggling GPIO4: 31 edges in 3 s — the circuit, not the UI, decides the LED is dark
- live feed: 0 LED transitions in 1.5 s



## E2E-4 — Repair the wiring → behaviour restored and verified: PASS

- run run_20261013091135_925f6f: success in 39 s; 5 DeepSeek calls (deepseek-flash), 6 tool calls, 0 repair round(s), tokens in/out 33234/4417, cost $0.0074
- plan: 用户要求"修复 LED 的连线"，让外接 LED（led1）重新按程序闪烁。当前问题：固件在 GPIO4 上以 5 Hz 闪烁（100 ms 亮 / 100 ms 灭，周期 200 ms，占空比 50%），但 LED 的限流电阻接在 GPIO5 上，而 GPIO5 被固件恒定拉低，所以 led1 全程不亮、上次验证失败。修复方案：把 led1/r1 那一串从 GPIO5 挪回承载闪烁信号的 GPIO4（接法不变：GPIO4 → r1 → led1 阳极 A，led1 阴极 K → J1_GND4），固件继续在 GPIO4 上做 200 ms 周期闪烁，并顺手去掉已无意义的 GPIO5 静态输出
- pins: GPIO4=LED_BLINK (led1 阳极驱动)
- verification spec: period, state_during, state_during, toggle_count, uart_contains over 3000 ms
-   ✓ led1: 13 periods, mean 200 ms (expected 200 ms ±2%), max deviation 0 ms, duty 50.0% (expected 50% ±5%)
-   ✓ led1 stayed on from 50 to 90 ms
-   ✓ led1 stayed off from 133 to 193 ms
-   ✓ led1 toggled 29 time(s) in 50–3000 ms (expected 25–33)
-   ✓ UART output contains "LED ON" (log evidence only — not a physical signal)
- builds: success
- tool chain: p:get_project_state → p:plan_hardware → c:edit_circuit → c:write_firmware → c:build_firmware → c:finish_implementation → e:flash_virtual_device → e:verify_behavior
- LED wired to GPIO4; live period 200.00 ms



## T9-a — Anti-cheat: edit source outside the agent → rebuild → UI feed follows the new firmware: PASS

- external edit → build success (b_20261013091217_dbc1) → flash success (esptool-virtual-uart) → live LED period 600.23 ms (expected 600)
- UART: T9 external firmware: 300 ms on / 300 ms off on GPIO4
- agent runs involved: none (project has 4 earlier runs; no new run started)



## T9-b — Static anti-cheat scan: renderers have no timers/animations; no mock success paths; UART-only checks cannot pass: PASS

- renderer files scanned for timers/animations/chat access; 1 CSS keyframes (spin)
- UART-only scenario: text found=true, verification passed=false (No physical (GPIO/circuit) check in scenario — UART-only checks cannot pass verification.)
- verify with stale build after a source edit: HTTP 200 (sources changed but flashed build unchanged — engine verifies what is actually flashed: 9bd27f79555c)



## T10 — Demo "blink" creates, builds, flashes and verifies (esp32c3-devkitm-1): PASS

- build success 10.7 s; esptool-virtual-uart success; verification PASS: led1: 3 periods, mean 1000 ms (expected 1000 ms ±1%), max deviation 0 ms, duty 50.0% (expected 50% ±3%)



## T10 — Demo "button-led" creates, builds, flashes and verifies (esp32c3-devkitm-1): PASS

- build success 10.8 s; esptool-virtual-uart success; verification PASS: led1 stayed off from 100 to 790 ms | led1 stayed on from 830 to 1790 ms | led1 stayed off from 1830 to 3000 ms



## T10 — Demo "traffic-light" creates, builds, flashes and verifies (esp32c3-devkitm-1): PASS

- build success 10.7 s; esptool-virtual-uart success; verification PASS: Pattern over (tl1:red, tl1:yellow, tl1:green) matched 3 consecutive segment(s) (needed 3); first match at 12.13 ms



## T10 — Demo "blink" creates, builds, flashes and verifies (arduino-uno): PASS

- build success 1.4 s; direct-image-load success; verification PASS: led1: 3 periods, mean 1000.02 ms (expected 1000 ms ±1%), max deviation 0.02 ms, duty 50.0% (expected 50% ±3%)



## T10 — Demo "button-led" creates, builds, flashes and verifies (arduino-uno): PASS

- build success 1.4 s; direct-image-load success; verification PASS: led1 stayed off from 100 to 790 ms | led1 stayed on from 830 to 1790 ms | led1 stayed off from 1830 to 3000 ms



## T10 — Demo "traffic-light" creates, builds, flashes and verifies (arduino-uno): PASS

- build success 1.4 s; direct-image-load success; verification PASS: Pattern over (tl1:red, tl1:yellow, tl1:green) matched 3 consecutive segment(s) (needed 3); first match at 0.14 ms [glitch filter 1 ms: 6 sub-ms transient(s) ignored]



## T10-mod-restore — Modify → rebuild → restore previous version from history → original behaviour back: PASS

- modified: led1: 5 periods, mean 250 ms (expected 250 ms ±1%), max deviation 0 ms
- restored to 376d999d (source identical: true): led1: 3 periods, mean 1000 ms (expected 1000 ms ±1%), max deviation 0 ms, duty 50.0% (expected 50% ±3%)



## T10-stop-restart — Simulator stop / restart and project isolation (two boards running different firmware concurrently): PASS

- concurrent: ESP32 project period 1000.0 ms, Uno project period 300.0 ms
- after stop: stopped; after start: running, simulated 1498 ms (fresh power-on)


