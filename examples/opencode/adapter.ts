import { realCliHarness } from "../shared.js";

// OpenCode documents project rules via AGENTS.md. The adapter writes a per-turn
// AGENTS.md in the run root and runs opencode from that root.
export const harness = realCliHarness({
  name: "opencode",
  description: "OpenCode multi-provider agent running inside the user Box.",
  bin: "opencode",
  installCmd: "npm i -g opencode-ai@latest >/tmp/opencode-install.log 2>&1",
  instructionDelivery: "workspace-agents-md",
  models: [
    { provider: "openai", model: "gpt-4.1-mini", label: "OpenCode · GPT-4.1 mini" },
    { provider: "openai", model: "gpt-4.1", label: "OpenCode · GPT-4.1" },
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "OpenCode · Sonnet 4.6" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "OpenCode · Haiku 4.5" },
  ],
  outputMode: "opencode-json",
  buildArgv: ({ prompt, model, provider }) => ["opencode", "run", "--format", "json", "--model", `${provider}/${model}`, prompt],
});
