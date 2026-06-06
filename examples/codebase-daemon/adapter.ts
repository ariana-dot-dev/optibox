import { realCliHarness } from "../shared.js";

// Checked-out codebase daemon adapter. Products can bake their own daemon into
// the repo/image as ./bin/agent-daemon or npm run agent:daemon. The framework
// only starts that process inside the private Box and streams its native stdout.
export const harness = realCliHarness({
  name: "codebase-daemon",
  description: "Developer's checked-out codebase daemon running inside the user Box.",
  bin: "node",
  instructionDelivery: "workspace-agents-md",
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "Codebase daemon · Sonnet 4.6" },
    { provider: "openai", model: "gpt-4.1", label: "Codebase daemon · GPT-4.1" },
  ],
  outputMode: "raw-stdout",
  prepare: async (caps) => {
    const script = `const text = 'Codebase daemon fallback running inside the private Box. Replace ./bin/agent-daemon or npm run agent:daemon with your real checked-out daemon. ';\nfor (const chunk of text.match(/.{1,18}/g) || []) { process.stdout.write(chunk); await new Promise(r => setTimeout(r, 30)); }\n`;
    const encoded = Buffer.from(script, "utf8").toString("base64");
    await caps.command(`printf %s '${encoded}' | base64 -d > /tmp/cba-codebase-daemon.mjs`);
  },
  buildArgv: ({ prompt, model, provider }) => [
    "bash",
    "-lc",
    [
      "prompt=$1; provider=$2; model=$3",
      "cp /tmp/cba-codebase-daemon.mjs ./cba-codebase-daemon.mjs",
      "if [ -x ./bin/agent-daemon ]; then printf %s \"$prompt\" | exec ./bin/agent-daemon --stream --provider \"$provider\" --model \"$model\"; fi",
      "if [ -f package.json ] && npm run 2>/dev/null | grep -q 'agent:daemon'; then printf %s \"$prompt\" | exec npm run -s agent:daemon -- --stream --provider \"$provider\" --model \"$model\"; fi",
      "node ./cba-codebase-daemon.mjs",
    ].join("; "),
    "cba-codebase-daemon",
    prompt,
    provider,
    model,
  ],
});
