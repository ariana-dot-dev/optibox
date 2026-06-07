import { streamSharedAnswer } from "../src/providerClient.js";
import type { HarnessAdapter, HarnessOutputChunk, HarnessOutputMode, ModelOption, SharedContext, UserBoxCapabilities, UserBoxContext } from "../src/index.js";

/** Resolve the LLM API key for a provider from the host environment. */
export function providerKey(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY_SCOPED ?? process.env.OPENAI_API_KEY;
  if (provider === "openrouter") return process.env.OPENROUTER_API_KEY;
  return undefined;
}

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

export interface SharedInfraRunnerInput {
  policy: HarnessPhasePolicy;
  prompt: string;
  instructions: string;
  selection: SharedContext["selection"];
  hiddenContext: string;
  latestUserMessage: string;
}

export interface RealCliHarnessSpec {
  name: string;
  description: string;
  models: ModelOption[];
  /** Binary to check for; if missing, run installCmd in the Box first. */
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
  /** Build the argv that runs the real harness for one turn inside the Box. */
  buildArgv: (input: {
    prompt: string;
    model: string;
    provider: string;
    cwd: string;
    systemInstructionPath: string;
  }) => string[];
  /**
   * Optional shared-infra execution hook for harnesses that can be run with a
   * structural no-tool mode. When present, shared() and userBox() both use the
   * same prompt/policy builder; only policy.toolsAllowed/runtime differ.
   *
   * If omitted, realCliHarness falls back to the direct provider LLM stream for
   * shared infra because generic external CLIs cannot be assumed safe: many can
   * read files or run shell unless the adapter proves a real no-tool mode.
   */
  runSharedInfra?: (input: SharedInfraRunnerInput) => AsyncIterable<HarnessOutputChunk>;
  /** Optional one-time setup inside the Box before the harness runs (e.g. auth files). */
  prepare?: (caps: UserBoxCapabilities) => Promise<void>;
  /** Override the env vars this harness requires (defaults to the provider key vars). */
  requiredEnv?: string[];
}

function providerRequiredEnv(provider: string): string {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return "OPENAI_API_KEY";
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
  caps: UserBoxCapabilities,
  harnessName: string,
  instructions: string,
  delivery: InstructionDelivery,
): Promise<{ cwd: string; systemInstructionPath: string }> {
  const mk = await caps.command(`mktemp -d /tmp/consumer-agent-${sanitizeShell(harnessName)}-XXXXXX`);
  const cwd = mk.stdout.trim();
  if (!cwd.startsWith("/tmp/consumer-agent-")) throw new Error(`Unexpected mktemp output: ${cwd}`);
  const systemInstructionPath = `${cwd}/CONSUMER_AGENT_SYSTEM.md`;
  await writeBoxFileByCommand(caps, systemInstructionPath, instructions + "\n");
  if (delivery === "workspace-agents-md") {
    await writeBoxFileByCommand(caps, `${cwd}/AGENTS.md`, instructions + "\n");
  }
  return { cwd, systemInstructionPath };
}

async function writeBoxFileByCommand(caps: UserBoxCapabilities, path: string, content: string): Promise<void> {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  await caps.command(`mkdir -p ${shellQuote(path.replace(/\/[^/]+$/, ""))} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`);
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

async function* runSharedProviderFallback(ctx: SharedContext, bundle: HarnessPromptBundle): AsyncIterable<string> {
  const key = providerKey(ctx.selection.provider);
  if (!key) throw new Error(`Missing ${providerRequiredEnv(ctx.selection.provider)} for shared ${ctx.selection.provider} response`);
  yield* streamSharedAnswer({
    provider: ctx.selection.provider,
    model: ctx.selection.model,
    system: bundle.instructions,
    user: bundle.prompt,
    apiKey: key,
    maxTokens: 220,
  });
}

/**
 * Build a HarnessAdapter around one phase-aware prompt/policy path.
 *
 * Important: shared and Box execution are only truly identical for adapters that
 * provide runSharedInfra(), proving a structural no-tool mode on shared infra.
 * Without it we deliberately keep the safer provider fallback and document that
 * this is not exact harness identity rather than pretending otherwise.
 */
export function realCliHarness(spec: RealCliHarnessSpec): HarnessAdapter {
  return {
    name: spec.name,
    description: spec.description,
    requiredEnv: spec.requiredEnv ?? [...new Set(spec.models.map((m) => providerRequiredEnv(m.provider)))],
    models: spec.models,
    async *shared(ctx: SharedContext) {
      const bundle = buildHarnessPromptBundle(ctx, { phase: "shared", toolsAllowed: false, runtime: "shared-infra" });
      if (spec.runSharedInfra) {
        for await (const chunk of spec.runSharedInfra({
          policy: bundle.policy,
          prompt: bundle.prompt,
          instructions: bundle.instructions,
          selection: ctx.selection,
          hiddenContext: ctx.hiddenContext,
          latestUserMessage: ctx.message,
        })) {
          yield typeof chunk === "string" ? chunk : chunk.text;
        }
        return;
      }
      yield* runSharedProviderFallback(ctx, bundle);
    },
    async *userBox(ctx: UserBoxContext) {
      const { capabilities, selection } = ctx;
      if (spec.installCmd) {
        const check = await capabilities.command(`command -v ${spec.bin} >/dev/null 2>&1 && echo ok || echo missing`);
        if (check.stdout.trim() !== "ok") {
          yield { text: `[${spec.name}] installing harness in private environment…\n`, messageId: "install", messageIndex: 0 };
          await capabilities.command(spec.installCmd, { timeoutMs: 180_000 });
        }
      }
      if (spec.prepare) await spec.prepare(capabilities);
      const bundle = buildHarnessPromptBundle(ctx, { phase: "user-box", toolsAllowed: true, runtime: "user-box" });
      const delivery = spec.instructionDelivery ?? "prompt-xml";
      const { cwd, systemInstructionPath } = await prepareInstructionWorkspace(capabilities, spec.name, bundle.instructions, delivery);
      const argv = spec.buildArgv({ prompt: bundle.prompt, model: selection.model, provider: selection.provider, cwd, systemInstructionPath });
      yield* capabilities.runHarness({ argv, cwd, ...(spec.outputMode ? { outputMode: spec.outputMode } : {}), pollMs: 150 });
    },
  };
}
