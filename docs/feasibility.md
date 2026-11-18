# PlugAI — Feasibility study & P0 proof (measured on this machine)

All numbers below were measured on the development machine; the raw evidence lives under `reports/`.

## 0. Host

| Item | Value |
|---|---|
| Machine | Apple M5 Pro, 18 cores, 48 GB, macOS 26.6.2 (arm64) |
| Node / Python | Node 22.20, Python 3.12 (uv) for ESP-IDF; system Python 3.9.6 not used |
| Containers | Docker not installed → isolation via restricted sub-processes (see `architecture.md` §Security) |
| Rosetta 2 | Installed during setup (`softwareupdate --install-rosetta`) because the Arduino AVR GCC 7.3.0 build is x86_64-only |

## 1. Route A — ESP32-C3 + ESP-IDF + Espressif ESP Emulator (selected as primary)

### 1.1 Toolchain

```
git clone -b v5.5.5 --depth 1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git ~/esp/esp-idf   # 1 m 39 s
python3.12 tools/idf_tools.py install --targets esp32c3 required cmake ninja
python3.12 tools/idf_tools.py install-python-env
```
Installed: ESP-IDF v5.5.5, riscv32-esp-elf-gcc 14.2.0 (crosstool-NG esp-14.2.0_20260121), CMake 3.30.2, Ninja 1.12.1, esptool 4.12.0.

### 1.2 Real build

Project with `set(COMPONENTS main)` (only the components `main` needs):

```
idf.py set-target esp32c3     # 10 s
idf.py build                  # 8 s first build, 2-3 s incremental
idf.py merge-bin -o merged.bin
```
Artifacts: `plugai_app.elf` (RISC-V ELF, e_machine 0xF3), `plugai_app.bin` (ESP image, magic 0xE9), `bootloader.bin`, `partition-table.bin`, `merged.bin`, `flasher_args.json`. PlugAI records argv, tool versions and SHA-256 of every artifact (`builds/<id>/build.json`).

Finding: `file(GLOB … CONFIGURE_DEPENDS)` in a component CMakeLists breaks ESP-IDF's requirement-scan pass ("CONFIGURE_DEPENDS is invalid for script and find package modes"); PlugAI therefore regenerates `main/CMakeLists.txt` with an explicit source list on every build.

### 1.3 esp-emu — what it is, licence

* Repository `espressif/esp-emulator`, **Apache-2.0** (`LICENSE` in repo and in the WASM `pkg/package.json`). The Rust source is not public; the repo ships installer, prebuilt binaries, docs and helper tools.
* Version used: **0.48.0** (`esp-emu --version`), native `aarch64-apple-darwin` and the `wasm` release bundle.
* Decision: PlugAI does **not** vendor or modify the binaries. `scripts/setup/setup.sh` downloads the official release assets (SHA256SUMS verified by `install.sh`) into `~/.local/bin/esp-emu` and `third_party/esp-emu-wasm/` (git-ignored). Redistribution as part of a product is permitted by Apache-2.0 if the licence/NOTICE is kept; we still chose download-at-setup to keep provenance clear.

### 1.4 Native CLI run (boots real ROM → 2nd-stage bootloader → app)

```
esp-emu --chip esp32c3 --firmware build/merged.bin --timeout 3s
I (23) main_task: Calling app_main()
PLUGAI_PROBE app_main start
t=23 led=1 btn=1
t=523 led=0 btn=1 …
```
The native CLI exposes UART (stdio / `--uart-tcp`), GDB, control channel and tracing, but **no stable GPIO pad export** — so the native binary alone cannot drive a circuit view.

### 1.5 WASM core under Node — GPIO is observable and injectable (key finding)

`pkg/esp_emu.js` (wasm-bindgen) exports `WasmEmulator` with `run_batch(n) → UART text`, `cycles()`, `cycles_per_us()`, `gpio_state() → [out_lo,out_hi,enable_lo,enable_hi]`, `gpio_set_input(pin, high)`, `read_memory(addr,len)`, `restart()`, `needs_restart()`. It runs headless in Node via `initSync({module: bytes})`.

`scripts/probe/esp-wasm-probe.ts` (`reports/p0/esp-wasm-probe.json`):

| Measurement | Result |
|---|---|
| GPIO4 output-register edges | 12.13 ms (config), then every **500.013 ms** of simulated time |
| `gpio_set_input(5,false)` at 1.2 s | firmware printed `btn=0` at 1512/2012 ms, `btn=1` after release |
| IO_MUX GPIO5 (0x60009018) | `0x1302` → FUN_WPU (bit 8) = internal pull-up visible |
| Speed | 3 s simulated in 124 ms wall (~24× real-time while idle, WFI is skipped) |

PlugAI additionally reads `GPIO_FUNCn_OUT_SEL_CFG` (0x60004554+4n) to detect pads routed to peripherals (LEDC, UART…) and `GPIO_PINn_REG.PAD_DRIVER` (open-drain). Peripheral-routed pads are reported as *not simulated* (Hi-Z + warning) instead of guessing their level.

Edge timing: pads are sampled after every 2000-instruction batch → resolution ≈ 12.5 µs at 160 MHz. Measured blink periods: 1000.00 ms / 200.00 ms, max deviation < 0.05 ms (`reports/p0/LATEST.md`, T6).

### 1.6 Real virtual UART flashing (esptool over `socket://`)

```
esp-emu --chip esp32c3 --firmware device.bin --strap-mode 0x02 \
        --uart-tcp 127.0.0.1:P --control-tcp 127.0.0.1:Q --save-state --net user,restrict=yes
python -m esptool --chip esp32c3 -p socket://127.0.0.1:P --before no_reset --after no_reset --no-stub \
        write_flash --flash_mode dio --flash_size 4MB --flash_freq 80m 0x0 bootloader.bin 0x8000 partition-table.bin 0x10000 plugai_app.bin
… verify_flash …  read_flash 0x10000 <size> readback.bin
kill -INT <esp-emu>      # "Flash state saved to 'device.bin'"
esp-emu --chip esp32c3 --firmware device.bin   # boots the written image
```

Measured: blank 4 MiB flash (SHA `cd3517…`) → after flashing `bfba4c…`; 163 840 bytes written in 3 regions, ROM MD5 "Hash of data verified" ×3, `verify_flash` OK ×3, read-back SHA-256 identical to `plugai_app.bin`; the booted image prints `ELF file SHA256: 939a56f7c…` = SHA of the built ELF and reaches `app_main()`. Re-flashing a second firmware changes the device hash and the behaviour (1000 ms → 200 ms) — `reports/p0/LATEST.md` T8.

Findings / caveats (documented, not hidden):
* **esptool's RAM flasher stub crashes esp-emu 0.48** (`Bus fault: hart0 read32 unmapped 0x3FCE0008`, then "Packet content transfer stopped"). PlugAI uses `--no-stub`, i.e. the mask-ROM serial loader protocol (≈1 Mbit/s writes, 300 kbit/s reads). This is still the real ROM download protocol.
* RTS/DTR cannot be carried over TCP → `--before no_reset --after no_reset` are mandatory; leaving download mode = stopping the emulator (flash persisted by `--save-state`) and booting without `--strap-mode`.
* The emulator process must stay alive for the whole esptool session; SIGINT triggers the flash save.

### 1.7 WASM vs native interface differences

| | Native CLI | WASM (`WasmEmulator`) |
|---|---|---|
| UART | stdio / TCP bridge | returned by `run_batch`, `uart_input()` |
| GPIO pads | not exported | `gpio_state()`, `gpio_set_input()` |
| Flash protocol | `--uart-tcp`, `--strap-mode`, `--save-state` | load image only |
| Pacing | real-time | caller controlled (`throttle_delay_ms` optional) |
| Used by PlugAI for | esptool virtual flashing + boot check | live simulation & verification |

Both run the same Apache-2.0 emulator release (0.48.0). The image produced by the native esptool session is the image loaded into the WASM core, so the live board really runs the bytes esptool wrote.

## 2. Route B — Arduino Uno + arduino-cli + avr8js (kept, fully working)

* `arduino-cli 1.5.2-rc.1`, core `arduino:avr 1.8.8`, `avr-gcc 7.3.0-atmel3.6.1-arduino7` (x86_64 → needs Rosetta on Apple Silicon; first attempt failed with "bad CPU type in executable", fixed by installing Rosetta).
* `avr8js 0.21.1` (MIT, Wokwi): real AVR instruction execution with Timer0/1/2, USART0, PORTB/C/D. Port listeners give cycle-exact edges (62.5 ns). Timer compare outputs drive pins, so `analogWrite` PWM reaches the circuit as real edges.
* Loading: Intel HEX parsed into program memory → labelled **direct image load**, never as serial upload (STK500/Optiboot is not emulated).
* Measured: blink period 1000.02 ms (Arduino `millis()` is Timer0 based, 1.024 ms tick), button → LED latency 2.39 ms (5 ms poll loop).

## 3. Decision

| Requirement | ESP32-C3 (esp-emu) | Uno (avr8js) |
|---|---|---|
| Real cross-compilation | ✓ ESP-IDF 5.5.5 | ✓ avr-gcc 7.3 |
| Real instruction execution | ✓ ROM+bootloader+app | ✓ |
| GPIO output observable | ✓ registers (12.5 µs) | ✓ cycle exact |
| GPIO input injectable | ✓ `gpio_set_input` | ✓ `setPin` |
| UART | ✓ | ✓ |
| Real serial flashing | ✓ esptool ROM protocol (no stub) | ✗ (direct load only) |
| PWM to circuit | ✗ (LEDC pad waveform not exposed) | ✓ |
| Licence | Apache-2.0 | MIT |

**ESP32-C3-DevKitM-1 is the primary board** (full loop incl. real virtual flashing). Arduino Uno is the second, independent backend behind the same `McuCore`/`VirtualHardware` interface. Neither is substituted for the other: the board is fixed per project and shown everywhere in the UI.

## 4. Known limits

* ESP32 PWM (LEDC), RMT/WS2812, ADC, I2C/SPI devices are not available to the circuit → the agent is told so and reports a capability gap instead of faking it.
* ESP32 edges are batch-sampled (≤12.5 µs error); fine for LEDs/buttons, not for µs-level protocols.
* No contact bounce, no analog/SPICE-level transient model (DC operating point per edge).
* Nothing here is physical-hardware verification; all results are labelled "virtual".
