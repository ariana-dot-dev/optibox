import { realCliHarness, opencodeNoToolEnv, type RealCliHarnessSpec } from "../shared.js";

// The OpenCode CLI driving OpenRouter models inside the user Box. The default
// model is Claude Sonnet (the one whose OpenRouter endpoint exposes tools);
// Nous Research's Hermes is offered only as a no-tools chat model. OpenCode
// consumes AGENTS.md project rules, so the model receives our phase rules
// through that harness-native mechanism plus the hidden XML prompt body.
export const spec: RealCliHarnessSpec = {
  name: "opencode-openrouter",
  description: "OpenCode CLI via OpenRouter (default Claude Sonnet with tools; Hermes for no-tools chat), inside the user Box.",
  bin: "opencode",
  installCmd: "npm i -g opencode-ai@latest >/tmp/opencode-install.log 2>&1",
  instructionDelivery: "workspace-agents-md",
  requiredEnv: ["OPENROUTER_API_KEY"],
  models: [
    // Sonnet supports OpenRouter's tool-use API, so the private Box can actually
    // call tools (curl/ls/etc). Listed first so it is the default selection.
    { provider: "openrouter", model: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (tools)" },
    // Hermes drives great shared chat but its OpenRouter endpoint reports
    // tools:false — pick it only for no-tool conversation, not private Box work.
    { provider: "openrouter", model: "nousresearch/hermes-4-70b", label: "Hermes 4 70B (chat only, no tools)" },
  ],
  outputMode: "opencode-json",
  // The shared holding/answer line needs speed, not depth: haiku reaches first
  // text in ~4.2s vs sonnet's ~7.2s (measured via openrouter).
  sharedModel: { model: "anthropic/claude-haiku-4.5" },
  // Same OpenCode session model: capture `sessionID` on turn 1, resume with `-s`.
  sessionStrategy: "capture",
  buildArgv: ({ prompt, model, resumeSessionId, toolsAllowed }) => [
    "opencode", "run", "--format", "json",
    // Fixed session title. Without it, OpenCode fires a second LLM call to
    // google/gemini-3.5-flash just to name the session (which errors "Reasoning
    // mandatory" on that model) BEFORE the real model runs — measured ~0.8s of
    // dead time per turn. A static title skips that side-call entirely.
    "--title", "optibox",
    // Private Box run: auto-approve tool permissions so `opencode run` doesn't
    // block forever on a TTY-less approval prompt the first time it calls a tool.
    ...(toolsAllowed ? ["--auto"] : []),
    ...(resumeSessionId ? ["-s", resumeSessionId] : []),
    "--model", `openrouter/${model}`, prompt,
  ],
  // Hermes runs through OpenCode, so it inherits OpenCode's structural no-tool
  // mode: an inline OPENCODE_CONFIG_CONTENT permission map that denies all tools.
  buildEnv: ({ toolsAllowed }) => opencodeNoToolEnv(toolsAllowed),
};

export const harness = realCliHarness(spec);
