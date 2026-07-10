import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "pg";
import { openDb, type Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import type { BoxClient, BoxInfo, CommandResult, HarnessAdapter } from "../src/types.js";

/**
 * Behavioral suite for the 6-rule engine against a REAL ephemeral Postgres
 * database (created on the shared server, dropped after). No mocks of the
 * state layer — the schema IS the invariant surface under test.
 */

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL required for the engine suite");
const TEST_DB = `optibox_test_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// Admin work (create/drop the ephemeral db) runs over the configured database
// itself — CREATE DATABASE works from any connection.
const adminUrl = baseUrl;
const testUrl = baseUrl.replace(/\/[^/]*$/, `/${TEST_DB}`);

let db: Db;

before(async () => {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();
  db = await openDb(testUrl);
});

after(async () => {
  await db.close();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.end();
});

// Module-level counter: box ids are PRIMARY KEYs in the shared test database,
// so per-instance counters would collide across tests.
let nextBoxId = 1;
class FakeBoxClient implements BoxClient {
  boxes = new Map<string, BoxInfo>();
  commands: string[] = [];
  async create(input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo> {
    const id = `box-${nextBoxId++}`;
    const box: BoxInfo = { id, state: "idle", ...(input.name ? { name: input.name } : {}) };
    this.boxes.set(id, box);
    return box;
  }
  async list(): Promise<BoxInfo[]> { return [...this.boxes.values()]; }
  async get(boxId: string): Promise<BoxInfo> { return this.boxes.get(boxId) ?? { id: boxId, state: "error" }; }
  async update(boxId: string, input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo> {
    const updated = { ...(await this.get(boxId)), ...(input.name !== undefined ? { name: input.name } : {}) };
    this.boxes.set(boxId, updated);
    return updated;
  }
  async stop(boxId: string): Promise<BoxInfo> { const b = { ...(await this.get(boxId)), state: "archived" }; this.boxes.set(boxId, b); return b; }
  async resume(boxId: string): Promise<BoxInfo> { const b = { ...(await this.get(boxId)), state: "idle" }; this.boxes.set(boxId, b); return b; }
  async command(boxId: string, input: { command: string }): Promise<CommandResult> {
    const state = (await this.get(boxId)).state;
    if (!["ready", "idle", "running", "provisioned"].includes(state)) {
      throw new Error(`fake box ${boxId} cannot run commands in state ${state}`);
    }
    this.commands.push(input.command);
    return { exitCode: 0, stdout: `ran:${input.command}`, stderr: "" };
  }
  async readFile(_boxId: string, path: string): Promise<string> { return `file:${path}`; }
  async writeFile(): Promise<void> { /* noop */ }
}

type HarnessBehavior = { shared?: string; box?: string | (() => AsyncIterable<string>) };
function harnessOf(name: string, behavior: HarnessBehavior = {}): HarnessAdapter {
  return {
    name,
    description: name,
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared({ capabilities }) {
      await assert.rejects(capabilities.bash("whoami")); // rule: shared surface is structurally tool-less
      yield behavior.shared ?? "I’m checking that now.";
    },
    async *userBox(ctx) {
      if (typeof behavior.box === "function") { yield* behavior.box(); return; }
      const r = await ctx.capabilities.command("echo hi");
      yield behavior.box ?? `BOX:${r.stdout}`;
    },
  };
}

function makeEngine(box: FakeBoxClient, harness: HarnessAdapter, extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}): Engine {
  return new Engine({
    db, box, harnesses: [harness],
    instanceId: "testinst", credHash: "cred0001",
    readinessPollMs: 1, autoStopIdleMs: 30, sweepIntervalMs: 0, handoffTimeoutMs: 5_000,
    ...extra,
  });
}

const sel = { harness: "h", provider: "anthropic", model: "m-1" };
async function collect(engine: Engine, userId: string, conversationId: string, message: string): Promise<any[]> {
  const events: any[] = [];
  for await (const e of engine.runTurn({ userId, conversationId, message, selection: sel })) events.push(e);
  return events;
}

test("rules 1+3: cold turn bridges (shared answers first), box answers on top, turn settles", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h"));
  const events = await collect(engine, "u1", "c1", "run something");
  const sharedIdx = events.findIndex((e) => e.type === "shared.delta");
  const boxIdx = events.findIndex((e) => e.type === "user-box.delta");
  assert.ok(sharedIdx >= 0, "shared bridge answered");
  assert.ok(boxIdx > sharedIdx, "box answered after the bridge");
  assert.ok(events.some((e) => e.type === "turn.done" && e.settled === true), "turn settled");
  assert.ok(events.some((e) => e.type === "handoff.started"), "handoff event stream intact");
  engine.dispose();
});

test("rule 5: direct route requires BOTH responsiveness and >=15s machine age", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h"));
  await collect(engine, "u5", "c5", "first");
  // Box billing but YOUNG (<15s of machine time): must bridge as if off.
  const young = await collect(engine, "u5", "c5", "second while young");
  assert.ok(young.some((e) => e.type === "shared.delta"), "young box still gets the shared answer");
  assert.ok(!young.some((e) => e.stage === "route.direct"), "no direct route inside the warmup window");
  // Age the machine past the window: now direct, no bridge.
  await db.q(`update boxes set billing_since = now() - interval '20 seconds' where user_key like 'u5-%'`);
  const events = await collect(engine, "u5", "c5", "third when warm");
  assert.ok(events.some((e) => e.type === "trace" && e.stage === "route.direct"), "direct route chosen when warm");
  assert.ok(!events.some((e) => e.type === "shared.delta"), "no bridge text on a warm box");
  assert.ok(events.some((e) => e.type === "user-box.delta"), "box answered");
  engine.dispose();
});

test("a box missing its harness is retired loudly ONCE; next message gets a fresh machine", async () => {
  const { HarnessMissingError } = await import("../src/types.js");
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h", {
    box: () => (async function* (): AsyncIterable<string> { throw new HarnessMissingError("harness 'pi' is not installed on this user box"); })(),
  }));
  const events = await collect(engine, "umiss", "cmiss", "do something");
  assert.equal(events.filter((e) => e.type === "turn.blocked").length, 1, "exactly ONE blocked event (no doubled error bubble)");
  assert.ok(events.some((e) => e.type === "lifecycle" && e.state === "retired"), "retirement is visible");
  const firstBox = events.find((e) => e.type === "lifecycle" && e.state === "retired")?.boxId;
  const rows = await db.q<{ retired_at: string | null }>(`select retired_at from boxes where id=$1`, [firstBox]);
  assert.ok(rows[0]?.retired_at, "broken box row retired");
  const fresh = await engine.ensureUserBox("umiss", "cmiss");
  assert.notEqual(fresh.id, firstBox, "next message provisions a fresh machine");
  engine.dispose();
});

test("template-configured engines NEVER plain-create: not-ready template fails loudly", async () => {
  const box = new FakeBoxClient();
  // Template configured but its build can't complete in the fake (install
  // marker handled; the point is the not-ready window): mark row 'building'.
  const engine = makeEngine(box, harnessOf("h"), { template: { installCmd: "echo install" } });
  await db.q(`insert into templates(instance_id, box_id, status) values('testinst','tpl-x','building')
              on conflict(instance_id) do update set status='building'`);
  const events = await collect(engine, "utpl", "ctpl", "need a machine");
  assert.ok(events.some((e) => e.type === "shared.delta"), "rule 1: shared still answered");
  assert.ok(events.some((e) => e.type === "turn.blocked" && /template is still being prepared/.test(e.message)), "loud not-ready failure, no pi-less box");
  const rows = await db.q(`select id from boxes where user_key like 'utpl-%' and retired_at is null`);
  assert.equal(rows.length, 0, "no plain-created user box exists");
  await db.q(`delete from templates where instance_id='testinst'`);
  engine.dispose();
});

test("rule 6: <end> renders nothing but settles the turn", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h", { box: "<end>" }));
  const events = await collect(engine, "u6", "c6", "hey there");
  assert.ok(!events.some((e) => e.type === "user-box.delta"), "sentinel is never shown");
  assert.ok(events.some((e) => e.type === "turn.done" && e.settled === true), "silent decline still settles");
  engine.dispose();
});

test("rule 6 binding: no text and no <end> is a LOUD turn.blocked, never silence", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h", { box: () => (async function* () { /* nothing */ })() }));
  const events = await collect(engine, "u6b", "c6b", "do a thing");
  assert.ok(events.some((e) => e.type === "turn.blocked"), "no-answer surfaces loudly");
  engine.dispose();
});

test("rule 4: sweeper stops the idle box, folds billing into the durable total", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h"));
  const events = await collect(engine, "u4", "c4", "warm me up");
  const boxId = events.find((e) => e.type === "turn.done")?.boxId;
  await new Promise((r) => setTimeout(r, 60)); // idle window (30ms) passes
  await (engine as unknown as { sweep(): Promise<void> }).sweep();
  assert.equal((await box.get(boxId)).state, "archived", "idle box stopped");
  const rt = await engine.userRuntimeStatus("u4");
  assert.equal(rt.billingSinceEpochMs, null, "billing ended");
  assert.ok(rt.billedSecondsTotal > 0, "elapsed seconds folded into the durable ledger");
  engine.dispose();
});

test("rule 4: holds and active turns block the sweeper; release unblocks", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h"));
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
  const engine = makeEngine(box, harnessOf("h"));
  const [a, b] = await Promise.all([
    engine.ensureUserBox("uone", "conv-a"),
    engine.ensureUserBox("uone", "conv-b"),
  ]);
  assert.equal(a.id, b.id, "both conversations got the SAME box");
  const rows = await db.q(`select id from boxes where user_key like 'uone-%' and retired_at is null`);
  assert.equal(rows.length, 1, "exactly one active box row exists");
  engine.dispose();
});

test("identical concurrent message is suppressed; original still answers", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h"));
  const [first, second] = await Promise.all([
    collect(engine, "udup", "cdup", "same message"),
    // 300ms stagger: a human double-send, comfortably past one PG round trip
    // (the dedup window opens once the first turn's row is inserted).
    (async () => { await new Promise((r) => setTimeout(r, 300)); return collect(engine, "udup", "cdup", "same message"); })(),
  ]);
  const answered = [first, second].filter((evs) => evs.some((e: any) => e.type === "user-box.delta"));
  assert.equal(answered.length, 1, "exactly one box round ran");
  const suppressed = [first, second].find((evs) => evs.some((e: any) => e.stage === "private-round.suppressed"));
  assert.ok(suppressed, "the duplicate was visibly suppressed");
  engine.dispose();
});

test("hosting: tool command detection writes a row with provenance; stop intent is durable", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h", {
    box: () => (async function* () { yield "hosted!"; })(),
  }));
  // Simulate what the turn tap does on a host tool command
  await engine.ensureUserBox("uh", "ch");
  const boxId = (await engine.activeUserBoxId("uh"))!;
  await (engine as unknown as { markHosting(u: string, c: string, b: string, p: number, m: string): Promise<void> })
    .markHosting("uh", "ch", boxId, 8080, "public");
  let rt = await engine.userRuntimeStatus("uh");
  assert.equal(rt.hosting.length, 1);
  assert.equal(rt.hosting[0]?.conversationId, "ch", "provenance recorded");
  // sweep must NOT stop a hosting box even when idle
  await new Promise((r) => setTimeout(r, 60));
  await (engine as unknown as { sweep(): Promise<void> }).sweep();
  assert.notEqual((await box.get(boxId)).state, "archived", "hosting pins the box");
  // durable stop: even if the process is observed again, it gets killed, not resurrected
  const res = await engine.stopHosting("uh");
  assert.deepEqual(res.ports, [8080]);
  await engine.reconcileObservedHosting("uh", boxId, [{ port: 8080, mode: "public" }]);
  rt = await engine.userRuntimeStatus("uh");
  assert.equal(rt.hosting.length, 0, "stopped hosting never resurrects from observation");
  assert.ok(box.commands.some((c) => c.includes("host hide 8080")), "authoritative takedown enforced on the observed box");
  engine.dispose();
});

test("hosting ground truth: 2 consecutive misses clear the row", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h"));
  await engine.ensureUserBox("um", "cm");
  const boxId = (await engine.activeUserBoxId("um"))!;
  await (engine as unknown as { markHosting(u: string, c: string, b: string, p: number, m: string): Promise<void> })
    .markHosting("um", "cm", boxId, 9000, "private");
  await engine.reconcileObservedHosting("um", boxId, []);
  assert.equal((await engine.userRuntimeStatus("um")).hosting.length, 1, "one miss is grace");
  await engine.reconcileObservedHosting("um", boxId, []);
  assert.equal((await engine.userRuntimeStatus("um")).hosting.length, 0, "second miss clears");
  engine.dispose();
});

test("transcripts persist across engine instances (restart is not amnesia)", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h"));
  await collect(engine, "ut", "ct", "remember this message");
  engine.dispose();
  const engine2 = makeEngine(box, harnessOf("h"));
  const transcript = await engine2.getTranscript("ut", "ct");
  assert.ok(transcript.some((m) => m.role === "user" && m.content === "remember this message"));
  assert.ok(transcript.some((m) => m.role === "assistant"), "assistant reply persisted too");
  engine2.dispose();
});

test("manual stopUserBox ends billing at stop request and archives", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h"));
  const events = await collect(engine, "us", "cs", "then stop me");
  const boxId = events.find((e) => e.type === "turn.done")?.boxId;
  const stops: any[] = [];
  for await (const e of engine.stopUserBox("us", "cs")) stops.push(e);
  assert.ok(stops.some((e) => e.type === "billing.stop"), "billing.stop streamed");
  assert.equal((await box.get(boxId)).state, "archived");
  const rt = await engine.userRuntimeStatus("us");
  assert.equal(rt.billingSinceEpochMs, null);
  engine.dispose();
});

test("resetUser deletes the box and every row about the user", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h"));
  const events = await collect(engine, "ureset", "creset", "make some state");
  const boxId = events.find((e) => e.type === "turn.done")?.boxId;
  const result = await engine.resetUser("ureset");
  assert.equal(result.ok, true);
  assert.equal(result.boxesDeleted, 1);
  assert.equal((await box.get(boxId)).state, "archived", "box stopped");
  for (const [table, col] of [["boxes", "user_key"], ["transcripts", "user_key"], ["turns", "user_key"], ["conversations", "user_key"], ["users", "key"]] as const) {
    const rows = await db.q(`select 1 from ${table} where ${col} like 'ureset-%'`);
    assert.equal(rows.length, 0, `${table} wiped`);
  }
  const rt = await engine.userRuntimeStatus("ureset");
  assert.equal(rt.billedSecondsTotal, 0, "billing ledger gone");
  engine.dispose();
});

test("billing total is a pure projection: no double count between stop paths", async () => {
  const box = new FakeBoxClient();
  const engine = makeEngine(box, harnessOf("h"));
  await collect(engine, "ub", "cb", "bill me");
  const before = (await engine.userRuntimeStatus("ub")).billedSecondsTotal;
  for await (const _ of engine.stopUserBox("ub", "cb")) void _;
  const afterStop = (await engine.userRuntimeStatus("ub")).billedSecondsTotal;
  assert.ok(afterStop >= before, "total grew (or held) at stop");
  await (engine as unknown as { sweep(): Promise<void> }).sweep(); // second path must be a no-op
  const afterSweep = (await engine.userRuntimeStatus("ub")).billedSecondsTotal;
  assert.equal(afterSweep, afterStop, "sweep after stop adds nothing (single endBilling)");
  engine.dispose();
});
