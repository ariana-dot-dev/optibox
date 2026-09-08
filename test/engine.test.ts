import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "pg";
import { openDb, type Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { OAuthClient, type OAuthEndpoints } from "../src/oauth.js";
import type { BoxClient, BoxEvent, BoxInfo, CommandResult, HarnessSelection, PromptRun } from "../src/types.js";

/**
 * Behavioral suite for the 6-rule engine against a REAL ephemeral Postgres
 * database (created on the shared server, dropped after). The Box is a fake
 * that behaves like the integrated-agents API: prompts open conversations,
 * events carry the full text of each assistant message so far, prompt runs
 * settle, interrupts are scoped to one conversation.
 */

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL required for the engine suite");
const TEST_DB = `optibox_test_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const testUrl = baseUrl.replace(/\/[^/]*$/, `/${TEST_DB}`);

let db: Db;
before(async () => {
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();
  db = await openDb(testUrl);
});
after(async () => {
  await db.close();
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.end();
});

let nextBoxId = 1;
/** Scripted answer of the fake harness: frames of full text per message id, or a thrower. */
type Answer = { frames?: Array<{ id?: string; text: string; tools?: unknown[] }>; status?: "finished" | "failed"; hang?: boolean };

class FakeBoxClient implements BoxClient {
  boxes = new Map<string, BoxInfo>();
  commands: string[] = [];
  files = new Map<string, string>();
  prompts: Array<{ boxId: string; input: Record<string, unknown>; conversationId: string; promptId: string }> = [];
  interrupts: Array<{ boxId: string; conversationId?: string }> = [];
  resumes: Array<{ boxId: string; env?: Record<string, string> }> = [];
  writes: Array<{ boxId: string; path: string }> = [];
  eventsCalls = 0;
  private convs = 0;
  private runs = new Map<string, { conversationId: string; answer: Answer; events: BoxEvent[]; done: boolean }>();
  constructor(private answer: Answer | ((input: Record<string, unknown>) => Answer) = { frames: [{ text: "BOX:ran" }] }) {}
  async create(input: { name?: string; noEnv?: boolean; env?: Record<string, string> }): Promise<BoxInfo> {
    const id = `box-${nextBoxId++}`;
    const box: BoxInfo = { id, state: "idle", ...(input.name ? { name: input.name } : {}) };
    this.boxes.set(id, box);
    this.files.set(`${id}:create`, JSON.stringify({ noEnv: input.noEnv, env: input.env }));
    return box;
  }
  async get(boxId: string): Promise<BoxInfo> { return this.boxes.get(boxId) ?? { id: boxId, state: "error" }; }
  async update(boxId: string, input: { name?: string }): Promise<BoxInfo> {
    const updated = { ...(await this.get(boxId)), ...(input.name !== undefined ? { name: input.name } : {}) };
    this.boxes.set(boxId, updated);
    return updated;
  }
  async stop(boxId: string): Promise<BoxInfo> { const b = { ...(await this.get(boxId)), state: "archived" }; this.boxes.set(boxId, b); return b; }
  async resume(boxId: string, input: { env?: Record<string, string> } = {}): Promise<BoxInfo> {
    // The real API REPLACES the box's env when the body carries one, and keeps
    // the stored env when it does not — the fake records exactly that.
    this.resumes.push({ boxId, ...(input.env ? { env: input.env } : {}) });
    if (input.env) this.files.set(`${boxId}:create`, JSON.stringify({ noEnv: true, env: input.env }));
    const b = { ...(await this.get(boxId)), state: "idle" };
    this.boxes.set(boxId, b);
    return b;
  }
  async deleteBox(): Promise<void> { /* noop */ }
  async command(boxId: string, input: { command: string }): Promise<CommandResult> {
    const state = (await this.get(boxId)).state;
    if (!["ready", "idle", "running", "provisioned"].includes(state)) throw new Error(`fake box ${boxId} cannot run commands in state ${state}`);
    this.commands.push(input.command);
    return { exitCode: 0, stdout: `ran:${input.command}`, stderr: "" };
  }
  async readFile(boxId: string, path: string): Promise<string> { return this.files.get(`${boxId}:${path}`) ?? ""; }
  async writeFile(boxId: string, path: string, content: string): Promise<void> { this.writes.push({ boxId, path }); this.files.set(`${boxId}:${path}`, content); }
  async prompt(boxId: string, input: { conversationId?: string; new?: boolean; prompt: string }): Promise<PromptRun> {
    const conversationId = input.conversationId ?? `conv-${++this.convs}`;
    const promptId = `p-${this.prompts.length + 1}`;
    this.prompts.push({ boxId, input, conversationId, promptId });
    const answer = typeof this.answer === "function" ? this.answer(input) : this.answer;
    const events: BoxEvent[] = [];
    let t = Date.now();
    for (const f of answer.frames ?? []) {
      events.push({ id: f.id ?? "m1", type: "response", timestamp: t++, taskId: promptId, conversationId, data: { content: f.text, ...(f.tools ? { tools: f.tools } : {}), is_streaming: true } });
    }
    this.runs.set(promptId, { conversationId, answer, events, done: false });
    return { promptId, conversationId, status: "queued", done: false };
  }
  async promptRun(_boxId: string, promptId: string): Promise<PromptRun> {
    const run = this.runs.get(promptId)!;
    // Settles once every frame has been served (or never, when hanging).
    const done = !run.answer.hang && run.events.length === 0;
    return { promptId, conversationId: run.conversationId, status: done ? (run.answer.status ?? "finished") : "running", done };
  }
  async events(_boxId: string, input: { conversationId?: string }): Promise<{ events: BoxEvent[]; nextCursor?: string | null }> {
    this.eventsCalls++;
    // one frame per poll = streaming; a conversation's runs are served in order
    for (const run of this.runs.values()) {
      if (run.conversationId !== input.conversationId || run.events.length === 0) continue;
      return { events: [run.events.shift()!], nextCursor: null };
    }
    return { events: [], nextCursor: null };
  }
  async interrupt(boxId: string, conversationId?: string): Promise<void> {
    this.interrupts.push({ boxId, ...(conversationId ? { conversationId } : {}) });
    for (const run of this.runs.values()) if (run.conversationId === conversationId) { run.answer = { frames: [] }; run.events.length = 0; }
  }
}

const sharedStream = (text = "I’m checking that now.") => async function* () { yield text; };

function makeEngine(box: FakeBoxClient, extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}): Engine {
  return new Engine({
    db, box, sharedStream: sharedStream(),
    instanceId: "testinst", credHash: "cred0001",
    readinessPollMs: 1, autoStopIdleMs: 30, sweepIntervalMs: 0, handoffTimeoutMs: 5_000, eventPollMs: 1,
    providerEnv: { ANTHROPIC_API_KEY: "sk-test" },
    ...extra,
  });
}

const sel: HarnessSelection = { harness: "claude-code", provider: "anthropic", model: "claude-sonnet-5" };
async function collect(engine: Engine, userId: string, conversationId: string, message: string, selection = sel): Promise<any[]> {
  const events: any[] = [];
  for await (const e of engine.runTurn({ userId, conversationId, message, selection })) events.push(e);
  return events;
}
const visibleText = (events: any[]) => events.filter((e) => e.type === "user-box.delta").map((e) => e.text).join("");

test("rules 1+3: cold turn bridges (shared answers first), box answers on top, turn settles", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  const events = await collect(engine, "u1", "c1", "run something");
  const sharedIdx = events.findIndex((e) => e.type === "shared.delta");
  const boxIdx = events.findIndex((e) => e.type === "user-box.delta");
  assert.ok(sharedIdx >= 0, "shared bridge answered");
  assert.ok(boxIdx > sharedIdx, "box answered after the bridge");
  assert.ok(events.some((e) => e.type === "turn.done" && e.settled === true), "turn settled");
  assert.ok(events.some((e) => e.type === "handoff.started"), "handoff event stream intact");
  engine.dispose();
});

test("a fresh box carries the user's keys only (noEnv) and the standing rules in its home", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, { providerEnv: { OPENROUTER_API_KEY: "or-1" } });
  await collect(engine, "uk", "ck", "hello");
  const boxId = (await engine.activeUserBoxId("uk"))!;
  assert.deepEqual(JSON.parse(box.files.get(`${boxId}:create`)!), { noEnv: true, env: { OPENROUTER_API_KEY: "or-1" } });
  assert.match(box.files.get(`${boxId}:AGENTS.md`) ?? "", /<end>/, "AGENTS.md written once per machine");
  assert.equal(box.files.get(`${boxId}:CLAUDE.md`), box.files.get(`${boxId}:AGENTS.md`), "same rules for every harness");
  engine.dispose();
});

test("conversation memory is the Box's: first turn opens it, later turns and a harness switch resume it", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await collect(engine, "um", "cm", "first");
  await collect(engine, "um", "cm", "second");
  await collect(engine, "um", "cm", "third on pi", { harness: "pi", provider: "openrouter", model: "openrouter:anthropic/claude-sonnet-4.5", reasoningEffort: "high" });
  assert.equal(box.prompts.length, 3);
  assert.equal(box.prompts[0]!.input.new, true, "first prompt starts a new conversation");
  assert.equal(box.prompts[1]!.input.conversationId, box.prompts[0]!.conversationId, "second prompt resumes it");
  assert.equal(box.prompts[2]!.input.conversationId, box.prompts[0]!.conversationId, "harness switch keeps the same conversation");
  assert.equal(box.prompts[2]!.input.provider, "pi");
  assert.equal(box.prompts[2]!.input.reasoningEffort, "high");
  assert.match(String(box.prompts[0]!.input.prompt), /<partial-shared-response/, "shared text handed over");
  assert.doesNotMatch(String(box.prompts[1]!.input.prompt), /<consumer-context>/, "no transcript replay once the conversation exists");
  engine.dispose();
});

test("rule 5: direct route requires BOTH responsiveness and >=15s machine age", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await collect(engine, "u5", "c5", "first");
  const young = await collect(engine, "u5", "c5", "second while young");
  assert.ok(young.some((e) => e.type === "shared.delta"), "young box still gets the shared answer");
  assert.ok(!young.some((e) => e.stage === "route.direct"), "no direct route inside the warmup window");
  await db.q(`update boxes set billing_since = now() - interval '20 seconds' where user_key like 'u5-%'`);
  const events = await collect(engine, "u5", "c5", "third when warm");
  assert.ok(events.some((e) => e.type === "trace" && e.stage === "route.direct"), "direct route chosen when warm");
  assert.ok(!events.some((e) => e.type === "shared.delta"), "no bridge text on a warm box");
  assert.ok(events.some((e) => e.type === "user-box.delta"), "box answered");
  engine.dispose();
});

test("rule 6: <end> renders nothing but settles the turn", async () => {
  const box = new FakeBoxClient({ frames: [{ text: "<end>" }] });
  const engine = makeEngine(box);
  const events = await collect(engine, "u6", "c6", "hey there");
  assert.ok(!events.some((e) => e.type === "user-box.delta"), "sentinel is never shown");
  assert.ok(events.some((e) => e.type === "turn.done" && e.settled === true), "silent decline still settles");
  engine.dispose();
});

test("rule 6 streaming: a growing message never leaks a partial sentinel; text before it streams step by step", async () => {
  const box = new FakeBoxClient({ frames: [{ text: "4 CP" }, { text: "4 CPUs." }, { text: "4 CPUs.<" }, { text: "4 CPUs.<end" }, { text: "4 CPUs.<end>" }] });
  const engine = makeEngine(box);
  const events = await collect(engine, "u6t", "c6t", "cpu count");
  assert.equal(visibleText(events), "4 CPUs.", "answer streamed progressively, sentinel withheld");
  assert.ok(events.filter((e) => e.type === "user-box.delta").length >= 2, "streamed in more than one piece");
  assert.ok(events.some((e) => e.type === "turn.done" && e.settled === true));
  engine.dispose();
});

test("rule 6 streaming: a held partial flushes once disproven (real text ending in '<')", async () => {
  const box = new FakeBoxClient({ frames: [{ text: "a <" }, { text: "a <b" }] });
  const engine = makeEngine(box);
  const events = await collect(engine, "u6p", "c6p", "compare");
  assert.equal(visibleText(events), "a <b", "withheld prefix re-streams when it is not the sentinel");
  engine.dispose();
});

test("distinct assistant messages keep their native ids", async () => {
  const box = new FakeBoxClient({ frames: [{ id: "m1", text: "Looking." }, { id: "m2", text: "Done: 4 cores." }] });
  const engine = makeEngine(box);
  const events = await collect(engine, "u6m", "c6m", "cores");
  const deltas = events.filter((e) => e.type === "user-box.delta");
  assert.deepEqual(deltas.map((d) => d.messageId), ["m1", "m2"]);
  assert.deepEqual(deltas.map((d) => d.messageIndex), [0, 1]);
  engine.dispose();
});

test("rule 6 binding: a silent harness with NOTHING shown to the user is a LOUD turn.blocked", async () => {
  // The shared surface says nothing either, so the user would be left with an empty turn.
  const box = new FakeBoxClient({ frames: [] });
  const engine = makeEngine(box, { sharedStream: sharedStream("") });
  const events = await collect(engine, "u6b", "c6b", "do a thing");
  assert.equal(events.filter((e) => e.type === "turn.blocked").length, 1, "exactly one loud block");
  engine.dispose();
});

test("rule 6: a silent harness is FINE when the shared surface already answered in full", async () => {
  // Adding nothing is what <end> means; some models end the turn empty instead of typing it
  // (Kimi answers out of its thinking). The user has a complete answer, so a red error lies.
  const box = new FakeBoxClient({ frames: [] });
  const engine = makeEngine(box, { sharedStream: sharedStream("Paris is the capital of France.") });
  const events = await collect(engine, "u6c", "c6c", "capital of France?");
  assert.equal(events.filter((e) => e.type === "turn.blocked").length, 0, "no error on a turn the user got answered");
  const done = events.find((e) => e.type === "turn.done");
  assert.ok(done?.settled, "the turn settles");
  engine.dispose();
});

test("the <end> sentinel never reaches the user, even when the model types it FIRST", async () => {
  // Kimi opens with the sentinel and then answers anyway; "<end>I am Kimi..." was reaching the screen.
  const box = new FakeBoxClient({ frames: [{ id: "m1", text: "<end>I am Kimi, and here is the answer." }] });
  const engine = makeEngine(box);
  const events = await collect(engine, "uend", "cend", "who are you?");
  const shown = visibleText(events);
  assert.ok(!shown.includes("<end>"), `sentinel leaked: ${JSON.stringify(shown)}`);
  assert.ok(shown.includes("I am Kimi"), "the real answer still shows");
  engine.dispose();
});

test("tool calls stream as harness.tool events; a `host` command becomes a hosting row with provenance", async () => {
  const tools = [{ use: { id: "t1", name: "Bash", input: { command: "setsid nohup host 8080 --public > h.log 2>&1 &", description: "expose" } }, result: { tool_use_id: "t1", content: "started" } }];
  const box = new FakeBoxClient({ frames: [{ id: "m1", text: "", tools }, { id: "m2", text: "Hosted at https://x.on.ascii.dev" }] });
  const engine = makeEngine(box);
  const events = await collect(engine, "uh", "ch", "host my site");
  const uses = events.filter((e) => e.type === "harness.tool" && e.phase === "tool_use");
  const results = events.filter((e) => e.type === "harness.tool" && e.phase === "tool_result");
  assert.equal(uses.length, 1); assert.equal(results.length, 1);
  assert.equal(uses[0].command, "setsid nohup host 8080 --public > h.log 2>&1 &");
  assert.equal(results[0].stdout, "started");
  const rt = await engine.userRuntimeStatus("uh");
  assert.equal(rt.hosting.length, 1);
  assert.equal(rt.hosting[0]?.conversationId, "ch", "provenance recorded");
  engine.dispose();
});

test("hosting pins the box; stop intent is durable and enforced on the observed box", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await engine.ensureUserBox("uhs", "chs");
  const boxId = (await engine.activeUserBoxId("uhs"))!;
  await (engine as unknown as { markHosting(u: string, c: string, b: string, p: number, m: string): Promise<void> }).markHosting("uhs", "chs", boxId, 8080, "public");
  await new Promise((r) => setTimeout(r, 60));
  await (engine as unknown as { sweep(): Promise<void> }).sweep();
  assert.notEqual((await box.get(boxId)).state, "archived", "hosting pins the box");
  const res = await engine.stopHosting("uhs");
  assert.deepEqual(res.ports, [8080]);
  await engine.reconcileObservedHosting("uhs", boxId, [{ port: 8080, mode: "public" }]);
  assert.equal((await engine.userRuntimeStatus("uhs")).hosting.length, 0, "stopped hosting never resurrects from observation");
  assert.ok(box.commands.some((c) => c.includes("host hide 8080")), "authoritative takedown enforced");
  engine.dispose();
});

test("hosting ground truth: 2 consecutive misses clear the row", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await engine.ensureUserBox("um2", "cm2");
  const boxId = (await engine.activeUserBoxId("um2"))!;
  await (engine as unknown as { markHosting(u: string, c: string, b: string, p: number, m: string): Promise<void> }).markHosting("um2", "cm2", boxId, 9000, "private");
  await engine.reconcileObservedHosting("um2", boxId, []);
  assert.equal((await engine.userRuntimeStatus("um2")).hosting.length, 1, "one miss is grace");
  await engine.reconcileObservedHosting("um2", boxId, []);
  assert.equal((await engine.userRuntimeStatus("um2")).hosting.length, 0, "second miss clears");
  engine.dispose();
});

test("interrupt stops ONLY that turn's Box conversation and keeps its memory", async () => {
  // The first prompt never settles on its own; the follow-up after the interrupt does.
  const box = new FakeBoxClient((input) => (input.new ? { frames: [{ text: "working" }], hang: true } : { frames: [{ text: "resumed" }] }));
  const engine = makeEngine(box);
  const events: any[] = [];
  const run = (async () => { for await (const e of engine.runTurn({ userId: "ui", conversationId: "ci", message: "long task", selection: sel })) events.push(e); })();
  for (let i = 0; i < 200 && !events.some((e) => e.type === "user-box.delta"); i++) await new Promise((r) => setTimeout(r, 10));
  const turnId = events.find((e) => e.turnId)?.turnId;
  assert.equal(engine.interrupt(turnId), true);
  await run;
  assert.deepEqual(box.interrupts, [{ boxId: box.prompts[0]!.boxId, conversationId: box.prompts[0]!.conversationId }], "scoped interrupt, not the whole box");
  assert.ok(events.some((e) => e.stage === "turn.interrupted"));
  const rows = await db.q<{ status: string }>(`select status from turns where id=$1`, [turnId]);
  assert.equal(rows[0]?.status, "interrupted");
  // The next message resumes the SAME conversation (nothing was lost).
  await collect(engine, "ui", "ci", "continue");
  assert.equal(box.prompts[1]!.input.conversationId, box.prompts[0]!.conversationId);
  engine.dispose();
});

test("rule 4: sweeper stops the idle box, folds billing into the durable total", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  const events = await collect(engine, "u4", "c4", "warm me up");
  const boxId = events.find((e) => e.type === "turn.done")?.boxId;
  await new Promise((r) => setTimeout(r, 60));
  await (engine as unknown as { sweep(): Promise<void> }).sweep();
  assert.equal((await box.get(boxId)).state, "archived", "idle box stopped");
  const rt = await engine.userRuntimeStatus("u4");
  assert.equal(rt.billingSinceEpochMs, null, "billing ended");
  assert.ok(rt.billedSecondsTotal > 0, "elapsed seconds folded into the durable ledger");
  engine.dispose();
});

test("rule 4: holds and active turns block the sweeper; release unblocks", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  const events = await collect(engine, "u4h", "c4h", "hold me");
  const boxId = events.find((e) => e.type === "turn.done")?.boxId;
  const release = engine.holdUserBox("u4h", "upload", 60_000);
  await new Promise((r) => setTimeout(r, 60));
  await (engine as unknown as { sweep(): Promise<void> }).sweep();
  assert.notEqual((await box.get(boxId)).state, "archived", "held box survives the sweep");
  release();
  await new Promise((r) => setTimeout(r, 30));
  await (engine as unknown as { sweep(): Promise<void> }).sweep();
  assert.equal((await box.get(boxId)).state, "archived", "released box is swept");
  engine.dispose();
});

test("one user = one box: concurrent ensures from two conversations share one row", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  const [a, b] = await Promise.all([engine.ensureUserBox("uone", "conv-a"), engine.ensureUserBox("uone", "conv-b")]);
  assert.equal(a.id, b.id, "both conversations got the SAME box");
  const rows = await db.q(`select id from boxes where user_key like 'uone-%' and retired_at is null`);
  assert.equal(rows.length, 1, "exactly one active box row exists");
  engine.dispose();
});

test("identical concurrent message is suppressed; original still answers", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  const [first, second] = await Promise.all([
    collect(engine, "udup", "cdup", "same message"),
    (async () => { await new Promise((r) => setTimeout(r, 300)); return collect(engine, "udup", "cdup", "same message"); })(),
  ]);
  const answered = [first, second].filter((evs) => evs.some((e: any) => e.type === "user-box.delta"));
  assert.equal(answered.length, 1, "exactly one box round ran");
  assert.ok([first, second].some((evs) => evs.some((e: any) => e.stage === "private-round.suppressed")), "the duplicate was visibly suppressed");
  engine.dispose();
});

test("transcripts persist across engine instances (restart is not amnesia)", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await collect(engine, "ut", "ct", "remember this message");
  engine.dispose();
  const engine2 = makeEngine(box);
  const transcript = await engine2.getTranscript("ut", "ct");
  assert.ok(transcript.some((m) => m.role === "user" && m.content === "remember this message"));
  assert.ok(transcript.some((m) => m.role === "assistant"), "assistant reply persisted too");
  engine2.dispose();
});

test("render journal: events append in order, tail by cursor, reset clears them", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await engine.logEvent("uj", "cj", null, { type: "user.message", text: "hi" });
  await engine.logEvent("uj", "cj", "t1", { type: "user-box.delta", text: "answer" });
  await engine.logEvent("uj", "cj", "t1", { type: "turn.done" });
  const all = await engine.getEvents("uj", "cj");
  assert.deepEqual(all.map((e: any) => e.body.type), ["user.message", "user-box.delta", "turn.done"]);
  const tail = await engine.getEvents("uj", "cj", all[1]!.seq);
  assert.deepEqual(tail.map((e: any) => e.body.type), ["turn.done"]);
  await engine.resetUser("uj");
  assert.equal((await engine.getEvents("uj", "cj")).length, 0, "reset wipes the journal");
  engine.dispose();
});

test("parallel scenarios: the fork tag fans out into N parallel conversations on the SAME box", async () => {
  const box = new FakeBoxClient({ frames: [{ text: "scenario answer" }] });
  const engine = makeEngine(box, { sharedStream: sharedStream("Two solid directions here.\n<optibox-fork>Fast MVP | Robust build</optibox-fork>"), scenariosEnabled: true });
  const events = await collect(engine, "usc", "csc", "build me a thing");
  const fork = events.find((e: any) => e.type === "scenario.fork");
  assert.ok(fork, "scenario.fork emitted");
  assert.deepEqual(fork.labels, ["Fast MVP", "Robust build"]);
  const scenIds = new Set(events.filter((e: any) => e.type === "user-box.delta").map((e: any) => e.scenarioId));
  assert.equal(scenIds.size, 2, "two scenarios each produced tagged deltas");
  assert.equal(box.prompts.length, 2, "one prompt per scenario");
  assert.ok(box.prompts.every((p) => p.input.new === true), "each scenario is its own new conversation");
  assert.equal(new Set(box.prompts.map((p) => p.boxId)).size, 1, "all on the user's one box");
  assert.equal(box.boxes.size, 1, "no extra machines provisioned");
  engine.dispose();
});

test("scenarios OFF: the fork tag is ignored and the turn runs as a single box round", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, { sharedStream: sharedStream("one path.\n<optibox-fork>A | B</optibox-fork>") });
  const events = await collect(engine, "usoff", "csoff", "do it");
  assert.ok(!events.some((e: any) => e.type === "scenario.fork"), "no fan-out when flag off");
  assert.equal(box.prompts.length, 1);
  engine.dispose();
});

test("manual stopUserBox ends billing at stop request and archives", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  const events = await collect(engine, "us", "cs", "then stop me");
  const boxId = events.find((e) => e.type === "turn.done")?.boxId;
  const stops: any[] = [];
  for await (const e of engine.stopUserBox("us", "cs")) stops.push(e);
  assert.ok(stops.some((e) => e.type === "billing.stop"), "billing.stop streamed");
  assert.equal((await box.get(boxId)).state, "archived");
  assert.equal((await engine.userRuntimeStatus("us")).billingSinceEpochMs, null);
  engine.dispose();
});

test("resetUser deletes the box and every row about the user", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  const events = await collect(engine, "ureset", "creset", "make some state");
  const boxId = events.find((e) => e.type === "turn.done")?.boxId;
  const result = await engine.resetUser("ureset");
  assert.equal(result.ok, true);
  assert.equal(result.boxesDeleted, 1);
  assert.equal((await box.get(boxId)).state, "archived", "box stopped");
  for (const [table, col] of [["boxes", "user_key"], ["transcripts", "user_key"], ["turns", "user_key"], ["conversations", "user_key"], ["users", "key"]] as const) {
    assert.equal((await db.q(`select 1 from ${table} where ${col} like 'ureset-%'`)).length, 0, `${table} wiped`);
  }
  assert.equal((await engine.userRuntimeStatus("ureset")).billedSecondsTotal, 0, "billing ledger gone");
  engine.dispose();
});

test("billing total is a pure projection: no double count between stop paths", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await collect(engine, "ub", "cb", "bill me");
  const before = (await engine.userRuntimeStatus("ub")).billedSecondsTotal;
  for await (const _ of engine.stopUserBox("ub", "cb")) void _;
  const afterStop = (await engine.userRuntimeStatus("ub")).billedSecondsTotal;
  assert.ok(afterStop >= before, "total grew (or held) at stop");
  await (engine as unknown as { sweep(): Promise<void> }).sweep();
  assert.equal((await engine.userRuntimeStatus("ub")).billedSecondsTotal, afterStop, "sweep after stop adds nothing (single endBilling)");
  engine.dispose();
});

// ---------------------------------------------------------------- per-user Agents setup

const AUTH_JSON = '{"tokens":{"access_token":"chatgpt-secret-9999"}}';

test("a user's own keys become the box env at create, and their secret files are rewritten after create AND after resume", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  const saved = await engine.setUserAgents("uag", {
    providerEnv: { ANTHROPIC_API_KEY: "sk-user-1111", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-2222" },
    agentFiles: { ".codex/auth.json": AUTH_JSON },
  });
  assert.equal(saved.applied, "next-start", "no machine yet: the keys ride the create call");

  await collect(engine, "uag", "cag", "first message");
  const boxId = (await engine.activeUserBoxId("uag"))!;
  assert.deepEqual(JSON.parse(box.files.get(`${boxId}:create`)!), {
    noEnv: true,
    env: { ANTHROPIC_API_KEY: "sk-user-1111", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-2222" },
  }, "the box carries the USER's keys, not the server's");
  assert.equal(box.files.get(`${boxId}:.codex/auth.json`), AUTH_JSON, "secret file written after create");
  assert.ok(box.commands.some((c) => c.includes("mkdir -p '.codex'")), "parent dir created before the files PUT");

  // A no-env box's resume scrubs owner secrets off its disk — which unlinks
  // ~/.codex/auth.json — so the file must be written again after every wake.
  box.files.delete(`${boxId}:.codex/auth.json`);
  for await (const _ of engine.stopUserBox("uag", "cag")) void _;
  await collect(engine, "uag", "cag", "second message after the wake");
  assert.equal(box.files.get(`${boxId}:.codex/auth.json`), AUTH_JSON, "secret file rewritten after resume");
  engine.dispose();
});

test("changing keys on a LIVE box stops it, resumes with the new env, and rewrites the files", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await collect(engine, "ulive", "clive", "warm the machine");
  const boxId = (await engine.activeUserBoxId("ulive"))!;
  const billedBefore = (await engine.userRuntimeStatus("ulive")).billedSecondsTotal;

  const result = await engine.setUserAgents("ulive", {
    providerEnv: { OPENROUTER_API_KEY: "or-user-3333" },
    agentFiles: { ".codex/auth.json": AUTH_JSON },
  });
  assert.equal(result.applied, "now");
  assert.equal(result.boxId, boxId);
  assert.deepEqual(box.resumes.at(-1), { boxId, env: { OPENROUTER_API_KEY: "or-user-3333" } }, "resume REPLACES the box env");
  assert.equal(box.files.get(`${boxId}:.codex/auth.json`), AUTH_JSON, "files rewritten on the way back up");
  assert.ok((await engine.userRuntimeStatus("ulive")).billedSecondsTotal >= billedBefore, "the stop ended billing like a manual pause");
  assert.equal((await engine.getUserAgents("ulive")).envPending, false, "nothing left pending: the live box already has them");
  engine.dispose();
});

test("changing keys on a PARKED box is pending, and the next wake resumes with the new env", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await collect(engine, "upark", "cpark", "warm the machine");
  const boxId = (await engine.activeUserBoxId("upark"))!;
  for await (const _ of engine.stopUserBox("upark", "cpark")) void _;
  const resumesBefore = box.resumes.length;

  const result = await engine.setUserAgents("upark", { providerEnv: { ANTHROPIC_API_KEY: "sk-user-4444" } });
  assert.equal(result.applied, "next-start", "a parked box is not woken just to take keys");
  assert.equal(box.resumes.length, resumesBefore, "no resume happened at save time");
  assert.equal((await engine.getUserAgents("upark")).envPending, true);

  await collect(engine, "upark", "cpark", "next message wakes it");
  assert.deepEqual(box.resumes.at(-1), { boxId, env: { ANTHROPIC_API_KEY: "sk-user-4444" } }, "the wake carried the new env");
  assert.equal((await engine.getUserAgents("upark")).envPending, false, "pending flag cleared once applied");
  engine.dispose();
});

test("the user's stored harness/model/reasoning is the default; a message's own selection still wins", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await engine.setUserAgents("usel", { selection: { harness: "pi", provider: "openrouter", model: "glm-5.3", reasoningEffort: "high" } });
  const events: any[] = [];
  for await (const e of engine.runTurn({ userId: "usel", conversationId: "csel", message: "no selection in this send" })) events.push(e);
  assert.equal(box.prompts[0]!.input.provider, "pi", "the stored harness ran the turn");
  assert.equal(box.prompts[0]!.input.model, "glm-5.3");
  assert.equal(box.prompts[0]!.input.reasoningEffort, "high");
  await collect(engine, "usel", "csel", "this one overrides", { harness: "claude-code", provider: "anthropic", model: "claude-sonnet-5" });
  assert.equal(box.prompts[1]!.input.provider, "claude-code", "the per-message selection wins");
  assert.equal(box.prompts[1]!.input.model, "claude-sonnet-5");
  engine.dispose();
});

test("getUserAgents reports what is connected and NEVER the secret", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box);
  await engine.setUserAgents("usec", {
    providerEnv: { ANTHROPIC_API_KEY: "sk-user-super-secret-5555" },
    agentFiles: { ".codex/auth.json": AUTH_JSON },
  });
  const view = await engine.getUserAgents("usec");
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /sk-user-super-secret-5555/, "no API key leaves the server");
  assert.doesNotMatch(serialized, /chatgpt-secret-9999/, "no auth.json content leaves the server");
  const anthropic = view.credentials.find((c) => c.id === "anthropicApiKey")!;
  assert.equal(anthropic.connected, true);
  assert.equal(anthropic.last4, "5555", "only the last 4 characters are shown");
  assert.equal(view.credentials.find((c) => c.id === "codexSubscription")!.connected, true);
  assert.equal(view.credentials.find((c) => c.id === "openaiApiKey")!.connected, false);
  assert.equal(view.usingOwnKeys, true);
  // Clearing a field with "" disconnects it.
  await engine.setUserAgents("usec", { providerEnv: { ANTHROPIC_API_KEY: "" } });
  assert.equal((await engine.getUserAgents("usec")).credentials.find((c) => c.id === "anthropicApiKey")!.connected, false);
  engine.dispose();
});

// ---------------------------------------------------------------------------
// Subscription sign-ins. A fake Anthropic/OpenAI answers the token endpoints,
// so both flows run end to end without touching the real providers.
// ---------------------------------------------------------------------------

const FAKE_OAUTH: OAuthEndpoints = {
  claudeAuthorize: "https://fake-anthropic.test/oauth/authorize",
  claudeToken: "https://fake-anthropic.test/v1/oauth/token",
  claudeRedirect: "https://fake-anthropic.test/oauth/code/callback",
  codexDeviceCode: "https://fake-openai.test/deviceauth/usercode",
  codexDeviceToken: "https://fake-openai.test/deviceauth/token",
  codexVerify: "https://fake-openai.test/codex/device",
  codexToken: "https://fake-openai.test/oauth/token",
  codexRedirect: "https://fake-openai.test/deviceauth/callback",
  kimiDeviceCode: "https://fake-kimi.test/api/oauth/device_authorization",
  kimiToken: "https://fake-kimi.test/api/oauth/token",
};

/** An OpenAI access token is a JWT whose payload names the ChatGPT account. */
const chatGptJwt = (account: string): string =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.sig`;

class FakeOAuthProvider {
  calls: Array<{ url: string; body: Record<string, string>; headers: Record<string, string> }> = [];
  /** How many polls the user takes before approving the device code. */
  pollsBeforeApproval = 1;
  claudeExpiresIn = 3600;
  kimiExpiresIn = 3600;
  private polls = 0;
  readonly client = new OAuthClient({
    endpoints: FAKE_OAUTH,
    kimiDeviceId: "device-fixed-id",
    fetch: ((input: unknown, init: { body?: string; headers?: Record<string, string> }) => this.handle(String(input), init)) as unknown as typeof fetch,
  });

  private reply(body: unknown, status = 200) {
    return { ok: status < 300, status, statusText: "OK", text: async () => JSON.stringify(body) };
  }

  private async handle(url: string, init: { body?: string; headers?: Record<string, string> }) {
    const raw = String(init?.body ?? "");
    const body: Record<string, string> = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    this.calls.push({ url, body, headers: { ...(init?.headers ?? {}) } });
    if (url === FAKE_OAUTH.kimiDeviceCode) {
      return this.reply({ user_code: "KIMI-4321", device_code: "kimi-dev-1", verification_uri: "https://fake-kimi.test/device", verification_uri_complete: "https://fake-kimi.test/device?user_code=KIMI-4321", expires_in: 300, interval: 5 });
    }
    if (url === FAKE_OAUTH.kimiToken && body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      return ++this.polls > this.pollsBeforeApproval
        ? this.reply({ access_token: "kimi-access-1", refresh_token: "rt-kimi-1", expires_in: this.kimiExpiresIn, scope: "kimi", token_type: "Bearer" })
        : this.reply({ error: "authorization_pending", error_description: "waiting" }, 400);
    }
    if (url === FAKE_OAUTH.kimiToken && body.grant_type === "refresh_token") {
      return this.reply({ access_token: "kimi-access-renewed", refresh_token: "rt-kimi-2", expires_in: 7200, scope: "kimi", token_type: "Bearer" });
    }
    if (url === FAKE_OAUTH.claudeToken) {
      const renewing = body.grant_type === "refresh_token";
      return this.reply({
        access_token: renewing ? "sk-ant-oat01-renewed" : "sk-ant-oat01-first",
        refresh_token: renewing ? "rt-claude-2" : "rt-claude-1",
        expires_in: this.claudeExpiresIn,
        token_type: "Bearer",
      });
    }
    if (url === FAKE_OAUTH.codexDeviceCode) return this.reply({ device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: "5" });
    if (url === FAKE_OAUTH.codexDeviceToken) {
      return ++this.polls > this.pollsBeforeApproval
        ? this.reply({ authorization_code: "auth-code-1", code_verifier: "verifier-1" })
        : this.reply({ status: "pending" });
    }
    if (url === FAKE_OAUTH.codexToken) return this.reply({ access_token: chatGptJwt("acct-90210"), refresh_token: "rt-codex-1", expires_in: 3600, token_type: "Bearer" });
    throw new Error(`unexpected oauth call ${url}`);
  }
}

test("Claude sign-in: the user approves a PKCE URL, pastes the code, and their box runs on the token", async () => {
  const box = new FakeBoxClient();
  const provider = new FakeOAuthProvider();
  const engine = makeEngine(box, { oauth: provider.client });

  const start = await engine.startAgentOAuth("uclaude", "claude");
  const url = new URL(start.url);
  assert.equal(`${url.origin}${url.pathname}`, FAKE_OAUTH.claudeAuthorize);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"), "PKCE challenge is in the URL");
  assert.equal(url.searchParams.get("redirect_uri"), FAKE_OAUTH.claudeRedirect);

  const done = await engine.completeAgentOAuth("uclaude", start.sessionId, "pasted-code#state-x");
  assert.equal(done.status, "connected");
  assert.equal(done.status === "connected" && done.applied, "next-start", "no machine yet: the token rides the create call");
  const exchange = provider.calls.find((c) => c.body.grant_type === "authorization_code")!;
  assert.equal(exchange.body.code, "pasted-code", "a pasted 'code#state' is split the way Anthropic prints it");
  assert.ok(exchange.body.code_verifier, "the PKCE verifier goes back with the code");

  const view = await engine.getUserAgents("uclaude");
  assert.equal(view.credentials.find((c) => c.id === "claudeSubscription")!.connected, true);
  assert.equal(view.credentials.find((c) => c.id === "claudeSubscription")!.last4, "irst");
  assert.doesNotMatch(JSON.stringify(view), /rt-claude-1/, "the refresh token never leaves the server");

  await collect(engine, "uclaude", "cclaude", "hello");
  const boxId = (await engine.activeUserBoxId("uclaude"))!;
  assert.deepEqual(JSON.parse(box.files.get(`${boxId}:create`)!).env, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-first" });
  engine.dispose();
});

test("ChatGPT sign-in: a device code, polling until the user finishes, then ~/.codex/auth.json on the box", async () => {
  const box = new FakeBoxClient();
  const provider = new FakeOAuthProvider();
  const engine = makeEngine(box, { oauth: provider.client });

  const start = await engine.startAgentOAuth("ucodex", "codex");
  assert.equal(start.userCode, "ABCD-EFGH");
  assert.equal(start.url, FAKE_OAUTH.codexVerify, "the page the user types the code into");
  assert.equal(start.interval, 5, "the provider's own polling cadence");

  assert.deepEqual(await engine.completeAgentOAuth("ucodex", start.sessionId), { status: "pending" });
  const done = await engine.completeAgentOAuth("ucodex", start.sessionId);
  assert.equal(done.status, "connected");

  const view = await engine.getUserAgents("ucodex");
  const cred = view.credentials.find((c) => c.id === "codexSubscription")!;
  assert.equal(cred.connected, true);
  assert.equal(cred.detail, "account ····0210", "the panel can name the connected account");

  await collect(engine, "ucodex", "ccodex", "hello");
  const boxId = (await engine.activeUserBoxId("ucodex"))!;
  const auth = JSON.parse(box.files.get(`${boxId}:.codex/auth.json`)!);
  assert.equal(auth.auth_mode, "chatgpt", "codex authenticates from this file and nothing else");
  assert.equal(auth.tokens.account_id, "acct-90210");
  assert.equal(JSON.parse(box.files.get(`${boxId}:create`)!).env.CHATGPT_ACCOUNT_ID, "acct-90210");
  engine.dispose();
});

test("Kimi sign-in: a device code on auth.kimi.com with kimi-cli's headers, polled until approved, then the token pair as box env, renewed before a bring-up", async () => {
  const box = new FakeBoxClient();
  const provider = new FakeOAuthProvider();
  provider.kimiExpiresIn = 30; // inside the refresh buffer: the first bring-up renews it
  const engine = makeEngine(box, { oauth: provider.client });

  const start = await engine.startAgentOAuth("ukimi", "kimi");
  assert.equal(start.userCode, "KIMI-4321");
  assert.equal(start.url, "https://fake-kimi.test/device?user_code=KIMI-4321", "the link already carries the code");
  assert.equal(start.interval, 5);
  const deviceCall = provider.calls[0]!;
  assert.deepEqual(deviceCall.body, { client_id: "17e5f671-d194-4dfb-9706-5516cb48c098" }, "form body, public client, no scope");
  assert.equal(deviceCall.headers["X-Msh-Platform"], "kimi_cli");
  assert.equal(deviceCall.headers["X-Msh-Version"], "1.50.0");
  assert.equal(deviceCall.headers["X-Msh-Device-Id"], "device-fixed-id");
  assert.equal(deviceCall.headers["content-type"], "application/x-www-form-urlencoded");

  assert.deepEqual(await engine.completeAgentOAuth("ukimi", start.sessionId), { status: "pending" });
  const done = await engine.completeAgentOAuth("ukimi", start.sessionId);
  assert.equal(done.status, "connected");
  const poll = provider.calls.find((c) => c.body.grant_type === "urn:ietf:params:oauth:grant-type:device_code")!;
  assert.equal(poll.body.device_code, "kimi-dev-1");

  const view = await engine.getUserAgents("ukimi");
  const cred = view.credentials.find((c) => c.id === "kimiSubscription")!;
  assert.equal(cred.connected, true);
  assert.equal(cred.target, "KIMI_CODE_ACCESS_TOKEN");
  assert.doesNotMatch(JSON.stringify(view), /rt-kimi-1/, "the refresh token never leaves the server");

  await collect(engine, "ukimi", "ckimi", "hello");
  const boxId = (await engine.activeUserBoxId("ukimi"))!;
  const env = JSON.parse(box.files.get(`${boxId}:create`)!).env;
  assert.equal(env.KIMI_CODE_ACCESS_TOKEN, "kimi-access-renewed", "the box got the renewed token, not the 30s one");
  assert.equal(env.KIMI_CODE_REFRESH_TOKEN, "rt-kimi-2");
  assert.ok(Number(env.KIMI_CODE_TOKEN_EXPIRY) > Date.now() / 1000 + 7000, "expiry is unix seconds");
  assert.equal(box.files.get(`${boxId}:.kimi/credentials/kimi-code.json`), undefined, "no file: the box writes ~/.kimi-code itself from the env");
  assert.ok(provider.calls.some((c) => c.body.grant_type === "refresh_token" && c.body.refresh_token === "rt-kimi-1"), "the stored refresh token was spent");

  await engine.disconnectSubscription("ukimi", "kimi");
  assert.equal((await engine.getUserAgents("ukimi")).credentials.find((c) => c.id === "kimiSubscription")!.connected, false);
  engine.dispose();
});

test("a subscription token close to expiry is renewed before the box comes up", async () => {
  const box = new FakeBoxClient();
  const provider = new FakeOAuthProvider();
  provider.claudeExpiresIn = 30; // inside the 2-minute refresh buffer
  const engine = makeEngine(box, { oauth: provider.client });

  const start = await engine.startAgentOAuth("uref", "claude");
  await engine.completeAgentOAuth("uref", start.sessionId, "code-1");
  await collect(engine, "uref", "cref", "hello");

  const boxId = (await engine.activeUserBoxId("uref"))!;
  assert.equal(JSON.parse(box.files.get(`${boxId}:create`)!).env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-renewed", "the box started on the renewed token");
  assert.ok(provider.calls.some((c) => c.body.grant_type === "refresh_token" && c.body.refresh_token === "rt-claude-1"), "the stored refresh token was spent");
  engine.dispose();
});

test("the INSTANT answer also renews an expiring subscription, not just the box", async () => {
  // A Kimi access token lives 15 minutes. The bridge used the stored one as-is, so once it went
  // stale the fast answer failed and the user watched nothing until the box turn finished.
  const box = new FakeBoxClient();
  const provider = new FakeOAuthProvider();
  provider.pollsBeforeApproval = 0;
  provider.kimiExpiresIn = 30; // inside the refresh buffer
  const seen: string[] = [];
  const engine = makeEngine(box, {
    oauth: provider.client,
    sharedStream: undefined,
    sharedModelForEnv: (env: Record<string, string>) => { seen.push(env.KIMI_CODE_ACCESS_TOKEN ?? ""); return "kimi/k3"; },
    directStreamFactory: undefined,
  } as never);
  const start = await engine.startAgentOAuth("ubridge", "kimi");
  assert.equal((await engine.completeAgentOAuth("ubridge", start.sessionId)).status, "connected");
  await collect(engine, "ubridge", "cbridge", "hello").catch(() => undefined);
  assert.ok(seen.length > 0, "the bridge picked a model from the env");
  assert.equal(seen[0], "kimi-access-renewed", "the bridge ran on the renewed token, not the 30s one");
  engine.dispose();
});

test("disconnecting a subscription clears what it put on the box and its refresh token", async () => {
  const box = new FakeBoxClient();
  const provider = new FakeOAuthProvider();
  provider.pollsBeforeApproval = 0;
  const engine = makeEngine(box, { oauth: provider.client });

  await assert.rejects(engine.completeAgentOAuth("udis", "no-such-session"), /expired/, "a stale session id is refused");

  const start = await engine.startAgentOAuth("udis", "codex");
  assert.equal((await engine.completeAgentOAuth("udis", start.sessionId)).status, "connected");
  await engine.disconnectSubscription("udis", "codex");

  const view = await engine.getUserAgents("udis");
  assert.equal(view.credentials.find((c) => c.id === "codexSubscription")!.connected, false);
  assert.equal(view.usingOwnKeys, false, "nothing of the user's is left on the box");

  await collect(engine, "udis", "cdis", "hello");
  assert.equal(provider.calls.filter((c) => c.body.grant_type === "refresh_token").length, 0, "nothing left to refresh");
  engine.dispose();
});

test("Box API traffic of one private turn: 1 prompt, a handful of event polls, no shell round trips for the agent", async () => {
  const box = new FakeBoxClient({ frames: [{ text: "one" }, { text: "one two" }, { text: "one two three" }] });
  const engine = makeEngine(box);
  await collect(engine, "uc", "cc", "count");
  assert.equal(box.prompts.length, 1);
  assert.ok(box.eventsCalls <= 8, `event polls: ${box.eventsCalls}`);
  // The only commands: readiness probes (`echo __UP__`); nothing launches, polls or kills a harness process.
  assert.ok(box.commands.every((c) => c === "echo __UP__"), `commands: ${box.commands.join(" | ")}`);
  engine.dispose();
});
