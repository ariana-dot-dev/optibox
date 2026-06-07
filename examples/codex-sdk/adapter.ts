import { realCliHarness, type RealCliHarnessSpec } from "../shared.js";

// Codex CLI reads project instructions from AGENTS.md in the working root and
// also accepts hidden XML in the initial exec prompt. We set -C to the generated
// per-turn root that contains AGENTS.md.
export const spec: RealCliHarnessSpec = {
  name: "codex-sdk",
  description: "OpenAI Codex CLI / Codex SDK running inside the user Box.",
  bin: "codex",
  instructionDelivery: "workspace-agents-md",
  models: [
    { provider: "openai", model: "gpt-5.5", label: "GPT-5.5 (Codex)" },
    { provider: "openai", model: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
  ],
  outputMode: "codex-json",
  // Codex emits its session id as `{"type":"thread.started","thread_id":"…"}`; we
  // capture it and resume the SAME rollout with `codex exec resume <id> …`. The
  // resume subcommand rejects `-s`, so the sandbox is set via `-c sandbox_mode`
  // (verified, codex-cli 0.137.0 — docs/harness-interrupt-resume-evidence.md).
  sessionStrategy: "capture",
  // Structural no-tool mode (shared infra): Codex has no single "zero tools"
  // flag, so we disable every side-effecting tool via documented config keys —
  // `features.shell_tool=false` removes the command tool entirely,
  // `web_search="disabled"` removes network search, and `-s read-only` blocks
  // apply_patch from mutating the filesystem. Verified against codex-cli 0.137.0:
  // these keys are accepted under --strict-config and the model returns text.
  // The Box run uses --dangerously-bypass-approvals-and-sandbox so tools execute.
  buildArgv: ({ prompt, model, cwd, toolsAllowed, resumeSessionId }) =>
    resumeSessionId
      ? [
          "codex", "exec", "resume", resumeSessionId,
          "--json",
          "--skip-git-repo-check",
          ...(toolsAllowed
            ? ["-c", 'sandbox_mode="danger-full-access"']
            : ["-c", 'sandbox_mode="read-only"', "-c", "features.shell_tool=false", "-c", 'web_search="disabled"']),
          "--model", model,
          prompt,
        ]
      : [
          "codex", "exec",
          "--json",
          "--skip-git-repo-check",
          ...(toolsAllowed
            ? ["--dangerously-bypass-approvals-and-sandbox"]
            : ["-s", "read-only", "-c", "features.shell_tool=false", "-c", 'web_search="disabled"']),
          "--cd", cwd,
          "--model", model,
          prompt,
        ],
};

export const harness = realCliHarness(spec);
