# PlugAI P0 acceptance — real firmware ↔ MCU emulation ↔ virtual circuit

Generated: 2026-10-13T08:18:36.943Z

All results below come from real cross-compilation and MCU emulation; LED states are computed by the circuit solver from emulated GPIO pad registers.

| ID | Test | Board | Status | Time |
|---|---|---|---|---|
| T1 | Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture) | arduino-uno | **PASS** | 3.0 s |
| T2 | MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU) | arduino-uno | **PASS** | 0.2 s |
| T3 | GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit | arduino-uno | **PASS** | 1.3 s |
| T4 | Circuit truthfulness: same running firmware, different wiring | arduino-uno | **PASS** | 3.1 s |
| T5 | Interactive closed loop: button → input pad → firmware → output pad → LED | arduino-uno | **PASS** | 2.1 s |
| T6 | Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps | arduino-uno | **PASS** | 1.8 s |

## T1 — Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture) (arduino-uno): PASS

- d4_high: success in 1702 ms; ELF 24184 B sha256 bc556871a8fee251…; sketch.ino.hex sha256 eb3c920c79b52e24…
-   command: --output-dir /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/builds/b1_d4_high --warnings default --no-color /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/firmware/sketch
- d4_low: success in 498 ms; ELF 24204 B sha256 e6d9cef24015a931…; sketch.ino.hex sha256 e290a729163030ea…
-   command: --output-dir /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/builds/b2_d4_low --warnings default --no-color /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/firmware/sketch
- d4_blink_1000: success in 492 ms; ELF 25108 B sha256 5629960953887ca0…; sketch.ino.hex sha256 9bd27f79555cadbf…
-   command: --output-dir /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/builds/b3_d4_blink_1000 --warnings default --no-color /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/firmware/sketch
- toolchain: arduino-cli arduino-cli  Version: 1.5.2-rc.1 Commit: fef6e48df Date: 2026-07-23T11:12:51Z; arduino:avr core 1.8.8; avr-gcc 7.3.0-atmel3.6.1-arduino7
- compile_error fixture: status=failed, 2 error diagnostic(s): sketch/sketch.ino:1: expected ';' before '}' token | sketch/sketch.ino:2: 'levle' was not declared in this scope
- compile_error produced artifacts: 0

Evidence: `workspaces/tests/p0-uno/builds/b1_d4_high/build.json`, `workspaces/tests/p0-uno/builds/b2_d4_low/build.json`, `workspaces/tests/p0-uno/builds/b3_d4_blink_1000/build.json`, `workspaces/tests/p0-uno/builds/b4_compile_error/build.log`

## T2 — MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU) (arduino-uno): PASS

- cycle counter samples: 4800001 → 9600000 → 14400001 → 19200000 (strictly increasing)
- PC samples: 0x602, 0x602, 0x600, 0x600
- UART (from emulated UART peripheral): PLUGAI_FIXTURE d4_high
- PC within target code regions: true

Evidence: `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T2.jsonl`, `reports/p0/2026-10-13T08-18-25-413Z/uno-T2-uart.txt`

## T3 — GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit (arduino-uno): PASS

- A (always HIGH): led1 stayed on from 300 to 3000 ms
- B (always LOW):  led1 stayed off from 0 to 3000 ms
- C (toggle):      led1: 2 periods, mean 1000.02 ms (expected 1000 ms ±1%), max deviation 0.02 ms, duty 50.0% (expected 50% ±2%)
- LED signatures: A=[0:0 0:1] B=[0:0] C=[0:0 0:1 500:0 1000:1 1500:0 2000:1 2500:0…]
- GPIO D4 edges: A=2, B=1, C=7

Evidence: `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T3-A.jsonl`, `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T3-B.jsonl`, `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T3-C.jsonl`

## T4 — Circuit truthfulness: same running firmware, different wiring (arduino-uno): PASS

- connected    (D4 edges: 7): led1: 2 periods, mean 1000.02 ms (expected 1000 ms ±1%), max deviation 0.02 ms
- disconnected (D4 edges: 7): led1 stayed off from 0 to 3000 ms
- alt-gpio     (D4 edges: 7): led1 stayed off from 0 to 3000 ms
- reversed     (D4 edges: 7): led1 stayed off from 0 to 3000 ms | warnings: LED_REVERSED reported
- live rewire @2000 ms: before → led1 toggled 4 time(s) in 0–2000 ms (expected 2+); after → led1 stayed off from 2001 to 4000 ms; D4 kept toggling (4 edges after rewire)

Evidence: `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T4-connected.jsonl`, `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T4-disconnected.jsonl`, `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T4-alt-gpio.jsonl`, `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T4-reversed.jsonl`, `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T4-live-rewire.jsonl`

## T5 — Interactive closed loop: button → input pad → firmware → output pad → LED (arduino-uno): PASS

- led1 stayed off from 300 to 999 ms
- led1 stayed on from 1020 to 1999 ms
- led1 stayed off from 2020 to 3000 ms
- causal chain: user press @1000.000 ms → D5 input=0 applied @1000.000 ms → firmware drives D4=1 @1002.394 ms → led1 lit @1002.394 ms
- control (button unwired): led1 stayed off from 300 to 3000 ms
- control (firmware ignores button): led1 stayed off from 300 to 3000 ms

Evidence: `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T5.jsonl`, `reports/p0/2026-10-13T08-18-25-413Z/uno-T5-event-chain.json`

## T6 — Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps (arduino-uno): PASS

- 1000 ms firmware: led1: 4 periods, mean 1000.02 ms (expected 1000 ms ±1%), max deviation 0.02 ms, duty 50.0% (expected 50% ±2%)
- 200 ms firmware:  led1: 10 periods, mean 200.02 ms (expected 200 ms ±1%), max deviation 0.02 ms, duty 50.0% (expected 50% ±2%)
- tolerance ±1%: avr8js edges are cycle-exact (62.5 ns); Arduino delay() uses Timer0 millis() (1.024 ms tick granularity)

Evidence: `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T6-1000.jsonl`, `reports/p0/2026-10-13T08-18-25-413Z/traces/uno-T6-200.jsonl`
