#!/usr/bin/env bash
# Start PlugAI: API server (127.0.0.1:8787) + web UI (http://127.0.0.1:5173).
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsx scripts/probe/doctor.ts || echo "⚠ some toolchains are missing — run: npm run setup"
trap 'kill 0' EXIT INT TERM
npx tsx apps/server/src/index.ts &
sleep 2
npm --workspace @plugai/web run dev -- --open &
wait
