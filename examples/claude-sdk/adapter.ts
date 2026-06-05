import { realCliHarness } from "../shared.js";

// Verified-real: the Claude Code CLI (`claude`, package @anthropic-ai/claude-code)
// is preinstalled in every Box. Needs ANTHROPIC_API_KEY in the Box env.
// The Claude Agent SDK (@anthropic-ai/claude-agent-sdk) drives the same engine.
export const harness = realCliHarness({
  name: "claude-agent-sdk",
  description: "Anthropic Claude Code / Claude Agent SDK running inside the user Box.",
  bin: "claude",
  // Sonnet + Haiku are the demo defaults. Opus is intentionally NOT offered as a
  // default demo model.
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  buildArgv: ({ prompt, model }) => ["claude", "-p", prompt, "--model", model, "--dangerously-skip-permissions"],
});
