# Supported hardware (real simulation support only)

## Boards

| Board | Chip | Toolchain | Emulator | Virtual flashing |
|---|---|---|---|---|
| ESP32-C3-DevKitM-1 | ESP32-C3 RV32IMC 160 MHz | ESP-IDF v5.5.5 | esp-emu 0.48.0 (WASM core for run, native for esptool) | esptool ROM protocol over virtual UART **and** direct image load |
| Arduino Uno R3 | ATmega328P 16 MHz | arduino-cli + arduino:avr 1.8.8 | avr8js 0.21.1 | direct image load only |

### ESP32-C3 pins
Usable: GPIO0, 1, 3, 4, 5, 6, 7, 10. Reserved (warning when wired): GPIO2/8/9 (strapping; GPIO8 = onboard WS2812, GPIO9 = BOOT), GPIO18/19 (USB), GPIO20/21 (UART0 console). Power: 3V3 ×2, 5V ×2, GND ×10 (internally common).
Simulated: digital out (`gpio_set_level`), digital in (`gpio_get_level`), internal pull-up/down, open-drain, UART0. **Not simulated to the circuit:** LEDC/PWM pad waveforms, RMT/WS2812, ADC, I2C/SPI devices.

### Arduino Uno pins
Usable: D2–D13, A0–A5 (digital). Reserved: D0/D1 (Serial). Power: 5V, 3.3V, VIN, IOREF, GND ×3.
Simulated: digital in/out, INPUT_PULLUP, timers (millis/delay), Serial, **analogWrite PWM as real pin edges** on D3/5/6/9/10/11, onboard "L" LED (buffered from D13). **Not simulated:** analogRead/ADC, I2C/SPI devices.

## Components

| Type | Pins | Model | Tests |
|---|---|---|---|
| LED (red/yellow/orange/green/blue/white) | A, K | piecewise-linear diode (Vf by colour, Rs 15 Ω), brightness from current, reverse/over-current/missing-resistor warnings | `tests/unit/circuit.test.ts`, P0 T3–T6 |
| Resistor | 1, 2 | linear | unit tests |
| Push button | 1, 2 | ideal switch (0.05 Ω closed), no bounce | P0 T5, e2e demos |
| Traffic-light module | R, Y, G, GND | 3 LEDs + 220 Ω each, common cathode | unit tests, e2e traffic-light demo |
| 1.8" TFT LCD (ST7735, 128×160, RGB565/666) | VCC, GND, CS, RST, DC(A0), SDA, SCK, BL | Uno only. Real SPI bytes from the ATmega328P SPI peripheral (SCK=D13, MOSI=D11 required); CS/DC/RST sampled from the wired GPIOs per byte; commands SWRESET, SLPIN/OUT, INVON/OFF, DISPON/OFF, CASET, RASET, RAMWR, MADCTL (MX/MY/MV/BGR), COLMOD; power-on frame memory = noise; verification captures the glass (`display` check) | `tests/unit/st7735.test.ts`, LCD cases |
| Serial terminal | (UART0) | real UART bytes from the emulator, RX injection | P0 T2 |

Visual-only parts: none are offered. RGB LED / PWM breathing on ESP32 are listed as future work (needs a waveform export for LEDC) and the agent reports them as capability gaps.

## Electrical model limits
DC operating point per edge (no transients/capacitance), ideal rails, GPIO modelled as 40/30 Ω Thevenin (ESP) or 25 Ω (AVR), thresholds 0.25/0.75·VDD (ESP) or 0.3/0.6·VDD (AVR). Floating nets are reported as Z; conflicts (two drivers) and over-voltage on 3.3 V pins are flagged.
