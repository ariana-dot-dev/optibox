#!/usr/bin/env node
import { readFile, mkdir, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface Args {
  stream: boolean;
  provider: string;
  model: string;
  cwd: string;
  systemPromptFile: string;
  noTools: boolean;
  /** Session id to assign (turn 1) or resume (later turns); enables continuity. */
  sessionId: string;
  resume: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    stream: false,
    provider: "unknown-provider",
    model: "unknown-model",
    cwd: process.cwd(),
    systemPromptFile: "",
    noTools: false,
    sessionId: "",
    resume: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stream") args.stream = true;
    else if (arg === "--no-tools") args.noTools = true;
    else if (arg === "--provider") args.provider = argv[++i] ?? args.provider;
    else if (arg === "--model") args.model = argv[++i] ?? args.model;
    else if (arg === "--cwd") args.cwd = argv[++i] ?? args.cwd;
    else if (arg === "--system-prompt-file") args.systemPromptFile = argv[++i] ?? args.systemPromptFile;
    else if (arg === "--session-id") args.sessionId = argv[++i] ?? args.sessionId;
    else if (arg === "--resume") { args.sessionId = argv[++i] ?? args.sessionId; args.resume = true; }
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: agent-daemon --stream --provider <name> --model <name> --cwd <dir> --system-prompt-file <path>",
        "                    [--session-id <id> | --resume <id>]",
        "",
        "Reads the Optibox turn prompt on stdin and streams assistant text on stdout.",
        "With --session-id/--resume it persists and replays a per-session transcript",
        "so the same conversation continues across processes.",
      ].join("\n") + "\n");
      process.exit(0);
    }
  }
  return args;
}

function sessionFile(sessionId: string): string {
  const dir = process.env.OPTIBOX_DAEMON_SESSION_DIR ?? path.join(os.tmpdir(), "optibox-daemon-sessions");
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "-");
  return path.join(dir, `${safe}.jsonl`);
}

interface SessionTurn { role: "user" | "assistant"; content: string }

async function loadSession(sessionId: string): Promise<SessionTurn[]> {
  if (!sessionId) return [];
  try {
    const raw = await readFile(sessionFile(sessionId), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionTurn);
  } catch { return []; }
}

async function appendSession(sessionId: string, turns: SessionTurn[]): Promise<void> {
  if (!sessionId) return;
  const file = sessionFile(sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, turns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function extractLatestRequest(prompt: string): string {
  const match = prompt.match(/<latest-user-request>([\s\S]*?)<\/latest-user-request>/i)
    ?? prompt.match(/<latest-user-message>([\s\S]*?)<\/latest-user-message>/i);
  return decodeXml((match?.[1] ?? prompt).replace(/\s+/g, " ").trim());
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function maybeRead(path: string): Promise<string> {
  if (!path) return "";
  try { return await readFile(path, "utf8"); } catch { return ""; }
}

async function writeStream(text: string, stream: boolean): Promise<void> {
  if (!stream) {
    process.stdout.write(text);
    return;
  }
  for (const chunk of text.match(/.{1,28}(?:\s|$)/gs) ?? [text]) {
    process.stdout.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prompt = await readStdin();
  const latest = extractLatestRequest(prompt);
  const systemInstructions = await maybeRead(args.systemPromptFile);
  const agentsMd = await maybeRead(`${args.cwd}/AGENTS.md`);
  const hasInstructions = Boolean(systemInstructions.trim() || agentsMd.trim());

  // Replay the persisted transcript so a --resume turn demonstrably continues the
  // same conversation instead of starting fresh.
  const prior = await loadSession(args.sessionId);
  const priorUserTurns = prior.filter((t) => t.role === "user").length;

  const lower = latest.toLowerCase();
  let answer: string;
  const needsMachine = /\b(cpu|core|cores|nproc|pwd|cwd|directory|where am i)\b/.test(lower);
  if (args.noTools) {
    // Structural no-tool mode: the daemon is launched with zero machine tools,
    // so it must not read host facts (os.cpus, cwd). It answers text-only and
    // defers any machine-specific request instead of fabricating a result.
    answer = needsMachine
      ? "Example codebase daemon (no-tools mode): I’m checking that now.\n"
      : `Example codebase daemon (no-tools mode) received: ${latest || "(empty request)"}.\n`;
  } else if (/\b(cpu|core|cores|nproc)\b/.test(lower)) {
    answer = `Example codebase daemon observed ${os.cpus().length} CPU cores.\n`;
  } else if (/\b(pwd|cwd|directory|where am i)\b/.test(lower)) {
    answer = `Example codebase daemon is using Optibox workspace ${args.cwd}.\n`;
  } else {
    answer = `Example codebase daemon received: ${latest || "(empty request)"}.\n`;
  }

  answer += `Runtime selection: ${args.provider}/${args.model}. `;
  answer += hasInstructions
    ? "Host instructions were available via --system-prompt-file / AGENTS.md.\n"
    : "No host instruction file was readable.\n";
  if (priorUserTurns > 0) {
    answer += `Resumed session ${args.sessionId} with ${priorUserTurns} earlier user turn(s) in context.\n`;
  }

  // Persist this turn so a later --resume replays it (incremental append, so a
  // completed turn survives even if a subsequent turn is interrupted/killed).
  await appendSession(args.sessionId, [
    { role: "user", content: latest },
    { role: "assistant", content: answer },
  ]);

  await writeStream(answer, args.stream);
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exit(1);
});
