export type StreamingSupport = "native-token" | "native-json-events" | "stdout-chunks" | "final-only" | "blocked";

export interface RuntimeFeasibility {
  runtime: string;
  harnessName: string;
  supported: boolean;
  streaming: StreamingSupport;
  proofPath: string;
  blocker: string | null;
  source: string;
  /**
   * The harness' own STRUCTURAL (framework-enforced) mechanism for running with
   * zero side-effecting tools. The shared-infra surface runs the same binary as
   * the Box with this mechanism engaged; there is no provider fallback and no
   * prompt-only "please don't use tools". If a harness had no such mechanism it
   * would be marked unsupported here rather than faked.
   */
  noToolMechanism: string;
}

/**
 * Feasibility study for the runtimes the demo supports. Keep this data
 * user-visible: the UI and PR report use it to avoid pretending every harness
 * has identical token-level semantics, and to document the exact structural
 * tool-disable mechanism each harness exposes.
 */
export const RUNTIME_FEASIBILITY: RuntimeFeasibility[] = [
  {
    runtime: "Claude SDK / Claude Code",
    harnessName: "claude-agent-sdk",
    supported: true,
    streaming: "native-token",
    proofPath: "claude -p --output-format stream-json --include-partial-messages --verbose",
    blocker: null,
    source: "Official Claude Code CLI documents stream-json partial messages for token deltas.",
    noToolMechanism: "`--tools \"\"` registers zero built-in tools; the stream-json init event reports `\"tools\":[]`. Box run uses --dangerously-skip-permissions instead.",
  },
  {
    runtime: "OpenClaude",
    harnessName: "openclaude",
    supported: true,
    streaming: "stdout-chunks",
    proofPath: "openclaude -p <prompt> --model <model>",
    blocker: "OpenClaude is a Claude Code fork; token granularity depends on the fork's print-mode output.",
    source: "OpenClaude src/main.tsx documents `--tools <tools...>` with `\"\"` to disable all tools (same option as Claude Code).",
    noToolMechanism: "`--tools \"\"` (inherited from the Claude Code fork) disables all tools. Box run uses --dangerously-skip-permissions instead.",
  },
  {
    runtime: "OpenAI Codex CLI / SDK",
    harnessName: "codex-sdk",
    supported: true,
    streaming: "native-json-events",
    proofPath: "codex exec --json --skip-git-repo-check -s read-only -c features.shell_tool=false -c web_search=\"disabled\"",
    blocker: "Codex has no single zero-tools flag; tools are removed via a documented combination of config keys (verified accepted under --strict-config on codex-cli 0.137.0).",
    source: "Codex CLI config docs: features.shell_tool, web_search, and -s/--sandbox read-only.",
    noToolMechanism: "`features.shell_tool=false` removes the command tool, `web_search=\"disabled\"` removes network search, `-s read-only` blocks apply_patch writes. Box run uses --dangerously-bypass-approvals-and-sandbox.",
  },
  {
    runtime: "Checked-out codebase daemon",
    harnessName: "codebase-daemon",
    supported: true,
    streaming: "stdout-chunks",
    proofPath: "examples/codebase-daemon/agentDaemon.ts or CODEBASE_DAEMON_DIR/bin/agent-daemon --stream [--no-tools] --provider <provider> --model <model> --cwd <optibox-cwd> --system-prompt-file <file>",
    blocker: "Only token-level if the product daemon flushes token chunks; otherwise we relay whatever stdout chunks it emits.",
    source: "Self-contained sample daemon plus product-owned daemon contract in examples/codebase-daemon.",
    noToolMechanism: "`--no-tools` launches the daemon with zero machine tools (it never reads os.cpus/cwd and defers machine requests). Box run omits it.",
  },
  {
    runtime: "Pi coding agent",
    harnessName: "pi",
    supported: true,
    streaming: "native-json-events",
    proofPath: "pi --mode json [--no-tools] <prompt> --model <model>",
    blocker: "The current simple CLI adapter must be upgraded to Pi RPC stdin/stdout for strict token events; simple --mode json may collapse updates depending on Pi version.",
    source: "Pi docs (packages/coding-agent/docs/usage.md) document `--no-tools, -nt Disable all tools`; --mode rpc/json for headless JSON.",
    noToolMechanism: "`--no-tools` loads the agent with zero tools (read/bash/edit/write/grep/find/ls). Box run omits it.",
  },
  {
    runtime: "Hermès / Hermes",
    harnessName: "hermes",
    supported: true,
    streaming: "stdout-chunks",
    proofPath: "opencode run --format json --model openrouter/nousresearch/hermes-4-70b (OPENCODE_CONFIG_CONTENT permission map)",
    blocker: "Direct Hermes token-event schema is not stable in this prototype; Hermes via OpenCode inherits OpenCode JSON event granularity.",
    source: "Hermes runs through OpenCode's OpenRouter provider; OpenCode docs describe raw JSON events and the permission system.",
    noToolMechanism: "Inherits OpenCode's structural permission map: OPENCODE_CONFIG_CONTENT={\"permission\":{\"*\":\"deny\"}} denies every tool. Box run sets no override.",
  },
  {
    runtime: "OpenCode",
    harnessName: "opencode",
    supported: true,
    streaming: "native-json-events",
    proofPath: "opencode run --format json --model provider/model (OPENCODE_CONFIG_CONTENT permission map)",
    blocker: "OpenCode JSON events are model/text events, not guaranteed one event per provider token; the UI relays each emitted JSON text event immediately.",
    source: "OpenCode CLI docs describe --format json raw JSON events and the framework-enforced permission system.",
    noToolMechanism: "OPENCODE_CONFIG_CONTENT={\"permission\":{\"*\":\"deny\"}} denies bash/edit/read/webfetch/all tools (framework-enforced). Box run sets no override, keeping defaults.",
  },
];
