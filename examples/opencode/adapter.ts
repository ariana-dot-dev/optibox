import { realCliHarness } from "../shared.js";

// Verified-real: OpenCode (`opencode`, package opencode-ai) is multi-provider.
// Installed on demand in the Box; reads ANTHROPIC_API_KEY / OPENAI_API_KEY.
export const harness = realCliHarness({
  name: "opencode",
  description: "OpenCode multi-provider agent running inside the user Box.",
  bin: "opencode",
  installCmd: "npm i -g opencode-ai@latest >/tmp/opencode-install.log 2>&1",
  // Prefer OpenAI when available so the demo does not default to an Anthropic-only path.
  models: [
    { provider: "openai", model: "gpt-4.1-mini", label: "OpenCode · GPT-4.1 mini" },
    { provider: "openai", model: "gpt-4.1", label: "OpenCode · GPT-4.1" },
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "OpenCode · Sonnet 4.6" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "OpenCode · Haiku 4.5" },
  ],
  buildArgv: ({ prompt, model, provider }) => ["opencode", "run", "--model", `${provider}/${model}`, prompt],
});
