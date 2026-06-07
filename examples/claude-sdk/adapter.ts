import { realCliHarness, type RealCliHarnessSpec } from "../shared.js";

// Claude Code supports per-invocation system prompt appending in print mode via
// --append-system-prompt-file, preserving the native Claude Code tool/system
// prompt while adding our phase/orchestration rules.
export const spec: RealCliHarnessSpec = {
  name: "claude-agent-sdk",
  description: "Anthropic Claude Code / Claude Agent SDK running inside the user Box.",
  bin: "claude",
  instructionDelivery: "claude-append-system-prompt-file",
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  outputMode: "claude-stream-json",
  // Structural no-tool mode (shared infra): `--tools ""` makes Claude Code
  // register ZERO built-in tools. Verified against Claude Code 2.1.145: the
  // stream-json `init` event then reports `"tools":[]`. With tools the Box run
  // uses --dangerously-skip-permissions so the native tools execute.
  buildArgv: ({ prompt, model, systemInstructionPath, toolsAllowed }) => [
    "claude", "-p", prompt,
    "--model", model,
    "--append-system-prompt-file", systemInstructionPath,
    ...(toolsAllowed ? ["--dangerously-skip-permissions"] : ["--tools", ""]),
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
  ],
};

export const harness = realCliHarness(spec);
