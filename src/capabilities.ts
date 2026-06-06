import type { BoxClient, CommandResult, HarnessOutputMode, HarnessRunSpec, SafeSharedCapabilities, UserBoxCapabilities } from "./types.js";

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
}

function createHarnessOutputParser(mode: HarnessOutputMode): HarnessOutputParser {
  return { mode, lineBuffer: "", emittedText: "" };
}

function* parseHarnessOutput(rawDelta: string, parser: HarnessOutputParser): Iterable<string> {
  if (parser.mode === "raw-stdout") {
    yield rawDelta;
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

function parseHarnessJsonLine(line: string, parser: HarnessOutputParser): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return "";
  let j: any;
  try { j = JSON.parse(trimmed); } catch { return ""; }

  if (parser.mode === "claude-stream-json") {
    const delta = j.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.type === "text_delta"
      ? j.event.delta.text
      : undefined;
    if (typeof delta === "string") {
      parser.emittedText += delta;
      return delta;
    }
    if (!parser.emittedText && j.type === "result" && typeof j.result === "string") {
      parser.emittedText = j.result;
      return j.result;
    }
    return "";
  }

  if (parser.mode === "opencode-json" || parser.mode === "pi-json") {
    const ev = j.assistantMessageEvent;
    if (j.type === "message_update" && ev?.type === "text_delta" && typeof ev.delta === "string") {
      parser.emittedText += ev.delta;
      return ev.delta;
    }
    const full = j.type === "message_end" && extractAssistantMessageText(j.message);
    return emitNewSuffix(String(full || ""), parser);
  }

  if (parser.mode === "codex-json") {
    const delta = typeof j.delta === "string" ? j.delta
      : typeof j.delta?.text === "string" ? j.delta.text
      : typeof j.item?.delta === "string" ? j.item.delta
      : typeof j.item?.delta?.text === "string" ? j.item.delta.text
      : "";
    if (delta) { parser.emittedText += delta; return delta; }
    const full = j.type === "item.completed" && j.item?.type === "agent_message" && typeof j.item.text === "string" ? j.item.text : "";
    return emitNewSuffix(full, parser);
  }

  return "";
}

function emitNewSuffix(fullText: string, parser: HarnessOutputParser): string {
  if (!fullText) return "";
  if (fullText.startsWith(parser.emittedText)) {
    const next = fullText.slice(parser.emittedText.length);
    parser.emittedText = fullText;
    return next;
  }
  if (parser.emittedText && parser.emittedText.includes(fullText)) return "";
  parser.emittedText += fullText;
  return fullText;
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

  async function* runHarness(spec: HarnessRunSpec): AsyncIterable<string> {
    options.onExec?.({ kind: "harness", argv: spec.argv });
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workdir = spec.cwd ?? "cba-work";
    const dir = `${workdir}/.cba-runs/${runId}`;
    const log = `${dir}/out.log`;
    const env = { ...providerEnv, ...(spec.env ?? {}) };
    const envPrefix = Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}; `).join("");
    const argvStr = spec.argv.map(shq).join(" ");
    const timeoutMs = spec.timeoutMs ?? 240_000;
    const parser = createHarnessOutputParser(spec.outputMode ?? "raw-stdout");
    const effectivePollMs = spec.pollMs ?? pollMs;
    // Launch detached, tee to a log so we can poll for incremental output.
    // The harness process runs in spec.cwd so AGENTS.md / other native rule
    // files written there are in the harness' real discovery path.
    const launch = `mkdir -p ${shq(dir)} && cd ${shq(workdir)} && ${envPrefix}nohup bash -c ${shq(`${argvStr} > ${shq(log)} 2>&1; echo "__CBA_EXIT__:$?" >> ${shq(log)}`)} >/dev/null 2>&1 & echo $!`;
    const launched = await box.command(boxId, { command: launch, timeoutMs: 30_000 });
    const pid = launched.stdout.trim().split(/\s+/).pop() ?? "";

    const started = Date.now();
    let offset = 0;
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, effectivePollMs));
      let content = "";
      try {
        content = (await box.command(boxId, { command: `cat ${shq(log)} 2>/dev/null || true`, timeoutMs: 15_000 })).stdout;
      } catch { /* not created yet */ }
      const exitMatch = content.match(/__CBA_EXIT__:(\d+)\s*$/);
      const visible = content.replace(/\n?__CBA_EXIT__:\d+\s*$/g, "");
      if (visible.length > offset) {
        const rawDelta = visible.slice(offset);
        for (const chunk of parseHarnessOutput(rawDelta, parser)) yield chunk;
        offset = visible.length;
      }
      if (exitMatch) {
        if (parser.mode !== "raw-stdout" && parser.lineBuffer.trim()) {
          const text = parseHarnessJsonLine(parser.lineBuffer.replace(/\r$/, ""), parser);
          parser.lineBuffer = "";
          if (text) yield text;
        }
        return;
      }
      // process gone but no exit marker -> stop polling
      if (pid) {
        const alive = (await box.command(boxId, { command: `kill -0 ${pid} 2>/dev/null && echo up || echo down`, timeoutMs: 15_000 })).stdout.trim();
        if (alive === "down") { if (visible.length > offset) yield visible.slice(offset); return; }
      }
    }
    yield `\n[runHarness timed out after ${Math.round(timeoutMs / 1000)}s]`;
  }

  return {
    mode: "user-box-full",
    boxId,
    runHarness,
    command,
    readFile: (path: string) => box.readFile(boxId, path),
    writeFile: (path: string, content: string) => box.writeFile(boxId, path, content),
  };
}
