import { realCliHarness, opencodeNoToolEnv, type RealCliHarnessSpec } from "../shared.js";

// Hermes is reached through OpenCode's OpenRouter provider. OpenCode consumes
// AGENTS.md project rules, so Hermes receives our phase rules through that
// harness-native rule mechanism plus the hidden XML prompt body.
export const spec: RealCliHarnessSpec = {
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
  // Same OpenCode session model: capture `sessionID` on turn 1, resume with `-s`.
  sessionStrategy: "capture",
  buildArgv: ({ prompt, model, resumeSessionId }) => [
    "opencode", "run", "--format", "json",
    ...(resumeSessionId ? ["-s", resumeSessionId] : []),
    "--model", `openrouter/${model}`, prompt,
  ],
  // Hermes runs through OpenCode, so it inherits OpenCode's structural no-tool
  // mode: an inline OPENCODE_CONFIG_CONTENT permission map that denies all tools.
  buildEnv: ({ toolsAllowed }) => opencodeNoToolEnv(toolsAllowed),
};

export const harness = realCliHarness(spec);
