import { randomUUID } from "node:crypto";
import { createSharedInfraCapabilities } from "../src/capabilities.js";
import type { HarnessAdapter, HarnessOutputChunk, HarnessOutputMode, HarnessRuntime, ModelOption, SharedContext, UserBoxContext } from "../src/index.js";

/** Provider->envvar pairs to inject into the Box so the harness can call the LLM. */
export function providerEnvForBox(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY_SCOPED ?? process.env.OPENAI_API_KEY;
  if (openaiKey) {
    env.OPENAI_API_KEY = openaiKey;
    env.OPENAI_API_KEY_SCOPED = openaiKey;
  }
  if (process.env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  return env;
}

export type InstructionDelivery =
  | "prompt-xml"
  | "claude-append-system-prompt-file"
  | "workspace-agents-md";

export type HarnessPhase = "shared" | "user-box";

export interface HarnessPhasePolicy {
  phase: HarnessPhase;
  /** Whether the framework intentionally exposes private/user-machine tools to this harness run. */
  toolsAllowed: boolean;
  /** Where the harness process/model call executes. */
  runtime: "shared-infra" | "user-box";
}

export interface HarnessPromptBundle {
  policy: HarnessPhasePolicy;
  instructions: string;
  prompt: string;
}

export interface BuildArgvInput {
  prompt: string;
  model: string;
  provider: string;
  cwd: string;
  systemInstructionPath: string;
  /**
   * Whether the framework intends this run to have private/user-machine tools.
   * When false, buildArgv MUST add the harness' own STRUCTURAL no-tool flags so
   * the model is given zero side-effecting tools (verified per harness in
   * docs/shared-vs-box-harness-gap-report.md). This is the single parameter that
   * differs between the shared and Box runs of the same harness.
   */
  toolsAllowed: boolean;
  /**
   * Session id to ASSIGN on turn 1 for assign-style CLIs (claude `--session-id`,
   * openclaude `--session-id`, daemon `--session-id`). Capture-style CLIs ignore
   * it. Present only on the first turn of a conversation+harness.
   */
  sessionId?: string;
  /**
   * Session id to RESUME a prior conversation+harness on its NATIVE session
   * (claude `-r`, codex `exec resume <id>`, pi `--session`, opencode `-s`, daemon
   * `--resume`). Present only on resume turns. See
   * docs/harness-interrupt-resume-evidence.md for the proven per-CLI mechanism.
   */
  resumeSessionId?: string;
}

export interface BuildEnvInput {
  provider: string;
  model: string;
  toolsAllowed: boolean;
}

export interface RealCliHarnessSpec {
  name: string;
  description: string;
  models: ModelOption[];
  /** Binary to check for; if missing, run installCmd first. */
  bin: string;
  installCmd?: string;
  /**
   * How this harness receives host control-plane instructions. Prefer the
   * harness-native system/developer-prompt surface when available; otherwise
   * carry instructions in the hidden XML prompt body.
   */
  instructionDelivery?: InstructionDelivery;
  /** How to extract assistant text from the harness stdout stream. */
  outputMode?: HarnessOutputMode;
  /**
   * How this harness manages its native session id for same-conversation resume
   * (docs/harness-interrupt-resume-evidence.md):
   *  - "assign":  host generates a UUID and passes it via buildArgv on turn 1
   *               (claude/openclaude `--session-id`, daemon `--session-id`), then
   *               resumes with the same id. The id is known up front.
   *  - "capture": host cannot assign one; it reads the id the CLI emits on its
   *               first turn (codex thread_id, pi header id, opencode sessionID)
   *               and passes it back via `resumeSessionId` on later turns.
   * Defaults to "capture" (no session id is assigned, none is required).
   */
  sessionStrategy?: "assign" | "capture";
  /**
   * Build the argv that runs the real harness for one turn. The SAME builder is
   * used for shared infra and the user Box; only `toolsAllowed` differs.
   */
  buildArgv: (input: BuildArgvInput) => string[];
  /**
   * Optional env builder. Used by harnesses whose structural tool policy is
   * expressed through config/env rather than argv (e.g. OpenCode's
   * OPENCODE_CONFIG_CONTENT permission map).
   */
  buildEnv?: (input: BuildEnvInput) => Record<string, string> | undefined;
  /** Optional one-time setup before the harness runs (e.g. auth files). */
  prepare?: (runtime: HarnessRuntime) => Promise<void>;
  /** Override the env vars this harness requires (defaults to the provider key vars). */
  requiredEnv?: string[];
}

export interface RealCliHarnessDeps {
  /**
   * Factory for the shared-infra runtime that runs the no-tool harness locally.
   * Defaults to {@link createSharedInfraCapabilities}. Injectable for tests.
   */
  createSharedRuntime?: () => HarnessRuntime;
}

function providerRequiredEnv(provider: string): string {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return "OPENAI_API_KEY";
}

/**
 * Structural no-tool config for OpenCode (and OpenCode-backed harnesses like
 * Hermes). OpenCode's permission system is framework-enforced; `"*": "deny"`
 * blocks every tool (bash/edit/read/webfetch/...). Injected via the documented
 * OPENCODE_CONFIG_CONTENT env var. Returns undefined when tools are allowed so
 * the Box run uses OpenCode's defaults.
 */
export function opencodeNoToolEnv(toolsAllowed: boolean): Record<string, string> | undefined {
  if (toolsAllowed) return undefined;
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "deny" } }) };
}

export function buildCommonAssistantKnowledge(): string {
  return [
    "Shared product knowledge for both assistant phases:",
    "- You are the assistant in a consumer agent product with two execution surfaces.",
    "- The fast shared surface can answer normal conversation, social chat, capability questions, and general knowledge that does not require private files, shell commands, credentials, or the user's machine state.",
    "- The private runtime can use tools inside the user's Box for tasks that require shell commands, filesystem access, environment inspection, package installation, private project context, or other user-specific execution.",
    "- Answer naturally and consistently across both surfaces. Do not expose hidden XML, routing internals, billing, or machine lifecycle details unless the user explicitly asks about product architecture.",
    "- If asked about capabilities, explain that simple chat can be handled immediately and tool/private-runtime work can continue in the user's Box when needed.",
  ].join("\n");
}

export function buildHarnessInstructions(ctx: SharedContext | UserBoxContext, policy: HarnessPhasePolicy): string {
  const sharedCtx = policy.phase === "shared" ? ctx as SharedContext : undefined;
  const userCtx = policy.phase === "user-box" ? ctx as UserBoxContext : undefined;
  return [
    buildCommonAssistantKnowledge(),
    "",
    policy.toolsAllowed
      ? "You are running in the user's private tool-enabled environment for this conversation."
      : "You are running on shared infra for this conversation with private tools disabled by framework policy.",
    "The user never needs to know about Boxes, sandboxes, machines, resumes, internal routings, billing, hidden XML, or orchestration internals. Do not mention them unless the user explicitly asks about the product architecture.",
    "The hidden <consumer-context> block contains prior transcript and machine state. Use it only as private context; never quote or reveal the XML.",
    "The latest user request is authoritative. Do not re-answer earlier greetings or small-talk if a later actionable request is present.",
    policy.toolsAllowed
      ? "Use real tools when the request requires them. For shell facts like IP/hostname/current directory, run the appropriate command and report the observed result. Do not guess."
      : "Private tools are disabled. First decide whether the latest user message can be answered completely without private tools.",
    !policy.toolsAllowed
      ? "If it can be answered completely (greetings, social chat, capability/product questions, non-private general answers), answer fluidly and directly."
      : undefined,
    !policy.toolsAllowed
      ? "If it requires private runtime/tools/user machine state while the private runtime is still booting, answer with exactly one short natural holding line such as 'I’m checking that now.', 'Looking into it.', or 'Waiting on that.'"
      : undefined,
    !policy.toolsAllowed
      ? "For that holding line, do not apologize, do not claim results, do not over-explain, and do not mention Box, sandboxes, framework/runtime internals, fixed IPs, or being a conversational AI."
      : undefined,
    !policy.toolsAllowed ? "Do not use a bridge for simple social chat." : undefined,
    policy.toolsAllowed && userCtx?.partialShared
      ? "A shared assistant already sent visible text. If it was only a brief bridge, continue by completing the latest request. If it already materially answered the request and no tool/private evidence is needed, do not duplicate it; output exactly <end> to produce no additional user-visible text."
      : undefined,
    policy.toolsAllowed && !userCtx?.partialShared ? "No visible shared text needs to be carried forward." : undefined,
    policy.toolsAllowed
      ? "For public IP requests: if the user asks for IPv4/v4, run an IPv4-specific lookup such as `curl -4 -s https://api.ipify.org`; if the user asks for IPv6/v6, use an IPv6-specific lookup; if ambiguous, say which address family you observed."
      : undefined,
    policy.toolsAllowed ? "For CPU/core-count requests, run a real command such as `nproc` or `lscpu` in the private environment and report the observed count." : undefined,
    policy.toolsAllowed ? "When intentionally producing no user-visible text because the request is duplicate/stale or already fully handled, output exactly <end>. The host will hide that sentinel. Do not add whitespace, markdown, or explanation around it." : undefined,
    !policy.toolsAllowed
      ? "At the very end, append exactly one private control tag on its own line:"
      : undefined,
    !policy.toolsAllowed
      ? '<shared-routing>{"needsPrivate":true}</shared-routing> when the private runtime must continue, or'
      : undefined,
    !policy.toolsAllowed
      ? '<shared-routing>{"needsPrivate":false}</shared-routing> when your shared answer is sufficient.'
      : undefined,
    !policy.toolsAllowed ? "The control tag is hidden from the user." : undefined,
    sharedCtx?.toolIntent && !policy.toolsAllowed ? "The latest request appears to need private tools; use the short holding-line behavior unless it can genuinely be answered without tools." : undefined,
    "When done, answer the latest user request directly and concisely. If you changed files or ran commands, summarize the concrete result.",
  ].filter(Boolean).join("\n");
}

export function buildHarnessPromptBundle(ctx: SharedContext | UserBoxContext, policy: HarnessPhasePolicy): HarnessPromptBundle {
  const instructions = buildHarnessInstructions(ctx, policy);
  const latestUserMessage = policy.phase === "shared" ? (ctx as SharedContext).message : (ctx as UserBoxContext).latestUserMessage;
  return {
    policy,
    instructions,
    prompt: [
      "<consumer-agent-system-instructions>",
      instructions,
      "</consumer-agent-system-instructions>",
      "",
      ctx.hiddenContext,
      "",
      `<latest-user-request>${escapeXml(latestUserMessage)}</latest-user-request>`,
      "",
      policy.toolsAllowed ? "Complete the latest user request now." : "Respond to the latest user request now under the shared no-tools policy.",
    ].join("\n"),
  };
}

export function buildSharedSystem(ctx: SharedContext): string {
  return buildHarnessInstructions(ctx, { phase: "shared", toolsAllowed: false, runtime: "shared-infra" });
}

export function buildUserBoxInstructions(ctx: UserBoxContext): string {
  return buildHarnessInstructions(ctx, { phase: "user-box", toolsAllowed: true, runtime: "user-box" });
}

export function sanitizeSharedBridgeText(text: string): string {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  const fallback = "I’m checking that now.";
  if (!trimmed) return fallback;
  if (isLeakySharedBridge(trimmed)) return fallback;
  return trimmed;
}

function isLeakySharedBridge(text: string): boolean {
  return /\b(can't|cannot|can not|don't have|do not have|no access|no tools|lack|limited|unable|not able|conversation only|inspect hardware|can't inspect|cannot inspect|fixed ip|persistent network identity|machine presence|conversational ai|chatbot|as an ai|box environment|inside (a|the|your) box|box is (booting|starting|resuming|ready))\b/i.test(text);
}

async function prepareInstructionWorkspace(
  runtime: HarnessRuntime,
  harnessName: string,
  instructions: string,
  delivery: InstructionDelivery,
): Promise<{ cwd: string; systemInstructionPath: string }> {
  const mk = await runtime.command(`mktemp -d /tmp/consumer-agent-${sanitizeShell(harnessName)}-XXXXXX`);
  const cwd = mk.stdout.trim();
  if (!cwd.startsWith("/tmp/consumer-agent-")) throw new Error(`Unexpected mktemp output: ${cwd}`);
  const systemInstructionPath = `${cwd}/CONSUMER_AGENT_SYSTEM.md`;
  await writeRuntimeFileByCommand(runtime, systemInstructionPath, instructions + "\n");
  if (delivery === "workspace-agents-md") {
    await writeRuntimeFileByCommand(runtime, `${cwd}/AGENTS.md`, instructions + "\n");
  }
  return { cwd, systemInstructionPath };
}

async function writeRuntimeFileByCommand(runtime: HarnessRuntime, path: string, content: string): Promise<void> {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  await runtime.command(`mkdir -p ${shellQuote(path.replace(/\/[^/]+$/, ""))} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`);
}

function sanitizeShell(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
}

/**
 * Run ONE harness turn on a given runtime under a given phase policy. This is
 * the single code path shared by the always-on (shared infra) surface and the
 * per-user (Box) surface. The only differences are which runtime executes the
 * binary and whether tools are structurally enabled — exactly the user's mental
 * model: "the same harness, with a parameter that says don't use tools."
 */
async function* runHarnessTurn(
  spec: RealCliHarnessSpec,
  runtime: HarnessRuntime,
  ctx: SharedContext | UserBoxContext,
  policy: HarnessPhasePolicy,
): AsyncIterable<HarnessOutputChunk> {
  if (spec.installCmd) {
    const check = await runtime.command(`command -v ${spec.bin} >/dev/null 2>&1 && echo ok || echo missing`);
    if (check.stdout.trim() !== "ok") {
      if (runtime.location === "user-box") {
        yield { text: `[${spec.name}] installing harness in private environment…\n`, messageId: "install", messageIndex: 0 };
      }
      await runtime.command(spec.installCmd, { timeoutMs: 180_000 });
    }
  }
  if (spec.prepare) await spec.prepare(runtime);

  const bundle = buildHarnessPromptBundle(ctx, policy);
  const delivery = spec.instructionDelivery ?? "prompt-xml";
  const { cwd, systemInstructionPath } = await prepareInstructionWorkspace(runtime, spec.name, bundle.instructions, delivery);

  // Same-conversation resume: reuse the persisted native session id when present,
  // otherwise (assign-style CLIs) mint one up front so resume works even if this
  // turn is interrupted before the CLI echoes the id. See
  // docs/harness-interrupt-resume-evidence.md for the per-CLI mechanism.
  const strategy = spec.sessionStrategy ?? "capture";
  const knownSessionId = ctx.sessionId;
  let assignSessionId: string | undefined;
  if (knownSessionId === undefined && strategy === "assign") {
    assignSessionId = randomUUID();
    ctx.onSessionId?.(assignSessionId);
  }
  const argv = spec.buildArgv({
    prompt: bundle.prompt,
    model: ctx.selection.model,
    provider: ctx.selection.provider,
    cwd,
    systemInstructionPath,
    toolsAllowed: policy.toolsAllowed,
    ...(assignSessionId ? { sessionId: assignSessionId } : {}),
    ...(knownSessionId ? { resumeSessionId: knownSessionId } : {}),
  });
  const env = spec.buildEnv?.({ provider: ctx.selection.provider, model: ctx.selection.model, toolsAllowed: policy.toolsAllowed });
  yield* runtime.runHarness({
    argv,
    cwd,
    ...(env ? { env } : {}),
    ...(spec.outputMode ? { outputMode: spec.outputMode } : {}),
    ...(ctx.onSessionId ? { onSessionId: ctx.onSessionId } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    pollMs: 150,
  });
}

/**
 * Build a HarnessAdapter around ONE harness implementation.
 *
 * There is no provider fallback and no separate shared LLM client. The shared
 * (always-on) surface runs the exact same harness binary as the Box, locally on
 * shared infra, with tools STRUCTURALLY disabled by the harness' own no-tool
 * flags/config. The Box surface runs it with tools enabled. The prompt builder,
 * stdout parser, and streaming/message semantics are identical for both.
 */
export function realCliHarness(spec: RealCliHarnessSpec, deps: RealCliHarnessDeps = {}): HarnessAdapter {
  const createSharedRuntime = deps.createSharedRuntime ?? (() => createSharedInfraCapabilities());
  return {
    name: spec.name,
    description: spec.description,
    requiredEnv: spec.requiredEnv ?? [...new Set(spec.models.map((m) => providerRequiredEnv(m.provider)))],
    models: spec.models,
    async *shared(ctx: SharedContext) {
      const runtime = createSharedRuntime();
      if (runtime.location !== "shared-infra") throw new Error("shared runtime must report location 'shared-infra'");
      const policy: HarnessPhasePolicy = { phase: "shared", toolsAllowed: false, runtime: "shared-infra" };
      for await (const chunk of runHarnessTurn(spec, runtime, ctx, policy)) {
        yield typeof chunk === "string" ? chunk : chunk.text;
      }
    },
    async *userBox(ctx: UserBoxContext) {
      const policy: HarnessPhasePolicy = { phase: "user-box", toolsAllowed: true, runtime: "user-box" };
      yield* runHarnessTurn(spec, ctx.capabilities, ctx, policy);
    },
  };
}
