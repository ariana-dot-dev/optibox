import type { MachineState } from "./context.js";
import type { SANDBOX_PRICING } from "./context.js";

export type Role = "user" | "assistant" | "system";

/**
 * Which sandbox harness runs the private turn and on which model. `harness` is the
 * Boat provider id (claude-code, codex, pi, opencode, prime-agent); `provider`
 * is the key family the model bills to (anthropic, openai, openrouter) and only
 * drives the settings UI; `model` is a Boat model id from GET /api/provider-models.
 */
export interface HarnessSelection {
  harness: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  /** Fast mode (Codex "priority" tier, Opus fast): only models with fastMode in GET /provider-models. */
  fast?: boolean;
}

/**
 * A turn's selection is a PARTIAL override: any field the composer leaves out
 * falls back to the user's stored Agents default (agent_selection).
 */
export interface ConsumerTurnInput {
  userId: string;
  conversationId: string;
  message: string;
  selection?: Partial<HarnessSelection>;
}

/** The event contract between engine and UI — unchanged, so the client renders identically. */
export type ConsumerTurnEventBody =
  | { type: "trace"; stage: string; message: string; harness?: string; model?: string; sandboxId?: string; data?: Record<string, unknown> }
  | { type: "turn.blocked"; stage: string; message: string; retryable: boolean; harness?: string; model?: string; sandboxId?: string }
  | { type: "shared.delta"; text: string; harness: string; final?: boolean }
  | { type: "context.injected"; scope: "shared" | "user-sandbox"; machine: MachineState; hidden: string }
  | { type: "lifecycle"; state: string; sandboxId: string; note?: string }
  | { type: "autostop.timer"; phase: "started" | "tick" | "canceled" | "stopping" | "held"; sandboxId?: string | undefined; remainingMs: number; deadlineEpochMs?: number; reason: "idle-after-response" | "new-user-message" | "disabled"; note: string }
  | { type: "billing.start"; sandboxId: string; ratePerSecond: number; sinceEpochMs: number; pricing: typeof SANDBOX_PRICING }
  | { type: "billing.stop"; sandboxId: string; elapsedSeconds: number; costUsd: number; note: string }
  | { type: "handoff.started"; recap: string; sandboxId: string; harness: string; model: string }
  | { type: "exec"; kind: "command" | "harness"; argv?: string[]; command?: string; sandboxId: string }
  | { type: "harness.tool"; phase: "tool_use" | "tool_result"; sandboxId: string; toolName?: string; command?: string; description?: string; stdout?: string; stderr?: string; isError?: boolean }
  | { type: "user-sandbox.delta"; text: string; sandboxId: string; harness: string; model: string; messageId?: string; messageIndex?: number }
  | { type: "desktop.recording"; sandboxId: string; path: string; sizeKb: number }
  | { type: "scenario.fork"; groupId: string; labels: string[] }
  | { type: "error"; message: string }
  | { type: "turn.done"; sandboxId?: string; harness: string; model: string; route?: "shared" | "direct" | "bridge"; settled?: boolean };

export type ConsumerTurnEvent = ConsumerTurnEventBody & { turnId?: string; scenarioId?: string; scenarioLabel?: string };

export interface TranscriptMessage {
  role: Role;
  content: string;
  at?: string;
  mode?: "shared" | "handoff" | "user-sandbox";
  harness?: string;
  model?: string;
}

export interface SandboxInfo {
  id: string;
  state: "provisioning" | "provisioned" | "cloning" | "ready" | "idle" | "running" | "archiving" | "archived" | "error" | string;
  name?: string;
  archiveAfter?: string | null;
  url?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One queued prompt on a Boat (POST /prompt, GET /prompts/{id}). */
export interface PromptRun {
  promptId: string;
  conversationId: string;
  status: string;
  done: boolean;
}

/** One entry of GET /events. `data` is extensible; the engine reads content/tools/is_streaming. */
export interface SandboxEvent {
  id: string;
  type: string;
  timestamp: number;
  taskId?: string | null;
  conversationId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Sandbox as seen by the engine: machine lifecycle, the integrated agents
 * (prompt / events / interrupt, conversations included), and a few commands for
 * the readiness probe, hosting takedown and the desktop recording.
 */
export interface SandboxClient {
  create(input: {
    name?: string;
    ttlSeconds?: number | null;
    /** Withhold every owner secret from the sandbox; `env` is then the ONLY environment it gets. */
    noEnv?: boolean;
    /** Per-sandbox environment: the provider keys the user's harnesses run on. */
    env?: Record<string, string>;
  }): Promise<SandboxInfo>;
  get(sandboxId: string): Promise<SandboxInfo>;
  update(sandboxId: string, input: { name?: string; ttlSeconds?: number | null }): Promise<SandboxInfo>;
  stop(sandboxId: string): Promise<SandboxInfo | { ok: boolean }>;
  /** `env` REPLACES the sandbox's stored environment; omitted keeps whatever it has. */
  resume(sandboxId: string, input?: { env?: Record<string, string> }): Promise<SandboxInfo | { ok: boolean }>;
  deleteSandbox?(sandboxId: string): Promise<void>;
  command(sandboxId: string, input: { command: string; cwd?: string; timeoutMs?: number }): Promise<CommandResult>;
  readFile(sandboxId: string, path: string): Promise<string>;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
  prompt(sandboxId: string, input: { provider: string; model?: string; reasoningEffort?: string; fast?: boolean; prompt: string; new?: boolean; conversationId?: string }): Promise<PromptRun>;
  promptRun(sandboxId: string, promptId: string): Promise<PromptRun>;
  events(sandboxId: string, input: { conversationId?: string; cursor?: string; limit?: number }): Promise<{ events: SandboxEvent[]; nextCursor?: string | null }>;
  interrupt(sandboxId: string, conversationId?: string): Promise<void>;
}
