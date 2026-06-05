import { realCliHarness } from "../shared.js";

// Best-effort real: Hermes (Nous Research) models are served over OpenAI-compatible
// endpoints. This adapter drives them via OpenCode's OpenRouter provider, so it
// uses a real external harness + real Hermes model calls. Needs OPENROUTER_API_KEY
// (or adapt buildArgv to your Hermes endpoint).
export const harness = realCliHarness({
  name: "hermes",
  description: "Hermes (Nous Research) model via OpenCode inside the user Box.",
  bin: "opencode",
  installCmd: "npm i -g opencode-ai@latest >/tmp/opencode-install.log 2>&1",
  models: [
    { provider: "openai", model: "nousresearch/hermes-4-70b", label: "Hermes 4 70B" },
  ],
  buildArgv: ({ prompt, model }) => ["opencode", "run", "--model", `openrouter/${model}`, prompt],
});
