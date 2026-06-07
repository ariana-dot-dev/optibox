import { realCliHarness, type RealCliHarnessSpec } from "../shared.js";

// Pi exposes a prompt-first non-interactive CLI surface. We carry phase rules in
// hidden XML in the prompt; tool execution still happens only inside the user Box.
export const spec: RealCliHarnessSpec = {
  name: "pi",
  description: "Pi / PI coding-agent running inside the user Box.",
  bin: "pi",
  installCmd: "npm i -g @earendil-works/pi-coding-agent >/tmp/pi-install.log 2>&1",
  instructionDelivery: "prompt-xml",
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "Pi · Sonnet 4.6" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Pi · Haiku 4.5" },
  ],
  outputMode: "pi-json",
  // Structural no-tool mode (shared infra): Pi documents `--no-tools, -nt
  // Disable all tools` (packages/coding-agent/docs/usage.md), which loads the
  // agent with zero tools. The Box run omits it so the built-in tools (read,
  // bash, edit, write, grep, find, ls) are available.
  buildArgv: ({ prompt, model, toolsAllowed }) => [
    "pi", "--mode", "json",
    ...(toolsAllowed ? [] : ["--no-tools"]),
    prompt, "--model", model,
  ],
};

export const harness = realCliHarness(spec);
