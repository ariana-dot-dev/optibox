# Optibox

Optibox is a small TypeScript orchestration layer for consumer agents on Boat. It gives users an instant shared response while starting or resuming their private sandbox, then hands the work to the agents that ship inside that sandbox.

## Minimal wiring

Pick a Boat API key, the provider keys your users' agents run on, and a model for the shared bridge. The private side needs nothing else: every sandbox comes with Claude Code, Codex, pi, OpenCode and Prime Agent installed, and Boat keeps each conversation's memory itself.

```ts
import { BoatHttpClient, Engine, openDb } from "@ascii-prototypes/consumer-boat-agents";

const engine = new Engine({
  db: await openDb(process.env.DATABASE_URL!),
  sandbox: new BoatHttpClient({ apiKey: process.env.BOAT_API_KEY! }),
  instanceId: "my-app",
  credHash: "server",
  providerEnv: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! }, // lands in the user's sandbox, nothing else does
  sharedModel: "anthropic/claude-haiku-4-5",                            // the instant no-tools answer
  autoStopIdleMs: 15_000,
});

for await (const event of engine.runTurn({
  userId: "user-1",
  conversationId: "chat-1",
  message: "Check my CPU count.",
  selection: { harness: "pi", provider: "anthropic", model: "claude-sonnet-5-5", reasoningEffort: "medium" },
})) {
  if (event.type === "shared.delta" || event.type === "user-sandbox.delta") process.stdout.write(event.text);
}

// When the user closes the chat or asks to pause, archive the private sandbox.
for await (const event of engine.stopUserSandbox("user-1", "chat-1")) {
  if (event.type === "billing.stop") console.log("billing paused");
}
```

`selection.harness` is a Boat provider id (`claude-code`, `codex`, `pi`, `opencode`, `prime-agent`); models and reasoning levels come from `GET /api/provider-models`, which the demo server exposes as `/api/harnesses`. A user can switch harness or model on any message: the conversation continues with its memory.

## What Boat does for you

| Job | sandbox |
|---|---|
| Install and update the agents on every machine | Preinstalled; nothing to build or warm-cycle |
| Spawn the agent with the prompt, in the right directory, with the right keys | `POST /sandboxes/{id}/prompt` |
| Capture its output, parse tool calls, stream to the UI | `GET /sandboxes/{id}/events` (text, tool calls, results) |
| Remember the session so the next message continues the thread | A sandbox **conversation**: `new: true` once, then `conversationId` |
| Explore two directions at once without sessions colliding | Parallel conversations on the same sandbox (`scenariosEnabled`) |
| Stop the right process | `POST /sandboxes/{id}/interrupt?conversation=` |
| Keep the memory across stop / resume | Conversations ride the snapshot |
| Give every user their own keys | `POST /sandboxes {noEnv: true, env: {...}}` |

## Handing a machine to someone who is not you

Every sandbox this layer creates passes `noEnv` and its own `env`: the account owner's env vars, secret files and credentials never reach the machine; only the keys in `providerEnv` do. The sandbox keeps its own scoped token, so `host` and the desktop still work.

## The six rules

1. Always answer something: the shared bridge streams immediately, a full answer or a short holding line (its choice).
2. The private agent answers on top, with the shared text handed to it.
3. The shared agent never claims it cannot act: the private machine will.
4. The machine stops after the idle window; any activity resets it; hosting keeps it up.
5. A warm, responsive machine is routed to directly: no bridge text.
6. The private agent declines with exactly `<end>`; no text and no `<end>` is a loud `turn.blocked`.

## Architecture

Your app provides a Boat API key, provider keys, and Postgres. Optibox provides per-user sandbox lifecycle, shared-first routing, the standing rules every harness reads (`AGENTS.md` / `CLAUDE.md`, written once per machine), transcript and hidden context, streaming events for the UI, billing, holds, hosting detection, stop and resume.

```mermaid
stateDiagram-v2
  [*] --> SharedReady
  SharedReady --> EagerSandbox: user message immediately requests private sandbox
  EagerSandbox --> CheckBox: resolve exact runtime state
  CheckBox --> DirectSandbox: Sandbox ready + no private lock
  CheckBox --> SharedFirst: Sandbox missing/provisioning/archived/busy
  SharedFirst --> SharedAnswer: restricted shared stream
  EagerSandbox --> SandboxStarting: start/resume in parallel
  SharedAnswer --> Done: shared says no private work
  SharedAnswer --> HandoffPending: shared says private work needed
  SandboxStarting --> SandboxReady
  SandboxReady --> HandoffPending
  DirectSandbox --> SandboxAnswer
  HandoffPending --> SandboxAnswer: POST /prompt on the sandbox conversation
  SandboxAnswer --> WarmIdle
  WarmIdle --> Archived: stop/idle timeout
  Archived --> SharedReady: next message can resume
  WarmIdle --> DirectSandbox: quick follow-up
```

## Running the repo

```bash
npm install
npm test
```
