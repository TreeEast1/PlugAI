# PlugAI architecture

```
 Browser (React, apps/web)                         Node server (apps/server)
 ┌──────────────┬────────────────┬──────────────┐  ┌───────────────────────────────────────────────────────────┐
 │ AI Creator   │ Virtual Hardw. │ Engineering  │  │ REST /api  +  WebSocket /ws (per-project push)            │
 │ (run cards)  │ Lab (SVG)      │ Code/Build/  │◀─┤ Runtime = deterministic Tool Executor + ToolHost          │
 │              │ HardwareRender │ Serial/Sig/… │  │   ├─ ProjectStore (git per project, path policy)          │
 └──────────────┴────────────────┴──────────────┘  │   ├─ FirmwareBuilder  backends/esp32 | backends/avr        │
        ▲ only renders server state                │   ├─ Flasher          esptool⇄esp-emu | HEX direct load   │
        │                                          │   ├─ VirtualHardware  (worker thread per board)          │
        │                                          │   │     McuCore (esp-emu WASM | avr8js) + circuit solver   │
        │                                          │   └─ Verification Engine (fresh MCU, fast mode)          │
        │                                          │ Agent (packages/agent): Planner / Coder / Debugger       │
        │                                          │   DeepSeek-V4.1-Flash, thinking=enabled, effort=high       │
        └────────── sim.frame / agent.event ───────┴───────────────────────────────────────────────────────────┘
```

## Packages

| Path | Responsibility |
|---|---|
| `packages/shared` | Types/protocol: boards & pinouts, circuit model, sim events, verification DSL (zod), agent events |
| `packages/circuit` | **VirtualCircuit**: component catalogue + geometry, `applyOps` (validated, atomic), DC nodal solver |
| `packages/simulator` | **MCUSimulator** contract (`McuCore`), worker host `VirtualHardware`, `runVerification` |
| `packages/sandbox` | Allow-listed tool execution (argv only, scrubbed env, ulimits, timeouts, process-group kill), source policy |
| `packages/agent` | DeepSeek client, tool schemas, prompts, `AgentRun` state machine |
| `backends/esp32` | ESP-IDF builder, esp-emu WASM core, esptool virtual-UART flasher |
| `backends/avr` | arduino-cli builder, avr8js core, HEX loader |
| `apps/server` | HTTP/WS API, project store (git), runtime, SDK reference extraction |
| `apps/web` | UI. `lab/parts.tsx` are pure renderers (HardwareRenderer) |

## Unified simulator interface

`McuCore` (runs inside the worker): `init / load(image) / reset / run(maxUs) → {uart, edges, restarted, configChanged} / pins() / setInput(pin, level) / uartWrite / clock() / pc()`.

`VirtualHardware` (main thread) implements the MCUSimulator contract from the spec: `loadFirmware()`, `start(mode)`, `pause()`, `reset()`, `stop()`, `getState()`, `subscribeEvents()`, `setInputPin()` (+ `pressButton`, `setCircuit`, `schedule`, `runUntil`). Capabilities are declared per backend (`BackendInfo.capabilities`); unsupported features throw `UnsupportedError` (e.g. serial flashing on AVR).

Adding a chip = new `McuCore` + board definition (pins/geometry) + builder. UI, circuit, agent and verification are unchanged.

## Causal chain (no shortcuts)

1. Firmware writes a GPIO register (real machine code in the emulator).
2. Core detects the pad change (ESP: GPIO_OUT/ENABLE after each 2000-instruction batch; AVR: port listener at the exact cycle) → `GpioEdge{pin, level, simUs, cycles}`.
3. Worker re-solves the circuit with the new pad states (`solveCircuit`): nets from explicit wires, Thevenin sources for driven pads, pull resistors, resistors, switches, piecewise-linear LEDs; iterated to a consistent operating point.
4. Component states (`lit`, `brightness`, `currentMa`) and net levels change → `ComponentEdge` with the same `simUs`.
5. Input pads get their level from the solved net (button → GND with pull-up ⇒ 0) → `core.setInput()` at that simulated instant.
6. Frames (≤30/s) with edges, component states, duty cycles and nets go to the browser, which only draws them.

## Time

* `simUs = cycles / cyclesPerUs` (160 MHz ESP32-C3, 16 MHz AVR) — the only time base used by verification and the Signals view.
* Live mode is paced to wall-clock (`speed` reported honestly, e.g. ×1.00; if the core is slower than real-time the ratio drops below 1 and is shown).
* Verification mode runs as fast as possible on a fresh MCU; stimuli are applied at exact simulated times.
* LED brightness in the UI = duty (fraction of the frame window the LED was lit, computed from edges) × brightness from forward current — fast PWM is therefore shown as dimming derived from real edges, not as an animation.

## Agent

`AgentRun.execute()`:

1. `understanding` → project state (circuit, files, last build/verification, conversation).
2. **Planner** (DeepSeek, tools: inspect_environment, get_project_state, list_supported_hardware, create_project, `plan_hardware`) → zod-validated `Plan` with a machine-checkable verification scenario. Invalid → model must fix. Infeasible → honest capability-gap failure.
3. **Coder** (edit_circuit, write_firmware, read_sdk_reference, build_firmware, `finish_implementation`). `finish_implementation` is refused unless the *current* sources were built successfully and every planned wire exists.
4. **Executor** (deterministic): flash (ESP: esptool virtual UART; Uno: direct load) → Verification Engine.
5. On failure, **Debugger** (run_simulation, inspect_gpio/uart, edit/write/build, verify_behavior, `repair_project`) gets real evidence; ≤3 repair rounds. It may revise the scenario at most once, keeping check types/count and tolerances ≤10%/≤100 ms (recorded and shown).
6. Success only when the engine passes; then the verified firmware is started live.

Requests are streamed (SSE) with an idle timeout (no bytes for ≥60–180 s) instead of a total timeout, so long firmware generations are not cut off; progress (`llm-progress` events) is shown in the run card. Thinking mode: every request carries `thinking:{type:"enabled"}`, `reasoning_effort:"high"`, `tool_choice:"auto"`; each role's full message list including `reasoning_content` and `tool_calls` is sent back on every turn. Retries with exponential backoff (rate-limit ×2), per-request timeout, tool-call cap (90), tool-result clipping (24 k chars), token & cost accounting per call. API errors end the run with "AI service unavailable"; there is no template fallback.

Audit trail per run (`workspaces/projects/<id>/runs/<runId>/`): `run.json` (status, model, usage, cost), `events.jsonl` (every phase/LLM/tool/build/flash/verification event), `llm/*.json` (each model call: response content + tool calls, request tail), `tools/*.json` (each tool's arguments and full result). Every agent step is also a git commit in the project.

## Security / isolation (local single-user)

* Server binds to 127.0.0.1; requests/WebSocket from non-localhost origins are refused.
* The agent never sends commands; it calls typed tools. Builders/flashers spawn allow-listed executables with argv arrays (no shell interpolation; `/bin/sh` is used only to apply `ulimit -t/-f/-c` with positional args).
* Environment scrubbed (no `*KEY*/*TOKEN*/*SECRET*`, no DeepSeek variables) for every child process; `IDF_COMPONENT_MANAGER=0` (no network fetches); emulator networking `--net user,restrict=yes`.
* Timeouts kill the whole process group; children are killed on server exit; orphaned runs are marked "interrupted" on restart.
* Writable files: `firmware/main/*.{c,cpp,h,hpp}` (ESP) or `firmware/sketch/*` (Uno); CMake/sdkconfig are platform-managed. Sources with absolute/parent `#include`, `.incbin` etc. are rejected before compilation.
* Simulation runs in worker threads with a heap limit; the browser cannot run anything.
* Not containerised (no Docker on this host) — see `deployment.md` for the multi-user hardening plan.

## Bus devices (LCD)

`packages/simulator/src/devices/st7735.ts` is driven from the worker: the AVR core exposes an SPI byte hook (`AVRSPI.onByte`) and fast pad reads; for every byte the worker checks the LCD's bus binding (derived by the circuit solver from the actual wires: SCK→D13, SDA→D11, CS/DC/RST→GPIO, VCC/BL powered) and the live CS/DC/RST levels, then feeds the controller. Frames go to the UI at ≤15 fps (live) and are captured at exact simulated times for `display` checks (PNG evidence in `traces/`).

## Site & cases

`apps/server/src/cases.ts` serves `showcase/` (list, detail, assets, `POST /api/cases/:id/fork` → new project with the case's circuit, firmware and conversation history). The web app routes `/`, `/cases`, `/cases/:id`, `/cases/:id/film` (1280×720 scripted replay used for video capture) and `/studio`. `site/CircuitView.tsx` renders recorded runs with the same pure part renderers as the Lab, looking up every state in the recorded timelines.
