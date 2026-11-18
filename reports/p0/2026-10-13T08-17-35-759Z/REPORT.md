# PlugAI P0 acceptance — real firmware ↔ MCU emulation ↔ virtual circuit

Generated: 2026-10-13T08:18:14.010Z

All results below come from real cross-compilation and MCU emulation; LED states are computed by the circuit solver from emulated GPIO pad registers.

| ID | Test | Board | Status | Time |
|---|---|---|---|---|
| T1 | Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture) | esp32c3-devkitm-1 | **PASS** | 16.1 s |
| T2 | MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU) | esp32c3-devkitm-1 | **PASS** | 0.2 s |
| T3 | GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit | esp32c3-devkitm-1 | **PASS** | 0.7 s |
| T4 | Circuit truthfulness: same running firmware, different wiring | esp32c3-devkitm-1 | **FAIL** | 1.1 s |
| T5 | Interactive closed loop: button → input pad → firmware → output pad → LED | esp32c3-devkitm-1 | **PASS** | 3.1 s |
| T6 | Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps | esp32c3-devkitm-1 | **PASS** | 2.8 s |
| T8 | Virtual UART flashing (esptool ROM protocol → emulated SPI flash → boot from written flash) | esp32c3-devkitm-1 | **PASS** | 14.2 s |

## T1 — Real firmware compilation (ELF/BIN/HEX, commands, versions, SHA256, real error capture) (esp32c3-devkitm-1): PASS

- gpio4_high: success in 10949 ms; ELF 2958956 B sha256 5da1d557b2ce30be…; merged.bin sha256 c7da790e71fec916…
-   command: -C /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 set-target esp32c3 && /Users/licochen/esp/esp-idf/tools/idf.py -C /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 build && /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 merge-bin -o merged.bin
- gpio4_low: success in 2433 ms; ELF 2966964 B sha256 0bbd0ec2cfeec8fe…; merged.bin sha256 52337ef161923efb…
-   command: /Users/licochen/esp/esp-idf/tools/idf.py -C /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 build && /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 merge-bin -o merged.bin
- gpio4_blink_1000: success in 2416 ms; ELF 2967060 B sha256 939a56f7c0253d0f…; merged.bin sha256 1d892f438e069b5e…
-   command: /Users/licochen/esp/esp-idf/tools/idf.py -C /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 build && /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/firmware -B /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/.build/esp32c3 merge-bin -o merged.bin
- toolchain: ESP-IDF v5.5.5; riscv32-esp-elf-gcc riscv32-esp-elf-gcc (crosstool-NG esp-14.2.0_20260121) 14.2.0; esptool 4.12.0; esp-emu (native) esp-emu 0.48.0
- compile_error fixture: status=failed, 1 error diagnostic(s): main/main.c:7: expected ';' before 'while'
- compile_error produced artifacts: 0

Evidence: `workspaces/tests/p0-esp32c3/builds/b1_gpio4_high/build.json`, `workspaces/tests/p0-esp32c3/builds/b2_gpio4_low/build.json`, `workspaces/tests/p0-esp32c3/builds/b3_gpio4_blink_1000/build.json`, `workspaces/tests/p0-esp32c3/builds/b4_compile_error/build.log`

## T2 — MCU actually executes target machine code (cycles advance, app entry reached, UART from MCU) (esp32c3-devkitm-1): PASS

- cycle counter samples: 48000079 → 96000079 → 144000079 → 192000080 (strictly increasing)
- PC samples: 0x40381dc4, 0x40381dc4, 0x40381dc4, 0x40381dc4
- UART (from emulated UART peripheral): rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT) | I (1) boot: ESP-IDF v5.5.5 2nd stage bootloader | I (1) boot: compile time Oct 13 2026 16:17:45 | I (1) boot: chip revision: v0.3 | I (1) boot: efuse block revision: v1.0 | I (1) boot: Enabling RNG early entropy source... | I (1) boot: Partition Table: | I (1) boot: ## Label            Usage          Type ST Offset   Length
- PC within target code regions: true

Evidence: `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T2.jsonl`, `reports/p0/2026-10-13T08-17-35-759Z/esp32c3-T2-uart.txt`

## T3 — GPIO causality: HIGH / LOW / toggling firmware give different LED behaviour on the same circuit (esp32c3-devkitm-1): PASS

- A (always HIGH): led1 stayed on from 300 to 3000 ms
- B (always LOW):  led1 stayed off from 0 to 3000 ms
- C (toggle):      led1: 2 periods, mean 1000 ms (expected 1000 ms ±1%), max deviation 0 ms, duty 50.0% (expected 50% ±2%)
- LED signatures: A=[0:0 12:1] B=[0:0] C=[0:0 13:1 513:0 1013:1 1513:0 2013:1 2513:0…]
- GPIO GPIO4 edges: A=1, B=1, C=7

Evidence: `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T3-A.jsonl`, `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T3-B.jsonl`, `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T3-C.jsonl`

## T4 — Circuit truthfulness: same running firmware, different wiring (esp32c3-devkitm-1): FAIL

- connected    (GPIO4 edges: 7): led1: 2 periods, mean 1000 ms (expected 1000 ms ±1%), max deviation 0 ms
- disconnected (GPIO4 edges: 7): led1 stayed off from 0 to 3000 ms
- alt-gpio     (GPIO4 edges: 7): led1 stayed off from 0 to 3000 ms
- reversed     (GPIO4 edges: 7): led1 stayed off from 0 to 3000 ms | warnings: LED_REVERSED reported
- live rewire @2000 ms: before → led1 toggled 4 time(s) in 0–2000 ms (expected 2+); after → led1 turned on at 2013 ms, inside the window 2001–4000 ms where it should stay off; GPIO4 kept toggling (4 edges after rewire)

Evidence: `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T4-connected.jsonl`, `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T4-disconnected.jsonl`, `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T4-alt-gpio.jsonl`, `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T4-reversed.jsonl`, `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T4-live-rewire.jsonl`

## T5 — Interactive closed loop: button → input pad → firmware → output pad → LED (esp32c3-devkitm-1): PASS

- led1 stayed off from 300 to 999 ms
- led1 stayed on from 1020 to 1999 ms
- led1 stayed off from 2020 to 3000 ms
- causal chain: user press @1000.000 ms → GPIO5 input=0 applied @1000.000 ms → firmware drives GPIO4=1 @1002.013 ms → led1 lit @1002.013 ms
- control (button unwired): led1 stayed off from 300 to 3000 ms
- control (firmware ignores button): led1 stayed off from 300 to 3000 ms

Evidence: `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T5.jsonl`, `reports/p0/2026-10-13T08-17-35-759Z/esp32c3-T5-event-chain.json`

## T6 — Timing: 1000 ms vs 200 ms blink measured from simulated GPIO edge timestamps (esp32c3-devkitm-1): PASS

- 1000 ms firmware: led1: 4 periods, mean 1000 ms (expected 1000 ms ±0.5%), max deviation 0 ms, duty 50.0% (expected 50% ±2%)
- 200 ms firmware:  led1: 10 periods, mean 200 ms (expected 200 ms ±0.5%), max deviation 0 ms, duty 50.0% (expected 50% ±2%)
- tolerance ±0.5%: esp-emu pads sampled every 2000 instructions (≈12.5 µs at 160 MHz); FreeRTOS tick 1 ms

Evidence: `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T6-1000.jsonl`, `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T6-200.jsonl`

## T8 — Virtual UART flashing (esptool ROM protocol → emulated SPI flash → boot from written flash) (esp32c3-devkitm-1): PASS

-   [flash#1] prepare-virtual-device: ok
-   [flash#1] enter-rom-download-mode: ok
-   [flash#1] esptool-connect-chip-id: ok
-   [flash#1] esptool-write-flash: ok
-   [flash#1] esptool-verify-flash: ok
-   [flash#1] esptool-read-back: ok
-   [flash#1] exit-download-mode-persist-flash: ok
-   [flash#1] boot-from-written-flash: ok
- flash#1 success: esptool 4.12.0, transport socket://127.0.0.1:52842, 163840 bytes; before cd3517473707… → after bfba4c90460b…; readback 2efb85bcf5e2…
-   command: -m esptool --chip esp32c3 -p socket://127.0.0.1:52842 --before no_reset --after no_reset --no-stub write_flash --flash_mode dio --flash_size 4MB --flash_freq 80m 0x0 /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/builds/b3_gpio4_blink_1000/bootloader.bin 0x8000 /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/builds/b3_gpio4_blink_1000/partition-table.bin 0x10000 /Users/licochen/Desktop/Project/PlugAI/workspaces/tests/p0-esp32c3/builds/b3_gpio4_blink_1000/plugai_app.bin
-   Booted from written virtual flash: bootloader → app; app reports ELF SHA256 939a56f7c… matching build b3_gpio4_blink_1000; reached app_main()
- running the written virtual flash: led1: 2 periods, mean 1000 ms (expected 1000 ms ±0.5%), max deviation 0 ms
- flash#2 success: before bfba4c90460b… (= after#1: true) → after b253cf0be409…; Booted from written virtual flash: bootloader → app; app reports ELF SHA256 c62c0c27e… matching build b6_gpio4_blink_200; reached app_main()
- re-flashed device now runs: led1: 9 periods, mean 200 ms (expected 200 ms ±0.5%), max deviation 0 ms

Evidence: `workspaces/tests/p0-esp32c3/flashes/flash_3973970c/flash.json`, `workspaces/tests/p0-esp32c3/flashes/flash_3973970c/flash.log`, `workspaces/tests/p0-esp32c3/flashes/flash_02495f0e/flash.json`, `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T8-run-after-flash1.jsonl`, `reports/p0/2026-10-13T08-17-35-759Z/traces/esp32c3-T8-run-after-flash2.jsonl`
