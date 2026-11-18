# Real vs. virtual — what PlugAI does and does not claim

| Claim in the UI | What actually happened |
|---|---|
| "Build success" | The real cross-compiler (riscv32-esp-elf-gcc / avr-gcc) produced an ELF + image; SHA-256 and argv recorded |
| "Flashed via esptool · virtual UART" (ESP32) | esp-emu ran the ESP32-C3 mask ROM in UART download mode; real esptool 4.12 used the ROM serial protocol over TCP (`socket://`), wrote and MD5-verified each region, `verify_flash` + read-back SHA matched, flash persisted, and the written image booted to `app_main()` with the matching ELF hash |
| "Direct image load" | The image was handed to the emulator as flash contents. No serial protocol. Always labelled this way (Uno is always direct load) |
| LED lit / dark | The circuit solver computed forward current through that LED from the emulated GPIO pad state and the wires you see |
| "虚拟验证通过 / virtual verification passed" | The Verification Engine ran the flashed firmware on a fresh simulated MCU and the physical (GPIO/circuit) checks passed. UART text checks are marked "log only" and can never make a verification pass alone |
| LCD image | Pixels decoded by the ST7735 controller model from real SPI bytes the firmware shifted out; what is shown is the controller's frame memory (black while asleep/DISPOFF, dark without backlight) |
| Case videos / replays ("recorded run replay") | Played back from the run's event log and an emulator recording of the final firmware; time is simulated time; nothing is hand-animated |
| "实体硬件：未连接" | No physical board is connected; PlugAI never shows "physical hardware verified" |

## Known differences from silicon
* ESP32-C3 GPIO edges are sampled every 2000 instructions (≤12.5 µs timestamp error); AVR edges are cycle-exact.
* Emulator timing follows the emulated CPU clock; flash/cache wait-states, analog behaviour, brown-out, contact bounce and EMI are not modelled.
* ESP32 LEDC/RMT/ADC/I2C/SPI peripheral pads are not routed to the virtual circuit (shown as "not simulated").
* esptool runs with `--no-stub` because its RAM stub faults in esp-emu 0.48; on real hardware PlugAI will use the stub (faster).
* The circuit model is a DC operating-point solver, not SPICE.

## What still needs real hardware
Electrical tolerances, timing under real flash cache misses, RF/WiFi/BLE, power consumption, physical button bounce, and any peripheral not listed as simulated in `supported-hardware.md`.
