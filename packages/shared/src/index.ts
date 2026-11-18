// Shared protocol and data types for PlugAI.

export * from './boards.ts';
export * from './circuit-types.ts';
export * from './sim-types.ts';
export * from './scenario.ts';
export * from './agent-types.ts';

export type BoardId = 'esp32c3-devkitm-1' | 'arduino-uno';
export type ChipId = 'esp32c3' | 'atmega328p';
export type BackendId = 'esp32c3-esp-emu-wasm' | 'avr8js';

export interface ToolVersion {
  name: string;
  version: string;
  path?: string;
}

export interface BuildArtifact {
  name: string;
  kind: 'elf' | 'bin' | 'hex' | 'merged-bin' | 'bootloader' | 'partition-table' | 'map' | 'other';
  /** Path relative to the project root. */
  path: string;
  size: number;
  sha256: string;
  /** Flash offset for ESP32 images. */
  flashOffset?: number;
}

export interface CompilerDiagnostic {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

export interface BuildRecord {
  buildId: string;
  projectId: string;
  board: BoardId;
  status: 'running' | 'success' | 'failed' | 'error';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** Commands actually executed (argv, no shell). */
  commands: string[][];
  toolVersions: ToolVersion[];
  artifacts: BuildArtifact[];
  diagnostics: CompilerDiagnostic[];
  /** Git commit of the project sources that were built. */
  sourceCommit?: string;
  sourceHash: string;
  logPath: string;
  logTail?: string;
  error?: string;
  sizeInfo?: Record<string, number>;
}

export type FlashMethod = 'esptool-virtual-uart' | 'direct-image-load';

export interface FlashStep {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
  startedAt: string;
  durationMs: number;
}

export interface FlashRecord {
  flashId: string;
  projectId: string;
  buildId: string;
  method: FlashMethod;
  /** Honest, user-facing description of what actually happened. */
  description: string;
  status: 'success' | 'failed';
  steps: FlashStep[];
  esptoolVersion?: string;
  emulatorVersion?: string;
  transport?: string;
  commands: string[][];
  bytesWritten?: number;
  regions?: { offset: number; size: number; sha256: string; file: string; verified: boolean }[];
  flashImageBefore?: { sha256: string; size: number } | null;
  flashImageAfter?: { sha256: string; size: number };
  readBackSha256?: string;
  verified: boolean;
  bootEvidence?: string;
  logPath: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  board: BoardId;
  createdAt: string;
  updatedAt: string;
  description?: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}
