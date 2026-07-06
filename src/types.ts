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
  /** Fork a box from its latest snapshot (POST /boxes/{id}/fork). Optional: legacy clients may lack it. */
  fork?(boxId: string): Promise<BoxInfo>;
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
  /** One-object response from a resident `opencode serve` (POST /session/:id/message). */
  | "opencode-serve-json"
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
  /**
   * Interrupt handle. When this aborts, the runtime stops the harness the same
   * way a human "stops the agent": SIGINT then SIGKILL on shared infra, or
   * `kill -INT`/`kill -KILL` of the captured PID inside the Box. Completed turns
   * are already flushed to the harness' session file and remain resumable.
   */
  signal?: AbortSignal;
  /**
   * Called once when the harness' native stream reveals the session/thread id for
   * this conversation (codex thread_id, pi header id, opencode sessionID, claude
   * session_id). The host persists it to resume the SAME conversation next turn.
   */
  onSessionId?: (sessionId: string) => void;
  /**
   * Called exactly once when the harness loop ends, with WHY it ended. The host
   * uses this to decide whether the box agent has DEFINITELY settled the current
   * prompt (and may therefore begin the idle auto-stop countdown) versus the loop
   * ending ambiguously or being interrupted. See {@link HarnessCompletion}.
   */
  onComplete?: (info: HarnessCompletion) => void;
}

/**
 * Why a harness loop ended for one turn. This is the cross-harness "the prompt is
 * done" signal: every adapter runs a one-shot CLI/SDK invocation that performs the
 * entire agent loop — including arbitrarily long tool calls / computer-use — and
 * only ends its native stream when there is nothing more to do. Short inactivity
 * (no visible text for a few seconds while tools run) is NOT a completion and must
 * never be treated as one.
 */
export interface HarnessCompletion {
  /**
   *  - "completed": the CLI/SDK process finished its agent loop normally and the
   *    native stream ended (clean exit marker / process close). The only signal
   *    that the prompt is definitely fully answered.
   *  - "timeout": the long safety timeout elapsed while the process was still
   *    running (an hours-scale backstop, never short inactivity).
   *  - "process-exited": the process is gone but no clean exit marker was seen
   *    (crash/kill); the loop is over, though the answer may be incomplete.
   *  - "aborted": the turn was interrupted (human "stop" / superseding turn). The
   *    loop did NOT settle on its own and must not arm an idle stop.
   */
  reason: "completed" | "timeout" | "process-exited" | "aborted";
  /** Process exit code when a clean exit marker was observed. */
  exitCode?: number;
  /** Whether any user-visible assistant text was streamed during this turn. */
  sawText?: boolean;
  /** Spawn error / trailing stderr, surfaced so a no-output failure explains itself. */
  diagnostic?: string;
}

/** User-visible text emitted by a harness, with optional native assistant-message identity. */
export interface HarnessTextChunk {
  text: string;
  /** Stable within one harness invocation. Chunks with different ids must render as separate assistant messages. */
  messageId?: string;
  /** Monotonic fallback when the native runtime exposes message boundaries without ids. */
  messageIndex?: number;
}

export type HarnessOutputChunk = string | HarnessTextChunk;

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

/**
 * The substrate that runs the developer's real external harness and streams its
 * stdout. There is exactly ONE harness implementation; the only thing that
 * changes between the always-on shared surface and the per-user private surface
 * is which HarnessRuntime executes it (local shared infra vs the user Box) and
 * whether tools are structurally enabled. See {@link createSharedInfraCapabilities}
 * and {@link createUserBoxCapabilities}.
 */
export interface HarnessRuntime {
  /** Where this runtime physically executes the harness process. */
  readonly location: "shared-infra" | "user-box";
  /** Run the developer's real external harness, streaming its native stdout. */
  runHarness(spec: HarnessRunSpec): AsyncIterable<HarnessOutputChunk>;
  /** Low-level substrate primitives also available to adapters. */
  command(command: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface UserBoxCapabilities extends HarnessRuntime {
  readonly mode: "user-box-full";
  readonly location: "user-box";
  boxId: string;
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
  /** Last known native session id for this conversation+harness (resume target). */
  sessionId?: string;
  /** Persist the native session id captured from the harness stream this turn. */
  onSessionId?: (sessionId: string) => void;
  /** Notified once when the harness loop ends, with why (see {@link HarnessCompletion}). */
  onComplete?: (info: HarnessCompletion) => void;
  /** Interrupt handle: aborting stops the harness like a human "stop". */
  signal?: AbortSignal;
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
  /** Last known native session id for this conversation+harness (resume target). */
  sessionId?: string;
  /** Persist the native session id captured from the harness stream this turn. */
  onSessionId?: (sessionId: string) => void;
  /** Notified once when the harness loop ends, with why (see {@link HarnessCompletion}). */
  onComplete?: (info: HarnessCompletion) => void;
  /** Interrupt handle: aborting stops the harness like a human "stop". */
  signal?: AbortSignal;
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
  userBox(ctx: UserBoxContext): AsyncIterable<HarnessOutputChunk>;
}

export interface SessionStore {
  get(userId: string, conversationId: string): Promise<UserSession | undefined>;
  put(session: UserSession): Promise<void>;
  delete?(userId: string, conversationId: string): Promise<void>;
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
  /**
   * If set (>0), a background reaper runs on this interval and force-stops any
   * billable Box whose conversation has been idle (no active stream, owed round,
   * or in-flight boot) for longer than autoStopIdleMs. This is the safety net for
   * boxes the request-driven auto-stop can't reach — abandoned SSE streams, hung
   * turns, or a browser tab closed mid-answer. Disabled (undefined) in tests.
   */
  idleReaperIntervalMs?: number;
  /**
   * Absolute ceiling on how long any Box may bill before the reaper force-stops
   * it, even if the conversation still looks "active". This is the last-resort
   * guard against a stuck turn pinning a VM for hours/days. Defaults to 30 min
   * when the reaper is enabled. Set higher if you run genuinely long box work.
   */
  maxBillingAgeMs?: number;
  /**
   * Ownership test for the reaper's orphan sweep: given a box name, return true
   * if this orchestrator is responsible for stopping it when it runs unbilled
   * (e.g. name => name.startsWith("consumer-agent-")). Orphans appear after a
   * server restart wipes the in-memory billing map. Requires box.list. Assumes a
   * single server process owns these names; unset disables the sweep.
   */
  orphanBoxName?: (name: string) => boolean;
  /**
   * Pre-baked template Box. When set, brand-new user boxes are FORKED from this
   * template's snapshot instead of created empty + harness-installed — a restore
   * (~16s, constant) instead of an in-VM npm install (~15-40s, registry-variant).
   * The template is built lazily in the background (create → installCmd → stop =
   * snapshot); until its snapshot exists, fresh boxes use the legacy create path
   * and each turn's own bin-check still installs on demand. Version drift note:
   * the template pins whatever `installCmd` fetched at build time; delete the
   * template box to force a rebuild with current versions.
   */
  userBoxTemplate?: {
    name: string;
    /** Command run inside the template box to pre-install harness dependencies. */
    installCmd: string;
  };
}
