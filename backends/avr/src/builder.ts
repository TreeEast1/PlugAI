import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { allowTool, checkSourcePolicy, runTool } from '@plugai/sandbox';
import type { BuildArtifact, BuildRecord, CompilerDiagnostic, FlashRecord, ToolVersion } from '@plugai/shared';
import { nowIso } from '@plugai/shared';
import { parseIntelHex } from './core.ts';

const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const expandHome = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

let tc: { cli: string; versions: ToolVersion[] } | null = null;

export function locateArduinoCli() {
  if (tc) return tc;
  const candidates = [process.env.ARDUINO_CLI, '~/.local/bin/arduino-cli', '/opt/homebrew/bin/arduino-cli', '/usr/local/bin/arduino-cli'].filter(Boolean).map((p) => expandHome(p!));
  const cli = candidates.find((p) => p.startsWith('/') && existsSync(p));
  if (!cli) throw new Error('arduino-cli not found (set ARDUINO_CLI or run scripts/setup/setup.sh)');
  allowTool('arduino-cli', cli);
  const versions: ToolVersion[] = [{ name: 'arduino-cli', version: execFileSync(cli, ['version'], { encoding: 'utf8' }).trim(), path: cli }];
  try {
    const list = execFileSync(cli, ['core', 'list'], { encoding: 'utf8' });
    const avr = list.split('\n').find((l) => l.startsWith('arduino:avr'));
    if (!avr) throw new Error('arduino:avr core not installed (arduino-cli core install arduino:avr)');
    versions.push({ name: 'arduino:avr core', version: avr.split(/\s+/)[1] });
    const gccDir = join(homedir(), 'Library/Arduino15/packages/arduino/tools/avr-gcc');
    if (existsSync(gccDir)) versions.push({ name: 'avr-gcc', version: readdirSync(gccDir).sort().pop()! });
  } catch (e) {
    throw new Error((e as Error).message);
  }
  tc = { cli, versions };
  return tc;
}

export function avrToolchainStatus() {
  try {
    const t = locateArduinoCli();
    return { ok: true, versions: t.versions };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function parseAvrDiagnostics(log: string, sketchDir: string): CompilerDiagnostic[] {
  const out: CompilerDiagnostic[] = [];
  const re = /^(.*?):(\d+):(?:(\d+):)?\s+(fatal error|error|warning|note):\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log))) {
    let file = m[1].trim();
    if (file.startsWith(sketchDir)) file = 'sketch/' + relative(sketchDir, file);
    out.push({ file, line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined, severity: m[4] === 'fatal error' ? 'error' : (m[4] as CompilerDiagnostic['severity']), message: m[5].trim() });
  }
  return out;
}

export function avrSourceHash(sketchDir: string): string {
  const h = createHash('sha256');
  if (!existsSync(sketchDir)) return h.digest('hex');
  for (const f of readdirSync(sketchDir).sort()) {
    if (!/\.(ino|c|cpp|h|hpp)$/.test(f)) continue;
    h.update(f).update(readFileSync(join(sketchDir, f), 'utf8'));
  }
  return h.digest('hex');
}

export async function buildAvr(opts: { projectId: string; projectDir: string; buildId: string; sourceCommit?: string; onLog?: (s: string) => void }): Promise<BuildRecord> {
  const started = Date.now();
  const outDir = join(opts.projectDir, 'builds', opts.buildId);
  mkdirSync(outDir, { recursive: true });
  const sketchDir = join(opts.projectDir, 'firmware', 'sketch');
  const logPath = join(outDir, 'build.log');
  let fullLog = '';
  const log = (s: string) => {
    fullLog += s;
    opts.onLog?.(s);
  };
  const rec: BuildRecord = {
    buildId: opts.buildId,
    projectId: opts.projectId,
    board: 'arduino-uno',
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
    const t = locateArduinoCli();
    rec.toolVersions = t.versions;
    if (!existsSync(join(sketchDir, 'sketch.ino'))) return finish('failed', 'firmware/sketch/sketch.ino is missing');
    const problems: string[] = [];
    for (const f of readdirSync(sketchDir).sort()) {
      if (!/\.(ino|c|cpp|h|hpp)$/.test(f)) continue;
      problems.push(...checkSourcePolicy(`sketch/${f}`, readFileSync(join(sketchDir, f), 'utf8')));
    }
    rec.sourceHash = avrSourceHash(sketchDir);
    if (problems.length) {
      log(problems.join('\n'));
      rec.diagnostics = problems.map((p) => ({ file: p.split(':')[0], line: Number(p.split(':')[1]) || 0, severity: 'error', message: p }));
      return finish('failed', 'Source policy violation');
    }
    const buildPath = join(opts.projectDir, '.build', 'avr');
    const args = ['compile', '--fqbn', 'arduino:avr:uno', '--build-path', buildPath, '--output-dir', outDir, '--warnings', 'default', '--no-color', sketchDir];
    rec.commands.push([t.cli, ...args]);
    log(`$ arduino-cli ${args.join(' ')}\n`);
    const r = await runTool({ tool: 'arduino-cli', args, cwd: opts.projectDir, workspaceRoot: opts.projectDir, env: { HOME: homedir() }, timeoutMs: 300_000, onData: log });
    rec.diagnostics = parseAvrDiagnostics(fullLog, sketchDir);
    if (r.timedOut) return finish('error', 'Compilation timed out');
    if (r.exitCode !== 0) {
      const e = rec.diagnostics.find((d) => d.severity === 'error');
      return finish('failed', e ? `${e.file}:${e.line}: ${e.message}` : `arduino-cli exited with ${r.exitCode}`);
    }
    for (const [name, kind] of [['sketch.ino.hex', 'hex'], ['sketch.ino.elf', 'elf'], ['sketch.ino.bin', 'bin'], ['sketch.ino.with_bootloader.hex', 'other']] as const) {
      const p = join(outDir, name);
      if (!existsSync(p)) {
        if (kind === 'other' || kind === 'bin') continue;
        return finish('error', `Missing artifact ${name}`);
      }
      rec.artifacts.push({ name, kind: kind as BuildArtifact['kind'], path: relative(opts.projectDir, p), size: statSync(p).size, sha256: sha256File(p) });
    }
    const elf = readFileSync(join(outDir, 'sketch.ino.elf'));
    if (!(elf[0] === 0x7f && elf[1] === 0x45 && elf[18] === 0x53)) return finish('error', 'Produced ELF is not an AVR ELF (e_machine 0x53)');
    parseIntelHex(readFileSync(join(outDir, 'sketch.ino.hex'), 'utf8'));
    const m = fullLog.match(/Sketch uses (\d+) bytes .*?Global variables use (\d+) bytes/s);
    if (m) rec.sizeInfo = { flashBytes: Number(m[1]), ramBytes: Number(m[2]) };
    return finish('success');
  } catch (e) {
    log(`\n[plugai] build error: ${(e as Error).message}\n`);
    return finish('error', (e as Error).message);
  }
}

export function avrDirectLoad(projectId: string, projectDir: string, build: BuildRecord): { record: FlashRecord; image: Uint8Array } {
  const hex = build.artifacts.find((a) => a.kind === 'hex');
  const at = nowIso();
  if (!hex) throw new Error('No HEX artifact');
  const { flash, bytes } = parseIntelHex(readFileSync(join(projectDir, hex.path), 'utf8'));
  const record: FlashRecord = {
    flashId: `load_${randomUUID().slice(0, 8)}`,
    projectId,
    buildId: build.buildId,
    method: 'direct-image-load',
    description: 'Load firmware into simulated flash: the Intel HEX is parsed and written into avr8js program memory. This is NOT a serial bootloader (STK500/Optiboot) upload.',
    status: 'success',
    steps: [{ name: 'parse-hex-into-program-memory', status: 'ok', startedAt: at, durationMs: 0, detail: `${bytes} bytes from ${hex.name} (sha256 ${hex.sha256.slice(0, 12)}…)` }],
    commands: [],
    bytesWritten: bytes,
    verified: false,
    logPath: '',
    startedAt: at,
    finishedAt: at,
    flashImageAfter: { sha256: createHash('sha256').update(flash).digest('hex'), size: flash.length },
  };
  return { record, image: flash };
}
