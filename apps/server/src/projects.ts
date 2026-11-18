import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { applyOps, createCircuit } from '@plugai/circuit';
import { BOARDS, nowIso, type BoardId, type Circuit, type ProjectMeta } from '@plugai/shared';
import { checkSourcePolicy } from '@plugai/sandbox';
import { ensureEspScaffold } from '@plugai/backend-esp32';
import { PROJECTS_DIR, ROOT } from './config.ts';

export const SCAFFOLD: Record<BoardId, { path: string; content: string }> = {
  'esp32c3-devkitm-1': {
    path: 'main/main.c',
    content: `// PlugAI project — ESP32-C3-DevKitM-1 (ESP-IDF v5.5).
// Empty starter: describe what you want in the AI Creator, or edit this file directly.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main(void)
{
    printf("PlugAI: empty project\\n");
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
`,
  },
  'arduino-uno': {
    path: 'sketch/sketch.ino',
    content: `// PlugAI project — Arduino Uno (ATmega328P).
// Empty starter: describe what you want in the AI Creator, or edit this file directly.
void setup() {
  Serial.begin(115200);
  Serial.println("PlugAI: empty project");
}

void loop() {
}
`,
  },
};

export interface ProjectMetaExt extends ProjectMeta {
  origin: 'blank' | `example:${string}` | `case:${string}`;
}

const ID_RE = /^p_[a-z0-9]{8}$/;
const PROJECT_GITIGNORE = 'builds/\nflashes/\ndevice/\nruns/\ntraces/\nverifications/\n.build/\nfirmware/build/\nfirmware/sdkconfig.old\n';

function git(dir: string, args: string[]): string {
  return execFileSync('/usr/bin/git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', GIT_AUTHOR_NAME: 'PlugAI', GIT_AUTHOR_EMAIL: 'plugai@localhost', GIT_COMMITTER_NAME: 'PlugAI', GIT_COMMITTER_EMAIL: 'plugai@localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function editablePathOk(board: BoardId, rel: string): string | null {
  const dir = board === 'arduino-uno' ? 'sketch' : 'main';
  const re = board === 'arduino-uno' ? /^sketch\/[A-Za-z0-9_\-]{1,60}\.(ino|c|cpp|h|hpp)$/ : /^main\/[A-Za-z0-9_\-]{1,60}\.(c|cpp|h|hpp)$/;
  if (!re.test(rel)) return `Path "${rel}" is not an editable firmware source. Allowed: ${dir}/<name>.${board === 'arduino-uno' ? '(ino|c|cpp|h|hpp)' : '(c|cpp|h|hpp)'}`;
  if (board === 'arduino-uno' && rel.endsWith('.ino') && rel !== 'sketch/sketch.ino') return 'The sketch must have exactly one .ino file: sketch/sketch.ino';
  return null;
}

export class ProjectStore {
  dir(id: string) {
    if (!ID_RE.test(id)) throw new HttpError(400, `Invalid project id ${id}`);
    const d = join(PROJECTS_DIR, id);
    if (!existsSync(join(d, 'project.json'))) throw new HttpError(404, `Project ${id} not found`);
    return d;
  }

  list(): ProjectMetaExt[] {
    return readdirSync(PROJECTS_DIR)
      .filter((d) => ID_RE.test(d) && existsSync(join(PROJECTS_DIR, d, 'project.json')))
      .map((d) => JSON.parse(readFileSync(join(PROJECTS_DIR, d, 'project.json'), 'utf8')) as ProjectMetaExt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  meta(id: string): ProjectMetaExt {
    return JSON.parse(readFileSync(join(this.dir(id), 'project.json'), 'utf8'));
  }

  touch(id: string) {
    const m = this.meta(id);
    m.updatedAt = nowIso();
    writeFileSync(join(this.dir(id), 'project.json'), JSON.stringify(m, null, 2));
  }

  create(opts: { name: string; board: BoardId; example?: string }): ProjectMetaExt {
    if (!BOARDS[opts.board]) throw new HttpError(400, `Unsupported board ${opts.board}`);
    const id = `p_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const d = join(PROJECTS_DIR, id);
    mkdirSync(join(d, 'firmware'), { recursive: true });
    const meta: ProjectMetaExt = { id, name: opts.name.slice(0, 80) || 'Untitled', board: opts.board, createdAt: nowIso(), updatedAt: nowIso(), origin: opts.example ? `example:${opts.example}` : 'blank' };
    writeFileSync(join(d, 'project.json'), JSON.stringify(meta, null, 2));
    writeFileSync(join(d, '.gitignore'), PROJECT_GITIGNORE);
    this.initFirmware(d, opts.board, opts.example);
    git(d, ['init', '-q']);
    git(d, ['add', '-A']);
    git(d, ['commit', '-q', '-m', opts.example ? `create project from hand-written example "${opts.example}"` : 'create project']);
    return meta;
  }

  private initFirmware(d: string, board: BoardId, example?: string) {
    const short = board === 'arduino-uno' ? 'uno' : 'esp32c3';
    rmSync(join(d, 'firmware'), { recursive: true, force: true });
    mkdirSync(join(d, 'firmware'), { recursive: true });
    let circuit: Circuit = createCircuit(board);
    if (example) {
      const ex = join(ROOT, 'firmware-examples', example, short);
      if (!existsSync(ex)) throw new HttpError(404, `Example ${example} not available for ${board}`);
      const exCircuit = JSON.parse(readFileSync(join(ex, 'circuit.json'), 'utf8'));
      circuit = applyOps(createCircuit(board), exCircuit.ops).circuit;
      if (board === 'arduino-uno') {
        mkdirSync(join(d, 'firmware', 'sketch'), { recursive: true });
        cpSync(join(ex, 'sketch.ino'), join(d, 'firmware', 'sketch', 'sketch.ino'));
      } else {
        mkdirSync(join(d, 'firmware', 'main'), { recursive: true });
        cpSync(join(ex, 'main.c'), join(d, 'firmware', 'main', 'main.c'));
      }
    } else {
      const s = SCAFFOLD[board];
      mkdirSync(join(d, 'firmware', s.path.split('/')[0]), { recursive: true });
      writeFileSync(join(d, 'firmware', s.path), s.content);
    }
    if (board === 'esp32c3-devkitm-1') ensureEspScaffold(d);
    writeFileSync(join(d, 'circuit.json'), JSON.stringify(circuit, null, 2));
  }

  /** Switch an EMPTY project to another board. */
  reinit(id: string, board: BoardId) {
    const d = this.dir(id);
    const m = this.meta(id);
    m.board = board;
    m.updatedAt = nowIso();
    writeFileSync(join(d, 'project.json'), JSON.stringify(m, null, 2));
    rmSync(join(d, '.build'), { recursive: true, force: true });
    rmSync(join(d, 'device'), { recursive: true, force: true });
    this.initFirmware(d, board);
    this.commit(id, `re-initialise project for ${board}`);
  }

  delete(id: string) {
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  circuit(id: string): Circuit {
    return JSON.parse(readFileSync(join(this.dir(id), 'circuit.json'), 'utf8'));
  }

  saveCircuit(id: string, c: Circuit) {
    writeFileSync(join(this.dir(id), 'circuit.json'), JSON.stringify(c, null, 2));
    this.touch(id);
  }

  firmwareRoot(id: string) {
    return join(this.dir(id), 'firmware');
  }

  listFiles(id: string): { path: string; bytes: number; editable: boolean }[] {
    const root = this.firmwareRoot(id);
    const board = this.meta(id).board;
    const out: { path: string; bytes: number; editable: boolean }[] = [];
    const walk = (rel: string) => {
      const abs = join(root, rel);
      if (!existsSync(abs)) return;
      for (const f of readdirSync(abs).sort()) {
        const r = rel ? `${rel}/${f}` : f;
        if (r === 'build' || f.startsWith('.') || r === 'sdkconfig.old') continue;
        const st = statSync(join(root, r));
        if (st.isDirectory()) walk(r);
        else out.push({ path: r, bytes: st.size, editable: editablePathOk(board, r) === null });
      }
    };
    walk('');
    return out;
  }

  readFile(id: string, rel: string): string {
    const root = this.firmwareRoot(id);
    const abs = resolve(root, rel);
    if (!abs.startsWith(root + sep)) throw new HttpError(400, 'Path escapes firmware directory');
    if (!existsSync(abs)) throw new HttpError(404, `File ${rel} not found`);
    if (statSync(abs).size > 1_000_000) throw new HttpError(413, 'File too large');
    return readFileSync(abs, 'utf8');
  }

  writeFile(id: string, rel: string, content: string): { bytes: number; added: number; removed: number } {
    const board = this.meta(id).board;
    const err = editablePathOk(board, rel);
    if (err) throw new HttpError(400, err);
    const policy = checkSourcePolicy(rel, content);
    if (policy.length) throw new HttpError(400, `Source policy violation: ${policy.join('; ')}`);
    const abs = join(this.firmwareRoot(id), rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    const before = existsSync(abs) ? readFileSync(abs, 'utf8').split('\n') : [];
    writeFileSync(abs, content);
    const after = content.split('\n');
    const bs = new Set(before);
    const as = new Set(after);
    this.touch(id);
    return { bytes: Buffer.byteLength(content), added: after.filter((l) => !bs.has(l)).length, removed: before.filter((l) => !as.has(l)).length };
  }

  deleteFile(id: string, rel: string) {
    const board = this.meta(id).board;
    const err = editablePathOk(board, rel);
    if (err) throw new HttpError(400, err);
    if (rel === SCAFFOLD[board].path) throw new HttpError(400, 'The main source file cannot be deleted');
    rmSync(join(this.firmwareRoot(id), rel), { force: true });
  }

  head(id: string): string | null {
    try {
      return git(this.dir(id), ['rev-parse', 'HEAD']);
    } catch {
      return null;
    }
  }

  commit(id: string, message: string): string | null {
    const d = this.dir(id);
    git(d, ['add', '-A']);
    const dirty = git(d, ['status', '--porcelain']);
    if (!dirty) return this.head(id);
    git(d, ['commit', '-q', '-m', message.slice(0, 300)]);
    return this.head(id);
  }

  history(id: string): { commit: string; date: string; message: string; files: string[] }[] {
    const d = this.dir(id);
    const out = git(d, ['log', '--name-only', '--pretty=format:@@%H|%cI|%s', '-n', '200']);
    return out
      .split('@@')
      .filter(Boolean)
      .map((chunk) => {
        const [head, ...files] = chunk.trim().split('\n');
        const [commit, date, ...msg] = head.split('|');
        return { commit, date, message: msg.join('|'), files: files.filter(Boolean) };
      });
  }

  diff(id: string, commit: string): string {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new HttpError(400, 'bad commit');
    return git(this.dir(id), ['show', '--stat', '--patch', '--format=%H %s', commit]).slice(0, 200_000);
  }

  restore(id: string, commit: string): string | null {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new HttpError(400, 'bad commit');
    const d = this.dir(id);
    git(d, ['cat-file', '-e', `${commit}^{commit}`]);
    git(d, ['checkout', commit, '--', 'firmware', 'circuit.json']);
    // remove files that did not exist in that commit
    const tracked = new Set(git(d, ['ls-tree', '-r', '--name-only', commit, 'firmware']).split('\n'));
    for (const f of this.listFiles(id)) if (!tracked.has(`firmware/${f.path}`) && f.editable) rmSync(join(d, 'firmware', f.path), { force: true });
    return this.commit(id, `restore to ${commit.slice(0, 8)}`);
  }

  isEmpty(id: string): boolean {
    const board = this.meta(id).board;
    const c = this.circuit(id);
    if (c.components.length > 1 || c.wires.length) return false;
    const files = this.listFiles(id).filter((f) => f.editable);
    if (files.length !== 1) return false;
    try {
      return this.readFile(id, SCAFFOLD[board].path) === SCAFFOLD[board].content;
    } catch {
      return false;
    }
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
