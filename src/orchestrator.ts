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
  | { type: "trace"; stage: string; message: string; harness?: string; model?: string; boxId?: string }
  | { type: "turn.blocked"; stage: string; message: string; retryable: boolean; harness?: string; model?: string; boxId?: string }
  | { type: "shared.delta"; text: string; harness: string; final?: boolean }
  | { type: "shared.larp"; harness: string; toolIntent: boolean; note: string }
  | {
      type: "context.injected";
      scope: "shared" | "user-box";
      machine: MachineState;
      hidden: string;
    }
  | { type: "lifecycle"; state: string; boxId: string; note?: string }
  | {
      type: "autostop.timer";
      phase: "started" | "tick" | "canceled" | "stopping";
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
  | "resume-requested"
  | "existing-boot"
  | "adopt-ready"
  | "adopt-resume-requested";

interface UserBoxBootAck {
  action: UserBoxBootAction;
  box: BoxInfo;
}

type PrivateRoundState = "needed" | "active" | "answered" | "suppressed" | "stale";

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

export class ConsumerBoxAgentOrchestrator {
  private readonly sessions;
  private readonly recapper;
  private readonly harnesses: Map<string, HarnessAdapter>;
  private readonly transcripts = new Map<string, TranscriptMessage[]>();
  /** boxId -> epoch ms when billing started (set once while running, cleared on stop). */
  private readonly billing = new Map<string, number>();
  private sharedBoxPromise?: Promise<BoxInfo>;
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

  constructor(private readonly options: OrchestratorOptions) {
    this.sessions = options.sessions ?? new InMemorySessionStore();
    this.recapper = options.recapper ?? new ExtractiveRecapper();
    this.harnesses = new Map(options.harnesses.map((h) => [h.name, h]));
    if (this.harnesses.size === 0)
      throw new Error("At least one harness adapter is required");
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

  async ensureSharedBox(): Promise<BoxInfo> {
    this.sharedBoxPromise ??= this.options.box
      .create({
        name: this.options.sharedBoxName ?? "consumer-agent-shared-prewarm",
        ttlSeconds: null,
      })
      .then((box) => this.waitUntilReady(box.id, "shared"))
      .then((box) =>
        box.archiveAfter === null
          ? box
          : this.options.box.update(box.id, { ttlSeconds: null }),
      );
    return this.sharedBoxPromise;
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
    if (box.state === "archived")
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
    if (inFlight) return inFlight;
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
          } catch {
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
          } catch {
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
    const reusable = boxes
      .filter((box) => box.name === expectedName && (isReady(box.state) || box.state === "archived"))
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
    if (box.state === "archived") {
      try {
        await this.options.box.resume(box.id);
        onBootAck?.({ action: "adopt-resume-requested", box: await this.options.box.get(box.id).catch(() => box) });
        box = await this.waitUntilReady(box.id, "adopt-archived", this.options.resumeTimeoutMs);
      } catch {
        await this.clearSession(userId, conversationId);
        return undefined;
      }
    } else {
      onBootAck?.({ action: "adopt-ready", box });
      box = await this.waitUntilReady(reusable.id, "adopt-existing");
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
    const created = await this.options.box.create({
      name:
        this.options.userBoxName?.(userId) ?? `consumer-agent-user-${userId}`,
      ttlSeconds: this.options.userBoxTtlSeconds ?? 3600,
    });
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
      )) {
        if (ev.type === "trace" && ev.stage === "user-box.response.end") boxAgentSettled = true;
        if (ev.type === "turn.done" && Boolean(ev.boxId) && (ev.route === "direct" || ev.route === "bridge") && ev.settled === true) boxAgentSettled = true;
        if (ev.type === "turn.done" && ev.settled !== false) promptAnswered = true;
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
      if (promptAnswered || boxAgentSettled) this.markPromptAnswered(key, turnId);
      // If the browser closes/aborts the SSE stream after the shared bridge but
      // before the private handoff completes, the generator is returned early.
      // Always clear the active stream count so a canceled preview request cannot
      // leave the conversation permanently "active" and block future settlement.
      const activeTurns = Math.max(0, (this.activeTurnCounts.get(key) ?? 1) - 1);
      if (activeTurns === 0) this.activeTurnCounts.delete(key);
      else this.activeTurnCounts.set(key, activeTurns);
    }

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
    void this.ensureSharedBox().catch(() => undefined);

    yield {
      type: "trace",
      stage: "shared.reasoning.start",
      message: "shared assistant is ready to respond if the private runtime is not immediately available; private Box boot/resume will be requested eagerly, and box.boot.start is emitted only after Box API accepts it",
      harness: harness.name,
      model: input.selection.model,
    };

    const activeAtSubmit = this.activePrivateRound(key);
    const candidateRound = activeAtSubmit ? undefined : this.reservePrivateRound(key, input.message);
    const roundBlockedAtSubmit = Boolean(activeAtSubmit || candidateRound?.state === "stale");
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
            const latestStatus = await this.userBoxStatus(input.userId, input.conversationId);
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
    };

    if (roundBlockedAtSubmit || lockBusyAtSubmit) {
      yield {
        type: "trace",
        stage: activeAtSubmit ? "private-round.active" : candidateRound?.state === "stale" ? "private-round.stale" : "box.boot.queued",
        message: activeAtSubmit
          ? `private round ${activeAtSubmit.id} is already active for this conversation; this shared turn will not enqueue another Box round`
          : candidateRound?.state === "stale"
            ? "this request was already answered by the private runtime; no Box round will be queued"
            : "private Box boot/resume is queued behind an active private runtime or stop; no Box API start/resume has been confirmed for this turn yet",
        harness: harness.name,
        model: input.selection.model,
        ...("boxId" in resolvedStatus ? { boxId: resolvedStatus.boxId } : {}),
      };
    } else {
      const bootAck = await bootAckPromise.catch((error) => {
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
        yield* this.emitConfirmedBootStart(bootAck, harness, input.selection.model);
      }
    }

    // True fast path: if the private runtime is known warm and no stop/turn has
    // the private lock, route directly. This preserves the adaptive behavior
    // that avoids unnecessary shared bridge text for a ready Box.
    if (resolvedStatus.kind === "ready" && !lockBusyAtSubmit && !activeAtSubmit && privateReady && candidateRound) {
      const privateResult = await privateReady;
      privateReadyConsumed = true;
      try {
        if (privateResult.status.kind === "ready") {
          yield {
            type: "shared.larp",
            harness: harness.name,
            toolIntent: true,
            note: "private environment already warm; skipping shared bridge and continuing directly",
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
          yield* this.runPrivateRuntime(
            input,
            key,
            harness,
            privateResult.box,
            transcript,
            "",
            privateResult.status,
            round,
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
      type: "shared.larp",
      harness: harness.name,
      toolIntent: true,
      note:
        bridgeStatus === "resuming"
          ? "private environment is resuming; shared assistant is covering latency"
          : "private environment is starting; shared assistant is covering latency",
    };

    let rawSharedText = "";
    let emittedSharedText = "";
    const bufferSharedUntilRouted = sharedNeedsPrivate("", input.message);
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
      toolIntent: false,
      ...(knownSharedSessionId ? { sessionId: knownSharedSessionId } : {}),
      onSessionId: (id: string) => this.harnessSessions.set(sharedSessionKey, id),
    })) {
      rawSharedText += String(text ?? "");
      if (bufferSharedUntilRouted) continue;
      const visible = visibleSharedText(rawSharedText);
      if (visible.length > emittedSharedText.length) {
        const delta = visible.slice(emittedSharedText.length);
        emittedSharedText = visible;
        if (delta) yield { type: "shared.delta", text: delta, harness: harness.name, final: false };
      }
    }

    const sharedText = sanitizeSharedBridgeText(stripSharedControl(rawSharedText) || emittedSharedText);
    if (!emittedSharedText && sharedText) {
      emittedSharedText = sharedText;
      yield { type: "shared.delta", text: sharedText, harness: harness.name, final: false };
    }
    if (sharedText) {
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
    }

    const needsPrivate = sharedNeedsPrivate(rawSharedText, input.message);
    if (!needsPrivate) {
      if (candidateRound) this.markPrivateRound(key, candidateRound, "suppressed");
      this.discardPreparedPrivateRuntime(privateReady);
      yield {
        type: "trace",
        stage: "private-round.suppressed",
        message: "authoritative request state marked this turn suppressed because the shared answer did not require a private Box round",
        harness: harness.name,
        model: input.selection.model,
        ...("boxId" in resolvedStatus ? { boxId: resolvedStatus.boxId } : {}),
      };
      yield { type: "turn.done", harness: harness.name, model: input.selection.model, route: "shared", settled: true };
      adaptiveTurnCompleted = true;
      return;
    }

    const round = candidateRound;
    if (!round || round.state === "stale" || activeAtSubmit || !privateReady) {
      if (round) this.markPrivateRound(key, round, "stale");
      this.discardPreparedPrivateRuntime(privateReady);
      yield {
        type: "trace",
        stage: "private-round.suppressed",
        message: activeAtSubmit
          ? `private round ${activeAtSubmit.id} is already active; not enqueueing another Box round for this shared-side message`
          : "private Box output suppressed because this request is stale or already answered",
        harness: harness.name,
        model: input.selection.model,
        ...("boxId" in resolvedStatus ? { boxId: resolvedStatus.boxId } : {}),
      };
      yield {
        type: "turn.done",
        harness: harness.name,
        model: input.selection.model,
        route: "shared",
        settled: !activeAtSubmit,
      };
      adaptiveTurnCompleted = true;
      return;
    }
    this.markPrivateRound(key, round, "active");

    let privateResult: { box: BoxInfo; status: UserBoxStatus; release: () => void };
    try {
      privateResult = await privateReady;
      privateReadyConsumed = true;
    } catch (error) {
      this.markPrivateRound(key, round, "suppressed");
      while (recoveryEvents.length) yield recoveryEvents.shift()!;
      yield {
        type: "turn.blocked",
        stage: "box.runtime.unavailable",
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
        retryable: true,
        harness: harness.name,
        model: input.selection.model,
        ...("boxId" in resolvedStatus ? { boxId: resolvedStatus.boxId } : {}),
      };
      adaptiveTurnCompleted = true;
      return;
    }

    try {
      if (!confirmedBootEmitted) {
        const bootAck = await bootAckPromise.catch(() => undefined);
        if (bootAck) {
          confirmedBootEmitted = true;
          yield* this.emitConfirmedBootStart(bootAck, harness, input.selection.model);
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
  ): AsyncIterable<ConsumerTurnEvent> {
    yield {
      type: "trace",
      stage: "runtime.owner.selected",
      message: `selected runtime ${harness.name} owns this turn; no Box prompt/API or host agent responder`,
      harness: harness.name,
      model: input.selection.model,
      boxId: box.id,
    };
    const { since, fresh } = this.startBilling(box.id);
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
    );
  }

  private *emitConfirmedBootStart(
    bootAck: UserBoxBootAck,
    harness: HarnessAdapter,
    model: string,
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
      const { since, fresh } = this.startBilling(bootAck.box.id);
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

  private activePrivateRound(key: string): PrivateRequestRound | undefined {
    const active = this.privateRequests.get(key)?.active;
    return active && (active.state === "needed" || active.state === "active") ? active : undefined;
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

  private reservePrivateRound(key: string, message: string): PrivateRequestRound {
    const state = this.requestState(key);
    const fingerprint = requestFingerprint(message) || randomUUID();
    const now = Date.now();
    const existingActive = this.activePrivateRound(key);
    const round: PrivateRequestRound = {
      id: randomUUID(),
      fingerprint,
      message,
      state: existingActive || state.answeredFingerprints.has(fingerprint) ? "stale" : "needed",
      createdAt: now,
      updatedAt: now,
    };
    state.rounds.set(round.id, round);
    if (round.state === "needed") state.active = round;
    return round;
  }

  private markPrivateRound(key: string, round: PrivateRequestRound, state: PrivateRoundState): void {
    const conversation = this.requestState(key);
    round.state = state;
    round.updatedAt = Date.now();
    conversation.rounds.set(round.id, round);
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
    return (
      this.turnSequences.get(key) !== turnSequence ||
      this.activeTurnCounts.has(key) ||
      this.hasUnansweredPrompts(key) ||
      Boolean(this.activePrivateRound(key)) ||
      this.userBoxStarts.has(key)
    );
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
      const deadlineEpochMs = Date.now() + delayMs;
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
      while (true) {
        if (this.isConversationBusyForIdleStop(key, turnSequence)) {
          yield {
            type: "autostop.timer",
            phase: "canceled",
            boxId,
            remainingMs: Math.max(0, deadlineEpochMs - Date.now()),
            deadlineEpochMs,
            reason: "new-user-message",
            note: "auto-stop countdown reset because a new user message arrived; it will restart after that response finishes",
          };
          return;
        }

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

    if (this.isConversationBusyForIdleStop(key, turnSequence)) {
      yield {
        type: "autostop.timer",
        phase: "canceled",
        boxId,
        remainingMs: 0,
        reason: "new-user-message",
        note: "auto-stop skipped because a new user message arrived before stop could begin",
      };
      return;
    }

    const release = await this.acquireLock(this.boxLocks, key);
    try {
      if (this.isConversationBusyForIdleStop(key, turnSequence)) {
        yield {
          type: "autostop.timer",
          phase: "canceled",
          boxId,
          remainingMs: 0,
          reason: "new-user-message",
          note: "auto-stop skipped because a new user message is using the private Box",
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
      onSessionId: (id: string) => this.harnessSessions.set(userBoxSessionKey, id),
      onComplete: (info: HarnessCompletion) => { completion = info; },
    });
    let userText = "";
    let lastToolStdout = "";
    let sawToolUse = false;
    let heldEndCandidate = "";
    const itc = continued[Symbol.asyncIterator]();
    const harnessName = harness.name;
    const selectionModel = input.selection.model;
    const flushExecEvents = function* (): Iterable<ConsumerTurnEvent> {
      while (execEvents.length) {
        const ev = execEvents.shift()!;
        if (ev.type === "harness.tool") {
          if (ev.phase === "tool_use") sawToolUse = true;
          if (ev.phase === "tool_result" && typeof ev.stdout === "string" && ev.stdout.trim())
            lastToolStdout = ev.stdout.trim();
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
    while (true) {
      const n = await itc.next();
      yield* flushExecEvents();
      if (n.done) break;
      yield* emitPrivateChunk(n.value);
    }
    yield* flushExecEvents();
    if (heldEndCandidate && heldEndCandidate !== PRIVATE_END_SENTINEL) {
      yield* emitChunkEvent({ text: heldEndCandidate, messageId: "assistant-0", messageIndex: 0 });
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
      };
      yield { type: "turn.done", boxId: box.id, harness: harness.name, model: input.selection.model, route: "shared" };
      return;
    }
    if (userText === PRIVATE_END_SENTINEL) {
      yield {
        type: "trace",
        stage: "user-box.response.end",
        message: "private Box agent returned exactly <end>; no private answer will be surfaced",
        harness: harness.name,
        model: input.selection.model,
        boxId: box.id,
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
    if (!userText.trim() && sawToolUse && lastToolStdout) {
      const fallback = buildToolResultFallback(input.message, lastToolStdout);
      userText += fallback;
      yield {
        type: "user-box.delta",
        text: fallback,
        boxId: box.id,
        harness: harness.name,
        model: input.selection.model,
        messageId: "fallback-0",
        messageIndex: 0,
      };
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
    if (!userText) this.markPrivateRound(key, round, "suppressed");
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

  private startBilling(boxId: string): { since: number; fresh: boolean } {
    let since = this.billing.get(boxId);
    const fresh = since === undefined;
    if (since === undefined) {
      since = Date.now();
      this.billing.set(boxId, since);
    }
    return { since, fresh };
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
    const since = this.billing.get(boxId);
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
    const elapsedSeconds = since ? Math.max(0, (Date.now() - since) / 1000) : 0;
    this.billing.delete(boxId);
    yield {
      type: "billing.stop",
      boxId,
      elapsedSeconds,
      costUsd: elapsedSeconds * BOX_PRICE_USD_PER_SECOND,
      note: "billing PAUSED — you pay $0 while the box is stopped",
    };
  }

  async stopIdleUserBox(userId: string, conversationId: string): Promise<void> {
    const session = await this.sessions.get(userId, conversationId);
    if (session?.boxId) {
      await this.options.box.stop(session.boxId);
      this.billing.delete(session.boxId);
    }
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
      if (box.state === "archived") return box;
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
      const box = await this.options.box.get(boxId);
      if (isReady(box.state)) return box;
      if (box.state === "error")
        throw new Error(
          `Box ${boxId} entered error while waiting for ${label}`,
        );
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(
      `Timed out waiting for Box ${boxId} to become ready for ${label}`,
    );
  }
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

const SHARED_ROUTING_RE = /<shared-routing>\s*({[\s\S]*?})\s*<\/shared-routing>/i;

function visibleSharedText(text: string): string {
  const raw = String(text ?? "");
  const controlStart = raw.search(/<shared-routing>/i);
  const withoutPartial = controlStart >= 0 ? raw.slice(0, controlStart) : raw;
  return stripSharedControl(withoutPartial);
}

function stripSharedControl(text: string): string {
  return String(text ?? "")
    .replace(SHARED_ROUTING_RE, "")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function sharedNeedsPrivate(rawSharedText: string, message: string): boolean {
  const match = SHARED_ROUTING_RE.exec(String(rawSharedText ?? ""));
  if (match?.[1]) {
    try {
      const parsed = JSON.parse(match[1]) as { needsPrivate?: unknown };
      if (typeof parsed.needsPrivate === "boolean") return parsed.needsPrivate;
    } catch {
      // Fall back to the deterministic message heuristic below if a harness
      // emits malformed routing metadata.
    }
  }
  return /\b(run|execute|shell|bash|terminal|command|file|create|write|edit|read|inspect|check|list|install|curl|hostname|ip|ip address|ipv[46]|cpu|core|nproc|pwd|directory)\b/i.test(message);
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

function sanitizeSharedBridgeText(text: string): string {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  const fallback = nextBridgeText();
  if (!trimmed) return fallback;
  if (isLeakySharedBridge(trimmed)) return fallback;
  return trimmed;
}

function isLeakySharedBridge(text: string): boolean {
  return /\b(can't|cannot|can not|don't have|do not have|no access|no tools|lack|limited|unable|not able|conversation only|inspect hardware|can't inspect|cannot inspect|fixed ip|persistent network identity|machine presence|conversational ai|chatbot|as an ai|box environment|inside (a|the|your) box|box is (booting|starting|resuming|ready))\b/i.test(text);
}

function nextBridgeText(): string {
  const options = [
    "I’m checking that now.",
    "I’m looking into it.",
    "On it — I’ll take a look.",
    "Got it, I’m checking.",
  ];
  return options[Math.floor(Math.random() * options.length)]!;
}

function buildToolResultFallback(message: string, stdout: string): string {
  const marker = /\breply\s+(?:exactly\s+)?(?:with\s+)?([A-Z][A-Z0-9_]{2,})\b/.exec(message)?.[1];
  const value = stdout.trim();
  return marker ? `${marker} ${value}` : `Done — observed: ${value}`;
}

function bootLifecycleState(ack: UserBoxBootAck): string {
  if (ack.action === "resume-requested" || ack.action === "adopt-resume-requested") return "resuming";
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
      return "private Box already exists and is booting";
    case "create-requested":
      return "private Box create request was accepted by Box API";
  }
}

function isReady(state: string): boolean {
  return state === "ready" || state === "idle" || state === "running";
}
