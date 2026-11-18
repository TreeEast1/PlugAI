#!/usr/bin/env bash
# Full acceptance run. Unit + P0 run standalone; LLM and E2E need the server (npm run dev:server) and a DeepSeek key.
set -uo pipefail
cd "$(dirname "$0")/../.."
rc=0
echo "== unit";  npx vitest run tests/unit || rc=1
echo "== P0";    npx tsx scripts/test/p0-acceptance.ts || rc=1
if curl -fs http://127.0.0.1:8787/api/health >/dev/null; then
  echo "== LLM";   npx tsx scripts/test/llm-acceptance.ts || rc=1
  echo "== E2E";   npx tsx scripts/test/e2e-final.ts || rc=1
else
  echo "Server not running — skipping LLM and E2E suites (start it with: npm run dev:server)"; rc=1
fi
npx tsx scripts/test/summarize.ts
exit $rc
