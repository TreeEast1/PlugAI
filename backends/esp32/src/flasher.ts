// Real virtual serial flashing: esp-emu boots the ESP32-C3 mask ROM in UART download mode
// (--strap-mode 0x02) with UART0 bridged to TCP; the real esptool talks the ROM serial
// protocol over socket://, writes/verifies/reads the emulated SPI flash, and the emulator
// persists the flash (--save-state). The written flash is then booted to prove it runs.
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { runTool, startTool } from '@plugai/sandbox';
import type { BuildRecord, FlashRecord, FlashStep } from '@plugai/shared';
import { nowIso } from '@plugai/shared';
import { locateEspToolchain } from './toolchain.ts';

const FLASH_SIZE = 4 * 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function deviceFlashPath(projectDir: string) {
  return join(projectDir, 'device', 'esp32c3-flash.bin');
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

export interface FlashOptions {
  projectId: string;
  projectDir: string;
  build: BuildRecord;
  onProgress?: (step: string, status: string, detail?: string) => void;
}

export async function flashEsp32Virtual(opts: FlashOptions): Promise<FlashRecord> {
  const tc = locateEspToolchain();
  const flashId = `flash_${randomUUID().slice(0, 8)}`;
  const dir = join(opts.projectDir, 'flashes', flashId);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'flash.log');
  const startedAt = nowIso();
  let fullLog = '';
  const log = (s: string) => {
    fullLog += s;
  };
  const steps: FlashStep[] = [];
  const commands: string[][] = [];
  const rec: FlashRecord = {
    flashId,
    projectId: opts.projectId,
    buildId: opts.build.buildId,
    method: 'esptool-virtual-uart',
    description: 'Real virtual serial flashing: esptool ROM-loader protocol over a TCP-bridged virtual UART0 into the emulated SPI flash (ESP32-C3 in UART download mode).',
    status: 'failed',
    steps,
    commands,
    transport: '',
    verified: false,
    logPath: relative(opts.projectDir, logPath),
    startedAt,
    finishedAt: startedAt,
  };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    const at = nowIso();
    opts.onProgress?.(name, 'running');
    try {
      const r = await fn();
      steps.push({ name, status: 'ok', startedAt: at, durationMs: Date.now() - t, detail: typeof r === 'string' ? r : undefined });
      opts.onProgress?.(name, 'ok', typeof r === 'string' ? r : undefined);
      return r;
    } catch (e) {
      steps.push({ name, status: 'failed', startedAt: at, durationMs: Date.now() - t, detail: (e as Error).message });
      opts.onProgress?.(name, 'failed', (e as Error).message);
      throw e;
    }
  };
  const finish = (ok: boolean, error?: string) => {
    rec.status = ok ? 'success' : 'failed';
    rec.error = error;
    rec.finishedAt = nowIso();
    writeFileSync(logPath, fullLog);
    writeFileSync(join(dir, 'flash.json'), JSON.stringify(rec, null, 2));
    return rec;
  };

  const art = (kind: string) => opts.build.artifacts.find((a) => a.kind === kind);
  const boot = art('bootloader');
  const pt = art('partition-table');
  const app = art('bin');
  const elf = art('elf');
  if (opts.build.status !== 'success' || !boot || !pt || !app || !elf) return finish(false, 'Build is not successful or artifacts are missing — nothing to flash');
  if (!existsSync(tc.espEmu)) return finish(false, `Native esp-emu not found at ${tc.espEmu}; virtual UART flashing requires it`);

  const devPath = deviceFlashPath(opts.projectDir);
  mkdirSync(join(devPath, '..'), { recursive: true });
  let emu: ReturnType<typeof startTool> | null = null;
  try {
    rec.flashImageBefore = await step('prepare-virtual-device', async () => {
      if (!existsSync(devPath)) writeFileSync(devPath, Buffer.alloc(FLASH_SIZE, 0xff));
      const b = readFileSync(devPath);
      return { sha256: sha(b), size: b.length };
    });
    const uartPort = await freePort();
    const ctlPort = await freePort();
    rec.transport = `socket://127.0.0.1:${uartPort}`;
    const emuArgs = ['--chip', 'esp32c3', '--firmware', devPath, '--strap-mode', '0x02', '--uart-tcp', `127.0.0.1:${uartPort}`, '--control-tcp', `127.0.0.1:${ctlPort}`, '--save-state', '--net', 'user,restrict=yes'];
    commands.push([tc.espEmu, ...emuArgs]);
    const emuVer = tc.versions.find((v) => v.name.startsWith('esp-emu'))?.version;
    rec.emulatorVersion = emuVer;
    await step('enter-rom-download-mode', async () => {
      let emuLog = '';
      emu = startTool({ tool: 'esp-emu', args: emuArgs, cwd: opts.projectDir, workspaceRoot: opts.projectDir, onData: (s) => {
        emuLog += s;
        log(`[esp-emu] ${s}`);
      }, timeoutMs: 180_000 });
      const t0 = Date.now();
      while (!/UART TCP server listening/.test(emuLog)) {
        if (Date.now() - t0 > 15_000) throw new Error('esp-emu did not open the virtual UART');
        if (emu.child.exitCode !== null) throw new Error(`esp-emu exited early: ${emuLog.slice(-400)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!/download mode/.test(emuLog)) throw new Error('Emulator did not report ROM download mode');
      return 'ROM entered UART download mode (GPIO_STRAP=0x02); UART0 bridged to TCP';
    });

    const esptoolBase = ['-m', 'esptool', '--chip', 'esp32c3', '-p', rec.transport, '--before', 'no_reset', '--after', 'no_reset', '--no-stub'];
    const flasherArgs = JSON.parse(readFileSync(join(opts.projectDir, 'builds', opts.build.buildId, 'flasher_args.json'), 'utf8'));
    const fs = flasherArgs.flash_settings ?? { flash_mode: 'dio', flash_size: '4MB', flash_freq: '80m' };
    const abs = (a: { path: string }) => join(opts.projectDir, a.path);
    const esptool = async (args: string[], label: string) => {
      const argv = [...esptoolBase, ...args];
      commands.push(['python', ...argv]);
      log(`\n$ python ${argv.join(' ')}\n`);
      const r = await runTool({ tool: 'idf-python', args: argv, cwd: opts.projectDir, workspaceRoot: opts.projectDir, env: tc.env, timeoutMs: 120_000, onData: log });
      if (r.exitCode !== 0) throw new Error(`${label} failed (exit ${r.exitCode}): ${r.log.split('\n').filter((l) => /error|Error|fatal/.test(l)).slice(-3).join(' | ') || r.log.slice(-300)}`);
      return r.log;
    };
    const ver = await runTool({ tool: 'idf-python', args: ['-m', 'esptool', 'version'], cwd: opts.projectDir, workspaceRoot: opts.projectDir, env: tc.env, timeoutMs: 30_000 });
    rec.esptoolVersion = ver.log.trim().split('\n').pop();

    await step('esptool-connect-chip-id', async () => {
      const out = await esptool(['chip_id'], 'chip_id');
      const chip = out.match(/Chip is (.*)/)?.[1];
      if (!chip || !/ESP32-C3/.test(chip)) throw new Error(`Unexpected chip: ${chip}`);
      return `Detected ${chip}; MAC ${out.match(/MAC: (\S+)/)?.[1] ?? '?'}`;
    });
    const regions = [
      { offset: boot.flashOffset!, a: boot },
      { offset: pt.flashOffset!, a: pt },
      { offset: app.flashOffset!, a: app },
    ];
    await step('esptool-write-flash', async () => {
      const args = ['write_flash', '--flash_mode', fs.flash_mode, '--flash_size', fs.flash_size, '--flash_freq', fs.flash_freq];
      for (const r of regions) args.push(`0x${r.offset.toString(16)}`, abs(r.a));
      const out = await esptool(args, 'write_flash');
      const wrote = [...out.matchAll(/Wrote (\d+) bytes/g)].map((m) => Number(m[1]));
      const verified = (out.match(/Hash of data verified/g) ?? []).length;
      if (wrote.length !== regions.length || verified !== regions.length) throw new Error(`write_flash reported ${wrote.length} writes / ${verified} hash checks for ${regions.length} regions`);
      rec.bytesWritten = wrote.reduce((a, b) => a + b, 0);
      return `Wrote ${rec.bytesWritten} bytes in ${regions.length} regions; device MD5 verified for each region`;
    });
    await step('esptool-verify-flash', async () => {
      const args = ['verify_flash'];
      for (const r of regions) args.push(`0x${r.offset.toString(16)}`, abs(r.a));
      const out = await esptool(args, 'verify_flash');
      const ok = (out.match(/verify OK/g) ?? []).length;
      if (ok !== regions.length) throw new Error(`verify_flash OK for ${ok}/${regions.length} regions`);
      return `verify_flash: ${ok}/${regions.length} regions digest matched`;
    });
    await step('esptool-read-back', async () => {
      const rb = join(dir, 'readback-app.bin');
      await esptool(['read_flash', `0x${app.flashOffset!.toString(16)}`, String(app.size), rb], 'read_flash');
      rec.readBackSha256 = sha(readFileSync(rb));
      if (rec.readBackSha256 !== app.sha256) throw new Error(`read-back SHA256 ${rec.readBackSha256} != app ${app.sha256}`);
      return `read_flash ${app.size} bytes @0x${app.flashOffset!.toString(16)}: SHA256 matches app image`;
    });
    rec.regions = regions.map((r) => ({ offset: r.offset, size: r.a.size, sha256: r.a.sha256, file: r.a.name, verified: true }));
    await step('exit-download-mode-persist-flash', async () => {
      const h = emu!;
      h.kill('SIGINT');
      const res = await h.done;
      emu = null;
      if (!/Flash state saved/.test(res.log)) throw new Error('Emulator did not persist flash state');
      return 'Emulator stopped; flash persisted to virtual device image';
    });
    rec.flashImageAfter = (() => {
      const b = readFileSync(devPath);
      return { sha256: sha(b), size: b.length };
    })();
    // independent check of the persisted image contents
    const img = readFileSync(devPath);
    for (const r of regions) {
      const data = readFileSync(abs(r.a));
      if (sha(img.subarray(r.offset, r.offset + data.length)) !== r.a.sha256) return finish(false, `Persisted flash region @0x${r.offset.toString(16)} does not match ${r.a.name}`);
    }
    await step('boot-from-written-flash', async () => {
      const args = ['--chip', 'esp32c3', '--firmware', devPath, '--timeout', '5s', '--exit-on', 'main_task: Calling app_main()', '--net', 'user,restrict=yes'];
      commands.push([tc.espEmu, ...args]);
      const r = await runTool({ tool: 'esp-emu', args, cwd: opts.projectDir, workspaceRoot: opts.projectDir, timeoutMs: 30_000 });
      writeFileSync(join(dir, 'boot.log'), r.log);
      log(`\n[boot check]\n${r.log.slice(-3000)}`);
      const elfPrefix = r.log.match(/ELF file SHA256:\s+([0-9a-f]+)/)?.[1];
      if (!/Calling app_main\(\)/.test(r.log)) throw new Error('Written firmware did not reach app_main()');
      if (!elfPrefix || !elf.sha256.startsWith(elfPrefix)) throw new Error(`Booted image ELF SHA256 prefix ${elfPrefix} does not match built ELF ${elf.sha256.slice(0, 12)}`);
      rec.bootEvidence = `Booted from written virtual flash: bootloader → app; app reports ELF SHA256 ${elfPrefix}… matching build ${opts.build.buildId}; reached app_main()`;
      return rec.bootEvidence;
    });
    rec.verified = true;
    return finish(true);
  } catch (e) {
    if (emu) (emu as ReturnType<typeof startTool>).kill('SIGKILL');
    return finish(false, (e as Error).message);
  }
}

export function directLoadRecord(projectId: string, projectDir: string, build: BuildRecord): FlashRecord {
  const merged = build.artifacts.find((a) => a.kind === 'merged-bin')!;
  const at = nowIso();
  return {
    flashId: `load_${randomUUID().slice(0, 8)}`,
    projectId,
    buildId: build.buildId,
    method: 'direct-image-load',
    description: 'Direct image load: the merged flash image is handed to the emulator as its SPI flash contents (no serial download protocol involved).',
    status: 'success',
    steps: [{ name: 'load-merged-image', status: 'ok', startedAt: at, durationMs: 0, detail: `${merged.name} (${merged.size} bytes, sha256 ${merged.sha256.slice(0, 12)}…)` }],
    commands: [],
    verified: false,
    logPath: '',
    startedAt: at,
    finishedAt: at,
    flashImageAfter: { sha256: merged.sha256, size: statSync(join(projectDir, merged.path)).size },
  };
}
