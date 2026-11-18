import { z } from 'zod';

/**
 * Verification scenario: the model may *propose* one, but only the deterministic
 * Verification Engine evaluates it against recorded simulator/circuit traces.
 * All times are simulated milliseconds since MCU reset.
 */
export const StimulusSchema = z.object({
  at_ms: z.number().min(0),
  component: z.string().describe('component_id of a button'),
  action: z.enum(['press', 'release']),
});

const OnOff = z.enum(['on', 'off']);

export const CheckSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state_during'),
    component: z.string().describe('component_id, or component_id:channel for traffic-light (e.g. tl1:red)'),
    state: OnOff,
    from_ms: z.number().min(0),
    to_ms: z.number().min(0),
    glitch_ms: z.number().min(0).max(50).default(1).describe('ignore pulses / combined states shorter than this (ms)'),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('period'),
    component: z.string(),
    period_ms: z.number().positive(),
    tolerance_pct: z.number().min(0).max(50).default(5),
    duty: z.number().min(0).max(1).optional(),
    duty_tolerance: z.number().min(0).max(0.5).default(0.1),
    from_ms: z.number().min(0).optional(),
    min_cycles: z.number().int().min(1).default(2),
    glitch_ms: z.number().min(0).max(50).default(1).describe('ignore pulses / combined states shorter than this (ms)'),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('pattern'),
    components: z.array(z.string()).min(1),
    segments: z
      .array(
        z.object({
          states: z.record(OnOff).describe('map component -> on/off for every listed component'),
          duration_ms: z.number().positive(),
        }),
      )
      .min(1),
    cyclic: z.boolean().default(true),
    min_repeats: z.number().int().min(1).default(1),
    tolerance_ms: z.number().min(0).default(30),
    tolerance_pct: z.number().min(0).max(50).default(3),
    from_ms: z.number().min(0).optional(),
    glitch_ms: z.number().min(0).max(50).default(1).describe('ignore pulses / combined states shorter than this (ms)'),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('toggle_count'),
    component: z.string(),
    min: z.number().int().min(0),
    max: z.number().int().min(0).optional(),
    from_ms: z.number().min(0),
    to_ms: z.number().min(0),
    glitch_ms: z.number().min(0).max(50).default(1).describe('ignore pulses / combined states shorter than this (ms)'),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('display'),
    component: z.string().describe('component_id of an LCD'),
    at_ms: z.number().min(0).describe('simulated time at which the frame is captured'),
    on: z.boolean().default(true).describe('display must be powered, awake, DISPON and backlit'),
    min_nonblack_pct: z.number().min(0).max(100).optional(),
    max_nonblack_pct: z.number().min(0).max(100).optional(),
    colors: z.array(z.object({ hex: z.string().regex(/^#?[0-9a-fA-F]{6}$/), min_pct: z.number().min(0).max(100), tolerance: z.number().min(0).max(255).default(60) })).default([]),
    region: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1), h: z.number().int().min(1) }).optional(),
    changed_since_ms: z.number().min(0).optional().describe('frame must differ from the frame captured at this earlier time (animation)'),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('uart_contains'),
    text: z.string(),
    description: z.string().optional(),
  }),
]);

export const ScenarioSchema = z.object({
  name: z.string(),
  duration_ms: z.number().min(100).max(60_000),
  stimuli: z.array(StimulusSchema).default([]),
  checks: z.array(CheckSchema).min(1),
});

export type Stimulus = z.infer<typeof StimulusSchema>;
export type Check = z.infer<typeof CheckSchema>;
export type CheckInput = z.input<typeof CheckSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

export interface CheckResult {
  check: Check;
  passed: boolean;
  /** True when the check only inspects UART text (not physical evidence). */
  logOnly: boolean;
  detail: string;
  measured?: Record<string, unknown>;
}

export interface VerificationReport {
  verificationId: string;
  scenario: Scenario;
  passed: boolean;
  physicalChecks: number;
  /** "virtual" — never claims physical-hardware verification. */
  scope: 'virtual-simulation';
  results: CheckResult[];
  buildId?: string;
  firmwareSha256?: string;
  simulatedMs: number;
  wallMs: number;
  tracePath?: string;
  timeline: Record<string, { simUs: number; on: boolean }[]>;
  uartExcerpt: string;
  warnings: string[];
  createdAt: string;
  /** Raw pad evidence (capped) from the same run. */
  gpio?: Record<string, { simUs: number; level: 0 | 1 | 'Z' }[]>;
  finalPins?: { pin: string; output: boolean; level: 0 | 1; pull: string; driver?: string }[];
  nets?: { net_id: string; level: string; voltage: number | null }[];
  inputs?: { pin: string; level: 0 | 1 | null; simUs: number }[];
  /** Display frames captured for display checks (PNG paths relative to the project). */
  displayEvidence?: { component: string; atMs: number; png: string; stats: Record<string, unknown> }[];
}
