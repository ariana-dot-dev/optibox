import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConsumerBoxAgentOrchestrator,
  createRestrictedSharedCapabilities,
  assertNoBoxAgent,
  buildHiddenContext,
  detectToolIntent,
  stripHiddenContext,
  type BoxClient,
  type BoxInfo,
  type CommandResult,
  type HarnessAdapter,
} from "../src/index.js";

class FakeBoxClient implements BoxClient {
  boxes = new Map<string, BoxInfo>();
  commands: string[] = [];
  writes: string[] = [];
  next = 1;
  async create(input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo> {
    const id = `box-${this.next++}`;
    const box: BoxInfo = { id, state: "idle", archiveAfter: input.ttlSeconds === null ? null : new Date(Date.now() + (input.ttlSeconds ?? 3600) * 1000).toISOString() };
    if (input.name) box.name = input.name;
    this.boxes.set(id, box);
    return box;
  }
  async get(boxId: string): Promise<BoxInfo> { return this.boxes.get(boxId) ?? { id: boxId, state: "error" }; }
  async update(boxId: string, input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo> {
    const updated: BoxInfo = { ...(await this.get(boxId)) };
    if (input.name !== undefined) updated.name = input.name;
    if (input.ttlSeconds === null) updated.archiveAfter = null;
    this.boxes.set(boxId, updated);
    return updated;
  }
  async stop(boxId: string): Promise<BoxInfo> { const box = { ...(await this.get(boxId)), state: "archived" }; this.boxes.set(boxId, box); return box; }
  async resume(boxId: string): Promise<BoxInfo> { const box = { ...(await this.get(boxId)), state: "idle" }; this.boxes.set(boxId, box); return box; }
  async command(_boxId: string, input: { command: string }): Promise<CommandResult> { this.commands.push(input.command); return { exitCode: 0, stdout: `ran:${input.command}`, stderr: "" }; }
  async readFile(_boxId: string, path: string): Promise<string> { return `file:${path}`; }
  async writeFile(_boxId: string, path: string, content: string): Promise<void> { this.writes.push(`${path}:${content}`); }
}


async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 300): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("timed out waiting for condition");
}

function probeHarness(name: string): HarnessAdapter {
  return {
    name,
    description: name,
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }, { provider: "openai", model: "m-2" }],
    async *shared({ capabilities, message }) {
      await assert.rejects(capabilities.bash("whoami"));
      yield `shared:${name}:${message}`;
    },
    async *userBox({ capabilities, recap, hiddenContext, machine, partialShared }) {
      const r = await capabilities.command(`echo ${name}`);
      await capabilities.writeFile("notes.txt", "ok");
      yield `box:${name}:${r.stdout}:recapHas(${/one/.test(recap)}):hiddenHas(${/one/.test(hiddenContext)}):tools(${machine.tools}):partial(${partialShared.length > 0})`;
    },
  };
}

test("shared restricted mode cannot read files/run bash/edit/control computer", async () => {
  const caps = createRestrictedSharedCapabilities();
  await assert.rejects(caps.readFile("/etc/passwd"), /denies file reads/);
  await assert.rejects(caps.bash("id"), /denies bash commands/);
  await assert.rejects(caps.writeFile("x", "y"), /denies file writes\/edits/);
  await assert.rejects(caps.controlComputer("click"), /denies computer control/);
  assert.equal(await caps.webSearch("box docs"), "Search is delegated by the host application for: box docs");
});

test("assertNoBoxAgent forbids Box built-in agent", async () => {
  const guarded = assertNoBoxAgent(new FakeBoxClient());
  assert.throws(() => (guarded as any).prompt, /built-in agent is disabled/);
  assert.throws(() => (guarded as any).events, /built-in agent is disabled/);
  // substrate primitives still work
  assert.equal((await guarded.get("box-x")).id, "box-x");
});

test("live harness switching keeps same Box + preserves context", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha"), probeHarness("beta")], readinessPollMs: 1, autoStopIdleMs: 1 });

  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  const boxId = first.find((e) => e.type === "handoff.started")?.boxId;
  assert.ok(boxId);
  assert.ok(first.some((e) => e.type === "user-box.delta" && e.harness === "alpha"));

  // switch harness AND model mid-conversation. The box is now warm, so this
  // turn routes DIRECTLY to the user box (no shared agent, no bridge).
  const second: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run two", selection: { harness: "beta", provider: "openai", model: "m-2" } })) second.push(e);
  const secondBoxId = second.find((e) => e.type === "turn.done")?.boxId;
  assert.equal(secondBoxId, boxId, "same Box reused across harness switch");
  // context is still preserved across the switch (hidden envelope carries "one")
  assert.ok(second.some((e) => e.type === "user-box.delta" && e.harness === "beta" && /hiddenHas\(true\)/.test(e.text)));
});

test("tool turns resume the Box and auto-stop after answering", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });

  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  const boxId = first.find((e) => e.type === "turn.done")?.boxId;
  assert.ok(boxId);
  assert.ok(first.some((e) => e.type === "handoff.started"), "first tool turn bridges into the Box");
  assert.ok(first.some((e) => e.type === "user-box.delta"), "first tool turn is answered by the Box");
  assert.ok(first.some((e) => e.type === "billing.stop"), "first turn auto-stops billing");
  assert.equal((await box.get(boxId)).state, "archived", "Box is archived after the turn finishes");

  const second: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run two", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) second.push(e);
  assert.equal(second.find((e) => e.type === "turn.done")?.boxId, boxId, "same Box is resumed for tool follow-up");
  assert.ok(second.some((e) => e.type === "shared.larp" && /resuming/.test(e.note)), "tool follow-up bridges during resume");
  assert.ok(second.some((e) => e.type === "user-box.delta"), "tool follow-up is answered by the Box");
  assert.ok(second.some((e) => e.type === "billing.stop"), "follow-up auto-stops billing");
  assert.equal((await box.get(boxId)).state, "archived", "Box is archived again after follow-up");
});

test("new turn inside idle window cancels pending auto-stop and reuses warm Box", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 30 });

  const first: any[] = [];
  const g1 = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const d1 = (async () => { for await (const e of g1) first.push(e); })();
  await waitFor(() => first.some((e) => e.type === "turn.done"));
  const boxId = first.find((e) => e.type === "turn.done")?.boxId;
  assert.equal((await box.get(boxId)).state, "idle", "Box remains warm during idle window");

  const second: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run follow up", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) second.push(e);
  await d1;

  assert.ok(!first.some((e) => e.type === "billing.stop"), "first pending stop was cancelled by the newer turn");
  assert.equal(second.find((e) => e.type === "turn.done")?.boxId, boxId, "new turn reused the still-warm Box");
  assert.ok(second.some((e) => e.type === "lifecycle" && /already warm/.test(e.note || "")), "second turn went direct while Box was warm");
  assert.ok(second.some((e) => e.type === "billing.stop"), "newest turn stops after its own idle window");
  assert.equal((await box.get(boxId)).state, "archived");
});

test("concurrent turns on one conversation are serialized through the Box, then auto-stopped", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });

  const a: any[] = [], b: any[] = [];
  const g1 = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const g2 = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run two", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const da = (async () => { for await (const e of g1) a.push(e); })();
  const db = (async () => { for await (const e of g2) b.push(e); })();
  await Promise.all([da, db]);

  const id1 = a.find((e) => e.type === "turn.done")?.boxId;
  const id2 = b.find((e) => e.type === "turn.done")?.boxId;
  assert.equal(id1, id2, "both serialized turns reuse the same Box");
  assert.ok(a.some((e) => e.type === "user-box.delta"));
  assert.ok(b.some((e) => e.type === "user-box.delta"));
  assert.ok(!a.some((e) => e.type === "billing.stop"), "first pending stop is cancelled by the newer queued turn");
  assert.ok(b.some((e) => e.type === "billing.stop"), "newest turn stops after idle window");
  assert.equal((await box.get(id1)).state, "archived", "Box ends archived after both turns");
  const users = orchestrator.getTranscript("u", "c").filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["create one", "run two"]);
});

test("a stop waits behind an in-flight turn (no archive mid-harness)", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  const turn: any[] = [], stop: any[] = [];
  const gt = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const dt = (async () => { for await (const e of gt) turn.push(e); })();
  // Let the turn actually acquire the box lock and create the session before stop races it.
  while (!turn.some((e) => e.type === "handoff.started")) await new Promise((r) => setTimeout(r, 1));
  const gs = orchestrator.stopUserBox("u", "c");
  const ds = (async () => { for await (const e of gs) stop.push(e); })();
  await Promise.all([dt, ds]);
  // The turn completed fully before the stop archived the box.
  assert.ok(turn.some((e) => e.type === "turn.done"), "turn finished");
  assert.deepEqual(stop.filter((e) => e.type === "lifecycle").map((e) => e.state), ["stopping", "archiving", "archived"]);
});

test("userBoxStatus reports precise, non-mutating state", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  assert.equal((await orchestrator.userBoxStatus("u", "c")).kind, "none");
  for await (const _ of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) void _;
  assert.equal((await orchestrator.userBoxStatus("u", "c")).kind, "archived");
  await orchestrator.stopIdleUserBox("u", "c");
  assert.equal((await orchestrator.userBoxStatus("u", "c")).kind, "archived");
});

test("resume path bridges as 'resuming' and reuses the same box", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  const boxId = first.find((e) => e.type === "turn.done")?.boxId;
  await orchestrator.stopIdleUserBox("u", "c");
  const second: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run two", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) second.push(e);
  assert.ok(second.some((e) => e.type === "shared.larp" && /resuming/.test(e.note)), "resume bridges as resuming");
  assert.ok(second.some((e) => e.type === "handoff.started"), "resume bridges back into the box");
  assert.equal(second.find((e) => e.type === "turn.done")?.boxId, boxId, "same box reused on resume");
});

test("hidden context envelope carries transcript + machine state, strips cleanly", async () => {
  const hidden = buildHiddenContext({
    transcript: [
      { role: "user", content: "make proof1.txt", mode: "shared" },
      { role: "assistant", content: "booting your box", mode: "shared", harness: "claude" },
    ],
    machine: { location: "user-box", tools: true, boxId: "box-9" },
    partialShared: "spinning up your sandbox",
  });
  assert.match(hidden, /<machine-state location="user-box" tools="true" boxId="box-9"\/>/);
  assert.match(hidden, /make proof1.txt/);
  assert.match(hidden, /<partial-shared-response/);
  // wrapped text is stripped entirely from anything user-visible
  assert.equal(stripHiddenContext(`before ${hidden} after`), "before  after".trim());
});

test("detectToolIntent flags tool work but not pure chit-chat", () => {
  assert.equal(detectToolIntent("create a file foo.txt"), true);
  assert.equal(detectToolIntent("run the build and fix the test"), true);
  assert.equal(detectToolIntent("what's ur ip"), true);
  assert.equal(detectToolIntent("hello, how are you today?"), false);
});

// A user box that takes time to provision: lets a follow-up message genuinely
// overlap the bridge so we can prove it is answered immediately by shared.
class SlowUserBoxClient extends FakeBoxClient {
  readyAt = new Map<string, number>();
  delayMs = 80;
  override async create(input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo> {
    const box = await super.create(input);
    if ((input.name ?? "").includes("user")) {
      const provisioning: BoxInfo = { ...box, state: "provisioning" };
      this.boxes.set(box.id, provisioning);
      this.readyAt.set(box.id, Date.now() + this.delayMs);
      return provisioning;
    }
    return box;
  }
  override async get(boxId: string): Promise<BoxInfo> {
    const box = await super.get(boxId);
    const at = this.readyAt.get(boxId);
    if (at !== undefined && box.state === "provisioning" && Date.now() >= at) {
      const ready: BoxInfo = { ...box, state: "idle" };
      this.boxes.set(boxId, ready);
      return ready;
    }
    return box;
  }
}


test("first chatty turn replies from shared immediately while one Box prewarms", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 60;
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 5, autoStopIdleMs: 1 });

  const first: any[] = [];
  const started = Date.now();
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "hello", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  assert.equal(first.find((e) => e.type === "turn.done")?.route, "shared-only");
  assert.ok(Date.now() - started < box.delayMs, "chatty answer does not wait for private Box readiness");
  assert.ok(first.some((e) => e.type === "shared.delta"), "chatty first turn is answered by shared");
  assert.ok(!first.some((e) => e.type === "handoff.started"), "chatty first turn does not bridge stale hello into Box");
  assert.ok(!first.some((e) => e.type === "user-box.delta"), "chatty first turn has no duplicate Box answer");
  assert.equal([...box.boxes.values()].filter((b) => /user/.test(b.name || "")).length, 1, "exactly one user Box is prewarming");
});

test("stopUserBox streams stopping -> archiving -> archived and pauses billing", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  assert.ok(first.some((e) => e.type === "billing.start"));
  assert.ok(first.some((e) => e.type === "handoff.started"));
  assert.ok(first.some((e) => e.type === "context.injected" && e.scope === "user-box" && e.machine.tools === true));

  const stop: any[] = [];
  for await (const e of orchestrator.stopUserBox("u", "c")) stop.push(e);
  const states = stop.filter((e) => e.type === "lifecycle").map((e) => e.state);
  assert.deepEqual(states, ["stopping", "archiving", "archived"]);
  const bill = stop.find((e) => e.type === "billing.stop");
  assert.ok(bill && bill.costUsd >= 0 && /paused/i.test(bill.note));
});

test("lifecycle stop and resume reuses session Box", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  const boxId = first.find((e) => e.type === "handoff.started")?.boxId;
  assert.ok(boxId);
  await orchestrator.stopIdleUserBox("u", "c");
  assert.equal((await box.get(boxId)).state, "archived");
  const second: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run two", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) second.push(e);
  assert.equal(second.find((e) => e.type === "handoff.started")?.boxId, boxId);
  assert.equal((await box.get(boxId)).state, "archived");
});


class StuckResumeBoxClient extends FakeBoxClient {
  override async resume(boxId: string): Promise<BoxInfo> {
    const box = { ...(await this.get(boxId)), state: "provisioning" };
    this.boxes.set(boxId, box);
    return box;
  }
}

test("stuck resume times out, recovers, and queued follow-up also runs in a Box", async () => {
  const box = new StuckResumeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 2, resumeTimeoutMs: 20, handoffTimeoutMs: 200, autoStopIdleMs: 1 });

  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  const oldBoxId = first.find((e) => e.type === "turn.done")?.boxId;
  assert.ok(oldBoxId);
  await orchestrator.stopIdleUserBox("u", "c");
  assert.equal((await box.get(oldBoxId)).state, "archived");

  const tool: any[] = [], chat: any[] = [];
  const gt = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "what's ur ip", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const dt = (async () => { for await (const e of gt) tool.push(e); })();
  await new Promise((r) => setTimeout(r, 5));
  const gc = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "pwd", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const dc = (async () => { for await (const e of gc) chat.push(e); })();
  await Promise.all([dt, dc]);

  assert.ok(tool.some((e) => e.type === "lifecycle" && e.state === "resume-timeout"), "stuck resume visibly timed out");
  assert.ok(tool.some((e) => e.type === "handoff.started"), "original tool work bridged after recovery");
  assert.equal(tool.filter((e) => e.type === "user-box.delta").length, 1, "original turn gets exactly one Box answer");
  const newBoxId = tool.find((e) => e.type === "turn.done")?.boxId;
  assert.notEqual(newBoxId, oldBoxId, "fresh box recovered from stale archived box");
  assert.ok(chat.some((e) => e.type === "user-box.delta"), "queued follow-up also runs in a Box");
  assert.ok(chat.some((e) => e.type === "billing.stop"), "queued follow-up auto-stops too");
});


test("interactive proof UI has no global message queue and can abort stale shared streams", async () => {
  const html = await import("node:fs/promises").then((fs) => fs.readFile("scripts/interactive-proof-server.ts", "utf8"));
  assert.match(html, /activeTurns=new Map/);
  assert.match(html, /abortInterruptibleSharedTurns/);
  assert.doesNotMatch(html, new RegExp("Hot " + "swap:"));
  assert.doesNotMatch(html, /handoff\.swap/);
  assert.doesNotMatch(html, /queued #/);
  assert.doesNotMatch(html, /const queue=\[\]/);
});
