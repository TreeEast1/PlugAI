import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { runTool, checkSourcePolicy } from '@plugai/sandbox';
import type { BuildArtifact, BuildRecord, CompilerDiagnostic } from '@plugai/shared';
import { nowIso } from '@plugai/shared';
import { ESP_PROJECT_NAME, ESP_TEMPLATE, espMainCmake, locateEspToolchain } from './toolchain.ts';

export const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Ensure the platform-managed ESP-IDF scaffolding exists in <project>/firmware. */
export function ensureEspScaffold(projectDir: string, mainSource?: string) {
  const fw = join(projectDir, 'firmware');
  for (const [rel, content] of Object.entries(ESP_TEMPLATE)) {
    const p = join(fw, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    if (!existsSync(p) || readFileSync(p, 'utf8') !== content) writeFileSync(p, content);
  }
  mkdirSync(join(fw, 'main'), { recursive: true });
  const main = join(fw, 'main', 'main.c');
  if (!existsSync(main)) writeFileSync(main, mainSource ?? '');
  const srcs = readdirSync(join(fw, 'main')).filter((f) => /\.(c|cpp)$/.test(f)).sort();
  const cm = join(fw, 'main', 'CMakeLists.txt');
  const content = espMainCmake(srcs);
  if (!existsSync(cm) || readFileSync(cm, 'utf8') !== content) writeFileSync(cm, content);
}

export function parseGccDiagnostics(log: string, root: string): CompilerDiagnostic[] {
  const out: CompilerDiagnostic[] = [];
  const re = /^(.*?):(\d+):(?:(\d+):)?\s+(fatal error|error|warning|note):\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(log))) {
    let file = m[1].trim();
    if (file.startsWith(root)) file = relative(root, file);
    const d: CompilerDiagnostic = { file, line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined, severity: m[4] === 'fatal error' ? 'error' : (m[4] as CompilerDiagnostic['severity']), message: m[5].trim() };
    const k = `${d.file}:${d.line}:${d.column}:${d.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

export function hashSources(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(c|cpp|h|hpp|ino|txt|defaults)$/.test(f) || f === 'CMakeLists.txt') {
        h.update(relative(dir, p));
        h.update(readFileSync(p));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return h.digest('hex');
}

export interface BuildOptions {
  projectId: string;
  projectDir: string;
  buildId: string;
  sourceCommit?: string;
  onLog?: (chunk: string) => void;
  timeoutMs?: number;
}

export async function buildEsp32(opts: BuildOptions): Promise<BuildRecord> {
  const started = Date.now();
  const outDir = join(opts.projectDir, 'builds', opts.buildId);
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, 'build.log');
  const fwDir = join(opts.projectDir, 'firmware');
  const buildDir = join(opts.projectDir, '.build', 'esp32c3');
  const rec: BuildRecord = {
    buildId: opts.buildId,
    projectId: opts.projectId,
    board: 'esp32c3-devkitm-1',
    status: 'running',
    startedAt: nowIso(),
    commands: [],
    toolVersions: [],
    artifacts: [],
    diagnostics: [],
    sourceCommit: opts.sourceCommit,
    sourceHash: '',
    logPath: relative(opts.projectDir, logPath),
  };
  let fullLog = '';
  const log = (s: string) => {
    fullLog += s;
    opts.onLog?.(s);
  };
  const finish = (status: BuildRecord['status'], error?: string) => {
    rec.status = status;
    rec.error = error;
    rec.finishedAt = nowIso();
    rec.durationMs = Date.now() - started;
    rec.logTail = fullLog.slice(-6000);
    writeFileSync(logPath, fullLog);
    writeFileSync(join(outDir, 'build.json'), JSON.stringify(rec, null, 2));
    return rec;
  };
  try {
    const tc = locateEspToolchain();
    rec.toolVersions = tc.versions;
    ensureEspScaffold(opts.projectDir);
    // source policy (no host file inclusion)
    const problems: string[] = [];
    for (const f of readdirSync(join(fwDir, 'main'))) {
      if (/\.(c|cpp|h|hpp)$/.test(f)) problems.push(...checkSourcePolicy(`main/${f}`, readFileSync(join(fwDir, 'main', f), 'utf8')));
    }
    if (problems.length) {
      log(`[plugai] source policy violations:\n${problems.join('\n')}\n`);
      rec.diagnostics = problems.map((p) => ({ file: p.split(':')[0], line: Number(p.split(':')[1]) || 0, severity: 'error', message: p }));
      return finish('failed', 'Source policy violation');
    }
    rec.sourceHash = hashSources(fwDir);
    const idf = join(tc.idfPath, 'tools', 'idf.py');
    const base = ['-C', fwDir, '-B', buildDir];
    const steps: string[][] = [];
    if (!existsSync(join(buildDir, 'CMakeCache.txt')) || !existsSync(join(fwDir, 'sdkconfig'))) steps.push([idf, ...base, 'set-target', 'esp32c3']);
    steps.push([idf, ...base, 'build']);
    steps.push([idf, ...base, 'merge-bin', '-o', 'merged.bin']);
    for (const argv of steps) {
      log(`\n$ idf.py ${argv.slice(1 + base.length).join(' ')}\n`);
      rec.commands.push(['python', ...argv]);
      const r = await runTool({ tool: 'idf-python', args: argv, cwd: opts.projectDir, workspaceRoot: opts.projectDir, env: tc.env, timeoutMs: opts.timeoutMs ?? 420_000, onData: log, cpuSeconds: 1200 });
      if (r.timedOut) return finish('error', `Build step timed out after ${r.durationMs} ms`);
      if (r.exitCode !== 0) {
        rec.diagnostics = parseGccDiagnostics(fullLog, fwDir);
        const cm = fullLog.match(/CMake Error at\s+([^\n]+?):(\d+)[^\n]*\n([\s\S]*?)(?:\n\s*\n|Call Stack)/);
        if (cm) rec.diagnostics.push({ file: cm[1].trim().startsWith(fwDir) ? relative(fwDir, cm[1].trim()) : cm[1].trim(), line: Number(cm[2]), severity: 'error', message: `CMake: ${cm[3].replace(/\s+/g, ' ').trim()}` });
        const ld = fullLog.match(/undefined reference to `([^']+)'/);
        if (ld) rec.diagnostics.push({ file: 'link', line: 0, severity: 'error', message: `linker: undefined reference to ${ld[1]}` });
        const firstErr = rec.diagnostics.find((d) => d.severity === 'error');
        return finish('failed', firstErr ? `${firstErr.file}:${firstErr.line}: ${firstErr.message}` : `idf.py exited with code ${r.exitCode}`);
      }
    }
    rec.diagnostics = parseGccDiagnostics(fullLog, fwDir);
    const files: [string, BuildArtifact['kind'], number | undefined][] = [
      [`${ESP_PROJECT_NAME}.elf`, 'elf', undefined],
      [`${ESP_PROJECT_NAME}.bin`, 'bin', 0x10000],
      ['bootloader/bootloader.bin', 'bootloader', 0x0],
      ['partition_table/partition-table.bin', 'partition-table', 0x8000],
      ['merged.bin', 'merged-bin', 0x0],
      [`${ESP_PROJECT_NAME}.map`, 'map', undefined],
      ['flasher_args.json', 'other', undefined],
    ];
    for (const [rel, kind, off] of files) {
      const src = join(buildDir, rel);
      if (!existsSync(src)) {
        if (kind === 'map' || kind === 'other') continue;
        return finish('error', `Expected artifact missing: ${rel}`);
      }
      const name = rel.split('/').pop()!;
      const dst = join(outDir, name);
      copyFileSync(src, dst);
      rec.artifacts.push({ name, kind, path: relative(opts.projectDir, dst), size: statSync(dst).size, sha256: sha256File(dst), flashOffset: off });
    }
    // validate ELF magic & app image magic
    const elf = readFileSync(join(outDir, `${ESP_PROJECT_NAME}.elf`));
    if (!(elf[0] === 0x7f && elf[1] === 0x45 && elf[2] === 0x4c && elf[3] === 0x46 && elf[18] === 0xf3)) return finish('error', 'Produced ELF is not a RISC-V ELF');
    const app = readFileSync(join(outDir, `${ESP_PROJECT_NAME}.bin`));
    if (app[0] !== 0xe9) return finish('error', 'App image missing ESP image magic 0xE9');
    const m = fullLog.match(/binary size (0x[0-9a-f]+) bytes.*?(0x[0-9a-f]+) bytes \((\d+)%\) free/);
    if (m) rec.sizeInfo = { appBytes: parseInt(m[1], 16), freeBytes: parseInt(m[2], 16), freePct: Number(m[3]) };
    return finish('success');
  } catch (e) {
    log(`\n[plugai] build error: ${(e as Error).message}\n`);
    return finish('error', (e as Error).message);
  }
}
