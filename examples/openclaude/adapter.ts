import { realCliHarness, type RealCliHarnessSpec } from "../shared.js";

// OpenClaude exposes a prompt-first non-interactive CLI surface. We carry
// control-plane instructions in hidden XML inside that prompt, so the model can
// adapt naturally without hardcoded responses.
export const spec: RealCliHarnessSpec = {
  name: "openclaude",
  description: "OpenClaude coding-agent running inside the user Box.",
  bin: "openclaude",
  installCmd: "npm i -g @gitlawb/openclaude >/tmp/openclaude-install.log 2>&1",
  instructionDelivery: "prompt-xml",
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "OpenClaude · Sonnet 4.6" },
    { provider: "openai", model: "gpt-5.5", label: "OpenClaude · GPT-5.5" },
  ],
  // OpenClaude is a Claude Code fork, so it shares Claude Code's session id model:
  // assign `--session-id <uuid>` on turn 1 and resume with `-r <uuid>`.
  sessionStrategy: "assign",
  // OpenClaude is a Claude Code fork and exposes the same `--tools` option
  // (src/main.tsx: `--tools <tools...> … Use "" to disable all tools`). The
  // shared run passes `--tools ""` for a structural zero-tool surface; the Box
  // run bypasses permissions so the native tools execute.
  buildArgv: ({ prompt, model, toolsAllowed, sessionId, resumeSessionId }) => [
    "openclaude", "-p", prompt,
    ...(resumeSessionId ? ["-r", resumeSessionId] : sessionId ? ["--session-id", sessionId] : []),
    "--model", model,
    ...(toolsAllowed ? ["--dangerously-skip-permissions"] : ["--tools", ""]),
  ],
};

export const harness = realCliHarness(spec);
