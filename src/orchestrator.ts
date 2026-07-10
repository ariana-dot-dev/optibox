import { randomUUID } from "node:crypto";
import {
  createRestrictedSharedCapabilities,
  createUserBoxCapabilities,
} from "./capabilities.js";
import {
  BOX_PRICE_USD_PER_SECOND,
  BOX_PRICING,
  buildHiddenContext,
  type MachineState,
} from "./context.js";
import { ExtractiveRecapper } from "./recap.js";
import { RUNTIME_FEASIBILITY } from "./runtimeMatrix.js";
import { InMemorySessionStore } from "./store.js";
import type {
  BoxInfo,
  HarnessAdapter,
  HarnessCompletion,
  HarnessSelection,
  OrchestratorOptions,
  TranscriptMessage,
} from "./types.js";

export interface ConsumerTurnInput {
  userId: string;
  conversationId: string;
  message: string;
  selection: HarnessSelection;
}

export type ConsumerTurnEventBody =
  | { type: "trace"; stage: string; message: string; harness?: string; model?: string; boxId?: string; data?: Record<string, unknown> }
  | { type: "turn.blocked"; stage: string; message: string; retryable: boolean; harness?: string; model?: string; boxId?: string }
  | { type: "shared.delta"; text: string; harness: string; final?: boolean }
  | {
      type: "context.injected";
      scope: "shared" | "user-box";
      machine: MachineState;
      hidden: string;
    }
  | { type: "lifecycle"; state: string; boxId: string; note?: string }
  | {
      type: "autostop.timer";
      phase: "started" | "tick" | "canceled" | "stopping" | "held";
      boxId?: string | undefined;
      remainingMs: number;
      deadlineEpochMs?: number;
      reason: "idle-after-response" | "new-user-message" | "disabled";
      note: string;
    }
  | {
      type: "billing.start";
      boxId: string;
      ratePerSecond: number;
      sinceEpochMs: number;
      pricing: typeof BOX_PRICING;
    }
  | {
      type: "billing.stop";
      boxId: string;
      elapsedSeconds: number;
      costUsd: number;
      note: string;
    }
  | {
      type: "handoff.started";
      recap: string;
      boxId: string;
      harness: string;
      model: string;
    }
  | {
      type: "runtime.proof";
      boxId: string;
      harness: string;
      model: string;
      boxPromptApiUsed: false;
      boxBuiltInAgentUsed: false;
      hostAsciiAgentUsed: false;
      continuation: "in-box-runtime-harness";
      proofPath?: string;
      streaming?: string;
      blocker?: string | null;
    }
  | {
      type: "exec";
      kind: "command" | "harness";
      argv?: string[];
      command?: string;
      boxId: string;
    }
  | {
      type: "harness.tool";
      phase: "tool_use" | "tool_result";
      boxId: string;
      toolName?: string;
      command?: string;
      description?: string;
      stdout?: string;
      stderr?: string;
      isError?: boolean;
    }
  | {
      type: "user-box.delta";
      text: string;
      boxId: string;
      harness: string;
      model: string;
      /** Stable assistant-message key from the native harness stream. Different ids render as separate bubbles. */
      messageId?: string;
      messageIndex?: number;
    }
  | {
      type: "turn.done";
      boxId?: string;
      harness: string;
      model: string;
      route?: "shared" | "direct" | "bridge";
      /**
       * True when this accepted user prompt has a final answer/settlement. For
       * private routes that means the box agent's harness loop definitely settled
       * (clean native stream end or the hidden <end> sentinel). False marks a
       * visible prompt that only received latency/bridge text and is still owed a
       * final answer. Any false/unanswered prompt is a hard idle-stop blocker.
       */
      settled?: boolean;
    };

/**
 * Every emitted event carries a `turnId`. Because conversational turns can now
 * run CONCURRENTLY with a box turn (a follow-up answered by the shared agent
 * while the private box is still provisioning), two event streams interleave on
 * one conversation. The UI keys each chat bubble by `turnId` so concurrent
 * streams land in their own bubbles instead of corrupting each other.
 */
export type ConsumerTurnEvent = ConsumerTurnEventBody & { turnId?: string };

/** Precise, non-mutating snapshot of a conversation's private box. */
export type UserBoxStatus =
  | { kind: "none"; staleBoxId?: string }
  | { kind: "ready"; boxId: string; box: BoxInfo }
  | { kind: "provisioning"; boxId: string; box: BoxInfo }
  | { kind: "archiving"; boxId: string; box: BoxInfo }
  | { kind: "archived"; boxId: string; box: BoxInfo }
  | { kind: "error"; boxId: string; box: BoxInfo };

type UserBoxBootAction =
  | "already-ready"
  | "create-requested"
  | "fork-requested"
  | "resume-requested"
  | "existing-boot"
  | "adopt-ready"
  | "adopt-resume-requested"
  | "adopt-inflight";

interface UserBoxBootAck {
  action: UserBoxBootAction;
  box: BoxInfo;
}

type PrivateRoundState = "needed" | "active" | "answered" | "suppressed" | "stale";

class BoxTerminalStateError extends Error {
  constructor(readonly boxId: string, readonly state: string, readonly label: string) {
    super(`Box ${boxId} entered terminal state ${state} while waiting for ${label}`);
    this.name = "BoxTerminalStateError";
  }
}

interface PrivateRequestRound {
  id: string;
  fingerprint: string;
  message: string;
  state: PrivateRoundState;
  createdAt: number;
  updatedAt: number;
}

interface ConversationPrivateRequestState {
  active?: PrivateRequestRound;
  answeredFingerprints: Set<string>;
  rounds: Map<string, PrivateRequestRound>;
}

interface ConversationDiagnosticSnapshot {
  reason: string;
  key: string;
  turnSequence: number | null;
  latestTurnSequence: number | null;
  activeTurnCount: number;
  unansweredPromptCount: number;
  unansweredTurnIds: string[];
  activePrivateRound: { id: string; state: PrivateRoundState; ageMs: number; fingerprint: string } | null;
  privateRoundStates: Record<PrivateRoundState, number>;
  privateRoundIds: Array<{ id: string; state: PrivateRoundState; ageMs: number; fingerprint: string }>;
  answeredFingerprintCount: number;
  userBoxBootInFlight: boolean;
  boxLockQueued: boolean;
  billableBoxIds: string[];
  harnessSessionCount: number;
}

export class ConsumerBoxAgentOrchestrator {
  private readonly sessions;
  private readonly recapper;
  private readonly harnesses: Map<string, HarnessAdapter>;
  private readonly transcripts = new Map<string, TranscriptMessage[]>();
  /** boxId -> epoch ms when billing started (set once while running, cleared on stop). */
  private readonly billing = new Map<string, number>();
  /** Per-conversation in-flight private-box startup/resume, used to dedupe foreground handoffs. */
  private readonly userBoxStarts = new Map<string, Promise<BoxInfo>>();
  /** Per-conversation FIFO mutex for private Box work. */
  private readonly boxLocks = new Map<string, Promise<void>>();
  /** Monotonic per-conversation submit counter for tracing/order-sensitive bookkeeping. */
  private readonly turnSequences = new Map<string, number>();
  /** Number of response streams still active per conversation; auto-stop starts only when this reaches 0. */
  private readonly activeTurnCounts = new Map<string, number>();
  /** Accepted/visible user prompts that have not received a final answer yet. */
  private readonly unansweredPromptTurnIds = new Map<string, Set<string>>();
  /** Single authoritative per-conversation Box-request state machine. */
  private readonly privateRequests = new Map<string, ConversationPrivateRequestState>();
  /**
   * Per (conversation, harness, surface) CLI session id, so each surface resumes
   * its own conversation/session across turns without history loss. Keyed
   * `${userId}:${conversationId}:${harness}:${surface}` where surface is
   * "shared" | "user-box". Populated either up-front (assign strategy) or from
   * the id the CLI emits on turn 1 (capture strategy).
   */
  private readonly harnessSessions = new Map<string, string>();
  /** boxId -> the conversation that owns it, so the reaper can stop it by user/conversation. */
  private readonly boxOwners = new Map<string, { userId: string; conversationId: string; key: string }>();
  /** key -> last time this conversation had any turn activity (submit or stream end). */
  private readonly lastActivityAt = new Map<string, number>();
  /** Background idle-box reaper handle (see OrchestratorOptions.idleReaperIntervalMs). */
  private reaper: ReturnType<typeof setInterval> | undefined;
  /** Orphan candidates first sighted by the reaper (boxId -> epoch ms), for the grace window. */
  private readonly orphanSightings = new Map<string, number>();
  /** In-flight template build (deduped); resolves to the archived template or undefined on failure. */
  private templateBuild: Promise<BoxInfo | undefined> | undefined;
  /** Per-conversation abort controllers of in-flight turns (a new message aborts priors). */
  private readonly turnAborts = new Map<string, AbortController[]>();
  /**
   * Named keep-alive holds per userId: while any hold is active the user's box
   * is "still needed" — the idle countdown cancels/never starts and the idle
   * reaper skips it. First holder: in-flight uploads; more uses later. Every
   * hold carries a TTL so a leaked hold can never pin a VM (and the reaper's
   * hard billing ceiling still overrides everything).
   */
  private readonly boxHolds = new Map<string, Map<string, { reason: string; expiresEpochMs: number }>>();
  /** Boxes with an eager serve-prewarm in flight — dedupes the every-4s typing pings. */
  private readonly prewarmingBoxes = new Set<string>();
  /**
   * Cumulative billed seconds per user across every ended billing lifecycle
   * (fed only by endBilling). userRuntimeStatus surfaces it so the UI's
   * total/cost counters are a projection of server truth instead of a
   * client-side accumulator that drifts.
   */
  private readonly billedSecondsByUser = new Map<string, number>();
  /**
   * Users whose box is actively HOSTING an exposed service (the box `host
   * <port> --public|--private` CLI ran in a tool call). Unlike boxHolds this
   * deliberately has NO TTL: a hosted site must stay reachable until the user
   * explicitly stops hosting (stopHosting), so the box never idle-stops while
   * an entry exists. Surfaced through activeHoldReasons (countdown, reaper,
   * stop blockers all respect it) and userRuntimeStatus (header indicator).
   */
  private readonly hostingByUser = new Map<string, Map<number, { boxId: string; port: number; mode: "public" | "private"; sinceEpochMs: number; url?: string }>>();

  constructor(private readonly options: OrchestratorOptions) {
    this.sessions = options.sessions ?? new InMemorySessionStore();
    this.recapper = options.recapper ?? new ExtractiveRecapper();
    this.harnesses = new Map(options.harnesses.map((h) => [h.name, h]));
    if (this.harnesses.size === 0)
      throw new Error("At least one harness adapter is required");
    const reaperMs = options.idleReaperIntervalMs;
    if (typeof reaperMs === "number" && reaperMs > 0) {
      this.reaper = setInterval(() => { void this.reapIdleBoxes(); }, reaperMs);
      this.reaper.unref?.();
    }
  }

  /** Stop the background reaper (call when disposing a long-lived orchestrator). */
  dispose(): void {
    if (this.reaper) { clearInterval(this.reaper); this.reaper = undefined; }
  }

  /**
   * Force-stop any billable Box whose conversation has been idle past
   * autoStopIdleMs. Runs on a timer, independent of any request stream, so a box
   * cannot be left running by an abandoned/blocked/hung turn. Idempotent with the
   * request-driven auto-stop: whichever fires first wins; stop is a no-op after.
   */
  private async reapIdleBoxes(): Promise<void> {
    const now = Date.now();
    const idleThreshold = this.options.autoStopIdleMs ?? 5000;
    const hardCeilingMs = this.options.maxBillingAgeMs ?? 30 * 60_000;
    for (const [boxId, owner] of [...this.boxOwners]) {
      const since = this.billing.get(boxId);
      if (since === undefined) { this.boxOwners.delete(boxId); continue; }
      const key = owner.key;
      // A box billing past the absolute ceiling is force-stopped no matter what:
      // a turn that has "run" for half an hour is stuck, not working, and must
      // never pin a VM for hours/days. This is the last-resort leak guard.
      const overHardCeiling = now - since >= hardCeilingMs;
      if (!overHardCeiling) {
        // Otherwise never reap a genuinely busy conversation: an active stream, an
        // owed private round, an in-flight boot, or a keep-alive hold (e.g. an
        // upload in progress) all mean real work is happening.
        if (this.activeTurnCounts.has(key) || this.activePrivateRound(key) || this.userBoxStarts.has(key)) continue;
        if (this.activeHoldReasons(owner.userId).length > 0) continue;
        if (now - (this.lastActivityAt.get(key) ?? now) < idleThreshold) continue;
      }
      await this.reapBox(boxId, key, overHardCeiling);
    }
    await this.reapOrphanBoxes(now);
  }

  /**
   * Stop running boxes this PROCESS doesn't know about but that match our naming
   * (options.orphanBoxName). These exist after a server restart (in-memory billing
   * is gone) or from older builds that leaked never-stopping boxes. A box must be
   * sighted running-and-unbilled twice, a grace window apart, before it is stopped
   * — so a box another code path is actively booting right now is never sniped.
   */
  private async reapOrphanBoxes(now: number): Promise<void> {
    const isOurs = this.options.orphanBoxName;
    if (!isOurs || !this.options.box.list) return;
    // Two sweep intervals (or the idle window, whichever is longer): long enough
    // that a box WE are booting right now has registered billing (that happens at
    // boot-ack, before the box is even ready), short enough to matter.
    const graceMs = Math.max(2 * (this.options.idleReaperIntervalMs ?? 15_000), this.options.autoStopIdleMs ?? 5000);
    const boxes = await this.options.box.list().catch(() => []);
    const seenIds = new Set<string>();
    for (const box of boxes) {
      if (!box.name || !isOurs(box.name)) continue;
      // Never reap the template: it legitimately runs unbilled during its
      // one-time background build (its own TTL is the leak backstop).
      if (this.options.userBoxTemplate && box.name === this.options.userBoxTemplate.name) continue;
      if (box.state === "archived" || box.state === "archiving" || box.state === "stopped") continue;
      // External wakes (typing/upload) register billing via registerExternalWake,
      // so a deliberately-woken box is never mistaken for an orphan here.
      if (this.billing.has(box.id)) { this.orphanSightings.delete(box.id); continue; }
      // A box HOSTING an exposed service is intentionally up even when nothing
      // bills it (e.g. after a server restart rebuilt hosting state from the
      // pgrep ground truth) — never orphan-reap a user's live site.
      if ([...this.hostingByUser.values()].some((services) => [...services.values()].some((s) => s.boxId === box.id))) { this.orphanSightings.delete(box.id); continue; }
      seenIds.add(box.id);
      const firstSeen = this.orphanSightings.get(box.id);
      if (firstSeen === undefined) { this.orphanSightings.set(box.id, now); continue; }
      if (now - firstSeen < graceMs) continue;
      this.orphanSightings.delete(box.id);
      await this.options.box.stop(box.id).catch(() => undefined);
    }
    // Drop sightings for boxes that disappeared or stopped on their own.
    for (const id of [...this.orphanSightings.keys()]) if (!seenIds.has(id)) this.orphanSightings.delete(id);
  }

  /** Force-stop one specific billable box under the conversation lock. */
  private async reapBox(boxId: string, key: string, force = false): Promise<void> {
    const release = await this.acquireLock(this.boxLocks, key);
    try {
      // Re-check under the lock: a turn may have started using the box while we
      // waited. Stop the box directly by id — it may be an orphaned prior box
      // (e.g. a stuck resume), not the conversation's current session box. When
      // `force` (over the hard billing ceiling) we stop even a "busy" conversation.
      if (!force && (this.activeTurnCounts.has(key) || this.activePrivateRound(key) || this.userBoxStarts.has(key))) return;
      if (this.endBilling(boxId) === undefined) return;
      this.boxOwners.delete(boxId);
      await this.options.box.stop(boxId).catch(() => undefined);
    } finally {
      release();
    }
  }

  listHarnesses(): HarnessAdapter[] {
    return [...this.harnesses.values()];
  }

  getTranscript(userId: string, conversationId: string): TranscriptMessage[] {
    return this.transcripts.get(`${userId}:${conversationId}`) ?? [];
  }

  /** FIFO mutex over a given lock map: resolves to a release fn once it's our turn. */
  private async acquireLock(
    map: Map<string, Promise<void>>,
    key: string,
  ): Promise<() => void> {
    const prev = map.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    map.set(key, tail);
    await prev; // block until the previous holder releases
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (map.get(key) === tail) map.delete(key);
    };
  }

  private harness(name: string): HarnessAdapter {
    const h = this.harnesses.get(name);
    if (!h)
      throw new Error(
        `Unknown harness '${name}'. Registered: ${[...this.harnesses.keys()].join(", ")}`,
      );
    return h;
  }

  /**
   * Precise, race-aware snapshot of the user's box WITHOUT mutating anything.
   * This is what makes routing state-aware: runTurn calls this first and picks
   * the path (direct vs. bridge) from the exact state, instead of always
   * shared-first. Tolerant of stale/dangling box IDs (treated as "none").
   */
  async userBoxStatus(
    userId: string,
    conversationId: string,
  ): Promise<UserBoxStatus> {
    const existing = await this.sessions.get(userId, conversationId);
    if (!existing?.boxId) return { kind: "none" };
    const box = await this.options.box
      .get(existing.boxId)
      .catch(() => undefined);
    if (!box) return { kind: "none", staleBoxId: existing.boxId };
    if (box.state === "error") return { kind: "error", boxId: box.id, box };
    if (isReady(box.state)) return { kind: "ready", boxId: box.id, box };
    if (box.state === "archived" || box.state === "stopped")
      return { kind: "archived", boxId: box.id, box };
    if (box.state === "archiving")
      return { kind: "archiving", boxId: box.id, box };
    return { kind: "provisioning", boxId: box.id, box };
  }

  async ensureUserBox(
    userId: string,
    conversationId: string,
    onBootAck?: (ack: UserBoxBootAck) => void,
  ): Promise<BoxInfo> {
    const key = `${userId}:${conversationId}`;
    const inFlight = this.userBoxStarts.get(key);
    if (inFlight) {
      // A joiner's onBootAck must STILL fire, from the in-flight boot's own
      // resolution. Dropping it (the old behavior) left the joining turn's
      // bootAckPromise unsettled forever — and the turn's pre-runtime
      // checkpoint awaited that promise uncapped, wedging the whole
      // conversation. Live trigger: wake-on-type cold-boots the box, then the
      // user's first real message dedupe-joins that in-flight boot here.
      if (onBootAck) inFlight.then((box) => onBootAck({ action: "existing-boot", box })).catch(() => undefined);
      return inFlight;
    }
    const started = this.ensureUserBoxUncached(userId, conversationId, onBootAck);
    this.userBoxStarts.set(key, started);
    try {
      return await this.withTimeout(
        started,
        this.options.handoffTimeoutMs ?? 120_000,
        `Timed out waiting for private Box boot/handoff for ${key}`,
      );
    } finally {
      if (this.userBoxStarts.get(key) === started)
        this.userBoxStarts.delete(key);
    }
  }

  private async ensureUserBoxUncached(
    userId: string,
    conversationId: string,
    onBootAck?: (ack: UserBoxBootAck) => void,
  ): Promise<BoxInfo> {
    const existing = await this.sessions.get(userId, conversationId);
    if (existing?.boxId) {
      // Tolerate a stale/dangling box id (deleted out from under us): fall
      // through to create a fresh one rather than throwing.
      const box = await this.options.box
        .get(existing.boxId)
        .catch(() => undefined);
      if (box) {
        if (box.state === "archiving") {
          await this.waitUntilArchived(existing.boxId, "archive-before-resume");
          await this.options.box.resume(existing.boxId);
          onBootAck?.({ action: "resume-requested", box: await this.options.box.get(existing.boxId).catch(() => box) });
          return this.waitUntilReady(
            existing.boxId,
            "resume",
            this.options.resumeTimeoutMs,
          );
        }
        if (box.state === "archived") {
          await this.options.box.resume(existing.boxId);
          onBootAck?.({ action: "resume-requested", box: await this.options.box.get(existing.boxId).catch(() => box) });
          try {
            return await this.waitUntilReady(
              existing.boxId,
              "resume",
              this.options.resumeTimeoutMs,
            );
          } catch (e) {
            if (e instanceof BoxTerminalStateError) throw e;
            return this.createFreshUserBox(userId, conversationId, onBootAck);
          }
        }
        if (isReady(box.state)) {
          onBootAck?.({ action: "already-ready", box });
          return box;
        }
        if (box.state !== "error") {
          onBootAck?.({ action: "existing-boot", box });
          try {
            return await this.waitUntilReady(existing.boxId, "existing");
          } catch (e) {
            if (e instanceof BoxTerminalStateError) throw e;
            await this.clearSession(userId, conversationId);
            return this.createFreshUserBox(userId, conversationId, onBootAck);
          }
        }
        await this.clearSession(userId, conversationId);
        // error state -> fall through and provision a fresh box
      }
    }
    const adopted = await this.findReusableNamedUserBox(userId, conversationId, onBootAck);
    if (adopted) return adopted;
    return this.createFreshUserBox(userId, conversationId, onBootAck);
  }

  private async findReusableNamedUserBox(
    userId: string,
    conversationId: string,
    onBootAck?: (ack: UserBoxBootAck) => void,
  ): Promise<BoxInfo | undefined> {
    if (!this.options.box.list) return undefined;
    const expectedName =
      this.options.userBoxName?.(userId) ?? `consumer-agent-user-${userId}`;
    const boxes = await this.options.box.list().catch(() => []);
    // EVERY non-error state is adoptable. Filtering to ready|archived twice
    // produced same-named duplicates in production: first a mid-ARCHIVING box
    // was invisible here, then a mid-STARTING one (woken seconds earlier by a
    // typing/upload external wake) — each time a turn created a FRESH box with
    // the SAME name and every name-based lookup then flipped a coin. The
    // invariant is one user = one box; a box that is booting gets awaited, not
    // duplicated.
    const reusable = boxes
      .filter((box) => box.name === expectedName && box.state !== "error")
      .sort((a, b) => {
        // Prefer a warm ready Box. Otherwise prefer the newest archived snapshot
        // over creating a fresh Box; this preserves the same user conversation
        // and avoids poisoning second turns with long-lived provisioning rows.
        const ar = isReady(a.state) ? 1 : 0;
        const br = isReady(b.state) ? 1 : 0;
        if (ar !== br) return br - ar;
        const as = (a as any).snapshotAvailable ? 1 : 0;
        const bs = (b as any).snapshotAvailable ? 1 : 0;
        if (as !== bs) return bs - as;
        const au = Date.parse(String((a as any).updatedAt ?? ""));
        const bu = Date.parse(String((b as any).updatedAt ?? ""));
        return (Number.isFinite(bu) ? bu : 0) - (Number.isFinite(au) ? au : 0);
      })[0];
    if (!reusable) return undefined;
    await this.sessions.put({
      userId,
      conversationId,
      boxId: reusable.id,
      lastSeenAt: Date.now(),
    });
    let box = reusable;
    if (box.state === "archiving" || box.state === "archived" || box.state === "stopped") {
      try {
        // Mid-archive: let the snapshot finish, then resume — same pattern as
        // the per-session path. Never fall through to a fresh same-named box.
        if (box.state === "archiving") await this.waitUntilArchived(box.id, "adopt-archiving");
        await this.options.box.resume(box.id);
        onBootAck?.({ action: "adopt-resume-requested", box: await this.options.box.get(box.id).catch(() => box) });
        box = await this.waitUntilReady(box.id, "adopt-archived", this.options.resumeTimeoutMs);
      } catch (e) {
        if (e instanceof BoxTerminalStateError) throw e;
        await this.clearSession(userId, conversationId);
        return undefined;
      }
    } else if (isReady(box.state)) {
      onBootAck?.({ action: "adopt-ready", box });
      box = await this.waitUntilReady(reusable.id, "adopt-existing");
    } else {
      // starting/resuming/etc — an external wake (typing, upload) or another
      // request is booting this box RIGHT NOW. Wait for it; do not duplicate.
      try {
        onBootAck?.({ action: "adopt-inflight", box });
        box = await this.waitUntilReady(box.id, "adopt-inflight", this.options.resumeTimeoutMs);
      } catch (e) {
        if (e instanceof BoxTerminalStateError) throw e;
        await this.clearSession(userId, conversationId);
        return undefined;
      }
    }
    return this.options.userBoxTtlSeconds === null
      ? box
      : this.options.box.update(box.id, {
          ttlSeconds: this.options.userBoxTtlSeconds ?? 3600,
        });
  }

  private async createFreshUserBox(
    userId: string,
    conversationId: string,
    onBootAck?: (ack: UserBoxBootAck) => void,
  ): Promise<BoxInfo> {
    const name = this.options.userBoxName?.(userId) ?? `consumer-agent-user-${userId}`;
    const ttlSeconds = this.options.userBoxTtlSeconds ?? 3600;
    // INVARIANT: one user = one box name = one box. This is the only place a
    // user box is created, so enforce it mechanically: any surviving box that
    // still carries the name (adoption gave up on it) gets renamed out of the
    // namespace first — a same-named duplicate corrupts every name-based
    // lookup (observed twice: files staged onto one box while the agent ran
    // on the other).
    if (this.options.box.list) {
      const existing = (await this.options.box.list().catch(() => [])).filter((b) => b.name === name);
      for (const stale of existing) {
        await this.options.box
          .update(stale.id, { name: `${name}-superseded-${Date.now().toString(36)}` })
          .catch(() => undefined);
      }
    }
    // A brand-new box has a brand-new harness session store. Carrying an old
    // box's native session id onto it makes `opencode run -s <unknown-id>` hang
    // forever (cross-store resume). Drop user-box session ids for this
    // conversation; the full transcript still rides in the hidden context.
    const key = `${userId}:${conversationId}`;
    for (const sessionKey of [...this.harnessSessions.keys()]) {
      if (sessionKey.startsWith(`${key}:`) && sessionKey.endsWith(":user-box")) this.harnessSessions.delete(sessionKey);
    }
    // Fast path: fork the pre-installed template snapshot (restore ≈ constant
    // ~16s) instead of creating an empty box and npm-installing the harness
    // inside it (~15-40s, npm-registry variant). Falls back to plain create on
    // any fork problem — the per-turn bin check still installs on demand.
    const forked = await this.forkFromTemplate(name, ttlSeconds, onBootAck).catch(() => undefined);
    if (forked) {
      await this.sessions.put({ userId, conversationId, boxId: forked.id, lastSeenAt: Date.now() });
      return forked;
    }
    const created = await this.options.box.create({ name, ttlSeconds });
    onBootAck?.({ action: "create-requested", box: created });
    const ready = await this.waitUntilReady(created.id, "create");
    await this.sessions.put({
      userId,
      conversationId,
      boxId: ready.id,
      lastSeenAt: Date.now(),
    });
    return ready;
  }

  /** Fork a new user box from the template snapshot; undefined when unavailable. */
  private async forkFromTemplate(
    name: string,
    ttlSeconds: number | null,
    onBootAck?: (ack: UserBoxBootAck) => void,
  ): Promise<BoxInfo | undefined> {
    const template = this.options.userBoxTemplate;
    if (!template || !this.options.box.fork || !this.options.box.list) return undefined;
    // Only an ARCHIVED/STOPPED template may serve forks: its snapshot then
    // provably contains the finished install. A still-running template can
    // report snapshotAvailable from a snapshot taken BEFORE the install.
    const existing = (await this.options.box.list().catch(() => []))
      .find((b) => b.name === template.name && (b.state === "archived" || b.state === "stopped"));
    if (!existing) {
      // No template yet: build it in the background (deduped) and let THIS boot
      // take the legacy path — the user should not wait on a template build.
      this.templateBuild ??= this.buildTemplateBox().catch(() => undefined);
      return undefined;
    }
    const forked = await this.options.box.fork(existing.id);
    await this.options.box.update(forked.id, { name, ttlSeconds }).catch(() => undefined);
    onBootAck?.({ action: "fork-requested", box: forked });
    return this.waitUntilReady(forked.id, "fork");
  }

  /** One-time background build: create -> install harness deps -> stop (snapshot). */
  private async buildTemplateBox(): Promise<BoxInfo | undefined> {
    const template = this.options.userBoxTemplate;
    if (!template) return undefined;
    let boxId: string | undefined;
    try {
      const created = await this.options.box.create({ name: template.name, ttlSeconds: 3600 });
      boxId = created.id;
      const ready = await this.waitUntilReady(created.id, "template-create");
      // Detached install + exit-marker polling, NOT one synchronous command: npm
      // installs routinely exceed the Box command API's hard 60s execution cap
      // (and previously also the HTTP client's 30s request cap, which aborted
      // every 30-60s build mid-flight — the template never built, so each fresh
      // user box npm-installed the harness inside the user's first turn: 15-60s
      // of billed silence before the agent's first action).
      const script = `( ${template.installCmd} ) >/tmp/.tpl-install.log 2>&1; echo $? >/tmp/.tpl-install.exit`;
      await this.options.box.command(ready.id, {
        command: `rm -f /tmp/.tpl-install.exit; nohup bash -c '${script.replace(/'/g, `'\\''`)}' >/dev/null 2>&1 & echo started`,
        timeoutMs: 15_000,
      });
      // Poll cadence scales with readinessPollMs (tests run it at 1ms); total
      // budget stays 5 minutes regardless of cadence.
      const installPollMs = Math.min(5_000, Math.max(1, this.options.readinessPollMs ?? 5_000));
      const installDeadline = Date.now() + 300_000;
      let installExit: string | undefined;
      while (installExit === undefined && Date.now() < installDeadline) {
        await new Promise((r) => setTimeout(r, installPollMs));
        const probe = await this.options.box
          .command(ready.id, { command: "cat /tmp/.tpl-install.exit 2>/dev/null || true", timeoutMs: 15_000 })
          .catch(() => undefined);
        const out = probe?.stdout.trim();
        if (out) installExit = out;
      }
      if (installExit !== "0") {
        const tail = await this.options.box
          .command(ready.id, { command: "tail -c 400 /tmp/.tpl-install.log 2>/dev/null || true", timeoutMs: 15_000 })
          .catch(() => undefined);
        throw new Error(`template install ${installExit === undefined ? "timed out after 300s" : `failed (exit=${installExit})`}: ${(tail?.stdout ?? "").trim().slice(-300)}`);
      }
      // The platform refuses to stop a box until it has a successful snapshot
      // ("no successful snapshot in the last 30 minutes" on young boxes), so a
      // single stop right after install can be rejected. Retry until accepted.
      await this.stopWithRetry(ready.id, "template-stop");
      const archived = await this.waitUntilArchived(ready.id, "template-snapshot", 300_000);
      if (!template.warmCmd) return archived;
      // Warm pass: resume the just-snapshotted template and exercise the exact
      // cold path a fork's first turn takes (harness launch faulting its module
      // tree through the lazy-restore disk), then snapshot again. The platform
      // records the resume-time access order and prefetches it on later
      // forks/resumes, so a fork's first harness launch streams the right
      // blocks up front instead of faulting them one read at a time (measured
      // on a fresh fork: cold `pi --version` 3.25s vs warm 1.07s). Best-effort:
      // a failed warm pass keeps the perfectly valid install snapshot.
      try {
        await this.options.box.resume(ready.id);
        await this.waitUntilReady(ready.id, "template-warm-resume");
        await this.options.box.command(ready.id, { command: template.warmCmd, timeoutMs: 55_000 });
        await this.stopWithRetry(ready.id, "template-warm-stop");
        return await this.waitUntilArchived(ready.id, "template-warm-snapshot", 300_000);
      } catch (warmError) {
        console.error(`[optibox] template warm pass failed (install snapshot still valid):`, warmError instanceof Error ? warmError.message : String(warmError));
        await this.options.box.stop(ready.id).catch(() => undefined);
        return archived;
      }
    } catch (error) {
      // This runs detached from any turn stream, so "loud" = the server log, and
      // the box must ALWAYS be stopped on failure or it runs until its TTL.
      if (boxId) await this.options.box.stop(boxId).catch(() => undefined);
      this.templateBuild = undefined; // allow a later boot to retry the build
      console.error(`[optibox] template box build failed${boxId ? ` (box ${boxId}, stop requested)` : ""}:`, error instanceof Error ? (error.stack ?? error.message) : String(error));
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async clearSession(userId: string, conversationId: string): Promise<void> {
    if (this.sessions.delete) await this.sessions.delete(userId, conversationId);
  }

  private async ensureUserBoxWithRecovery(
    userId: string,
    conversationId: string,
    status: UserBoxStatus,
    emit: (event: ConsumerTurnEventBody) => void,
    onBootAck?: (ack: UserBoxBootAck) => void,
  ): Promise<BoxInfo> {
    if (status.kind === "archived" || status.kind === "archiving") {
      const oldBoxId = status.boxId;
      try {
        if (status.kind === "archiving")
          await this.waitUntilArchived(
            oldBoxId,
            "archive-before-resume",
            this.options.resumeTimeoutMs,
          );
        emit({
          type: "lifecycle",
          boxId: oldBoxId,
          state: "resuming",
          note: "resuming private box from disk snapshot",
        });
        await this.options.box.resume(oldBoxId);
        onBootAck?.({ action: "resume-requested", box: await this.options.box.get(oldBoxId).catch(() => status.box) });
        return await this.waitUntilReady(
          oldBoxId,
          "resume",
          this.options.resumeTimeoutMs,
        );
      } catch (e) {
        if (e instanceof BoxTerminalStateError) {
          emit({
            type: "lifecycle",
            boxId: oldBoxId,
            state: e.state,
            note: `private Box resume ended in terminal state ${e.state}; a retry can request a fresh runtime`,
          });
          throw e;
        }
        emit({
          type: "lifecycle",
          boxId: oldBoxId,
          state: "resume-timeout",
          note: `resume did not become ready within ${this.options.resumeTimeoutMs ?? this.options.handoffTimeoutMs ?? 120_000}ms — keeping shared chat live and provisioning a fresh private box`,
        });
        const fresh = await this.createFreshUserBox(userId, conversationId, onBootAck);
        emit({
          type: "lifecycle",
          boxId: fresh.id,
          state: fresh.state,
          note: "fresh private box recovered from stale resume",
        });
        return fresh;
      }
    }
    return this.ensureUserBox(userId, conversationId, onBootAck);
  }

  async *runTurn(input: ConsumerTurnInput): AsyncIterable<ConsumerTurnEvent> {
    const key = `${input.userId}:${input.conversationId}`;
    const turnId = randomUUID();
    const turnSequence = this.bumpTurnSequence(key);
    // A new user message INTERRUPTS any in-flight turn for this conversation:
    // abort signals flow to the running harnesses (SIGINT, like a human "stop"),
    // their streams end, and this message runs as the fresh authoritative turn.
    for (const prior of this.turnAborts.get(key) ?? []) prior.abort();
    const turnAbort = new AbortController();
    this.turnAborts.set(key, [...(this.turnAborts.get(key) ?? []), turnAbort]);
    this.lastActivityAt.set(key, Date.now());
    this.registerUnansweredPrompt(key, turnId);
    this.activeTurnCounts.set(key, (this.activeTurnCounts.get(key) ?? 0) + 1);
    // Do not await the remote Box status before emitting. A slow Box API check
    // made the preview look like Send did nothing because no SSE bytes were
    // flushed until userBoxStatus resolved. Status still runs immediately.
    const statusPromise = this.userBoxStatus(input.userId, input.conversationId);
    const lockBusyAtSubmit = this.boxLocks.has(key);

    yield {
      type: "trace",
      stage: "turn.submit.accepted",
      message: lockBusyAtSubmit
        ? "submit reached backend while private runtime is busy/stopping; shared assistant will answer first"
        : "submit reached backend; checking private runtime state",
      harness: input.selection.harness,
      model: input.selection.model,
      data: {
        lockBusyAtSubmit,
        conversation: this.diagnosticSnapshot(key, "turn.submit.accepted", turnSequence),
      },
      turnId,
    };

    // The auto-stop must be armed by the BOX agent finishing, never by the shared
    // assistant finishing. We watch this turn's event stream for two facts:
    //  - boxAgentSettled: the agent ON the box produced its final output for THIS
    //    message — a real answer (turn.done route direct/bridge) or the hidden
    //    <end> sentinel (trace user-box.response.end). This is the only signal
    //    that may start the idle countdown.
    //  - routedToPrivate: this turn engaged or queued the private box at all. A
    //    turn that needed the box but did NOT settle it (e.g. the shared bridge
    //    said "I'm looking into it" and the box has not answered yet) must never
    //    stop the box out from under the pending answer.
    let boxAgentSettled = false;
    let routedToPrivate = false;
    let promptAnswered = false;
    try {
      for await (const ev of this.runAdaptiveTurn(
        input,
        key,
        turnSequence,
        statusPromise,
        lockBusyAtSubmit,
        turnAbort.signal,
      )) {
        if (ev.type === "trace" && ev.stage === "user-box.response.end") boxAgentSettled = true;
        if (ev.type === "turn.done" && Boolean(ev.boxId) && (ev.route === "direct" || ev.route === "bridge") && ev.settled === true) boxAgentSettled = true;
        if (ev.type === "turn.done" && ev.settled !== false) promptAnswered = true;
        if (ev.type === "turn.blocked") promptAnswered = true;
        if (
          ev.type === "handoff.started" ||
          ev.type === "user-box.delta" ||
          ev.type === "billing.start" ||
          (ev.type === "turn.done" && Boolean(ev.boxId)) ||
          (ev.type === "trace" && PRIVATE_ROUTE_TRACE_STAGES.has(ev.stage))
        ) routedToPrivate = true;
        yield { ...ev, turnId };
      }
    } finally {
      // The turn's stream has ended — clean turn.done, a block, an abort, or a
      // client disconnect. Whatever happened, the user is no longer waiting on
      // THIS prompt, so it must never keep blocking idle auto-stop. (A prompt
      // that dangled forever — e.g. a turn queued behind an active round whose
      // SSE the client abandoned — was exactly what kept boxes running for days.)
      // Box-settling is protected separately by the roundOwed / activePrivateRound
      // / bootInFlight gates, not by holding the prompt "unanswered".
      this.markPromptAnswered(key, turnId);
      this.lastActivityAt.set(key, Date.now());
      const aborts = (this.turnAborts.get(key) ?? []).filter((c) => c !== turnAbort);
      if (aborts.length === 0) this.turnAborts.delete(key); else this.turnAborts.set(key, aborts);
      // If the browser closes/aborts the SSE stream after the shared bridge but
      // before the private handoff completes, the generator is returned early.
      // Always clear the active stream count so a canceled preview request cannot
      // leave the conversation permanently "active" and block future settlement.
      const activeTurns = Math.max(0, (this.activeTurnCounts.get(key) ?? 1) - 1);
      if (activeTurns === 0) this.activeTurnCounts.delete(key);
      else this.activeTurnCounts.set(key, activeTurns);
    }

    yield {
      ...this.traceState(
        key,
        "turn.stream.finalized",
        "turn stream finalized; evaluating unanswered prompts, private rounds, active streams, and auto-stop eligibility",
        input,
        turnSequence,
        { promptAnswered, boxAgentSettled, routedToPrivate },
      ),
      turnId,
    };

    // Keep the Box warm briefly after all current responses are done. Any user
    // message bumps turnSequences[key] immediately, which cancels/freezes an
    // existing countdown.
    const session = await this.sessions.get(input.userId, input.conversationId);
    const hasBillableBox = Boolean(session?.boxId && this.billing.has(session.boxId));
    // Never arm the idle-stop while a private round is still owed (needed/active)
    // or a Box boot is still in flight.
    const roundOwed = Boolean(this.activePrivateRound(key));
    const bootInFlight = this.userBoxStarts.has(key);
    // Arm only when the box agent actually finished this turn, OR when this was a
    // pure shared turn (it never touched the box) that left a warm billable box
    // idle. The middle case — routed to the box but the agent has not settled —
    // is exactly the bug where a shared "I'm looking into it" stopped a box that
    // had not yet had a chance to answer.
    const armForBoxDone = boxAgentSettled;
    const armForWarmSharedOnly = !routedToPrivate && hasBillableBox;
    yield {
      ...this.traceState(
        key,
        "autostop.gate.evaluated",
        (armForBoxDone || armForWarmSharedOnly) &&
          !this.activeTurnCounts.has(key) &&
          !this.hasUnansweredPrompts(key) &&
          !roundOwed &&
          !bootInFlight
          ? "idle auto-stop gate is clear; countdown may start"
          : "idle auto-stop gate is blocked; Box will remain running until all blockers clear",
        input,
        turnSequence,
        {
          hasBillableBox,
          roundOwed,
          bootInFlight,
          armForBoxDone,
          armForWarmSharedOnly,
          activeTurnBlocked: this.activeTurnCounts.has(key),
          unansweredPromptBlocked: this.hasUnansweredPrompts(key),
        },
      ),
      turnId,
    };
    if (
      (armForBoxDone || armForWarmSharedOnly) &&
      !this.activeTurnCounts.has(key) &&
      !this.hasUnansweredPrompts(key) &&
      !roundOwed &&
      !bootInFlight
    ) {
      const latestIdleSequence = this.turnSequences.get(key) ?? turnSequence;
      for await (const ev of this.stopAfterIdle(input, key, latestIdleSequence))
        yield { ...ev, turnId };
    }
  }

  private async *runAdaptiveTurn(
    input: ConsumerTurnInput,
    key: string,
    turnSequence: number,
    statusPromise: Promise<UserBoxStatus>,
    lockBusyAtSubmit: boolean,
    signal?: AbortSignal,
  ): AsyncIterable<ConsumerTurnEvent> {
    const userMessage: TranscriptMessage = {
      role: "user",
      content: input.message,
      mode: "shared",
      at: new Date().toISOString(),
    };
    // Each turn keeps an immutable snapshot for its own shared/private handoff.
    // The global transcript is updated append-only through appendTranscript so
    // a later user message cannot mutate an earlier in-flight Box prompt.
    const transcript = [...(this.transcripts.get(key) ?? []), userMessage];
    this.transcripts.set(key, [...transcript]);

    const harness = this.harness(input.selection.harness);

    yield {
      type: "trace",
      stage: "shared.reasoning.start",
      message: "shared assistant is ready to respond if the private runtime is not immediately available; private Box boot/resume will be requested eagerly, and box.boot.start is emitted only after Box API accepts it",
      harness: harness.name,
      model: input.selection.model,
    };

    // EVERY user message reserves its OWN private round (rule 2: the box always
    // runs on top and decides for itself). An earlier round still running does
    // NOT suppress this one — it only serializes it behind the box lock. (The old
    // "a round is already active -> suppress" shortcut silently dropped follow-up
    // questions: the active round carried the OLDER message, so the newer one
    // never reached the box at all.) Only an exact duplicate of a message the box
    // already answered (or one still pending) is stale.
    // If this turn is the NEWEST for the conversation, every pending round
    // belongs to a turn we just interrupted — suppress them so (a) their late
    // output is discarded as stale and (b) they free the fingerprint space
    // (otherwise a resend of the same text would dedupe against a dead round and
    // be answered by NOBODY). An older turn racing through here skips this and
    // instead dedupes against the newest turn's fresh round — both orders
    // converge on exactly one live round owned by the newest message.
    if (this.turnSequences.get(key) === turnSequence) {
      const state = this.privateRequests.get(key);
      if (state) {
        for (const round of state.rounds.values()) {
          if (round.state === "needed" || round.state === "active") this.markPrivateRound(key, round, "suppressed");
        }
      }
    }
    const pendingBeforeSubmit = this.activePrivateRound(key);
    const candidateRound: PrivateRequestRound | undefined = this.reservePrivateRound(key, input.message);
    const roundBlockedAtSubmit = candidateRound.state === "stale";
    yield this.traceState(
      key,
      "private-round.reserved",
      `private round ${candidateRound.id} reserved with state=${candidateRound.state}${pendingBeforeSubmit ? `; will run after pending round ${pendingBeforeSubmit.id}` : ""}`,
      input,
      turnSequence,
      {
        pendingRoundId: pendingBeforeSubmit?.id ?? null,
        candidateRoundId: candidateRound.id,
        candidateRoundState: candidateRound.state,
        roundBlockedAtSubmit,
      },
    );
    const recoveryEvents: ConsumerTurnEventBody[] = [];
    let settleBootAck!: (ack: UserBoxBootAck) => void;
    let rejectBootAck!: (error: unknown) => void;
    let confirmedBootEmitted = false;
    const bootAckPromise = new Promise<UserBoxBootAck>((resolve, reject) => {
      settleBootAck = resolve;
      rejectBootAck = reject;
    });
    void bootAckPromise.catch(() => undefined);
    const privateReady = roundBlockedAtSubmit
      ? undefined
      : (async () => {
          const release = await this.acquireLock(this.boxLocks, key);
          try {
            recoveryEvents.push(this.traceState(
              key,
              "box.lock.acquired",
              "private Box lock acquired; refreshing status before create/resume/adopt",
              input,
              turnSequence,
            ));
            const latestStatus = await this.userBoxStatus(input.userId, input.conversationId);
            recoveryEvents.push(this.traceState(
              key,
              "box.status.refreshed",
              `private Box status refreshed under lock as ${latestStatus.kind}`,
              input,
              turnSequence,
              { latestStatus },
            ));
            const box = latestStatus.kind === "ready"
              ? (settleBootAck({ action: "already-ready", box: latestStatus.box }), latestStatus.box)
              : await this.ensureUserBoxWithRecovery(
                  input.userId,
                  input.conversationId,
                  latestStatus,
                  (event) => recoveryEvents.push(event),
                  settleBootAck,
                );
            return { box, status: latestStatus, release };
          } catch (error) {
            release();
            rejectBootAck(error);
            throw error;
          }
        })();
    let privateReadyConsumed = false;
    let adaptiveTurnCompleted = false;

    try {
    let resolvedStatus = await statusPromise;
    yield {
      type: "trace",
      stage: "box.status.resolved",
      message: `private Box status resolved as ${resolvedStatus.kind}`,
      harness: harness.name,
      model: input.selection.model,
      ...("boxId" in resolvedStatus ? { boxId: resolvedStatus.boxId } : {}),
      data: {
        resolvedStatus,
        conversation: this.diagnosticSnapshot(key, "box.status.resolved", turnSequence),
      },
    };

    if (roundBlockedAtSubmit || lockBusyAtSubmit || pendingBeforeSubmit) {
      yield {
        type: "trace",
        stage: candidateRound.state === "stale" ? "private-round.stale" : "box.boot.queued",
        message: candidateRound.state === "stale"
          ? "this request was already answered by (or is already pending at) the private runtime; no new Box round will be queued"
          : "private Box round is queued behind an earlier round or stop; it runs with the full transcript once the lock frees",
        harness: harness.name,
        model: input.selection.model,
        ...("boxId" in resolvedStatus ? { boxId: resolvedStatus.boxId } : {}),
      };
    } else {
      // Capped, NOT plain awaited: this gated the shared no-tools reply behind
      // the box's create/fork/resume call with no ceiling of its own, so a
      // stalled Box API request silently froze the "instant" shared line too —
      // reproduced in prod (2026-07-09 15:42 UTC): a turn hung at
      // box.status.resolved with zero further events until an unrelated
      // process restart killed it 5 minutes later; the client never got so
      // much as an error. bootAckPromise itself is untouched and still
      // resolves/rejects normally in the background (already void-caught below
      // its creation) — the second checkpoint after the shared reply (see
      // `confirmedBootEmitted` below) emits the boot-start event once it does,
      // so nothing is lost, only deferred.
      const bootAck = await Promise.race([
        bootAckPromise,
        new Promise<undefined>((resolve) => setTimeout(resolve, this.options.bootAckTimeoutMs ?? 1_500)),
      ]).catch((error) => {
        recoveryEvents.push({
          type: "trace",
          stage: "box.boot.failed",
          message: error instanceof Error ? error.message : String(error),
          harness: harness.name,
          model: input.selection.model,
          ...("boxId" in resolvedStatus ? { boxId: resolvedStatus.boxId } : {}),
        });
        return undefined;
      });
      if (bootAck) {
        confirmedBootEmitted = true;
        yield* this.emitConfirmedBootStart(bootAck, harness, input.selection.model, { userId: input.userId, conversationId: input.conversationId });
      }
    }

    // True fast path: if the private runtime is known warm and no stop/turn has
    // the private lock, route directly. This preserves the adaptive behavior
    // that avoids unnecessary shared bridge text for a ready Box.
    if (resolvedStatus.kind === "ready" && !lockBusyAtSubmit && !pendingBeforeSubmit && privateReady && candidateRound.state !== "stale") {
      const privateResult = await privateReady;
      privateReadyConsumed = true;
      try {
        if (privateResult.status.kind === "ready") {
          yield {
            type: "trace",
            stage: "route.direct",
            message: "private box is warm and holds no other work; routing this message directly to it (rule 5: no shared bridge needed)",
            harness: harness.name,
            model: input.selection.model,
            boxId: privateResult.box.id,
          };
          const round = candidateRound;
          if (round.state === "stale") {
            yield {
              type: "trace",
              stage: "private-round.suppressed",
              message: "private Box output suppressed because this request is stale or already answered",
              harness: harness.name,
              model: input.selection.model,
              boxId: privateResult.box.id,
            };
            yield { type: "turn.done", boxId: privateResult.box.id, harness: harness.name, model: input.selection.model, route: "shared" };
            adaptiveTurnCompleted = true;
            return;
          }
          this.markPrivateRound(key, round, "active");
          while (recoveryEvents.length) yield recoveryEvents.shift()!;
          yield* this.runPrivateRuntime(
            input,
            key,
            harness,
            privateResult.box,
            transcript,
            "",
            privateResult.status,
            round,
            signal,
          );
          adaptiveTurnCompleted = true;
          return;
        }
        resolvedStatus = privateResult.status;
      } finally {
        privateResult.release();
      }
    }

    // Not immediately ready (including lock held by stop/archive): run the
    // shared assistant visibly first while the private runtime is resumed or
    // started in parallel behind the private lock. This prevents the UI from
    // waiting silently during archiving/resume/cold-start windows.
    const bridgeStatus: NonNullable<MachineState["status"]> =
      resolvedStatus.kind === "archived" || resolvedStatus.kind === "archiving"
        ? "resuming"
        : "provisioning";
    const sharedMachine: MachineState = {
      location: "shared-box",
      tools: false,
      status: bridgeStatus,
    };
    const sharedHidden = buildHiddenContext({
      transcript,
      machine: sharedMachine,
    });
    yield {
      type: "context.injected",
      scope: "shared",
      machine: sharedMachine,
      hidden: sharedHidden,
    };
    yield {
      type: "trace",
      stage: "shared.bridge.start",
      message:
        bridgeStatus === "resuming"
          ? "private box is resuming; the shared no-tools agent answers first (full answer or a short wait line — its own choice)"
          : "private box is starting; the shared no-tools agent answers first (full answer or a short wait line — its own choice)",
      harness: harness.name,
      model: input.selection.model,
    };

    let rawSharedText = "";
    let emittedSharedText = "";
    let sharedCompletion: HarnessCompletion | undefined;
    const sharedSessionKey = this.sessionKey(key, harness.name, "shared");
    const knownSharedSessionId = this.harnessSessions.get(sharedSessionKey);
    for await (const text of harness.shared({
      userId: input.userId,
      conversationId: input.conversationId,
      message: input.message,
      transcript,
      selection: input.selection,
      capabilities: createRestrictedSharedCapabilities(),
      hiddenContext: sharedHidden,
      machine: sharedMachine,
      ...(knownSharedSessionId ? { sessionId: knownSharedSessionId } : {}),
      ...(signal ? { signal } : {}),
      onSessionId: (id: string) => this.harnessSessions.set(sharedSessionKey, id),
      onComplete: (info: HarnessCompletion) => { sharedCompletion = info; },
    })) {
      rawSharedText += String(text ?? "");
      // Stream the shared answer verbatim as it arrives — full reply or brief
      // holding line. No routing tag, no control markers, no message inspection.
      if (rawSharedText.length > emittedSharedText.length) {
        const delta = rawSharedText.slice(emittedSharedText.length);
        emittedSharedText = rawSharedText;
        if (delta) yield { type: "shared.delta", text: delta, harness: harness.name, final: false };
      }
    }

    const sharedText = rawSharedText.trim() || emittedSharedText;
    if (!emittedSharedText && sharedText) {
      emittedSharedText = sharedText;
      yield { type: "shared.delta", text: sharedText, harness: harness.name, final: false };
    }
    if (!emittedSharedText && (signal?.aborted || sharedCompletion?.reason === "aborted")) {
      // Interrupted by a newer user message: end quietly — the newer turn owns
      // the conversation now. Not a failure, so no loud throw.
      if (candidateRound.state === "needed") this.markPrivateRound(key, candidateRound, "suppressed");
      this.discardPreparedPrivateRuntime(privateReady);
      yield { type: "turn.done", harness: harness.name, model: input.selection.model, route: "shared", settled: false };
      adaptiveTurnCompleted = true;
      return;
    }
    if (!emittedSharedText) {
      // Rule 1: the shared agent must always answer something — a full reply or a
      // short wait line. No visible output is a real failure; fail loudly (with the
      // harness' own exit/stderr) instead of substituting a canned bridge line.
      const why = sharedCompletion
        ? ` (reason=${sharedCompletion.reason}${typeof sharedCompletion.exitCode === "number" ? `, exit=${sharedCompletion.exitCode}` : ""}${sharedCompletion.diagnostic ? `, diagnostic=${sharedCompletion.diagnostic}` : ""})`
        : "";
      throw new Error(
        `shared agent for harness ${harness.name} produced no visible answer${why}; refusing to fabricate a fallback`,
      );
    }
    const sharedMessage: TranscriptMessage = {
      role: "assistant",
      content: sharedText,
      mode: "shared",
      harness: harness.name,
      model: input.selection.model,
      at: new Date().toISOString(),
    };
    transcript.push(sharedMessage);
    this.appendTranscript(key, sharedMessage);

    // The private Box always runs on top (rule 2): its own agent decides whether
    // to add anything or emit <end> to stay silent (rule 6). The shared agent
    // never decides routing — it only ever answers (rule 3).

    const round = candidateRound;
    if (round.state === "stale" || !privateReady) {
      this.markPrivateRound(key, round, "stale");
      this.discardPreparedPrivateRuntime(privateReady);
      yield {
        type: "trace",
        stage: "private-round.suppressed",
        message: "private Box round suppressed: this exact request was already answered by (or is already pending at) the private runtime",
        harness: harness.name,
        model: input.selection.model,
        ...("boxId" in resolvedStatus ? { boxId: resolvedStatus.boxId } : {}),
      };
      yield {
        type: "turn.done",
        harness: harness.name,
        model: input.selection.model,
        route: "shared",
        settled: true,
      };
      adaptiveTurnCompleted = true;
      return;
    }

    let privateResult: { box: BoxInfo; status: UserBoxStatus; release: () => void };
    try {
      // Serialization point: waits for any earlier round to finish and release
      // the box lock. Only THEN does this round become the active one, so the
      // earlier round's output is never suppressed as stale mid-stream.
      privateResult = await privateReady;
      privateReadyConsumed = true;
      if (signal?.aborted) {
        // Superseded while queued: the newer message's turn owns the box now.
        this.markPrivateRound(key, round, "suppressed");
        privateResult.release();
        yield { type: "turn.done", harness: harness.name, model: input.selection.model, route: "shared", settled: false };
        adaptiveTurnCompleted = true;
        return;
      }
      this.markPrivateRound(key, round, "active");
    } catch (error) {
      this.markPrivateRound(key, round, "suppressed");
      while (recoveryEvents.length) yield recoveryEvents.shift()!;
      const blockedBoxId = error instanceof BoxTerminalStateError
        ? error.boxId
        : ("boxId" in resolvedStatus ? resolvedStatus.boxId : undefined);
      const blockedElapsed = blockedBoxId ? this.endBilling(blockedBoxId) : undefined;
      if (blockedBoxId && blockedElapsed !== undefined) {
        yield {
          type: "billing.stop",
          boxId: blockedBoxId,
          elapsedSeconds: blockedElapsed,
          costUsd: blockedElapsed * BOX_PRICE_USD_PER_SECOND,
          note: "billing PAUSED — private Box boot/resume ended before it became usable",
        };
      }
      yield {
        type: "turn.blocked",
        stage: "box.runtime.unavailable",
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
        retryable: true,
        harness: harness.name,
        model: input.selection.model,
        ...(blockedBoxId ? { boxId: blockedBoxId } : {}),
      };
      adaptiveTurnCompleted = true;
      return;
    }

    try {
      if (!confirmedBootEmitted) {
        // Capped like the first checkpoint. This await previously had no
        // ceiling on the assumption the ack always "arrives late at worst" —
        // false: a turn that dedupe-joined an in-flight boot never got its ack
        // at all (fixed at the join site, but belt-and-braces here), and this
        // uncapped await wedged the conversation indefinitely: shared reply
        // done, round active, lock held, every later message queued forever.
        const bootAck = await Promise.race([
          bootAckPromise,
          new Promise<undefined>((resolve) => setTimeout(resolve, this.options.bootAckTimeoutMs ?? 1_500)),
        ]).catch(() => undefined);
        if (bootAck) {
          confirmedBootEmitted = true;
          yield* this.emitConfirmedBootStart(bootAck, harness, input.selection.model, { userId: input.userId, conversationId: input.conversationId });
        }
      }
      while (recoveryEvents.length) yield recoveryEvents.shift()!;
      yield* this.runPrivateRuntime(
        input,
        key,
        harness,
        privateResult.box,
        transcript,
        sharedText,
        privateResult.status,
        round,
        signal,
      );
      adaptiveTurnCompleted = true;
    } finally {
      privateResult.release();
    }
    } finally {
      // A browser/SSE abort can return this generator after the private Box
      // create/resume has been accepted but before this code reaches the
      // handoff. Without cleanup, the prepared runtime promise keeps the
      // per-conversation lock and the reserved private round remains "needed",
      // so the next message appears to nudge a stuck warm Box. Release any
      // unconsumed prepared runtime and clear the orphaned round.
      if (!adaptiveTurnCompleted && !privateReadyConsumed) {
        if (candidateRound && (candidateRound.state === "needed" || candidateRound.state === "active")) {
          this.markPrivateRound(key, candidateRound, "suppressed");
        }
        this.discardPreparedPrivateRuntime(privateReady);
        this.scheduleAbandonedPreparedStop(input, key, turnSequence);
      }
    }
  }

  private async *runPrivateRuntime(
    input: ConsumerTurnInput,
    key: string,
    harness: HarnessAdapter,
    box: BoxInfo,
    transcript: TranscriptMessage[],
    sharedText: string,
    resolvedStatus: UserBoxStatus,
    round: PrivateRequestRound,
    signal?: AbortSignal,
  ): AsyncIterable<ConsumerTurnEvent> {
    // This round may have queued behind an earlier one; the conversation moved
    // on meanwhile (the earlier round's box answer, newer shared replies). Run
    // the box against the FRESHEST transcript, not this turn's submit snapshot —
    // the global store is an append-only superset of the snapshot.
    const globalTranscript = this.transcripts.get(key);
    if (globalTranscript && globalTranscript.length > transcript.length) transcript = [...globalTranscript];
    yield {
      type: "trace",
      stage: "runtime.owner.selected",
      message: `selected runtime ${harness.name} owns this turn; no Box prompt/API or host agent responder`,
      harness: harness.name,
      model: input.selection.model,
      boxId: box.id,
    };
    const { since, fresh } = this.startBilling(box.id, { userId: input.userId, conversationId: input.conversationId });
    if (fresh) {
      yield {
        type: "billing.start",
        boxId: box.id,
        ratePerSecond: BOX_PRICE_USD_PER_SECOND,
        sinceEpochMs: since,
        pricing: BOX_PRICING,
      };
    }
    yield {
      type: "lifecycle",
      boxId: box.id,
      state: box.state,
      note:
        resolvedStatus.kind === "ready"
          ? "private box already warm — routing your message straight to it"
          : resolvedStatus.kind === "archived" || resolvedStatus.kind === "archiving"
            ? "private box resumed from snapshot — no cold start"
            : "private box provisioned and ready",
    };
    const recap = await this.recapper.recap(transcript);
    yield {
      type: "handoff.started",
      boxId: box.id,
      recap,
      harness: harness.name,
      model: input.selection.model,
    };
    const runtimeProof = RUNTIME_FEASIBILITY.find((r) => r.harnessName === harness.name);
    yield {
      type: "runtime.proof",
      boxId: box.id,
      harness: harness.name,
      model: input.selection.model,
      boxPromptApiUsed: false,
      boxBuiltInAgentUsed: false,
      hostAsciiAgentUsed: false,
      continuation: "in-box-runtime-harness",
      ...(runtimeProof?.proofPath ? { proofPath: runtimeProof.proofPath } : {}),
      ...(runtimeProof?.streaming ? { streaming: runtimeProof.streaming } : {}),
      ...(runtimeProof ? { blocker: runtimeProof.blocker } : {}),
    };
    transcript.push({
      role: "system",
      content: recap,
      mode: "handoff",
      at: new Date().toISOString(),
    });

    yield* this.continueInUserBox(
      input,
      key,
      harness,
      box,
      transcript,
      sharedText,
      resolvedStatus.kind === "ready" ? "direct" : "bridge",
      round,
      signal,
    );
  }

  private *emitConfirmedBootStart(
    bootAck: UserBoxBootAck,
    harness: HarnessAdapter,
    model: string,
    owner: { userId: string; conversationId: string },
  ): Iterable<ConsumerTurnEventBody> {
    const bootState = bootLifecycleState(bootAck);
    yield {
      type: "lifecycle",
      state: bootState,
      boxId: bootAck.box.id,
      note: bootLifecycleNote(bootAck),
    };
    yield {
      type: "trace",
      stage: "box.boot.start",
      message: bootTraceMessage(bootAck),
      harness: harness.name,
      model,
      boxId: bootAck.box.id,
    };
    if (bootState !== "archived") {
      const { since, fresh } = this.startBilling(bootAck.box.id, owner);
      if (fresh) {
        yield {
          type: "billing.start",
          boxId: bootAck.box.id,
          ratePerSecond: BOX_PRICE_USD_PER_SECOND,
          sinceEpochMs: since,
          pricing: BOX_PRICING,
        };
      }
    }
  }


  private appendTranscript(key: string, message: TranscriptMessage): void {
    const current = this.transcripts.get(key) ?? [];
    this.transcripts.set(key, [...current, message]);
  }

  private requestState(key: string): ConversationPrivateRequestState {
    let state = this.privateRequests.get(key);
    if (!state) {
      state = { answeredFingerprints: new Set<string>(), rounds: new Map<string, PrivateRequestRound>() };
      this.privateRequests.set(key, state);
    }
    return state;
  }

  private sessionKey(key: string, harness: string, surface: "shared" | "user-box"): string {
    return `${key}:${harness}:${surface}`;
  }

  /** Any round still owed to the box (reserved-but-queued or currently running). */
  private activePrivateRound(key: string): PrivateRequestRound | undefined {
    const state = this.privateRequests.get(key);
    if (!state) return undefined;
    const running = state.active;
    if (running && (running.state === "needed" || running.state === "active")) return running;
    for (const round of state.rounds.values()) {
      if (round.state === "needed" || round.state === "active") return round;
    }
    return undefined;
  }

  private registerUnansweredPrompt(key: string, turnId: string): void {
    let turns = this.unansweredPromptTurnIds.get(key);
    if (!turns) {
      turns = new Set<string>();
      this.unansweredPromptTurnIds.set(key, turns);
    }
    turns.add(turnId);
  }

  private markPromptAnswered(key: string, turnId: string): void {
    const turns = this.unansweredPromptTurnIds.get(key);
    if (!turns) return;
    turns.delete(turnId);
    if (turns.size === 0) this.unansweredPromptTurnIds.delete(key);
  }

  private hasUnansweredPrompts(key: string): boolean {
    return (this.unansweredPromptTurnIds.get(key)?.size ?? 0) > 0;
  }

  private diagnosticSnapshot(
    key: string,
    reason: string,
    turnSequence?: number,
  ): ConversationDiagnosticSnapshot {
    const state = this.privateRequests.get(key);
    const now = Date.now();
    const unansweredTurnIds = [...(this.unansweredPromptTurnIds.get(key) ?? [])];
    const privateRoundIds = [...(state?.rounds.values() ?? [])]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((round) => ({
        id: round.id,
        state: round.state,
        ageMs: Math.max(0, now - round.createdAt),
        fingerprint: round.fingerprint,
      }));
    const privateRoundStates: Record<PrivateRoundState, number> = {
      needed: 0,
      active: 0,
      answered: 0,
      suppressed: 0,
      stale: 0,
    };
    for (const round of privateRoundIds) privateRoundStates[round.state] += 1;
    const active = state?.active;
    return {
      reason,
      key,
      turnSequence: turnSequence ?? null,
      latestTurnSequence: this.turnSequences.get(key) ?? null,
      activeTurnCount: this.activeTurnCounts.get(key) ?? 0,
      unansweredPromptCount: unansweredTurnIds.length,
      unansweredTurnIds,
      activePrivateRound: active
        ? {
            id: active.id,
            state: active.state,
            ageMs: Math.max(0, now - active.createdAt),
            fingerprint: active.fingerprint,
          }
        : null,
      privateRoundStates,
      privateRoundIds,
      answeredFingerprintCount: state?.answeredFingerprints.size ?? 0,
      userBoxBootInFlight: this.userBoxStarts.has(key),
      boxLockQueued: this.boxLocks.has(key),
      billableBoxIds: [...this.billing.keys()],
      harnessSessionCount: [...this.harnessSessions.keys()].filter((sessionKey) =>
        sessionKey.startsWith(`${key}:`),
      ).length,
    };
  }

  private traceState(
    key: string,
    stage: string,
    message: string,
    input: ConsumerTurnInput,
    turnSequence?: number,
    extra: Record<string, unknown> = {},
  ): ConsumerTurnEventBody {
    return {
      type: "trace",
      stage,
      message,
      harness: input.selection.harness,
      model: input.selection.model,
      data: {
        ...extra,
        conversation: this.diagnosticSnapshot(key, stage, turnSequence),
      },
    };
  }

  private reservePrivateRound(key: string, message: string): PrivateRequestRound {
    const state = this.requestState(key);
    const fingerprint = requestFingerprint(message) || randomUUID();
    const now = Date.now();
    // Stale ONLY for an exact duplicate: the same message text already answered
    // by the box, or identical text already reserved/running. A DIFFERENT
    // message always gets its own round (it serializes behind the box lock).
    const duplicatePending = [...state.rounds.values()].some(
      (r) => (r.state === "needed" || r.state === "active") && r.fingerprint === fingerprint,
    );
    const round: PrivateRequestRound = {
      id: randomUUID(),
      fingerprint,
      message,
      state: duplicatePending || state.answeredFingerprints.has(fingerprint) ? "stale" : "needed",
      createdAt: now,
      updatedAt: now,
    };
    state.rounds.set(round.id, round);
    return round;
  }

  private markPrivateRound(key: string, round: PrivateRequestRound, state: PrivateRoundState): void {
    const conversation = this.requestState(key);
    round.state = state;
    round.updatedAt = Date.now();
    conversation.rounds.set(round.id, round);
    // The active slot is claimed at ACTIVATION (after the box lock is held), so
    // a newly reserved round can never steal it from one still streaming.
    if (state === "active") conversation.active = round;
    if (state === "answered") {
      conversation.answeredFingerprints.add(round.fingerprint);
      if (conversation.active?.id === round.id) delete conversation.active;
    }
    if (state === "suppressed" || state === "stale") {
      if (conversation.active?.id === round.id) delete conversation.active;
    }
  }

  private isPrivateRoundCurrent(key: string, round: PrivateRequestRound): boolean {
    const active = this.privateRequests.get(key)?.active;
    return Boolean(active && active.id === round.id && active.state === "active");
  }

  private discardPreparedPrivateRuntime(
    prepared?: Promise<{ box: BoxInfo; status: UserBoxStatus; release: () => void }>,
  ): void {
    if (!prepared) return;
    void prepared.then((result) => result.release()).catch(() => undefined);
  }

  private scheduleAbandonedPreparedStop(
    input: ConsumerTurnInput,
    key: string,
    turnSequence: number,
  ): void {
    void (async () => {
      // If a create/resume is still being deduped, let it finish before deciding
      // whether the abandoned turn left a billable warm Box behind.
      await this.userBoxStarts.get(key)?.catch(() => undefined);
      const delayMs = this.options.autoStopIdleMs ?? 5000;
      if (delayMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        });
      }
      if (this.isConversationBusyForIdleStop(key, turnSequence)) return;
      const session = await this.sessions.get(input.userId, input.conversationId);
      if (!session?.boxId || !this.billing.has(session.boxId)) return;
      const release = await this.acquireLock(this.boxLocks, key);
      try {
        if (this.isConversationBusyForIdleStop(key, turnSequence)) return;
        for await (const _ of this.stopUserBoxLocked(input.userId, input.conversationId)) {
          // This is a detached cleanup path after the SSE stream disappeared;
          // there is no client to receive lifecycle events.
        }
      } finally {
        release();
      }
    })().catch(() => undefined);
  }

  private isConversationBusyForIdleStop(key: string, turnSequence: number): boolean {
    return this.idleStopBlockers(key, turnSequence).length > 0;
  }

  private idleStopBlockers(key: string, turnSequence: number): string[] {
    const blockers: string[] = [];
    if (this.turnSequences.get(key) !== turnSequence) blockers.push("newer-turn-sequence");
    if (this.activeTurnCounts.has(key)) blockers.push("active-turn-stream");
    if (this.hasUnansweredPrompts(key)) blockers.push("unanswered-prompt");
    if (this.activePrivateRound(key)) blockers.push("active-private-round");
    if (this.userBoxStarts.has(key)) blockers.push("box-boot-in-flight");
    for (const reason of this.activeHoldReasons(key.split(":")[0]!)) blockers.push(`hold:${reason}`);
    return blockers;
  }

  /**
   * Register a keep-alive hold on a user's box (e.g. an in-flight upload).
   * Returns a release function; the TTL (capped at 10 minutes) is the leak
   * guard for callers that die without releasing. The idle countdown polls
   * blockers every 250ms, so an appearing hold visibly cancels it and the box
   * only becomes stoppable again once the last hold is released or expired.
   */
  holdUserBox(userId: string, reason: string, ttlMs = 10 * 60_000): () => void {
    const id = randomUUID();
    const holds = this.boxHolds.get(userId) ?? new Map<string, { reason: string; expiresEpochMs: number }>();
    holds.set(id, { reason, expiresEpochMs: Date.now() + Math.min(Math.max(ttlMs, 1000), 10 * 60_000) });
    this.boxHolds.set(userId, holds);
    this.touchUserActivity(userId);
    return () => {
      const current = this.boxHolds.get(userId);
      current?.delete(id);
      if (current && current.size === 0) this.boxHolds.delete(userId);
      // Restart the idle clock from the release, not from the last message.
      this.touchUserActivity(userId);
    };
  }

  private activeHoldReasons(userId: string): string[] {
    const reasons: string[] = [];
    // Hosting is an indefinite hold: exposed services must stay reachable
    // until the user explicitly stops them from the UI.
    const hosting = this.hostingByUser.get(userId);
    if (hosting && hosting.size > 0) reasons.push(`hosting ${[...hosting.values()].map((h) => `:${h.port}`).join(" ")}`);
    const holds = this.boxHolds.get(userId);
    if (!holds) return reasons;
    const now = Date.now();
    for (const [id, hold] of holds) {
      if (hold.expiresEpochMs <= now) holds.delete(id);
      else reasons.push(hold.reason);
    }
    if (holds.size === 0) this.boxHolds.delete(userId);
    return reasons;
  }

  /**
   * Detect `host <port> --public|--private` in a tool command the box agent
   * ran and mark the user as hosting. Idempotent; the newest invocation wins
   * (port/mode update). Detection is command-text based because the host CLI
   * runs detached inside arbitrary shell strings (nohup/setsid wrappers).
   */
  private detectHostingCommand(userId: string, boxId: string, command: string): { port: number; mode: "public" | "private" } | undefined {
    const m = command.match(/(?:^|[\s;|&(])host\s+(\d{2,5})(?:\s+\S+)*?\s+--(public|private)\b/);
    if (!m) return undefined;
    const port = Number(m[1]);
    const mode = m[2] as "public" | "private";
    this.markHosting(userId, boxId, port, mode);
    this.touchUserActivity(userId);
    return { port, mode };
  }

  private markHosting(userId: string, boxId: string, port: number, mode: "public" | "private"): void {
    const services = this.hostingByUser.get(userId) ?? new Map<number, { boxId: string; port: number; mode: "public" | "private"; sinceEpochMs: number; url?: string }>();
    const firstForBox = ![...services.values()].some((s) => s.boxId === boxId);
    const cur = services.get(port);
    services.set(port, {
      boxId, port, mode,
      sinceEpochMs: cur && cur.boxId === boxId ? cur.sinceEpochMs : Date.now(),
      ...(cur && cur.boxId === boxId && cur.url ? { url: cur.url } : {}),
    });
    this.hostingByUser.set(userId, services);
    // Our holds stop OUR reaper/countdown, but the PLATFORM archives the box at
    // its own archiveAfter TTL regardless — which killed a hosted site mid-life
    // (box created with a short TTL, archived while the badge said hosting).
    // Best-effort: push the TTL way out while hosting; stopHosting isn't
    // required to restore it (the normal idle-stop parks the box anyway).
    if (firstForBox) {
      void this.options.box.update?.(boxId, { ttlSeconds: 7 * 24 * 3600 }).catch(() => undefined);
    }
    // Resolve the public URL of the hosted service for the UI bar: the host CLI
    // exposes <box-subdomain>-<port>.on.ascii.dev. Async best-effort; the bar
    // shows it as soon as a later runtime poll picks it up.
    const entry = services.get(port)!;
    if (!entry.url) {
      void this.options.box.get(boxId).then((b) => {
        const base = String((b as { url?: string }).url ?? "");
        const m = base.match(/^https:[/][/]([^.]+)[.](.+)$/);
        if (!m) return;
        const live = this.hostingByUser.get(userId)?.get(port);
        if (live && live.boxId === boxId) live.url = `https://${m[1]}-${port}.${m[2]}`;
      }).catch(() => undefined);
    }
  }

  /** Consecutive live probes that saw no host process, per user:port — grace so
   * one flaky pgrep doesn't drop the hold of a genuinely hosted service. */
  private readonly hostingMisses = new Map<string, number>();

  /**
   * Ground-truth reconcile from the box itself (rides the file-tree poll): the
   * set of live `host` processes is authoritative in both directions. Sets
   * services the command-sniffer never saw (host started outside a turn,
   * server restarted and lost the in-memory map) and clears each service whose
   * process is gone (two consecutive misses) or every service of a parked box
   * (boxLive:false — an archived machine hosts nothing).
   */
  reconcileObservedHosting(userId: string, boxId: string, observed: Array<{ port: number; mode: "public" | "private" }>, opts: { boxLive?: boolean } = {}): void {
    const services = this.hostingByUser.get(userId);
    for (const o of observed) {
      this.hostingMisses.delete(`${userId}:${o.port}`);
      this.markHosting(userId, boxId, o.port, o.mode);
    }
    if (!services || services.size === 0) return;
    const observedPorts = new Set(observed.map((o) => o.port));
    for (const [port, entry] of services) {
      if (entry.boxId !== boxId || observedPorts.has(port)) continue;
      const missKey = `${userId}:${port}`;
      if (opts.boxLive === false) { services.delete(port); this.hostingMisses.delete(missKey); continue; }
      const misses = (this.hostingMisses.get(missKey) ?? 0) + 1;
      if (misses >= 2) { services.delete(port); this.hostingMisses.delete(missKey); this.touchUserActivity(userId); }
      else this.hostingMisses.set(missKey, misses);
    }
    if (services.size === 0) this.hostingByUser.delete(userId);
  }

  /** Hosting status for the UI (rides userRuntimeStatus): all live services. */
  hostingStatus(userId: string): Array<{ boxId: string; port: number; mode: "public" | "private"; sinceEpochMs: number; url?: string }> {
    return [...(this.hostingByUser.get(userId)?.values() ?? [])];
  }

  /**
   * Stop hosting — one service (port given) or all of them. Closes the exposed
   * port on the box (ufw) and kills the host process, then releases the
   * indefinite hold so the normal idle countdown takes over and the machine
   * can park again. Best-effort on the box side — state is released even if
   * the box is unreachable (a stuck hold would pin the VM forever).
   */
  async stopHosting(userId: string, port?: number): Promise<{ stopped: boolean; ports: number[] }> {
    const services = this.hostingByUser.get(userId);
    if (!services || services.size === 0) return { stopped: false, ports: [] };
    const targets = [...services.values()].filter((s) => port === undefined || s.port === port);
    if (targets.length === 0) return { stopped: false, ports: [] };
    for (const t of targets) { services.delete(t.port); this.hostingMisses.delete(`${userId}:${t.port}`); }
    if (services.size === 0) this.hostingByUser.delete(userId);
    this.touchUserActivity(userId);
    for (const t of targets) {
      try {
        await this.options.box.command(t.boxId, {
          command:
            `sudo -n ufw delete allow ${t.port}/tcp 2>/dev/null; sudo -n ufw delete allow ${t.port} 2>/dev/null; ` +
            `sudo -n ufw deny ${t.port}/tcp 2>/dev/null; ` +
            `pkill -f 'host[[:space:]]+${t.port}' 2>/dev/null; true`,
          timeoutMs: 20_000,
        });
      } catch { /* box unreachable/parked: the state release above is what matters */ }
    }
    return { stopped: true, ports: targets.map((t) => t.port) };
  }

  /** Bump the idle clock of every conversation of this user (box is per-user). */
  private touchUserActivity(userId: string): void {
    const prefix = `${userId}:`;
    for (const key of this.lastActivityAt.keys()) {
      if (key.startsWith(prefix)) this.lastActivityAt.set(key, Date.now());
    }
  }

  private bumpTurnSequence(key: string): number {
    const next = (this.turnSequences.get(key) ?? 0) + 1;
    this.turnSequences.set(key, next);
    return next;
  }

  private async *stopAfterIdle(
    input: ConsumerTurnInput,
    key: string,
    turnSequence: number,
  ): AsyncIterable<ConsumerTurnEvent> {
    const delayMs = this.options.autoStopIdleMs ?? 5000;
    const session = await this.sessions.get(input.userId, input.conversationId);
    const boxId = session?.boxId;
    if (delayMs <= 0) {
      yield {
        type: "autostop.timer",
        phase: "stopping",
        boxId,
        remainingMs: 0,
        reason: "disabled",
        note: "auto-stop idle delay is disabled; stopping private Box now",
      };
    } else {
      let deadlineEpochMs = Date.now() + delayMs;
      yield {
        type: "autostop.timer",
        phase: "started",
        boxId,
        remainingMs: delayMs,
        deadlineEpochMs,
        reason: "idle-after-response",
        note: "assistant finished; private Box will auto-stop when this visible idle countdown reaches zero",
      };

      // This generator runs only after the private response finishes. While the
      // user is idle, emit countdown events and frequently check the private
      // turn sequence so a new message visibly resets the timer instead of
      // leaving a hidden stop tail.
      let lastWholeSecond = Math.ceil(delayMs / 1000);
      let heldNoted = false;
      let lastHeldEmit = 0;
      while (true) {
        const blockers = this.idleStopBlockers(key, turnSequence);
        // Keep-alive holds (typing, attachment uploads, desktop stream) are the
        // user's "box still needed" flag: PAUSE the countdown at full and resume
        // fresh when the flag drops — returning here would kill this generator
        // and nothing would ever re-arm the stop.
        const holdOnly = blockers.length > 0 && blockers.every((b) => b.startsWith("hold:"));
        if (blockers.length > 0 && !holdOnly) {
          yield {
            type: "autostop.timer",
            phase: "canceled",
            boxId,
            remainingMs: Math.max(0, deadlineEpochMs - Date.now()),
            deadlineEpochMs,
            reason: "new-user-message",
            note: `auto-stop countdown reset because the conversation is busy (${blockers.join(", ")}); it will restart after blockers clear`,
          };
          return;
        }
        if (holdOnly) {
          deadlineEpochMs = Date.now() + delayMs;
          // Emit a `held` tick on entering the hold AND re-emit ~once a second
          // while it lasts. A single emission is not enough: the client's local
          // countdown keeps ticking on its own between server events, so a paused
          // countdown would visibly run to zero unless the server keeps
          // reasserting "held". The `held` phase (distinct from `tick`) tells the
          // client to FREEZE the display rather than resume ticking.
          const now = Date.now();
          if (!heldNoted || now - lastHeldEmit >= 1000) {
            heldNoted = true;
            lastHeldEmit = now;
            lastWholeSecond = Math.ceil(delayMs / 1000);
            yield {
              type: "autostop.timer",
              phase: "held",
              boxId,
              remainingMs: delayMs,
              deadlineEpochMs,
              reason: "idle-after-response",
              note: `countdown held at full (${blockers.join(", ")}); it resumes when the hold clears`,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        heldNoted = false;

        const remainingMs = Math.max(0, deadlineEpochMs - Date.now());
        const wholeSecond = Math.ceil(remainingMs / 1000);
        if (wholeSecond !== lastWholeSecond || remainingMs === 0) {
          lastWholeSecond = wholeSecond;
          yield {
            type: "autostop.timer",
            phase: remainingMs === 0 ? "stopping" : "tick",
            boxId,
            remainingMs,
            deadlineEpochMs,
            reason: "idle-after-response",
            note: remainingMs === 0
              ? "visible idle countdown reached zero; stopping private Box now"
              : "private Box auto-stop countdown is running because the assistant is done and the user is idle",
          };
        }
        if (remainingMs === 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, remainingMs)));
      }
    }

    let blockers = this.idleStopBlockers(key, turnSequence);
    if (blockers.length > 0) {
      yield {
        type: "autostop.timer",
        phase: "canceled",
        boxId,
        remainingMs: 0,
        reason: "new-user-message",
        note: `auto-stop skipped before stop could begin because the conversation is busy (${blockers.join(", ")})`,
      };
      return;
    }

    const release = await this.acquireLock(this.boxLocks, key);
    try {
      blockers = this.idleStopBlockers(key, turnSequence);
      if (blockers.length > 0) {
        yield {
          type: "autostop.timer",
          phase: "canceled",
          boxId,
          remainingMs: 0,
          reason: "new-user-message",
          note: `auto-stop skipped after acquiring lock because the conversation is busy (${blockers.join(", ")})`,
        };
        return;
      }
      yield* this.stopUserBoxLocked(input.userId, input.conversationId, {
        shouldCancel: () => this.isConversationBusyForIdleStop(key, turnSequence),
      });
    } finally {
      release();
    }
  }

  /**
   * Phase 3: run the developer's REAL harness inside the ready private box, with
   * the hidden context (tools=true + any carried partial bridge reply). Shared
   * by both the fast (direct) path and the bridge path so routing
   * stays consistent however we got here.
   */
  private async *continueInUserBox(
    input: ConsumerTurnInput,
    key: string,
    harness: HarnessAdapter,
    box: BoxInfo,
    transcript: TranscriptMessage[],
    partialShared: string,
    route: "direct" | "bridge",
    round: PrivateRequestRound,
    signal?: AbortSignal,
  ): AsyncIterable<ConsumerTurnEvent> {
    const recap = this.lastRecap(transcript);
    const staleDuplicateRequest = round.state === "stale";
    const userBoxTranscript = staleDuplicateRequest
      ? [
          ...transcript,
          {
            role: "system" as const,
            content:
              "The latest user request appears to be a stale queued duplicate of a request already answered by the private runtime. The private agent may decline this duplicate by returning exactly <end>.",
            mode: "handoff" as const,
            at: new Date().toISOString(),
          },
        ]
      : transcript;
    const userMachine: MachineState = {
      location: "user-box",
      tools: true,
      boxId: box.id,
      status: "live",
    };
    const userHidden = buildHiddenContext({
      transcript: userBoxTranscript,
      machine: userMachine,
      partialShared,
      staleDuplicateRequest,
    });
    yield {
      type: "context.injected",
      scope: "user-box",
      machine: userMachine,
      hidden: userHidden,
    };

    const execEvents: ConsumerTurnEvent[] = [];
    const capabilities = createUserBoxCapabilities(this.options.box, box.id, {
      ...(this.options.providerEnv
        ? { providerEnv: this.options.providerEnv }
        : {}),
      onExec: (info) =>
        execEvents.push({ type: "exec", boxId: box.id, ...info }),
      onHarnessEvent: (event) =>
        execEvents.push({ type: "harness.tool", boxId: box.id, ...event }),
    });
    const userBoxSessionKey = this.sessionKey(key, harness.name, "user-box");
    const knownUserBoxSessionId = this.harnessSessions.get(userBoxSessionKey);
    yield this.traceState(
      key,
      "user-box.runtime.start",
      `starting private ${harness.name} runtime inside Box ${box.id} via ${route} route`,
      input,
      this.turnSequences.get(key),
      {
        boxId: box.id,
        route,
        roundId: round.id,
        knownSessionId: Boolean(knownUserBoxSessionId),
        partialSharedLength: partialShared.length,
      },
    );
    // Captures WHY the harness loop ended for this prompt. Defaults to "completed"
    // for plain generator harnesses (no real CLI loop): a generator that simply
    // returns has, by definition, finished its work. Real CLI/SDK harnesses report
    // the true reason (clean stream end vs timeout vs crash vs abort) via onComplete.
    let completion: HarnessCompletion = { reason: "completed" };
    const continued = harness.userBox({
      userId: input.userId,
      conversationId: input.conversationId,
      boxId: box.id,
      recap,
      latestUserMessage: input.message,
      transcript: userBoxTranscript,
      selection: input.selection,
      capabilities,
      hiddenContext: userHidden,
      machine: userMachine,
      partialShared,
      ...(knownUserBoxSessionId ? { sessionId: knownUserBoxSessionId } : {}),
      ...(signal ? { signal } : {}),
      onSessionId: (id: string) => this.harnessSessions.set(userBoxSessionKey, id),
      onComplete: (info: HarnessCompletion) => { completion = info; },
    });
    let userText = "";
    let sawToolUse = false;
    // Lightweight record of what the agent DID, so a no-final-answer failure can
    // salvage a human summary (execEvents is drained as it flushes, so count here).
    let toolUseCount = 0;
    let lastToolName = "";
    let heldEndCandidate = "";
    const itc = continued[Symbol.asyncIterator]();
    const harnessName = harness.name;
    const selectionModel = input.selection.model;
    // Hosting detection rides the tool stream: the moment the agent runs the
    // box `host <port> --public|--private` CLI, the user is hosting and the
    // box must not idle-stop until they stop hosting from the UI.
    const noteHostingCommand = (command: string) => this.detectHostingCommand(input.userId, box.id, command);
    const flushExecEvents = function* (): Iterable<ConsumerTurnEvent> {
      while (execEvents.length) {
        const ev = execEvents.shift()!;
        if (ev.type === "harness.tool") {
          if (ev.phase === "tool_use") {
            sawToolUse = true; toolUseCount++; if (ev.toolName) lastToolName = ev.toolName;
            const hosting = typeof ev.command === "string" ? noteHostingCommand(ev.command) : undefined;
            if (hosting) {
              yield {
                type: "trace",
                stage: "box.hosting.started",
                message: `box agent exposed port ${hosting.port} (${hosting.mode}) via the host CLI; machine will stay up until hosting is stopped from the UI`,
                harness: harnessName,
                model: selectionModel,
                boxId: box.id,
                data: { port: hosting.port, mode: hosting.mode },
              };
            }
          }
          // Surface tool activity in traces so the scheduler/UI can see the box
          // agent is actively working (NOT idle) even before any visible text.
          yield {
            type: "trace",
            stage: ev.phase === "tool_use" ? "box.tool.use" : "box.tool.result",
            message: ev.phase === "tool_use"
              ? `box agent invoked tool ${ev.toolName ?? "tool"}${ev.command ? `: ${ev.command}` : ""}`
              : `box agent received tool result${ev.isError ? " (error)" : ""}`,
            harness: harnessName,
            model: selectionModel,
            boxId: box.id,
            data: {
              toolName: ev.toolName ?? null,
              command: ev.command ?? null,
              description: ev.description ?? null,
              stdoutLength: typeof ev.stdout === "string" ? ev.stdout.length : 0,
              stderrLength: typeof ev.stderr === "string" ? ev.stderr.length : 0,
              isError: Boolean(ev.isError),
            },
          };
        }
        yield ev;
      }
    };
    const emitChunkEvent = function* (chunk: { text: string; messageId?: string; messageIndex?: number }): Iterable<ConsumerTurnEvent> {
      if (!chunk.text || !isCurrentPrivateRound()) return;
      yield {
        type: "user-box.delta",
        text: chunk.text,
        boxId: box.id,
        harness: harness.name,
        model: input.selection.model,
        ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
        ...(chunk.messageIndex !== undefined ? { messageIndex: chunk.messageIndex } : {}),
      };
    };
    const isCurrentPrivateRound = () => this.isPrivateRoundCurrent(key, round);
    const emitPrivateChunk = function* (value: unknown): Iterable<ConsumerTurnEvent> {
      const chunk = normalizeHarnessChunk(value);
      if (!chunk.text) return;
      userText += chunk.text;

      // Preserve exact <end> suppression without buffering ordinary answers:
      // hold only prefixes that can still become the sentinel, then release them
      // as real streamed chunks as soon as they are proven to be normal text.
      if ((heldEndCandidate + chunk.text).startsWith(PRIVATE_END_SENTINEL)) {
        heldEndCandidate += chunk.text;
        return;
      }
      if (heldEndCandidate) {
        const held = heldEndCandidate;
        heldEndCandidate = "";
        yield* emitChunkEvent({ text: held, ...(chunk.messageId ? { messageId: chunk.messageId } : {}), ...(chunk.messageIndex !== undefined ? { messageIndex: chunk.messageIndex } : {}) });
      }
      yield* emitChunkEvent(chunk);
    };
    const drainIterator = async function* (iterator: AsyncIterator<unknown>): AsyncIterable<ConsumerTurnEvent> {
      let next = iterator.next();
      while (true) {
        const raced = await Promise.race([
          next.then((n) => ({ kind: "next" as const, n })),
          sleep(50).then(() => ({ kind: "tick" as const })),
        ]);
        yield* flushExecEvents();
        if (raced.kind === "tick") continue;
        if (raced.n.done) break;
        yield* emitPrivateChunk(raced.n.value);
        next = iterator.next();
      }
      yield* flushExecEvents();
      if (heldEndCandidate && heldEndCandidate !== PRIVATE_END_SENTINEL) {
        yield* emitChunkEvent({ text: heldEndCandidate, messageId: "assistant-0", messageIndex: 0 });
        heldEndCandidate = "";
      }
    };
    yield* drainIterator(itc);
    // OBSERVABILITY: ground-truth what actually landed on disk in the user's home
    // this turn. This is the source of truth behind "the agent said it saved X":
    // it exposes files written to the wrong directory or writes that never
    // persisted, and lets a turn be reproduced/diagnosed from /api/diagnostics
    // instead of guesswork. Best-effort; never blocks or fails the turn.
    if (this.options.box.command) {
      try {
        const probe = await this.options.box.command(box.id, {
          command:
            "find /home/user -maxdepth 6 -type f -mmin -15 -not -path '*/.*' " +
            "-not -path '*/node_modules/*' -printf '%T@\\t%s\\t%P\\n' 2>/dev/null " +
            "| sort -rn | head -50",
          timeoutMs: 10_000,
        });
        const files = String(probe?.stdout ?? "")
          .split("\n")
          .map((l) => l.replace(/\r$/, ""))
          .filter(Boolean)
          .map((l) => {
            const [mtime, size, ...rest] = l.split("\t");
            return { path: rest.join("\t"), size: Number(size) || 0, mtime: Math.floor(Number(mtime) || 0) };
          })
          .filter((f) => f.path);
        yield {
          type: "trace",
          stage: "box.files.ondisk",
          message:
            `after turn (${toolUseCount} tool call${toolUseCount === 1 ? "" : "s"}` +
            `${lastToolName ? `, last: ${lastToolName}` : ""}): ` +
            (files.length
              ? `${files.length} file(s) modified under /home/user in last 15min → ${files.slice(0, 10).map((f) => f.path).join(", ")}`
              : "NO non-hidden files modified under /home/user in last 15min"),
          harness: harnessName,
          model: selectionModel,
          boxId: box.id,
          data: { cwd: "/home/user", count: files.length, files, toolUseCount, lastToolName, sawToolUse },
        };
      } catch (err) {
        yield {
          type: "trace",
          stage: "box.files.ondisk.error",
          message: `on-disk file verification failed: ${String(err).slice(0, 200)}`,
          harness: harnessName,
          model: selectionModel,
          boxId: box.id,
        };
      }
    }
    if (!this.isPrivateRoundCurrent(key, round)) {
      this.markPrivateRound(key, round, "stale");
      yield {
        type: "trace",
        stage: "private-round.output.suppressed",
        message: `private Box output for round ${round.id} was stale and was deterministically suppressed`,
        harness: harness.name,
        model: input.selection.model,
        boxId: box.id,
        data: {
          roundId: round.id,
          conversation: this.diagnosticSnapshot(key, "private-round.output.suppressed", this.turnSequences.get(key)),
        },
      };
      yield { type: "turn.done", boxId: box.id, harness: harness.name, model: input.selection.model, route: "shared" };
      return;
    }
    // Rule 1 salvage: the box agent ran tools successfully but its run ended before
    // writing a final answer (observed with opencode: `run` can exit right after a
    // tool-call step, discarding the tool result). Rather than lose a successful
    // result to the loud no-answer blocker, resume the SAME session ONCE and ask it
    // to deliver the answer it already computed. Only a STILL-empty result after
    // this genuine retry falls through to fail loudly below. Not attempted on abort
    // (interrupted, not stuck) or when no tool ran (nothing to summarize).
    if (!userText && sawToolUse && completion.reason !== "aborted") {
      const resumeSessionId = this.harnessSessions.get(userBoxSessionKey);
      yield this.traceState(
        key,
        "box.runtime.continue",
        "box agent used tools but ended without a final answer; resuming its session once to deliver the answer it already computed",
        input,
        this.turnSequences.get(key),
        { boxId: box.id, roundId: round.id, resume: Boolean(resumeSessionId) },
      );
      let continuationCompletion: HarnessCompletion = { reason: "completed" };
      const continuation = harness.userBox({
        userId: input.userId,
        conversationId: input.conversationId,
        boxId: box.id,
        recap,
        latestUserMessage:
          "Your previous run ended WITHOUT delivering any visible reply: the user has received NOTHING — even if you believe you already answered, that answer was never shown. Write your final answer to the user now, in plain prose (1-4 sentences): what you did, where any files are, and any URL you exposed. Do not call more tools. Do NOT return <end> — you did work this turn, so silence is wrong.",
        transcript: userBoxTranscript,
        selection: input.selection,
        capabilities,
        hiddenContext: userHidden,
        machine: userMachine,
        partialShared,
        ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
        ...(signal ? { signal } : {}),
        onSessionId: (id: string) => this.harnessSessions.set(userBoxSessionKey, id),
        onComplete: (info: HarnessCompletion) => { continuationCompletion = info; },
      });
      yield* drainIterator(continuation[Symbol.asyncIterator]());
      completion = continuationCompletion;
    }
    if (userText === PRIVATE_END_SENTINEL) {
      yield {
        type: "trace",
        stage: "user-box.response.end",
        message: "private Box agent returned exactly <end>; no private answer will be surfaced",
        harness: harness.name,
        model: input.selection.model,
        boxId: box.id,
        data: {
          roundId: round.id,
          completion,
          conversation: this.diagnosticSnapshot(key, "user-box.response.end", this.turnSequences.get(key)),
        },
      };
      this.markPrivateRound(key, round, "suppressed");
      yield {
        type: "turn.done",
        boxId: box.id,
        harness: harness.name,
        model: input.selection.model,
        route: "shared",
      };
      return;
    }
    if (userText) {
      const assistantMessage: TranscriptMessage = {
        role: "assistant",
        content: userText,
        mode: "user-box",
        harness: harness.name,
        model: input.selection.model,
        at: new Date().toISOString(),
      };
      transcript.push(assistantMessage);
      this.appendTranscript(key, assistantMessage);
      this.markPrivateRound(key, round, "answered");
    }
    if (!userText && completion.reason !== "aborted") {
      if (sawToolUse) {
        // The agent DID run tools on the machine but the harness (opencode) died
        // before writing a final answer — even the one-shot continuation retry
        // above came back empty (observed: opencode serve 500s / UnknownError on
        // the resume call). Don't strand the user on a hard error: surface WHAT
        // the agent did as a real answer, mark the round answered so the box can
        // idle-stop, and invite a continue. The work already ran on their box.
        const did = `${toolUseCount} tool ${toolUseCount === 1 ? "call" : "calls"}${lastToolName ? ` (last: ${lastToolName})` : ""}`;
        const salvage = `I worked on your machine — ${did} — but the run ended before I could write up the result${completion.diagnostic ? " (the harness threw an error mid-reply)" : ""}. The steps themselves ran; ask me to continue and I'll report back on what I found.`;
        const assistantMessage: TranscriptMessage = {
          role: "assistant",
          content: salvage,
          mode: "user-box",
          harness: harness.name,
          model: input.selection.model,
          at: new Date().toISOString(),
        };
        transcript.push(assistantMessage);
        this.appendTranscript(key, assistantMessage);
        this.markPrivateRound(key, round, "answered");
        yield { type: "user-box.delta", text: salvage, boxId: box.id, harness: harness.name, model: input.selection.model };
      } else {
        this.markPrivateRound(key, round, "suppressed");
        // No text AND no tool ran — the agent produced NOTHING (not a legitimate
        // silence; rule 6: intentional silence is exactly "<end>"). There is
        // nothing to salvage, so fail loudly with the harness exit code + tail.
        yield {
          type: "turn.blocked",
          stage: "box.runtime.no-answer",
          message: `private box agent for harness ${harness.name} ended (reason=${completion.reason}${typeof completion.exitCode === "number" ? `, exit=${completion.exitCode}` : ""}) without any visible answer and without <end>${completion.diagnostic ? `; harness output tail: ${completion.diagnostic}` : ""}`,
          retryable: true,
          harness: harness.name,
          model: input.selection.model,
          boxId: box.id,
        };
      }
    }
    // The box agent only "settled" this prompt if its loop ended of its own accord
    // (clean stream end / safety timeout / process gone) — never if it was aborted
    // out from under an in-flight turn. Only a settled answer may arm the idle stop.
    const settled = completion.reason !== "aborted";
    if (!settled) {
      yield {
        type: "trace",
        stage: "box.runtime.unsettled",
        message: `box agent loop ended without settling (${completion.reason}); not arming idle auto-stop`,
        harness: harness.name,
        model: input.selection.model,
        boxId: box.id,
        data: {
          completion,
          roundId: round.id,
          sawUserText: Boolean(userText),
          sawToolUse,
          conversation: this.diagnosticSnapshot(key, "box.runtime.unsettled", this.turnSequences.get(key)),
        },
      };
    }
    yield {
      type: "turn.done",
      boxId: box.id,
      harness: harness.name,
      model: input.selection.model,
      route,
      settled,
    };
  }

  private lastRecap(transcript: TranscriptMessage[]): string {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const m = transcript[i];
      if (m && m.mode === "handoff") return m.content;
    }
    return "";
  }

  /**
   * The box currently billing for a user, if any. This is the authoritative
   * answer to "which machine is this user's agent on RIGHT NOW" — name-based
   * lookups can be ambiguous (duplicate names have been observed after an
   * archiving race), but the billing owner map cannot.
   */
  activeUserBoxId(userId: string): string | undefined {
    // Prefer a box a real conversation owns over an external-wake one: when a
    // wake raced a turn into two billed boxes, files must follow the agent.
    let fallback: string | undefined;
    for (const [boxId, owner] of this.boxOwners) {
      if (owner.userId !== userId || !this.billing.has(boxId)) continue;
      if (!owner.conversationId.startsWith("external-")) return boxId;
      fallback = fallback ?? boxId;
    }
    return fallback;
  }

  /**
   * A box woken OUTSIDE a turn (user typing, staged attachment upload) is a
   * running machine like any other: register it with the SAME billing/owner
   * machinery turns use, so every downstream system — the cost counter, the
   * idle reaper, the orphan sweep, userRuntimeStatus — sees ONE truth instead
   * of a side-channel wake it has to special-case. Idempotent per box.
   */
  registerExternalWake(boxId: string, userId: string, reason: string): void {
    // Already billed (a turn owns it, or a previous wake registered it): never
    // overwrite the owner — that would detach the running turn's status.
    if (this.billing.has(boxId)) {
      this.touchUserActivity(userId);
      return;
    }
    const conversationId = `external-${reason}`;
    const key = `${userId}:${conversationId}`;
    this.startBilling(boxId, { userId, conversationId });
    // Seed + bump the idle clock: touchUserActivity only bumps existing keys,
    // and without an entry the reaper's `?? now` fallback never sees it idle.
    this.lastActivityAt.set(key, Date.now());
    this.touchUserActivity(userId);
    // First wake of this billing lifecycle: eagerly boot serve so the user's
    // first message doesn't pay for it. Repeat typing pings hit the early return
    // above (billing already set) and never re-fire this.
    this.prewarmBoxServe(boxId);
  }

  /**
   * Eagerly boot the box's resident harness runtime (opencode serve) the moment
   * a wake happens — typing/upload wakes the machine, so by the time the user
   * finally sends their first message serve is already listening and the turn
   * skips the ~3s (up to 90s on archive-resume) boot it would otherwise pay.
   *
   * Fire-and-forget and self-sequencing: the caller need not wait for the box to
   * finish resuming — we poll for it to execute commands (up to ~90s), then run
   * each serve-capable harness's own prewarm. Deduped per box so the 4s typing
   * pings don't stack. A turn's health-check still boots serve if this loses a
   * race or the box cold-started since, so this is a pure latency optimization,
   * never a correctness dependency.
   */
  prewarmBoxServe(boxId: string): void {
    if (this.prewarmingBoxes.has(boxId)) return;
    const warmers = [...this.harnesses.values()].filter((h) => typeof h.prewarm === "function");
    if (warmers.length === 0) return;
    this.prewarmingBoxes.add(boxId);
    void (async () => {
      try {
        const capabilities = createUserBoxCapabilities(this.options.box, boxId, {
          ...(this.options.providerEnv ? { providerEnv: this.options.providerEnv } : {}),
        });
        // Wait until the box actually executes a command (it may still be
        // resuming when the wake fired). Same readiness gate the upload path uses.
        let live = false;
        for (let i = 0; i < 45 && !live; i++) {
          try {
            const r = await capabilities.command(`echo ready`, { timeoutMs: 30_000 });
            if ((r.stdout || "").includes("ready")) live = true;
          } catch { /* still booting */ }
          if (!live) await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        if (!live) return;
        for (const h of warmers) {
          try { await h.prewarm!(capabilities); } catch { /* the turn's own boot covers a failed prewarm */ }
        }
      } finally {
        this.prewarmingBoxes.delete(boxId);
      }
    })();
  }

  /**
   * One coherent runtime snapshot for a user's machine, whatever woke it: the
   * demo UI polls this and reconciles every counter (billing, cost, auto-stop,
   * state) from it, so a wake with no SSE stream attached is never invisible.
   */
  userRuntimeStatus(userId: string): {
    boxId?: string;
    billingSinceEpochMs: number | null;
    /** Seconds billed across all ENDED lifecycles; add the live (since) window for the display total. */
    billedSecondsTotal: number;
    holds: string[];
    activeTurn: boolean;
    idleStopEtaEpochMs: number | null;
    idleStopMs: number;
    hosting: Array<{ port: number; mode: "public" | "private"; sinceEpochMs: number; url?: string }> | null;
  } {
    const holds = this.activeHoldReasons(userId);
    let boxId: string | undefined;
    let since: number | null = null;
    let activeTurn = false;
    let lastActivity = 0;
    for (const [bId, owner] of this.boxOwners) {
      if (owner.userId !== userId) continue;
      const s = this.billing.get(bId);
      if (s === undefined) continue;
      boxId = bId;
      since = since === null ? s : Math.min(since, s);
      if (this.activeTurnCounts.has(owner.key) || this.activePrivateRound(owner.key) || this.userBoxStarts.has(owner.key)) activeTurn = true;
      lastActivity = Math.max(lastActivity, this.lastActivityAt.get(owner.key) ?? 0);
    }
    const idleStopMs = this.options.autoStopIdleMs ?? 5000;
    const idleStopEtaEpochMs = since !== null && !activeTurn && holds.length === 0
      ? Math.max(Date.now(), (lastActivity || Date.now()) + idleStopMs)
      : null;
    const hostingList = this.hostingStatus(userId);
    return { ...(boxId ? { boxId } : {}), billingSinceEpochMs: since, billedSecondsTotal: this.billedSecondsByUser.get(userId) ?? 0, holds, activeTurn, idleStopEtaEpochMs, idleStopMs, hosting: hostingList.length ? hostingList.map((h) => ({ port: h.port, mode: h.mode, sinceEpochMs: h.sinceEpochMs, ...(h.url ? { url: h.url } : {}) })) : null };
  }

  private startBilling(boxId: string, owner?: { userId: string; conversationId: string }): { since: number; fresh: boolean } {
    let since = this.billing.get(boxId);
    const fresh = since === undefined;
    if (since === undefined) {
      since = Date.now();
      this.billing.set(boxId, since);
    }
    // Remember which conversation owns this billable box so the background reaper
    // can stop it by user/conversation even with no request stream attached.
    if (owner) this.boxOwners.set(boxId, { ...owner, key: `${owner.userId}:${owner.conversationId}` });
    return { since, fresh };
  }

  /**
   * THE one way billing ends. Computes the elapsed seconds, folds them into the
   * user's cumulative total (surfaced by userRuntimeStatus — the UI's machine
   * counter is a pure projection of that number, not its own accumulator), and
   * clears the live entry. Returns elapsed seconds, or undefined if the box was
   * not billing. Every stop path routes through here; before this existed each
   * path did its own get/compute/delete and the client kept a THIRD copy of the
   * running total, so the header could disagree with the server (observed: a
   * typing-woken machine billed server-side while the header showed 0.0s until
   * the next poll happened to land).
   */
  private endBilling(boxId: string): number | undefined {
    const since = this.billing.get(boxId);
    if (since === undefined) return undefined;
    this.billing.delete(boxId);
    const elapsedSeconds = Math.max(0, (Date.now() - since) / 1000);
    const owner = this.boxOwners.get(boxId);
    if (owner) this.billedSecondsByUser.set(owner.userId, (this.billedSecondsByUser.get(owner.userId) ?? 0) + elapsedSeconds);
    return elapsedSeconds;
  }

  /**
   * Stop the user's Box, streaming the full lifecycle so the UI can show
   * stopping -> archiving -> archived and the exact moment billing pauses.
   */
  async *stopUserBox(
    userId: string,
    conversationId: string,
  ): AsyncIterable<ConsumerTurnEvent> {
    const key = `${userId}:${conversationId}`;
    const turnId = randomUUID();
    // Take the boxLock so a stop waits for any in-flight Box turn to finish
    // streaming instead of archiving the box out from under a running harness
    // (which would truncate the answer and scramble billing).
    const release = await this.acquireLock(this.boxLocks, key);
    try {
      for await (const ev of this.stopUserBoxLocked(userId, conversationId))
        yield { ...ev, turnId };
    } finally {
      release();
    }
  }

  private async *stopUserBoxLocked(
    userId: string,
    conversationId: string,
    options: { shouldCancel?: () => boolean } = {},
  ): AsyncIterable<ConsumerTurnEvent> {
    const canceled = () => Boolean(options.shouldCancel?.());
    const session = await this.sessions.get(userId, conversationId);
    if (!session?.boxId) {
      yield {
        type: "lifecycle",
        boxId: "",
        state: "none",
        note: "no active user box to stop",
      };
      return;
    }
    const boxId = session.boxId;
    if (canceled()) {
      yield {
        type: "autostop.timer",
        phase: "canceled",
        boxId,
        remainingMs: 0,
        reason: "new-user-message",
        note: "auto-stop canceled because a user prompt was accepted before shutdown began",
      };
      return;
    }
    yield {
      type: "lifecycle",
      boxId,
      state: "stopping",
      note: "requesting stop (snapshot + pause billing)",
    };
    // Idempotent: the box may already be archiving/archived (e.g. TTL auto-stop
    // raced our request). Only issue stop if it's still active, but always stream
    // the rest of the lifecycle so billing is shown pausing exactly once.
    const current = await this.options.box.get(boxId).catch(() => undefined);
    if (
      current &&
      current.state !== "archiving" &&
      current.state !== "archived"
    ) {
      if (canceled()) {
        yield {
          type: "autostop.timer",
          phase: "canceled",
          boxId,
          remainingMs: 0,
          reason: "new-user-message",
          note: "auto-stop canceled because a user prompt was accepted before the stop request was sent",
        };
        return;
      }
      await this.options.box.stop(boxId).catch(() => undefined);
    }
    if (canceled()) {
      const afterStop = await this.options.box.get(boxId).catch(() => undefined);
      if (afterStop?.state === "archived") {
        yield {
          type: "lifecycle",
          boxId,
          state: "resuming",
          note: "auto-stop stop request raced a new accepted prompt; resuming private box",
        };
        await this.options.box.resume(boxId).catch(() => undefined);
        await this.waitUntilReady(boxId, "cancel-auto-stop-resume").catch(() => undefined);
      }
      yield {
        type: "autostop.timer",
        phase: "canceled",
        boxId,
        remainingMs: 0,
        reason: "new-user-message",
        note: "auto-stop canceled because a user prompt was accepted while shutdown was starting",
      };
      return;
    }
    // Billing stops the moment the stop request is accepted — the ~1min the
    // platform then spends snapshotting/archiving is not the user's time. This
    // also freezes the UI's machine counter at the countdown's zero instead of
    // letting it tick through the archive (which read as "it never stops").
    const elapsedSeconds = this.endBilling(boxId) ?? 0;
    yield {
      type: "billing.stop",
      boxId,
      elapsedSeconds,
      costUsd: elapsedSeconds * BOX_PRICE_USD_PER_SECOND,
      note: "billing PAUSED — you pay $0 while the box is stopped",
    };
    yield {
      type: "lifecycle",
      boxId,
      state: "archiving",
      note: "snapshotting disk & archiving",
    };
    let final: BoxInfo | undefined;
    try {
      final = await this.waitUntilArchived(boxId, "stop");
    } catch {
      /* best-effort */
    }
    yield {
      type: "lifecycle",
      boxId,
      state: final?.state ?? "archived",
      note: "archived — disk snapshot kept, resumes with no cold start",
    };
  }

  /** Stop a box, retrying while the platform refuses (e.g. no snapshot yet on a young box). */
  private async stopWithRetry(boxId: string, label: string, attempts = 15, delayMs = 20_000): Promise<void> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.options.box.stop(boxId);
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delayMs);
        (t as any).unref?.();
      });
    }
    throw new Error(`stop for ${label} (${boxId}) kept being refused after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async waitUntilArchived(
    boxId: string,
    label: string,
    timeoutOverrideMs?: number,
  ): Promise<BoxInfo> {
    const pollMs = this.options.readinessPollMs ?? 2000;
    const timeoutMs =
      timeoutOverrideMs ?? this.options.handoffTimeoutMs ?? 120_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const box = await this.options.box.get(boxId);
      if (box.state === "archived" || box.state === "stopped") return box;
      if (box.state === "error")
        throw new Error(
          `Box ${boxId} entered error while waiting for ${label}`,
        );
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(
      `Timed out waiting for Box ${boxId} to become archived for ${label}`,
    );
  }

  /**
   * A box is "ready" when it actually EXECUTES a command — rule 5's definition of
   * responsive. The reported `state` field lags real usability by many seconds
   * (measured: fork commands succeed at ~1-4s while state says 'ready' only at
   * ~13s), so waiting on the state alone silently costs ~8s on every boot. The
   * state is still polled alongside, but only to detect terminal error/stopped.
   */
  private async waitUntilReady(
    boxId: string,
    label: string,
    timeoutOverrideMs?: number,
  ): Promise<BoxInfo> {
    const pollMs = this.options.readinessPollMs ?? 2000;
    const timeoutMs =
      timeoutOverrideMs ?? this.options.handoffTimeoutMs ?? 120_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const probe = await this.options.box
        .command(boxId, { command: "echo __BOX_UP__", timeoutMs: 10_000 })
        .catch(() => undefined);
      const box = await this.options.box.get(boxId);
      if (probe && probe.exitCode === 0 && probe.stdout.includes("__BOX_UP__")) return box;
      if (box.state === "error")
        throw new Error(
          `Box ${boxId} entered error while waiting for ${label}`,
        );
      if (box.state === "archived" || box.state === "stopped")
        throw new BoxTerminalStateError(boxId, box.state, label);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(
      `Timed out waiting for Box ${boxId} to become responsive for ${label}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHarnessChunk(value: unknown): { text: string; messageId?: string; messageIndex?: number } {
  if (typeof value === "object" && value !== null && "text" in value) {
    const chunk = value as { text?: unknown; messageId?: unknown; messageIndex?: unknown };
    const out: { text: string; messageId?: string; messageIndex?: number } = { text: String(chunk.text ?? "") };
    if (typeof chunk.messageId === "string" && chunk.messageId) out.messageId = chunk.messageId;
    if (typeof chunk.messageIndex === "number" && Number.isFinite(chunk.messageIndex)) out.messageIndex = chunk.messageIndex;
    return out;
  }
  return { text: String(value ?? ""), messageId: "assistant-0", messageIndex: 0 };
}

const PRIVATE_END_SENTINEL = "<end>";

/**
 * Trace stages that prove a turn engaged or queued the private Box (even if it
 * never produced a visible answer). Used by the idle-auto-stop gate to tell a
 * pure shared turn (which may stop a warm box) apart from a box-bound turn whose
 * agent has not settled yet (which must not stop the box).
 */
const PRIVATE_ROUTE_TRACE_STAGES = new Set<string>([
  "box.boot.queued",
  "private-round.active",
  "box.boot.start",
  "runtime.owner.selected",
]);

function requestFingerprint(message: string): string {
  return String(message ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function bootLifecycleState(ack: UserBoxBootAck): string {
  if (ack.action === "resume-requested" || ack.action === "adopt-resume-requested") return "resuming";
  if (ack.action === "fork-requested") return "forking";
  if (ack.action === "already-ready" || ack.action === "adopt-ready" || isReady(ack.box.state)) return "ready";
  return ack.box.state === "provisioning" || ack.box.state === "cloning" || ack.box.state === "provisioned"
    ? ack.box.state
    : "starting";
}

function bootLifecycleNote(ack: UserBoxBootAck): string {
  switch (ack.action) {
    case "already-ready":
      return "private Box already exists and is warm";
    case "adopt-ready":
      return "existing named private Box was adopted and is warm";
    case "adopt-resume-requested":
      return "existing archived private Box resume was accepted by Box API";
    case "resume-requested":
      return "private Box resume was accepted by Box API";
    case "existing-boot":
      return `private Box already exists and is still booting (${ack.box.state})`;
    case "create-requested":
      return `private Box create was accepted by Box API (${ack.box.state})`;
    case "fork-requested":
      return `private Box was forked from the pre-installed template snapshot (${ack.box.state})`;
    case "adopt-inflight":
      return `existing named private Box is already booting (${ack.box.state}) — waiting instead of duplicating`;
  }
}

function bootTraceMessage(ack: UserBoxBootAck): string {
  switch (ack.action) {
    case "already-ready":
    case "adopt-ready":
      return "private Box exists and is ready";
    case "resume-requested":
    case "adopt-resume-requested":
      return "private Box resume request was accepted by Box API";
    case "existing-boot":
    case "adopt-inflight":
      return "private Box already exists and is booting";
    case "create-requested":
      return "private Box create request was accepted by Box API";
    case "fork-requested":
      return "private Box fork from template snapshot was accepted by Box API";
  }
}

function isReady(state: string): boolean {
  return state === "ready" || state === "idle" || state === "running";
}
