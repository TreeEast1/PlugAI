#!/usr/bin/env bash
# PlugAI one-shot setup: Node deps + real embedded toolchains + emulators.
# Idempotent. Large downloads (ESP-IDF ≈ 1.5 GB incl. toolchain) cannot be skipped if you want the ESP32 backend.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
IDF_VERSION="${IDF_VERSION:-v5.5.5}"
ESP_EMU_VERSION="${ESP_EMU_VERSION:-0.48.0}"
IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf}"
export IDF_TOOLS_PATH="${IDF_TOOLS_PATH:-$HOME/.espressif}"
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

say "Host: $(uname -sm)"
command -v node >/dev/null || { echo "Node.js >= 20 is required"; exit 1; }
command -v git >/dev/null || { echo "git is required"; exit 1; }

say "Node dependencies"
npm install

# ---------------------------------------------------------------- Python for ESP-IDF
PY="${PLUGAI_PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.13 python3.12 python3.11 python3.10; do command -v $c >/dev/null && PY=$(command -v $c) && break; done
fi
if [ -z "$PY" ] && command -v uv >/dev/null; then uv python install 3.12 && PY=$(uv python find 3.12); fi
[ -n "$PY" ] || { echo "Python >= 3.10 required for ESP-IDF (install uv: https://docs.astral.sh/uv/)"; exit 1; }
echo "Python for ESP-IDF: $PY ($($PY --version))"

# ---------------------------------------------------------------- ESP-IDF
if [ ! -f "$IDF_PATH/tools/idf.py" ]; then
  say "Cloning ESP-IDF $IDF_VERSION into $IDF_PATH"
  mkdir -p "$(dirname "$IDF_PATH")"
  git clone -b "$IDF_VERSION" --depth 1 --recursive --shallow-submodules --jobs 8 https://github.com/espressif/esp-idf.git "$IDF_PATH"
fi
say "ESP-IDF tools for esp32c3"
"$PY" "$IDF_PATH/tools/idf_tools.py" install --targets esp32c3 required cmake ninja
"$PY" "$IDF_PATH/tools/idf_tools.py" install-python-env

# ---------------------------------------------------------------- esp-emu (native + WASM)
if ! "$BIN/esp-emu" --version 2>/dev/null | grep -q "$ESP_EMU_VERSION"; then
  say "Installing esp-emu $ESP_EMU_VERSION (Apache-2.0, official release)"
  curl -fsSL https://raw.githubusercontent.com/espressif/esp-emulator/main/install.sh | sh -s -- --version "$ESP_EMU_VERSION" --bin-dir "$BIN"
fi
if [ ! -f "$ROOT/third_party/esp-emu-wasm/pkg/esp_emu_bg.wasm" ] || ! grep -q "$ESP_EMU_VERSION" "$ROOT/third_party/esp-emu-wasm/VERSION" 2>/dev/null; then
  say "Downloading esp-emu $ESP_EMU_VERSION WASM bundle"
  T=$(mktemp -d)
  curl -fsSL -o "$T/wasm.tgz" "https://github.com/espressif/esp-emulator/releases/download/v$ESP_EMU_VERSION/esp-emu-$ESP_EMU_VERSION-wasm.tar.gz"
  curl -fsSL -o "$T/SHA256SUMS" "https://github.com/espressif/esp-emulator/releases/download/v$ESP_EMU_VERSION/SHA256SUMS" || true
  if [ -s "$T/SHA256SUMS" ]; then (cd "$T" && grep "wasm.tar.gz" SHA256SUMS | sed "s#esp-emu-$ESP_EMU_VERSION-wasm.tar.gz#wasm.tgz#" | shasum -a 256 -c -); fi
  tar -xzf "$T/wasm.tgz" -C "$T"
  rm -rf "$ROOT/third_party/esp-emu-wasm" && mkdir -p "$ROOT/third_party/esp-emu-wasm"
  cp -R "$T/esp-emu-$ESP_EMU_VERSION-wasm/www/pkg" "$ROOT/third_party/esp-emu-wasm/pkg"
  echo "$ESP_EMU_VERSION" > "$ROOT/third_party/esp-emu-wasm/VERSION"
fi

# ---------------------------------------------------------------- Arduino CLI + AVR core
if ! command -v arduino-cli >/dev/null && [ ! -x "$BIN/arduino-cli" ]; then
  say "Installing arduino-cli"
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) A=macOS_ARM64 ;; Darwin-x86_64) A=macOS_64bit ;; Linux-x86_64) A=Linux_64bit ;; Linux-aarch64) A=Linux_ARM64 ;; *) echo "unsupported host"; exit 1 ;;
  esac
  T=$(mktemp -d); curl -fsSL -o "$T/a.tgz" "https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_${A}.tar.gz"; tar -xzf "$T/a.tgz" -C "$T"; mv "$T/arduino-cli" "$BIN/"
fi
ACLI=$(command -v arduino-cli || echo "$BIN/arduino-cli")
"$ACLI" core update-index
"$ACLI" core list | grep -q '^arduino:avr' || "$ACLI" core install arduino:avr
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] && ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  say "Apple Silicon: avr-gcc 7.3 from arduino:avr is x86_64 — installing Rosetta 2"
  softwareupdate --install-rosetta --agree-to-license
fi

# ---------------------------------------------------------------- .env
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"; chmod 600 "$ROOT/.env"
  echo "Created .env — put your DeepSeek key into DEEPSEEK_API_KEY (never commit it)."
fi

say "Doctor"
npx tsx scripts/probe/doctor.ts
