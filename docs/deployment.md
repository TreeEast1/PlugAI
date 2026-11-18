# Deployment & future physical flashing

## Local (current)
`npm run setup` installs/verifies toolchains, `npm run dev` starts API (127.0.0.1:8787) + UI (127.0.0.1:5173). Production-style: `npm run build:web && npx tsx apps/server/src/index.ts` serves the built UI from the API port.

## Public site (GitHub Pages)
The landing page and case library are static: recorded prompts, firmware, replays and videos. They do not need the API, the compilers or the DeepSeek key, so they can be published for anyone to open. The studio stays local — a public page cannot run ESP-IDF, esp-emu or hold your API key.

Pushing `main` runs `.github/workflows/pages.yml`, which builds `site/` and deploys it. One-time setup on the repository: Settings → Pages → Source: **GitHub Actions**. The site is then at `https://<user>.github.io/<repo>/`.

To preview the exact build locally: `PLUGAI_BASE=/PlugAI/ VITE_REPO_URL=https://github.com/<you>/PlugAI npm run build:site`, then open `site/index.html` through any static server (opening the file directly will not load the JSON).

## Same project on a real board (designed, not yet executed — no board available)

The project directory *is* a standard toolchain project:

### ESP32-C3-DevKitM-1
```
cd workspaces/projects/<id>/firmware
. ~/esp/esp-idf/export.sh
idf.py -B ../.build/esp32c3 -p /dev/cu.usbserial-XXXX flash monitor     # same sources, same sdkconfig
# or flash the exact verified artifacts:
python -m esptool --chip esp32c3 -p /dev/cu.usbserial-XXXX -b 460800 write_flash @../builds/<buildId>/flasher_args.json
```
Differences vs. virtual: default reset (`--before default_reset --after hard_reset`, RTS/DTR available on the CP2102 bridge) and the esptool stub (faster) are used.

### Arduino Uno
```
arduino-cli upload -p /dev/cu.usbmodemXXXX --fqbn arduino:avr:uno --input-dir workspaces/projects/<id>/builds/<buildId>
```
(avrdude, STK500v1 via Optiboot — not emulated in PlugAI.)

### Planned integration
* `PhysicalFlasher` alongside `flashEsp32Virtual` with the same `FlashRecord` (method `esptool-usb-serial` / `avrdude-serial`), port discovery via `esptool --list` / `arduino-cli board list`, same allow-listed sandbox.
* `PhysicalMonitor` streaming the real UART into the Serial tab; results labelled "physical".
* Hardware-in-the-loop verification would need a logic analyser or a test fixture firmware to read GPIOs; until then physical runs are never auto-marked as verified.

## Multi-user hardening (not needed for the local single-user build)
Run builders/emulators in per-job containers (`espressif/idf:v5.5.5`, read-only rootfs, no network, cgroup CPU/mem limits), project storage per tenant, auth in front of the API, secrets in a vault.
