// Build the read-only data the public site needs, without the local API server.
// Writes showcase/public/{cases,proof,boards}.json. Case firmware, replays and videos stay
// where they are (showcase/<id>/) and are published next to the site.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalog, boardGeometry, COMPONENT_TYPES } from '@plugai/circuit';
import { BOARDS } from '@plugai/shared';
import { listCases, proof, readCase, SHOWCASE_DIR } from '../../apps/server/src/cases.ts';

const outDir = join(SHOWCASE_DIR, 'public');
mkdirSync(outDir, { recursive: true });

const summaries = listCases();
writeFileSync(join(outDir, 'cases.json'), JSON.stringify(summaries));

const full: Record<string, unknown> = {};
for (const c of summaries) full[c.id] = readCase(c.id);
writeFileSync(join(outDir, 'cases-full.json'), JSON.stringify(full));

writeFileSync(join(outDir, 'proof.json'), JSON.stringify({ ...proof(), cases: summaries.length }));

writeFileSync(
  join(outDir, 'boards.json'),
  JSON.stringify({
    boards: Object.values(BOARDS).map((b) => ({ ...b, geometry: boardGeometry(b) })),
    components: catalog().map((c) => ({
      ...c,
      size: COMPONENT_TYPES[c.type as keyof typeof COMPONENT_TYPES].size,
      pinPos: COMPONENT_TYPES[c.type as keyof typeof COMPONENT_TYPES].pinPos,
    })),
  }),
);

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
console.log(
  `static site data: ${summaries.length} cases, ` +
    `cases.json ${kb(Buffer.byteLength(JSON.stringify(summaries)))}, ` +
    `cases-full.json ${kb(Buffer.byteLength(JSON.stringify(full)))}`,
);
