import { realCliHarness } from "../shared.js";

// Hermes is reached through OpenCode's OpenRouter provider. OpenCode consumes
// AGENTS.md project rules, so Hermes receives our phase rules through that
// harness-native rule mechanism plus the hidden XML prompt body.
export const harness = realCliHarness({
  name: "hermes",
  description: "Hermes (Nous Research) model via OpenCode inside the user Box.",
  bin: "opencode",
  installCmd: "npm i -g opencode-ai@latest >/tmp/opencode-install.log 2>&1",
  instructionDelivery: "workspace-agents-md",
  requiredEnv: ["OPENROUTER_API_KEY"],
  models: [
    { provider: "openrouter", model: "nousresearch/hermes-4-70b", label: "Hermes 4 70B" },
  ],
  outputMode: "opencode-json",
  buildArgv: ({ prompt, model }) => ["opencode", "run", "--format", "json", "--model", `openrouter/${model}`, prompt],
});
