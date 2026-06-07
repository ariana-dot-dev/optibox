import { readFile } from "node:fs/promises";
import { realCliHarness, type RealCliHarnessSpec } from "../shared.js";

// Self-contained codebase daemon adapter. By default, prepare() copies the
// included sample daemon into the user Box and runs that. Products can replace
// it by setting CODEBASE_DAEMON_DIR to a checkout containing their own
// ./bin/agent-daemon or npm run agent:daemon entrypoint.
export const spec: RealCliHarnessSpec = {
  name: "codebase-daemon",
  description: "Self-contained codebase daemon example running inside the user Box.",
  bin: "bash",
  instructionDelivery: "workspace-agents-md",
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-6", label: "Codebase daemon · Sonnet 4.6" },
    { provider: "openai", model: "gpt-4.1", label: "Codebase daemon · GPT-4.1" },
  ],
  outputMode: "raw-stdout",
  prepare: async (caps) => {
    const source = await readFile(new URL("./agentDaemon.js", import.meta.url), "utf8");
    const encoded = Buffer.from(source, "utf8").toString("base64");
    await caps.command(`mkdir -p /tmp/optibox-codebase-daemon-example/bin && printf %s '${encoded}' | base64 -d > /tmp/optibox-codebase-daemon-example/bin/agent-daemon && chmod +x /tmp/optibox-codebase-daemon-example/bin/agent-daemon`);
  },
  // Structural no-tool mode (shared infra): the daemon documents `--no-tools`,
  // which launches the agent with zero machine tools (no os.cpus/cwd reads). The
  // adapter threads toolsAllowed through as a positional and appends --no-tools
  // when tools are denied. The Box run omits it so the daemon's tools are live.
  buildArgv: ({ prompt, model, provider, cwd, systemInstructionPath, toolsAllowed }) => [
    "bash",
    "-lc",
    [
      "set -euo pipefail",
      "prompt=$1; provider=$2; model=$3; optibox_cwd=$4; system_file=$5; notools=$6",
      'daemon_dir="${CODEBASE_DAEMON_DIR:-/tmp/optibox-codebase-daemon-example}"',
      'if [ -x "$daemon_dir/bin/agent-daemon" ]; then printf %s "$prompt" | exec "$daemon_dir/bin/agent-daemon" --stream $notools --provider "$provider" --model "$model" --cwd "$optibox_cwd" --system-prompt-file "$system_file"; fi',
      'if [ -f "$daemon_dir/package.json" ] && npm --prefix "$daemon_dir" run 2>/dev/null | grep -q "agent:daemon"; then printf %s "$prompt" | exec npm --prefix "$daemon_dir" run -s agent:daemon -- --stream $notools --provider "$provider" --model "$model" --cwd "$optibox_cwd" --system-prompt-file "$system_file"; fi',
      'echo "Missing codebase daemon. The bundled sample was not installed, or CODEBASE_DAEMON_DIR does not contain ./bin/agent-daemon or package.json with an agent:daemon script." >&2',
      "exit 127",
    ].join("; "),
    "codebase-daemon",
    prompt,
    provider,
    model,
    cwd,
    systemInstructionPath,
    toolsAllowed ? "" : "--no-tools",
  ],
};

export const harness = realCliHarness(spec);
