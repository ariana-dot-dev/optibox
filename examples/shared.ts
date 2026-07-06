import { randomUUID } from "node:crypto";
import { createSharedInfraCapabilities } from "../src/capabilities.js";
import { sharedDirectStream } from "./sharedDirectStream.js";
import type { CommandResult, HarnessAdapter, HarnessOutputChunk, HarnessOutputMode, HarnessRuntime, ModelOption, SharedContext, UserBoxContext } from "../src/index.js";

/** Provider->envvar pairs to inject into the Box so the harness can call the LLM. */
export function providerEnvForBox(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY_SCOPED ?? process.env.OPENAI_API_KEY;
  if (openaiKey) {
    env.OPENAI_API_KEY = openaiKey;
    env.OPENAI_API_KEY_SCOPED = openaiKey;
  }
  if (process.env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  return env;
}

export type InstructionDelivery =
  | "prompt-xml"
  | "claude-append-system-prompt-file"
  | "workspace-agents-md";

export type HarnessPhase = "shared" | "user-box";

export interface HarnessPhasePolicy {
  phase: HarnessPhase;
  /** Whether the framework intentionally exposes private/user-machine tools to this harness run. */
  toolsAllowed: boolean;
  /** Where the harness process/model call executes. */
  runtime: "shared-infra" | "user-box";
}

export interface HarnessPromptBundle {
  policy: HarnessPhasePolicy;
  instructions: string;
  prompt: string;
}

export interface BuildArgvInput {
  prompt: string;
  model: string;
  provider: string;
  cwd: string;
  systemInstructionPath: string;
  /**
   * Whether the framework intends this run to have private/user-machine tools.
   * When false, buildArgv MUST add the harness' own STRUCTURAL no-tool flags so
   * the model is given zero side-effecting tools (verified per harness in
   * docs/shared-vs-box-harness-gap-report.md). This is the single parameter that
   * differs between the shared and Box runs of the same harness.
   */
  toolsAllowed: boolean;
  /**
   * Session id to ASSIGN on turn 1 for assign-style CLIs (claude `--session-id`,
   * openclaude `--session-id`, daemon `--session-id`). Capture-style CLIs ignore
   * it. Present only on the first turn of a conversation+harness.
   */
  sessionId?: string;
  /**
   * Session id to RESUME a prior conversation+harness on its NATIVE session
   * (claude `-r`, codex `exec resume <id>`, pi `--session`, opencode `-s`, daemon
   * `--resume`). Present only on resume turns. See
   * docs/harness-interrupt-resume-evidence.md for the proven per-CLI mechanism.
   */
  resumeSessionId?: string;
}

export interface BuildEnvInput {
  provider: string;
  model: string;
  toolsAllowed: boolean;
}

export interface RealCliHarnessSpec {
  name: string;
  description: string;
  models: ModelOption[];
  /** Binary to check for; if missing, run installCmd first. */
  bin: string;
  installCmd?: string;
  /**
   * How this harness receives host control-plane instructions. Prefer the
   * harness-native system/developer-prompt surface when available; otherwise
   * carry instructions in the hidden XML prompt body.
   */
  instructionDelivery?: InstructionDelivery;
  /** How to extract assistant text from the harness stdout stream. */
  outputMode?: HarnessOutputMode;
  /**
   * How this harness manages its native session id for same-conversation resume
   * (docs/harness-interrupt-resume-evidence.md):
   *  - "assign":  host generates a UUID and passes it via buildArgv on turn 1
   *               (claude/openclaude `--session-id`, daemon `--session-id`), then
   *               resumes with the same id. The id is known up front.
   *  - "capture": host cannot assign one; it reads the id the CLI emits on its
   *               first turn (codex thread_id, pi header id, opencode sessionID)
   *               and passes it back via `resumeSessionId` on later turns.
   * Defaults to "capture" (no session id is assigned, none is required).
   */
  sessionStrategy?: "assign" | "capture";
  /**
   * Build the argv that runs the real harness for one turn. The SAME builder is
   * used for shared infra and the user Box; only `toolsAllowed` differs.
   */
  buildArgv: (input: BuildArgvInput) => string[];
  /**
   * Optional env builder. Used by harnesses whose structural tool policy is
   * expressed through config/env rather than argv (e.g. OpenCode's
   * OPENCODE_CONFIG_CONTENT permission map).
   */
  buildEnv?: (input: BuildEnvInput) => Record<string, string> | undefined;
  /** Optional one-time setup before the harness runs (e.g. auth files). */
  prepare?: (runtime: HarnessRuntime) => Promise<void>;
  /** Override the env vars this harness requires (defaults to the provider key vars). */
  requiredEnv?: string[];
  /**
   * Model override for the SHARED (no-tools) surface only. The shared line needs
   * speed, not depth — e.g. box on sonnet, shared on haiku (measured: ~4.2s vs
   * ~7.2s to first text). The Box surface always uses the user's selection.
   */
  sharedModel?: { provider?: string; model: string };
}

export interface RealCliHarnessDeps {
  /**
   * Factory for the shared-infra runtime that runs the no-tool harness locally.
   * Defaults to {@link createSharedInfraCapabilities}. Injectable for tests.
   */
  createSharedRuntime?: () => HarnessRuntime;
}

function providerRequiredEnv(provider: string): string {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return "OPENAI_API_KEY";
}

/**
 * Structural no-tool config for OpenCode (and OpenCode-backed harnesses like
 * Hermes). Disabling every tool with `tools: { "*": false }` removes the tools
 * from the model entirely, so it answers directly and fast. (Do NOT use
 * `permission: { "*": "deny" }`: that keeps the tools present, so the model
 * calls one and OpenCode blocks forever on a permission prompt that has no TTY
 * to approve it — the shared bridge then produces no output at all.) Injected via
 * the documented OPENCODE_CONFIG_CONTENT env var.
 *
 * When tools ARE allowed (the Box run) we must NOT fall back to OpenCode's
 * defaults: the default permission is "ask", so the first time the agent calls a
 * tool (e.g. `bash curl` to read the machine's IP) OpenCode blocks forever on an
 * approval prompt that has no TTY in a non-interactive `opencode run` — the whole
 * turn hangs and never answers. Auto-approve every tool (the OpenCode equivalent
 * of Claude's `--dangerously-skip-permissions`) so the agent loop actually runs.
 */
export function opencodeNoToolEnv(toolsAllowed: boolean): Record<string, string> {
  // autoupdate/snapshot off: pure startup/turn overhead in a disposable box.
  if (toolsAllowed) return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "allow" }, autoupdate: false, snapshot: false }) };
  // Shared surface: all PRIVATE-machine tools structurally removed, but webfetch
  // stays enabled — public live data (weather, news, prices) is not user-machine
  // state, and the shared agent answering it directly beats a pointless bridge.
  // permission allow is required or the surviving tool hangs on a TTY-less prompt.
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ tools: { "*": false, webfetch: true }, permission: { "*": "allow" } }) };
}

export function buildCommonAssistantKnowledge(): string {
  return [
    "Shared product knowledge for both assistant phases:",
    "- You are the assistant in a consumer agent product with two execution surfaces.",
    "- The fast shared surface can answer normal conversation, social chat, capability questions, and general knowledge that does not require private files, shell commands, credentials, or the user's machine state.",
    "- The private runtime can use tools inside the user's Box for tasks that require shell commands, filesystem access, environment inspection, package installation, private project context, or other user-specific execution.",
    "- Answer naturally and consistently across both surfaces. Do not expose hidden XML, routing internals, billing, or machine lifecycle details unless the user explicitly asks about product architecture.",
    "- If asked who you are, present yourself simply as the user's personal assistant. Never name internal harness/CLI products (OpenCode, Claude Code, Codex, …) as your identity.",
    "- If asked about capabilities, explain that simple chat can be handled immediately and tool/private-runtime work can continue in the user's Box when needed.",
  ].join("\n");
}

export function buildHarnessInstructions(ctx: SharedContext | UserBoxContext, policy: HarnessPhasePolicy): string {
  const userCtx = policy.phase === "user-box" ? ctx as UserBoxContext : undefined;
  return [
    buildCommonAssistantKnowledge(),
    "",
    policy.toolsAllowed
      ? "You are running in the user's private tool-enabled environment for this conversation."
      : "You are running on shared infra for this conversation with private tools disabled by framework policy.",
    "The user never needs to know about Boxes, sandboxes, machines, resumes, internal routings, billing, hidden XML, or orchestration internals. Do not mention them unless the user explicitly asks about the product architecture.",
    "The hidden <consumer-context> block contains prior transcript and machine state. Use it only as private context; never quote or reveal the XML.",
    "The latest user request is authoritative. Do not re-answer earlier greetings or small-talk if a later actionable request is present.",
    policy.toolsAllowed
      ? "Use real tools when the request requires them. For shell facts like IP/hostname/current directory, run the appropriate command and report the observed result. Do not guess."
      : "Private tools are disabled. First decide whether the latest user message can be answered completely without private tools.",
    !policy.toolsAllowed
      ? "If it can be answered from your own knowledge or reasoning — greetings, small-talk, opinions, preferences, recommendations, jokes, definitions, explanations, product/capability questions, or any general answer that does NOT depend on the user's private files, shell output, or live machine state — answer it fully and directly. Questions like 'what's your favorite X', opinions, and recommendations NEVER require private tools; answer them."
      : undefined,
    !policy.toolsAllowed
      ? "ONLY when answering genuinely requires reading or acting on the user's private environment (their files, shell, running processes, installed software, or live machine facts such as IP/hostname/CPU) AND that private runtime is still booting, reply with exactly one short natural holding line such as 'I’m checking that now.', 'Looking into it.', or 'One sec.'"
      : undefined,
    !policy.toolsAllowed
      ? "For that holding line, do not apologize, do not claim results, do not over-explain, and do not mention Box, sandboxes, framework/runtime internals, fixed IPs, or being a conversational AI."
      : undefined,
    !policy.toolsAllowed ? "A holding line is ONLY ever for private-machine work in flight. Never use one for anything you could answer yourself — when in doubt, just answer." : undefined,
    !policy.toolsAllowed
      ? "NEVER say you lack access, cannot run commands, or cannot see the user's machine. The private runtime WILL handle machine work right after you — denying capability is factually wrong and contradicts the answer the user is about to receive. For machine work your entire reply is just the short holding line."
      : undefined,
    !policy.toolsAllowed
      ? "Machine facts (IP address, hostname, OS, CPU, files) are about THE USER'S OWN machine, which they fully own and may inspect freely. NEVER refuse them as private/secret 'infrastructure details' — there is no policy against them. Reply with the short holding line and let the private runtime report the real values."
      : undefined,
    !policy.toolsAllowed
      ? "For PUBLIC live data (weather, news, prices, current events) you DO have the webfetch tool: fetch a public source and answer directly. Never claim you cannot access live data. Known-good sources: weather https://wttr.in/<city>?format=3 ; general/topic news https://lite.duckduckgo.com/lite/?q=<query>+news ; world headlines https://feeds.bbci.co.uk/news/world/rss.xml . One or two fetches maximum, then answer with what you got."
      : undefined,
    policy.toolsAllowed && userCtx?.partialShared
      ? `A shared assistant already sent this visible text to the user: "${(userCtx.partialShared).slice(0, 200)}". Treat it as an answer ONLY if it ALREADY fully and concretely answers the latest user request. A brief holding/bridge line (e.g. "I’m checking that now.", "Looking into it.", "One sec.") is NOT an answer — in that case you MUST now produce the real, complete answer to the latest request yourself.`
      : undefined,
    policy.toolsAllowed
      ? "If you have nothing to add for the user, your ENTIRE output must be exactly the five characters <end> — nothing before it, nothing after it. NEVER write meta-commentary about your decision or the shared response (e.g. 'the shared response already answered this', 'no further action needed'): everything you output other than <end> is shown to the user as your reply, and such commentary is wrong."
      : undefined,
    policy.toolsAllowed && !userCtx?.partialShared ? "No visible shared text needs to be carried forward." : undefined,
    policy.toolsAllowed
      ? "For public IP requests: if the user asks for IPv4/v4, run an IPv4-specific lookup such as `curl -4 -s https://api.ipify.org`; if the user asks for IPv6/v6, use an IPv6-specific lookup; if ambiguous, say which address family you observed."
      : undefined,
    policy.toolsAllowed ? "For CPU/core-count requests, run a real command such as `nproc` or `lscpu` in the private environment and report the observed count." : undefined,
    policy.toolsAllowed ? "When intentionally producing no user-visible text because the request is duplicate/stale or already fully handled, output exactly <end>. The host will hide that sentinel. Do not add whitespace, markdown, or explanation around it." : undefined,
    !policy.toolsAllowed
      ? "Output ONLY that visible reply — either the full answer or the one short holding line. Never output routing tags, XML, control markers, or an empty response. You must always produce visible text."
      : undefined,
    "When done, answer the latest user request directly and concisely. If you changed files or ran commands, summarize the concrete result.",
  ].filter(Boolean).join("\n");
}

export function buildHarnessPromptBundle(ctx: SharedContext | UserBoxContext, policy: HarnessPhasePolicy): HarnessPromptBundle {
  const instructions = buildHarnessInstructions(ctx, policy);
  const latestUserMessage = policy.phase === "shared" ? (ctx as SharedContext).message : (ctx as UserBoxContext).latestUserMessage;
  return {
    policy,
    instructions,
    prompt: [
      "<consumer-agent-system-instructions>",
      instructions,
      "</consumer-agent-system-instructions>",
      "",
      ctx.hiddenContext,
      "",
      `<latest-user-request>${escapeXml(latestUserMessage)}</latest-user-request>`,
      "",
      policy.toolsAllowed ? "Complete the latest user request now." : "Respond to the latest user request now under the shared no-tools policy.",
    ].join("\n"),
  };
}

export function buildSharedSystem(ctx: SharedContext): string {
  return buildHarnessInstructions(ctx, { phase: "shared", toolsAllowed: false, runtime: "shared-infra" });
}

export function buildUserBoxInstructions(ctx: UserBoxContext): string {
  return buildHarnessInstructions(ctx, { phase: "user-box", toolsAllowed: true, runtime: "user-box" });
}

/**
 * Prepare the conversation workspace in ONE runtime command: create the run dir,
 * write the instruction file(s) (base64 -d), and report whether the harness
 * binary is installed. On the Box runtime every command is a full HTTP round
 * trip (~0.5-1.5s), so batching this (previously 4 commands: bin check, mktemp,
 * 2 file writes) is a direct multi-second latency win on every single turn.
 *
 * The workdir is STABLE PER CONVERSATION, not per turn. OpenCode scopes its
 * session store to the project directory: `opencode run -s <id>` launched from a
 * different directory than the session's original one HANGS FOREVER (verified on
 * opencode 1.17.12 — every orphaned zombie process was a cross-directory -s
 * resume). Same directory -> resume works in seconds. A stable dir also lets the
 * harness' own project memory accumulate across turns, which is the point of
 * native session resume in the first place.
 */
async function prepareTurnWorkspace(
  runtime: HarnessRuntime,
  spec: RealCliHarnessSpec,
  ctx: SharedContext | UserBoxContext,
  phase: HarnessPhase,
  instructions: string,
  delivery: InstructionDelivery,
  extraFiles?: Record<string, string>,
): Promise<{ cwd: string; systemInstructionPath: string; binInstalled: boolean; binPath?: string }> {
  const conversationSlug = sanitizeShell(`${ctx.userId}-${ctx.conversationId}`).slice(0, 60);
  const cwd = `/tmp/consumer-agent-${sanitizeShell(spec.name)}-${phase}-${conversationSlug}`;
  const systemInstructionPath = `${cwd}/CONSUMER_AGENT_SYSTEM.md`;
  const encoded = Buffer.from(instructions + "\n", "utf8").toString("base64");
  const parts = [
    `mkdir -p ${shellQuote(cwd)}`,
    // Box only: heal the harness state dir. Long-lived boxes that saw installs
    // from different uids can end up with an unwritable ~/.local/share/opencode
    // ("EACCES: mkdir .../opencode/repos"), which kills every run at startup.
    ...(runtime.location === "user-box"
      ? [`(mkdir -p ~/.local/share/opencode 2>/dev/null; [ -w ~/.local/share/opencode ] || sudo -n chown -R "$(id -u):$(id -g)" ~/.local/share/opencode 2>/dev/null; chmod -R u+rwX ~/.local/share/opencode 2>/dev/null; true)`]
      : []),
    `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(systemInstructionPath)}`,
  ];
  if (delivery === "workspace-agents-md") {
    parts.push(`printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(`${cwd}/AGENTS.md`)}`);
  }
  // Extra per-turn payload files (e.g. the resident-serve request body) ride the
  // SAME batched prep command: each separate box command costs a ~0.5-1.5s HTTP
  // round trip, so never add a round trip for a file write.
  for (const [rel, content] of Object.entries(extraFiles ?? {})) {
    const enc = Buffer.from(content, "utf8").toString("base64");
    parts.push(`printf %s ${shellQuote(enc)} | base64 -d > ${shellQuote(`${cwd}/${rel}`)}`);
  }
  // The bin check retries up to ~20s before reporting MISSING: a box declared
  // responsive right after a fork/resume answers commands while its DISK is
  // still restoring (measured: echo works at ~1s, /home content lands seconds
  // later). A false MISSING is expensive twice over — it triggers a redundant
  // ~50s reinstall AND launches the harness before its session store exists,
  // which is the unknown-session infinite hang. Costs 0s when the bin is present.
  // Poll FINELY (0.25s), not every 2s: after a resume opencode lands on PATH within
  // a second or so, and a coarse 2s sleep overshoots by seconds on every turn
  // (measured ~6.5s of dead prep just waiting on this). Same ~20s worst-case budget
  // for a genuinely still-restoring disk, but ~0s once the bin is actually present.
  // Echo the RESOLVED binary path: harness children spawned via `nohup bash -c`
  // do not inherit the box shell's nvm PATH (measured: bare `opencode` is
  // "command not found" there), so every later launch must use the absolute path.
  parts.push(`(ok=""; for i in $(seq 1 80); do if command -v ${sanitizeShell(spec.bin)} >/dev/null 2>&1; then ok=1; break; fi; sleep 0.25; done; [ -n "$ok" ] && echo "__BIN_OK__:$(command -v ${sanitizeShell(spec.bin)})" || echo __BIN_MISSING__)`);
  // Box runtime: ONE HTTP command (each round trip costs ~0.5-1.5s; body size is
  // not a constraint). Shared-infra runtime: run the parts as separate local
  // spawns — local spawns are ~10ms, and a single joined ~8KB argv element gets
  // truncated by the Git-Bash-on-Windows spawn arg limit (unexpected-EOF errors).
  let prep: CommandResult;
  if (runtime.location === "user-box") {
    prep = await runtime.command(parts.join(" && "));
  } else {
    prep = { exitCode: 0, stdout: "", stderr: "" };
    for (const part of parts) {
      const r = await runtime.command(part);
      prep = { exitCode: r.exitCode, stdout: prep.stdout + r.stdout, stderr: prep.stderr + r.stderr };
      if (r.exitCode !== 0) break;
    }
  }
  if (!prep.stdout.includes("__BIN_OK__") && !prep.stdout.includes("__BIN_MISSING__")) {
    throw new Error(`workspace prep failed (exit=${prep.exitCode}): ${prep.stderr.trim().slice(-300) || prep.stdout.trim().slice(-300) || "no output"}`);
  }
  const binPath = prep.stdout.match(/__BIN_OK__:(\S+)/)?.[1];
  return { cwd, systemInstructionPath, binInstalled: prep.stdout.includes("__BIN_OK__"), ...(binPath ? { binPath } : {}) };
}

function sanitizeShell(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function shellQuote(value: string): string {
  // POSIX single-quote escape: ' -> '\'' (close, literal quote, reopen).
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
}

/**
 * Hard cap on the shared (no-tools) bridge run. It only ever generates a short
 * holding line or a directly-answerable reply; anything longer is a stalled CLI,
 * not real work. Kept well below any conversational patience so a hung bridge
 * cannot pin a conversation "active" (which blocks idle auto-stop and the reaper).
 */
const SHARED_BRIDGE_TIMEOUT_MS = 60_000;

/**
 * Hard cap on one BOX turn. Tool work in this product is interactive-scale
 * (shell facts, small file edits) — minutes, not hours. A box run past this is a
 * hang (e.g. a session-resume wedge), and it must surface as a loud
 * box.runtime.no-answer blocker instead of an eternal "working…" indicator.
 */
const BOX_TURN_TIMEOUT_MS = 10 * 60_000;

/**
 * Fixed localhost port for the resident `opencode serve` inside the user Box.
 * Off the common 4096 default so a user process inside their own box never
 * collides with the runtime's harness server.
 */
const BOX_SERVE_PORT = 4917;
const BOX_SERVE_URL = `http://127.0.0.1:${BOX_SERVE_PORT}`;

/**
 * Per-turn box script: health-check the resident `opencode serve`, boot it if
 * missing (~3s, measured in-box; then it lives for the box's whole warm life and
 * even survives pause/resume as VM state), then run the turn as ONE localhost
 * HTTP call. This kills the dominant box-turn cost: `opencode run` cold-boots a
 * full embedded server EVERY turn (measured 9.6s for a trivial reply); through a
 * resident serve the same turn is ~3.6s, almost all of it real model time.
 *
 * The serve process inherits the exported provider keys + OPENCODE_CONFIG_CONTENT
 * (tool auto-approve) from this script's environment (runHarness env prefix).
 * The OPENCODE_DISABLE_* vars cut its one-time boot cost. Everything noisy goes
 * to stderr/serve log; stdout carries ONLY the final message JSON, which the
 * opencode-serve-json parser turns into text + native tool events.
 */
function buildBoxServeTurnScript(args: { binPath: string; bodyPath: string; sessionId?: string; timeoutMs: number }): string {
  const curlMaxSec = Math.max(30, Math.floor(args.timeoutMs / 1000) - 30);
  const lines = [
    `OC=${shellQuote(args.binPath)}`,
    `SL="$HOME/.cba-opencode-serve.log"`,
    `if ! curl -s -m 2 -o /dev/null ${BOX_SERVE_URL}/app 2>/dev/null; then`,
    // cd $HOME: sessions must all live in ONE deterministic project scope; a
    // serve started in a per-conversation dir would scope other conversations'
    // sessions to the wrong project. Instructions ride the prompt XML anyway.
    `  (cd "$HOME" && OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_DISABLE_MODELS_FETCH=1 nohup "$OC" serve --port ${BOX_SERVE_PORT} --hostname 127.0.0.1 >> "$SL" 2>&1 &)`,
    `  ready=""`,
    `  for i in $(seq 1 150); do if curl -s -m 1 -o /dev/null ${BOX_SERVE_URL}/app 2>/dev/null; then ready=1; break; fi; sleep 0.2; done`,
    `  [ -n "$ready" ] || { echo "opencode serve failed to boot: $(tail -c 300 "$SL" 2>/dev/null)" >&2; exit 7; }`,
    `fi`,
    args.sessionId
      ? [
          `SID=${shellQuote(args.sessionId)}`,
          // Clear any in-flight generation left by an interrupted previous turn;
          // a busy session would otherwise reject/queue the new message.
          `curl -s -m 5 -o /dev/null -X POST "${BOX_SERVE_URL}/session/$SID/abort" 2>/dev/null || true`,
        ].join("\n")
      : [
          // Fixed title: without it opencode fires a side LLM call just to name
          // the session (same reason the CLI path passes --title).
          `SID=$(curl -s -m 10 -X POST ${BOX_SERVE_URL}/session -H 'Content-Type: application/json' -d '{"title":"optibox"}' | grep -o '"id":"ses_[^"]*"' | head -1 | cut -d'"' -f4)`,
          `[ -n "$SID" ] || { echo "opencode serve session create failed" >&2; exit 8; }`,
        ].join("\n"),
    `curl -s -m ${curlMaxSec} -X POST "${BOX_SERVE_URL}/session/$SID/message" -H 'Content-Type: application/json' -d @${shellQuote(args.bodyPath)}`,
  ];
  return lines.join("\n");
}

/**
 * Run ONE harness turn on a given runtime under a given phase policy. This is
 * the single code path shared by the always-on (shared infra) surface and the
 * per-user (Box) surface. The only differences are which runtime executes the
 * binary and whether tools are structurally enabled — exactly the user's mental
 * model: "the same harness, with a parameter that says don't use tools."
 */
async function* runHarnessTurn(
  spec: RealCliHarnessSpec,
  runtime: HarnessRuntime,
  ctx: SharedContext | UserBoxContext,
  policy: HarnessPhasePolicy,
): AsyncIterable<HarnessOutputChunk> {
  const bundle = buildHarnessPromptBundle(ctx, policy);
  const delivery = spec.instructionDelivery ?? "prompt-xml";
  // Resident-serve turn (box + opencode-backed harness): the request body is
  // known before prep, so it rides the batched prep command as an extra file
  // instead of costing its own box round trip.
  const serveTurn = runtime.location === "user-box" && spec.outputMode === "opencode-json";
  const serveBodyFile = ".cba-serve-body.json";
  let extraFiles: Record<string, string> | undefined;
  if (serveTurn) {
    const probeArgv = spec.buildArgv({ prompt: "", model: ctx.selection.model, provider: ctx.selection.provider, cwd: ".", systemInstructionPath: "", toolsAllowed: policy.toolsAllowed });
    const mi = probeArgv.indexOf("--model");
    const modelString = (mi >= 0 ? probeArgv[mi + 1] : undefined) ?? `${ctx.selection.provider}/${ctx.selection.model}`;
    const slash = modelString.indexOf("/");
    extraFiles = {
      [serveBodyFile]: JSON.stringify({
        model: { providerID: modelString.slice(0, slash), modelID: modelString.slice(slash + 1) },
        parts: [{ type: "text", text: bundle.prompt }],
      }),
    };
  }
  const { cwd, systemInstructionPath, binInstalled, binPath: preppedBinPath } = await prepareTurnWorkspace(runtime, spec, ctx, policy.phase, bundle.instructions, delivery, extraFiles);
  let binPath = preppedBinPath;
  if (spec.installCmd && !binInstalled) {
    // NOTE: no user-visible text here. Install progress already surfaces via the
    // runtime's exec audit event; a text yield would count as the box agent's
    // "answer" and mask the loud no-answer failure when the real run errors out.
    await runtime.command(spec.installCmd, { timeoutMs: 180_000 });
  }
  if (spec.prepare) await spec.prepare(runtime);

  // Same-conversation resume: reuse the persisted native session id when present,
  // otherwise (assign-style CLIs) mint one up front so resume works even if this
  // turn is interrupted before the CLI echoes the id. See
  // docs/harness-interrupt-resume-evidence.md for the per-CLI mechanism.
  const strategy = spec.sessionStrategy ?? "capture";
  const knownSessionId = ctx.sessionId;
  let assignSessionId: string | undefined;
  if (knownSessionId === undefined && strategy === "assign") {
    assignSessionId = randomUUID();
    ctx.onSessionId?.(assignSessionId);
  }
  const env = spec.buildEnv?.({ provider: ctx.selection.provider, model: ctx.selection.model, toolsAllowed: policy.toolsAllowed });
  let argv: string[];
  let outputMode = spec.outputMode;
  if (serveTurn) {
    // The bin was just installed (fresh box): resolve the absolute path the prep
    // couldn't. One extra round trip only on that rare first-install path.
    if (!binPath) {
      binPath = (await runtime.command(`command -v ${sanitizeShell(spec.bin)}`)).stdout.trim().split(/\s+/).pop();
      if (!binPath) throw new Error(`harness binary '${spec.bin}' not found in box after install`);
    }
    argv = ["bash", "-c", buildBoxServeTurnScript({
      binPath,
      bodyPath: `${cwd}/${serveBodyFile}`,
      ...(knownSessionId ? { sessionId: knownSessionId } : {}),
      timeoutMs: BOX_TURN_TIMEOUT_MS,
    })];
    outputMode = "opencode-serve-json";
  } else {
    argv = spec.buildArgv({
      prompt: bundle.prompt,
      model: ctx.selection.model,
      provider: ctx.selection.provider,
      cwd,
      systemInstructionPath,
      toolsAllowed: policy.toolsAllowed,
      ...(assignSessionId ? { sessionId: assignSessionId } : {}),
      ...(knownSessionId ? { resumeSessionId: knownSessionId } : {}),
    });
  }
  yield* runtime.runHarness({
    argv,
    cwd,
    ...(env ? { env } : {}),
    ...(outputMode ? { outputMode } : {}),
    ...(ctx.onSessionId ? { onSessionId: ctx.onSessionId } : {}),
    ...(ctx.onComplete ? { onComplete: ctx.onComplete } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    // The shared bridge is a quick holding/answer line, never a long tool run. It
    // must NOT inherit the multi-hour box-harness safety timeout: a hung shared
    // CLI (opencode/Hermes stalls intermittently) would otherwise keep the turn
    // "active" for hours, blocking idle auto-stop AND the reaper. Cap it hard.
    timeoutMs: policy.runtime === "shared-infra" ? SHARED_BRIDGE_TIMEOUT_MS : BOX_TURN_TIMEOUT_MS,
    pollMs: 150,
  });
}

/**
 * Build a HarnessAdapter around ONE harness implementation.
 *
 * There is no provider fallback and no separate shared LLM client. The shared
 * (always-on) surface runs the exact same harness binary as the Box, locally on
 * shared infra, with tools STRUCTURALLY disabled by the harness' own no-tool
 * flags/config. The Box surface runs it with tools enabled. The prompt builder,
 * stdout parser, and streaming/message semantics are identical for both.
 */
export function realCliHarness(spec: RealCliHarnessSpec, deps: RealCliHarnessDeps = {}): HarnessAdapter {
  const createSharedRuntime = deps.createSharedRuntime ?? (() => createSharedInfraCapabilities());
  return {
    name: spec.name,
    description: spec.description,
    requiredEnv: spec.requiredEnv ?? [...new Set(spec.models.map((m) => providerRequiredEnv(m.provider)))],
    models: spec.models,
    async *shared(ctx: SharedContext) {
      const runtime = createSharedRuntime();
      if (runtime.location !== "shared-infra") throw new Error("shared runtime must report location 'shared-infra'");
      const policy: HarnessPhasePolicy = { phase: "shared", toolsAllowed: false, runtime: "shared-infra" };
      if (spec.sharedModel) {
        ctx = { ...ctx, selection: { ...ctx.selection, ...(spec.sharedModel.provider ? { provider: spec.sharedModel.provider } : {}), model: spec.sharedModel.model } };
      }
      // Direct provider streaming for OpenCode-backed harnesses. The shared surface
      // is a stateless, no-tools chat line, so it does NOT run OpenCode at all here:
      // `opencode run` cold-starts ~6.5s/turn and a warm `opencode serve` WEDGES
      // under this system's rapid-message + interrupt load (one stuck generation
      // makes every later shared turn return empty). A direct provider call is an
      // independent request — nothing shared to wedge, an interrupt just drops it,
      // and it streams token-by-token (~1.25s to first token). See sharedDirectStream.
      if (spec.outputMode === "opencode-json") {
        const bundle = buildHarnessPromptBundle(ctx, policy);
        const argv = spec.buildArgv({ prompt: bundle.prompt, model: ctx.selection.model, provider: ctx.selection.provider, cwd: ".", systemInstructionPath: "", toolsAllowed: false });
        const mi = argv.indexOf("--model");
        const modelString = (mi >= 0 ? argv[mi + 1] : undefined) ?? `${ctx.selection.provider}/${ctx.selection.model}`;
        yield* sharedDirectStream({
          modelString,
          prompt: bundle.prompt,
          ...(ctx.onComplete ? { onComplete: ctx.onComplete } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          timeoutMs: SHARED_BRIDGE_TIMEOUT_MS,
        });
        return;
      }
      for await (const chunk of runHarnessTurn(spec, runtime, ctx, policy)) {
        yield typeof chunk === "string" ? chunk : chunk.text;
      }
    },
    async *userBox(ctx: UserBoxContext) {
      const policy: HarnessPhasePolicy = { phase: "user-box", toolsAllowed: true, runtime: "user-box" };
      yield* runHarnessTurn(spec, ctx.capabilities, ctx, policy);
    },
  };
}
