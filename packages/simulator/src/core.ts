import type { BackendInfo, GpioEdge, McuPinState, SimClock } from '@plugai/shared';

export interface CoreRunResult {
  uart: string;
  edges: GpioEdge[];
  restarted?: string;
  /** Pull / pad-routing configuration changed (needs a circuit re-solve). */
  configChanged?: boolean;
}

/**
 * Synchronous MCU core adapter executed inside the hardware worker thread.
 * Implementations must execute real target machine code; no behavioural shortcuts.
 */
export interface McuCore {
  info: BackendInfo;
  instructions: number;
  init(): Promise<void>;
  load(image: Uint8Array): void;
  reset(): void;
  clock(): SimClock;
  pc(): number;
  pins(): McuPinState[];
  setInput(pin: string, level: 0 | 1 | null): void;
  uartWrite(data: Uint8Array): void;
  /** Run up to maxUs simulated microseconds; may return early after a pad change. */
  run(maxUs: number): CoreRunResult;
  dispose(): void;
  /** Optional: SPI master byte hook (backends that emulate the SPI peripheral). */
  onSpiByte?: ((byte: number, cycles: number) => void) | null;
  /** Optional: fast output level of one pad (null = not driven). */
  pinLevel?(pin: string): 0 | 1 | null;
}

export class UnsupportedError extends Error {
  readonly unsupported = true;
  constructor(feature: string, backend: string) {
    super(`Unsupported: "${feature}" is not supported by backend ${backend}`);
    this.name = 'UnsupportedError';
  }
}
