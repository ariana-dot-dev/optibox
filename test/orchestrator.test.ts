import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  ConsumerBoxAgentOrchestrator,
  createRestrictedSharedCapabilities,
  createUserBoxCapabilities,
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
  async list(): Promise<BoxInfo[]> { return [...this.boxes.values()]; }
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



class FirstCreateStuckBoxClient extends FakeBoxClient {
  firstCreate = true;
  override async create(input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo> {
    const box = await super.create(input);
    if (this.firstCreate && input.name?.startsWith("consumer-agent-user-")) {
      this.firstCreate = false;
      box.state = "provisioning";
      this.boxes.set(box.id, box);
    }
    return box;
  }
}

class SlowStatusBoxClient extends FakeBoxClient {
  slowGets = false;
  override async get(boxId: string): Promise<BoxInfo> {
    if (this.slowGets) await new Promise((r) => setTimeout(r, 80));
    return super.get(boxId);
  }
}

class StreamingLogBoxClient extends FakeBoxClient {
  catReads = 0;
  constructor(private snapshots: string[]) { super(); }
  override async command(_boxId: string, input: { command: string }): Promise<CommandResult> {
    this.commands.push(input.command);
    if (/^cat\s/.test(input.command)) {
      const index = Math.min(this.catReads++, this.snapshots.length - 1);
      return { exitCode: 0, stdout: this.snapshots[index] ?? "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
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
      if (/^(hello|hi|hey)\b|capab|surprise/i.test(message)) {
        yield `shared:${name}:I can answer simple chat here and use the private runtime for tool work.\n<shared-routing>{"needsPrivate":false}</shared-routing>`;
      } else {
        yield `shared:${name}:I’m checking that now.\n<shared-routing>{"needsPrivate":true}</shared-routing>`;
      }
    },
    async *userBox({ capabilities, recap, hiddenContext, machine, partialShared, latestUserMessage }) {
      if (/^(hello|hi|hey)\b|capab|surprise/i.test(latestUserMessage)) {
        yield "<end>";
        return;
      }
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

  // switch harness AND model mid-conversation. The box is now warm, so the
  // turn still emits a shared bridge first, then hot-swaps to the same Box.
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
  assert.ok(first.some((e) => e.type === "shared.delta"), "every turn gets a shared bridge acknowledgement");
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

test("tool turn adopts an existing named warm user Box before creating another", async () => {
  const box = new FakeBoxClient();
  box.boxes.set("box-existing", {
    id: "box-existing",
    name: "consumer-agent-user-u",
    state: "idle",
    archiveAfter: new Date(Date.now() + 60_000).toISOString(),
  } as any);
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "hey what's ur cpu count", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) events.push(e);
  assert.equal(events.find((e) => e.type === "turn.done")?.boxId, "box-existing");
  assert.equal([...box.boxes.values()].filter((b) => b.name === "consumer-agent-user-u").length, 1, "no duplicate user box created");
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

test("legacy detectToolIntent is only a cheap UI hint", () => {
  assert.equal(detectToolIntent("create a file foo.txt"), true);
  assert.equal(detectToolIntent("hello, how are you today?"), false);
  assert.equal(detectToolIntent("surprise me with a color"), false);
});

test("runHarness extracts real Claude stream-json text deltas without duplicating final result", async () => {
  const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "curl -4 -s https://api.ipify.org", description: "Get IPv4" } }] } };
  const toolResult = { type: "user", tool_use_result: { stdout: "78.47.150.66", stderr: "", is_error: false } };
  const snapshots = [
    `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } })}\n${JSON.stringify(toolUse)}\n${JSON.stringify(toolResult)}\n${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } })}\n${JSON.stringify(toolUse)}\n${JSON.stringify(toolResult)}\n${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } })}\n${JSON.stringify({ type: "result", result: "Hello" })}\n__CBA_EXIT__:0\n`,
  ];
  const box = new StreamingLogBoxClient(snapshots);
  const toolEvents: any[] = [];
  const caps = createUserBoxCapabilities(box, "box-1", { pollMs: 1, onHarnessEvent: (event) => toolEvents.push(event) });
  const chunks: string[] = [];
  for await (const chunk of caps.runHarness({ argv: ["claude", "-p", "hi"], outputMode: "claude-stream-json", pollMs: 1 })) chunks.push(chunk);
  assert.deepEqual(chunks, ["Hel", "lo"]);
  assert.ok(toolEvents.some((e) => e.phase === "tool_use" && e.command === "curl -4 -s https://api.ipify.org"));
  assert.ok(toolEvents.some((e) => e.phase === "tool_result" && e.stdout === "78.47.150.66"));
});

test("runHarness forwards Codex JSON final message only when token deltas are not exposed", async () => {
  const snapshots = [
    `${JSON.stringify({ type: "session.started" })}\n`,
    `${JSON.stringify({ type: "session.started" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } })}\n__CBA_EXIT__:0\n`,
  ];
  const box = new StreamingLogBoxClient(snapshots);
  const caps = createUserBoxCapabilities(box, "box-1", { pollMs: 1 });
  const chunks: string[] = [];
  for await (const chunk of caps.runHarness({ argv: ["codex", "exec", "--json", "hi"], outputMode: "codex-json", pollMs: 1 })) chunks.push(chunk);
  assert.deepEqual(chunks, ["Done."]);
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

class SlowArchivingBoxClient extends FakeBoxClient {
  archiveReadyAt = new Map<string, number>();
  archiveDelayMs = 80;
  override async stop(boxId: string): Promise<BoxInfo> {
    const box = { ...(await this.get(boxId)), state: "archiving" };
    this.boxes.set(boxId, box);
    this.archiveReadyAt.set(boxId, Date.now() + this.archiveDelayMs);
    return box;
  }
  override async get(boxId: string): Promise<BoxInfo> {
    const box = await super.get(boxId);
    const at = this.archiveReadyAt.get(boxId);
    if (at !== undefined && box.state === "archiving" && Date.now() >= at) {
      const archived: BoxInfo = { ...box, state: "archived" };
      this.boxes.set(boxId, archived);
      return archived;
    }
    return box;
  }
}


test("CPU request during archiving gets shared response before private resume", async () => {
  const box = new SlowArchivingBoxClient();
  box.archiveDelayMs = 90;
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 5, resumeTimeoutMs: 200, autoStopIdleMs: 100_000 });

  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) {
    first.push(e);
    if (e.type === "turn.done") break;
  }
  const boxId = first.find((e) => e.type === "turn.done")?.boxId;
  assert.ok(boxId);

  const stop: any[] = [];
  const ds = (async () => { for await (const e of orchestrator.stopUserBox("u", "c")) stop.push(e); })();
  await waitFor(() => stop.some((e) => e.type === "lifecycle" && e.state === "archiving"));

  const cpu: any[] = [];
  const started = Date.now();
  const dc = (async () => {
    for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "what's your CPU count", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) {
      cpu.push(e);
      if (e.type === "turn.done") break;
    }
  })();
  await waitFor(() => cpu.some((e) => e.type === "shared.delta"), 50);
  assert.ok(Date.now() - started < box.archiveDelayMs, "shared response appears before archive completes");
  assert.ok(!cpu.some((e) => e.type === "handoff.started"), "private runtime has not resumed before shared response");
  const sharedContext = cpu.find((e) => e.type === "context.injected" && e.scope === "shared");
  assert.equal(sharedContext?.machine.status, "resuming", "shared hidden context reflects archiving/resume rather than generic provisioning");

  await Promise.all([ds, dc]);
  assert.ok(cpu.some((e) => e.type === "lifecycle" && /resumed|provisioned|warm/.test(e.note || "")), "private runtime resumes after the shared response");
  assert.ok(cpu.some((e) => e.type === "user-box.delta"), "private runtime can answer or add after reading shared history");
});



test("shared-only cold greeting does not later answer a follow-up private turn", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 80;
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 5, autoStopIdleMs: 100_000 });

  const greeting: any[] = [];
  const dg = (async () => {
    for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "hey", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) {
      greeting.push(e);
      if (e.type === "turn.done") break;
    }
  })();
  await waitFor(() => greeting.some((e) => e.type === "shared.delta"), 50);

  const ip: any[] = [];
  const di = (async () => {
    for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "whats ur ip", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) {
      ip.push(e);
      if (e.type === "turn.done") break;
    }
  })();
  await Promise.all([dg, di]);

  assert.ok(greeting.some((e) => e.type === "handoff.started"), "shared-only greeting still hands off to the private Box agent");
  assert.ok(greeting.some((e) => e.type === "trace" && e.stage === "user-box.response.end"), "only the private Box agent suppresses its answer by returning exactly <end>");
  assert.equal(greeting.filter((e) => e.type === "user-box.delta").length, 0, "greeting does not emit a private answer");
  assert.equal(ip.filter((e) => e.type === "user-box.delta").length, 1, "follow-up gets exactly one private answer");
  assert.ok(ip.some((e) => e.type === "shared.delta"), "follow-up still receives immediate shared bridge while Box is not ready/busy");
});


test("first greeting eagerly starts private Box before shared-only answer is finalized", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 60;
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 5, autoStopIdleMs: 100_000 });

  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "hey", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) {
    events.push(e);
    if (e.type === "turn.done") break;
  }

  const bootIdx = events.findIndex((e) => e.type === "trace" && e.stage === "box.boot.start");
  const lifecycleIdx = events.findIndex((e) => e.type === "lifecycle" && ["starting", "provisioning", "resuming", "ready"].includes(e.state));
  const boot = events[bootIdx];
  const billingIdx = events.findIndex((e) => e.type === "billing.start");
  const sharedIdx = events.findIndex((e) => e.type === "shared.delta");
  assert.ok(lifecycleIdx >= 0, "runtime emits a real lifecycle event for the eager Box start");
  assert.ok(bootIdx >= 0 && bootIdx < sharedIdx, "private Box start is requested before the shared greeting streams");
  assert.ok(boot?.boxId && boot.boxId !== "pending", "boot.start is emitted only after a real Box id exists");
  assert.ok(/accepted|exists/.test(boot?.message || ""), "boot.start describes a confirmed Box API state, not an intent");
  assert.ok(billingIdx >= 0 && billingIdx < sharedIdx, "eager prepare starts visible per-user billing even if the private answer is later suppressed");
  assert.equal(events.filter((e) => e.type === "user-box.delta").length, 0, "shared-only greeting is not mislabeled as a private/tool answer");
  assert.equal(events.find((e) => e.type === "turn.done")?.route, "shared", "final route label remains honest for a shared-only answer");
  assert.equal([...box.boxes.values()].filter((b) => /user/.test(b.name || "")).length, 1, "one private user Box was started for the first greeting");
});

test("shared routing cannot suppress private Box answer unless Box returns exact end sentinel", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 5;
  const harness: HarnessAdapter = {
    name: "no-shared-suppression",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() {
      yield `shared says enough\n<shared-routing>{"needsPrivate":false}</shared-routing>`;
    },
    async *userBox() {
      yield "PRIVATE_BOX_DECIDED_TO_ANSWER";
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 1 });

  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "hey", selection: { harness: "no-shared-suppression", provider: "anthropic", model: "m-1" } })) events.push(e);

  assert.ok(!events.some((e) => e.type === "trace" && e.stage === "handoff.suppressed"), "shared/system side no longer has a sufficiency suppression trace");
  assert.ok(events.some((e) => e.type === "handoff.started"), "private Box agent always receives the handoff");
  assert.equal(events.filter((e) => e.type === "user-box.delta").map((e) => e.text).join(""), "PRIVATE_BOX_DECIDED_TO_ANSWER", "private answer is surfaced despite needsPrivate:false");
});

test("only exact private Box <end> sentinel suppresses private output", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 5;
  const harness: HarnessAdapter = {
    name: "exact-end-only",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() {
      yield `shared\n<shared-routing>{"needsPrivate":false}</shared-routing>`;
    },
    async *userBox({ latestUserMessage }) {
      yield latestUserMessage.includes("newline") ? "<end>\n" : "<end>";
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 1 });

  const exact: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "exact", message: "exact", selection: { harness: "exact-end-only", provider: "anthropic", model: "m-1" } })) exact.push(e);
  assert.equal(exact.filter((e) => e.type === "user-box.delta").length, 0, "exact <end> emits no private text");
  assert.ok(exact.some((e) => e.type === "trace" && e.stage === "user-box.response.end"));

  const newline: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "newline", message: "newline", selection: { harness: "exact-end-only", provider: "anthropic", model: "m-1" } })) newline.push(e);
  assert.equal(newline.filter((e) => e.type === "user-box.delta").map((e) => e.text).join(""), "<end>\n", "non-exact sentinel text is surfaced");
});

test("not-ready turns answer from shared first while private runtime starts in parallel", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 60;
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 5, autoStopIdleMs: 1 });

  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "whats ur ip", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  assert.equal(first.find((e) => e.type === "turn.done")?.route, "bridge");
  const sharedIdx = first.findIndex((e) => e.type === "shared.delta");
  const bootIdx = first.findIndex((e) => e.type === "trace" && e.stage === "box.boot.start");
  const boxIdx = first.findIndex((e) => e.type === "user-box.delta");
  assert.ok(sharedIdx >= 0, "shared response is emitted");
  assert.ok(bootIdx >= 0 && bootIdx < sharedIdx, "private startup is kicked off before/during the shared response");
  assert.ok(boxIdx > sharedIdx, "private runtime reads the shared response later and may add/suppress");
  assert.ok(first.some((e) => e.type === "handoff.started"), "private runtime is started even for a not-ready shared-first turn");
  assert.equal([...box.boxes.values()].filter((b) => /user/.test(b.name || "")).length, 1, "one user Box is created in parallel");
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




test("stuck first Box create does not poison second message session", async () => {
  const box = new FirstCreateStuckBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, handoffTimeoutMs: 8, autoStopIdleMs: 1 });
  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create first proof file", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  assert.ok(first.some((e) => e.type === "turn.blocked"), "first turn reports an explicit retryable blocker instead of a network error");

  const second: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create second proof file", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) second.push(e);
  assert.ok(second.some((e) => e.type === "runtime.proof"), "second turn reaches authoritative runtime after stale create is cleared");
  assert.ok(second.some((e) => e.type === "user-box.delta"), "second turn streams private runtime chunks");
  assert.equal(second.filter((e) => e.type === "turn.done").length, 1, "second turn completes once");
});

test("two successful messages reuse one Box conversation without duplicate answers", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create first proof file", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  const firstBoxId = first.find((e) => e.type === "turn.done")?.boxId;
  assert.ok(firstBoxId);

  const second: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create second proof file", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) second.push(e);
  assert.equal(second.find((e) => e.type === "turn.done")?.boxId, firstBoxId, "same ready Box/session is reused");
  assert.equal(second.filter((e) => e.type === "shared.delta").length, 1, "one shared bridge ack during resume");
  assert.equal(second.filter((e) => e.type === "user-box.delta").length, 1, "one private runtime answer");
  assert.equal(second.filter((e) => e.type === "runtime.proof").length, 1, "one authoritative runtime owner");
});

test("send emits immediate trace and bridge before slow Box status resolves", async () => {
  const box = new SlowStatusBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  for await (const _ of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create first proof file", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) void _;

  box.slowGets = true;
  const iterator = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create second proof file", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })[Symbol.asyncIterator]();
  const first = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no immediate first event")), 25)),
  ]);
  assert.equal(first.value.type, "trace");
  assert.equal(first.value.stage, "turn.submit.accepted");
  const second = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no immediate bridge event")), 25)),
  ]);
  assert.equal(second.value.type, "trace");
  assert.equal(second.value.stage, "shared.reasoning.start");
  for await (const _ of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<any>) void _;
});

test("interactive proof UI has no global message queue and can abort stale shared streams", async () => {
  const html = await import("node:fs/promises").then((fs) => fs.readFile("scripts/interactive-proof-server.ts", "utf8"));
  assert.match(html, /activeTurns=new Map/);
  assert.match(html, /function routeEvent\(ev\)/);
  assert.match(html, /function resetRouteForTurn\(\)/);
  assert.match(html, /function routeIsPrivate\(\)/);
  assert.match(html, /routeEvent\(ev\);const t=activeTurns/);
  assert.doesNotMatch(html, /function routeForState/);
  assert.doesNotMatch(html, /Route: handed off to the user machine\./);
  assert.doesNotMatch(html, /waiting for runtime events/);
  assert.match(html, /message accepted; checking Box state/);
  assert.match(html, /shared text is just the bridge response/);
  assert.match(html, /private Box is '\+state\+boxLabel\(routeState\.boxId\)/);
  assert.match(html, /user-machine answer is streaming/);
  assert.match(html, /private Box bridge/);
  assert.match(html, /turn completed via '\+routeLabel\+' runtime/);
  assert.match(html, /abortInterruptibleSharedTurns/);
  assert.match(html, /submit event fired/);
  assert.match(html, /backend.request.received/);
  assert.match(html, /shared.delta/);
  assert.match(html, /turn.blocked/);
  assert.match(html, /Private runtime is not ready yet/);
  assert.match(html, /Show traces/);
  assert.match(html, /body\.hide-traces \.msg\.trace\{display:none\}/);
  assert.match(html, /id="showTraces" type="checkbox"/);
  assert.doesNotMatch(html, new RegExp("Hot " + "swap:"));
  assert.doesNotMatch(html, /handoff\.swap/);
  assert.doesNotMatch(html, /queued #/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "interactive proof page contains inline script");
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotMatch(html, /const queue=\[\]/);
});

test("runtime proof event states continuation is in-box harness, not Box prompt/API or host agent", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("opencode")], readinessPollMs: 1, autoStopIdleMs: 1 });
  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run pwd", selection: { harness: "opencode", provider: "anthropic", model: "m-1" } })) events.push(e);
  const proof = events.find((e) => e.type === "runtime.proof");
  assert.ok(proof, "runtime proof is emitted before in-Box deltas");
  assert.equal(proof.boxPromptApiUsed, false);
  assert.equal(proof.boxBuiltInAgentUsed, false);
  assert.equal(proof.hostAsciiAgentUsed, false);
  assert.equal(proof.continuation, "in-box-runtime-harness");
  assert.equal(proof.streaming, "native-json-events");
  assert.ok(events.some((e) => e.type === "exec" && e.kind === "command"), "continuation uses Box command substrate");
  assert.ok(!box.commands.some((cmd) => /\/prompt\b|ascii agent|ascii task|claude-code.*host/i.test(cmd)), "no Box prompt endpoint or host agent command is used");
});


test("codebase daemon example is executable and self-contained", async () => {
  const child = spawn(process.execPath, [
    "dist/examples/codebase-daemon/agentDaemon.js",
    "--stream",
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4-6",
    "--cwd",
    "/tmp",
    "--system-prompt-file",
    "/tmp/CONSUMER_AGENT_SYSTEM.md",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end("<latest-user-request>Check my CPU count.</latest-user-request>");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Example codebase daemon observed \d+ CPU cores/);
  assert.match(stdout, /Runtime selection: anthropic\/claude-sonnet-4-6/);
});
test("runtime feasibility matrix covers required harnesses", async () => {
  const { RUNTIME_FEASIBILITY } = await import("../src/runtimeMatrix.js");
  for (const harness of ["claude-agent-sdk", "codebase-daemon", "pi", "hermes", "opencode"]) {
    const row = RUNTIME_FEASIBILITY.find((r) => r.harnessName === harness);
    assert.ok(row, `${harness} is in the feasibility matrix`);
    assert.equal(row.supported, true);
    assert.ok(row.proofPath);
  }
});

test("OpenCode JSON parser streams documented text events and tool events", async () => {
  const snapshots = [
    `${JSON.stringify({ type: "text", text: "Hel" })}\n`,
    `${JSON.stringify({ type: "text", text: "Hel" })}\n${JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { title: "Run nproc", input: { command: "nproc" }, output: "4" } } })}\n${JSON.stringify({ type: "text", text: "lo" })}\n__CBA_EXIT__:0\n`,
  ];
  const box = new StreamingLogBoxClient(snapshots);
  const toolEvents: any[] = [];
  const caps = createUserBoxCapabilities(box, "box-1", { pollMs: 1, onHarnessEvent: (event) => toolEvents.push(event) });
  const chunks: string[] = [];
  for await (const chunk of caps.runHarness({ argv: ["opencode", "run", "--format", "json", "hi"], outputMode: "opencode-json", pollMs: 1 })) chunks.push(chunk);
  assert.deepEqual(chunks, ["Hel", "lo"]);
  assert.ok(toolEvents.some((e) => e.toolName === "bash" && e.command === "nproc"));
});
