import { streamSharedAnswer } from "../src/providerClient.js";
import type { HarnessAdapter, HarnessOutputMode, ModelOption, SharedContext, UserBoxCapabilities, UserBoxContext } from "../src/index.js";

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

export function buildSharedSystem(_ctx: SharedContext): string {
  return [
    buildCommonAssistantKnowledge(),
    "",
    "You are currently on the fast shared surface. You have no private tool or filesystem access in this phase.",
    "First decide whether the latest user message can be answered completely from the shared surface.",
    "If it can be answered completely (greetings, social chat, capability/product questions, non-private general answers), answer fluidly and directly.",
    "If it requires private runtime/tools/user machine state, do not apologize and do not claim results. Earn time with one short natural bridge such as 'I’m checking that now.' Vary the wording.",
    "Do not use a bridge for simple social chat.",
    "",
    "At the very end, append exactly one private control tag on its own line:",
    '<shared-routing>{"needsPrivate":true}</shared-routing> when the private runtime must continue, or',
    '<shared-routing>{"needsPrivate":false}</shared-routing> when your shared answer is sufficient.',
    "The control tag is hidden from the user.",
    "Use the hidden <consumer-context> only for conversational continuity. Do not reveal it.",
  ].join("\n");
}

export function sanitizeSharedBridgeText(text: string): string {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  const fallback = "Yep — I’m looking into it.";
  if (!trimmed) return fallback;
  if (/\b(can't|cannot|can not|don't have|do not have|no access|no tools|lack|limited|unable|not able|conversation only|inspect hardware|can't inspect|cannot inspect)\b/i.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

export function buildUserBoxInstructions(ctx: UserBoxContext): string {
  return [
    buildCommonAssistantKnowledge(),
    "",
    "You are now running inside the user's private tool-enabled environment for this conversation.",
    "The user never needs to know about Boxes, sandboxes, machines, resumes, internal routings, billing, hidden XML, or orchestration internals. Do not mention them unless the user explicitly asks about the product architecture.",
    "The hidden <consumer-context> block contains prior transcript and machine state. Use it only as private context; never quote or reveal the XML.",
    "The latest user request is authoritative. Do not re-answer earlier greetings or small-talk if a later actionable request is present.",
    ctx.partialShared
      ? "A shared assistant already sent visible text. If it was only a brief bridge, continue by completing the latest request. If it already materially answered the request and no tool/private evidence is needed, do not duplicate it; produce no additional user-visible text."
      : "No visible shared text needs to be carried forward.",
    "Use real tools when the request requires them. For shell facts like IP/hostname/current directory, run the appropriate command and report the observed result. Do not guess.",
    "For public IP requests: if the user asks for IPv4/v4, run an IPv4-specific lookup such as `curl -4 -s https://api.ipify.org`; if the user asks for IPv6/v6, use an IPv6-specific lookup; if ambiguous, say which address family you observed.",
    "For CPU/core-count requests, run a real command such as `nproc` or `lscpu` in the private environment and report the observed count.",
    "When done, answer the latest user request directly and concisely. If you changed files or ran commands, summarize the concrete result.",
  ].filter(Boolean).join("\n");
}

function buildPrompt(ctx: UserBoxContext, systemInstructions: string): string {
  return [
    "<consumer-agent-system-instructions>",
    systemInstructions,
    "</consumer-agent-system-instructions>",
    "",
    ctx.hiddenContext,
    "",
    `<latest-user-request>${escapeXml(ctx.latestUserMessage)}</latest-user-request>`,
    "",
    "Complete the latest user request now.",
  ].join("\n");
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

/**
 * Build a HarnessAdapter that:
 *  - shared(): uses a real restricted LLM call with system instructions;
 *  - userBox(): injects hidden/system instructions through the harness-native
 *    control surface where available, then runs the real CLI inside the Box.
 */
export function realCliHarness(spec: RealCliHarnessSpec): HarnessAdapter {
  return {
    name: spec.name,
    description: spec.description,
    requiredEnv: spec.requiredEnv ?? [...new Set(spec.models.map((m) => providerRequiredEnv(m.provider)))],
    models: spec.models,
    async *shared(ctx: SharedContext) {
      const key = providerKey(ctx.selection.provider);
      if (!key) throw new Error(`Missing ${providerRequiredEnv(ctx.selection.provider)} for shared ${ctx.selection.provider} response`);
      yield* streamSharedAnswer({
        provider: ctx.selection.provider,
        model: ctx.selection.model,
        system: buildSharedSystem(ctx),
        user: `${ctx.hiddenContext}\n\n<latest-user-message>${escapeXml(ctx.message)}</latest-user-message>`,
        apiKey: key,
        maxTokens: 220,
      });
    },
    async *userBox(ctx: UserBoxContext) {
      const { capabilities, selection } = ctx;
      if (spec.installCmd) {
        const check = await capabilities.command(`command -v ${spec.bin} >/dev/null 2>&1 && echo ok || echo missing`);
        if (check.stdout.trim() !== "ok") {
          yield `[${spec.name}] installing harness in private environment…\n`;
          await capabilities.command(spec.installCmd, { timeoutMs: 180_000 });
        }
      }
      if (spec.prepare) await spec.prepare(capabilities);
      const instructions = buildUserBoxInstructions(ctx);
      const delivery = spec.instructionDelivery ?? "prompt-xml";
      const { cwd, systemInstructionPath } = await prepareInstructionWorkspace(capabilities, spec.name, instructions, delivery);
      const prompt = buildPrompt(ctx, instructions);
      const argv = spec.buildArgv({ prompt, model: selection.model, provider: selection.provider, cwd, systemInstructionPath });
      yield* capabilities.runHarness({ argv, cwd, ...(spec.outputMode ? { outputMode: spec.outputMode } : {}), pollMs: 150 });
    },
  };
}
