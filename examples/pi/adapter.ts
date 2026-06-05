import { realCliHarness } from "../shared.js";

// Pi exposes a prompt-first non-interactive CLI surface. We carry phase rules in
// hidden XML in the prompt; tool execution still happens only inside the user Box.
export const harness = realCliHarness({
  name: "pi",
  description: "Pi / PI coding-agent running inside the user Box.",
  bin: "pi",
  installCmd: "npm i -g @earendil-works/pi-coding-agent >/tmp/pi-install.log 2>&1",
  instructionDelivery: "prompt-xml",
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "Pi · Sonnet 4.6" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Pi · Haiku 4.5" },
  ],
  buildArgv: ({ prompt, model }) => ["pi", "-p", prompt, "--model", model],
});
