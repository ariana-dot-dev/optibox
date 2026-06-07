# Harness Interrupt & Session-Resume Evidence

Date: 2026-06-07

Goal: for every supported harness, establish the EXACT, proven mechanism to (1)
**interrupt** a running CLI harness ("agent stops talking") and (2) **resume the
same conversation** with full history on the next prompt — including on shared
infra, which requires per-conversation session-id bookkeeping. No mechanism is
implemented until it is proven here with a working example.

The 7 adapters reduce to **4 distinct CLIs** plus our own bundled daemon:

| Adapter(s) | CLI | Installed version (this machine) |
|---|---|---|
| `claude-agent-sdk`, `openclaude` | `claude` (Claude Code) | 2.1.145 |
| `codex-sdk` | `codex exec` | codex-cli 0.137.0 |
| `pi` | `pi` | 0.74.2 |
| `opencode`, `hermes` | `opencode run` | 1.16.2 |
| `codebase-daemon` | bundled `agent-daemon` (we own the source) | n/a |

## Interrupt: uniform, structural

All five are **subprocess CLIs** that persist session state to disk
incrementally (JSONL/DB). Therefore "interrupt" == signal the process:
`SIGINT` (graceful) then `SIGKILL` (hard). The effect is identical to "the agent
stops talking" — the stdout stream ends and the process exits. Prior **completed**
turns are already flushed to the session file and remain resumable. This is the
same honesty rule as the no-tools work: no harness needs a bespoke in-band
interrupt API, and none requires faking. (A future in-process SDK adapter — not a
subprocess — would need its own abort hook; today none are.)

Implementation note proven below (Claude): resuming the *instant* after `SIGKILL`
can transiently fail because the session file is mid-flush; let the process fully
die before issuing the resume (a short settle / one retry).

---

## 1. Claude Code (`claude`) — claude-agent-sdk, openclaude

**Flags (installed `claude --help`, v2.1.145):**
- `--session-id <uuid>` — "Use a specific session ID for the conversation (must be a valid UUID)". We **assign** the id up front; no capture needed.
- `-r, --resume [value]` — "Resume a conversation by session ID".
- `-c, --continue` — most recent conversation in cwd.
- `--fork-session` — new id when resuming.
- All work in print mode (`-p`). `session_id` is also echoed on every `--output-format json` result.

**Live proof (print mode, tools disabled with `--tools ""`):**
```
turn1: claude -p "secret word is BANANA42 ..." --session-id 8342240e-... --tools "" --output-format json
       -> session_id: 8342240e-...   result: "noted."
turn2: claude -p "What was the secret word?" -r 8342240e-... --tools "" --output-format json
       -> result: "BANANA42"          (history retained across processes)
```

**Interrupt proof:** started a long turn on the same session, `kill -INT` then
`kill -KILL` mid-stream; after the process died, `-r <id> "first secret word?"`
returned `"BANANA42"` — the session survived the mid-turn kill and resumed.

**Mechanism:** assign `--session-id <uuid>` on turn 1, `-r <uuid>` on every later
turn. Interrupt = SIGINT→SIGKILL.

Sources: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) (and live `claude --help` 2.1.145).

---

## 2. Codex (`codex exec`) — codex-sdk

**Flags (installed `codex exec --help` / `codex exec resume --help`, 0.137.0):**
- `codex exec resume [SESSION_ID] [PROMPT]` — "Resume a previous session by id or pick the most recent with `--last`". SESSION_ID is a UUID/thread name.
- `--last`, `--all`. `--json` gives newline-delimited events.
- **Resume subcommand uses different flags than `exec`:** `-s` is NOT accepted; sandbox is set via `-c sandbox_mode="read-only"`. The no-tool config keys still apply: `-c features.shell_tool=false -c web_search="disabled"`.
- Session id is emitted as `{"type":"thread.started","thread_id":"<uuid>"}` in `--json`. Sessions persist under `$CODEX_HOME/sessions` (default `~/.codex/sessions`).
- **Auth:** codex uses ChatGPT auth in `$CODEX_HOME/auth.json`. A per-conversation `CODEX_HOME` MUST contain that `auth.json` (an empty home → HTTP 401). Simplest: keep the shared `CODEX_HOME` and resume by explicit `thread_id` (parallel-safe), or copy `auth.json` into an isolated home.

**Live proof (`--json`, read-only / no tools):**
```
turn1: codex exec --json ... -s read-only -c features.shell_tool=false -c web_search="disabled" "secret word is OTTER77 ..."
       -> {"type":"thread.started","thread_id":"019ea23a-20c1-7bb1-acb4-e1c4088ce1f2"}   text: "noted"
turn2: codex exec resume 019ea23a-... --json -c sandbox_mode="read-only" -c features.shell_tool=false -c web_search="disabled" "What was the secret word?"
       -> text: "OTTER77"            (history retained across processes)
```

**Mechanism:** turn 1 `codex exec --json` → capture `thread.started.thread_id`;
later turns `codex exec resume <thread_id> <prompt>` (sandbox/no-tool via `-c`).
Interrupt = SIGINT→SIGKILL; rollout JSONL persists and is resumable by id.

Sources: live `codex exec resume --help` (0.137.0); [Codex CLI reference](https://developers.openai.com/codex/cli/reference); [Resuming a previous session · openai/codex#1076](https://github.com/openai/codex/discussions/1076).

---

## 3. Pi (`pi`) — pi

**Flags (docs `packages/coding-agent/docs/usage.md` + `sessions.md`, and live):**
- `--session <path|id>` — "Use a specific session file or partial UUID". (Proven reliable.)
- `-c, --continue` — most recent session. (In `--mode json` non-interactive this did **not** reliably carry history in testing; prefer explicit `--session <id>`.)
- `--fork <path|id>`, `--no-session`, `--session-dir <dir>` (env `PI_CODING_AGENT_SESSION_DIR`).
- `--mode json` first line is the session header: `{"type":"session","version":3,"id":"<uuid>","timestamp":...,"cwd":...}` — that `id` is the resume id.
- `--no-tools` for shared parity. Sessions persist under `~/.pi/agent/sessions/` (or `--session-dir`).

**Live proof (`--mode json --no-tools`, isolated `PI_CODING_AGENT_SESSION_DIR`):**
```
turn1: pi --mode json --no-tools "secret word is FALCON8 ..."   -> header id 019ea241-2531-7d74-...
turn2: pi --mode json --no-tools --session 019ea241-... "What was the secret word earlier in this session?"
       -> model: "Looking at the conversation history, ... you asked me to remember ... in your first message"
```
History was carried across processes (the model explicitly referenced the prior
message; it declined to parrot the literal word as a model-safety stance — that
is a model artifact, not a resume failure). The session JSONL contained `FALCON8`.

**Mechanism:** turn 1 `pi --mode json` → capture header `id`; later turns
`pi --mode json --session <id>`. Isolate storage per conversation with
`PI_CODING_AGENT_SESSION_DIR`. Interrupt = SIGINT→SIGKILL.

Sources: [pi sessions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md), [pi usage.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md), [pi json.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md).

---

## 4. OpenCode (`opencode run`) — opencode, hermes

**Flags (docs `opencode.ai/docs/cli` + live):**
- `-s, --session <id>` — "Session ID to continue".
- `-c, --continue` — last session. `--fork`.
- `--format json` — raw JSON events; turn 1 emits `"sessionID":"ses_..."`. `opencode session list --format json` also lists ids.
- Structural no-tool via `OPENCODE_CONFIG_CONTENT={"permission":{"*":"deny"}}` (already in adapters). Sessions persist under `~/.local/share/opencode`.

**Live proof (`--format json`):**
```
turn1: opencode run --format json --model anthropic/claude-haiku-4-5 "Remember FALCON8 ..."
       -> "sessionID":"ses_15dbe65e7ffe7uk38yIxYg5nVX"
turn2: opencode run --format json -s ses_15dbe65e7ffe7uk38yIxYg5nVX "What is the secret word?"
       -> "... I see you asked me to remember \"FALCON8\" in your first message, and I acknowledged it."
```
History fully carried across separate `opencode run` invocations.

**Mechanism:** turn 1 `opencode run --format json` → capture `sessionID`; later
turns `opencode run -s <sessionID>`. Interrupt = SIGINT→SIGKILL.

Sources: [OpenCode CLI docs](https://opencode.ai/docs/cli/); live `opencode` 1.16.2.

---

## 5. Codebase daemon (bundled `agent-daemon`)

We own `examples/codebase-daemon/agentDaemon.ts`, so session continuity and
interrupt are implemented in-source: persist a session transcript keyed by an id
passed via `--session-id <id>` / `--resume <id>`, and handle `SIGINT` to stop
the current turn cleanly while leaving the persisted transcript intact. This
mirrors the external CLIs rather than faking a flag.

---

## Resulting uniform contract

- **Interrupt:** SIGINT → (after a short grace) SIGKILL the harness process.
  Shared infra: kill the local child. User Box: kill the captured PID via
  `box.command`. Let the process fully die before resuming (session file flush).
- **Resume / session bookkeeping (per conversation, per harness):**
  - claude: assign `--session-id <uuid>` (turn 1) → `-r <uuid>` (resume).
  - codex: capture `thread.started.thread_id` → `codex exec resume <id>` (sandbox via `-c`).
  - pi: capture json header `id` → `--session <id>` (+ isolated `PI_CODING_AGENT_SESSION_DIR`).
  - opencode/hermes: capture `sessionID` → `-s <id>`.
  - codebase-daemon: `--session-id` / `--resume <id>` (own implementation).
- **Coalescing:** on interrupt + new message, the resumed prompt is prefixed with
  a hidden reminder to address ALL unanswered user messages, not just the latest.

---

## Implementation status (landed in this change)

The proven contract above is now wired through the framework (foundation layer):

- **Types** (`src/types.ts`): `HarnessRunSpec`, `SharedContext`, and
  `UserBoxContext` carry `sessionId?`, `onSessionId?(id)`, and `signal?`
  (AbortSignal) so both surfaces can resume by id and be interrupted.
- **Runtimes** (`src/capabilities.ts`):
  - `extractSessionId(j, mode)` + `noteSessionId` report the native id exactly
    once per run via `onSessionId` (claude `session_id`, codex
    `thread.started.thread_id`, opencode `sessionID`, pi header `id`).
  - Shared-infra `runHarness` honors `signal`: SIGINT then (2s grace) SIGKILL the
    local child. User-Box `runHarness` kills the captured PID in-Box
    (`kill -INT … ; sleep 0.2 ; kill -KILL …`).
- **Adapter layer** (`examples/shared.ts`): `sessionStrategy` ("assign" mints a
  UUID up front; "capture" reads the CLI-emitted id) drives `buildArgv`’s
  `sessionId` / `resumeSessionId`. Each adapter renders its native flag
  (`-r`, `codex exec resume`, `--session`, `-s`, `--session-id`/`--resume`).
- **Orchestrator** (`src/orchestrator.ts`): `harnessSessions` map keyed
  `${userId}:${conversationId}:${harness}:${surface}` persists/resumes each
  surface’s session id across turns; `sessionId`/`onSessionId` are threaded into
  both `harness.shared(...)` and `harness.userBox(...)`.
- **Daemon** (`examples/codebase-daemon/agentDaemon.ts`): real transcript
  persistence — `--session-id`/`--resume <id>` load and append a JSONL transcript
  (`OPTIBOX_DAEMON_SESSION_DIR`), and a resume turn reports the prior-turn count.
  Verified: turn 2 with `--resume` reads turn 1’s persisted transcript.
- **Part-A autostop fix** (`src/orchestrator.ts`): the idle-stop is no longer
  armed while a private round is still owed (`activePrivateRound`) or a Box boot
  is in flight (`userBoxStarts`), so a shared-only answer can’t stop a box that
  is still booting/owing a turn and force a re-boot next message.

Tests: `node --test` green (50/50), including new coverage for per-mode
`onSessionId` extraction, per-adapter resume argv, and shared-infra abort.

**Not yet landed (deferred, needs per-case decisions):** the orchestrator
queue→interrupt+coalesce policy inversion, and two live Box-side validations
(codex tools-side `exec resume`; in-Box PID interrupt against a real Box).
