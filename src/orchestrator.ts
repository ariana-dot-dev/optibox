import { randomUUID } from "node:crypto";
import {
  createRestrictedSharedCapabilities,
  createUserBoxCapabilities,
} from "./capabilities.js";
import {
  BOX_PRICE_USD_PER_SECOND,
  BOX_PRICING,
  buildHiddenContext,
  detectToolIntent,
  type MachineState,
} from "./context.js";
import { ExtractiveRecapper } from "./recap.js";
import { InMemorySessionStore } from "./store.js";
import type {
  BoxInfo,
  HarnessAdapter,
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
  | { type: "shared.delta"; text: string; harness: string }
  | { type: "shared.larp"; harness: string; toolIntent: boolean; note: string }
  | {
      type: "context.injected";
      scope: "shared" | "user-box";
      machine: MachineState;
      hidden: string;
    }
  | { type: "lifecycle"; state: string; boxId: string; note?: string }
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
      type: "exec";
      kind: "command" | "harness";
      argv?: string[];
      command?: string;
      boxId: string;
    }
  | {
      type: "user-box.delta";
      text: string;
      boxId: string;
      harness: string;
      model: string;
    }
  | {
      type: "turn.done";
      boxId: string;
      harness: string;
      model: string;
      route?: "shared-only" | "direct" | "bridge";
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
  /**
   * Per-conversation FIFO mutex for private Box work. Every user turn goes
   * through this lock and into the Box; there is deliberately no message
   * content heuristic that can keep a turn on the shared machine.
   */
  private readonly boxLocks = new Map<string, Promise<void>>();
  /** Monotonic per-conversation counter. Delayed auto-stop only fires if no newer user turn bumped this value. */
  private readonly turnSequences = new Map<string, number>();

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
  ): Promise<BoxInfo> {
    const key = `${userId}:${conversationId}`;
    const inFlight = this.userBoxStarts.get(key);
    if (inFlight) return inFlight;
    const started = this.ensureUserBoxUncached(userId, conversationId);
    this.userBoxStarts.set(key, started);
    try {
      return await started;
    } finally {
      if (this.userBoxStarts.get(key) === started)
        this.userBoxStarts.delete(key);
    }
  }

  private async ensureUserBoxUncached(
    userId: string,
    conversationId: string,
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
          return this.waitUntilReady(
            existing.boxId,
            "resume",
            this.options.resumeTimeoutMs,
          );
        }
        if (box.state === "archived") {
          await this.options.box.resume(existing.boxId);
          try {
            return await this.waitUntilReady(
              existing.boxId,
              "resume",
              this.options.resumeTimeoutMs,
            );
          } catch {
            return this.createFreshUserBox(userId, conversationId);
          }
        }
        if (isReady(box.state)) return box;
        if (box.state !== "error")
          return this.waitUntilReady(existing.boxId, "existing");
        // error state -> fall through and provision a fresh box
      }
    }
    return this.createFreshUserBox(userId, conversationId);
  }

  private async createFreshUserBox(
    userId: string,
    conversationId: string,
  ): Promise<BoxInfo> {
    const created = await this.options.box.create({
      name:
        this.options.userBoxName?.(userId) ?? `consumer-agent-user-${userId}`,
      ttlSeconds: this.options.userBoxTtlSeconds ?? 3600,
    });
    await this.sessions.put({
      userId,
      conversationId,
      boxId: created.id,
      lastSeenAt: Date.now(),
    });
    return this.waitUntilReady(created.id, "create");
  }

  private async ensureUserBoxWithRecovery(
    userId: string,
    conversationId: string,
    status: UserBoxStatus,
    emit: (event: ConsumerTurnEventBody) => void,
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
        const fresh = await this.createFreshUserBox(userId, conversationId);
        emit({
          type: "lifecycle",
          boxId: fresh.id,
          state: fresh.state,
          note: "fresh private box recovered from stale resume",
        });
        return fresh;
      }
    }
    return this.ensureUserBox(userId, conversationId);
  }

  async *runTurn(input: ConsumerTurnInput): AsyncIterable<ConsumerTurnEvent> {
    const key = `${input.userId}:${input.conversationId}`;
    const turnId = randomUUID();
    const turnSequence = this.bumpTurnSequence(key);
    const toolIntent = detectToolIntent(input.message);
    const status = await this.userBoxStatus(input.userId, input.conversationId);

    // Pure chat while no private Box is ready is answered immediately by the
    // shared front desk, while a single private Box boots in the background.
    // The shared message is final for that chatty turn, so there is no stale
    // "hey" handoff and no duplicate user-box answer later.
    if (!toolIntent && status.kind !== "ready") {
      for await (const ev of this.runSharedOnlyTurn(input, key, status))
        yield { ...ev, turnId };
      return;
    }

    // Tool work, or any message once the Box is warm, is serialized into the
    // private Box. While the Box provisions/resumes the shared machine can emit
    // a short holding reply, then exactly one handoff continues the latest turn.
    const release = await this.acquireLock(this.boxLocks, key);
    try {
      for await (const ev of this.runBoxTurn(input, key, status, toolIntent))
        yield { ...ev, turnId };
    } finally {
      release();
    }

    // Keep the Box warm briefly after the answer. If another user turn arrives
    // during this window, it bumps turnSequences[key], this stop is skipped,
    // and the next turn can reuse the warm Box immediately.
    for await (const ev of this.stopAfterIdle(input, key, turnSequence))
      yield { ...ev, turnId };
  }

  private async *runSharedOnlyTurn(
    input: ConsumerTurnInput,
    key: string,
    status: UserBoxStatus,
  ): AsyncIterable<ConsumerTurnEvent> {
    const transcript = this.transcripts.get(key) ?? [];
    transcript.push({
      role: "user",
      content: input.message,
      mode: "shared",
      at: new Date().toISOString(),
    });
    this.transcripts.set(key, transcript);

    const harness = this.harness(input.selection.harness);
    void this.ensureSharedBox().catch(() => undefined);

    // Fire-and-forget one private Box startup/resume. ensureUserBox internally
    // dedupes by conversation, so the next tool turn will await this same boot
    // instead of launching a second Box or producing a second handoff.
    void this.ensureUserBoxWithRecovery(
      input.userId,
      input.conversationId,
      status,
      () => {
        /* background prewarm: lifecycle becomes visible when a tool turn awaits it */
      },
    ).catch(() => undefined);

    const sharedMachine: MachineState = {
      location: "shared-box",
      tools: false,
      status: "prewarming",
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

    let sharedText = "";
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
    })) {
      const chunk = String(text ?? "");
      sharedText += chunk;
      yield { type: "shared.delta", text: chunk, harness: harness.name };
    }
    if (sharedText)
      transcript.push({
        role: "assistant",
        content: sharedText,
        mode: "shared",
        harness: harness.name,
        at: new Date().toISOString(),
      });
    yield {
      type: "turn.done",
      boxId: status.kind === "none" ? "" : status.boxId,
      harness: harness.name,
      model: input.selection.model,
      route: "shared-only",
    };
  }

  private async *runBoxTurn(
    input: ConsumerTurnInput,
    key: string,
    status: UserBoxStatus,
    toolIntent: boolean,
  ): AsyncIterable<ConsumerTurnEvent> {
    const transcript = this.transcripts.get(key) ?? [];
    transcript.push({
      role: "user",
      content: input.message,
      mode: "shared",
      at: new Date().toISOString(),
    });
    this.transcripts.set(key, transcript);

    const harness = this.harness(input.selection.harness);
    // STATE-AWARE ROUTING. Decide the path from the box's PRECISE current state,
    // never a blanket shared-first fallback.
    //   ready                -> DIRECT to the private box (no shared, no swap)
    //   none/archived/        \
    //   archiving/provisioning -> shared BRIDGE while we provision/resume, then handoff
    //   error                -> shared bridge while we provision a fresh box
    if (status.kind === "ready") {
      // FAST PATH: the private box already exists and is warm. Route the message
      // straight to the user-box agent. No shared agent runs, so there is NO
      // misleading "I can't access…" reply and NO bounce back to shared.
      const box = status.box;
      const { since } = this.startBilling(box.id);
      yield {
        type: "billing.start",
        boxId: box.id,
        ratePerSecond: BOX_PRICE_USD_PER_SECOND,
        sinceEpochMs: since,
        pricing: BOX_PRICING,
      };
      yield {
        type: "lifecycle",
        boxId: box.id,
        state: box.state,
        note: "private box already warm — routing your message straight to it (no shared agent)",
      };
      yield* this.continueInUserBox(
        input,
        harness,
        box,
        transcript,
        "",
        "direct",
      );
      return;
    }

    // BRIDGE PATH: the private box is not ready yet. Start the real restricted
    // shared LLM immediately with hidden/system guidance, then wait for the
    // private environment and continue the latest request there. No scripted
    // response or user-visible lifecycle event is emitted.
    const resuming = status.kind === "archived" || status.kind === "archiving";
    const bridgeStatus: NonNullable<MachineState["status"]> = resuming
      ? "resuming"
      : "provisioning";
    void this.ensureSharedBox().catch(() => undefined);

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
      toolIntent,
      note: resuming
        ? "private environment is resuming; restricted shared model is guided by hidden instructions"
        : "private environment is starting; restricted shared model is guided by hidden instructions",
    };

    const recoveryEvents: ConsumerTurnEventBody[] = [];
    const userBoxPromise = this.ensureUserBoxWithRecovery(
      input.userId,
      input.conversationId,
      status,
      (event) => recoveryEvents.push(event),
    ).then(
      (box) => ({ box, error: undefined as unknown }),
      (error) => ({ box: undefined as unknown as BoxInfo, error }),
    );

    let sharedText = "";
    for await (const text of harness.shared({
      userId: input.userId,
      conversationId: input.conversationId,
      message: input.message,
      transcript,
      selection: input.selection,
      capabilities: createRestrictedSharedCapabilities(),
      hiddenContext: sharedHidden,
      machine: sharedMachine,
      toolIntent,
    })) {
      const chunk = String(text ?? "");
      sharedText += chunk;
      yield { type: "shared.delta", text: chunk, harness: harness.name };
    }
    if (sharedText)
      transcript.push({
        role: "assistant",
        content: sharedText,
        mode: "shared",
        harness: harness.name,
        at: new Date().toISOString(),
      });

    const boxResult = await userBoxPromise;
    if (boxResult.error) throw boxResult.error;
    const box = boxResult.box;
    while (recoveryEvents.length) yield recoveryEvents.shift()!;
    const { since } = this.startBilling(box.id);
    yield {
      type: "billing.start",
      boxId: box.id,
      ratePerSecond: BOX_PRICE_USD_PER_SECOND,
      sinceEpochMs: since,
      pricing: BOX_PRICING,
    };
    yield {
      type: "lifecycle",
      boxId: box.id,
      state: box.state,
      note: resuming
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
    transcript.push({
      role: "system",
      content: recap,
      mode: "handoff",
      at: new Date().toISOString(),
    });

    yield* this.continueInUserBox(
      input,
      harness,
      box,
      transcript,
      sharedText,
      "bridge",
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
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (this.turnSequences.get(key) !== turnSequence) return;

    const release = await this.acquireLock(this.boxLocks, key);
    try {
      if (this.turnSequences.get(key) !== turnSequence) return;
      yield* this.stopUserBoxLocked(input.userId, input.conversationId);
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
    harness: HarnessAdapter,
    box: BoxInfo,
    transcript: TranscriptMessage[],
    partialShared: string,
    route: "direct" | "bridge",
  ): AsyncIterable<ConsumerTurnEvent> {
    const recap = this.lastRecap(transcript);
    const userMachine: MachineState = {
      location: "user-box",
      tools: true,
      boxId: box.id,
      status: "live",
    };
    const userHidden = buildHiddenContext({
      transcript,
      machine: userMachine,
      partialShared,
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
    });
    const continued = harness.userBox({
      userId: input.userId,
      conversationId: input.conversationId,
      boxId: box.id,
      recap,
      latestUserMessage: input.message,
      transcript,
      selection: input.selection,
      capabilities,
      hiddenContext: userHidden,
      machine: userMachine,
      partialShared,
    });
    let userText = "";
    const itc = continued[Symbol.asyncIterator]();
    while (true) {
      const n = await itc.next();
      while (execEvents.length) yield execEvents.shift()!;
      if (n.done) break;
      const text = String(n.value ?? "");
      userText += text;
      yield {
        type: "user-box.delta",
        text,
        boxId: box.id,
        harness: harness.name,
        model: input.selection.model,
      };
    }
    while (execEvents.length) yield execEvents.shift()!;
    if (userText)
      transcript.push({
        role: "assistant",
        content: userText,
        mode: "user-box",
        harness: harness.name,
        model: input.selection.model,
        at: new Date().toISOString(),
      });
    yield {
      type: "turn.done",
      boxId: box.id,
      harness: harness.name,
      model: input.selection.model,
      route,
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
  ): AsyncIterable<ConsumerTurnEvent> {
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
      await this.options.box.stop(boxId).catch(() => undefined);
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

function isReady(state: string): boolean {
  return state === "ready" || state === "idle" || state === "running";
}
