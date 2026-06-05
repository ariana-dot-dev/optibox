import type { BoxClient, CommandResult, HarnessRunSpec, SafeSharedCapabilities, UserBoxCapabilities } from "./types.js";

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
  const pollMs = options.pollMs ?? 1000;
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
    // Box files API requires paths relative to the Box work directory.
    const dir = `${spec.cwd ?? "cba-work"}/${runId}`;
    const log = `${dir}/out.log`;
    const env = { ...providerEnv, ...(spec.env ?? {}) };
    const envPrefix = Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}; `).join("");
    const argvStr = spec.argv.map(shq).join(" ");
    const timeoutMs = spec.timeoutMs ?? 240_000;
    // Launch detached, tee to a log so we can poll for incremental output.
    const launch = `mkdir -p ${shq(dir)} && cd ${shq(dir)} && ${envPrefix}nohup bash -c ${shq(`${argvStr} > out.log 2>&1; echo "__CBA_EXIT__:$?" >> out.log`)} >/dev/null 2>&1 & echo $!`;
    const launched = await box.command(boxId, { command: launch, timeoutMs: 30_000 });
    const pid = launched.stdout.trim().split(/\s+/).pop() ?? "";

    const started = Date.now();
    let offset = 0;
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      let content = "";
      try { content = await box.readFile(boxId, log); } catch { /* not created yet */ }
      const exitMatch = content.match(/__CBA_EXIT__:(\d+)\s*$/);
      const visible = content.replace(/\n?__CBA_EXIT__:\d+\s*$/g, "");
      if (visible.length > offset) {
        yield visible.slice(offset);
        offset = visible.length;
      }
      if (exitMatch) return;
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
