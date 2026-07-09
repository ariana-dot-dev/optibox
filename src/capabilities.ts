import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BoxClient, CommandResult, HarnessCompletion, HarnessOutputMode, HarnessRunSpec, HarnessRuntime, HarnessTextChunk, HarnessToolEvent, SafeSharedCapabilities, UserBoxCapabilities } from "./types.js";

/**
 * Default harness loop timeout. A single prompt can drive arbitrarily long tool
 * calls / computer-use before producing its final text, so this is a multi-hour
 * SAFETY backstop — not a short-inactivity stop. It only fires while the process
 * is still running; a normal agent loop ends (and is reported) far sooner via its
 * clean exit. Overridable per run via HarnessRunSpec.timeoutMs.
 */
export const DEFAULT_HARNESS_TIMEOUT_MS = 6 * 60 * 60 * 1000;

class CapabilityDeniedError extends Error {
  constructor(action: string) {
    super(`Shared prewarm mode denies ${action}. Wait for the user's Box before using machine capabilities.`);
    this.name = "CapabilityDeniedError";
  }
}

/**
 * Shared restricted capabilities. The shared always-on agent only gets
 * answer/webSearch; every machine action throws. This is the framework-level
 * (structural) guarantee that shared mode cannot read/write files, run bash, or
 * control the computer — independent of what the harness tries to do.
 */
export function createRestrictedSharedCapabilities(options: {
  webSearch?: (query: string) => Promise<string>;
  answer?: (text: string) => AsyncIterable<string>;
} = {}): SafeSharedCapabilities {
  return {
    mode: "shared-restricted",
    webSearch: options.webSearch ?? (async (query) => `Search is delegated by the host application for: ${query}`),
    answer: options.answer ?? (async function* (text: string) { yield text; }),
    readFile: async () => { throw new CapabilityDeniedError("file reads"); },
    writeFile: async () => { throw new CapabilityDeniedError("file writes/edits"); },
    bash: async () => { throw new CapabilityDeniedError("bash commands"); },
    controlComputer: async () => { throw new CapabilityDeniedError("computer control"); },
  };
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface HarnessOutputParser {
  mode: HarnessOutputMode;
  lineBuffer: string;
  emittedText: string;
  activeMessageId?: string;
  activeMessageIndex: number;
  emittedByMessage: Map<string, string>;
  onToolEvent?: (event: HarnessToolEvent) => void;
  onSessionId?: (sessionId: string) => void;
  sessionIdEmitted: boolean;
  /** opencode-serve-json: tool part ids already surfaced (event bus + final response overlap). */
  seenTools?: Set<string>;
}

function createHarnessOutputParser(
  mode: HarnessOutputMode,
  onToolEvent?: (event: HarnessToolEvent) => void,
  onSessionId?: (sessionId: string) => void,
): HarnessOutputParser {
  return {
    mode,
    lineBuffer: "",
    emittedText: "",
    activeMessageIndex: 0,
    emittedByMessage: new Map(),
    sessionIdEmitted: false,
    ...(onToolEvent ? { onToolEvent } : {}),
    ...(onSessionId ? { onSessionId } : {}),
  };
}

/**
 * Best-effort extraction of the native session/thread id from a harness JSON
 * event, per the proven per-CLI shapes (docs/harness-interrupt-resume-evidence.md):
 *   - claude-stream-json: `session_id` on the `system`/`result` events
 *   - codex-json: `{"type":"thread.started","thread_id":"…"}`
 *   - opencode-json: `sessionID` (e.g. `ses_…`) on message info/parts
 *   - pi-json: the first header line `{"type":"session","id":"…"}`
 */
function extractSessionId(j: any, mode: HarnessOutputMode): string | undefined {
  const pick = (...vals: unknown[]): string | undefined => {
    for (const v of vals) if (typeof v === "string" && v) return v;
    return undefined;
  };
  if (mode === "claude-stream-json") return pick(j.session_id, j.sessionId, j.message?.session_id);
  if (mode === "codex-json") {
    if (j.type === "thread.started") return pick(j.thread_id, j.threadId);
    return pick(j.thread_id, j.session_id, j.session?.id);
  }
  if (mode === "opencode-json") return pick(j.sessionID, j.info?.sessionID, j.part?.sessionID, j.properties?.sessionID, j.message?.sessionID);
  if (mode === "opencode-serve-json") return pick(j.info?.sessionID, j.sessionID, Array.isArray(j.parts) ? j.parts[0]?.sessionID : undefined);
  if (mode === "pi-json") {
    if (j.type === "session") return pick(j.id, j.session?.id);
    return pick(j.sessionId, j.session?.id);
  }
  return undefined;
}

function noteSessionId(j: any, parser: HarnessOutputParser): void {
  if (parser.sessionIdEmitted || !parser.onSessionId) return;
  const id = extractSessionId(j, parser.mode);
  if (id) {
    parser.sessionIdEmitted = true;
    parser.onSessionId(id);
  }
}

function* parseHarnessOutput(rawDelta: string, parser: HarnessOutputParser): Iterable<HarnessTextChunk> {
  if (parser.mode === "raw-stdout") {
    yield { text: rawDelta, messageId: "stdout-0", messageIndex: 0 };
    return;
  }
  parser.lineBuffer += rawDelta;
  const lines = parser.lineBuffer.split(/\n/);
  parser.lineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const text = parseHarnessJsonLine(line.replace(/\r$/, ""), parser);
    if (text) yield text;
  }
}

function parseHarnessJsonLine(line: string, parser: HarnessOutputParser): HarnessTextChunk | undefined {
  let trimmed = line.trim();
  // The serve event-bus tap writes SSE-framed lines ("data: {...}") into the
  // run log; unwrap them so tool parts reach the parser.
  if (parser.mode === "opencode-serve-json" && trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
  if (!trimmed.startsWith("{")) return undefined;
  let j: any;
  try { j = JSON.parse(trimmed); } catch { return undefined; }

  noteSessionId(j, parser);

  if (parser.mode === "claude-stream-json") {
    emitClaudeToolEvent(j, parser);
    noteMessageBoundary(j, parser);
    const delta = j.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.type === "text_delta"
      ? j.event.delta.text
      : undefined;
    if (typeof delta === "string") {
      return emitChunk(delta, parser);
    }
    // Claude Code's `--output-format stream-json` is not only Anthropic SDK
    // `stream_event` deltas. In real CLI output, especially around tool calls,
    // assistant messages are often emitted as JSON snapshots:
    //   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
    // The previous parser observed the tool_use snapshot but ignored the later
    // assistant text snapshot, so a perfectly valid answer could look like
    // "no output" to the orchestrator and incorrectly arm idle shutdown.
    const assistantText = j.type === "assistant" ? extractAssistantMessageText(j.message) : "";
    if (assistantText) return emitNewSuffix(assistantText, parser);
    if (!parser.emittedText && j.type === "result" && typeof j.result === "string") {
      return emitChunk(j.result, parser);
    }
    return undefined;
  }

  if (parser.mode === "opencode-serve-json") {
    // Two line shapes interleave in the run log:
    //   1. Live `/event` bus lines tapped during the turn — the ONLY place tool
    //      calls are visible, because opencode chains each agent step as a
    //      separate message (the final message's parentID points at the
    //      tool-executing message) and POST /message returns only the last one.
    //   2. The final message object {"info":{...},"parts":[...]} with the text.
    // Error payloads have neither shape and are intentionally ignored so the
    // no-answer diagnostic (raw log tail) explains the failure.
    const evPart = j.type === "message.part.updated" ? (j.properties?.part ?? j.part) : undefined;
    if (evPart?.type === "tool") {
      emitServeToolPart(evPart, parser);
      return undefined;
    }
    if (!Array.isArray(j.parts)) return undefined;
    let text = "";
    for (const part of j.parts) {
      if (part?.type === "text" && typeof part.text === "string") text += part.text;
      if (part?.type === "tool") emitServeToolPart(part, parser);
    }
    return emitNewSuffix(text, parser);
  }

  if (parser.mode === "pi-json") {
    emitPiToolEvent(j, parser);
    noteMessageBoundary(j, parser);
    const ev = j.assistantMessageEvent;
    // Assistant text streams ONLY as message_update/text_delta. Pi ALSO emits
    // message_start/message_end for the USER message (role:"user") echoing the
    // full prompt — extracting text from those would leak the entire hidden
    // system-instruction XML back as the assistant's visible reply. So the
    // final-text safety net is strictly gated to role:"assistant".
    if (j.type === "message_update" && ev?.type === "text_delta" && typeof ev.delta === "string" && j.message?.role !== "user") {
      return emitChunk(ev.delta, parser);
    }
    if (j.type === "message_end" && j.message?.role === "assistant") {
      return emitNewSuffix(String(extractAssistantMessageText(j.message) || ""), parser);
    }
    return undefined;
  }

  if (parser.mode === "opencode-json") {
    emitGenericToolEvent(j, parser);
    noteMessageBoundary(j, parser);
    const ev = j.assistantMessageEvent;
    if (j.type === "message_update" && ev?.type === "text_delta" && typeof ev.delta === "string") {
      return emitChunk(ev.delta, parser);
    }
    // OpenCode's documented JSON mode emits raw JSON events such as `text` and
    // `tool_use`; Pi RPC/JSON variants commonly emit message_update deltas.
    const directText = j.type === "text" && typeof j.text === "string" ? j.text
      : j.type === "text" && typeof j.part?.text === "string" ? j.part.text
      : typeof j.delta === "string" ? j.delta
      : "";
    if (directText) return emitChunk(directText, parser);
    const full = j.type === "message_end" && extractAssistantMessageText(j.message);
    return emitNewSuffix(String(full || ""), parser);
  }

  if (parser.mode === "codex-json") {
    noteMessageBoundary(j, parser);
    const delta = typeof j.delta === "string" ? j.delta
      : typeof j.delta?.text === "string" ? j.delta.text
      : typeof j.item?.delta === "string" ? j.item.delta
      : typeof j.item?.delta?.text === "string" ? j.item.delta.text
      : "";
    if (delta) return emitChunk(delta, parser);
    const full = j.type === "item.completed" && j.item?.type === "agent_message" && typeof j.item.text === "string" ? j.item.text : "";
    return emitNewSuffix(full, parser);
  }

  return undefined;
}

function emitClaudeToolEvent(j: any, parser: HarnessOutputParser): void {
  if (!parser.onToolEvent) return;
  if (j.type === "assistant" && Array.isArray(j.message?.content)) {
    for (const part of j.message.content) {
      if (part?.type !== "tool_use") continue;
      parser.onToolEvent({
        phase: "tool_use",
        toolName: String(part.name ?? "tool"),
        command: typeof part.input?.command === "string" ? part.input.command : undefined,
        description: typeof part.input?.description === "string" ? part.input.description : undefined,
      });
    }
  }
  if (j.type === "user" && j.tool_use_result) {
    parser.onToolEvent({
      phase: "tool_result",
      toolName: "tool",
      stdout: typeof j.tool_use_result.stdout === "string" ? j.tool_use_result.stdout : undefined,
      stderr: typeof j.tool_use_result.stderr === "string" ? j.tool_use_result.stderr : undefined,
      isError: Boolean(j.tool_use_result.is_error ?? j.tool_use_result.isError),
    });
  }
}


/**
 * Surface one opencode tool part (event-bus `message.part.updated` or a part of
 * the final response) as native tool_use/tool_result events, exactly once per
 * part+phase. The event bus repeats a part across its lifecycle
 * (pending -> running -> completed), and the final response may repeat parts the
 * bus already delivered.
 */
function emitServeToolPart(part: any, parser: HarnessOutputParser): void {
  if (!parser.onToolEvent) return;
  const seen = parser.seenTools ?? (parser.seenTools = new Set());
  const id = String(part.id ?? part.callID ?? "tool-part");
  const status = String(part.state?.status ?? "completed");
  const base = {
    toolName: String(part.tool ?? "tool"),
    command: typeof part.state?.input?.command === "string" ? part.state.input.command : undefined,
    description: typeof part.state?.title === "string" ? part.state.title : undefined,
  };
  if (!seen.has(`${id}:use`) && status !== "pending") {
    seen.add(`${id}:use`);
    parser.onToolEvent({ phase: "tool_use", ...base });
  }
  if ((status === "completed" || status === "error") && !seen.has(`${id}:result`)) {
    seen.add(`${id}:result`);
    parser.onToolEvent({
      phase: "tool_result",
      ...base,
      stdout: typeof part.state?.output === "string" ? part.state.output : undefined,
      isError: status === "error",
    });
  }
}

/**
 * Pi's `--mode json` reports tool activity as `tool_execution_start` (toolName +
 * args) and `tool_execution_end` (result + isError) — distinct from opencode's
 * `tool_use` snapshots — so surface them as native tool_use/tool_result events
 * for the tool-chain UI. bash args carry `command`; file tools carry a path.
 */
function emitPiToolEvent(j: any, parser: HarnessOutputParser): void {
  if (!parser.onToolEvent) return;
  if (j.type === "tool_execution_start") {
    const args = j.args ?? {};
    parser.onToolEvent({
      phase: "tool_use",
      toolName: String(j.toolName ?? "tool"),
      command: typeof args.command === "string" ? args.command
        : typeof args.cmd === "string" ? args.cmd
        : typeof args.file_path === "string" ? args.file_path
        : typeof args.path === "string" ? args.path
        : undefined,
      description: typeof args.description === "string" ? args.description : undefined,
    });
  }
  if (j.type === "tool_execution_end") {
    const r = j.result;
    const stdout = typeof r === "string" ? r
      : (r && typeof r.stdout === "string") ? r.stdout
      : (r && typeof r.output === "string") ? r.output
      : r != null ? JSON.stringify(r).slice(0, 2000) : undefined;
    parser.onToolEvent({
      phase: "tool_result",
      toolName: String(j.toolName ?? "tool"),
      ...(stdout !== undefined ? { stdout } : {}),
      isError: Boolean(j.isError),
    });
  }
}

function emitGenericToolEvent(j: any, parser: HarnessOutputParser): void {
  if (!parser.onToolEvent) return;
  if (j.type === "tool_use") {
    const part = j.part ?? j;
    parser.onToolEvent({
      phase: "tool_use",
      toolName: String(part.tool ?? j.tool ?? "tool"),
      command: typeof part.state?.input?.command === "string" ? part.state.input.command
        : typeof part.input?.command === "string" ? part.input.command
        : undefined,
      description: typeof part.state?.title === "string" ? part.state.title : undefined,
      stdout: typeof part.state?.output === "string" ? part.state.output : undefined,
    });
  }
}

function emitChunk(text: string, parser: HarnessOutputParser): HarnessTextChunk | undefined {
  if (!text) return undefined;
  const messageId = currentMessageId(parser);
  const previous = parser.emittedByMessage.get(messageId) ?? "";
  parser.emittedByMessage.set(messageId, previous + text);
  parser.emittedText += text;
  return { text, messageId, messageIndex: parser.activeMessageIndex };
}

function emitNewSuffix(fullText: string, parser: HarnessOutputParser): HarnessTextChunk | undefined {
  if (!fullText) return undefined;
  const messageId = currentMessageId(parser);
  const previous = parser.emittedByMessage.get(messageId) ?? "";
  if (fullText.startsWith(previous)) {
    const next = fullText.slice(previous.length);
    return emitChunk(next, parser);
  }
  if (previous && previous.includes(fullText)) return undefined;
  return emitChunk(fullText, parser);
}

function currentMessageId(parser: HarnessOutputParser): string {
  if (!parser.activeMessageId) {
    parser.activeMessageId = `assistant-${parser.activeMessageIndex}`;
  }
  return parser.activeMessageId;
}

function setActiveMessage(parser: HarnessOutputParser, rawId?: unknown): void {
  const id = typeof rawId === "string" && rawId ? rawId : `assistant-${parser.activeMessageIndex + 1}`;
  if (parser.activeMessageId === id) return;
  parser.activeMessageIndex += 1;
  parser.activeMessageId = id;
}

function noteMessageBoundary(j: any, parser: HarnessOutputParser): void {
  const event = j.event ?? j;
  const explicitId = j.message?.id ?? event.message?.id ?? event.message_id ?? event.messageId ?? j.message_id ?? j.messageId ?? j.item?.id;
  if (event.type === "message_start" || j.type === "message_start") {
    setActiveMessage(parser, explicitId);
    return;
  }
  if (explicitId && explicitId !== parser.activeMessageId && (j.type === "assistant" || j.type === "message_update" || j.type === "message_end" || j.type === "item.completed")) {
    setActiveMessage(parser, explicitId);
  }
}

function extractAssistantMessageText(message: any): string {
  if (!message) return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part: any) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    }).join("");
  }
  return "";
}

export interface UserBoxCapabilityOptions {
  /** Provider LLM keys injected into the Box when running harnesses. */
  providerEnv?: Record<string, string>;
  pollMs?: number;
  /** Called every time a real Box command/harness is launched (audit/proof). */
  onExec?: (info: { kind: "command" | "harness"; argv?: string[]; command?: string }) => void;
  /** Called when the harness' own stream reports a native tool call/result. */
  onHarnessEvent?: (event: HarnessToolEvent) => void;
}

/**
 * Full user-Box capabilities. The developer's real external harness is launched
 * inside the Box via {@link UserBoxCapabilities.runHarness}; stdout is streamed
 * back by tailing a log file. Box is the substrate; the harness is the agent.
 */
export function createUserBoxCapabilities(box: BoxClient, boxId: string, options: UserBoxCapabilityOptions = {}): UserBoxCapabilities {
  const pollMs = options.pollMs ?? 250;
  const providerEnv = options.providerEnv ?? {};

  async function command(cmd: string, opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<CommandResult> {
    options.onExec?.({ kind: "command", command: cmd });
    const input: { command: string; cwd?: string; env?: Record<string, string>; timeoutMs: number } = { command: cmd, timeoutMs: opts.timeoutMs ?? 120_000 };
    if (opts.cwd !== undefined) input.cwd = opts.cwd;
    if (opts.env !== undefined) input.env = opts.env;
    return box.command(boxId, input);
  }

  async function* runHarness(spec: HarnessRunSpec): AsyncIterable<HarnessTextChunk> {
    options.onExec?.({ kind: "harness", argv: spec.argv });
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workdir = spec.cwd ?? "cba-work";
    const dir = `${workdir}/.cba-runs/${runId}`;
    const log = `${dir}/out.log`;
    const env = { ...providerEnv, ...(spec.env ?? {}) };
    const envPrefix = Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}; `).join("");
    const argvStr = spec.argv.map(shq).join(" ");
    const timeoutMs = spec.timeoutMs ?? DEFAULT_HARNESS_TIMEOUT_MS;
    const parser = createHarnessOutputParser(spec.outputMode ?? "raw-stdout", options.onHarnessEvent, spec.onSessionId);
    let sawText = false;
    let rawTail = "";
    let completionReported = false;
    const reportCompletion = (info: HarnessCompletion): void => {
      if (completionReported) return;
      completionReported = true;
      // When the loop ended with no visible text, surface the raw log tail so a
      // no-answer failure explains itself (e.g. a provider error the JSON parser
      // rightly did not treat as assistant text).
      const diagnostic = !sawText && rawTail.trim() ? rawTail.trim().slice(-500) : undefined;
      spec.onComplete?.({ ...info, sawText, ...(diagnostic ? { diagnostic } : {}) });
    };
    const noteChunk = (chunk: HarnessTextChunk): HarnessTextChunk => {
      if (chunk.text && chunk.text.trim()) sawText = true;
      return chunk;
    };
    const effectivePollMs = spec.pollMs ?? pollMs;
    // Launch detached, tee to a log so we can poll for incremental output.
    // The harness process runs in spec.cwd so AGENTS.md / other native rule
    // files written there are in the harness' real discovery path.
    const launch = `mkdir -p ${shq(dir)} && cd ${shq(workdir)} && ${envPrefix}nohup bash -c ${shq(`${argvStr} > ${shq(log)} 2>&1; echo "__CBA_EXIT__:$?" >> ${shq(log)}`)} >/dev/null 2>&1 & echo $!`;
    const launched = await box.command(boxId, { command: launch, timeoutMs: 30_000 });
    const pid = launched.stdout.trim().split(/\s+/).pop() ?? "";

    // Interrupt == "agent stops talking": SIGINT then SIGKILL the captured PID
    // inside the Box. The harness' session file is already flushed for completed
    // turns, so the conversation remains resumable by id on the next message.
    const interruptInBox = async (): Promise<void> => {
      if (!pid) return;
      await box.command(boxId, { command: `kill -INT ${pid} 2>/dev/null; sleep 0.2; kill -KILL ${pid} 2>/dev/null; true`, timeoutMs: 15_000 }).catch(() => undefined);
    };
    if (spec.signal?.aborted) { await interruptInBox(); reportCompletion({ reason: "aborted" }); return; }
    let aborted = false;
    const onAbort = () => { aborted = true; void interruptInBox(); };
    spec.signal?.addEventListener("abort", onAbort, { once: true });

    const started = Date.now();
    let offset = 0;
    try {
    while (Date.now() - started < timeoutMs) {
      if (aborted) { reportCompletion({ reason: "aborted" }); return; }
      await new Promise((r) => setTimeout(r, effectivePollMs));
      if (aborted) { reportCompletion({ reason: "aborted" }); return; }
      // ONE round trip per poll: read the log AND the process aliveness together.
      // (A separate `kill -0` command doubled the HTTP polls for zero benefit.)
      let content = "";
      let alive = "unknown";
      try {
        const polled = (await box.command(boxId, { command: `cat ${shq(log)} 2>/dev/null || true; printf '\\n__CBA_ALIVE__:%s\\n' "$(kill -0 ${pid || "0"} 2>/dev/null && echo up || echo down)"`, timeoutMs: 15_000 })).stdout;
        const aliveMatch = polled.match(/\n?__CBA_ALIVE__:(\w+)\s*$/);
        alive = aliveMatch?.[1] ?? "unknown";
        content = polled.replace(/\n?__CBA_ALIVE__:\w+\s*$/g, "");
      } catch { /* transient command failure; retry next poll */ }
      const exitMatch = content.match(/__CBA_EXIT__:(\d+)\s*$/);
      const visible = content.replace(/\n?__CBA_EXIT__:\d+\s*$/g, "");
      rawTail = visible.slice(-600);
      if (visible.length > offset) {
        const rawDelta = visible.slice(offset);
        for (const chunk of parseHarnessOutput(rawDelta, parser)) yield noteChunk(chunk);
        offset = visible.length;
      }
      if (exitMatch) {
        if (parser.mode !== "raw-stdout" && parser.lineBuffer.trim()) {
          const text = parseHarnessJsonLine(parser.lineBuffer.replace(/\r$/, ""), parser);
          parser.lineBuffer = "";
          if (text) yield noteChunk(text);
        }
        // Clean native stream end: the agent loop (incl. all tool calls) is done.
        reportCompletion({ reason: "completed", exitCode: Number(exitMatch[1]) });
        return;
      }
      // process gone but no exit marker -> stop polling (crash/kill, not a clean end)
      if (pid && alive === "down") {
        if (visible.length > offset) yield noteChunk({ text: visible.slice(offset), messageId: "stdout-0", messageIndex: 0 });
        reportCompletion({ reason: "process-exited" });
        return;
      }
    }
    if (aborted) { reportCompletion({ reason: "aborted" }); return; }
    yield noteChunk({ text: `\n[runHarness safety timeout after ${Math.round(timeoutMs / 1000)}s]`, messageId: "stdout-0", messageIndex: 0 });
    reportCompletion({ reason: "timeout" });
    } finally {
      spec.signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    mode: "user-box-full",
    location: "user-box",
    boxId,
    runHarness,
    command,
    readFile: (path: string) => box.readFile(boxId, path),
    writeFile: (path: string, content: string) => box.writeFile(boxId, path, content),
  };
}

export interface SharedInfraCapabilityOptions {
  /** Provider LLM keys exposed to the shared harness process (in addition to the host env). */
  providerEnv?: Record<string, string>;
  /** Called every time a real shared harness/command is launched (audit/proof). */
  onExec?: (info: { kind: "command" | "harness"; argv?: string[]; command?: string }) => void;
  /** Called when the harness' own stream reports a native tool call/result. */
  onHarnessEvent?: (event: HarnessToolEvent) => void;
  /** Override the process spawner (tests). Must match node:child_process spawn. */
  spawn?: typeof spawn;
}

/**
 * Shared-infra runtime. Runs the EXACT SAME external harness binary as the user
 * Box, but as a local process on the always-on shared machine. The harness is
 * launched with tools structurally disabled (the adapter passes the harness'
 * native no-tool flags), so this runtime never needs — and never grants — the
 * user's private machine. Multiple sessions can run in parallel in the same
 * working directory because each turn gets its own temp workspace.
 *
 * This is the structural counterpart to {@link createUserBoxCapabilities}: same
 * stdout parser, same chunk/message semantics, different execution location and
 * tool policy. There is no separate "shared" LLM client and no provider fallback.
 */
export function createSharedInfraCapabilities(options: SharedInfraCapabilityOptions = {}): HarnessRuntime {
  const providerEnv = options.providerEnv ?? {};
  const spawnFn = options.spawn ?? spawn;

  function baseEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    return { ...process.env, ...providerEnv, ...(extra ?? {}) };
  }

  async function command(cmd: string, opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<CommandResult> {
    options.onExec?.({ kind: "command", command: cmd });
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawnFn("bash", ["-lc", cmd], { cwd: opts.cwd, env: baseEnv(opts.env), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = opts.timeoutMs ? setTimeout(() => { child.kill("SIGKILL"); }, opts.timeoutMs) : undefined;
      child.stdout?.on("data", (d) => { stdout += String(d); });
      child.stderr?.on("data", (d) => { stderr += String(d); });
      child.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });
      child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ exitCode: code ?? 0, stdout, stderr }); });
    });
  }

  async function* runHarness(spec: HarnessRunSpec): AsyncIterable<HarnessTextChunk> {
    options.onExec?.({ kind: "harness", argv: spec.argv });
    const parser = createHarnessOutputParser(spec.outputMode ?? "raw-stdout", options.onHarnessEvent, spec.onSessionId);
    // Launch through a login shell instead of spawning argv[0] directly. npm CLIs
    // are launcher shims (extensionless shell shims resolved by Git Bash, plus
    // *.cmd on Windows); a bare spawn() bypasses PATHEXT and dies with ENOENT on
    // the exact CLIs this surface must run. bash resolves them the same way
    // `command -v` does, and shq() keeps each argv element (incl. the prompt) intact.
    // Enter the workspace via `cd` INSIDE bash rather than Node's spawn cwd.
    // spec.cwd is an MSYS path (e.g. /tmp/consumer-agent-...). On Windows, Node
    // resolves a spawn cwd against the Win32 filesystem (C:\tmp\...), which does
    // not exist, and spawn then fails with a misleading `spawn bash ENOENT`. bash
    // resolves the MSYS path correctly, so let bash change into it.
    const cdPrefix = spec.cwd ? `cd ${shq(spec.cwd)} && ` : "";
    const commandLine = cdPrefix + spec.argv.map(shq).join(" ");
    const child = spawnFn("bash", ["-lc", commandLine], { env: baseEnv(spec.env), stdio: ["ignore", "pipe", "pipe"] });
    const timeoutMs = spec.timeoutMs ?? DEFAULT_HARNESS_TIMEOUT_MS;
    let timedOut = false;
    let aborted = false;
    let sawText = false;
    let spawnError: Error | undefined;
    // A subprocess that never launches must degrade to an empty shared bridge,
    // never crash the server with an unhandled 'error' event.
    child.on("error", (err) => { spawnError = err instanceof Error ? err : new Error(String(err)); });
    const noteChunk = (chunk: HarnessTextChunk): HarnessTextChunk => {
      if (chunk.text && chunk.text.trim()) sawText = true;
      return chunk;
    };
    // KILL THE TREE, not just the immediate child. We launch via `bash -lc`, so
    // the real harness (opencode/claude/…) is a GRANDCHILD. On Windows,
    // child.kill() terminates only bash; the orphaned grandchild keeps the stdout
    // pipe open, the `for await (child.stdout)` loop never ends, the turn stays
    // "active" forever, and idle auto-stop is blocked — the exact "no answer and
    // the box never stops" failure. taskkill /T takes the whole tree down.
    const killTree = (): void => {
      if (process.platform === "win32" && child.pid) {
        try { spawnFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
      }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    // Interrupt == "agent stops talking": SIGINT for a graceful stop, then a hard
    // tree-kill if it lingers. Completed turns are already flushed to the harness'
    // session file, so the conversation stays resumable by id next turn.
    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGINT"); } catch { /* already gone */ }
      setTimeout(() => killTree(), 2000);
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener("abort", onAbort, { once: true });
    // Keep the harness' own error text for a loud, diagnostic failure: it is
    // surfaced via onComplete.stderr when the run produced no visible answer.
    let stderrBuf = "";
    child.stderr?.on("data", (d) => { if (stderrBuf.length < 4000) stderrBuf += String(d); });
    try {
      if (child.stdout) {
        // Enforce the deadline ON THE READ LOOP, not only via killTree. An
        // orphaned grandchild (opencode shim chains) can survive the tree-kill
        // holding the inherited stdout pipe open — then this loop would never end
        // and the turn would stay "active" forever, blocking idle auto-stop. Race
        // every read against a hard deadline so the TURN always terminates.
        const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
          const t = setTimeout(() => resolve({ kind: "deadline" }), timeoutMs + 5000);
          t.unref?.();
        });
        const it = child.stdout[Symbol.asyncIterator]();
        while (true) {
          const raced = await Promise.race([
            it.next().then((n) => ({ kind: "next" as const, n })),
            deadline,
          ]);
          if (raced.kind === "deadline") {
            timedOut = true;
            killTree();
            try { child.stdout.destroy(); } catch { /* already gone */ }
            break;
          }
          if (raced.n.done) break;
          for (const chunk of parseHarnessOutput(String(raced.n.value), parser)) yield noteChunk(chunk);
        }
      }
      // Flush any trailing partial JSON line the harness emitted without a newline.
      if (parser.mode !== "raw-stdout" && parser.lineBuffer.trim()) {
        const text = parseHarnessJsonLine(parser.lineBuffer.replace(/\r$/, ""), parser);
        parser.lineBuffer = "";
        if (text) yield noteChunk(text);
      }
    } catch (err) {
      // stdout torn down by a spawn failure: degrade to no shared output, don't propagate.
      spawnError = spawnError ?? (err instanceof Error ? err : new Error(String(err)));
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
    }
    await new Promise<void>((resolve) => {
      // Same principle for the close-wait: never block on a process whose pipes
      // an orphan may be holding. 10s after the read loop ended is final.
      const t = setTimeout(() => resolve(), 10_000);
      t.unref?.();
      child.on("close", () => { clearTimeout(t); resolve(); });
      child.on("error", () => { clearTimeout(t); resolve(); });
      if (child.exitCode !== null || spawnError) { clearTimeout(t); resolve(); }
    });
    if (timedOut && !aborted) yield noteChunk({ text: `\n[shared harness safety timeout after ${Math.round(timeoutMs / 1000)}s]`, messageId: "stdout-0", messageIndex: 0 });
    const diag = spawnError ? spawnError.message : stderrBuf.trim().slice(-500);
    spec.onComplete?.({
      reason: aborted ? "aborted" : spawnError ? "process-exited" : timedOut ? "timeout" : "completed",
      sawText,
      ...(typeof child.exitCode === "number" ? { exitCode: child.exitCode } : {}),
      ...(diag ? { diagnostic: diag } : {}),
    });
  }

  async function writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await fsWriteFile(path, content, "utf8");
  }

  return {
    location: "shared-infra",
    runHarness,
    command,
    readFile: (path: string) => fsReadFile(path, "utf8"),
    writeFile,
  };
}

/** Create a private temp working directory on shared infra (parallel-safe). */
export async function makeSharedWorkdir(prefix = "optibox-shared-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
