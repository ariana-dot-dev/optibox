import type { MachineState } from "./context.js";

export type Role = "user" | "assistant" | "system";

export interface TranscriptMessage {
  role: Role;
  content: string;
  at?: string;
  mode?: "shared" | "handoff" | "user-box";
  harness?: string;
  model?: string;
}

export interface UserSession {
  userId: string;
  conversationId: string;
  boxId?: string;
  lastSeenAt?: number;
}

export interface BoxInfo {
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

/**
 * Box is used purely as a runtime/substrate: create/resume/stop boxes and run
 * commands + read/write files inside them. The framework NEVER calls Box's
 * built-in agent/prompt endpoint — the acting agents are the developer's own
 * external harnesses, invoked via `command`. See {@link assertNoBoxAgent}.
 */
export interface BoxClient {
  create(input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo>;
  list?(): Promise<BoxInfo[]>;
  get(boxId: string): Promise<BoxInfo>;
  update(boxId: string, input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo>;
  stop(boxId: string): Promise<BoxInfo | { ok: boolean }>;
  resume(boxId: string): Promise<BoxInfo | { ok: boolean }>;
  command(boxId: string, input: { command: string; cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<CommandResult>;
  readFile(boxId: string, path: string): Promise<string>;
  writeFile(boxId: string, path: string, content: string): Promise<void>;
}

/** Identifies which external harness + which model/provider a turn should use. */
export interface HarnessSelection {
  harness: string;
  provider: string;
  model: string;
}

/** Spec for running the developer's real harness binary inside the user Box. */
export type HarnessOutputMode =
  | "raw-stdout"
  | "claude-stream-json"
  | "codex-json"
  | "opencode-json"
  | "pi-json";

export interface HarnessRunSpec {
  /** argv[0] is the binary (e.g. "codex", "claude", "opencode"). */
  argv: string[];
  /** Extra env injected into the Box process (e.g. ANTHROPIC_API_KEY). */
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  /** How to extract user-visible assistant text from the harness stdout stream. */
  outputMode?: HarnessOutputMode;
  /** Poll cadence for the remote log tail; lower values expose real chunks sooner. */
  pollMs?: number;
}

/** Real tool telemetry emitted by a harness' native streaming/event output. */
export interface HarnessToolEvent {
  phase: "tool_use" | "tool_result";
  toolName?: string;
  command?: string;
  description?: string;
  stdout?: string;
  stderr?: string;
  isError?: boolean;
}

export interface SafeSharedCapabilities {
  readonly mode: "shared-restricted";
  /** Safe: a constrained text/search-only LLM answer. Provided by the host. */
  webSearch(query: string): Promise<string>;
  answer(text: string): AsyncIterable<string>;
  // Everything that touches the machine is denied in shared mode:
  readFile(path: string): Promise<never>;
  writeFile(path: string, content: string): Promise<never>;
  bash(command: string): Promise<never>;
  controlComputer(action: string): Promise<never>;
}

export interface UserBoxCapabilities {
  readonly mode: "user-box-full";
  boxId: string;
  /** Run the developer's real external harness inside the Box, streaming stdout. */
  runHarness(spec: HarnessRunSpec): AsyncIterable<string>;
  /** Low-level Box substrate primitives also available to adapters. */
  command(command: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface SharedContext {
  userId: string;
  conversationId: string;
  message: string;
  transcript: TranscriptMessage[];
  selection: HarnessSelection;
  capabilities: SafeSharedCapabilities;
  /** Hidden XML envelope (prior transcript + machine state) injected into the prompt. */
  hiddenContext: string;
  /** Current machine/tool state — here: shared box, tools=false. */
  machine: MachineState;
  /** Whether the user asked for real tool work (=> LARP a brief holding reply). */
  toolIntent: boolean;
}

export interface UserBoxContext {
  userId: string;
  conversationId: string;
  boxId: string;
  recap: string;
  latestUserMessage: string;
  transcript: TranscriptMessage[];
  selection: HarnessSelection;
  capabilities: UserBoxCapabilities;
  /** Hidden XML envelope (prior transcript + machine state + partial shared reply). */
  hiddenContext: string;
  /** Current machine/tool state — here: user box, tools=true. */
  machine: MachineState;
  /** Partial reply the shared prewarm agent already streamed to the user. */
  partialShared: string;
}

export interface ModelOption {
  provider: string;
  model: string;
  label?: string;
}

/**
 * A consumer harness: the developer's own agent/loop/code. The framework only
 * orchestrates Box lifecycle, restricted shared prewarm, recap handoff, and
 * per-user Box continuation — the harness owns the agentic loop and the real
 * LLM calls.
 */
export interface HarnessAdapter {
  name: string;
  description?: string;
  /** Which provider that supplies the LLM key this harness needs at runtime. */
  requiredEnv: string[];
  /** Models this harness can drive — powers live model switching. */
  models: ModelOption[];
  /** Restricted, fast first response. Real LLM allowed but NO Box actions. */
  shared(ctx: SharedContext): AsyncIterable<string>;
  /** Full continuation: runs the REAL external harness inside the user Box. */
  userBox(ctx: UserBoxContext): AsyncIterable<string>;
}

export interface SessionStore {
  get(userId: string, conversationId: string): Promise<UserSession | undefined>;
  put(session: UserSession): Promise<void>;
}

export interface Recapper {
  recap(messages: TranscriptMessage[]): Promise<string>;
}

export interface OrchestratorOptions {
  box: BoxClient;
  /** All harnesses the product offers; the active one is chosen per turn. */
  harnesses: HarnessAdapter[];
  sessions?: SessionStore;
  recapper?: Recapper;
  sharedBoxName?: string;
  userBoxName?: (userId: string) => string;
  userBoxTtlSeconds?: number;
  readinessPollMs?: number;
  handoffTimeoutMs?: number;
  /** Max time to wait for an archived private Box to resume before surfacing recovery and provisioning a fresh one. */
  resumeTimeoutMs?: number;
  /** Provider LLM keys to inject into the Box when running harnesses. */
  providerEnv?: Record<string, string>;
  /** Delay after a Box answer before auto-stopping, unless a newer user turn arrives. Defaults to 5000ms. */
  autoStopIdleMs?: number;
}
