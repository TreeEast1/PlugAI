#!/usr/bin/env bash
# Build the public, read-only PlugAI site into site/.
#
#   PLUGAI_BASE=/PlugAI/ VITE_REPO_URL=https://github.com/<you>/PlugAI bash scripts/deploy/pages.sh
#
# GitHub Actions sets both from the repository it runs in. The result is a static site:
# landing page, case library, recorded replays and videos. The studio (compilers, emulators,
# the DeepSeek key) is not part of it and keeps running only on your own machine.
set -euo pipefail
cd "$(dirname "$0")/../.."

repo="${GITHUB_REPOSITORY:-}"
if [[ -z "${VITE_REPO_URL:-}" && -n "$repo" ]]; then
  export VITE_REPO_URL="https://github.com/${repo}"
fi
if [[ -z "${PLUGAI_BASE:-}" && -n "$repo" ]]; then
  name="${repo#*/}"
  export PLUGAI_BASE="/${name}/"
fi
export VITE_STATIC=1

echo "building public site  base=${PLUGAI_BASE:-/}  repo=${VITE_REPO_URL:-unset}"
npx tsx scripts/showcase/export-static.ts
npm run build:web

rm -rf site
mkdir -p site/data site/showcase
cp -R apps/web/dist/. site/
cp showcase/public/*.json site/data/
# Only what the pages actually request. Raw run logs stay in the repo, not on the site.
for d in showcase/*/; do
  id="$(basename "$d")"
  [[ "$id" == "public" ]] && continue
  mkdir -p "site/showcase/$id"
  [[ -f "$d/video.webm" ]] && cp "$d/video.webm" "site/showcase/$id/"
  [[ -f "$d/poster.png" ]] && cp "$d/poster.png" "site/showcase/$id/"
  if [[ -d "$d/frames" ]]; then cp -R "$d/frames" "site/showcase/$id/frames"; fi
  if [[ -d "$d/evidence" ]]; then cp -R "$d/evidence" "site/showcase/$id/evidence"; fi
done
# Project sites have no server to rewrite routes, so every app path must still return the app.
cp site/index.html site/404.html
echo "site ready: $(du -sh site | cut -f1) in $(pwd)/site"
