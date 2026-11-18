import { describe, expect, it } from 'vitest';
import { checkSourcePolicy, scrubbedEnv, allowTool, runTool } from '@plugai/sandbox';
import { editablePathOk } from '../../apps/server/src/projects.ts';
import { tmpdir } from 'node:os';

describe('sandbox & policy', () => {
  it('rejects host-file inclusion tricks', () => {
    expect(checkSourcePolicy('main/x.c', '#include "/etc/passwd"').length).toBe(1);
    expect(checkSourcePolicy('main/x.c', '#include "../../secret.h"').length).toBe(1);
    expect(checkSourcePolicy('main/x.c', 'asm(".incbin \\"/etc/hosts\\"");').length).toBe(1);
    expect(checkSourcePolicy('main/x.c', '#include "driver/gpio.h"\n#include <stdio.h>').length).toBe(0);
  });
  it('scrubs secrets from child environments', () => {
    const env = scrubbedEnv({ DEEPSEEK_API_KEY: 'sk-x', MY_TOKEN: 't', IDF_PATH: '/x' });
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.MY_TOKEN).toBeUndefined();
    expect(env.IDF_PATH).toBe('/x');
  });
  it('only allow-listed tools run, argv is not shell-interpreted, timeouts kill', async () => {
    await expect(runTool({ tool: 'not-registered', args: [], cwd: tmpdir(), workspaceRoot: tmpdir() })).rejects.toThrow(/allow-list/);
    allowTool('echo-test', '/bin/echo');
    const r = await runTool({ tool: 'echo-test', args: ['$(whoami); rm -rf /'], cwd: tmpdir(), workspaceRoot: tmpdir() });
    expect(r.log.trim()).toBe('$(whoami); rm -rf /');
    allowTool('sleep-test', '/bin/sleep');
    const t = await runTool({ tool: 'sleep-test', args: ['5'], cwd: tmpdir(), workspaceRoot: tmpdir(), timeoutMs: 300 });
    expect(t.timedOut).toBe(true);
    await expect(runTool({ tool: 'echo-test', args: [], cwd: '/etc', workspaceRoot: tmpdir() })).rejects.toThrow(/escapes/);
  });
  it('limits editable firmware paths', () => {
    expect(editablePathOk('esp32c3-devkitm-1', 'main/main.c')).toBeNull();
    expect(editablePathOk('esp32c3-devkitm-1', 'main/CMakeLists.txt')).not.toBeNull();
    expect(editablePathOk('esp32c3-devkitm-1', '../x.c')).not.toBeNull();
    expect(editablePathOk('arduino-uno', 'sketch/sketch.ino')).toBeNull();
    expect(editablePathOk('arduino-uno', 'sketch/other.ino')).not.toBeNull();
  });
});
