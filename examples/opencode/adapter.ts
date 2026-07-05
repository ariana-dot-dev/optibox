import { realCliHarness, opencodeNoToolEnv, type RealCliHarnessSpec } from "../shared.js";

// OpenCode documents project rules via AGENTS.md. The adapter writes a per-turn
// AGENTS.md in the run root and runs opencode from that root.
export const spec: RealCliHarnessSpec = {
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
  // OpenCode emits `"sessionID":"ses_…"` on turn 1; we capture it and continue the
  // SAME session with `-s <sessionID>` (verified, opencode 1.16.2 —
  // docs/harness-interrupt-resume-evidence.md).
  sessionStrategy: "capture",
  buildArgv: ({ prompt, model, provider, resumeSessionId, toolsAllowed }) => [
    "opencode", "run", "--format", "json",
    // Fixed session title: skip OpenCode's auto-title side-call to
    // google/gemini-3.5-flash (errors "Reasoning mandatory", ~0.8s dead time
    // before the real model runs). Verified via --print-logs DEBUG.
    "--title", "optibox",
    // Box run: auto-approve tool permissions; a TTY-less `opencode run` would
    // otherwise hang forever on the first tool call's approval prompt.
    ...(toolsAllowed ? ["--auto"] : []),
    ...(resumeSessionId ? ["-s", resumeSessionId] : []),
    "--model", `${provider}/${model}`, prompt,
  ],
  // Structural tool policy via OPENCODE_CONFIG_CONTENT (see opencodeNoToolEnv):
  // shared run removes every tool with tools:{"*":false}; Box run auto-approves
  // permissions so a TTY-less `opencode run` never hangs on an approval prompt.
  buildEnv: ({ toolsAllowed }) => opencodeNoToolEnv(toolsAllowed),
};

export const harness = realCliHarness(spec);
