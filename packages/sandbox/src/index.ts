// Restricted tool execution. The agent never supplies commands: builders/flashers call
// runTool() with an allow-listed executable and argv (no shell interpolation).
import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export interface RunToolOptions {
  /** Logical tool name; must be registered in the allow-list. */
  tool: string;
  args: string[];
  cwd: string;
  /** Directory the process is confined to (cwd must be inside). */
  workspaceRoot: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxLogBytes?: number;
  cpuSeconds?: number;
  onData?: (chunk: string) => void;
  /** Keep the process running and return a handle (for long-lived emulators). */
  detached?: boolean;
}

export interface RunToolResult {
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  log: string;
  truncated: boolean;
}

const registry = new Map<string, string>();

/** Register an allow-listed executable (absolute path). */
export function allowTool(name: string, absPath: string) {
  if (!absPath.startsWith('/')) throw new Error(`Tool ${name} must be an absolute path`);
  registry.set(name, absPath);
}

export function toolPath(name: string): string {
  const p = registry.get(name);
  if (!p) throw new Error(`Tool "${name}" is not in the execution allow-list`);
  return p;
}

const SAFE_ENV_KEYS = ['HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'TERM'];
const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|DEEPSEEK|OPENAI|AWS_|GITHUB_)/i;

export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k]!;
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  for (const [k, v] of Object.entries(extra)) {
    if (SECRET_RE.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function inside(child: string, root: string) {
  const c = existsSync(child) ? realpathSync(child) : resolve(child);
  const r = existsSync(root) ? realpathSync(root) : resolve(root);
  return c === r || c.startsWith(r + sep);
}

/** Wrap with /bin/sh only to apply ulimits; argv is passed positionally (never interpolated). */
function wrapped(exe: string, args: string[], cpuSeconds: number): { cmd: string; argv: string[] } {
  const script = `ulimit -t ${Math.floor(cpuSeconds)} 2>/dev/null; ulimit -f 4194304 2>/dev/null; ulimit -c 0 2>/dev/null; exec "$0" "$@"`;
  return { cmd: '/bin/sh', argv: ['-c', script, exe, ...args] };
}

export interface ToolHandle {
  child: ChildProcess;
  argv: string[];
  done: Promise<RunToolResult>;
  kill: (sig?: NodeJS.Signals) => void;
  log: () => string;
}

const live = new Set<ChildProcess>();
function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGTERM') {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* gone */
    }
  }
}
process.on('exit', () => {
  for (const c of live) killTree(c, 'SIGKILL');
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const c of live) killTree(c, 'SIGKILL');
    if (process.listenerCount(sig) === 1) process.exit(130);
  });
}

export function startTool(opts: RunToolOptions): ToolHandle {
  const exe = toolPath(opts.tool);
  if (!inside(opts.cwd, opts.workspaceRoot)) throw new Error(`cwd ${opts.cwd} escapes workspace ${opts.workspaceRoot}`);
  const maxLog = opts.maxLogBytes ?? 2_000_000;
  const { cmd, argv } = wrapped(exe, opts.args, opts.cpuSeconds ?? 900);
  const started = Date.now();
  const child = spawn(cmd, argv, {
    cwd: opts.cwd,
    env: scrubbedEnv(opts.env),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  live.add(child);
  let log = '';
  let truncated = false;
  let timedOut = false;
  const onChunk = (b: Buffer) => {
    const s = b.toString('utf8');
    opts.onData?.(s);
    if (log.length < maxLog) log += s.slice(0, maxLog - log.length);
    else truncated = true;
  };
  child.stdout!.on('data', onChunk);
  child.stderr!.on('data', onChunk);
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGTERM');
        setTimeout(() => killTree(child, 'SIGKILL'), 3000);
      }, opts.timeoutMs)
    : null;
  const done = new Promise<RunToolResult>((resolveP) => {
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      live.delete(child);
      resolveP({
        argv: [exe, ...opts.args],
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        log: truncated ? log + `\n[log truncated at ${maxLog} bytes]` : log,
        truncated,
      });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      live.delete(child);
      resolveP({ argv: [exe, ...opts.args], exitCode: -1, signal: null, timedOut, durationMs: Date.now() - started, log: log + `\n[spawn error] ${err.message}`, truncated });
    });
  });
  return { child, argv: [exe, ...opts.args], done, kill: (sig = 'SIGTERM') => killTree(child, sig), log: () => log };
}

export async function runTool(opts: RunToolOptions): Promise<RunToolResult> {
  return startTool(opts).done;
}

/** Reject source constructs that could read host files at compile time. */
export function checkSourcePolicy(path: string, content: string): string[] {
  const problems: string[] = [];
  const lines = content.split('\n');
  lines.forEach((l, i) => {
    const inc = l.match(/^\s*#\s*(include|include_next|import)\s*[<"]([^>"]+)[>"]/);
    if (inc) {
      const target = inc[2];
      if (target.startsWith('/') || target.includes('..') || /^[A-Za-z]:\\/.test(target)) problems.push(`${path}:${i + 1}: include of "${target}" is outside the project sandbox`);
    }
    if (/\.incbin|\.include\s+"\//.test(l)) problems.push(`${path}:${i + 1}: assembler file inclusion (.incbin/.include) is not allowed`);
    if (/__has_include\s*\(\s*["<]\//.test(l)) problems.push(`${path}:${i + 1}: absolute __has_include is not allowed`);
  });
  if (content.length > 400_000) problems.push(`${path}: file too large (${content.length} bytes, max 400000)`);
  return problems;
}

export const SOURCE_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_\-./]{0,120}$/;
