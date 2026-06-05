import { realCliHarness } from "../shared.js";

// OpenClaude exposes a prompt-first non-interactive CLI surface. We carry
// control-plane instructions in hidden XML inside that prompt, so the model can
// adapt naturally without hardcoded responses.
export const harness = realCliHarness({
  name: "openclaude",
  description: "OpenClaude coding-agent running inside the user Box.",
  bin: "openclaude",
  installCmd: "npm i -g @gitlawb/openclaude >/tmp/openclaude-install.log 2>&1",
  instructionDelivery: "prompt-xml",
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "OpenClaude · Sonnet 4.6" },
    { provider: "openai", model: "gpt-5.5", label: "OpenClaude · GPT-5.5" },
  ],
  buildArgv: ({ prompt, model }) => ["openclaude", "-p", prompt, "--model", model],
});
