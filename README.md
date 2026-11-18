# PlugAI — AI Native Embedded Development Studio

**Vibe Coding for the Physical World.**

Describe a hardware behaviour in natural language. PlugAI's DeepSeek-V4.1-Flash agent plans the circuit, wires a virtual board, writes real firmware, cross-compiles it with the real SDK, flashes the virtual chip (on ESP32-C3: genuine esptool ROM-protocol flashing over a virtual UART), runs the machine code on an instruction-level MCU emulator, and verifies the actual GPIO signals through a circuit solver. LEDs in the UI light only when the solver says current flows.

```
natural language ─▶ Planner (DeepSeek) ─▶ Coder (DeepSeek) ─▶ real compiler ─▶ virtual flash ─▶ MCU emulator
                                             ▲                                                   │ GPIO pads
                                Debugger (DeepSeek) ◀── Verification Engine ◀── circuit solver ◀──┘ → UI
```

## Quick start

Requirements: macOS (Apple Silicon or Intel) or Linux, Node ≥ 20, git, ~3 GB disk. (On Apple Silicon, setup installs Rosetta 2 for avr-gcc.)

```bash
npm run setup        # Node deps + ESP-IDF v5.5.5 + esp32c3 toolchain + esp-emu 0.48 (native+WASM) + arduino-cli/avr core
# put your key into .env  →  DEEPSEEK_API_KEY=sk-...
npm run dev          # API on 127.0.0.1:8787, UI on http://127.0.0.1:5173
```

`npm run setup` downloads real SDKs — they cannot be skipped. `npm run doctor` shows what is installed. Without a DeepSeek key the app still works in manual mode (edit code, wire parts, build, flash, run), and the AI panel says the AI is unavailable. There is no hidden template fallback.

## Pages

| URL | What it is |
|---|---|
| `/` | Product landing page (live replay of a recorded run, proof numbers from `reports/`, pipeline, cases) |
| `/cases` | Case library — every card is a real recorded AI run (prompt, plan, firmware, verification, video) |
| `/cases/<id>` | Case detail: replay player (recorded emulator data), conversation & process log, firmware, build hashes, evidence; **Fork** to continue in the Studio |
| `/studio` | The workspace (AI Creator · Virtual Hardware Lab · Engineering panel) |

## Using it

1. **+ New** → choose **ESP32-C3-DevKitM-1** (primary) or **Arduino Uno**, blank or a hand-written example.
2. Type in the **AI Creator**, e.g. `帮我创建一个 ESP32 的 LED 闪烁项目，每隔一秒闪一次。` The run card shows real steps: plan → circuit → firmware → compile → flash → MCU run → signal verification → repair → delivery, plus every DeepSeek call, tool call, token usage and cost.
3. Continue the conversation in the same project (`现在改成每 200 毫秒闪一次。`). Every step is a git commit (History tab → diff / restore).
4. **Virtual Hardware Lab**: drag parts, click a pin then another pin to wire, click a wire + Delete to remove, hover for net level/voltage, hold a button to press it (only acts on a running MCU).
5. **Toolbar**: Build · Flash (esptool · virtual UART) / Direct load · Run · Pause · Reset · Stop · Download firmware. Disabled buttons explain why.
6. **Engineering panel**: Code (editable, saved = committed), Build (log, diagnostics, artifacts + SHA-256, commands, tool versions), Serial (UART), Signals (logic analyser on simulated time), Debug (MCU state, flash steps, verification reports, circuit warnings), History.

## Showcase cases

`showcase/<id>/` holds each case: `case.json` (all turns with prompt, plan, metrics, condensed event log, verification; final circuit + firmware + build hashes; replay recording), `runs/` (original run logs), `frames/` & `evidence/` (LCD frames), `video.webm` + `poster.png`.

```bash
npx tsx scripts/showcase/export.ts [id…]   # rebuild cases from workspaces/projects (re-runs final firmware on the emulator for the replay)
npx tsx scripts/showcase/record.ts [id…]   # film /cases/<id>/film with Playwright → video.webm + poster.png (needs `npx playwright install chromium`)
```
The videos and replays are labelled "recorded run replay": every frame is driven by the recorded logs and emulator data, never by hand-made animation.

## Tests & evidence

```bash
npm run test:unit                  # circuit solver, verification semantics, sandbox policy (vitest)
npm run test:p0                    # Tests 1–6 (both boards) + Test 8 (esptool virtual flashing) — no server needed
npm run dev:server &               # the next suites drive the real HTTP/WS API
npm run test:llm                   # LLM-Test-01…07 + scenarios A–E + capability boundary (real DeepSeek)
npm run test:e2e                   # §15 final flow, Test 9 (anti-cheat), Test 10 (regression, both boards)
npm run test:all                   # everything + reports/SUMMARY.md
```

Reports (Markdown + JSON + JSONL event traces) are written to `reports/<suite>/<timestamp>/`. `reports/SUMMARY.md` aggregates the latest run.

## Repository layout

```
apps/server        HTTP/WS API, project store (git), runtime / tool executor, SDK reference
apps/web           React UI (AI Creator · Virtual Hardware Lab · Engineering panel · toolbar)
packages/shared    types, boards & pinouts, verification DSL
packages/circuit   component catalogue, circuit ops, DC nodal solver
packages/simulator McuCore contract, VirtualHardware worker host, Verification Engine
packages/agent     DeepSeek client, tool schemas, prompts, Planner/Coder/Debugger orchestrator
packages/sandbox   allow-listed process execution and source policy
backends/esp32     ESP-IDF builder, esp-emu WASM core, esptool virtual-UART flasher
backends/avr       arduino-cli builder, avr8js core, HEX loader
firmware-examples  hand-written examples (blink, button-led, traffic-light) + test fixtures
docs/              feasibility, architecture, supported hardware, real-vs-virtual, deployment
reports/           test reports and evidence
workspaces/        runtime data (projects, builds, traces) — git-ignored
```

## Status

| Area | Status |
|---|---|
| Real cross-compilation (ESP-IDF 5.5.5 / avr-gcc 7.3) | ✅ |
| Real MCU execution (esp-emu 0.48 ESP32-C3 ROM→bootloader→app; avr8js ATmega328P) | ✅ |
| GPIO → circuit solver → LED; button → input pad → firmware | ✅ both boards |
| esptool ROM-protocol virtual flashing + verify + read-back + boot from written flash (ESP32-C3) | ✅ (`--no-stub`, stub crashes esp-emu 0.48) |
| Direct image load (both), clearly labelled | ✅ |
| DeepSeek Planner/Coder/Debugger with function calling, thinking mode, repair loop ≤ 3 | ✅ |
| Verification Engine (period / pattern / state windows / toggle counts / UART log-only) | ✅ |
| Web UI (canvas editing, live state, panels, history/restore, downloads) | ✅ |
| PWM to circuit: Uno ✅ (timer compare outputs), ESP32 LEDC ❌ (not exposed by emulator) | partial |
| 1.8" ST7735 colour LCD over real hardware SPI (Uno): controller model, frame capture, display verification | ✅ (Uno only — esp-emu does not expose ESP32 SPI pads) |
| Landing page, case library (12 recorded AI cases with videos), fork-and-continue | ✅ |
| RGB LED, OLED, sensors, I2C | ❌ not implemented (agent reports capability gap) |
| Physical USB flashing | ❌ designed (docs/deployment.md), no hardware available |
| Physical hardware verification | ❌ never claimed |

See `docs/real-vs-virtual.md` for exactly what each UI label means and `docs/feasibility.md` for measured P0 data.

## Security notes

The API binds to localhost and rejects non-local origins. The agent only calls typed tools; compilers/emulators run as allow-listed executables (argv, scrubbed env without secrets, ulimits, timeouts). The DeepSeek key lives only in the server's `.env` (git-ignored, mode 600) and is never sent to the browser, written to projects, logs or reports.
