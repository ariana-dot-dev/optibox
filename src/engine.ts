import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import {
  AGENT_CREDENTIALS, agentCredentialStates, applyPatch, sameMap, subscriptionClear, subscriptionCredentials, subscriptionSpec,
  type AgentOAuthState, type UserAgentSelection, type UserAgentsView,
} from "./agents.js";
import { OAuthClient, tokenIsStale, type DevicePoll, type OAuthProvider, type OAuthTokens } from "./oauth.js";
import { buildHiddenContext, SANDBOX_PRICE_USD_PER_SECOND, SANDBOX_PRICING } from "./context.js";
import { sandboxRules, sandboxTurnPrompt, directProviderStream, sharedPrompt, type SharedStream } from "./shared.js";
import type { SandboxClient, SandboxEvent, SandboxInfo, ConsumerTurnEvent, ConsumerTurnEventBody, ConsumerTurnInput, HarnessSelection, TranscriptMessage } from "./types.js";

/**
 * The engine: the 6-rule spec on Postgres, with the sandbox's integrated agents
 * doing the private work.
 *
 *  1. always answer something          -> shared bridge streams immediately
 *  2. sandbox agent may answer on top      -> POST /prompt on the user's sandbox, GET /events streamed
 *  3. shared decides full vs holding   -> its own instructions (shared.ts)
 *  4. machine stops after idle window  -> sweeper over rows, countdown in runtimeStatus
 *  5. warm+responsive sandbox -> direct    -> no bridge text when sandbox is ON
 *  6. sandbox declines with <end> only     -> render nothing; no-text-no-end is a LOUD turn.blocked
 *
 * The Boat keeps each conversation's memory (its harness session) itself:
 * the engine only stores which sandbox conversation belongs to which chat, and
 * writes the standing rules (AGENTS.md / CLAUDE.md) once per machine. Every
 * piece of coordination state is a row; the two locks are Postgres advisory
 * locks: ('user', key) for sandbox lifecycle and ('conv', key) for turn ordering.
 */

export interface EngineOptions {
  db: Db;
  sandbox: SandboxClient;
  instanceId: string;
  /** Isolates one Boat ACCOUNT's rows from another's; part of every user key. */
  credHash: string;
  /** FALLBACK provider keys: what a user's sandbox runs on until that user sets their own. */
  providerEnv?: Record<string, string>;
  /** The shared bridge model, "<provider>/<model>"; or an injected stream (tests). */
  sharedModel?: string;
  /** Picks the bridge model for a given key set (the bridge runs on the user's keys when it can). */
  sharedModelForEnv?: (env: Record<string, string>) => string;
  sharedStream?: SharedStream;
  userSandboxTtlSeconds?: number;
  autoStopIdleMs?: number;
  sweepIntervalMs?: number;
  maxBillingAgeMs?: number;
  readinessPollMs?: number;
  handoffTimeoutMs?: number;
  /** Minimum machine age before the direct (no-bridge) route applies; younger sandboxes bridge as if off. */
  directMinWarmMs?: number;
  /** Cadence of the GET /events poll while a sandbox turn runs. */
  eventPollMs?: number;
  /** Parallel scenarios: the shared model may fan a turn into N conversations on the user's sandbox. */
  scenariosEnabled?: boolean;
  /** The subscription sign-ins. Injectable so the suite can drive a fake provider. */
  oauth?: OAuthClient;
}

/** What the browser needs to walk the user through one sign-in. */
export interface AgentOAuthStart {
  sessionId: string;
  provider: OAuthProvider;
  /** Claude: the page the user approves. ChatGPT: where the user types the code. Kimi: the approval link, code included. */
  url: string;
  /** ChatGPT and Kimi: the short code the user confirms. */
  userCode?: string;
  /** ChatGPT and Kimi: seconds between polls. */
  interval?: number;
}

export type AgentOAuthResult =
  | { status: "pending" }
  | { status: "connected"; applied: "now" | "next-start" | "none"; sandboxId?: string };

type EventBody = ConsumerTurnEventBody;

/** Small unbounded push/pull queue bridging background work into turn streams. */
class EventQueue {
  private items: EventBody[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(e: EventBody): void { this.items.push(e); this.wake?.(); }
  end(): void { this.closed = true; this.wake?.(); }
  drain(): EventBody[] { const out = this.items; this.items = []; return out; }
  get done(): boolean { return this.closed && this.items.length === 0; }
  async wait(): Promise<void> {
    if (this.items.length || this.closed) return;
    await new Promise<void>((r) => { this.wake = () => { this.wake = null; r(); }; });
  }
}

const fingerprintOf = (message: string): string =>
  message.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200);

const HOST_CMD_RE = /(?:^|[\s;|&(])host\s+(\d{2,5})(?:\s+\S+)*?\s+--(public|private)\b/;

// A tool command "touches the desktop" if it drives the X session — the same
// marks the UI uses to show the live desktop widget. The first such command in
// a turn starts a sandbox-side screen recording.
const DESKTOP_MARKS = ["xdotool", "wmctrl", "xdg-open", "ydotool", "wtype", "scrot", "DISPLAY=", "chromium", "google-chrome", "firefox", "lux "];
const isDesktopCommand = (cmd: string): boolean => DESKTOP_MARKS.some((m) => cmd.includes(m));

// Parallel scenarios: the shared model marks a genuinely ambiguous request by
// ending its reply with <optibox-fork>label A | label B</optibox-fork>.
const FORK_TAG_RE = /<optibox-fork>([\s\S]*?)<\/optibox-fork>/i;
function parseForkLabels(text: string): string[] {
  const m = FORK_TAG_RE.exec(text);
  if (!m || !m[1]) return [];
  const uniq = [...new Set(m[1].split("|").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean))];
  return uniq.length >= 2 ? uniq.slice(0, 4) : [];
}
const stripForkTag = (text: string): string => text.replace(/<optibox-fork>[\s\S]*/i, "").trimEnd();

const FORK_DIRECTIVE = [
  "PARALLEL EXPLORATION (overrides the 'never output tags' rule above, for this one tag only): the private runtime can pursue several directions AT ONCE. When the user's request presents two or three genuinely distinct directions — an explicit either/or, or a task with two clearly different valid approaches each worth building out in full — do NOT ask which one and do NOT pick just one.",
  "Instead: give a brief, neutral one- or two-sentence framing that names the directions, then end your reply with EXACTLY this hidden tag on its own final line: <optibox-fork>short label A | short label B</optibox-fork> — 2 or 3 labels, each 2-4 words. Never mention or explain it. For a single unambiguous ask, omit it entirely and answer normally.",
].join(" ");

/** Command text of a tool call, whatever the harness names its shell tool's argument. */
function toolCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const raw = i.command ?? i.cmd ?? i.script;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map(String).join(" ");
  return undefined;
}
const toolText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c === "string" ? c : String((c as { text?: string })?.text ?? ""))).join("") : "";

type SandboxOutcome =
  | { outcome: "answered"; text: string }
  | { outcome: "silent"; text: "" }
  | { outcome: "interrupted"; text: string }
  | { outcome: "blocked"; text: ""; diagnostic: string; blockedEmitted: boolean };

/** A turn once its selection has been resolved against the user's Agents default. */
type ResolvedTurnInput = ConsumerTurnInput & { selection: HarnessSelection };

/** The Agents row of one user: their keys, their secret files, their default model. */
interface UserAgentsRow {
  providerEnv: Record<string, string>;
  agentFiles: Record<string, string>;
  selection: UserAgentSelection;
  envPending: boolean;
  /** Refresh tokens of the connected subscriptions; never reaches the sandbox. */
  oauth: AgentOAuthState;
}

/** One sign-in the user has started but not finished. Lives for 10 minutes. */
interface OAuthSession {
  provider: OAuthProvider;
  userId: string;
  verifier?: string;
  deviceAuthId?: string;
  userCode?: string;
  expiresAt: number;
}
const OAUTH_SESSION_TTL_MS = 10 * 60_000;

export class Engine {
  private readonly db: Db;
  private readonly sandbox: SandboxClient;
  private readonly opts: EngineOptions;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  /** In-process abort registry: aborting drops the shared stream and interrupts the sandbox conversation. */
  private readonly turnAborts = new Map<string, AbortController>();
  private readonly oauth: OAuthClient;
  /** Sign-ins in flight. Short-lived by design: an abandoned one just expires. */
  private readonly oauthSessions = new Map<string, OAuthSession>();

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.sandbox = opts.sandbox;
    // Kimi wants a stable device id per client; one per optibox instance, never per process.
    this.oauth = opts.oauth ?? new OAuthClient({ kimiDeviceId: createHash("sha256").update(`kimi-device:${opts.instanceId}:${opts.credHash}`).digest("hex").slice(0, 32) });
    if (!opts.sharedStream && !opts.sharedModel && !opts.sharedModelForEnv) throw new Error("Engine requires sharedModel (\"<provider>/<model>\") or sharedStream");
    const ms = opts.sweepIntervalMs ?? 5_000;
    if (ms > 0) {
      this.sweeper = setInterval(() => { void this.sweep().catch((e) => console.error("[engine] sweep failed:", e)); }, ms);
      this.sweeper.unref?.();
    }
  }

  dispose(): void { if (this.sweeper) clearInterval(this.sweeper); }

  // ---------------------------------------------------------------- identity

  /** Full user key: fingerprint user + the Boat account hash (account isolation). */
  userKey(userId: string): string { return `${userId}-${this.opts.credHash}`; }
  private sandboxName(userKey: string): string { return `optibox-${this.opts.instanceId}-user-${userKey}`; }
  private convKey(userKey: string, conversationId: string): string { return `${userKey}:${conversationId}`; }

  // ---------------------------------------------------------------- per-user Agents setup

  /**
   * A user's own Agents row. Every sandbox this engine brings up for them runs on
   * THEIR keys (`provider_env`) and carries THEIR secret files (`agent_files`);
   * the engine's own `providerEnv` is only the fallback for a user who has set
   * nothing. Reads never write, so this is safe on every turn.
   */
  private async userAgentsRow(userId: string): Promise<UserAgentsRow> {
    const row = await this.db.one<{ provider_env: Record<string, string> | null; agent_files: Record<string, string> | null; agent_selection: UserAgentSelection | null; env_pending: boolean | null; agent_oauth: AgentOAuthState | null }>(
      `select provider_env, agent_files, agent_selection, env_pending, agent_oauth from users where key=$1`, [this.userKey(userId)],
    );
    return {
      providerEnv: row?.provider_env ?? {},
      agentFiles: row?.agent_files ?? {},
      selection: row?.agent_selection ?? {},
      envPending: Boolean(row?.env_pending),
      oauth: row?.agent_oauth ?? {},
    };
  }

  /**
   * The environment the user's sandbox runs on: their keys when they have any, else
   * the server's. Every bring-up goes through here, which is exactly where an
   * expiring subscription token is renewed, so a sandbox never starts on a dead one.
   */
  async userProviderEnv(userId: string): Promise<Record<string, string>> {
    await this.refreshSubscriptions(userId);
    const own = (await this.userAgentsRow(userId)).providerEnv;
    return Object.keys(own).length ? { ...own } : { ...(this.opts.providerEnv ?? {}) };
  }

  /**
   * Spend a stored refresh token for any subscription whose access token is
   * about to expire, and write the new one back where the sandbox reads it. A
   * failure is silent on purpose: the old token stays and the harness reports
   * the expiry itself, which beats blocking the machine from starting.
   */
  private async refreshSubscriptions(userId: string): Promise<void> {
    const row = await this.userAgentsRow(userId);
    let providerEnv = row.providerEnv;
    let agentFiles = row.agentFiles;
    const oauth: AgentOAuthState = { ...row.oauth };
    let changed = false;
    for (const provider of ["claude", "codex", "kimi"] as OAuthProvider[]) {
      const record = oauth[provider];
      const spec = subscriptionSpec(provider);
      const live = spec.env ? providerEnv[spec.env] : agentFiles[spec.file as string];
      if (!record?.refreshToken || !live || !tokenIsStale(record.expiresAt)) continue;
      try {
        const tokens = provider === "claude"
          ? await this.oauth.refreshClaude(record.refreshToken)
          : provider === "kimi"
            ? await this.oauth.refreshKimi(record.refreshToken)
            : await this.oauth.refreshCodex(record.refreshToken);
        const accountId = tokens.accountId ?? record.accountId;
        const next = subscriptionCredentials(provider, { ...tokens, ...(accountId ? { accountId } : {}) });
        providerEnv = applyPatch(providerEnv, next.providerEnv);
        agentFiles = applyPatch(agentFiles, next.agentFiles);
        oauth[provider] = {
          ...record,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          expiresAt: tokens.expiresAt,
          ...(accountId ? { accountId } : {}),
        };
        changed = true;
      } catch { /* keep what we have; the harness will report the expiry */ }
    }
    if (!changed) return;
    await this.db.q(
      `update users set provider_env=$2, agent_files=$3, agent_oauth=$4 where key=$1`,
      [this.userKey(userId), JSON.stringify(providerEnv), JSON.stringify(agentFiles), JSON.stringify(oauth)],
    );
  }

  /** What the settings panel shows: selection + which credentials are connected. NEVER a secret. */
  async getUserAgents(userId: string): Promise<UserAgentsView> {
    const row = await this.userAgentsRow(userId);
    return {
      selection: row.selection,
      credentials: agentCredentialStates(row.providerEnv, row.agentFiles, row.oauth),
      usingOwnKeys: Object.keys(row.providerEnv).length > 0 || Object.keys(row.agentFiles).length > 0,
      envPending: row.envPending,
    };
  }

  /**
   * Save a user's Agents setup and make the sandbox match it.
   *
   * Keys reach a no-env sandbox exactly one way: as the sandbox's `env`, at create or at
   * resume (a resume body's env REPLACES the stored one and the sandbox keeps it
   * across later stop/resume). So a LIVE sandbox is stopped — billing ends exactly
   * as a manual stop — and resumed with the new env; a PARKED sandbox only records
   * `env_pending`, and the next wake in ensureUserSandbox carries the env.
   *
   * Secret FILES cannot ride the env: a no-env sandbox's resume scrubs owner secrets
   * off its disk, which unlinks ~/.codex/auth.json with them, so they are
   * rewritten after every bring-up (here, and in ensureUserSandbox).
   */
  async setUserAgents(
    userId: string,
    patch: { providerEnv?: Record<string, string>; agentFiles?: Record<string, string>; selection?: UserAgentSelection; oauth?: AgentOAuthState },
    opts: { conversationId?: string } = {},
  ): Promise<{ applied: "now" | "next-start" | "none"; sandboxId?: string }> {
    const key = this.userKey(userId);
    await this.db.q(`insert into users(key) values($1) on conflict do nothing`, [key]);
    const before = await this.userAgentsRow(userId);
    const providerEnv = applyPatch(before.providerEnv, patch.providerEnv);
    const agentFiles = applyPatch(before.agentFiles, patch.agentFiles);
    const selection: UserAgentSelection = { ...before.selection };
    for (const [k, v] of Object.entries(patch.selection ?? {})) {
      if (typeof v !== "string") continue;
      if (v) (selection as Record<string, string>)[k] = v; else delete (selection as Record<string, string>)[k];
    }
    // The refresh half of a subscription follows its access token: connect
    // stores it, and a credential that is no longer on the sandbox loses it, so
    // "Disconnect" through any path leaves nothing behind.
    const oauth: AgentOAuthState = { ...before.oauth, ...(patch.oauth ?? {}) };
    for (const spec of AGENT_CREDENTIALS) {
      if (!spec.oauth) continue;
      const value = spec.env ? providerEnv[spec.env] : agentFiles[spec.file as string];
      if (!value) delete oauth[spec.oauth];
    }
    const credentialsChanged = !sameMap(providerEnv, before.providerEnv) || !sameMap(agentFiles, before.agentFiles);
    await this.db.q(
      `update users set provider_env=$2, agent_selection=$4, agent_files=$3, agent_oauth=$5 where key=$1`,
      [key, JSON.stringify(providerEnv), JSON.stringify(agentFiles), JSON.stringify(selection), JSON.stringify(oauth)],
    );
    if (!credentialsChanged) return { applied: "none" };

    return this.db.withLock("user", key, async () => {
      const row = await this.db.one<{ id: string }>(
        `select id from sandboxes where user_key=$1 and purpose='user' and retired_at is null`, [key],
      );
      // No machine yet: the create call will carry the new keys as its env.
      if (!row) { await this.db.q(`update users set env_pending=false where key=$1`, [key]); return { applied: "next-start" }; }
      const info = await this.sandbox.get(row.id).catch(() => undefined);
      const state = String(info?.state ?? "error");
      const live = Boolean(info) && !["error", "deleted", "archived", "stopped", "archiving", "stopping"].includes(state);
      if (!live) {
        await this.db.q(`update users set env_pending=true where key=$1`, [key]);
        return { applied: "next-start", sandboxId: row.id };
      }
      await this.endBilling(row.id);
      await this.sandbox.stop(row.id).catch(() => undefined);
      await this.waitUntilParked(row.id);
      await this.sandbox.resume(row.id, { env: await this.userProviderEnv(userId) });
      const ready = await this.waitUntilReady(row.id);
      await this.writeAgentFiles(row.id, userId);
      await this.db.q(`update users set env_pending=false where key=$1`, [key]);
      await this.wake(userId, "agents");
      if (opts.conversationId) {
        await this.logEvent(userId, opts.conversationId, null, {
          type: "lifecycle", sandboxId: row.id, state: ready.state,
          note: "your agent credentials were applied: the private machine restarted with them",
        }).catch(() => undefined);
      }
      return { applied: "now", sandboxId: row.id };
    });
  }

  // ------------------------------------------------- subscription sign-ins

  /**
   * Step 1 of a sign-in. Claude hands back a page to approve; ChatGPT and Kimi
   * hand back a short code and the page to confirm it on. Either way the
   * session id is what the browser carries into step 2.
   */
  async startAgentOAuth(userId: string, provider: OAuthProvider): Promise<AgentOAuthStart> {
    const now = Date.now();
    for (const [id, s] of this.oauthSessions) if (s.expiresAt <= now) this.oauthSessions.delete(id);
    const sessionId = randomUUID();
    const expiresAt = now + OAUTH_SESSION_TTL_MS;
    if (provider === "claude") {
      const { url, verifier } = this.oauth.startClaude();
      this.oauthSessions.set(sessionId, { provider, userId, verifier, expiresAt });
      return { sessionId, provider, url };
    }
    const device = provider === "kimi" ? await this.oauth.startKimiDevice() : await this.oauth.startCodexDevice();
    this.oauthSessions.set(sessionId, { provider, userId, deviceAuthId: device.deviceAuthId, userCode: device.userCode, expiresAt });
    return { sessionId, provider, url: device.verificationUrl, userCode: device.userCode, interval: device.interval };
  }

  /**
   * Step 2. Claude needs the code the user pasted; ChatGPT and Kimi need
   * nothing and are called on a timer until they stop answering "pending".
   * Connecting applies the subscription to the user's sandbox through the SAME
   * path a typed key takes, so a live sandbox restarts on it and a parked one
   * picks it up next.
   */
  async completeAgentOAuth(
    userId: string,
    sessionId: string,
    code?: string,
    opts: { conversationId?: string } = {},
  ): Promise<AgentOAuthResult> {
    const session = this.oauthSessions.get(sessionId);
    if (!session || session.userId !== userId || session.expiresAt <= Date.now()) {
      this.oauthSessions.delete(sessionId);
      throw new Error("that sign-in expired, start it again");
    }
    if (session.provider === "claude") {
      const pasted = (code ?? "").trim();
      if (!pasted) return { status: "pending" };
      const tokens = await this.oauth.exchangeClaude(pasted, session.verifier as string);
      this.oauthSessions.delete(sessionId);
      return this.connectSubscription(userId, "claude", tokens, opts);
    }
    let poll: DevicePoll;
    try {
      poll = session.provider === "kimi"
        ? await this.oauth.pollKimiDevice(session.deviceAuthId as string)
        : await this.oauth.pollCodexDevice(session.deviceAuthId as string, session.userCode as string);
    } catch (e) {
      // An expired device code is final: drop the session so the browser starts a fresh one.
      this.oauthSessions.delete(sessionId);
      throw e;
    }
    if (poll.status === "pending") return { status: "pending" };
    this.oauthSessions.delete(sessionId);
    return this.connectSubscription(userId, session.provider, poll.tokens, opts);
  }

  private async connectSubscription(
    userId: string,
    provider: OAuthProvider,
    tokens: OAuthTokens,
    opts: { conversationId?: string },
  ): Promise<AgentOAuthResult> {
    const creds = subscriptionCredentials(provider, tokens);
    const applied = await this.setUserAgents(userId, {
      providerEnv: creds.providerEnv,
      agentFiles: creds.agentFiles,
      oauth: {
        [provider]: {
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          expiresAt: tokens.expiresAt,
          ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
          connectedAt: Date.now(),
        },
      },
    }, opts);
    return { status: "connected", ...applied };
  }

  /** Disconnect: everything the subscription put on the sandbox, and its refresh token. */
  async disconnectSubscription(
    userId: string,
    provider: OAuthProvider,
    opts: { conversationId?: string } = {},
  ): Promise<{ applied: "now" | "next-start" | "none"; sandboxId?: string }> {
    return this.setUserAgents(userId, subscriptionClear(provider), opts);
  }

  /**
   * Write the user's secret files into the sandbox. Run after EVERY bring-up: a
   * no-env sandbox scrubs owner secrets at /start, and that scrub deletes the same
   * paths a user's own file lands on (~/.codex/auth.json).
   */
  private async writeAgentFiles(sandboxId: string, userId: string): Promise<string[]> {
    const files = (await this.userAgentsRow(userId)).agentFiles;
    const paths = Object.keys(files).filter((p) => p && typeof files[p] === "string" && (files[p] as string).length);
    if (!paths.length) return [];
    const dirs = [...new Set(paths.map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")).filter(Boolean))];
    // A files-API PUT into a not-yet-existing directory can answer 200 without
    // ever hitting disk, so the parents are created with a command first.
    if (dirs.length) {
      await this.sandbox.command(sandboxId, { command: `mkdir -p ${dirs.map((d) => `'${d.replace(/'/g, `'\\''`)}'`).join(" ")}`, timeoutMs: 20_000 }).catch(() => undefined);
    }
    for (const p of paths) await this.sandbox.writeFile(sandboxId, p, files[p] as string);
    return paths;
  }

  /** The composer's per-message choice wins; anything it omits falls back to the user's default. */
  private async resolveSelection(userId: string, given: Partial<HarnessSelection> = {}): Promise<HarnessSelection> {
    const stored = (await this.userAgentsRow(userId)).selection;
    const pick = (a?: string, b?: string): string => (a && a.trim() ? a : b && b.trim() ? b : "");
    const reasoningEffort = pick(given.reasoningEffort, stored.reasoningEffort);
    return {
      harness: pick(given.harness, stored.harness),
      provider: pick(given.provider, stored.provider),
      model: pick(given.model, stored.model),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(typeof given.fast === "boolean" ? { fast: given.fast } : {}),
    };
  }

  /**
   * The bridge runs on the user's own keys when they have them, the server's otherwise.
   * It renews an expiring subscription first, exactly as a sandbox bring-up does: a Kimi access
   * token lives 15 minutes, and a stale one made the instant answer fail so the user waited
   * the sandbox's full turn with nothing on screen.
   */
  private async sharedStreamFor(userId: string): Promise<SharedStream> {
    if (this.opts.sharedStream) return this.opts.sharedStream;
    await this.refreshSubscriptions(userId);
    const env = { ...(this.opts.providerEnv ?? {}), ...(await this.userAgentsRow(userId)).providerEnv };
    const model = this.opts.sharedModelForEnv?.(env) ?? (this.opts.sharedModel as string);
    return directProviderStream(env, model);
  }

  // ---------------------------------------------------------------- billing

  /** THE wake path: sets billing_since if not billing, bumps activity. */
  async wake(userId: string, reason: string): Promise<void> {
    const key = this.userKey(userId);
    await this.db.q(`insert into users(key) values($1) on conflict(key) do update set last_activity_at=now()`, [key]);
    await this.db.q(
      `update sandboxes set billing_since=coalesce(billing_since, now()), billing_reason=coalesce(billing_reason,$2)
       where user_key=$1 and purpose='user' and retired_at is null`,
      [key, reason],
    );
  }

  /** THE one way billing ends: atomically folds elapsed into the user total (pre-image selected FOR UPDATE). */
  private async endBilling(sandboxId: string): Promise<number> {
    const row = await this.db.one<{ elapsed: number }>(
      `with old as (select id, user_key, billing_since from sandboxes where id=$1 and billing_since is not null for update),
       ended as (update sandboxes b set billing_since=null, billing_reason=null from old where b.id = old.id
                 returning old.user_key, extract(epoch from now() - old.billing_since) as elapsed)
       update users u set billed_seconds = u.billed_seconds + ended.elapsed from ended where u.key = ended.user_key
       returning ended.elapsed`,
      [sandboxId],
    );
    return Number(row?.elapsed ?? 0);
  }

  private async bumpActivity(userId: string): Promise<void> {
    await this.db.q(`update users set last_activity_at=now() where key=$1`, [this.userKey(userId)]);
  }

  // ---------------------------------------------------------------- holds

  /** Keep-alive hold with TTL; returns a release fn. Rows, not memory. */
  holdUserSandbox(userId: string, reason: string, ttlMs = 10 * 60_000): () => void {
    const key = this.userKey(userId);
    void this.db.q(`insert into users(key) values($1) on conflict do nothing`, [key]).then(() => this.db.q(
      `insert into holds(user_key, reason, expires_at) values($1,$2,now()+($3||' milliseconds')::interval)
       on conflict(user_key, reason) do update set expires_at=excluded.expires_at`,
      [key, reason, String(ttlMs)],
    )).catch((e) => console.error("[engine] hold write failed:", e.message));
    return () => { void this.db.q(`delete from holds where user_key=$1 and reason=$2`, [key, reason]).catch(() => undefined); };
  }

  // ---------------------------------------------------------------- sandbox lifecycle

  async activeUserSandboxId(userId: string): Promise<string | undefined> {
    const row = await this.db.one<{ id: string }>(
      `select id from sandboxes where user_key=$1 and purpose='user' and retired_at is null`, [this.userKey(userId)],
    );
    return row?.id;
  }

  /** ONE user = ONE sandbox, mechanically: user advisory lock + the unique index. */
  async ensureUserSandbox(userId: string, _conversationId: string, events?: EventQueue): Promise<SandboxInfo> {
    const key = this.userKey(userId);
    return this.db.withLock("user", key, async () => {
      await this.db.q(`insert into users(key) values($1) on conflict do nothing`, [key]);
      const existing = await this.db.one<{ id: string }>(
        `select id from sandboxes where user_key=$1 and purpose='user' and retired_at is null`, [key],
      );
      if (existing) {
        const info = await this.sandbox.get(existing.id).catch(() => undefined);
        const state = String(info?.state ?? "error");
        if (info && !["error", "deleted"].includes(state)) {
          if (["archived", "stopped"].includes(state)) {
            events?.push({ type: "lifecycle", sandboxId: info.id, state: "resuming", note: "resuming private sandbox from disk snapshot" });
            await this.resumeWithUserEnv(userId, info.id, events);
            await this.wake(userId, "resume");
            // Boat queues a prompt on a sandbox that is still resuming and delivers it the
            // moment the agent is up, so waiting here only adds polling time. The one thing
            // that must land BEFORE the prompt is the user's credential files.
            if (!(await this.hasAgentFiles(userId))) {
              events?.push({ type: "lifecycle", sandboxId: info.id, state: "resuming", note: "prompt sent while the sandbox resumes; Boat delivers it as soon as it is up" });
              return { ...info, state: "resuming" };
            }
            const ready = await this.waitUntilReady(info.id);
            await this.afterBringUp(userId, info.id, events);
            events?.push({ type: "lifecycle", sandboxId: info.id, state: ready.state, note: "private sandbox resumed from snapshot — no cold start" });
            return ready;
          }
          if (state === "archiving" || state === "stopping") {
            events?.push({ type: "lifecycle", sandboxId: info.id, state, note: "waiting out in-flight archive before resume" });
            await this.waitUntilParked(info.id);
            await this.resumeWithUserEnv(userId, info.id, events);
            const ready = await this.waitUntilReady(info.id);
            await this.afterBringUp(userId, info.id, events);
            await this.wake(userId, "resume");
            return ready;
          }
          const ready = await this.waitUntilReady(info.id);
          await this.wake(userId, "adopt");
          return ready;
        }
        events?.push({ type: "lifecycle", sandboxId: existing.id, state: "error", note: "previous sandbox is terminal; retiring it and provisioning a fresh one" });
        await this.db.q(`update sandboxes set retired_at=now(), billing_since=null where id=$1`, [existing.id]);
      }
      // Fresh machine: no owner secrets, only the user's provider keys; the
      // harnesses come with the sandbox, and read the standing rules from home.
      const env = await this.userProviderEnv(userId);
      const created = await this.sandbox.create({ name: this.sandboxName(key), ttlSeconds: this.opts.userSandboxTtlSeconds ?? 900, noEnv: true, ...(Object.keys(env).length ? { env } : {}) });
      await this.db.q(`insert into sandboxes(id, user_key, instance_id, purpose) values($1,$2,$3,'user')`, [created.id, key, this.opts.instanceId]);
      await this.db.q(`update users set env_pending=false where key=$1`, [key]);
      events?.push({ type: "lifecycle", sandboxId: created.id, state: "starting", note: "creating fresh private sandbox" });
      const ready = await this.waitUntilReady(created.id);
      const rules = sandboxRules();
      await Promise.all(["AGENTS.md", "CLAUDE.md"].map((f) => this.sandbox.writeFile(created.id, f, rules)));
      await this.afterBringUp(userId, created.id, events);
      await this.wake(userId, "boot");
      return ready;
    });
  }

  /**
   * Resume, carrying the user's env when they changed keys while the sandbox was
   * parked. Passing env REPLACES the sandbox's stored environment; omitting it keeps
   * what the sandbox already has, so a normal wake stays a plain resume.
   */
  private async resumeWithUserEnv(userId: string, sandboxId: string, events?: EventQueue): Promise<void> {
    if (!(await this.userAgentsRow(userId)).envPending) { await this.sandbox.resume(sandboxId); return; }
    events?.push({ type: "lifecycle", sandboxId, state: "resuming", note: "applying your saved agent credentials to this machine" });
    await this.sandbox.resume(sandboxId, { env: await this.userProviderEnv(userId) });
    await this.db.q(`update users set env_pending=false where key=$1`, [this.userKey(userId)]);
  }

  private async hasAgentFiles(userId: string): Promise<boolean> {
    const files = (await this.userAgentsRow(userId)).agentFiles;
    return Object.values(files).some((v) => typeof v === "string" && v.length > 0);
  }

  /** Every bring-up ends the same way: the user's secret files land before any prompt. */
  private async afterBringUp(userId: string, sandboxId: string, events?: EventQueue): Promise<void> {
    const written = await this.writeAgentFiles(sandboxId, userId).catch(() => [] as string[]);
    if (written.length) events?.push({ type: "lifecycle", sandboxId, state: "ready", note: `restored your agent credential files (${written.join(", ")})` });
  }

  private async waitUntilReady(sandboxId: string): Promise<SandboxInfo> {
    const pollMs = this.opts.readinessPollMs ?? 250;
    const deadline = Date.now() + (this.opts.handoffTimeoutMs ?? 120_000);
    // Readiness = the sandbox executes a command (state strings lag reality badly).
    while (Date.now() < deadline) {
      try {
        const r = await this.sandbox.command(sandboxId, { command: "echo __UP__", timeoutMs: 10_000 });
        if (r.stdout.includes("__UP__")) return await this.sandbox.get(sandboxId);
      } catch { /* still booting */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`sandbox ${sandboxId} did not become ready within the handoff window`);
  }

  private async waitUntilParked(sandboxId: string): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const info = await this.sandbox.get(sandboxId).catch(() => undefined);
      if (!info || ["archived", "stopped"].includes(String(info.state))) return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  /** Manual/auto stop: billing ends at stop REQUEST; stream the lifecycle. */
  async *stopUserSandbox(userId: string, _conversationId: string): AsyncIterable<ConsumerTurnEvent> {
    const key = this.userKey(userId);
    const turnId = randomUUID();
    const row = await this.db.one<{ id: string }>(`select id from sandboxes where user_key=$1 and purpose='user' and retired_at is null`, [key]);
    if (!row) { yield { type: "lifecycle", sandboxId: "", state: "none", note: "no active user sandbox to stop", turnId }; return; }
    const events = await this.db.withLock("user", key, async () => {
      const out: EventBody[] = [{ type: "lifecycle", sandboxId: row.id, state: "stopping", note: "requesting stop (snapshot + pause billing)" }];
      const elapsed = await this.endBilling(row.id);
      out.push({ type: "billing.stop", sandboxId: row.id, elapsedSeconds: elapsed, costUsd: elapsed * SANDBOX_PRICE_USD_PER_SECOND, note: "billing PAUSED — you pay $0 while the sandbox is stopped" });
      await this.sandbox.stop(row.id).catch(() => undefined);
      out.push({ type: "lifecycle", sandboxId: row.id, state: "archiving", note: "snapshotting disk & archiving" });
      return out;
    });
    for (const e of events) yield { ...e, turnId } as ConsumerTurnEvent;
    await this.waitUntilParked(row.id);
    yield { type: "lifecycle", sandboxId: row.id, state: "archived", note: "archived — disk snapshot kept, resumes with no cold start", turnId };
  }

  /** Full user reset: stop+delete every sandbox the user had under this credential set, erase all rows. */
  async resetUser(userId: string): Promise<{ ok: true; sandboxesDeleted: number }> {
    const key = this.userKey(userId);
    return this.db.withLock("user", key, async () => {
      const rows = await this.db.q<{ id: string }>(`select id from sandboxes where user_key=$1`, [key]);
      for (const r of rows) {
        await this.endBilling(r.id).catch(() => undefined);
        await this.sandbox.stop(r.id).catch(() => undefined);
        await this.sandbox.deleteSandbox?.(r.id)?.catch(() => undefined);
      }
      for (const table of ["hosting", "holds", "turns", "transcripts", "events", "conversations", "sandboxes"]) {
        await this.db.q(`delete from ${table} where user_key=$1`, [key]);
      }
      await this.db.q(`delete from users where key=$1`, [key]);
      return { ok: true as const, sandboxesDeleted: rows.length };
    });
  }

  // ---------------------------------------------------------------- sweeper (rule 4)

  /** Rule 4 as a query: stop every billing sandbox whose user is idle past the window, plus an absolute ceiling. */
  private async sweep(): Promise<void> {
    await this.db.q(`insert into instances(id) values($1) on conflict(id) do update set heartbeat_at=now()`, [this.opts.instanceId]);
    await this.db.q(`delete from holds where expires_at <= now()`);
    const idleMs = this.opts.autoStopIdleMs ?? 15_000;
    const ceilingMs = this.opts.maxBillingAgeMs ?? 30 * 60_000;
    const idleSql = `( b.billing_since < now() - ($3||' milliseconds')::interval
                       or ( u.last_activity_at < now() - ($2||' milliseconds')::interval
                            and not exists (select 1 from turns t where t.user_key = b.user_key and t.status='active')
                            and not exists (select 1 from holds hh where hh.user_key = b.user_key and hh.expires_at > now()) ) )`;
    const rows = await this.db.q<{ id: string; user_key: string }>(
      `select b.id, b.user_key from sandboxes b join users u on u.key = b.user_key
        where b.instance_id = $1 and b.user_key like $4 and b.purpose = 'user' and b.retired_at is null and b.billing_since is not null
          and not exists (select 1 from hosting h where h.user_key = b.user_key and h.stop_requested_at is null)
          and ${idleSql}`,
      [this.opts.instanceId, String(idleMs), String(ceilingMs), `%-${this.opts.credHash}`],
    );
    for (const r of rows) {
      await this.db.withLock("user", r.user_key, async () => {
        // Re-check under the lock; a turn may have started meanwhile.
        const still = await this.db.one(
          `select 1 from sandboxes b join users u on u.key=b.user_key where b.id=$1 and b.billing_since is not null and ${idleSql}`,
          [r.id, String(idleMs), String(ceilingMs)],
        );
        if (!still) return;
        await this.endBilling(r.id);
        await this.sandbox.stop(r.id).catch(() => undefined);
      });
    }
  }

  // ---------------------------------------------------------------- hosting

  private async markHosting(userId: string, conversationId: string, sandboxId: string, port: number, mode: "public" | "private"): Promise<void> {
    const key = this.userKey(userId);
    await this.db.q(
      `insert into hosting(user_key, port, conversation_id, sandbox_id, mode) values($1,$2,$3,$4,$5)
       on conflict(user_key, port) do update set sandbox_id=excluded.sandbox_id, mode=excluded.mode, conversation_id=excluded.conversation_id, stop_requested_at=null, misses=0`,
      [key, port, conversationId, sandboxId, mode],
    );
    // The platform archives at its own TTL regardless of our holds; push it out.
    void this.sandbox.update(sandboxId, { ttlSeconds: 7 * 24 * 3600 }).catch(() => undefined);
    void this.sandbox.get(sandboxId).then(async (b) => {
      const m = String(b.url ?? "").match(/^https:[/][/]([^.]+)[.](.+)$/);
      if (m) await this.db.q(`update hosting set url=$3 where user_key=$1 and port=$2`, [key, port, `https://${m[1]}-${port}.${m[2]}`]);
    }).catch(() => undefined);
  }

  /** Ground truth from the sandbox (rides the fs poll): observed host processes. */
  async reconcileObservedHosting(userId: string, sandboxId: string, observed: Array<{ port: number; mode: "public" | "private" }>, opts: { sandboxLive?: boolean } = {}): Promise<void> {
    const key = this.userKey(userId);
    for (const o of observed) {
      const row = await this.db.one<{ stop_requested_at: string | null; conversation_id: string }>(
        `select stop_requested_at, conversation_id from hosting where user_key=$1 and port=$2`, [key, o.port],
      );
      if (row?.stop_requested_at) {
        // Durable stop intent: kill on sight instead of resurrecting the banner.
        void this.sandbox.command(sandboxId, { command: hostingKillCommand(o.port), timeoutMs: 20_000 }).catch(() => undefined);
        continue;
      }
      await this.markHosting(userId, row?.conversation_id ?? "unknown", sandboxId, o.port, o.mode);
    }
    if (opts.sandboxLive === false) return; // can't disprove hosting on a parked sandbox
    await this.db.q(
      `update hosting set misses = misses + 1 where user_key=$1 and stop_requested_at is null and not (port = any($2::int[]))`,
      [key, observed.map((o) => o.port)],
    );
    await this.db.q(`delete from hosting where user_key=$1 and (misses >= 2 or (stop_requested_at is not null and stop_requested_at < now() - interval '10 minutes'))`, [key]);
  }

  async stopHosting(userId: string, port?: number): Promise<{ stopped: boolean; ports: number[] }> {
    const key = this.userKey(userId);
    const rows = await this.db.q<{ port: number; sandbox_id: string }>(
      `update hosting set stop_requested_at=now() where user_key=$1 and ($2::int is null or port=$2) and stop_requested_at is null returning port, sandbox_id`,
      [key, port ?? null],
    );
    await this.bumpActivity(userId);
    for (const r of rows) {
      try { await this.sandbox.command(r.sandbox_id, { command: hostingKillCommand(r.port), timeoutMs: 20_000 }); }
      catch { /* parked sandbox: the durable intent + reconcile handle it */ }
    }
    return { stopped: rows.length > 0, ports: rows.map((r) => r.port) };
  }

  // ---------------------------------------------------------------- runtime snapshot

  /** ONE query powers every counter in the UI. */
  async userRuntimeStatus(userId: string): Promise<{
    sandboxId?: string; billingSinceEpochMs: number | null; billedSecondsTotal: number; holds: string[]; activeTurn: boolean;
    idleStopEtaEpochMs: number | null; idleStopMs: number;
    hosting: Array<{ port: number; mode: string; url: string | null; conversationId: string; sinceEpochMs: number }>;
  }> {
    const key = this.userKey(userId);
    const idleStopMs = this.opts.autoStopIdleMs ?? 15_000;
    const row = await this.db.one<{ sandbox_id: string | null; billing_since: string | null; billed_seconds: number | null; last_activity_at: string | null; active_turns: number; holds: string[] | null }>(
      `select b.id as sandbox_id, b.billing_since, u.billed_seconds, u.last_activity_at,
              (select count(*)::int from turns t where t.user_key=$1 and t.status='active') as active_turns,
              (select array_agg(reason) from holds h where h.user_key=$1 and h.expires_at > now()) as holds
         from users u left join sandboxes b on b.user_key=u.key and b.purpose='user' and b.retired_at is null
        where u.key=$1`,
      [key],
    );
    const hosting = await this.db.q<{ port: number; mode: string; url: string | null; conversation_id: string; started_at: string }>(
      `select port, mode, url, conversation_id, started_at from hosting where user_key=$1 and stop_requested_at is null order by port`, [key],
    );
    const holds = [...(row?.holds ?? [])];
    if (hosting.length) holds.push(`hosting ${hosting.map((h) => `:${h.port}`).join(" ")}`);
    const billingSince = row?.billing_since ? Date.parse(row.billing_since) : null;
    const activeTurn = (row?.active_turns ?? 0) > 0;
    const lastActivity = row?.last_activity_at ? Date.parse(row.last_activity_at) : Date.now();
    return {
      ...(row?.sandbox_id ? { sandboxId: row.sandbox_id } : {}),
      billingSinceEpochMs: billingSince,
      billedSecondsTotal: Number(row?.billed_seconds ?? 0),
      holds, activeTurn,
      idleStopEtaEpochMs: billingSince !== null && !activeTurn && holds.length === 0 ? Math.max(Date.now(), lastActivity + idleStopMs) : null,
      idleStopMs,
      hosting: hosting.map((h) => ({ port: h.port, mode: h.mode, url: h.url, conversationId: h.conversation_id, sinceEpochMs: Date.parse(h.started_at) })),
    };
  }

  // ---------------------------------------------------------------- desktop recording

  /** Sandbox-side screen recording of :0, detached via setsid; SIGINT lets ffmpeg flush a playable mp4. */
  private async startDesktopRecording(sandboxId: string, turnId: string): Promise<void> {
    const out = `/home/user/recordings/${turnId}.mp4`, pid = `/home/user/recordings/${turnId}.pid`;
    await this.sandbox.command(sandboxId, {
      command:
        `mkdir -p /home/user/recordings && setsid bash -c 'for i in $(seq 1 30); do [ -S /tmp/.X11-unix/X0 ] && break; sleep 0.5; done; ` +
        `DISPLAY=:0 XAUTHORITY=/var/run/lightdm/root/:0 ffmpeg -y -loglevel error -f x11grab -r 12 -draw_mouse 1 -i :0 -pix_fmt yuv420p -movflags +faststart ${out} ` +
        `>/tmp/rec-${turnId}.log 2>&1 & echo $! > ${pid}'`,
      timeoutMs: 20_000,
    });
  }

  private async stopDesktopRecording(sandboxId: string, turnId: string): Promise<{ ok: boolean; sizeKb: number }> {
    const out = `/home/user/recordings/${turnId}.mp4`, pid = `/home/user/recordings/${turnId}.pid`;
    const r = await this.sandbox.command(sandboxId, {
      command:
        `P=$(cat ${pid} 2>/dev/null); if [ -n "$P" ]; then kill -INT "$P" 2>/dev/null; for i in $(seq 1 75); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done; fi; rm -f ${pid}; ` +
        `if [ -s ${out} ]; then echo "OK:$(( $(stat -c%s ${out}) / 1024 ))"; else echo NONE; fi`,
      timeoutMs: 30_000,
    });
    const m = (r.stdout || "").match(/OK:(\d+)/);
    return m ? { ok: true, sizeKb: Number(m[1]) } : { ok: false, sizeKb: 0 };
  }

  // ---------------------------------------------------------------- render journal + transcript

  async logEvent(userId: string, conversationId: string, turnId: string | null, body: unknown): Promise<void> {
    await this.db.q(`insert into events(user_key, conversation_id, turn_id, body) values($1,$2,$3,$4)`, [this.userKey(userId), conversationId, turnId, JSON.stringify(body)]);
  }

  async getEvents(userId: string, conversationId: string, sinceSeq = 0): Promise<Array<{ seq: number; body: unknown }>> {
    const rows = await this.db.q<{ seq: string; body: unknown }>(
      `select seq, body from events where user_key=$1 and conversation_id=$2 and seq > $3 order by seq`, [this.userKey(userId), conversationId, sinceSeq],
    );
    return rows.map((r) => ({ seq: Number(r.seq), body: r.body }));
  }

  async getTranscript(userId: string, conversationId: string): Promise<TranscriptMessage[]> {
    const rows = await this.db.q<{ role: string; content: string; mode: string | null; at: string }>(
      `select role, content, mode, at from transcripts where user_key=$1 and conversation_id=$2 and scenario_id is null order by seq`, [this.userKey(userId), conversationId],
    );
    return rows.map((r) => {
      const msg: TranscriptMessage = { role: r.role as TranscriptMessage["role"], content: r.content, at: r.at };
      if (r.mode === "shared" || r.mode === "handoff" || r.mode === "user-sandbox") msg.mode = r.mode;
      return msg;
    });
  }

  /** Stop one turn: drops its shared stream; its sandbox round interrupts ONLY its own sandbox conversation. */
  interrupt(turnId: string): boolean {
    const ac = this.turnAborts.get(turnId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  // ---------------------------------------------------------------- the turn (rules 1/2/3/5/6)

  async *runTurn(input: ConsumerTurnInput): AsyncIterable<ConsumerTurnEvent> {
    const turnId = randomUUID();
    const userKey = this.userKey(input.userId);
    const convKey = this.convKey(userKey, input.conversationId);
    // The composer's choice wins per message; anything it omits is the user's
    // own Agents default (harness / model / reasoning level).
    const selection = await this.resolveSelection(input.userId, input.selection);
    const turn: ResolvedTurnInput = { ...input, selection };
    const { harness, model } = selection;
    const abort = new AbortController();
    this.turnAborts.set(turnId, abort);
    const emit = (e: EventBody): ConsumerTurnEvent => ({ ...e, turnId } as ConsumerTurnEvent);
    if (!harness) {
      yield emit({ type: "turn.blocked", stage: "selection.missing", message: "no harness selected: choose one in the Agents panel", retryable: false });
      this.turnAborts.delete(turnId);
      return;
    }
    try {
      await this.db.q(`insert into users(key) values($1) on conflict(key) do update set last_activity_at=now()`, [userKey]);
      await this.db.q(`insert into conversations(user_key, id) values($1,$2) on conflict do nothing`, [userKey, input.conversationId]);
      await this.db.q(`insert into transcripts(user_key, conversation_id, role, content) values($1,$2,'user',$3)`, [userKey, input.conversationId, input.message]);
      const fingerprint = fingerprintOf(input.message);
      const dup = await this.db.one<{ id: string }>(
        `select id from turns where user_key=$1 and conversation_id=$2 and fingerprint=$3
          and (status='active' or (status='answered' and done_at > now() - interval '60 seconds'))`,
        [userKey, input.conversationId, fingerprint],
      );
      await this.db.q(`insert into turns(id, user_key, conversation_id, message, fingerprint, status) values($1,$2,$3,$4,$5,'active')`, [turnId, userKey, input.conversationId, input.message, fingerprint]);
      yield emit({ type: "trace", stage: "turn.submit.accepted", message: "submit reached backend", harness, model });

      // Rule 5: warm + responsive sandbox -> direct, no bridge. "Warm" = a live probe
      // AND >= directMinWarmMs of machine age (a sandbox in its first seconds is still hydrating).
      const sandboxRow = await this.db.one<{ id: string; billing_since: string | null }>(
        `select id, billing_since from sandboxes where user_key=$1 and purpose='user' and retired_at is null`, [userKey],
      );
      let direct = false;
      if (sandboxRow?.billing_since && !dup && Date.now() - Date.parse(sandboxRow.billing_since) >= (this.opts.directMinWarmMs ?? 15_000)) {
        try { direct = (await this.sandbox.command(sandboxRow.id, { command: "echo __UP__", timeoutMs: 3_500 })).stdout.includes("__UP__"); }
        catch { direct = false; }
      }

      const boot = new EventQueue();
      let sandboxReady: Promise<SandboxInfo>;
      if (direct && sandboxRow) {
        yield emit({ type: "trace", stage: "route.direct", message: "private sandbox is warm and responsive; routing directly (rule 5)", harness, model, sandboxId: sandboxRow.id });
        sandboxReady = this.sandbox.get(sandboxRow.id);
        boot.end();
      } else {
        sandboxReady = this.ensureUserSandbox(input.userId, input.conversationId, boot).finally(() => boot.end());
        sandboxReady.catch(() => undefined); // surfaced via the sandbox-round await below
      }
      await this.wake(input.userId, "turn");

      let partialShared = "";
      if (!direct) {
        // Rules 1+3: the shared agent answers immediately (full or holding line — its choice).
        yield emit({ type: "trace", stage: "shared.bridge.start", message: "shared no-tools agent answers first (full answer or a short wait line — its own choice)", harness, model });
        const transcript = await this.getTranscript(input.userId, input.conversationId);
        const hidden = buildHiddenContext({ transcript, machine: { location: "shared-sandbox", tools: false, status: "provisioning" } });
        yield emit({ type: "context.injected", scope: "shared", machine: { location: "shared-sandbox", tools: false, status: "provisioning" }, hidden });
        try {
          const shared = await this.sharedStreamFor(input.userId);
          for await (const delta of shared(sharedPrompt(transcript, input.message, this.opts.scenariosEnabled ? FORK_DIRECTIVE : undefined), abort.signal)) {
            if (delta) { partialShared += delta; yield emit({ type: "shared.delta", text: delta, harness, final: false }); }
            for (const e of boot.drain()) yield emit(e);
          }
        } catch (e) {
          yield emit({ type: "trace", stage: "shared.bridge.failed", message: e instanceof Error ? e.message : String(e), harness, model });
        }
        const sharedClean = stripForkTag(partialShared);
        if (sharedClean.trim()) {
          await this.db.q(`insert into transcripts(user_key, conversation_id, role, content, mode) values($1,$2,'assistant',$3,'shared')`, [userKey, input.conversationId, sharedClean]);
        }
      }
      for (const e of boot.drain()) yield emit(e);

      if (dup) {
        yield emit({ type: "trace", stage: "private-round.suppressed", message: "identical concurrent request already pending at the private runtime; no duplicate round", harness, model });
        await this.finishTurn(turnId, "suppressed");
        yield emit({ type: "turn.done", harness, model, route: "shared", settled: false });
        return;
      }

      let sandbox: SandboxInfo;
      try {
        sandbox = await sandboxReady;
        while (!boot.done) { await boot.wait(); for (const e of boot.drain()) yield emit(e); }
        for (const e of boot.drain()) yield emit(e);
      } catch (error) {
        await this.finishTurn(turnId, "blocked");
        yield emit({ type: "turn.blocked", stage: "sandbox.runtime.unavailable", message: error instanceof Error ? (error.stack ?? error.message) : String(error), retryable: true, harness, model });
        return;
      }

      const forkLabels = this.opts.scenariosEnabled ? parseForkLabels(partialShared) : [];
      if (forkLabels.length >= 2) {
        yield* this.runScenarios(turn, turnId, userKey, convKey, sandbox, partialShared, forkLabels, abort.signal);
      } else {
        yield* this.runSandboxRound(turn, turnId, userKey, convKey, sandbox, partialShared, abort.signal);
      }
    } finally {
      this.turnAborts.delete(turnId);
      await this.bumpActivity(input.userId).catch(() => undefined);
      // A turn can never be left 'active' — that would pin the sandbox forever.
      await this.db.q(`update turns set status='interrupted', done_at=now() where id=$1 and status='active'`, [turnId]).catch(() => undefined);
    }
  }

  private async finishTurn(turnId: string, status: "answered" | "suppressed" | "blocked" | "interrupted"): Promise<void> {
    await this.db.q(`update turns set status=$2, done_at=now() where id=$1`, [turnId, status]);
  }

  /**
   * The private round: one POST /prompt on the user's sandbox, its events streamed
   * until the prompt run is done. The sandbox conversation of this chat lives in
   * conversations.sandbox_conversations[sandboxId]; a scenario round always opens a new
   * one (parallel conversations on the same machine).
   */
  private async *runSandboxRound(
    input: ResolvedTurnInput, turnId: string, userKey: string, convKey: string, sandbox: SandboxInfo, partialShared: string, signal: AbortSignal,
    scenario?: { scenarioId: string; label: string },
  ): AsyncIterable<ConsumerTurnEvent> {
    const { harness, model, reasoningEffort } = input.selection;
    const emit = (e: EventBody): ConsumerTurnEvent =>
      ({ ...e, turnId, ...(scenario ? { scenarioId: scenario.scenarioId, scenarioLabel: scenario.label } : {}) } as ConsumerTurnEvent);
    let recordingPath: string | null = null;
    const queue = new EventQueue();
    const work = this.db.withLock("conv", convKey, async (): Promise<SandboxOutcome> => {
      const push = (e: EventBody) => queue.push(e);
      await this.wake(input.userId, scenario ? "scenario" : "turn");
      push({ type: "billing.start", sandboxId: sandbox.id, ratePerSecond: SANDBOX_PRICE_USD_PER_SECOND, sinceEpochMs: Date.now(), pricing: SANDBOX_PRICING });
      const transcript = await this.getTranscript(input.userId, input.conversationId);
      push({ type: "handoff.started", sandboxId: sandbox.id, recap: input.message, harness, model });
      const machine = { location: "user-sandbox" as const, tools: true, sandboxId: sandbox.id, status: "live" as const };

      const conv = await this.db.one<{ sandbox_conversations: Record<string, string> }>(
        `select sandbox_conversations from conversations where user_key=$1 and id=$2`, [userKey, input.conversationId],
      );
      const known = scenario ? undefined : conv?.sandbox_conversations?.[sandbox.id];
      const prompt = sandboxTurnPrompt({ first: !known, transcript, message: input.message, partialShared, ...(scenario ? { scenarioLabel: scenario.label } : {}) });
      push({ type: "context.injected", scope: "user-sandbox", machine, hidden: prompt });
      const run = await this.sandbox.prompt(sandbox.id, {
        provider: harness, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(typeof input.selection.fast === "boolean" ? { fast: input.selection.fast } : {}), prompt,
        ...(known ? { conversationId: known } : { new: true }),
      });
      if (!scenario && run.conversationId !== known) {
        await this.db.q(
          `update conversations set sandbox_conversations = sandbox_conversations || $3::jsonb where user_key=$1 and id=$2`,
          [userKey, input.conversationId, JSON.stringify({ [sandbox.id]: run.conversationId })],
        );
      }
      push({ type: "exec", kind: "harness", argv: [harness, ...(model ? [model] : [])], sandboxId: sandbox.id });

      // Stream: every response event carries the FULL text of one assistant
      // message so far; deltas are its growth. The <end> sentinel (rule 6) is
      // held back while it could still complete, so no partial ever leaks.
      const msgs = new Map<string, { text: string; flushed: number; index: number }>();
      const seenUses = new Set<string>(), seenResults = new Set<string>();
      let sawEnd = false, cursor: string | undefined, polls = 0, done = false, harnessError = "";
      const onTool = (tool: { use?: { id?: string; name?: string; input?: unknown }; result?: { tool_use_id?: string; content?: unknown; is_error?: boolean } }) => {
        const use = tool.use;
        if (use && !seenUses.has(String(use.id))) {
          seenUses.add(String(use.id));
          const command = toolCommand(use.input);
          const description = (use.input as { description?: string } | undefined)?.description;
          push({ type: "harness.tool", phase: "tool_use", sandboxId: sandbox.id, ...(use.name ? { toolName: use.name } : {}), ...(command ? { command } : {}), ...(description ? { description } : {}) });
          if (command) {
            const m = command.match(HOST_CMD_RE);
            if (m) void this.markHosting(input.userId, input.conversationId, sandbox.id, Number(m[1]), m[2] as "public" | "private").catch(() => undefined);
            if (!recordingPath && isDesktopCommand(command)) {
              recordingPath = `recordings/${turnId}.mp4`;
              void this.startDesktopRecording(sandbox.id, turnId).catch(() => { recordingPath = null; });
            }
          }
        }
        const result = tool.result;
        if (result && use?.id && !seenResults.has(String(use.id))) {
          seenResults.add(String(use.id));
          push({ type: "harness.tool", phase: "tool_result", sandboxId: sandbox.id, ...(use.name ? { toolName: use.name } : {}), stdout: toolText(result.content).slice(0, 4000), ...(result.is_error ? { isError: true } : {}) });
        }
      };
      const onText = (id: string, content: string) => {
        const m = msgs.get(id) ?? { text: "", flushed: 0, index: msgs.size };
        msgs.set(id, m);
        m.text = content;
        if (content.trim() === "<end>") { sawEnd = true; return; }
        // What the user sees never contains the sentinel, wherever the model put it: Kimi opens
        // with it and answers anyway, and holding only a TRAILING one let "<end>I'm Kimi..."
        // reach the screen. `flushed` counts characters of this cleaned text, so the tail hold
        // (a sentinel still being typed) is measured on it too.
        const clean = content.replace(/<end>/g, "");
        const hold = clean.match(/<(e(n(d)?)?)?$/)?.[0].length ?? 0;
        const flushTo = clean.length - hold;
        if (flushTo > m.flushed) {
          push({ type: "user-sandbox.delta", text: clean.slice(m.flushed, flushTo), sandboxId: sandbox.id, harness, model, messageId: id, messageIndex: m.index });
          m.flushed = flushTo;
        }
      };
      // Boat streams a partial message under one id (data.is_streaming) and then sends the
      // finished message under a NEW id with the same text. Keyed by id, the user saw the
      // answer twice. A finished message therefore lands on the partial it completes.
      let openStreamId: string | null = null;
      const consume = (events: SandboxEvent[]) => {
        for (const e of events) {
          if (e.taskId && e.taskId !== run.promptId) continue;
          if (events.length) cursor = `${e.timestamp}:${e.id}`;
          const d = e.data ?? {};
          if (e.type === "response") {
            if (typeof d.content === "string" && d.content) {
              const id = String(e.id).replace(/-tools$/, "");
              if (d.is_streaming) { openStreamId = id; onText(id, d.content); }
              else if (openStreamId && !msgs.has(id)) { onText(openStreamId, d.content); openStreamId = null; }
              else onText(id, d.content);
            }
            if (Array.isArray(d.tools)) for (const t of d.tools) onTool(t as Parameters<typeof onTool>[0]);
          } else if (e.type === "prompt" && ["finished", "failed", "interrupted"].includes(String(d.status))) {
            // A failed run carries the harness's own reason (missing key, bad model): keep it for the user.
            if (d.status === "failed" && typeof d.error === "string" && d.error) harnessError = d.error.trim().slice(0, 400);
            done = true;
          }
        }
      };
      // The prompt may have been sent while the sandbox was still resuming. If it never
      // comes up, nothing would ever arrive: check the sandbox once the handoff window
      // passes with no event, instead of polling forever.
      const handoffMs = this.opts.handoffTimeoutMs ?? 120_000;
      let quietSince = Date.now();
      while (!done) {
        if (signal.aborted) {
          await this.sandbox.interrupt(sandbox.id, run.conversationId).catch(() => undefined);
          return { outcome: "interrupted", text: [...msgs.values()].map((m) => m.text).join("\n") };
        }
        const page = await this.sandbox.events(sandbox.id, { conversationId: run.conversationId, ...(cursor ? { cursor } : {}) });
        consume(page.events);
        if (page.events.length) quietSince = Date.now();
        else if (msgs.size === 0 && Date.now() - quietSince > handoffMs) {
          const state = String((await this.sandbox.get(sandbox.id).catch(() => undefined))?.state ?? "error");
          if (["error", "deleted", "archived", "stopped"].includes(state)) {
            return { outcome: "blocked", text: "", diagnostic: `the private sandbox did not come up (state: ${state})`, blockedEmitted: false };
          }
          quietSince = Date.now();
        }
        // The prompt-run status is the first-class completion signal; the
        // events are the content. Ask for it every third poll (or when idle).
        if (!done && (page.events.length === 0 || ++polls % 3 === 0)) done = (await this.sandbox.promptRun(sandbox.id, run.promptId)).done;
        if (!done) await new Promise((r) => setTimeout(r, this.opts.eventPollMs ?? 250));
      }
      consume((await this.sandbox.events(sandbox.id, { conversationId: run.conversationId, ...(cursor ? { cursor } : {}) })).events); // final drain
      // Stream over: a held tail is either the sentinel (drop) or a partial that never completed (flush).
      const visibleParts: string[] = [];
      for (const [id, m] of msgs) {
        // The sentinel is stripped WHEREVER it lands, not only at the end: Kimi opens with it
        // and then answers anyway, and "<end>I'm Kimi..." reached the user's screen.
        const rawVisible = m.text.replace(/<end>/g, "");
        if (!sawEnd && rawVisible.length > m.flushed) push({ type: "user-sandbox.delta", text: rawVisible.slice(m.flushed), sandboxId: sandbox.id, harness, model, messageId: id, messageIndex: m.index });
        if (rawVisible.trim()) visibleParts.push(rawVisible.trim());
      }
      const visible = visibleParts.join("\n\n");
      if (sawEnd || !visible && msgs.size > 0 && [...msgs.values()].every((m) => /^\s*<end>\s*$/.test(m.text))) return { outcome: "silent", text: "" };
      if (!visible) {
        // Rule 6 binding clause: no text and no <end> is LOUD, never silence. Except when the
        // shared surface already answered in full and the harness reports no failure: adding
        // nothing IS the <end> case, whether or not the model bothered to type the sentinel
        // (Kimi answers from its thinking and can end a turn empty). The user has their answer,
        // so a red error would be a lie about a turn that worked.
        if (!harnessError && partialShared.trim()) return { outcome: "silent", text: "" };
        return { outcome: "blocked", text: "", diagnostic: harnessError ? `the agent could not run: ${harnessError}` : `harness ended with no answer and no <end> (tools used: ${seenUses.size})`, blockedEmitted: false };
      }
      await this.db.q(
        `insert into transcripts(user_key, conversation_id, role, content, mode, scenario_id) values($1,$2,'assistant',$3,'sandbox',$4)`,
        [userKey, input.conversationId, visible, scenario?.scenarioId ?? null],
      );
      return { outcome: "answered", text: visible };
    });

    let result: SandboxOutcome | undefined;
    const done = work.then((r) => { result = r; queue.end(); }, (e) => {
      queue.push({ type: "turn.blocked", stage: "sandbox.round.crashed", message: e instanceof Error ? (e.stack ?? e.message) : String(e), retryable: true, harness, model });
      result = { outcome: "blocked", text: "", diagnostic: e instanceof Error ? e.message : String(e), blockedEmitted: true };
      queue.end();
    });
    while (!queue.done) { await queue.wait(); for (const e of queue.drain()) yield emit(e); }
    await done;
    for (const e of queue.drain()) yield emit(e);

    if (recordingPath && !signal.aborted) {
      const rec = await this.stopDesktopRecording(sandbox.id, turnId).catch(() => ({ ok: false, sizeKb: 0 }));
      if (rec.ok && rec.sizeKb > 0) yield emit({ type: "desktop.recording", sandboxId: sandbox.id, path: recordingPath, sizeKb: rec.sizeKb });
    }

    const idleMs = this.opts.autoStopIdleMs ?? 15_000;
    switch (result?.outcome) {
      case "answered":
      case "silent":
        if (!scenario) { await this.finishTurn(turnId, "answered"); await this.bumpActivity(input.userId); }
        yield emit({ type: "turn.done", sandboxId: sandbox.id, harness, model, route: partialShared ? "bridge" : "direct", settled: true });
        if (!scenario) yield emit({ type: "autostop.timer", phase: "started", sandboxId: sandbox.id, remainingMs: idleMs, deadlineEpochMs: Date.now() + idleMs, reason: "idle-after-response", note: "assistant finished; private sandbox auto-stops when the idle countdown reaches zero" });
        break;
      case "interrupted":
        if (!scenario) await this.finishTurn(turnId, "interrupted");
        yield emit({ type: "trace", stage: "turn.interrupted", message: "turn aborted by the user; the conversation keeps its memory", harness, model, sandboxId: sandbox.id });
        break;
      default:
        if (!scenario) await this.finishTurn(turnId, "blocked");
        if (!(result && result.outcome === "blocked" && result.blockedEmitted)) {
          yield emit({ type: "turn.blocked", stage: "sandbox.no-answer", message: (result && result.outcome === "blocked" ? result.diagnostic : undefined) ?? "sandbox round produced no answer", retryable: true, harness, model, sandboxId: sandbox.id });
        }
    }
  }

  // ---------------------------------------------------------------- parallel scenarios (fan-out)

  private async *mergeGenerators(gens: AsyncIterable<ConsumerTurnEvent>[]): AsyncIterable<ConsumerTurnEvent> {
    const q = new EventQueue();
    let running = gens.length;
    if (!running) return;
    for (const g of gens) {
      void (async () => {
        try { for await (const ev of g) q.push(ev as unknown as EventBody); }
        finally { if (--running === 0) q.end(); }
      })();
    }
    while (!q.done) { await q.wait(); for (const e of q.drain()) yield e as unknown as ConsumerTurnEvent; }
  }

  /**
   * Fan a turn into one private run per interpretation: N parallel conversations
   * on the user's own sandbox (each its own harness process and memory), every event
   * scenario-tagged for the carousel UI. Nothing to provision, nothing to reap.
   */
  private async *runScenarios(
    input: ResolvedTurnInput, turnId: string, userKey: string, convKey: string, sandbox: SandboxInfo, partialShared: string, labels: string[], signal: AbortSignal,
  ): AsyncIterable<ConsumerTurnEvent> {
    yield { type: "scenario.fork", groupId: turnId, labels, turnId } as ConsumerTurnEvent;
    try {
      yield* this.mergeGenerators(labels.map((label, i) =>
        this.runSandboxRound(input, turnId, userKey, `${convKey}:s${i}`, sandbox, partialShared, signal, { scenarioId: `s${i}`, label }),
      ));
    } finally {
      await this.finishTurn(turnId, "answered").catch(() => undefined);
      await this.bumpActivity(input.userId).catch(() => undefined);
    }
  }
}

function hostingKillCommand(port: number): string {
  // `host hide <port>` is the CLI's authoritative takedown; ufw belt-and-suspenders.
  return `host hide ${port} 2>/dev/null; sudo -n ufw delete allow ${port}/tcp 2>/dev/null; sudo -n ufw delete allow ${port} 2>/dev/null; sudo -n ufw deny ${port}/tcp 2>/dev/null; true`;
}
