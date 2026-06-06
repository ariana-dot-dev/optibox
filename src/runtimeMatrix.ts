export type StreamingSupport = "native-token" | "native-json-events" | "stdout-chunks" | "final-only" | "blocked";

export interface RuntimeFeasibility {
  runtime: string;
  harnessName: string;
  supported: boolean;
  streaming: StreamingSupport;
  proofPath: string;
  blocker: string | null;
  source: string;
}

/**
 * Feasibility study for the runtimes explicitly required by the demo. Keep this
 * data user-visible: the UI and PR report use it to avoid pretending every
 * harness has identical token-level semantics.
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
  },
  {
    runtime: "Checked-out codebase daemon",
    harnessName: "codebase-daemon",
    supported: true,
    streaming: "stdout-chunks",
    proofPath: "CODEBASE_DAEMON_DIR=/home/user/codebase ./bin/agent-daemon --stream --provider <provider> --model <model> --cwd <optibox-cwd> --system-prompt-file <file>",
    blocker: "Only token-level if the product daemon flushes token chunks; otherwise we relay whatever stdout chunks it emits.",
    source: "Product-owned daemon contract in examples/codebase-daemon.",
  },
  {
    runtime: "Pi coding agent",
    harnessName: "pi",
    supported: true,
    streaming: "native-json-events",
    proofPath: "pi --mode rpc / AgentSession JSON protocol",
    blocker: "The current simple CLI adapter must be upgraded to Pi RPC stdin/stdout for strict token events; simple --mode json may collapse updates depending on Pi version.",
    source: "Pi docs describe --mode rpc headless JSON over stdin/stdout and AgentSession for Node/TypeScript embedding.",
  },
  {
    runtime: "Hermès / Hermes",
    harnessName: "hermes",
    supported: true,
    streaming: "stdout-chunks",
    proofPath: "Hermes CLI or Hermes-through-OpenCode/OpenRouter inside Box",
    blocker: "Direct Hermes token-event schema is not stable in this prototype; Hermes via OpenCode inherits OpenCode JSON event granularity.",
    source: "Hermes docs describe CLI streaming; OpenCode docs describe raw JSON events for run --format json.",
  },
  {
    runtime: "OpenCode",
    harnessName: "opencode",
    supported: true,
    streaming: "native-json-events",
    proofPath: "opencode run --format json --model provider/model",
    blocker: "OpenCode JSON events are model/text events, not guaranteed one event per provider token; the UI relays each emitted JSON text event immediately.",
    source: "OpenCode CLI docs describe --format json raw JSON events.",
  },
];
