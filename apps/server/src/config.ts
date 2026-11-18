import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export const ROOT = resolve(import.meta.dirname, '../../..');
loadEnv({ path: resolve(ROOT, '.env'), quiet: true } as any);
process.env.PLUGAI_ROOT ??= ROOT;

export const PORT = Number(process.env.PLUGAI_PORT ?? 8787);
export const DATA_DIR = resolve(ROOT, process.env.PLUGAI_DATA_DIR ?? 'workspaces');
export const PROJECTS_DIR = resolve(DATA_DIR, 'projects');
mkdirSync(PROJECTS_DIR, { recursive: true });
