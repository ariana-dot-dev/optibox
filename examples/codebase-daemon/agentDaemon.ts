#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import os from "node:os";

interface Args {
  stream: boolean;
  provider: string;
  model: string;
  cwd: string;
  systemPromptFile: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    stream: false,
    provider: "unknown-provider",
    model: "unknown-model",
    cwd: process.cwd(),
    systemPromptFile: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stream") args.stream = true;
    else if (arg === "--provider") args.provider = argv[++i] ?? args.provider;
    else if (arg === "--model") args.model = argv[++i] ?? args.model;
    else if (arg === "--cwd") args.cwd = argv[++i] ?? args.cwd;
    else if (arg === "--system-prompt-file") args.systemPromptFile = argv[++i] ?? args.systemPromptFile;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: agent-daemon --stream --provider <name> --model <name> --cwd <dir> --system-prompt-file <path>",
        "",
        "Reads the Optibox turn prompt on stdin and streams assistant text on stdout.",
      ].join("\n") + "\n");
      process.exit(0);
    }
  }
  return args;
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

  const lower = latest.toLowerCase();
  let answer: string;
  if (/\b(cpu|core|cores|nproc)\b/.test(lower)) {
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

  await writeStream(answer, args.stream);
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exit(1);
});
