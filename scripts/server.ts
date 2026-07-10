import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import path from "node:path";
import {
  BoxHttpClient,
  assertNoBoxAgent,
  BOX_PRICING,
  Engine,
  openDb,
  databaseUrlFromEnv,
  type Db,
  createRestrictedSharedCapabilities,
  createSharedInfraCapabilities,
  RUNTIME_FEASIBILITY,
  type ConsumerTurnEvent,
} from "../src/index.js";
import { realCliHarness, type RealCliHarnessSpec } from "../examples/shared.js";
import { spec as claudeSpec } from "../examples/claude-sdk/adapter.js";
import { spec as codebaseDaemonSpec } from "../examples/codebase-daemon/adapter.js";
import { spec as codexSpec } from "../examples/codex-sdk/adapter.js";
import { spec as opencodeOpenrouterSpec } from "../examples/opencode-openrouter/adapter.js";
import { spec as openclaudeSpec } from "../examples/openclaude/adapter.js";
import { spec as opencodeSpec } from "../examples/opencode/adapter.js";
import { spec as piSpec } from "../examples/pi/adapter.js";

const port = Number(process.env.PORT ?? 4178);

/**
 * Stable per-DEPLOYMENT identity, embedded in every Box this process creates
 * and in the orphan-reaper's own-box predicate below. Without this, two
 * separate optibox deployments sharing one Box account (a hosted preview and
 * someone's local dev server, say) create IDENTICALLY-named boxes
 * (`consumer-agent-user-<userId>-<hash>` depended only on the API key/provider
 * env, not on which machine/checkout is running), so each one's orphan sweep
 * — which force-stops any running box matching its naming that IT isn't
 * currently billing — reaps the OTHER deployment's boxes as if they were its
 * own leaked orphans. Confirmed in production: a hosted instance's reaper
 * stopped a developer's own dev-box mid-session with zero warning.
 *
 * Persisted next to this checkout (co-located with the script, not affected by
 * invocation cwd), untracked by git, survives `git reset --hard` from the
 * redeploy poller — so restarts of THIS deployment keep the same id (box
 * adoption-by-name across restarts still works), while any other checkout,
 * anywhere, mints its own id on first run and can never collide.
 */
function instanceId(): string {
  // This module compiles to dist/scripts/interactive-proof-server.js, so ".."
  // twice reaches the actual repo root (same level as .env), not the dist/
  // build output — the id must not live somewhere a future "clean dist before
  // build" step could plausibly wipe it.
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".optibox-instance-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* first run on this checkout */ }
  const id = randomBytes(4).toString("hex");
  try { writeFileSync(file, id); } catch { /* best effort; falls back to a fresh id next start */ }
  return id;
}
const INSTANCE_ID = instanceId();

// Public task-agent previews must never reuse the task agent's real Box/LLM keys.
// Alfred/private previews can opt into the old zero-config behavior with
// OPTIBOX_ALLOW_SERVER_KEYS=1; non-agent private runtimes also keep it by default.
const allowServerKeys =
  process.env.OPTIBOX_ALLOW_SERVER_KEYS === "1" ||
  (process.env.PRODUCT_MODE !== "agent" &&
    process.env.OPTIBOX_ALLOW_SERVER_KEYS !== "0");

const allSpecs: RealCliHarnessSpec[] = [
  // Pi first → it is the default harness/model selection (the client picks the
  // first harness whose provider key is available). OpenRouter-backed, feature-
  // complete, being trialled against opencode for snappiness/stability.
  piSpec,
  claudeSpec,
  codebaseDaemonSpec,
  codexSpec,
  opencodeOpenrouterSpec,
  openclaudeSpec,
  opencodeSpec,
];

interface DemoCredentials {
  boxApiKey: string | undefined;
  providerEnv: Record<string, string>;
  source: "server" | "byok";
}

const serverProviderEnv = allowServerKeys ? providerEnvFromProcess() : {};
const serverBoxApiKey = allowServerKeys ? process.env.BOX_API_KEY : undefined;
// ONE Postgres pool for the process; engines (one per BYOK credential set)
// share it. All coordination state lives in the DB — see docs/redesign.md.
const db: Db = await openDb(databaseUrlFromEnv());
const engines = new Map<string, Engine>();
const ogCache = new Map<string, { at: number; data: unknown }>();
const serverRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const auditRing: unknown[] = [];
const AUDIT_RING_LIMIT = Number(process.env.OPTIBOX_AUDIT_RING_LIMIT ?? 5000);

function rememberAudit(entry: unknown): void {
  auditRing.push(entry);
  while (auditRing.length > AUDIT_RING_LIMIT) auditRing.shift();
}

function providerEnvFromProcess(): Record<string, string> {
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

function providerEnvFromBody(raw: any): Record<string, string> {
  const apiKeys = raw && typeof raw === "object" ? raw.apiKeys ?? raw.keys ?? {} : {};
  const env: Record<string, string> = {};
  const put = (name: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) env[name] = value.trim();
  };
  put("ANTHROPIC_API_KEY", apiKeys.anthropicApiKey ?? apiKeys.ANTHROPIC_API_KEY);
  const openai = apiKeys.openaiApiKey ?? apiKeys.OPENAI_API_KEY ?? apiKeys.OPENAI_API_KEY_SCOPED;
  put("OPENAI_API_KEY", openai);
  put("OPENAI_API_KEY_SCOPED", openai);
  put("OPENROUTER_API_KEY", apiKeys.openrouterApiKey ?? apiKeys.OPENROUTER_API_KEY);
  return env;
}

function boxApiKeyFromBody(raw: any): string | undefined {
  const apiKeys = raw && typeof raw === "object" ? raw.apiKeys ?? raw.keys ?? {} : {};
  const value = apiKeys.boxApiKey ?? apiKeys.BOX_API_KEY;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function credentialsFromBody(raw: any): DemoCredentials {
  const byokProviderEnv = providerEnvFromBody(raw);
  const byokBoxApiKey = boxApiKeyFromBody(raw);
  const useByok = Boolean(byokBoxApiKey || Object.keys(byokProviderEnv).length);
  if (useByok) {
    return {
      boxApiKey: byokBoxApiKey ?? serverBoxApiKey,
      providerEnv: { ...serverProviderEnv, ...byokProviderEnv },
      source: "byok",
    };
  }
  return { boxApiKey: serverBoxApiKey, providerEnv: serverProviderEnv, source: "server" };
}

function envForProvider(provider: string): string {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return "OPENAI_API_KEY";
}

function keyAvailable(provider: string, providerEnv = serverProviderEnv): boolean {
  return Boolean(providerEnv[envForProvider(provider)]);
}

function credentialError(selection: { harness: string; provider: string; model: string }, credentials: DemoCredentials): string | undefined {
  if (!credentials.boxApiKey) {
    return allowServerKeys
      ? "BOX_API_KEY is not configured on the private preview and no BYOK Box key was provided."
      : "This public/dev preview requires your own Box API key. Open Settings (gear) and paste BOX_API_KEY.";
  }
  const required = envForProvider(selection.provider);
  if (!credentials.providerEnv[required]) {
    return allowServerKeys
      ? `${required} is not configured on the private preview and no BYOK provider key was provided.`
      : `This public/dev preview requires your own ${required}. Open Settings (gear), paste the key, and retry.`;
  }
  return undefined;
}

function engineFor(credentials: DemoCredentials): Engine {
  if (!credentials.boxApiKey) throw new Error("BOX_API_KEY is required");
  const cacheKey = createHash("sha256")
    .update(JSON.stringify({ box: credentials.boxApiKey, providerEnv: credentials.providerEnv }))
    .digest("hex");
  const cached = engines.get(cacheKey);
  if (cached) return cached;
  const providerEnv = credentials.providerEnv;
  const harnesses = allSpecs.map((spec) =>
    realCliHarness(spec, {
      createSharedRuntime: () => createSharedInfraCapabilities({ providerEnv }),
    }),
  );
  const engine = new Engine({
    db,
    box: assertNoBoxAgent(new BoxHttpClient({ apiKey: credentials.boxApiKey })),
    harnesses,
    instanceId: INSTANCE_ID,
    // BYOK isolation: the credential hash is part of every user key and box
    // name, so different key sets can never see or sweep each other's boxes.
    credHash: cacheKey.slice(0, 8),
    providerEnv,
    userBoxTtlSeconds: 900,
    readinessPollMs: 750,
    handoffTimeoutMs: 120_000,
    // 15s after the assistant finishes (product decision 2026-07-08).
    autoStopIdleMs: 15_000,
    template: {
      // Pi is the default harness; it MUST be baked into the template or every
      // fresh box would lack it — and in-turn reinstall is forbidden (crashes).
      installCmd: "npm i -g --ignore-scripts @earendil-works/pi-coding-agent >/tmp/pi-install.log 2>&1; npm i -g opencode-ai@latest >/tmp/opencode-install.log 2>&1",
      // Warm pass records the fork-cold harness launch order into the snapshot.
      warmCmd: "bash -lc 'pi --version; opencode --version' >/tmp/tpl-warm.log 2>&1 || true",
    },
  });
  engines.set(cacheKey, engine);
  return engine;
}

function harnessInfo(providerEnv = serverProviderEnv) {
  return allSpecs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    models: spec.models.map((m) => ({
      ...m,
      keyAvailable: keyAvailable(m.provider, providerEnv),
      requiredEnv: envForProvider(m.provider),
    })),
  }));
}

function sse(res: http.ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  return (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

class BodyTooLargeError extends Error {
  constructor(public limit: number, public got: number) {
    super(`request body is ${Math.round(got / 1e6)}MB — limit is ${Math.round(limit / 1e6)}MB`);
  }
}

function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    // Reject oversized bodies from the content-length header BEFORE reading:
    // destroying the socket mid-body surfaces in the browser as a bare
    // net::ERR_CONNECTION_RESET with no message and nothing in our logs. A
    // typed rejection lets the route answer 413 with a real explanation.
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBytes) {
      req.resume(); // drain so the client can read our response
      return reject(new BodyTooLargeError(maxBytes, declared));
    }
    let raw = "";
    let overflow = false;
    req.on("data", (c) => {
      if (overflow) return;
      raw += c;
      if (raw.length > maxBytes) { overflow = true; raw = ""; }
    });
    req.on("end", () => {
      if (overflow) return reject(new BodyTooLargeError(maxBytes, maxBytes + 1));
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Collect a raw binary request body into a Buffer (no base64/JSON overhead). */
function readBinaryBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBytes) {
      req.resume();
      return reject(new BodyTooLargeError(maxBytes, declared));
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    req.on("data", (c: Buffer) => {
      if (overflow) return;
      total += c.length;
      if (total > maxBytes) { overflow = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (overflow) return reject(new BodyTooLargeError(maxBytes, total));
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** Runtime log line for every fs request — stdout lands in the server log. */
function fsLog(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), audit: "fs", ...fields }));
}

function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuditValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (/hidden|recap|apiKey|token|secret|authorization/i.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactAuditValue(raw);
      }
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return value.slice(0, 500) + "…";
  return value;
}

function auditEvent(event: ConsumerTurnEvent, input: { userId: string; conversationId: string; message: string }, requestId: string) {
  const redacted: any = redactAuditValue(event);
  if (Array.isArray(redacted.argv)) redacted.argv = redacted.argv.map((v: unknown) => {
    const text = String(v);
    return /<consumer-agent-system-instructions>|<consumer-context>|<latest-user-request>/.test(text) || text.length > 300
      ? "[redacted harness prompt]"
      : text.slice(0, 120);
  });
  if (typeof redacted.command === "string" && redacted.command.includes("base64 -d")) redacted.command = "[redacted instruction-file write]";
  if (redacted.text && String(redacted.text).length > 160) redacted.text = String(redacted.text).slice(0, 160) + "…";
  const entry = {
    ts: new Date().toISOString(),
    runId: serverRunId,
    requestId,
    audit: "turn-event",
    userId: input.userId,
    conversationId: input.conversationId,
    messageHash: createHash("sha256").update(input.message).digest("hex").slice(0, 16),
    messagePreview: input.message.slice(0, 160),
    event: redacted,
  };
  rememberAudit(entry);
  console.log(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Filesystem panel backend. The browser cannot hold the Box API key, so these
// endpoints proxy: live boxes serve their real disk (files API + find), stopped
// boxes serve their latest snapshot (tree + file download endpoints) — same
// features either way except writes, which need a live box.
// ---------------------------------------------------------------------------

/** Latest desktop-connect hold release per user (renewed on every poll). */
const desktopHolds = new Map<string, () => void>();
// Rolling "user is composing" holds: typing or staging attachments raises the
// box-still-needed flag (countdown pauses at full); the client pings every few
// seconds while composing, so a short TTL drops the flag soon after they stop.
const composingHolds = new Map<string, () => void>();
// Users with a cold box-boot (fork on first keystroke) in flight — dedupes the
// 4s composing pings so typing spawns at most one fork, not one per ping.
const coldBooting = new Set<string>();

function fsBoxClient(credentials: DemoCredentials): BoxHttpClient {
  if (!credentials.boxApiKey) throw new Error("BOX_API_KEY is required");
  return new BoxHttpClient({ apiKey: credentials.boxApiKey });
}

// Box resolution is a ROW LOOKUP, never a name guess: the engine's boxes table
// is the single source of truth for "which machine is this user's". The old
// name-based fallback (list + sort by state/updatedAt) existed only because
// in-memory state died on restart — with durable rows it is dead code.

/**
 * Write raw bytes to one box file — reliably, at any size and any boot age.
 *
 * The files API is unreliable for our case in three ways: one write caps at
 * 5MB; a PUT to a path with a not-yet-existing parent dir can return 200 without
 * ever hitting disk; and moments after a boot/resume the parts PUT silently
 * no-ops while the (lazily-restored) filesystem is still settling. Root-level
 * PUTs DO persist once the FS is ready, so we ship ≤4MB parts to ROOT temp
 * files, assemble them into the target with one `cat` command (commands persist
 * and can `mkdir -p` the dir), verify the byte count, and RETRY the whole thing
 * through the settling window. Same path for a 200KB image and a 90MB video.
 */
async function writeBoxFile(client: BoxHttpClient, boxId: string, filePath: string, bytes: Buffer): Promise<void> {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const dir = filePath.includes("/") ? filePath.replace(/\/[^/]*$/, "") : ".";
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const tmp = `.cba-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const parts: string[] = [];
      for (let off = 0, i = 0; off < bytes.length || i === 0; off += 4_000_000, i++) {
        const part = `${tmp}.${i}`;
        await client.writeFileBytes(boxId, part, bytes.subarray(off, off + 4_000_000));
        parts.push(part);
      }
      const list = parts.map(q).join(" ");
      const assembled = await client.command(boxId, {
        command: `cd /home/user && mkdir -p ${q(dir)} && cat ${list} > ${q(filePath)} && rm -f ${list} && stat -c %s ${q(filePath)}`,
        timeoutMs: 60_000,
      });
      if (Number(assembled.stdout.trim()) !== bytes.length) {
        throw new Error(`assembled size mismatch: ${assembled.stdout.trim() || assembled.stderr.trim()}`);
      }
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Write bytes into the user's box, waking it first if parked. The one write
 * path shared by the JSON (base64) route and the raw-binary upload route.
 * Logs every attempt — uploads failing silently is how we ended up debugging
 * a browser ERR_CONNECTION_RESET with an empty server log.
 */
async function fsWriteIntoBox(credentials: DemoCredentials, userId: string, filePath: string, bytes: Buffer): Promise<{ status: number; payload: { ok: boolean; message?: string } }> {
  const t0 = Date.now();
  let resolvedBoxId = "";
  const done = (status: number, payload: { ok: boolean; message?: string }) => {
    fsLog({ route: "write", userId, boxId: resolvedBoxId, path: filePath, bytes: bytes.length, ms: Date.now() - t0, status, ...(payload.message ? { message: payload.message } : {}) });
    return { status, payload };
  };
  try {
    const { box, live } = await fsResolveBox(credentials, userId);
    const client = fsBoxClient(credentials);
    if (!box) return done(409, { ok: false, message: "no machine yet — send a message first" });
    resolvedBoxId = box.id;
    // Keep the box up for the duration of the upload: the hold cancels a
    // running auto-stop countdown and the reaper skips held boxes.
    const releaseHold = engineFor(credentials).holdUserBox(userId, "upload", 300_000);
    try {
      // Machine off? Boot it and wait until it actually executes a command,
      // so a drop while parked just wakes the box and completes the upload.
      // The wake registers real billing, so every counter and reaper sees it.
      await engineFor(credentials).wake(userId, "fs");
      if (!live) {
        try { await client.resume(box.id); } catch { /* may already be resuming */ }
        let up = false;
        for (let i = 0; i < 40 && !up; i++) {
          try { const p = await client.command(box.id, { command: "echo ready", timeoutMs: 30_000 }); if ((p.stdout || "").includes("ready")) up = true; } catch { /* still booting */ }
        }
        if (!up) return done(502, { ok: false, message: "machine did not wake up for the upload" });
      }
      await writeBoxFile(client, box.id, filePath, bytes);
      return done(200, { ok: true });
    } finally {
      releaseHold();
    }
  } catch (e) {
    return done(502, { ok: false, message: e instanceof Error ? e.message : String(e) });
  }
}

async function fsResolveBox(credentials: DemoCredentials, userId: string): Promise<{ box?: { id: string; state: string }; live: boolean }> {
  const activeId = await engineFor(credentials).activeUserBoxId(userId);
  if (!activeId) return { live: false };
  const active = await fsBoxClient(credentials).get(activeId).catch(() => undefined);
  if (!active) return { live: false };
  const state = String((active as { state?: string; status?: string }).state ?? (active as { status?: string }).status ?? "");
  // "live" means "worth TRYING the live path": the state string lags the
  // machine badly (starting/resuming for seconds while commands already
  // execute), so anything not clearly parked counts; callers fall back to the
  // snapshot when the live attempt fails.
  return { box: { id: active.id, state }, live: !["archived", "archiving", "stopped", "stopping"].includes(state) };
}

/**
 * Live tree: one `find` over the home directory, home-relative paths — the
 * SAME path space the snapshot tree uses, so the panel behaves identically
 * whether the box is up or down. (/tmp is tmpfs and never in snapshots.)
 */
async function fsLiveTree(client: BoxHttpClient, boxId: string): Promise<{ entries: Array<{ path: string; kind: string; size?: number; mtime?: number }>; hosting: Array<{ port: number; mode: "public" | "private" }> }> {
  const out = await client.command(boxId, {
    // %T@ = mtime as epoch seconds (float): lets the chat surface files the
    // agent created/modified during a turn by comparing against a turn-start
    // baseline, no per-command path parsing needed.
    //
    // PRUNE the multi-thousand-entry machine-noise dirs (npm/pip/cargo caches,
    // node_modules, nvm, git objects, etc). Without this, `.npm/_cacache` alone
    // is ~20k entries: the printf output blows past the byte cap and `head`
    // TRUNCATES real user files (e.g. Documents/*.pdf) out of the tail — which is
    // why "live" showed FEWER files than the complete snapshot tree. Pruning keeps
    // the output small and fast so every real file always makes it in. The cap is
    // a safety backstop only, raised well above any realistic real-file listing.
    command:
      `find /home/user -mindepth 1 ` +
      `\\( -name node_modules -o -name __pycache__ -o -name .git -o -name .npm ` +
      `-o -name .cache -o -name .cargo -o -name .rustup -o -name .nvm ` +
      `-o -name .vscode-server -o -name snap -o -name .bun -o -name .pnpm-store \\) -prune ` +
      `-o -printf '%y\\t%s\\t%T@\\t%P\\n' 2>/dev/null | head -c 8000000; ` +
      // GROUND-TRUTH hosting probe riding the same round trip: a live `host`
      // process IS hosting; its absence IS not-hosting. Command-sniffing alone
      // proved fragile (in-memory state dies on server restart and can't see a
      // host started outside a turn). This line is parsed out of the listing.
      `printf '__CBA_HOSTING__:%s\\n' "$(pgrep -af 'host [0-9]' 2>/dev/null | head -8 | tr '\\n' ';')"`,
    timeoutMs: 30_000,
  });
  const entries: Array<{ path: string; kind: string; size?: number; mtime?: number }> = [];
  const hosting: Array<{ port: number; mode: "public" | "private" }> = [];
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("__CBA_HOSTING__:")) {
      const seenPorts = new Set<number>();
      for (const m of line.matchAll(/host\s+(\d{2,5})(?:\s+\S+)*?\s+--(public|private)\b/g)) {
        const port = Number(m[1]);
        if (!seenPorts.has(port)) { seenPorts.add(port); hosting.push({ port, mode: m[2] as "public" | "private" }); }
      }
      continue;
    }
    const [y, size, mtime, ...rest] = line.split("\t");
    const p = rest.join("\t");
    if (!p || !y) continue;
    const kind = y === "d" ? "dir" : y === "l" ? "symlink" : "file";
    entries.push({ path: p, kind, ...(kind === "file" ? { size: Number(size) || 0, mtime: Math.floor(Number(mtime) || 0) } : {}) });
  }
  return { entries, hosting };
}

async function handleFsRoute(pathname: string, body: any, res: http.ServerResponse): Promise<boolean> {
  if (!pathname.startsWith("/api/fs/")) return false;
  const credentials = credentialsFromBody(body);
  const userId = String(body.userId ?? "user-a");
  const filePath = typeof body.path === "string" ? body.path.replace(/^\/+/, "") : "";
  const json = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  try {
    const { box, live } = await fsResolveBox(credentials, userId);
    const client = fsBoxClient(credentials);

    if (pathname === "/api/fs/tree") {
      // One coherent runtime snapshot rides every tree poll: the page
      // reconciles ALL counters from it, so machines woken outside a turn
      // (typing, uploads) are never invisible to the UI.
      const orch = engineFor(credentials);
      const runtime = await orch.userRuntimeStatus(userId);
      if (!box) return json(200, { ok: true, live: false, state: "none", entries: [], runtime }), true;
      if (live) {
        // Try live even while the state string still says starting/resuming —
        // but with a hard 3.5s deadline: commands against a still-booting box
        // HANG until it is up (observed 30s tree loads), and the panel repolls
        // every 4s anyway, so serving the snapshot now beats blocking.
        try {
          const { entries, hosting } = await Promise.race([
            fsLiveTree(client, box.id),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("live-tree deadline")), 6000)),
          ]);
          // Ground-truth hosting reconcile: a live host process is authoritative
          // in BOTH directions (starts hosting the badge saw nothing about;
          // clears it when the process is gone). Recompute the runtime AFTER so
          // this very response carries the corrected hosting/holds state.
          await orch.reconcileObservedHosting(userId, box.id, hosting);
          return json(200, { ok: true, live: true, state: box.state, boxId: box.id, entries, runtime: await orch.userRuntimeStatus(userId) }), true;
        } catch { /* fall through to snapshot */ }
      }
      // Parked box: hosting is de-facto over (nothing can be reachable on an
      // archived machine) — clear a stale entry so the badge/hold don't pin a
      // dead box forever.
      if (box.state === "archived") await orch.reconcileObservedHosting(userId, box.id, [], { boxLive: false });
      const snapshot = await client.latestSnapshot(box.id);
      if (!snapshot) return json(200, { ok: true, live: false, state: box.state, boxId: box.id, entries: [], runtime }), true;
      const tree = await client.snapshotTree(snapshot.id);
      return json(200, {
        ok: true, live: false, state: box.state, boxId: box.id, snapshotId: snapshot.id, runtime,
        treeAvailable: tree.treeAvailable, truncated: tree.truncated,
        entries: (tree.entries ?? []).map((e) => ({ ...e, path: e.path.replace(/^\//, "") })),
        ...(tree.reason ? { reason: tree.reason } : {}),
      }), true;
    }

    if (pathname === "/api/fs/read") {
      if (!box || !filePath) return json(404, { ok: false, message: "no box or path" }), true;
      let bytes: Buffer | undefined;
      let servedLive = false;
      if (live) {
        // Live files API rejects absolute paths ("relative to the Box work
        // directory" = the home dir), so home-relative tree paths pass as-is.
        try {
          try {
            bytes = await client.readFileBytes(box.id, filePath);
          } catch (e) {
            // Reads are capped at 5MB like writes (verified: 410 under the 502).
            // Fallback: split into 4MB parts in the box, read each, reassemble.
            const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
            const tmp = `.cba-dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            const prep = await client.command(box.id, {
              command: `cd /home/user && mkdir -p ${q(tmp)} && split -b 4000000 -d -a 4 ${q(filePath)} ${q(tmp + "/p")} && ls ${q(tmp)} | wc -l`,
              timeoutMs: 60_000,
            });
            const n = Number(prep.stdout.trim());
            if (!n) throw e;
            const chunks: Buffer[] = [];
            for (let i = 0; i < n; i++) chunks.push(await client.readFileBytes(box.id, `${tmp}/p${String(i).padStart(4, "0")}`));
            void client.command(box.id, { command: `rm -rf /home/user/${tmp}`, timeoutMs: 30_000 }).catch(() => undefined);
            bytes = Buffer.concat(chunks);
          }
          servedLive = true;
        } catch { /* machine not actually up -> snapshot below */ }
      }
      if (!bytes) {
        const snapshot = await client.latestSnapshot(box.id);
        if (!snapshot) return json(404, { ok: false, message: "no snapshot" }), true;
        // Snapshot paths are home-relative (verified: ".bashrc" 200, "/.bashrc" 404).
        bytes = (await client.snapshotFileBytes(snapshot.id, filePath)).bytes;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.length,
        "x-fs-live": servedLive ? "1" : "0",
      });
      return res.end(bytes), true;
    }

    if (pathname === "/api/fs/desktop") {
      if (!box || !live) return json(409, { ok: false, message: "machine is off" }), true;
      // Rolling keep-alive: VNC provisioning takes ~20s (longer than the idle
      // window), and a stream the user is about to watch shouldn't die under
      // them. Each poll renews a 45s hold; the TTL is the release.
      desktopHolds.get(userId)?.();
      desktopHolds.set(userId, engineFor(credentials).holdUserBox(userId, "desktop-connect", 45_000));
      // Moonlight (60fps WebRTC) by default; body.vnc=true returns the noVNC
      // stream instead — plain websockets, which load on networks where the
      // WebRTC stream never connects (the widget offers an in-place switch).
      // publicAccess: the tokened URL suits iframes (no cookie dance); the
      // host stays unguessable per-box.
      const desktop = await client.desktopStreamUrl(box.id, { theme: "light", publicAccess: true, ...(body.vnc ? { vnc: true } : {}) });
      return json(200, { ok: true, provisioning: desktop.provisioning, ...(desktop.desktopUrl ? { desktopUrl: desktop.desktopUrl } : {}), ...(desktop.message ? { message: desktop.message } : {}) }), true;
    }

    if (pathname === "/api/fs/write") {
      if (!filePath || typeof body.contentB64 !== "string") return json(400, { ok: false, message: "path and contentB64 required" }), true;
      const r = await fsWriteIntoBox(credentials, userId, filePath, Buffer.from(body.contentB64, "base64"));
      return json(r.status, r.payload), true;
    }

    // "User is composing": typing or staging attachments raises the flag —
    // renew a rolling hold (pauses any running countdown at full) and wake the
    // box if it's parked so it's warm by the time the message is sent.
    if (pathname === "/api/fs/activity") {
      const orch = engineFor(credentials);
      composingHolds.get(userId)?.();
      composingHolds.set(userId, orch.holdUserBox(userId, "composing", 15_000));
      if (box) {
        // Wake + bill through the one shared machinery: the counter, reaper
        // and status endpoint all see this machine like a turn-started one.
        await orch.wake(userId, "composing"); orch.prewarmBoxServe(box.id);
        if (!live) {
          fsLog({ route: "activity", userId, note: "composing wake", boxId: box.id, state: box.state });
          void client.resume(box.id).catch(() => undefined);
        }
      } else if (!coldBooting.has(userId)) {
        // No box exists yet (fresh account / post-reset): typing must still
        // "start the machine". Fork/boot one now — ONCE per user (deduped), fired
        // and forgotten — and start billing the instant the box id is known
        // (onBootAck) so the counter appears immediately. The composing hold keeps
        // it alive; the reaper reclaims it if the user stops typing without sending.
        // The session is keyed to the SAME conversation the send will use, so
        // /api/send reuses this exact box instead of forking a second one.
        coldBooting.add(userId);
        const convId = String(body.conversationId ?? "conv-1");
        fsLog({ route: "activity", userId, note: "cold boot on type", conversationId: convId });
        // ensureUserBox wakes/bills as part of provisioning (engine.wake inside);
        // prewarm the resident harness runtime once the box exists.
        void orch.ensureUserBox(userId, convId).then((booted) => {
          if (booted?.id) orch.prewarmBoxServe(booted.id);
        }).catch((e) => fsLog({ route: "activity", userId, note: "cold boot failed", message: String(e).slice(0, 140) }))
          .finally(() => coldBooting.delete(userId));
      }
      // Return the SAME runtime snapshot the tree poll carries: the composing
      // ping is the fastest channel the client has while the user types, so the
      // header counters reconcile within one ping of billing starting instead of
      // waiting out the 4s tree poll (which visibly raced short compose windows:
      // machine billing server-side, header stuck at 0.0s until send).
      return json(200, { ok: true, state: box?.state ?? "none", live, runtime: await orch.userRuntimeStatus(userId), ...(coldBooting.has(userId) ? { booting: true } : {}) }), true;
    }

    // Remove a staged attachment the user deleted from the composer before
    // sending. ATTEMPT the live command regardless of the state string — it
    // lags badly (a box woken by a staged upload can read "archiving" for many
    // seconds while commands already execute). Only report off if the command
    // itself fails; a parked box's snapshot is read-only and not worth a boot.
    if (pathname === "/api/fs/delete") {
      if (!filePath) return json(400, { ok: false, message: "path required" }), true;
      if (!filePath.startsWith("attachments/")) return json(400, { ok: false, message: "only attachments/ files can be deleted here" }), true;
      if (!box) return json(409, { ok: false, message: "no machine — nothing to delete" }), true;
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      // Retry through boot-transition stalls (commands can return empty stdout
      // for a while right after a wake) — same medicine as writeBoxFile.
      let removed = false;
      let lastErr = "";
      for (let attempt = 0; attempt < 4 && !removed; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2_000));
        try {
          const out = await client.command(box.id, { command: `cd /home/user && rm -f ${q(filePath)} && test ! -e ${q(filePath)} && echo removed`, timeoutMs: 20_000 });
          removed = out.stdout.includes("removed");
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
        }
      }
      fsLog({ route: "delete", userId, path: filePath, ok: removed, ...(removed ? {} : { error: lastErr || "no confirmation" }) });
      return json(removed ? 200 : 409, removed ? { ok: true } : { ok: false, message: "could not delete — machine may be off; file will be ignored" }), true;
    }

    return json(404, { ok: false, message: "unknown fs endpoint" }), true;
  } catch (e) {
    return json(502, { ok: false, message: e instanceof Error ? e.message : String(e) }), true;
  }
}

const STATIC_ASSETS: Record<string, { file: string; type: string }> = {
  "/static/app.css": { file: "scripts/assets/app.css", type: "text/css; charset=utf-8" },
  "/static/app.js": { file: "scripts/assets/app.js", type: "text/javascript; charset=utf-8" },
  "/static/fs-panel.js": { file: "scripts/assets/fs-panel.js", type: "text/javascript; charset=utf-8" },
  "/static/fs-panel.css": { file: "scripts/assets/fs-panel.css", type: "text/css; charset=utf-8" },
  "/static/mobile.js": { file: "scripts/assets/mobile.js", type: "text/javascript; charset=utf-8" },
};

// Graceful drain: deploys must NEVER kill in-flight turns (22 mid-turn restarts
// in one day taught this). Every open SSE stream is counted; SIGTERM flips
// `draining` (new sends get a clear 503 + the client can retry after the
// restart), and the process exits once streams finish or after a hard cap.
let activeStreams = 0;
let draining = false;
process.on("SIGTERM", () => {
  draining = true;
  console.log(`[server] SIGTERM: draining ${activeStreams} active stream(s)`);
  const started = Date.now();
  const timer = setInterval(() => {
    if (activeStreams === 0 || Date.now() - started > 8 * 60_000) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 500);
  timer.unref?.();
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(readFileSync("scripts/assets/app.html", "utf8"));
    }

    if (req.method === "GET" && url.pathname === "/api/busy") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ busy: activeStreams, draining }));
    }

    const asset = req.method === "GET" ? STATIC_ASSETS[url.pathname] : undefined;
    if (asset) {
      res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" });
      return void res.end(readFileSync(asset.file, "utf8"));
    }

    // Raw-binary upload: the panel/composer sends the file bytes directly
    // (query: userId, path; header x-fs-keys for BYOK). No base64 inflation,
    // no giant JSON.parse — this is the path for anything big.
    if (req.method === "POST" && url.pathname === "/api/fs/upload") {
      const userId = String(url.searchParams.get("userId") || "user-a");
      const filePath = String(url.searchParams.get("path") || "").replace(/^\/+/, "");
      let keys: unknown = {};
      try { keys = JSON.parse(String(req.headers["x-fs-keys"] || "{}")); } catch { /* optional */ }
      const credentials = credentialsFromBody({ apiKeys: keys });
      if (!filePath) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ ok: false, message: "path query param required" }));
      }
      const bytes = await readBinaryBody(req, 400_000_000);
      const r = await fsWriteIntoBox(credentials, userId, filePath, bytes);
      res.writeHead(r.status, { "content-type": "application/json" });
      return void res.end(JSON.stringify(r.payload));
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/fs/")) {
      // Small JSON writes/reads only; big uploads go through /api/fs/upload.
      const body = await readBody(req, 128_000_000);
      await handleFsRoute(url.pathname, body, res);
      return;
    }

    // Voice messages: transcribe recorded audio with OpenAI Whisper. The key is
    // server-side (WHISPER_API_KEY), with a BYOK OpenAI key as fallback.
    if (req.method === "POST" && url.pathname === "/api/transcribe") {
      const body = await readBody(req, 64_000_000);
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const key = process.env.WHISPER_API_KEY
        || credentialsFromBody(body).providerEnv.OPENAI_API_KEY
        || process.env.OPENAI_API_KEY
        || process.env.OPENAI_API_KEY_SCOPED;
      if (!key) return void json(400, { ok: false, message: "No transcription key (set WHISPER_API_KEY or provide an OpenAI key in Settings)." });
      if (typeof body.audioB64 !== "string") return void json(400, { ok: false, message: "audioB64 required" });
      try {
        const bytes = Buffer.from(body.audioB64, "base64");
        const mime = typeof body.mime === "string" && body.mime ? body.mime : "audio/webm";
        const ext = mime.includes("mp4") || mime.includes("mpeg") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: mime }), `audio.${ext}`);
        form.append("model", "whisper-1");
        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        });
        const text = await r.text();
        if (!r.ok) return void json(502, { ok: false, message: `whisper ${r.status}: ${text.slice(0, 300)}` });
        const parsed = JSON.parse(text);
        return void json(200, { ok: true, text: String(parsed.text ?? "").trim() });
      } catch (e) {
        return void json(502, { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/og") {
      // Open-Graph preview proxy for links the agent mentions in chat. The
      // browser can't fetch cross-origin pages itself, so the host fetches the
      // page and returns just the embed fields. Cached; failures return ok:false
      // (the client then renders a plain domain card instead).
      const target = url.searchParams.get("url") ?? "";
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      try {
        const t = new URL(target);
        if (t.protocol !== "http:" && t.protocol !== "https:") return void send(400, { ok: false, message: "http(s) only" });
        // Never proxy into local/private networks (SSRF guard).
        const host = t.hostname.toLowerCase();
        if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") || /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || host.startsWith("[")) {
          return void send(400, { ok: false, message: "private host" });
        }
        const cached = ogCache.get(t.href);
        if (cached && Date.now() - cached.at < 15 * 60_000) return void send(200, cached.data);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        let html = "";
        try {
          const page = await fetch(t.href, { signal: ctrl.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; optibox-og/1.0)", accept: "text/html" } });
          html = (await page.text()).slice(0, 400_000);
        } finally { clearTimeout(timer); }
        const pick = (...patterns: RegExp[]) => {
          for (const re of patterns) { const m = html.match(re); if (m?.[1]) return m[1].replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim(); }
          return "";
        };
        const meta = (prop: string) => pick(
          new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
          new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"),
        );
        let image = meta("og:image") || meta("twitter:image");
        if (image) { try { image = new URL(image, t.href).href; } catch { image = ""; } }
        const data = {
          ok: true,
          url: t.href,
          title: meta("og:title") || meta("twitter:title") || pick(/<title[^>]*>([^<]+)<\/title>/i) || t.hostname,
          description: (meta("og:description") || meta("twitter:description") || meta("description")).slice(0, 240),
          image,
          site: meta("og:site_name") || t.hostname.replace(/^www\./, ""),
        };
        ogCache.set(t.href, { at: Date.now(), data });
        return void send(200, data);
      } catch (e) {
        return void send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/harnesses") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({
          harnesses: harnessInfo(),
          env: {
            BOX_API_KEY: Boolean(serverBoxApiKey),
            ANTHROPIC_API_KEY: keyAvailable("anthropic"),
            OPENAI_API_KEY: keyAvailable("openai"),
            OPENROUTER_API_KEY: keyAvailable("openrouter"),
          },
          serverKeysAllowed: allowServerKeys,
          credentialMode: allowServerKeys ? "server-or-byok" : "byok-required",
          runtimeFeasibility: RUNTIME_FEASIBILITY,
          boxAgent: "disabled (assertNoBoxAgent guard)",
          pricing: BOX_PRICING,
        }),
      );
    }

    if (req.method === "GET" && url.pathname === "/api/diagnostics") {
      const format = url.searchParams.get("format") ?? "json";
      const payload = {
        runId: serverRunId,
        generatedAt: new Date().toISOString(),
        eventCount: auditRing.length,
        audit: auditRing,
      };
      if (format === "jsonl") {
        res.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition": `attachment; filename="optibox-diagnostics-${serverRunId}.jsonl"`,
        });
        return void res.end(auditRing.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="optibox-diagnostics-${serverRunId}.json"`,
      });
      return void res.end(JSON.stringify(payload, null, 2));
    }

    // Live restricted-mode proof: exercise the shared capabilities and show denials.
    if (req.method === "POST" && url.pathname === "/api/restricted-proof") {
      const caps = createRestrictedSharedCapabilities();
      const results: { action: string; denied: boolean; message: string }[] =
        [];
      for (const [action, call] of [
        ["readFile(/etc/passwd)", () => caps.readFile("/etc/passwd")],
        ["bash(id)", () => caps.bash("id")],
        ["writeFile(proof.txt)", () => caps.writeFile("proof.txt", "x")],
        ["controlComputer(click)", () => caps.controlComputer("click 0 0")],
      ] as const) {
        try {
          await call();
          results.push({
            action,
            denied: false,
            message: "UNEXPECTEDLY ALLOWED",
          });
        } catch (e) {
          results.push({
            action,
            denied: true,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ results }));
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      if (draining) {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "5" });
        return void res.end(JSON.stringify({ ok: false, message: "server is restarting for a deploy — retry in a few seconds" }));
      }
      const body = await readBody(req, 256_000_000);
      const send = sse(res);
      activeStreams++;
      res.once("close", () => { activeStreams = Math.max(0, activeStreams - 1); });
      // Chat attachments ride the send body as base64 and are written into the
      // box under attachments/ the instant it bills — see the billing.start
      // branch below (before the agent runs, so the file is always there).
      // Attachments already staged into the box while the user composed arrive
      // as {name, alreadyUploaded:true} with no bytes — nothing to write.
      const attachments: Array<{ name: string; contentB64: string }> = Array.isArray(body.attachments)
        ? body.attachments.filter((a: any) => a && typeof a.name === "string" && typeof a.contentB64 === "string" && !a.alreadyUploaded)
        : [];
      let attachmentsUploaded = false;
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const selection = {
        harness: String(body.harness),
        provider: String(body.provider),
        model: String(body.model),
      };
      const credentials = credentialsFromBody(body);
      try {
        const configError = credentialError(selection, credentials);
        if (configError) {
          send({ type: "error", message: configError });
          send({ type: "stream.end" });
          return void res.end();
        }
        const orchestrator = engineFor(credentials);
        const turnInput = {
          userId: String(body.userId ?? "user-a"),
          conversationId: String(body.conversationId ?? "conv-1"),
          message: String(body.message ?? ""),
          selection,
        };
        const receivedEvent: ConsumerTurnEvent = {
          type: "trace",
          stage: "backend.request.received",
          message: "POST /api/send reached backend; SSE stream opened",
          harness: selection.harness,
          model: selection.model,
          data: {
            runId: serverRunId,
            requestId,
            credentialSource: credentials.source,
          },
        };
        auditEvent(receivedEvent, turnInput, requestId);
        send(receivedEvent);
        for await (const event of orchestrator.runTurn(turnInput)) {
          auditEvent(event as ConsumerTurnEvent, turnInput, requestId);
          const ev = event as ConsumerTurnEvent;
          const boxIdForDesktop = (ev as any).boxId;
          // Two box-ready signals fire before the agent runs: billing.start (a
          // COLD box's first bill) and the runtime.owner.selected trace (fires
          // on EVERY box turn, incl. WARM reuse where billing.start is skipped).
          // Upload attachments on whichever lands first, awaiting here so the
          // turn suspends and the file is present before the agent looks. Only
          // billing.start also (re)provisions the desktop.
          const boxReady = typeof boxIdForDesktop === "string" &&
            (ev.type === "billing.start" || (ev.type === "trace" && (ev as any).stage === "runtime.owner.selected"));
          if (ev.type === "billing.start" && typeof boxIdForDesktop === "string") {
            void fsBoxClient(credentials).desktopStreamUrl(boxIdForDesktop, { theme: "light", publicAccess: true }).catch(() => undefined);
          }
          if (boxReady) {
            send(ev);
            if (attachments.length && !attachmentsUploaded) {
              attachmentsUploaded = true;
              const client = fsBoxClient(credentials);
              const hold = orchestrator.holdUserBox(turnInput.userId, "upload", 300_000);
              try {
                // The box may bill before its filesystem is mounted — a files-API
                // PUT can 200 without persisting. A command BLOCKS until the box
                // truly executes, so use one as a readiness gate before any write.
                for (let i = 0; i < 12; i++) {
                  try {
                    const probe = await client.command(boxIdForDesktop, { command: "echo ready", timeoutMs: 30_000 });
                    if ((probe.stdout || "").includes("ready")) break;
                  } catch { /* box still booting; retry */ }
                }
                for (const a of attachments) {
                  const dest = "attachments/" + a.name.replace(/[/\\]/g, "_");
                  try {
                    await writeBoxFile(client, boxIdForDesktop, dest, Buffer.from(a.contentB64, "base64"));
                    send({ type: "trace", stage: "attachment.uploaded", message: `saved ${dest}` } as ConsumerTurnEvent);
                  } catch (err) {
                    send({ type: "trace", stage: "attachment.failed", message: `failed to save ${dest}: ${err instanceof Error ? err.message : String(err)}` } as ConsumerTurnEvent);
                  }
                }
              } finally {
                hold();
              }
            }
            continue;
          }
          send(ev);
        }
        send({ type: "stream.end" });
      } catch (e) {
        send({
          type: "error",
          message: e instanceof Error ? (e.stack ?? e.message) : String(e),
        });
      }
      return void res.end();
    }

    // Stop hosting: close the exposed port (ufw) + kill the host process on the
    // box and release the indefinite hosting hold, so the machine can idle-stop
    // again. Triggered by the header "stop hosting" button.
    if (req.method === "POST" && url.pathname === "/api/host/stop") {
      const body = await readBody(req);
      try {
        const credentials = credentialsFromBody(body);
        const port = Number.isFinite(Number(body.port)) && Number(body.port) > 0 ? Number(body.port) : undefined;
        const result = await engineFor(credentials).stopHosting(String(body.userId ?? "user-a"), port);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ ok: false, message: e instanceof Error ? e.message : String(e) }));
      }
    }

    // Stop streams the full lifecycle (stopping -> archiving -> archived) and the
    // exact moment billing pauses.
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const body = await readBody(req);
      const send = sse(res);
      try {
        const credentials = credentialsFromBody(body);
        if (!credentials.boxApiKey) {
          send({ type: "error", message: allowServerKeys ? "BOX_API_KEY is not configured." : "Open Settings (gear) and paste BOX_API_KEY before pausing a BYOK Box." });
          send({ type: "stream.end" });
          return void res.end();
        }
        const orchestrator = engineFor(credentials);
        for await (const event of orchestrator.stopUserBox(
          String(body.userId ?? "user-a"),
          String(body.conversationId ?? "conv-1"),
        )) {
          send(event as ConsumerTurnEvent);
        }
        send({ type: "stream.end" });
      } catch (e) {
        send({
          type: "error",
          message: e instanceof Error ? (e.stack ?? e.message) : String(e),
        });
      }
      return void res.end();
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    const tooLarge = e instanceof BodyTooLargeError;
    fsLog({ route: req.url ?? "?", status: tooLarge ? 413 : 500, error: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) {
      res.writeHead(tooLarge ? 413 : 500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        message: tooLarge ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e),
      }));
    } else {
      res.end();
    }
  }
});

server.listen(port, "0.0.0.0", () =>
  console.log(`interactive proof server on 0.0.0.0:${port}`),
);

// UI lives in scripts/assets/app.html/app.css/app.js (served statically).

