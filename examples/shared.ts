import { streamSharedAnswer } from "../src/providerClient.js";
import type { HarnessAdapter, ModelOption, SharedContext, UserBoxCapabilities, UserBoxContext } from "../src/index.js";

/** Resolve the LLM API key for a provider from the host environment. */
export function providerKey(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY_SCOPED ?? process.env.OPENAI_API_KEY;
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
  return env;
}

const SHARED_NORMAL_SYSTEM =
  "You are the always-on shared front-desk agent for a consumer AI product. You can handle lightweight conversation instantly. Keep replies short and natural. Do not mention Boxes, sandboxes, machines, tools, booting, provisioning, or handoff.";

const SHARED_BRIDGE_SYSTEM =
  "You are the always-on shared front-desk agent for a consumer AI product. You run on a shared, always-warm machine while the user's private tool environment is becoming available in the background.\n\n" +
  "You are given a hidden <consumer-context> block with the full prior conversation and a <machine-state> tag. USE IT only to write a coherent holding reply.\n\n" +
  "ABSOLUTE RULE — do not give a final answer, do not claim you already used tools, do not ask follow-up questions, and do not mention Boxes, sandboxes, machines, booting, provisioning, handoff, or hotswap to the user.\n\n" +
  "Your only job is a short, warm holding reply (one sentence) that acknowledges the latest request and says you are looking into it.";

function fallbackSharedBridge(ctx: SharedContext): string {
  const normalized = ctx.message.trim().toLowerCase();
  if (!ctx.toolIntent) {
    if (/^(hi|hey|hello|yo|sup)[!. ]*$/.test(normalized))
      return "Hey — what can I do for you?";
    return "Got it — how can I help?";
  }
  return "Let me look into it...";
}

export interface RealCliHarnessSpec {
  name: string;
  description: string;
  models: ModelOption[];
  /** Binary to check for; if missing, run installCmd in the Box first. */
  bin: string;
  installCmd?: string;
  /** Build the argv that runs the real harness for one turn inside the Box. */
  buildArgv: (input: { prompt: string; model: string; provider: string }) => string[];
  /** Optional one-time setup inside the Box before the harness runs (e.g. auth files). */
  prepare?: (caps: UserBoxCapabilities) => Promise<void>;
  /** Override the env vars this harness requires (defaults to the provider key var). */
  requiredEnv?: string[];
}

function buildPrompt(ctx: UserBoxContext): string {
  return [
    ctx.hiddenContext,
    "",
    `Machine state: you are now INSIDE the user's private Box — location=user-box tools=true boxId=${ctx.boxId}. Full tools are available.`,
    ctx.partialShared
      ? `The shared prewarm agent already told the user this (carry it forward, continue from it, do NOT repeat it verbatim):\n"""${ctx.partialShared}"""`
      : "",
    "",
    `User's latest request: ${ctx.latestUserMessage}`,
    "",
    "Complete the request now using real tools: create/edit files and run commands as needed, then briefly report what you did.",
    "If the request needs a command (for example checking IP), first tell the user you are running the command, then run it, then provide the result. Do not repeat any shared holding reply.",
  ].filter(Boolean).join("\n");
}

/**
 * Build a HarnessAdapter that:
 *  - shared(): produces a real, restricted, text-only LLM answer (no Box access);
 *  - userBox(): runs the developer's REAL CLI harness inside the user Box.
 * This is the contract every example below uses — the framework never touches
 * Box's built-in agent.
 */
export function realCliHarness(spec: RealCliHarnessSpec): HarnessAdapter {
  return {
    name: spec.name,
    description: spec.description,
    requiredEnv: spec.requiredEnv ?? [...new Set(spec.models.map((m) => (m.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY_SCOPED")))],
    models: spec.models,
    async *shared(ctx: SharedContext) {
      const key = providerKey(ctx.selection.provider);
      if (!key) {
        yield fallbackSharedBridge(ctx);
        return;
      }
      try {
        const user = `${ctx.hiddenContext}\n\nCurrent user message: ${ctx.message}`;
        yield* streamSharedAnswer({
          provider: ctx.selection.provider,
          model: ctx.selection.model,
          system: ctx.toolIntent ? SHARED_BRIDGE_SYSTEM : SHARED_NORMAL_SYSTEM,
          user,
          apiKey: key,
          maxTokens: ctx.toolIntent ? 80 : 120,
        });
      } catch (e) {
        yield fallbackSharedBridge(ctx);
      }
    },
    async *userBox(ctx: UserBoxContext) {
      const { capabilities, selection } = ctx;
      if (spec.installCmd) {
        const check = await capabilities.command(`command -v ${spec.bin} >/dev/null 2>&1 && echo ok || echo missing`);
        if (check.stdout.trim() !== "ok") {
          yield `[${spec.name}] installing harness in Box…\n`;
          await capabilities.command(spec.installCmd, { timeoutMs: 180_000 });
        }
      }
      if (spec.prepare) await spec.prepare(capabilities);
      const argv = spec.buildArgv({ prompt: buildPrompt(ctx), model: selection.model, provider: selection.provider });
      yield* capabilities.runHarness({ argv });
    },
  };
}
