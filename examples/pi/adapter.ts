import { realCliHarness } from "../shared.js";

// Best-effort real: Pi coding-agent (@earendil-works/pi-coding-agent). Installed
// on demand in the Box. Same framework contract as the verified harnesses; the
// exact CLI flags may need tuning to the installed Pi version.
export const harness = realCliHarness({
  name: "pi",
  description: "Pi / PI coding-agent running inside the user Box.",
  bin: "pi",
  installCmd: "npm i -g @earendil-works/pi-coding-agent >/tmp/pi-install.log 2>&1",
  // Claude-only for the demo backend (Sonnet + Haiku).
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "Pi · Sonnet 4.6" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Pi · Haiku 4.5" },
  ],
  buildArgv: ({ prompt, model }) => ["pi", "-p", prompt, "--model", model],
});
