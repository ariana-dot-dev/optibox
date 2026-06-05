import { realCliHarness } from "../shared.js";

// Best-effort real: OpenClaude (@gitlawb/openclaude). Installed on demand in the
// Box. Same framework contract; flags may need tuning to the installed version.
export const harness = realCliHarness({
  name: "openclaude",
  description: "OpenClaude coding-agent running inside the user Box.",
  bin: "openclaude",
  installCmd: "npm i -g @gitlawb/openclaude >/tmp/openclaude-install.log 2>&1",
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "OpenClaude · Sonnet 4.6" },
    { provider: "openai", model: "gpt-5.5", label: "OpenClaude · GPT-5.5" },
  ],
  buildArgv: ({ prompt, model }) => ["openclaude", "-p", prompt, "--model", model],
});
