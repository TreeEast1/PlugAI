# PlugAI P0 acceptance — real firmware ↔ MCU emulation ↔ virtual circuit

Generated: 2026-10-13T11:08:43.246Z

All results below come from real cross-compilation and MCU emulation; LED states are computed by the circuit solver from emulated GPIO pad registers.

| ID | Test | Board | Status | Time |
|---|---|---|---|---|
| T1 | Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture) | esp32c3-devkitm-1 | **PASS** | 17.1 s |
| T2 | MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU) | esp32c3-devkitm-1 | **PASS** | 0.3 s |
| T3 | GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit | esp32c3-devkitm-1 | **PASS** | 0.8 s |
| T4 | Circuit truthfulness: same running firmware, different wiring | esp32c3-devkitm-1 | **PASS** | 1.3 s |
| T5 | Interactive closed loop: button → input pad → firmware → output pad → LED | esp32c3-devkitm-1 | **PASS** | 3.4 s |
| T6 | Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps | esp32c3-devkitm-1 | **PASS** | 3.0 s |
| T1 | Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture) | arduino-uno | **PASS** | 3.1 s |
| T2 | MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU) | arduino-uno | **PASS** | 0.2 s |
| T3 | GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit | arduino-uno | **PASS** | 1.5 s |
| T4 | Circuit truthfulness: same running firmware, different wiring | arduino-uno | **PASS** | 3.4 s |
| T5 | Interactive closed loop: button → input pad → firmware → output pad → LED | arduino-uno | **PASS** | 2.2 s |
| T6 | Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps | arduino-uno | **PASS** | 1.9 s |
| T8 | Virtual UART flashing (esptool ROM protocol → emulated SPI flash → boot from written flash) | esp32c3-devkitm-1 | **PASS** | 14.2 s |
| T11 | LCD over real SPI: firmware SPI bytes → ST7735 model → captured frame; miswired bus shows nothing | arduino-uno | **PASS** | 3.7 s |

## T1 — Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture) (esp32c3-devkitm-1): PASS

- gpio4_high: success in 11670 ms; ELF 2958956 B sha256 edd3412aa9e0dfa4…; merged.bin sha256 0969a01ec81aa96d…
-   command: -C /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 set-target esp32c3 && /Users/licochen/esp/esp-idf/tools/idf.py -C /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 build && /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 merge-bin -o merged.bin
- gpio4_low: success in 2514 ms; ELF 2966964 B sha256 db46e5407cd78467…; merged.bin sha256 140057cc735b787f…
-   command: /Users/licochen/esp/esp-idf/tools/idf.py -C /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 build && /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 merge-bin -o merged.bin
- gpio4_blink_1000: success in 2569 ms; ELF 2967060 B sha256 4acac27939e6cbbc…; merged.bin sha256 227938c319ad5672…
-   command: /Users/licochen/esp/esp-idf/tools/idf.py -C /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 build && /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 merge-bin -o merged.bin
- toolchain: ESP-IDF v5.5.5; riscv32-esp-elf-gcc riscv32-esp-elf-gcc (crosstool-NG esp-14.2.0_20260121) 14.2.0; esptool 4.12.0; esp-emu (native) esp-emu 0.48.0
- compile_error fixture: status=failed, 1 error diagnostic(s): main/main.c:7: expected ';' before 'while'
- compile_error produced artifacts: 0

Evidence: `workspaces/tests/p0-esp32c3/builds/b1_gpio4_high/build.json`, `workspaces/tests/p0-esp32c3/builds/b2_gpio4_low/build.json`, `workspaces/tests/p0-esp32c3/builds/b3_gpio4_blink_1000/build.json`, `workspaces/tests/p0-esp32c3/builds/b4_compile_error/build.log`

## T2 — MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU) (esp32c3-devkitm-1): PASS

- cycle counter samples: 48000078 → 96000078 → 144000078 → 192000079 (strictly increasing)
- PC samples: 0x40381dc4, 0x40381dc4, 0x40381dc4, 0x40381dc4
- UART (from emulated UART peripheral): rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT) | I (1) boot: ESP-IDF v5.5.5 2nd stage bootloader | I (1) boot: compile time Oct 13 2026 19:07:57 | I (1) boot: chip revision: v0.3 | I (1) boot: efuse block revision: v1.0 | I (1) boot: Enabling RNG early entropy source... | I (1) boot: Partition Table: | I (1) boot: ## Label            Usage          Type ST Offset   Length
- PC within target code regions: true

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T2.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/esp32c3-T2-uart.txt`

## T3 — GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit (esp32c3-devkitm-1): PASS

- A (always HIGH): led1 stayed on from 300 to 3000 ms
- B (always LOW):  led1 stayed off from 0 to 3000 ms
- C (toggle):      led1: 2 periods, mean 1000 ms (expected 1000 ms ±1%), max deviation 0 ms, duty 50.0% (expected 50% ±2%)
- LED signatures: A=[0:0 12:1] B=[0:0] C=[0:0 13:1 513:0 1013:1 1513:0 2013:1 2513:0…]
- GPIO GPIO4 edges: A=1, B=1, C=7

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T3-A.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T3-B.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T3-C.jsonl`

## T4 — Circuit truthfulness: same running firmware, different wiring (esp32c3-devkitm-1): PASS

- connected    (GPIO4 edges: 7): led1: 2 periods, mean 1000 ms (expected 1000 ms ±1%), max deviation 0 ms
- disconnected (GPIO4 edges: 7): led1 stayed off from 0 to 3000 ms
- alt-gpio     (GPIO4 edges: 7): led1 stayed off from 0 to 3000 ms
- reversed     (GPIO4 edges: 7): led1 stayed off from 0 to 3000 ms | warnings: LED_REVERSED reported
- live rewire @2000 ms: before → led1 toggled 4 time(s) in 0–2000 ms (expected 2+); after → led1 stayed off from 2001 to 4000 ms; GPIO4 kept toggling (4 edges after rewire)

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T4-connected.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T4-disconnected.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T4-alt-gpio.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T4-reversed.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T4-live-rewire.jsonl`

## T5 — Interactive closed loop: button → input pad → firmware → output pad → LED (esp32c3-devkitm-1): PASS

- led1 stayed off from 300 to 999 ms
- led1 stayed on from 1020 to 1999 ms
- led1 stayed off from 2020 to 3000 ms
- causal chain: user press @1000.000 ms → GPIO5 input=0 applied @1000.000 ms → firmware drives GPIO4=1 @1002.013 ms → led1 lit @1002.013 ms
- control (button unwired): led1 stayed off from 300 to 3000 ms
- control (firmware ignores button): led1 stayed off from 300 to 3000 ms

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T5.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/esp32c3-T5-event-chain.json`

## T6 — Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps (esp32c3-devkitm-1): PASS

- 1000 ms firmware: led1: 4 periods, mean 1000 ms (expected 1000 ms ±0.5%), max deviation 0 ms, duty 50.0% (expected 50% ±2%)
- 200 ms firmware:  led1: 10 periods, mean 200 ms (expected 200 ms ±0.5%), max deviation 0 ms, duty 50.0% (expected 50% ±2%)
- tolerance ±0.5%: esp-emu pads sampled every 2000 instructions (≈12.5 µs at 160 MHz); FreeRTOS tick 1 ms

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T6-1000.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T6-200.jsonl`

## T1 — Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture) (arduino-uno): PASS

- d4_high: success in 1611 ms; ELF 24184 B sha256 bc556871a8fee251…; sketch.ino.hex sha256 eb3c920c79b52e24…
-   command: --output-dir /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/builds/b7_d4_high --warnings default --no-color /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/firmware/sketch
- d4_low: success in 545 ms; ELF 24204 B sha256 e6d9cef24015a931…; sketch.ino.hex sha256 e290a729163030ea…
-   command: --output-dir /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/builds/b8_d4_low --warnings default --no-color /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/firmware/sketch
- d4_blink_1000: success in 547 ms; ELF 25108 B sha256 5629960953887ca0…; sketch.ino.hex sha256 9bd27f79555cadbf…
-   command: --output-dir /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/builds/b9_d4_blink_1000 --warnings default --no-color /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-uno/firmware/sketch
- toolchain: arduino-cli arduino-cli  Version: 1.5.2-rc.1 Commit: fef6e48df Date: 2026-07-23T11:12:51Z; arduino:avr core 1.8.8; avr-gcc 7.3.0-atmel3.6.1-arduino7
- compile_error fixture: status=failed, 2 error diagnostic(s): sketch/sketch.ino:1: expected ';' before '}' token | sketch/sketch.ino:2: 'levle' was not declared in this scope
- compile_error produced artifacts: 0

Evidence: `workspaces/tests/p0-uno/builds/b7_d4_high/build.json`, `workspaces/tests/p0-uno/builds/b8_d4_low/build.json`, `workspaces/tests/p0-uno/builds/b9_d4_blink_1000/build.json`, `workspaces/tests/p0-uno/builds/b10_compile_error/build.log`

## T2 — MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU) (arduino-uno): PASS

- cycle counter samples: 4800001 → 9600000 → 14400001 → 19200000 (strictly increasing)
- PC samples: 0x602, 0x602, 0x600, 0x600
- UART (from emulated UART peripheral): PLUGAI_FIXTURE d4_high
- PC within target code regions: true

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T2.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/uno-T2-uart.txt`

## T3 — GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit (arduino-uno): PASS

- A (always HIGH): led1 stayed on from 300 to 3000 ms
- B (always LOW):  led1 stayed off from 0 to 3000 ms
- C (toggle):      led1: 2 periods, mean 1000.02 ms (expected 1000 ms ±1%), max deviation 0.02 ms, duty 50.0% (expected 50% ±2%)
- LED signatures: A=[0:0 0:1] B=[0:0] C=[0:0 0:1 500:0 1000:1 1500:0 2000:1 2500:0…]
- GPIO D4 edges: A=2, B=1, C=7

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T3-A.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T3-B.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T3-C.jsonl`

## T4 — Circuit truthfulness: same running firmware, different wiring (arduino-uno): PASS

- connected    (D4 edges: 7): led1: 2 periods, mean 1000.02 ms (expected 1000 ms ±1%), max deviation 0.02 ms
- disconnected (D4 edges: 7): led1 stayed off from 0 to 3000 ms
- alt-gpio     (D4 edges: 7): led1 stayed off from 0 to 3000 ms
- reversed     (D4 edges: 7): led1 stayed off from 0 to 3000 ms | warnings: LED_REVERSED reported
- live rewire @2000 ms: before → led1 toggled 4 time(s) in 0–2000 ms (expected 2+); after → led1 stayed off from 2001 to 4000 ms; D4 kept toggling (4 edges after rewire)

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T4-connected.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T4-disconnected.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T4-alt-gpio.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T4-reversed.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T4-live-rewire.jsonl`

## T5 — Interactive closed loop: button → input pad → firmware → output pad → LED (arduino-uno): PASS

- led1 stayed off from 300 to 999 ms
- led1 stayed on from 1020 to 1999 ms
- led1 stayed off from 2020 to 3000 ms
- causal chain: user press @1000.000 ms → D5 input=0 applied @1000.000 ms → firmware drives D4=1 @1002.394 ms → led1 lit @1002.394 ms
- control (button unwired): led1 stayed off from 300 to 3000 ms
- control (firmware ignores button): led1 stayed off from 300 to 3000 ms

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T5.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/uno-T5-event-chain.json`

## T6 — Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps (arduino-uno): PASS

- 1000 ms firmware: led1: 4 periods, mean 1000.02 ms (expected 1000 ms ±1%), max deviation 0.02 ms, duty 50.0% (expected 50% ±2%)
- 200 ms firmware:  led1: 10 periods, mean 200.02 ms (expected 200 ms ±1%), max deviation 0.02 ms, duty 50.0% (expected 50% ±2%)
- tolerance ±1%: avr8js edges are cycle-exact (62.5 ns); Arduino delay() uses Timer0 millis() (1.024 ms tick granularity)

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T6-1000.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T6-200.jsonl`

## T8 — Virtual UART flashing (esptool ROM protocol → emulated SPI flash → boot from written flash) (esp32c3-devkitm-1): PASS

-   [flash#1] prepare-virtual-device: ok
-   [flash#1] enter-rom-download-mode: ok
-   [flash#1] esptool-connect-chip-id: ok
-   [flash#1] esptool-write-flash: ok
-   [flash#1] esptool-verify-flash: ok
-   [flash#1] esptool-read-back: ok
-   [flash#1] exit-download-mode-persist-flash: ok
-   [flash#1] boot-from-written-flash: ok
- flash#1 success: esptool 4.12.0, transport socket://127.0.0.1:49841, 163840 bytes; before cd3517473707… → after f0c7032a0c15…; readback 41941e1cf47e…
-   command: -m esptool --chip esp32c3 -p socket://127.0.0.1:49841 --before no_reset --after no_reset --no-stub write_flash --flash_mode dio --flash_size 4MB --flash_freq 80m 0x0 /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/builds/b3_gpio4_blink_1000/bootloader.bin 0x8000 /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/builds/b3_gpio4_blink_1000/partition-table.bin 0x10000 /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/builds/b3_gpio4_blink_1000/plugai_app.bin
-   Booted from written virtual flash: bootloader → app; app reports ELF SHA256 4acac2793… matching build b3_gpio4_blink_1000; reached app_main()
- running the written virtual flash: led1: 2 periods, mean 1000 ms (expected 1000 ms ±0.5%), max deviation 0 ms
- flash#2 success: before f0c7032a0c15… (= after#1: true) → after cdaec35a8628…; Booted from written virtual flash: bootloader → app; app reports ELF SHA256 da0e241bc… matching build b6_gpio4_blink_200; reached app_main()
- re-flashed device now runs: led1: 9 periods, mean 200 ms (expected 200 ms ±0.5%), max deviation 0 ms

Evidence: `workspaces/tests/p0-esp32c3/flashes/flash_4b7fdf23/flash.json`, `workspaces/tests/p0-esp32c3/flashes/flash_4b7fdf23/flash.log`, `workspaces/tests/p0-esp32c3/flashes/flash_7424d081/flash.json`, `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T8-run-after-flash1.jsonl`, `reports/p0/2026-10-13T11-07-47-112Z/traces/esp32c3-T8-run-after-flash2.jsonl`

## T11 — LCD over real SPI: firmware SPI bytes → ST7735 model → captured frame; miswired bus shows nothing (arduino-uno): PASS

- correct wiring: verification PASS — lcd1 @1500 ms: non-black 36.9%, #ffff00 33.8%, #ff0000 3.1%; dominant #121212 63.1% #ffff12 33.8% #ff1212 3.1%; 29257 pixels written over 60435 SPI bytes
- DC on D7 (firmware drives D9): verification FAIL — lcd1 at 1500 ms shows nothing: the D/C pin D7 is never driven by the firmware (60435 bytes arrived while it was an undriven input) — firmware and wiring disagree. Bus bytes 60435, accepted 0, commands 0, pixels 0
- SCK on D12 (not hardware SPI): verification FAIL — lcd1 at 1500 ms shows nothing: SPI bus wiring incomplete (SCK→D13, SDA→D11, CS/DC/RST to GPIOs). Bus bytes 60435, accepted 0, commands 0, pixels 0

Evidence: `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T11-D9-D13_lcd1_d1500ms.png`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T11-D9-D13_lcd1_d2000ms.png`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T11-D7-D13_lcd1_d1500ms.png`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T11-D7-D13_lcd1_d2000ms.png`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T11-D9-D12_lcd1_d1500ms.png`, `reports/p0/2026-10-13T11-07-47-112Z/traces/uno-T11-D9-D12_lcd1_d2000ms.png`
