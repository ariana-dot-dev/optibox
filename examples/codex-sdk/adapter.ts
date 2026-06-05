import { realCliHarness } from "../shared.js";

// Generic example only — NOT used in the Claude-only demo backend. The Codex CLI
// (`codex`, package @openai/codex / @openai/codex-sdk) is preinstalled in every
// Box and runs in API-key auth mode when a scoped sk-... OPENAI_API_KEY is set.
export const harness = realCliHarness({
  name: "codex-sdk",
  description: "OpenAI Codex CLI / Codex SDK running inside the user Box.",
  bin: "codex",
  models: [
    { provider: "openai", model: "gpt-5.5", label: "GPT-5.5 (Codex)" },
    { provider: "openai", model: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
  ],
  buildArgv: ({ prompt, model }) => [
    "codex", "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
    "-c", 'preferred_auth_method="apikey"', "--model", model, prompt,
  ],
});
