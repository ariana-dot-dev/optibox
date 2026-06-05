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

export function sharedPlaceholder(ctx: SharedContext): string {
  const normalized = ctx.message.trim().toLowerCase();
  if (ctx.toolIntent) return "Looking for it...";
  if (/^(hi|hey|hello|yo|sup)[!. ]*$/.test(normalized))
    return "Hey — what can I do for you?";
  return "Got it — one sec.";
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
      ? `The visible shared reply was only a temporary placeholder. Do not repeat it; continue from it silently:\n"""${ctx.partialShared}"""`
      : "",
    "",
    `User's latest request: ${ctx.latestUserMessage}`,
    "",
    "The latest user request is authoritative. Do not answer earlier small-talk, do not greet, and do not ask what to do if the latest request is actionable.",
    "Complete the latest request now using real tools: create/edit files and run commands as needed, then briefly report what you did.",
    "If the latest request asks for an IP address, run a real IP command such as `curl -s ifconfig.me || curl -s https://api.ipify.org` and answer with the result. Do not repeat any shared holding reply.",
  ].filter(Boolean).join("\n");
}

/**
 * Build a HarnessAdapter that:
 *  - shared(): produces a deterministic, restricted, text-only placeholder (no Box access);
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
      yield sharedPlaceholder(ctx);
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
