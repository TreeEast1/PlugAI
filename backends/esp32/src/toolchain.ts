import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { allowTool } from '@plugai/sandbox';
import type { ToolVersion } from '@plugai/shared';

export const expandHome = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

export interface EspToolchain {
  idfPath: string;
  idfToolsPath: string;
  pythonEnv: string;
  python: string;
  espEmu: string;
  env: Record<string, string>;
  versions: ToolVersion[];
}

let cached: EspToolchain | null = null;
let cachedError: string | null = null;

function findPythonEnv(toolsPath: string): string | null {
  const dir = join(toolsPath, 'python_env');
  if (!existsSync(dir)) return null;
  const envs = readdirSync(dir).filter((d) => d.startsWith('idf5.5_') && existsSync(join(dir, d, 'bin', 'python')));
  envs.sort();
  return envs.length ? join(dir, envs[envs.length - 1]) : null;
}

export function locateEspToolchain(force = false): EspToolchain {
  if (cached && !force) return cached;
  if (cachedError && !force) throw new Error(cachedError);
  try {
    const idfPath = expandHome(process.env.IDF_PATH ?? '~/esp/esp-idf');
    const idfToolsPath = expandHome(process.env.IDF_TOOLS_PATH ?? '~/.espressif');
    if (!existsSync(join(idfPath, 'tools', 'idf.py'))) throw new Error(`ESP-IDF not found at ${idfPath} (set IDF_PATH or run scripts/setup/setup.sh)`);
    const pythonEnv = expandHome(process.env.IDF_PYTHON_ENV_PATH ?? findPythonEnv(idfToolsPath) ?? '');
    const python = join(pythonEnv, 'bin', 'python');
    if (!existsSync(python)) throw new Error(`ESP-IDF Python environment not found under ${idfToolsPath}/python_env (run idf_tools.py install-python-env)`);
    const espEmu = expandHome(process.env.ESP_EMU_BIN ?? '~/.local/bin/esp-emu');
    const out = execFileSync(python, [join(idfPath, 'tools', 'idf_tools.py'), 'export', '--format', 'key-value'], {
      env: { ...process.env, IDF_PATH: idfPath, IDF_TOOLS_PATH: idfToolsPath, IDF_PYTHON_ENV_PATH: pythonEnv },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const env: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
    env.PATH = (env.PATH ?? '').replace('$PATH', '/usr/bin:/bin:/usr/sbin:/sbin');
    delete env.IDF_DEACTIVATE_FILE_PATH;
    Object.assign(env, {
      IDF_PATH: idfPath,
      IDF_TOOLS_PATH: idfToolsPath,
      IDF_PYTHON_ENV_PATH: pythonEnv,
      IDF_COMPONENT_MANAGER: '0', // no network fetches during builds
      IDF_CCACHE_ENABLE: '0',
      PYTHONDONTWRITEBYTECODE: '1',
    });
    allowTool('idf-python', python);
    if (existsSync(espEmu)) allowTool('esp-emu', espEmu);
    const gcc = env.PATH.split(':').map((d) => join(d, 'riscv32-esp-elf-gcc')).find((p) => existsSync(p));
    if (gcc) allowTool('riscv32-esp-elf-gcc', gcc);
    const versions: ToolVersion[] = [];
    const idfVer = (() => {
      try {
        return readFileSync(join(idfPath, 'version.txt'), 'utf8').trim();
      } catch {
        try {
          return execFileSync('git', ['-C', idfPath, 'describe', '--tags'], { encoding: 'utf8' }).trim();
        } catch {
          return 'unknown';
        }
      }
    })();
    versions.push({ name: 'ESP-IDF', version: idfVer, path: idfPath });
    if (gcc) versions.push({ name: 'riscv32-esp-elf-gcc', version: execFileSync(gcc, ['--version'], { encoding: 'utf8' }).split('\n')[0], path: gcc });
    try {
      versions.push({ name: 'esptool', version: execFileSync(python, ['-m', 'esptool', 'version'], { encoding: 'utf8', env: { ...env } }).trim().split('\n').pop()!, path: python });
    } catch {
      /* optional */
    }
    if (existsSync(espEmu)) {
      try {
        versions.push({ name: 'esp-emu (native)', version: execFileSync(espEmu, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop()!, path: espEmu });
      } catch {
        /* optional */
      }
    }
    cached = { idfPath, idfToolsPath, pythonEnv, python, espEmu, env, versions };
    cachedError = null;
    return cached;
  } catch (e) {
    cachedError = (e as Error).message;
    throw e;
  }
}

export function espToolchainStatus(): { ok: boolean; error?: string; versions?: ToolVersion[]; espEmuNative: boolean } {
  try {
    const t = locateEspToolchain();
    return { ok: true, versions: t.versions, espEmuNative: existsSync(t.espEmu) };
  } catch (e) {
    return { ok: false, error: (e as Error).message, espEmuNative: false };
  }
}

export const ESP_PROJECT_NAME = 'plugai_app';

export const ESP_TEMPLATE = {
  'CMakeLists.txt': `# Managed by PlugAI (ESP-IDF project root). Edit main/ sources instead.
cmake_minimum_required(VERSION 3.16)
# Build only the components required by main (faster, smaller, reproducible).
set(COMPONENTS main)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(${ESP_PROJECT_NAME})
`,
  'sdkconfig.defaults': `# Managed by PlugAI for ESP32-C3-DevKitM-1
CONFIG_IDF_TARGET="esp32c3"
CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y
CONFIG_FREERTOS_HZ=1000
CONFIG_ESP_CONSOLE_UART_DEFAULT=y
CONFIG_ESP_CONSOLE_UART_BAUDRATE=115200
`,
};

export const ESP_MAIN_REQUIRES = ['esp_driver_gpio', 'esp_driver_uart', 'esp_driver_gptimer', 'esp_timer', 'freertos', 'log', 'esp_system', 'esp_rom'];

/** main/CMakeLists.txt is generated from the actual source list (re-configures when files change). */
export function espMainCmake(sources: string[]): string {
  const srcs = sources.length ? sources.map((s) => `"${s}"`).join(' ') : '"main.c"';
  return `# Managed by PlugAI — regenerated on every build from the files in main/.
idf_component_register(SRCS ${srcs}
                       INCLUDE_DIRS "."
                       REQUIRES ${ESP_MAIN_REQUIRES.join(' ')})
`;
}

export const resolveRoot = (...p: string[]) => resolve(...p);
