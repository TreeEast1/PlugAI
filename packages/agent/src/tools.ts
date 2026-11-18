import { z } from 'zod';
import { ScenarioSchema, type BoardId, type BuildRecord, type CircuitOp, type FlashRecord, type Scenario, type VerificationReport } from '@plugai/shared';
import type { ToolDef } from './deepseek.ts';

export const PlanSchema = z.object({
  understanding: z.string().min(1),
  change_type: z.enum(['new', 'modify', 'fix', 'none']),
  feasible: z.boolean(),
  capability_gaps: z.array(z.string()).default([]),
  board: z.string(),
  hardware: z
    .array(
      z.object({
        component_id: z.string(),
        type: z.enum(['led', 'resistor', 'button', 'traffic-light', 'lcd']),
        action: z.enum(['keep', 'add', 'modify', 'remove']).default('keep'),
        purpose: z.string().default(''),
        props: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      }),
    )
    .default([]),
  pin_plan: z.array(z.object({ signal: z.string(), board_pin: z.string(), direction: z.enum(['output', 'input']), notes: z.string().optional() })).default([]),
  wiring: z.array(z.object({ from: z.string(), to: z.string(), purpose: z.string().optional() })).default([]),
  firmware_plan: z.string().default(''),
  verification: ScenarioSchema.optional(),
  risks: z.array(z.string()).default([]),
  user_summary: z.string().min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

export interface ProjectStateForAgent {
  projectId: string;
  name: string;
  board: BoardId;
  circuit: string;
  circuitJson: unknown;
  circuitWarnings: string[];
  files: { path: string; bytes: number; content?: string }[];
  lastBuild?: { buildId: string; status: string; error?: string; diagnostics: string[] };
  lastVerification?: { passed: boolean; summary: string[] };
  conversation: { role: 'user' | 'agent'; text: string; at: string }[];
  isEmpty: boolean;
}

export interface Observation {
  durationMs: number;
  components: Record<string, { transitions: number; timeline: string }>;
  gpio: Record<string, { edges: number; first: string }>;
  finalPins: string;
  nets: string;
  uartTail: string;
  warnings: string[];
  restarts: string[];
  displays?: { component: string; atMs: number; summary: string }[];
}

/** Deterministic executor implemented by the server (real files, real compilers, real emulators). */
export interface ToolHost {
  inspectEnvironment(): Promise<Record<string, unknown>>;
  getProjectState(projectId: string, opts?: { includeFiles?: boolean }): Promise<ProjectStateForAgent>;
  listSupportedHardware(board: BoardId): Record<string, unknown>;
  createProject(projectId: string, board: BoardId, runId: string): Promise<{ ok: boolean; message: string }>;
  editCircuit(projectId: string, ops: CircuitOp[], runId: string): Promise<{ log: string[]; circuit: string; warnings: string[] }>;
  readFile(projectId: string, path: string): Promise<string>;
  writeFile(projectId: string, path: string, content: string, runId: string): Promise<{ bytes: number; added: number; removed: number }>;
  readSdkReference(board: BoardId, topic: string): Promise<string>;
  build(projectId: string, runId: string): Promise<BuildRecord>;
  flash(projectId: string, runId: string): Promise<FlashRecord>;
  runSimulation(projectId: string, opts: { durationMs: number; stimuli: Scenario['stimuli'] }): Promise<Observation>;
  verify(projectId: string, scenario: Scenario, runId: string): Promise<VerificationReport>;
  lastObservation(projectId: string): Observation | null;
  commit(projectId: string, message: string): Promise<string | null>;
  startLive(projectId: string): Promise<void>;
  sourceHash(projectId: string): Promise<string>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const scenarioJsonSchema = {
  type: 'object',
  description: 'Verification scenario (see system prompt for check types).',
  properties: {
    name: { type: 'string' },
    duration_ms: { type: 'number' },
    stimuli: { type: 'array', items: obj({ at_ms: { type: 'number' }, component: { type: 'string' }, action: { type: 'string', enum: ['press', 'release'] } }, ['at_ms', 'component', 'action']) },
    checks: { type: 'array', items: { type: 'object', description: 'state_during | period | pattern | toggle_count | uart_contains check object' } },
  },
  required: ['name', 'duration_ms', 'checks'],
};

const circuitOpSchema = {
  type: 'object',
  description:
    'One circuit operation. op=add_component {type: led|resistor|button|traffic-light|lcd, component_id, label?, props?}; op=remove_component {component_id}; op=update_component {component_id, label?, props?}; op=connect {from:"comp.pin", to:"comp.pin"}; op=disconnect {from,to} or {wire_id}; op=disconnect_pin {pin:"comp.pin"}; op=auto_layout {}.',
  properties: {
    op: { type: 'string', enum: ['add_component', 'remove_component', 'update_component', 'connect', 'disconnect', 'disconnect_pin', 'auto_layout'] },
    type: { type: 'string', enum: ['led', 'resistor', 'button', 'traffic-light', 'lcd'] },
    component_id: { type: 'string' },
    label: { type: 'string' },
    props: { type: 'object' },
    from: { type: 'string' },
    to: { type: 'string' },
    wire_id: { type: 'string' },
    pin: { type: 'string' },
  },
  required: ['op'],
};

const T = (name: string, description: string, parameters: Record<string, unknown>): ToolDef => ({ type: 'function', function: { name, description, parameters } });

export const TOOLS = {
  inspect_environment: T('inspect_environment', 'Check installed SDKs, compilers, MCU emulators and their real capabilities on this machine.', obj({})),
  get_project_state: T('get_project_state', 'Get the current project: board, circuit (components and wires), firmware files with contents, last build and last verification, recent conversation.', obj({})),
  list_supported_hardware: T('list_supported_hardware', 'List the board pinout and the component types that are genuinely simulated (with pins and properties).', obj({})),
  create_project: T('create_project', 'Re-initialise THIS project for a different supported board. Only allowed while the project has no firmware/circuit content yet.', obj({ board: { type: 'string', enum: ['esp32c3-devkitm-1', 'arduino-uno'] } }, ['board'])),
  plan_hardware: T(
    'plan_hardware',
    'Submit the final hardware + firmware + verification plan (call exactly once).',
    obj(
      {
        understanding: { type: 'string', description: 'Restated requirement incl. exact timings' },
        change_type: { type: 'string', enum: ['new', 'modify', 'fix', 'none'] },
        feasible: { type: 'boolean' },
        capability_gaps: { type: 'array', items: { type: 'string' } },
        board: { type: 'string' },
        hardware: { type: 'array', items: obj({ component_id: { type: 'string' }, type: { type: 'string', enum: ['led', 'resistor', 'button', 'traffic-light', 'lcd'] }, action: { type: 'string', enum: ['keep', 'add', 'modify', 'remove'] }, purpose: { type: 'string' }, props: { type: 'object' } }, ['component_id', 'type', 'action']) },
        pin_plan: { type: 'array', items: obj({ signal: { type: 'string' }, board_pin: { type: 'string' }, direction: { type: 'string', enum: ['output', 'input'] }, notes: { type: 'string' } }, ['signal', 'board_pin', 'direction']) },
        wiring: { type: 'array', items: obj({ from: { type: 'string' }, to: { type: 'string' }, purpose: { type: 'string' } }, ['from', 'to']) },
        firmware_plan: { type: 'string', description: 'Behaviour / state machine / timing the firmware must implement' },
        verification: scenarioJsonSchema,
        risks: { type: 'array', items: { type: 'string' } },
        user_summary: { type: 'string', description: 'Short summary for the user, in the user language' },
      },
      ['understanding', 'change_type', 'feasible', 'board', 'user_summary'],
    ),
  ),
  read_file: T('read_file', 'Read a project firmware file (path relative to firmware/, e.g. "main/main.c" or "sketch/sketch.ino").', obj({ path: { type: 'string' } }, ['path'])),
  read_sdk_reference: T('read_sdk_reference', 'Read SDK API reference from the locally installed SDK headers. topics: esp32: "gpio", "freertos", "esp_timer", "log", "rom_delay"; uno: "arduino", "pins".', obj({ topic: { type: 'string' } }, ['topic'])),
  edit_circuit: T('edit_circuit', 'Apply circuit operations atomically. Returns the resulting circuit description and electrical warnings.', obj({ ops: { type: 'array', items: circuitOpSchema } }, ['ops'])),
  write_firmware: T('write_firmware', 'Create or overwrite a firmware source file with its FULL content.', obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content'])),
  build_firmware: T('build_firmware', 'Run the real cross-compiler on the current sources. Returns status, diagnostics and artifact hashes.', obj({})),
  finish_implementation: T('finish_implementation', 'Declare the implementation complete (requires a successful build of the current sources and the planned circuit).', obj({ summary: { type: 'string' }, notes: { type: 'string' } }, ['summary'])),
  flash_virtual_device: T('flash_virtual_device', 'Flash the latest successful build to the virtual device (ESP32: esptool over virtual UART; Uno: direct HEX load) and boot it.', obj({})),
  run_simulation: T('run_simulation', 'Run the latest flashed firmware on a fresh simulated MCU with the current circuit and report observed GPIO edges, LED timelines, nets, UART and warnings.', obj({ duration_ms: { type: 'number' }, stimuli: { type: 'array', items: obj({ at_ms: { type: 'number' }, component: { type: 'string' }, action: { type: 'string', enum: ['press', 'release'] } }, ['at_ms', 'component', 'action']) } }, ['duration_ms'])),
  inspect_uart: T('inspect_uart', 'Return the UART output of the most recent simulation/verification run.', obj({})),
  inspect_gpio: T('inspect_gpio', 'Return GPIO pad edges, final pad states and net levels of the most recent simulation/verification run.', obj({})),
  verify_behavior: T('verify_behavior', 'Run the plan verification scenario with the Verification Engine on the latest flashed firmware.', obj({})),
  repair_project: T(
    'repair_project',
    'Finish debugging: report root cause and what you changed. The platform then rebuilds, re-flashes and re-verifies independently.',
    obj(
      {
        root_cause: { type: 'string', enum: ['firmware', 'circuit', 'firmware-and-circuit', 'verification-spec', 'unsupported', 'unknown'] },
        explanation: { type: 'string' },
        changes_made: { type: 'array', items: { type: 'string' } },
        revised_verification: scenarioJsonSchema,
        revision_reason: { type: 'string' },
      },
      ['root_cause', 'explanation', 'changes_made'],
    ),
  ),
} satisfies Record<string, ToolDef>;

export type ToolName = keyof typeof TOOLS;

export const ROLE_TOOLS: Record<'planner' | 'coder' | 'debugger', ToolName[]> = {
  planner: ['inspect_environment', 'get_project_state', 'list_supported_hardware', 'create_project', 'plan_hardware'],
  coder: ['get_project_state', 'read_file', 'read_sdk_reference', 'edit_circuit', 'write_firmware', 'build_firmware', 'finish_implementation'],
  debugger: ['get_project_state', 'read_file', 'read_sdk_reference', 'inspect_uart', 'inspect_gpio', 'run_simulation', 'edit_circuit', 'write_firmware', 'build_firmware', 'flash_virtual_device', 'verify_behavior', 'repair_project'],
};
