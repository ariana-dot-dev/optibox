import { realCliHarness } from "../shared.js";

// Claude Code supports per-invocation system prompt appending in print mode via
// --append-system-prompt-file, preserving the native Claude Code tool/system
// prompt while adding our phase/orchestration rules.
export const harness = realCliHarness({
  name: "claude-agent-sdk",
  description: "Anthropic Claude Code / Claude Agent SDK running inside the user Box.",
  bin: "claude",
  instructionDelivery: "claude-append-system-prompt-file",
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  outputMode: "claude-stream-json",
  buildArgv: ({ prompt, model, systemInstructionPath }) => [
    "claude", "-p", prompt,
    "--model", model,
    "--append-system-prompt-file", systemInstructionPath,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
  ],
});
