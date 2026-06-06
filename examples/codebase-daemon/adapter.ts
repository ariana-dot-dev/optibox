import { realCliHarness } from "../shared.js";

// Checked-out codebase daemon adapter. The product image/Box should contain the
// product daemon checkout at CODEBASE_DAEMON_DIR, defaulting to
// /home/user/codebase. The daemon receives the full Optibox prompt on stdin and
// the per-turn instruction workspace through explicit flags.
export const harness = realCliHarness({
  name: "codebase-daemon",
  description: "Developer's checked-out codebase daemon running inside the user Box.",
  bin: "bash",
  instructionDelivery: "workspace-agents-md",
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "Codebase daemon · Sonnet 4.6" },
    { provider: "openai", model: "gpt-4.1", label: "Codebase daemon · GPT-4.1" },
  ],
  outputMode: "raw-stdout",
  buildArgv: ({ prompt, model, provider, cwd, systemInstructionPath }) => [
    "bash",
    "-lc",
    [
      "set -euo pipefail",
      "prompt=$1; provider=$2; model=$3; optibox_cwd=$4; system_file=$5",
      'daemon_dir="${CODEBASE_DAEMON_DIR:-/home/user/codebase}"',
      'if [ -x "$daemon_dir/bin/agent-daemon" ]; then printf %s "$prompt" | exec "$daemon_dir/bin/agent-daemon" --stream --provider "$provider" --model "$model" --cwd "$optibox_cwd" --system-prompt-file "$system_file"; fi',
      'if [ -f "$daemon_dir/package.json" ] && npm --prefix "$daemon_dir" run 2>/dev/null | grep -q "agent:daemon"; then printf %s "$prompt" | exec npm --prefix "$daemon_dir" run -s agent:daemon -- --stream --provider "$provider" --model "$model" --cwd "$optibox_cwd" --system-prompt-file "$system_file"; fi',
      'echo "Missing codebase daemon. Set CODEBASE_DAEMON_DIR to a checkout containing ./bin/agent-daemon or package.json with an agent:daemon script." >&2',
      "exit 127",
    ].join("; "),
    "codebase-daemon",
    prompt,
    provider,
    model,
    cwd,
    systemInstructionPath,
  ],
});
