/** planner/coder/debugger are model-driven; executor = deterministic tool execution by the orchestrator. */
export type AgentRole = 'planner' | 'coder' | 'debugger' | 'executor';

export type AgentPhase =
  | 'queued'
  | 'understanding'
  | 'planning'
  | 'editing-circuit'
  | 'coding'
  | 'building'
  | 'flashing'
  | 'running'
  | 'verifying'
  | 'debugging'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costUsd: number | null;
}

export interface LlmCallRecord {
  callId: string;
  role: AgentRole;
  model: string;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error';
  attempts: number;
  usage?: LlmUsage;
  finishReason?: string;
  toolCalls: { id: string; name: string }[];
  contentPreview?: string;
  reasoningChars?: number;
  error?: string;
}

export interface ToolCallRecord {
  toolCallId: string;
  role: AgentRole;
  name: string;
  args: unknown;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  resultPreview: string;
}

export type AgentEvent =
  | { kind: 'phase'; phase: AgentPhase; message: string; at: string }
  | { kind: 'llm-start'; role: AgentRole; callId: string; model: string; at: string }
  | { kind: 'llm-progress'; role: AgentRole; callId: string; contentChars: number; reasoningChars: number; toolArgChars: number; at: string }
  | { kind: 'llm-call'; call: LlmCallRecord; at: string }
  | { kind: 'tool-start'; role: AgentRole; toolCallId: string; name: string; args: unknown; at: string }
  | { kind: 'tool-end'; record: ToolCallRecord; at: string }
  | { kind: 'plan'; plan: unknown; at: string }
  | { kind: 'assistant'; role: AgentRole; content: string; at: string }
  | { kind: 'file-change'; path: string; bytes: number; diffStat: { added: number; removed: number }; at: string }
  | { kind: 'build'; build: unknown; at: string }
  | { kind: 'flash'; flash: unknown; at: string }
  | { kind: 'verification'; report: unknown; at: string }
  | { kind: 'error'; message: string; at: string }
  | { kind: 'final'; status: 'success' | 'failed' | 'cancelled'; summary: string; at: string };

export interface AgentRunSummary {
  runId: string;
  projectId: string;
  userMessage: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  phase: AgentPhase;
  model: string;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  usage: LlmUsage;
  llmCalls: number;
  toolCalls: number;
  repairRounds: number;
  finalBuildId?: string;
  finalVerificationId?: string;
  commitBefore?: string;
  commitAfter?: string;
}
