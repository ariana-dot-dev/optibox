import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import {
  createUserBoxCapabilities,
  createRestrictedSharedCapabilities,
} from "./capabilities.js";
import { HarnessMissingError } from "./types.js";
import { buildHiddenContext, BOX_PRICE_USD_PER_SECOND, BOX_PRICING } from "./context.js";
import { ExtractiveRecapper } from "./recap.js";
import type {
  BoxClient,
  ConsumerTurnEventBody,
  BoxInfo,
  ConsumerTurnEvent,
  ConsumerTurnInput,
  HarnessAdapter,
  HarnessCompletion,
  TranscriptMessage,
} from "./types.js";

/**
 * The engine: the 6-rule spec on Postgres, nothing else.
 *
 *  1. always answer something          -> shared bridge streams immediately
 *  2. box agent may answer on top      -> box round after/parallel to bridge
 *  3. shared decides full vs holding   -> its own instructions (harness layer)
 *  4. machine stops after idle window  -> sweeper over rows, countdown in
 *                                         runtimeStatus; new message = bump
 *  5. warm+responsive box -> direct    -> no bridge text when box is ON
 *  6. box declines with <end> only     -> render nothing; no-text-no-end is a
 *                                         LOUD turn.blocked (no fallbacks)
 *
 * Every piece of state is a row (docs/redesign.md). The invariants live in the
 * schema: one active box per user is a UNIQUE index, billing ends in a single
 * UPDATE, hosting is a row with provenance and a durable stop intent, boxes
 * are acted on only through their rows. There are exactly two locks in the
 * system, both Postgres advisory locks: ('user', key) for box lifecycle and
 * ('conv', key) for box-round ordering.
 */

export interface EngineOptions {
  db: Db;
  box: BoxClient;
  harnesses: HarnessAdapter[];
  instanceId: string;
  /** Distinguishes BYOK credential sets; part of every user key. */
  credHash: string;
  providerEnv?: Record<string, string>;
  userBoxTtlSeconds?: number;
  autoStopIdleMs?: number;
  sweepIntervalMs?: number;
  maxBillingAgeMs?: number;
  readinessPollMs?: number;
  handoffTimeoutMs?: number;
  /** Minimum machine age before the direct (no-bridge) route applies; younger boxes bridge as if off. */
  directMinWarmMs?: number;
  template?: { installCmd: string; warmCmd?: string };
  /** Parallel scenarios: let the shared model fan a turn into N alternative box
   *  runs via <optibox-fork>. Off by default — the fan-out UI ships in a later
   *  step; when off the fork tag is ignored and turns run exactly as before. */
  scenariosEnabled?: boolean;
}

type EventBody = ConsumerTurnEventBody;

/** Small unbounded push/pull queue bridging background work into turn streams. */
class EventQueue {
  private items: EventBody[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(e: EventBody): void { this.items.push(e); this.wake?.(); }
  end(): void { this.closed = true; this.wake?.(); }
  /** Drain whatever is queued right now (non-blocking). */
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
// a turn starts a box-side screen recording (see runBoxRound).
const DESKTOP_MARKS = ["xdotool", "wmctrl", "xdg-open", "ydotool", "wtype", "scrot", "DISPLAY=", "chromium", "google-chrome", "firefox", "lux "];
const isDesktopCommand = (cmd: string): boolean => DESKTOP_MARKS.some((m) => cmd.includes(m));

// Parallel scenarios: the shared model marks a genuinely ambiguous request by
// ending its reply with <optibox-fork>label A | label B</optibox-fork> (same
// hidden-tag machinery as <optibox-files>). Labels split on "|"; 2..4 kept.
const FORK_TAG_RE = /<optibox-fork>([\s\S]*?)<\/optibox-fork>/i;
function parseForkLabels(text: string): string[] {
  const m = FORK_TAG_RE.exec(text);
  if (!m || !m[1]) return [];
  const labels = m[1].split("|").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
  const uniq = [...new Set(labels)];
  return uniq.length >= 2 ? uniq.slice(0, 4) : [];
}
// Strip the fork tag (and anything after it) from stored/spoken shared text —
// the client already hides it via stripFileDecl, this keeps the transcript clean.
const stripForkTag = (text: string): string => text.replace(/<optibox-fork>[\s\S]*/i, "").trimEnd();

export class Engine {
  private readonly db: Db;
  private readonly box: BoxClient;
  private readonly harnesses: Map<string, HarnessAdapter>;
  private readonly recapper = new ExtractiveRecapper();
  private readonly opts: EngineOptions;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private templateBuild: Promise<void> | undefined;
  private readonly prewarming = new Set<string>();
  /** In-process abort registry for interrupts; processes are per-instance so this is not shared state. */
  private readonly turnAborts = new Map<string, AbortController>();

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.box = opts.box;
    this.harnesses = new Map(opts.harnesses.map((h) => [h.name, h]));
    if (this.harnesses.size === 0) throw new Error("Engine requires at least one harness");
    const ms = opts.sweepIntervalMs ?? 5_000;
    if (ms > 0) {
      this.sweeper = setInterval(() => { void this.sweep().catch((e) => console.error("[engine] sweep failed:", e)); }, ms);
      this.sweeper.unref?.();
    }
  }

  dispose(): void { if (this.sweeper) clearInterval(this.sweeper); }

  listHarnesses(): HarnessAdapter[] { return [...this.harnesses.values()]; }

  // ---------------------------------------------------------------- identity

  /** Full user key: fingerprint user + credential hash (BYOK isolation). */
  userKey(userId: string): string { return `${userId}-${this.opts.credHash}`; }

  private boxName(userKey: string): string {
    return `optibox-${this.opts.instanceId}-user-${userKey}`;
  }

  private convKey(userKey: string, conversationId: string): string {
    return `${userKey}:${conversationId}`;
  }

  // ---------------------------------------------------------------- billing

  /** THE wake path: sets billing_since if not billing, bumps activity. */
  async wake(userId: string, reason: string): Promise<void> {
    const key = this.userKey(userId);
    await this.db.q(`insert into users(key) values($1) on conflict(key) do update set last_activity_at=now()`, [key]);
    await this.db.q(
      `update boxes set billing_since=coalesce(billing_since, now()), billing_reason=coalesce(billing_reason,$2)
       where user_key=$1 and purpose='user' and retired_at is null`,
      [key, reason],
    );
  }

  /** Start billing on ONE specific box (any purpose) — the per-box form used by
   *  box rounds so a scenario box bills itself, not the user's primary box. */
  async wakeBox(boxId: string, reason: string): Promise<void> {
    await this.db.q(
      `update boxes set billing_since=coalesce(billing_since, now()), billing_reason=coalesce(billing_reason,$2) where id=$1 and retired_at is null`,
      [boxId, reason],
    );
    await this.db.q(`update users u set last_activity_at=now() from boxes b where b.id=$1 and b.user_key=u.key`, [boxId]);
  }

  /** THE one way billing ends: atomically folds elapsed into the user total.
   * NOTE the `old` subquery: RETURNING on an UPDATE sees the NEW row, so
   * referencing billing_since directly after nulling it yields NULL elapsed
   * (and a NULL ledger — caught by the suite). The pre-image must be selected
   * FOR UPDATE first. */
  private async endBilling(boxId: string): Promise<number> {
    const row = await this.db.one<{ elapsed: number }>(
      `with old as (
         select id, user_key, billing_since from boxes
          where id=$1 and billing_since is not null
          for update
       ),
       ended as (
         update boxes b set billing_since=null, billing_reason=null
           from old where b.id = old.id
         returning old.user_key, extract(epoch from now() - old.billing_since) as elapsed
       )
       update users u set billed_seconds = u.billed_seconds + ended.elapsed
         from ended where u.key = ended.user_key
       returning ended.elapsed`,
      [boxId],
    );
    return Number(row?.elapsed ?? 0);
  }

  private async bumpActivity(userId: string): Promise<void> {
    await this.db.q(`update users set last_activity_at=now() where key=$1`, [this.userKey(userId)]);
  }

  // ---------------------------------------------------------------- holds

  /** Keep-alive hold with TTL; returns a release fn. Rows, not memory. */
  holdUserBox(userId: string, reason: string, ttlMs = 10 * 60_000): () => void {
    const key = this.userKey(userId);
    void this.db.q(
      `insert into users(key) values($1) on conflict do nothing`, [key],
    ).then(() => this.db.q(
      `insert into holds(user_key, reason, expires_at) values($1,$2,now()+($3||' milliseconds')::interval)
       on conflict(user_key, reason) do update set expires_at=excluded.expires_at`,
      [key, reason, String(ttlMs)],
    )).catch((e) => console.error("[engine] hold write failed:", e.message));
    return () => { void this.db.q(`delete from holds where user_key=$1 and reason=$2`, [key, reason]).catch(() => undefined); };
  }

  // ---------------------------------------------------------------- box lifecycle

  /** The user's active box row, if any. */
  async activeUserBoxId(userId: string): Promise<string | undefined> {
    const row = await this.db.one<{ id: string }>(
      `select id from boxes where user_key=$1 and purpose='user' and retired_at is null`, [this.userKey(userId)],
    );
    return row?.id;
  }

  /**
   * ONE user = ONE box, mechanically: everything runs under the user advisory
   * lock and the unique index makes a duplicate insert impossible even if the
   * lock were bypassed. Emits lifecycle through the queue (no promise plumbing).
   */
  async ensureUserBox(userId: string, _conversationId: string, events?: EventQueue): Promise<BoxInfo> {
    const key = this.userKey(userId);
    return this.db.withLock("user", key, async () => {
      await this.db.q(`insert into users(key) values($1) on conflict do nothing`, [key]);
      const existing = await this.db.one<{ id: string }>(
        `select id from boxes where user_key=$1 and purpose='user' and retired_at is null`, [key],
      );
      if (existing) {
        const info = await this.box.get(existing.id).catch(() => undefined);
        const state = String(info?.state ?? "error");
        if (info && !["error", "deleted"].includes(state)) {
          if (["archived", "stopped"].includes(state)) {
            events?.push({ type: "lifecycle", boxId: info.id, state: "resuming", note: "resuming private box from disk snapshot" });
            await this.box.resume(info.id);
            const ready = await this.waitUntilReady(info.id);
            await this.wake(userId, "resume");
            events?.push({ type: "lifecycle", boxId: info.id, state: ready.state, note: "private box resumed from snapshot — no cold start" });
            return ready;
          }
          if (state === "archiving" || state === "stopping") {
            events?.push({ type: "lifecycle", boxId: info.id, state, note: "waiting out in-flight archive before resume" });
            await this.waitUntilParked(info.id);
            await this.box.resume(info.id);
            const ready = await this.waitUntilReady(info.id);
            await this.wake(userId, "resume");
            return ready;
          }
          // booting or live
          const ready = await this.waitUntilReady(info.id);
          await this.wake(userId, "adopt");
          return ready;
        }
        // Terminal/deleted: retire the row LOUDLY in the event stream, then fall through to create.
        events?.push({ type: "lifecycle", boxId: existing.id, state: "error", note: "previous box is terminal; retiring it and provisioning a fresh one" });
        await this.db.q(`update boxes set retired_at=now(), billing_since=null where id=$1`, [existing.id]);
      }
      const created = await this.createFreshBox(key, events);
      await this.wake(userId, "boot");
      return created;
    });
  }

  private async createFreshBox(userKey: string, events?: EventQueue, role?: { purpose: "scenario"; group: string; label: string }): Promise<BoxInfo> {
    const name = this.boxName(userKey);
    const ttlSeconds = this.opts.userBoxTtlSeconds ?? 900;
    const purpose = role?.purpose ?? "user";
    const scenCols = role ? ", scenario_group, scenario_label" : "";
    const scenVals = role ? ", $5, $6" : "";
    const scenArgs = role ? [role.group, role.label] : [];
    // When a template is configured (the harness needs installation), a user
    // box is ALWAYS a fork of the warm-cycled template — installed, snapshotted,
    // resumed once with the harness actually launched (recording the FUSE
    // lazy-restore access order), and snapshotted again. Never a plain create
    // with the harness missing, never an in-turn install. If the template isn't
    // ready yet, fail LOUDLY and let the user retry once the background build
    // lands (the shared surface has already answered — rule 1 holds).
    if (this.opts.template) {
      const tpl = await this.db.one<{ box_id: string; status: string }>(
        `select box_id, status from templates where instance_id=$1`, [this.opts.instanceId],
      );
      if (tpl?.status !== "ready") {
        if (!tpl || tpl.status === "failed") this.templateBuild ??= this.buildTemplate().catch(() => { this.templateBuild = undefined; });
        throw new Error(
          tpl?.status === "failed"
            ? "private machine template build FAILED — rebuilding in the background; check the server log for '[optibox] template box build failed' and retry in a few minutes"
            : "private machine template is still being prepared (first boot of this deployment, ~2-3 minutes) — send your message again shortly",
        );
      }
      if (!this.box.fork) throw new Error("box client cannot fork — template-based provisioning requires fork support");
      const forked = await this.box.fork(tpl.box_id);
      await this.box.update?.(forked.id, { name, ttlSeconds })?.catch(() => undefined);
      await this.db.q(
        `insert into boxes(id, user_key, instance_id, purpose${scenCols}) values($1,$2,$3,$4${scenVals})`,
        [forked.id, userKey, this.opts.instanceId, purpose, ...scenArgs],
      );
      events?.push({ type: "lifecycle", boxId: forked.id, state: "forking", note: "forking pre-installed, warm-cycled template" });
      return await this.waitUntilReady(forked.id);
    }
    // No template configured = the harness needs no installation (generator
    // harnesses, tests): plain create is the intended path.
    const created = await this.box.create({ name, ttlSeconds });
    await this.db.q(
      `insert into boxes(id, user_key, instance_id, purpose${scenCols}) values($1,$2,$3,$4${scenVals})`,
      [created.id, userKey, this.opts.instanceId, purpose, ...scenArgs],
    );
    events?.push({ type: "lifecycle", boxId: created.id, state: "starting", note: "creating fresh private box" });
    return this.waitUntilReady(created.id);
  }

  private async waitUntilReady(boxId: string): Promise<BoxInfo> {
    const pollMs = this.opts.readinessPollMs ?? 750;
    const deadline = Date.now() + (this.opts.handoffTimeoutMs ?? 120_000);
    // Readiness = the box executes a command (state strings lag reality badly).
    while (Date.now() < deadline) {
      try {
        const r = await this.box.command(boxId, { command: "echo __UP__", timeoutMs: 10_000 });
        if (r.stdout.includes("__UP__")) return await this.box.get(boxId);
      } catch { /* still booting */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`box ${boxId} did not become ready within the handoff window`);
  }

  private async waitUntilParked(boxId: string): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const info = await this.box.get(boxId).catch(() => undefined);
      if (!info || ["archived", "stopped"].includes(String(info.state))) return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  /** Manual/auto stop: billing ends at stop REQUEST; stream the lifecycle. */
  async *stopUserBox(userId: string, _conversationId: string): AsyncIterable<ConsumerTurnEvent> {
    const key = this.userKey(userId);
    const turnId = randomUUID();
    const row = await this.db.one<{ id: string }>(
      `select id from boxes where user_key=$1 and purpose='user' and retired_at is null`, [key],
    );
    if (!row) { yield { type: "lifecycle", boxId: "", state: "none", note: "no active user box to stop", turnId }; return; }
    const events = await this.db.withLock("user", key, async () => {
      const out: EventBody[] = [];
      out.push({ type: "lifecycle", boxId: row.id, state: "stopping", note: "requesting stop (snapshot + pause billing)" });
      const elapsed = await this.endBilling(row.id);
      out.push({ type: "billing.stop", boxId: row.id, elapsedSeconds: elapsed, costUsd: elapsed * BOX_PRICE_USD_PER_SECOND, note: "billing PAUSED — you pay $0 while the box is stopped" });
      await this.box.stop(row.id).catch(() => undefined);
      out.push({ type: "lifecycle", boxId: row.id, state: "archiving", note: "snapshotting disk & archiving" });
      return out;
    });
    for (const e of events) yield { ...e, turnId } as ConsumerTurnEvent;
    await this.waitUntilParked(row.id);
    yield { type: "lifecycle", boxId: row.id, state: "archived", note: "archived — disk snapshot kept, resumes with no cold start", turnId };
  }

  /**
   * Full user reset: stop+delete every box (and its snapshots) the user ever
   * had under this credential set, and erase all rows — billing ledger,
   * transcripts, turns, holds, hosting, conversations. Under the user lock so
   * it cannot race a turn's provisioning.
   */
  async resetUser(userId: string): Promise<{ ok: true; boxesDeleted: number }> {
    const key = this.userKey(userId);
    return this.db.withLock("user", key, async () => {
      const rows = await this.db.q<{ id: string }>(`select id from boxes where user_key=$1`, [key]);
      for (const r of rows) {
        await this.endBilling(r.id).catch(() => undefined);
        await this.box.stop(r.id).catch(() => undefined);
        await this.box.deleteBox?.(r.id)?.catch(() => undefined);
      }
      for (const table of ["hosting", "holds", "turns", "transcripts", "events", "conversations", "boxes"]) {
        await this.db.q(`delete from ${table} where user_key=$1`, [key]);
      }
      await this.db.q(`delete from users where key=$1`, [key]); // users keys on `key`, not user_key
      return { ok: true as const, boxesDeleted: rows.length };
    });
  }

  // ---------------------------------------------------------------- sweeper (rule 4)

  /**
   * Rule 4 as a query: stop every billing box of ours whose user has no active
   * turns, no unexpired holds, no hosting, and no activity inside the idle
   * window — plus an absolute ceiling for stuck turns. Rows only.
   */
  private async sweep(): Promise<void> {
    await this.db.q(`insert into instances(id) values($1) on conflict(id) do update set heartbeat_at=now()`, [this.opts.instanceId]);
    await this.db.q(`delete from holds where expires_at <= now()`);
    const idleMs = this.opts.autoStopIdleMs ?? 15_000;
    const ceilingMs = this.opts.maxBillingAgeMs ?? 30 * 60_000;
    const rows = await this.db.q<{ id: string; user_key: string; over_ceiling: boolean }>(
      `select b.id, b.user_key,
              (b.billing_since < now() - ($3||' milliseconds')::interval) as over_ceiling
         from boxes b join users u on u.key = b.user_key
        where b.instance_id = $1 and b.user_key like $4
          and b.purpose = 'user' and b.retired_at is null
          and b.billing_since is not null
          and not exists (select 1 from hosting h where h.user_key = b.user_key and h.stop_requested_at is null)
          and ( b.billing_since < now() - ($3||' milliseconds')::interval
                or ( u.last_activity_at < now() - ($2||' milliseconds')::interval
                     and not exists (select 1 from turns t where t.user_key = b.user_key and t.status='active')
                     and not exists (select 1 from holds hh where hh.user_key = b.user_key and hh.expires_at > now()) ) )`,
      [this.opts.instanceId, String(idleMs), String(ceilingMs), `%-${this.opts.credHash}`],
    );
    for (const r of rows) {
      await this.db.withLock("user", r.user_key, async () => {
        // Re-check under the lock; a turn may have started meanwhile.
        const still = await this.db.one(
          `select 1 from boxes b join users u on u.key=b.user_key
            where b.id=$1 and b.billing_since is not null
              and ( b.billing_since < now() - ($3||' milliseconds')::interval
                    or ( u.last_activity_at < now() - ($2||' milliseconds')::interval
                         and not exists (select 1 from turns t where t.user_key=b.user_key and t.status='active') ) )`,
          [r.id, String(idleMs), String(ceilingMs)],
        );
        if (!still) return;
        await this.endBilling(r.id);
        await this.box.stop(r.id).catch(() => undefined);
      });
    }
    // Crash safety for parallel scenarios: the fan-out stops+retires its own
    // scenario boxes, but if a run died mid-flight a purpose='scenario' box can
    // be left billing forever (the loop above only sweeps purpose='user'). Reap
    // any that has billed past the absolute ceiling.
    const orphans = await this.db.q<{ id: string }>(
      `select id from boxes where instance_id=$1 and purpose='scenario' and retired_at is null
         and billing_since is not null and billing_since < now() - ($2||' milliseconds')::interval`,
      [this.opts.instanceId, String(ceilingMs)],
    );
    for (const o of orphans) {
      await this.endBilling(o.id).catch(() => undefined);
      await this.box.stop(o.id).catch(() => undefined);
      await this.db.q(`update boxes set retired_at=now(), billing_since=null where id=$1`, [o.id]).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- template

  private async buildTemplate(): Promise<void> {
    const template = this.opts.template;
    if (!template) return;
    const name = `optibox-${this.opts.instanceId}-template`;
    let boxId: string | undefined;
    try {
      const created = await this.box.create({ name, ttlSeconds: 3600 });
      boxId = created.id;
      await this.db.q(
        `insert into templates(instance_id, box_id, status) values($1,$2,'building')
         on conflict(instance_id) do update set box_id=excluded.box_id, status='building', built_at=null`,
        [this.opts.instanceId, created.id],
      );
      await this.waitUntilReady(created.id);
      // Detached install + exit marker: npm installs exceed both the HTTP
      // request cap and the command API's hard 60s execution cap.
      const script = `( ${template.installCmd} ) >/tmp/.tpl-install.log 2>&1; echo $? >/tmp/.tpl-install.exit`;
      await this.box.command(created.id, {
        command: `rm -f /tmp/.tpl-install.exit; nohup bash -c '${script.replace(/'/g, `'\\''`)}' >/dev/null 2>&1 & echo started`,
        timeoutMs: 15_000,
      });
      const deadline = Date.now() + 300_000;
      let exit: string | undefined;
      while (exit === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(5_000, this.opts.readinessPollMs ?? 5_000)));
        const probe = await this.box.command(created.id, { command: "cat /tmp/.tpl-install.exit 2>/dev/null || true", timeoutMs: 15_000 }).catch(() => undefined);
        if (probe?.stdout.trim()) exit = probe.stdout.trim();
      }
      if (exit !== "0") {
        const tail = await this.box.command(created.id, { command: "tail -c 400 /tmp/.tpl-install.log 2>/dev/null || true", timeoutMs: 15_000 }).catch(() => undefined);
        throw new Error(`template install ${exit === undefined ? "timed out" : `failed (exit=${exit})`}: ${(tail?.stdout ?? "").trim().slice(-300)}`);
      }
      await this.stopWithRetry(created.id);
      await this.waitUntilParked(created.id);
      if (template.warmCmd) {
        // MANDATORY warm pass: every user box must fork a template that has
        // been resumed once with the harness actually launched (recording the
        // FUSE lazy-restore access order) and snapshotted again. A template
        // whose warm cycle failed is NOT ready — no fallback to the install
        // snapshot: warm failure = build failure, rebuilt on the next demand.
        await this.box.resume(created.id);
        await this.waitUntilReady(created.id);
        await this.box.command(created.id, { command: template.warmCmd, timeoutMs: 55_000 });
        await this.stopWithRetry(created.id);
        await this.waitUntilParked(created.id);
      }
      await this.db.q(`update templates set status='ready', built_at=now() where instance_id=$1`, [this.opts.instanceId]);
    } catch (error) {
      if (boxId) await this.box.stop(boxId).catch(() => undefined);
      await this.db.q(`update templates set status='failed' where instance_id=$1`, [this.opts.instanceId]).catch(() => undefined);
      console.error(`[engine] template box build failed${boxId ? ` (box ${boxId}, stop requested)` : ""}:`, error instanceof Error ? (error.stack ?? error.message) : String(error));
      throw error;
    }
  }

  private async stopWithRetry(boxId: string): Promise<void> {
    // The platform refuses stop until a successful snapshot exists on young boxes.
    for (let i = 0; i < 20; i++) {
      try { await this.box.stop(boxId); return; } catch { await new Promise((r) => setTimeout(r, 3_000)); }
    }
    await this.box.stop(boxId);
  }

  /** Eager resident-runtime boot on wake (pure latency optimization). */
  prewarmBoxServe(boxId: string): void {
    if (this.prewarming.has(boxId)) return;
    const warmers = [...this.harnesses.values()].filter((h) => typeof h.prewarm === "function");
    if (warmers.length === 0) return;
    this.prewarming.add(boxId);
    void (async () => {
      try {
        const caps = createUserBoxCapabilities(this.box, boxId, { ...(this.opts.providerEnv ? { providerEnv: this.opts.providerEnv } : {}) });
        await this.waitUntilReady(boxId).catch(() => undefined);
        for (const h of warmers) { const p = h.prewarm; if (!p) continue; try { await p.call(h, caps); } catch { /* the turn's own boot covers it */ } }
      } finally { this.prewarming.delete(boxId); }
    })();
  }

  // ---------------------------------------------------------------- hosting

  private async markHosting(userId: string, conversationId: string, boxId: string, port: number, mode: "public" | "private"): Promise<void> {
    const key = this.userKey(userId);
    await this.db.q(
      `insert into hosting(user_key, port, conversation_id, box_id, mode) values($1,$2,$3,$4,$5)
       on conflict(user_key, port) do update
         set box_id=excluded.box_id, mode=excluded.mode, conversation_id=excluded.conversation_id,
             stop_requested_at=null, misses=0`,
      [key, port, conversationId, boxId, mode],
    );
    // The platform archives at its own TTL regardless of our holds; push it out.
    void this.box.update(boxId, { ttlSeconds: 7 * 24 * 3600 }).catch(() => undefined);
    void this.box.get(boxId).then(async (b) => {
      const m = String((b as { url?: string }).url ?? "").match(/^https:[/][/]([^.]+)[.](.+)$/);
      if (m) await this.db.q(`update hosting set url=$3 where user_key=$1 and port=$2`, [key, port, `https://${m[1]}-${port}.${m[2]}`]);
    }).catch(() => undefined);
  }

  /** Ground truth from the box (rides the fs poll): observed host processes. */
  async reconcileObservedHosting(userId: string, boxId: string, observed: Array<{ port: number; mode: "public" | "private" }>, opts: { boxLive?: boolean } = {}): Promise<void> {
    const key = this.userKey(userId);
    const seen = new Set(observed.map((o) => o.port));
    for (const o of observed) {
      const row = await this.db.one<{ stop_requested_at: string | null; conversation_id: string }>(
        `select stop_requested_at, conversation_id from hosting where user_key=$1 and port=$2`, [key, o.port],
      );
      if (row?.stop_requested_at) {
        // Durable stop intent: kill on sight instead of resurrecting the banner.
        void this.box.command(boxId, { command: hostingKillCommand(o.port), timeoutMs: 20_000 }).catch(() => undefined);
        continue;
      }
      await this.markHosting(userId, row?.conversation_id ?? "unknown", boxId, o.port, o.mode);
    }
    if (opts.boxLive === false) return; // can't disprove hosting on a parked box
    await this.db.q(
      `update hosting set misses = misses + 1 where user_key=$1 and stop_requested_at is null and not (port = any($2::int[]))`,
      [key, [...seen]],
    );
    await this.db.q(`delete from hosting where user_key=$1 and (misses >= 2 or (stop_requested_at is not null and stop_requested_at < now() - interval '10 minutes'))`, [key]);
  }

  async stopHosting(userId: string, port?: number): Promise<{ stopped: boolean; ports: number[] }> {
    const key = this.userKey(userId);
    const rows = await this.db.q<{ port: number; box_id: string }>(
      `update hosting set stop_requested_at=now()
        where user_key=$1 and ($2::int is null or port=$2) and stop_requested_at is null
        returning port, box_id`,
      [key, port ?? null],
    );
    await this.bumpActivity(userId);
    for (const r of rows) {
      try { await this.box.command(r.box_id, { command: hostingKillCommand(r.port), timeoutMs: 20_000 }); }
      catch { /* parked box: the durable intent + reconcile handle it */ }
    }
    return { stopped: rows.length > 0, ports: rows.map((r) => r.port) };
  }

  // ---------------------------------------------------------------- runtime snapshot

  /** ONE query powers every counter in the UI. */
  async userRuntimeStatus(userId: string): Promise<{
    boxId?: string;
    billingSinceEpochMs: number | null;
    billedSecondsTotal: number;
    holds: string[];
    activeTurn: boolean;
    idleStopEtaEpochMs: number | null;
    idleStopMs: number;
    hosting: Array<{ port: number; mode: string; url: string | null; conversationId: string; sinceEpochMs: number }>;
  }> {
    const key = this.userKey(userId);
    const idleStopMs = this.opts.autoStopIdleMs ?? 15_000;
    const row = await this.db.one<{
      box_id: string | null; billing_since: string | null; billed_seconds: number | null;
      last_activity_at: string | null; active_turns: number; holds: string[] | null;
    }>(
      `select b.id as box_id, b.billing_since, u.billed_seconds, u.last_activity_at,
              (select count(*)::int from turns t where t.user_key=$1 and t.status='active') as active_turns,
              (select array_agg(reason) from holds h where h.user_key=$1 and h.expires_at > now()) as holds
         from users u
         left join boxes b on b.user_key=u.key and b.purpose='user' and b.retired_at is null
        where u.key=$1`,
      [key],
    );
    const hosting = await this.db.q<{ port: number; mode: string; url: string | null; conversation_id: string; started_at: string }>(
      `select port, mode, url, conversation_id, started_at from hosting where user_key=$1 and stop_requested_at is null order by port`,
      [key],
    );
    const holds = [...(row?.holds ?? [])];
    if (hosting.length) holds.push(`hosting ${hosting.map((h) => `:${h.port}`).join(" ")}`);
    const billingSince = row?.billing_since ? Date.parse(row.billing_since) : null;
    const activeTurn = (row?.active_turns ?? 0) > 0;
    const lastActivity = row?.last_activity_at ? Date.parse(row.last_activity_at) : Date.now();
    return {
      ...(row?.box_id ? { boxId: row.box_id } : {}),
      billingSinceEpochMs: billingSince,
      billedSecondsTotal: Number(row?.billed_seconds ?? 0),
      holds,
      activeTurn,
      idleStopEtaEpochMs: billingSince !== null && !activeTurn && holds.length === 0
        ? Math.max(Date.now(), lastActivity + idleStopMs) : null,
      idleStopMs,
      hosting: hosting.map((h) => ({ port: h.port, mode: h.mode, url: h.url, conversationId: h.conversation_id, sinceEpochMs: Date.parse(h.started_at) })),
    };
  }

  // ---------------------------------------------------------------- desktop recording (phase 2)

  /**
   * Start a box-side screen recording of the X display the desktop stream shows
   * (Moonlight/noVNC both mirror :0). Detached via setsid so it outlives this
   * command; the pid is stashed so stopDesktopRecording can SIGINT it (which
   * lets ffmpeg flush the moov atom → a seekable, web-playable mp4). The file
   * lands in /home/user (rides the snapshot) and downloads via /api/fs/read.
   */
  private async startDesktopRecording(boxId: string, turnId: string): Promise<void> {
    const out = `/home/user/recordings/${turnId}.mp4`;
    const pid = `/home/user/recordings/${turnId}.pid`;
    await this.box.command(boxId, {
      command:
        `mkdir -p /home/user/recordings && ` +
        // Wait (≤15s) for the X display socket before grabbing — on a fresh box
        // the desktop may still be provisioning when the first desktop command
        // runs. If it never appears, ffmpeg exits and the clip stays empty, so
        // stopDesktopRecording reports nothing and no event is emitted.
        `setsid bash -c 'for i in $(seq 1 30); do [ -S /tmp/.X11-unix/X0 ] && break; sleep 0.5; done; ` +
        `DISPLAY=:0 XAUTHORITY=/var/run/lightdm/root/:0 ffmpeg -y -loglevel error ` +
        `-f x11grab -r 12 -draw_mouse 1 -i :0 -pix_fmt yuv420p -movflags +faststart ${out} ` +
        `>/tmp/rec-${turnId}.log 2>&1 & echo $! > ${pid}'`,
      timeoutMs: 20_000,
    });
  }

  /** SIGINT the recorder, wait for the flush, and report the finished size (0 = none). */
  private async stopDesktopRecording(boxId: string, turnId: string): Promise<{ ok: boolean; sizeKb: number }> {
    const out = `/home/user/recordings/${turnId}.mp4`;
    const pid = `/home/user/recordings/${turnId}.pid`;
    const r = await this.box.command(boxId, {
      command:
        `P=$(cat ${pid} 2>/dev/null); if [ -n "$P" ]; then kill -INT "$P" 2>/dev/null; ` +
        `for i in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done; fi; rm -f ${pid}; ` +
        `if [ -s ${out} ]; then echo "OK:$(( $(stat -c%s ${out}) / 1024 ))"; else echo NONE; fi`,
      timeoutMs: 30_000,
    });
    const m = (r.stdout || "").match(/OK:(\d+)/);
    return m ? { ok: true, sizeKb: Number(m[1]) } : { ok: false, sizeKb: 0 };
  }

  // ---------------------------------------------------------------- render journal (reopen = replay)

  /** Append one rendered event to the conversation's journal (verbatim). */
  async logEvent(userId: string, conversationId: string, turnId: string | null, body: unknown): Promise<void> {
    await this.db.q(
      `insert into events(user_key, conversation_id, turn_id, body) values($1,$2,$3,$4)`,
      [this.userKey(userId), conversationId, turnId, JSON.stringify(body)],
    );
  }

  /** The journal since a cursor (0 = from the start). Each row: its seq + the event body. */
  async getEvents(userId: string, conversationId: string, sinceSeq = 0): Promise<Array<{ seq: number; body: unknown }>> {
    const rows = await this.db.q<{ seq: string; body: unknown }>(
      `select seq, body from events where user_key=$1 and conversation_id=$2 and seq > $3 order by seq`,
      [this.userKey(userId), conversationId, sinceSeq],
    );
    return rows.map((r) => ({ seq: Number(r.seq), body: r.body }));
  }

  async getTranscript(userId: string, conversationId: string): Promise<TranscriptMessage[]> {
    const rows = await this.db.q<{ role: string; content: string; mode: string | null; at: string }>(
      `select role, content, mode, at from transcripts where user_key=$1 and conversation_id=$2 and scenario_id is null order by seq`,
      [this.userKey(userId), conversationId],
    );
    return rows.map((r) => {
      const msg: TranscriptMessage = { role: r.role as TranscriptMessage["role"], content: r.content, at: r.at };
      if (r.mode === "shared" || r.mode === "handoff" || r.mode === "user-box") msg.mode = r.mode;
      return msg;
    });
  }

  interrupt(turnId: string): boolean {
    const ac = this.turnAborts.get(turnId);
    if (ac) { ac.abort(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- the turn (rules 1/2/3/5/6)

  async *runTurn(input: ConsumerTurnInput): AsyncIterable<ConsumerTurnEvent> {
    const turnId = randomUUID();
    const userKey = this.userKey(input.userId);
    const convKey = this.convKey(userKey, input.conversationId);
    const harness = this.harnesses.get(input.selection.harness);
    if (!harness) { yield { type: "error", message: `Unknown harness '${input.selection.harness}'`, turnId }; return; }
    const abort = new AbortController();
    this.turnAborts.set(turnId, abort);
    const emit = (e: EventBody): ConsumerTurnEvent => ({ ...e, turnId } as ConsumerTurnEvent);
    try {
      // Register: user, conversation, transcript(user), turn row.
      await this.db.q(`insert into users(key) values($1) on conflict(key) do update set last_activity_at=now()`, [userKey]);
      await this.db.q(`insert into conversations(user_key, id) values($1,$2) on conflict do nothing`, [userKey, input.conversationId]);
      await this.db.q(`insert into transcripts(user_key, conversation_id, role, content) values($1,$2,'user',$3)`, [userKey, input.conversationId, input.message]);
      const fingerprint = fingerprintOf(input.message);
      const dup = await this.db.one<{ id: string }>(
        `select id from turns where user_key=$1 and conversation_id=$2 and fingerprint=$3
          and (status='active' or (status='answered' and done_at > now() - interval '60 seconds'))`,
        [userKey, input.conversationId, fingerprint],
      );
      await this.db.q(
        `insert into turns(id, user_key, conversation_id, message, fingerprint, status) values($1,$2,$3,$4,$5,'active')`,
        [turnId, userKey, input.conversationId, input.message, fingerprint],
      );
      yield emit({ type: "trace", stage: "turn.submit.accepted", message: "submit reached backend", harness: harness.name, model: input.selection.model });

      // Rule 5: warm + responsive box -> direct, no bridge. "Warm" requires
      // BOTH a live probe AND >=15s of machine age: a box in its first 15s of
      // billing is still hydrating (lazy disk restore, harness boot), so a
      // message landing then gets the shared answer exactly as if the machine
      // were off — the direct route earns its no-bridge silence only once the
      // machine is genuinely responsive-warm.
      const boxRow = await this.db.one<{ id: string; billing_since: string | null }>(
        `select id, billing_since from boxes where user_key=$1 and purpose='user' and retired_at is null`, [userKey],
      );
      let direct = false;
      const warmMinMs = this.opts.directMinWarmMs ?? 15_000;
      if (boxRow?.billing_since && !dup && Date.now() - Date.parse(boxRow.billing_since) >= warmMinMs) {
        try {
          const probe = await this.box.command(boxRow.id, { command: "echo __UP__", timeoutMs: 3_500 });
          direct = probe.stdout.includes("__UP__");
        } catch { direct = false; }
      }

      const boot = new EventQueue();
      let boxReady: Promise<BoxInfo>;
      if (direct && boxRow) {
        yield emit({ type: "trace", stage: "route.direct", message: "private box is warm and responsive; routing directly (rule 5)", harness: harness.name, model: input.selection.model, boxId: boxRow.id });
        boxReady = this.box.get(boxRow.id);
        boot.end();
      } else {
        boxReady = this.ensureUserBox(input.userId, input.conversationId, boot).finally(() => boot.end());
        boxReady.catch(() => undefined); // surfaced via the box-round await below
      }
      await this.wake(input.userId, "turn");

      let partialShared = "";
      if (!direct) {
        // Rules 1+3: the shared agent answers immediately (full or holding line — its choice).
        yield emit({ type: "trace", stage: "shared.bridge.start", message: "shared no-tools agent answers first (full answer or a short wait line — its own choice)", harness: harness.name, model: input.selection.model });
        const transcript = await this.getTranscript(input.userId, input.conversationId);
        const forkDirective = this.opts.scenariosEnabled
          ? [
              "PARALLEL EXPLORATION (overrides the 'never output tags' rule above, for this one tag only): the private runtime can pursue several directions AT ONCE on parallel machines. When the user's request presents two or three genuinely distinct directions — an explicit either/or ('should I do X or Y?', 'a minimal version or a full one?'), or a task with two clearly different valid approaches each worth building out in full — do NOT ask which one and do NOT pick just one.",
              "Instead: give a brief, neutral one- or two-sentence framing that names the directions, then end your reply with EXACTLY this hidden tag on its own final line: <optibox-fork>short label A | short label B</optibox-fork> — 2 or 3 labels, each 2-4 words naming one direction, separated by ' | '. The runtime explores every labelled direction in parallel and the user keeps the winner.",
              "This is the ONLY tag you may ever emit, and only for genuine multi-direction requests. Never mention or explain it. For a single unambiguous ask with no real alternatives, omit it entirely and answer normally.",
            ].join(" ")
          : undefined;
        const hidden = buildHiddenContext({ transcript, machine: { location: "shared-box", tools: false, status: "provisioning" } });
        yield emit({ type: "context.injected", scope: "shared", machine: { location: "shared-box", tools: false, status: "provisioning" }, hidden });
        try {
          for await (const text of harness.shared({
            userId: input.userId, conversationId: input.conversationId, message: input.message,
            transcript, selection: input.selection, capabilities: createRestrictedSharedCapabilities(),
            hiddenContext: hidden, machine: { location: "shared-box", tools: false, status: "provisioning" },
            ...(forkDirective ? { directive: forkDirective } : {}),
            signal: abort.signal,
          })) {
            const delta = typeof text === "string" ? text : (text as { text: string }).text;
            if (delta) { partialShared += delta; yield emit({ type: "shared.delta", text: delta, harness: harness.name, final: false }); }
            for (const e of boot.drain()) yield emit(e);
          }
        } catch (e) {
          yield emit({ type: "trace", stage: "shared.bridge.failed", message: e instanceof Error ? e.message : String(e), harness: harness.name, model: input.selection.model });
        }
        const sharedClean = stripForkTag(partialShared);
        if (sharedClean.trim()) {
          await this.db.q(`insert into transcripts(user_key, conversation_id, role, content, mode) values($1,$2,'assistant',$3,'shared')`, [userKey, input.conversationId, sharedClean]);
        }
      }
      for (const e of boot.drain()) yield emit(e);

      if (dup) {
        // A concurrent identical message already owns the box round.
        yield emit({ type: "trace", stage: "private-round.suppressed", message: "identical concurrent request already pending at the private runtime; no duplicate round", harness: harness.name, model: input.selection.model });
        await this.finishTurn(turnId, "suppressed");
        yield emit({ type: "turn.done", harness: harness.name, model: input.selection.model, route: "shared", settled: false });
        return;
      }

      // Rules 2+6: the box round, serialized per conversation.
      let box: BoxInfo;
      try {
        box = await boxReady;
        while (!boot.done) { await boot.wait(); for (const e of boot.drain()) yield emit(e); }
        for (const e of boot.drain()) yield emit(e);
      } catch (error) {
        await this.finishTurn(turnId, "blocked");
        yield emit({ type: "turn.blocked", stage: "box.runtime.unavailable", message: error instanceof Error ? (error.stack ?? error.message) : String(error), retryable: true, harness: harness.name, model: input.selection.model });
        return;
      }

      // Parallel scenarios (flagged): if the shared model marked the request
      // ambiguous, fan out into one private run per interpretation; otherwise the
      // ordinary single box round. The flag OFF => tag ignored => unchanged path.
      const forkLabels = this.opts.scenariosEnabled ? parseForkLabels(partialShared) : [];
      if (forkLabels.length >= 2) {
        yield* this.runScenarios(input, turnId, userKey, convKey, harness, box, partialShared, forkLabels, abort.signal);
      } else {
        yield* this.runBoxRound(input, turnId, userKey, convKey, harness, box, partialShared, abort.signal);
      }
    } finally {
      this.turnAborts.delete(turnId);
      await this.bumpActivity(input.userId).catch(() => undefined);
      // A turn can never be left 'active' — that would pin the box forever.
      await this.db.q(`update turns set status='interrupted', done_at=now() where id=$1 and status='active'`, [turnId]).catch(() => undefined);
    }
  }

  private async finishTurn(turnId: string, status: "answered" | "suppressed" | "blocked" | "interrupted"): Promise<void> {
    await this.db.q(`update turns set status=$2, done_at=now() where id=$1`, [turnId, status]);
  }

  private async *runBoxRound(
    input: ConsumerTurnInput,
    turnId: string,
    userKey: string,
    convKey: string,
    harness: HarnessAdapter,
    box: BoxInfo,
    partialShared: string,
    signal: AbortSignal,
    scenario?: { scenarioId: string; label: string },
  ): AsyncIterable<ConsumerTurnEvent> {
    // In scenario mode every event is stamped with the scenario so the UI routes
    // it to the right carousel pane; the box round otherwise runs identically.
    const emit = (e: EventBody): ConsumerTurnEvent =>
      ({ ...e, turnId, ...(scenario ? { scenarioId: scenario.scenarioId, scenarioLabel: scenario.label } : {}) } as ConsumerTurnEvent);
    // Desktop recording: armed the moment the agent's FIRST desktop-touching
    // tool runs (see onHarnessEvent), finalized after the round (see below).
    // recordingPath being non-null is the "a recording exists to stop" flag.
    let recordingPath: string | null = null;
    // Serialize box rounds per conversation; collect events through a queue so
    // the generator can stream while the locked work runs.
    const queue = new EventQueue();
    const work = this.db.withLock("conv", convKey, async () => {
      const push = (e: EventBody) => queue.push(e);
      // Bill THIS box (works for the user box and for a scenario box alike).
      await this.wakeBox(box.id, scenario ? "scenario" : "turn");
      push({ type: "billing.start", boxId: box.id, ratePerSecond: BOX_PRICE_USD_PER_SECOND, sinceEpochMs: Date.now(), pricing: BOX_PRICING });
      const transcript = await this.getTranscript(input.userId, input.conversationId);
      const recap = await this.recapper.recap(transcript);
      push({ type: "handoff.started", boxId: box.id, recap, harness: harness.name, model: input.selection.model });
      const machine = { location: "user-box" as const, tools: true, boxId: box.id, status: "live" as const };
      const hidden = buildHiddenContext({ transcript, machine, partialShared });
      push({ type: "context.injected", scope: "user-box", machine, hidden });

      const conv = await this.db.one<{ harness_sessions: Record<string, string> }>(
        `select harness_sessions from conversations where user_key=$1 and id=$2`, [userKey, input.conversationId],
      );
      const sessionKey = `${harness.name}:user-box:${box.id}`;
      const knownSessionId = conv?.harness_sessions?.[sessionKey];

      const caps = createUserBoxCapabilities(this.box, box.id, {
        ...(this.opts.providerEnv ? { providerEnv: this.opts.providerEnv } : {}),
        onExec: (info) => push({ type: "exec", boxId: box.id, ...info }),
        onHarnessEvent: (event) => {
          push({ type: "harness.tool", boxId: box.id, ...event });
          // Hosting detection at the source: a row with provenance, not a guess.
          if (event.phase === "tool_use" && typeof event.command === "string") {
            const m = event.command.match(HOST_CMD_RE);
            if (m) void this.markHosting(input.userId, input.conversationId, box.id, Number(m[1]), m[2] as "public" | "private").catch(() => undefined);
            // First desktop-touching command arms the screen recording (once).
            if (!recordingPath && isDesktopCommand(event.command)) {
              recordingPath = `recordings/${turnId}.mp4`;
              void this.startDesktopRecording(box.id, turnId).catch(() => { recordingPath = null; });
            }
          }
        },
      });

      let text = "";
      let sawEnd = false;
      let completion: HarnessCompletion = { reason: "completed" };
      for await (const chunk of harness.userBox({
        userId: input.userId, conversationId: input.conversationId, boxId: box.id,
        recap, latestUserMessage: input.message, transcript, selection: input.selection,
        capabilities: caps, hiddenContext: hidden, machine, partialShared,
        ...(knownSessionId ? { sessionId: knownSessionId } : {}),
        signal,
        onSessionId: (id: string) => {
          void this.db.q(
            `update conversations set harness_sessions = harness_sessions || $3::jsonb where user_key=$1 and id=$2`,
            [userKey, input.conversationId, JSON.stringify({ [sessionKey]: id })],
          ).catch(() => undefined);
        },
        onComplete: (info: HarnessCompletion) => { completion = info; },
      })) {
        const t = typeof chunk === "string" ? chunk : (chunk as { text: string }).text;
        if (!t) continue;
        text += t;
        if (text.trim() === "<end>") { sawEnd = true; continue; }
        push({ type: "user-box.delta", text: t, boxId: box.id, harness: harness.name, model: input.selection.model, messageId: "assistant-0", messageIndex: 0 });
      }
      if (signal.aborted) return { outcome: "interrupted" as const, text };
      const visible = text.replace(/<end>\s*$/, "").trim();
      if (sawEnd || /^\s*<end>\s*$/.test(text)) return { outcome: "silent" as const, text: "" };
      if (!visible) {
        // Rule 6 binding clause: no text and no <end> is LOUD, never silence.
        return { outcome: "blocked" as const, text: "", diagnostic: completion.diagnostic ?? `harness ended (${completion.reason}) with no answer and no <end>`, blockedEmitted: false };
      }
      // Scenario answers are tagged with scenario_id and kept OUT of the main
      // model-context transcript (getTranscript filters scenario_id is null) —
      // only the winner is merged in later. Ordinary turns write the main line.
      await this.db.q(
        `insert into transcripts(user_key, conversation_id, role, content, mode, scenario_id) values($1,$2,'assistant',$3,'box',$4)`,
        [userKey, input.conversationId, visible, scenario?.scenarioId ?? null],
      );
      return { outcome: "answered" as const, text: visible };
    });

    // Stream queue while the locked work runs.
    let result: Awaited<typeof work> | undefined;
    const done = work.then((r) => { result = r; queue.end(); }, async (e) => {
      // A box without its harness binary is constitutionally broken: retire the
      // row LOUDLY so the next message provisions a fresh warm-cycled fork
      // instead of crashing on the same corpse forever.
      if (e instanceof HarnessMissingError) {
        await this.db.q(`update boxes set retired_at=now(), billing_since=null where id=$1`, [box.id]).catch(() => undefined);
        queue.push({ type: "lifecycle", boxId: box.id, state: "retired", note: "box lacks its harness (template pipeline failure) — retired; next message provisions a fresh machine" });
      }
      queue.push({ type: "turn.blocked", stage: "box.round.crashed", message: e instanceof Error ? (e.stack ?? e.message) : String(e), retryable: true, harness: harness.name, model: input.selection.model });
      // blockedEmitted: the switch below must not emit a SECOND turn.blocked
      // (observed in prod: the same error rendered twice in chat).
      result = { outcome: "blocked", text: "", diagnostic: e instanceof Error ? e.message : String(e), blockedEmitted: true };
      queue.end();
    });
    while (!queue.done) { await queue.wait(); for (const e of queue.drain()) yield emit(e); }
    await done;
    for (const e of queue.drain()) yield emit(e);

    // Finalize any desktop recording: stop the recorder, then emit the finished
    // clip. It's a turnId event, so the journal captures it and reopening replays
    // the same <video> in place of the (long-gone) live stream.
    if (recordingPath && !signal.aborted) {
      const rec = await this.stopDesktopRecording(box.id, turnId).catch(() => ({ ok: false, sizeKb: 0 }));
      if (rec.ok && rec.sizeKb > 0) yield emit({ type: "desktop.recording", boxId: box.id, path: recordingPath, sizeKb: rec.sizeKb });
    }

    const idleMs = this.opts.autoStopIdleMs ?? 15_000;
    switch (result?.outcome) {
      case "answered":
      case "silent": {
        // In scenario mode the OUTER turn finalizes once after all scenarios;
        // the scenario boxes are stopped by the fan-out, not an idle countdown.
        if (!scenario) { await this.finishTurn(turnId, "answered"); await this.bumpActivity(input.userId); }
        yield emit({ type: "turn.done", boxId: box.id, harness: harness.name, model: input.selection.model, route: partialShared ? "bridge" : "direct", settled: true });
        if (!scenario) yield emit({ type: "autostop.timer", phase: "started", boxId: box.id, remainingMs: idleMs, deadlineEpochMs: Date.now() + idleMs, reason: "idle-after-response", note: "assistant finished; private Box auto-stops when the idle countdown reaches zero" });
        break;
      }
      case "interrupted":
        if (!scenario) await this.finishTurn(turnId, "interrupted");
        yield emit({ type: "trace", stage: "turn.interrupted", message: "turn aborted by the user; session preserved for resume", harness: harness.name, model: input.selection.model, boxId: box.id });
        break;
      default: {
        if (!scenario) await this.finishTurn(turnId, "blocked");
        // The crash path already streamed its turn.blocked — never render the
        // same failure twice (observed in prod as a doubled error bubble).
        if (!(result && "blockedEmitted" in result && (result as { blockedEmitted?: boolean }).blockedEmitted)) {
          const diag = (result && "diagnostic" in result ? (result as { diagnostic?: string }).diagnostic : undefined) ?? "box round produced no answer";
          yield emit({ type: "turn.blocked", stage: "box.no-answer", message: diag, retryable: true, harness: harness.name, model: input.selection.model, boxId: box.id });
        }
      }
    }
  }

  // ---------------------------------------------------------------- parallel scenarios (fan-out)

  /** Merge N concurrent scenario generators into one stream (already tagged). */
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
   * Fan a turn into one private run per interpretation. Each scenario gets its
   * OWN fresh box (fork of the warm template) and its own conv lock, so they run
   * truly in parallel; every event is scenario-tagged for the carousel UI. The
   * user's own box is paused (it isn't running these). Scenario boxes are
   * stopped+retired when the fan-out ends — step 3 (winner-select) will instead
   * keep the chosen one and merge its branch into the main line.
   */
  private async *runScenarios(
    input: ConsumerTurnInput, turnId: string, userKey: string, convKey: string,
    harness: HarnessAdapter, userBox: BoxInfo, partialShared: string, labels: string[], signal: AbortSignal,
  ): AsyncIterable<ConsumerTurnEvent> {
    const emitT = (e: EventBody): ConsumerTurnEvent => ({ ...e, turnId } as ConsumerTurnEvent);
    await this.endBilling(userBox.id).catch(() => undefined); // the user box isn't running the scenarios
    yield emitT({ type: "scenario.fork", groupId: turnId, labels });

    // Provision one scenario box per label, in parallel.
    const provisioned = await Promise.all(labels.map((label, i) =>
      this.createFreshBox(userKey, undefined, { purpose: "scenario", group: turnId, label })
        .then((box) => ({ ok: true as const, box, label, id: `s${i}` }))
        .catch((error) => ({ ok: false as const, error, label, id: `s${i}` })),
    ));
    const live = provisioned.filter((p): p is { ok: true; box: BoxInfo; label: string; id: string } => p.ok);
    for (const p of provisioned) {
      if (!p.ok) yield ({ type: "turn.blocked", stage: "scenario.provision.failed", message: `scenario "${p.label}" could not start: ${p.error instanceof Error ? p.error.message : String(p.error)}`, retryable: true, harness: harness.name, model: input.selection.model, turnId, scenarioId: p.id, scenarioLabel: p.label } as ConsumerTurnEvent);
    }
    try {
      const gens = live.map((s) => this.runBoxRound(
        { ...input, message: `${input.message}\n\n[Parallel-scenario mode: explore ONLY this interpretation — "${s.label}". Commit fully to it; do not hedge across the alternatives.]` },
        turnId, userKey, `${convKey}:${s.id}`, harness, s.box, partialShared, signal, { scenarioId: s.id, label: s.label },
      ));
      yield* this.mergeGenerators(gens);
    } finally {
      // Pause billing + retire the scenario boxes (belt-and-suspenders: the sweep
      // also reaps any purpose='scenario' leak from a crash mid-fan-out).
      for (const s of live) {
        await this.endBilling(s.box.id).catch(() => undefined);
        await this.box.stop(s.box.id).catch(() => undefined);
        await this.db.q(`update boxes set retired_at=now(), billing_since=null where id=$1`, [s.box.id]).catch(() => undefined);
      }
      await this.finishTurn(turnId, "answered").catch(() => undefined);
      await this.bumpActivity(input.userId).catch(() => undefined);
    }
  }
}

function hostingKillCommand(port: number): string {
  // `host hide <port>` is the CLI's authoritative takedown: it removes the port
  // from `host list` (so the ground-truth probe immediately sees it gone) and
  // drops the public exposure. ufw belt-and-suspenders in case a raw rule
  // lingers. The old `pkill -f 'host <port>'` is deliberately gone — it matched
  // the same phantom the probe did (any process whose argv contained the text).
  return (
    `host hide ${port} 2>/dev/null; ` +
    `sudo -n ufw delete allow ${port}/tcp 2>/dev/null; sudo -n ufw delete allow ${port} 2>/dev/null; ` +
    `sudo -n ufw deny ${port}/tcp 2>/dev/null; true`
  );
}
