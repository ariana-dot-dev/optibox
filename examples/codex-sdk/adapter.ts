import { realCliHarness } from "../shared.js";

// Codex CLI reads project instructions from AGENTS.md in the working root and
// also accepts hidden XML in the initial exec prompt. We set -C to the generated
// per-turn root that contains AGENTS.md.
export const harness = realCliHarness({
  name: "codex-sdk",
  description: "OpenAI Codex CLI / Codex SDK running inside the user Box.",
  bin: "codex",
  instructionDelivery: "workspace-agents-md",
  models: [
    { provider: "openai", model: "gpt-5.5", label: "GPT-5.5 (Codex)" },
    { provider: "openai", model: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
  ],
  outputMode: "codex-json",
  buildArgv: ({ prompt, model, cwd }) => [
    "codex", "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--cd", cwd,
    "-c", 'preferred_auth_method="apikey"',
    "--model", model,
    prompt,
  ],
});
