import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  ConsumerBoxAgentOrchestrator,
  createRestrictedSharedCapabilities,
  createUserBoxCapabilities,
  assertNoBoxAgent,
  buildHiddenContext,

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
  async command(boxId: string, input: { command: string }): Promise<CommandResult> {
    // Model the real substrate: commands execute only on a usable box. The
    // orchestrator's readiness = "a command runs", so a fake that answered
    // commands on provisioning/archived boxes would make every box look ready.
    const state = (await this.get(boxId)).state;
    if (!["ready", "idle", "running", "provisioned"].includes(state)) {
      throw new Error(`fake box ${boxId} cannot run commands in state ${state}`);
    }
    this.commands.push(input.command);
    return { exitCode: 0, stdout: `ran:${input.command}`, stderr: "" };
  }
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
    if (input.command === "echo __BOX_UP__") return super.command(_boxId, input);
    this.commands.push(input.command);
    if (/^cat\s/.test(input.command)) {
      const index = Math.min(this.catReads++, this.snapshots.length - 1);
      return { exitCode: 0, stdout: this.snapshots[index] ?? "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class PausingStopBoxClient extends FakeBoxClient {
  stopStarted = false;
  releaseStop!: () => void;
  stopGate = new Promise<void>((resolve) => { this.releaseStop = resolve; });
  override async stop(boxId: string): Promise<BoxInfo> {
    this.stopStarted = true;
    await this.stopGate;
    return super.stop(boxId);
  }
}

class GatedToolLogBoxClient extends FakeBoxClient {
  answerReleased = false;
  releaseAnswer(): void { this.answerReleased = true; }
  override async command(_boxId: string, input: { command: string }): Promise<CommandResult> {
    if (input.command === "echo __BOX_UP__") return super.command(_boxId, input);
    this.commands.push(input.command);
    if (/^cat\s/.test(input.command)) {
      const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "sleep 1 && echo done", description: "long command" } }] } };
      const working = `${JSON.stringify(toolUse)}\n`;
      if (!this.answerReleased) return { exitCode: 0, stdout: working, stderr: "" };
      const answer = "done from tool";
      return {
        exitCode: 0,
        stdout: `${working}${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: answer } } })}\n${JSON.stringify({ type: "result", result: answer })}\n__CBA_EXIT__:0\n`,
        stderr: "",
      };
    }
    if (/kill -0/.test(input.command)) return { exitCode: 0, stdout: "up\n", stderr: "" };
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
        yield `shared:${name}:I can answer simple chat here and use the private runtime for tool work.`;
      } else {
        yield `shared:${name}:I’m checking that now.`;
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
  assert.ok(second.some((e) => e.type === "trace" && e.stage === "shared.bridge.start" && /resuming/.test(e.message)), "tool follow-up bridges during resume");
  assert.ok(second.some((e) => e.type === "user-box.delta"), "tool follow-up is answered by the Box");
  assert.ok(second.some((e) => e.type === "billing.stop"), "follow-up auto-stops billing");
  assert.equal((await box.get(boxId)).state, "archived", "Box is archived again after follow-up");
});

test("turn traces include attachable conversation diagnostics", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) events.push(e);

  const accepted = events.find((e) => e.type === "trace" && e.stage === "turn.submit.accepted");
  assert.equal(accepted?.data?.conversation?.activeTurnCount, 1);
  assert.equal(accepted?.data?.conversation?.unansweredPromptCount, 1);

  const reserved = events.find((e) => e.type === "trace" && e.stage === "private-round.reserved");
  assert.equal(reserved?.data?.candidateRoundState, "needed");
  assert.equal(reserved?.data?.conversation?.privateRoundStates?.needed, 1);

  const runtime = events.find((e) => e.type === "trace" && e.stage === "user-box.runtime.start");
  assert.equal(runtime?.data?.route, "bridge");
  assert.ok(runtime?.data?.roundId);

  const gate = events.find((e) => e.type === "trace" && e.stage === "autostop.gate.evaluated");
  assert.equal(gate?.data?.armForBoxDone, true);
  assert.equal(gate?.data?.conversation?.unansweredPromptCount, 0);
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

  const firstDoneIndex = first.findIndex((e) => e.type === "turn.done");
  const firstTimerStartIndex = first.findIndex((e) => e.type === "autostop.timer" && e.phase === "started");
  const firstTimerCanceledIndex = first.findIndex((e) => e.type === "autostop.timer" && e.phase === "canceled");
  assert.ok(firstDoneIndex >= 0, "first response finished");
  assert.ok(firstTimerStartIndex > firstDoneIndex, "idle countdown starts only after the private response is done");
  assert.ok(firstTimerCanceledIndex > firstTimerStartIndex, "new user message visibly cancels/resets the first countdown");
  assert.ok(!first.some((e) => e.type === "billing.stop"), "first pending stop was cancelled by the newer turn");

  assert.equal(second.find((e) => e.type === "turn.done")?.boxId, boxId, "new turn reused the still-warm Box");
  assert.ok(second.some((e) => e.type === "lifecycle" && /already warm/.test(e.note || "")), "second turn went direct while Box was warm");
  const secondDoneIndex = second.findIndex((e) => e.type === "turn.done");
  const secondTimerStartIndex = second.findIndex((e) => e.type === "autostop.timer" && e.phase === "started");
  const secondTimerStopIndex = second.findIndex((e) => e.type === "autostop.timer" && e.phase === "stopping");
  const secondBillingStopIndex = second.findIndex((e) => e.type === "billing.stop");
  assert.ok(secondTimerStartIndex > secondDoneIndex, "new countdown starts after the follow-up response finishes");
  assert.ok(secondTimerStopIndex > secondTimerStartIndex, "visible countdown reaches stopping before Box stop lifecycle");
  assert.ok(secondBillingStopIndex > secondTimerStopIndex, "billing stops promptly after visible countdown reaches zero");
  assert.equal((await box.get(boxId)).state, "archived");
});

test("accepted prompt during auto-stop shutdown resumes and preserves the answer", async () => {
  const box = new PausingStopBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  const selection = { harness: "alpha", provider: "anthropic", model: "m-1" };

  const first: any[] = [];
  const d1 = (async () => {
    for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection })) first.push(e);
  })();

  await waitFor(() => box.stopStarted, 300);
  const boxId = first.find((e) => e.type === "turn.done")?.boxId;
  assert.ok(boxId, "first turn reached the private box before auto-stop began");

  const second: any[] = [];
  const d2 = (async () => {
    for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run follow up", selection })) second.push(e);
  })();
  await waitFor(() => second.some((e) => e.type === "trace" && e.stage === "turn.submit.accepted"), 300);

  box.releaseStop();
  await Promise.all([d1, d2]);

  assert.ok(first.some((e) => e.type === "autostop.timer" && e.phase === "canceled"), "accepted prompt cancels the in-flight idle shutdown");
  assert.ok(!first.some((e) => e.type === "billing.stop"), "raced auto-stop does not pause billing for an accepted prompt");
  assert.ok(second.some((e) => e.type === "user-box.delta" && /box:alpha/.test(e.text)), "follow-up still gets its private Box answer");
  assert.equal(second.find((e) => e.type === "turn.done")?.boxId, boxId, "follow-up continues on the same resumed Box");
});

test("an identical concurrent message is deduped; the original still gets its Box round", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });

  const a: any[] = [], b: any[] = [];
  const g1 = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const g2 = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const da = (async () => { for await (const e of g1) a.push(e); })();
  const db = (async () => { for await (const e of g2) b.push(e); })();
  await Promise.all([da, db]);

  const withRound = [a, b].filter((events) => events.some((e) => e.type === "user-box.delta"));
  assert.equal(withRound.length, 1, "exactly one of the duplicate turns runs the Box round");
  // The losing duplicate either got deduped as stale (suppressed trace) or was
  // interrupted by the newer identical turn (turn.done settled=false) — both are
  // valid; what matters is one answer, not two and not zero.
  const loser = [a, b].find((events) => !events.some((e) => e.type === "user-box.delta"))!;
  assert.ok(
    loser.some((e) => (e.type === "trace" && e.stage === "private-round.suppressed") || (e.type === "turn.done" && e.settled === false)),
    "the losing duplicate ends explicitly (deduped or interrupted), never with a second answer",
  );
  assert.ok([...a, ...b].some((e) => e.type === "billing.stop"), "Box auto-stops once both streams end and the round is settled");
});

test("a DIFFERENT follow-up INTERRUPTS the prior turn; the newest message gets the Box round", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });

  const a: any[] = [], b: any[] = [];
  const g1 = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const g2 = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "what's your ip", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const da = (async () => { for await (const e of g1) a.push(e); })();
  const db = (async () => { for await (const e of g2) b.push(e); })();
  await Promise.all([da, db]);

  // Interrupt semantics: the newest message is authoritative. The older turn is
  // aborted (its round may be cut), but the NEWEST question must always be
  // answered by the box — the reported bug was the newest silently dropped.
  assert.ok(b.some((e) => e.type === "user-box.delta"), "the newest message always gets its Box round");
  assert.ok([...a, ...b].some((e) => e.type === "billing.stop"), "Box auto-stops after everything settles");
  const users = orchestrator.getTranscript("u", "c").filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual([...users].sort(), ["create one", "what's your ip"]);
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
  for await (const _ of orchestrator.stopUserBox("u", "c")) void _;
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
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "what's your CPU count", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) events.push(e);
  assert.equal(events.find((e) => e.type === "turn.done")?.boxId, "box-existing");
  assert.equal([...box.boxes.values()].filter((b) => b.name === "consumer-agent-user-u").length, 1, "no duplicate user box created");
});

test("resume path bridges as 'resuming' and reuses the same box", async () => {
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 1 });
  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  const boxId = first.find((e) => e.type === "turn.done")?.boxId;
  for await (const _ of orchestrator.stopUserBox("u", "c")) void _;
  const second: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run two", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) second.push(e);
  assert.ok(second.some((e) => e.type === "trace" && e.stage === "shared.bridge.start" && /resuming/.test(e.message)), "resume bridges as resuming");
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
    staleDuplicateRequest: true,
  });
  assert.match(hidden, /<machine-state location="user-box" tools="true" boxId="box-9"\/>/);
  assert.match(hidden, /make proof1.txt/);
  assert.match(hidden, /<partial-shared-response/);
  assert.match(hidden, /<stale-duplicate-request action="output-exact-end">/);
  // wrapped text is stripped entirely from anything user-visible
  assert.equal(stripHiddenContext(`before ${hidden} after`), "before  after".trim());
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
  const chunks: any[] = [];
  for await (const chunk of caps.runHarness({ argv: ["claude", "-p", "hi"], outputMode: "claude-stream-json", pollMs: 1 })) chunks.push(chunk);
  assert.deepEqual(chunks.map((c: any) => c.text), ["Hel", "lo"]);
  assert.ok(toolEvents.some((e) => e.phase === "tool_use" && e.command === "curl -4 -s https://api.ipify.org"));
  assert.ok(toolEvents.some((e) => e.phase === "tool_result" && e.stdout === "78.47.150.66"));
});

test("runHarness extracts Claude assistant message snapshots after tool calls", async () => {
  // Root-cause regression for the current diagnostics: Claude Code stream-json
  // can emit final assistant text as an `assistant.message.content[].text`
  // snapshot rather than as Anthropic SDK `stream_event` deltas. The old parser
  // saw tool_use/tool_result but ignored this text shape, making a real answer
  // look like empty private runtime output.
  const toolUse = { type: "assistant", message: { id: "msg-tool", content: [{ type: "tool_use", name: "Bash", input: { command: "find . -maxdepth 1", description: "inspect filesystem" } }] } };
  const toolResult = { type: "user", tool_use_result: { stdout: "README.md\nsrc\n", stderr: "", is_error: false } };
  const answer1 = { type: "assistant", message: { id: "msg-answer", content: [{ type: "text", text: "I found README.md" }] } };
  const answer2 = { type: "assistant", message: { id: "msg-answer", content: [{ type: "text", text: "I found README.md and src." }] } };
  const snapshots = [
    `${JSON.stringify(toolUse)}\n${JSON.stringify(toolResult)}\n${JSON.stringify(answer1)}\n`,
    `${JSON.stringify(toolUse)}\n${JSON.stringify(toolResult)}\n${JSON.stringify(answer1)}\n${JSON.stringify(answer2)}\n${JSON.stringify({ type: "result", session_id: "s-1" })}\n__CBA_EXIT__:0\n`,
  ];
  const box = new StreamingLogBoxClient(snapshots);
  const toolEvents: any[] = [];
  const caps = createUserBoxCapabilities(box, "box-1", { pollMs: 1, onHarnessEvent: (event) => toolEvents.push(event) });
  const chunks: any[] = [];
  for await (const chunk of caps.runHarness({ argv: ["claude", "-p", "what is in the filesystem"], outputMode: "claude-stream-json", pollMs: 1 })) chunks.push(chunk);

  assert.deepEqual(chunks.map((c: any) => [c.messageId, c.text]), [
    ["msg-answer", "I found README.md"],
    ["msg-answer", " and src."],
  ]);
  assert.ok(toolEvents.some((e) => e.phase === "tool_use" && e.command === "find . -maxdepth 1"));
  assert.ok(toolEvents.some((e) => e.phase === "tool_result" && /README/.test(e.stdout)));
});

test("runHarness forwards Codex JSON final message only when token deltas are not exposed", async () => {
  const snapshots = [
    `${JSON.stringify({ type: "session.started" })}\n`,
    `${JSON.stringify({ type: "session.started" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } })}\n__CBA_EXIT__:0\n`,
  ];
  const box = new StreamingLogBoxClient(snapshots);
  const caps = createUserBoxCapabilities(box, "box-1", { pollMs: 1 });
  const chunks: any[] = [];
  for await (const chunk of caps.runHarness({ argv: ["codex", "exec", "--json", "hi"], outputMode: "codex-json", pollMs: 1 })) chunks.push(chunk);
  assert.deepEqual(chunks.map((c: any) => c.text), ["Done."]);
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



test("cold greeting box round stays silent via <end>; follow-up answers privately", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 80;
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 5, autoStopIdleMs: 100_000 });

  const greeting: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "hey", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) {
    greeting.push(e);
    if (e.type === "turn.done") break;
  }
  assert.ok(greeting.some((e) => e.type === "shared.delta"), "greeting gets an immediate shared answer");
  assert.ok(greeting.some((e) => e.type === "handoff.started"), "the private Box round always runs — the box agent decides on top");
  assert.ok(greeting.some((e) => e.type === "trace" && e.stage === "user-box.response.end"), "greeting box round stays silent via the <end> sentinel, not a shared-side routing gate");
  assert.equal(greeting.filter((e) => e.type === "user-box.delta").length, 0, "greeting does not emit a private answer");

  const ip: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "whats ur ip", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) {
    ip.push(e);
    if (e.type === "turn.done") break;
  }
  assert.equal(ip.filter((e) => e.type === "user-box.delta").length, 1, "the tool follow-up gets exactly one private answer");
});

test("shared text is streamed verbatim — never rewritten, filtered, or replaced", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 40;
  const leakyHarness: HarnessAdapter = {
    name: "leaky",
    description: "leaky",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() {
      yield "Good question! I don't have a fixed IP address the way a server does — I'm a conversational AI.\n";
      yield '';
    },
    async *userBox() {
      yield "private runtime answer";
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [leakyHarness], readinessPollMs: 5, autoStopIdleMs: 1 });

  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "what is your ip", selection: { harness: "leaky", provider: "anthropic", model: "m-1" } })) {
    events.push(e);
  }

  const sharedText = events.filter((e) => e.type === "shared.delta").map((e) => e.text).join("");
  // The host shows the agent's words verbatim — no fallback, no leak filter.
  assert.match(sharedText, /fixed IP address the way a server does — I'm a conversational AI/);
  // The <shared-routing> control tag is the ONLY thing stripped from visible text.
  assert.doesNotMatch(sharedText, /shared-routing/);
  assert.equal(events.filter((e) => e.type === "user-box.delta").length, 1, "private runtime still completes the request");
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

test("box round always runs on top of a sufficient shared answer; box stays silent only via <end>", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 5;
  const harness: HarnessAdapter = {
    name: "box-decides",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() {
      yield `shared says enough`;
    },
    async *userBox() {
      // The box agent alone decides whether to add anything; here it has nothing
      // to add on top of the shared answer, so it emits the <end> sentinel.
      yield "<end>";
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 1 });

  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "hey", selection: { harness: "box-decides", provider: "anthropic", model: "m-1" } })) events.push(e);

  assert.ok(events.some((e) => e.type === "shared.delta" && /shared says enough/.test(e.text)), "shared answer is shown verbatim");
  assert.ok(events.some((e) => e.type === "handoff.started"), "the private Box round always runs — the shared agent never gates it out");
  assert.ok(events.some((e) => e.type === "trace" && e.stage === "user-box.response.end"), "box stays silent via its own <end>, not a shared-side routing gate");
  assert.equal(events.filter((e) => e.type === "user-box.delta").length, 0, "an <end> box round surfaces no extra text");
});


test("private Box answer chunks stream before final completion", async () => {
  const box = new FakeBoxClient();
  const harness: HarnessAdapter = {
    name: "chunky",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() {
      yield `I’m checking that now.`;
    },
    async *userBox() {
      yield "Hel";
      await new Promise((r) => setTimeout(r, 25));
      yield "lo";
      await new Promise((r) => setTimeout(r, 25));
      yield " world";
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 1 });

  const events: any[] = [];
  const deltaTimes: number[] = [];
  let doneTime = 0;
  const started = Date.now();
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "stream it", selection: { harness: "chunky", provider: "anthropic", model: "m-1" } })) {
    events.push(e);
    if (e.type === "user-box.delta") deltaTimes.push(Date.now() - started);
    if (e.type === "turn.done") doneTime = Date.now() - started;
  }

  const deltas = events.filter((e) => e.type === "user-box.delta").map((e) => e.text);
  assert.deepEqual(deltas, ["Hel", "lo", " world"], "Box output is forwarded incrementally, not coalesced into one blob");
  assert.equal(deltas.join(""), "Hello world");
  assert.ok(deltaTimes.length >= 3);
  assert.ok(deltaTimes[0]! < doneTime, "first Box chunk arrives before final completion");
  assert.ok(events.findIndex((e) => e.type === "user-box.delta") < events.findIndex((e) => e.type === "turn.done"), "delta precedes done event");
});

test("only exact private Box <end> sentinel suppresses private output", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 5;
  const harness: HarnessAdapter = {
    name: "exact-end-only",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() {
      yield `shared`;
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

test("duplicate queued Box round is suppressed by the state machine before private execution", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 5;
  const harness: HarnessAdapter = {
    name: "duplicate-aware",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() {
      yield `I’m checking that now.`;
    },
    async *userBox({ hiddenContext }) {
      if (hiddenContext.includes("<stale-duplicate-request")) {
        yield "<end>";
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
      yield "ANSWER_ONCE";
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 1 });

  const first: any[] = [];
  const second: any[] = [];
  const input = { userId: "u", conversationId: "c", message: "What is my public IP?", selection: { harness: "duplicate-aware", provider: "anthropic", model: "m-1" } };
  const d1 = (async () => { for await (const e of orchestrator.runTurn(input)) first.push(e); })();
  const d2 = (async () => { for await (const e of orchestrator.runTurn(input)) second.push(e); })();
  await Promise.all([d1, d2]);

  const all = [...first, ...second];
  assert.equal(all.filter((e) => e.type === "user-box.delta").map((e) => e.text).join(""), "ANSWER_ONCE", "the duplicate message is answered exactly once — never twice, never zero times");
  assert.equal(all.filter((e) => e.type === "handoff.started").length, 1, "only one of the duplicate turns reaches the Box agent");
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
  for await (const _ of orchestrator.stopUserBox("u", "c")) void _;
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

class ResumeStopsBoxClient extends FakeBoxClient {
  stopNow = false;
  override async create(input: { name?: string; ttlSeconds?: number | null }): Promise<BoxInfo> {
    const box = await super.create(input);
    if ((input.name ?? "").includes("user")) {
      const stopped = { ...box, state: "stopped" };
      this.boxes.set(box.id, stopped);
      return stopped;
    }
    return box;
  }
  override async resume(boxId: string): Promise<BoxInfo> {
    const box = { ...(await this.get(boxId)), state: "cloning" };
    this.boxes.set(boxId, box);
    return box;
  }
  override async get(boxId: string): Promise<BoxInfo> {
    const box = await super.get(boxId);
    if (this.stopNow && box.state === "cloning") {
      const stopped = { ...box, state: "stopped", updatedAt: new Date().toISOString() } as BoxInfo;
      this.boxes.set(boxId, stopped);
      return stopped;
    }
    return box;
  }
}

test("filesystem follow-up during boot-in-flight is not suppressed and terminal stopped resume settles blockers", async () => {
  const box = new ResumeStopsBoxClient();
  box.boxes.set("box-resume", {
    id: "box-resume",
    name: "consumer-agent-user-u",
    state: "archived",
    snapshotAvailable: true,
    snapshotCompletedAt: new Date().toISOString(),
  } as any);
  const harness: HarnessAdapter = {
    name: "bridge-only",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared({ message }) {
      if (/^hey\b/i.test(message)) {
        yield `Hey! How can I help you today?`;
        return;
      }
      // Exact failure shape: bridge text only, no routing control metadata.
      yield "On it — I’ll take a look.";
    },
    async *userBox({ latestUserMessage }) {
      // Greeting: box round runs but has nothing to add on top -> <end>.
      if (/^hey\b/i.test(latestUserMessage)) { yield "<end>"; return; }
      // Filesystem prompt: this must never run because the resume terminally stops.
      yield "SHOULD_NOT_RUN";
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({
    box,
    harnesses: [harness],
    readinessPollMs: 2,
    resumeTimeoutMs: 200,
    handoffTimeoutMs: 200,
    autoStopIdleMs: 1,
    // The greeting's "box always runs" resume leaves box-resume stuck cloning and
    // billing — an orphan the request-driven stop can't reach. The reaper must.
    idleReaperIntervalMs: 20,
  });
  const selection = { harness: "bridge-only", provider: "anthropic", model: "m-1" };

  // Drain the whole greeting turn (not just up to turn.done): the greeting now
  // runs a box round that <end>s, and its billing.stop / autostop fire in the
  // post-turn phase — exactly as a real SSE consumer drains until stream end.
  const greeting: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "hey", selection })) {
    greeting.push(e);
  }
  assert.ok(greeting.some((e) => e.type === "trace" && e.stage === "box.boot.start"), "first greeting eagerly starts/resumes the Box");
  assert.equal(greeting.filter((e) => e.type === "user-box.delta").length, 0, "greeting stays silent (box <end>s or resume is still in-flight)");
  box.stopNow = true;

  const followup: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "xhat's in your filesystem", selection })) followup.push(e);

  assert.ok(followup.some((e) => e.type === "trace" && (e.stage === "box.lock.acquired" || e.stage === "box.boot.start")), "filesystem follow-up really attempts private work (boots / acquires the lock), never gated out by the shared answer");
  assert.equal(followup.filter((e) => e.type === "trace" && e.stage === "private-round.suppressed").length, 0, "filesystem prompt is not suppressed by bridge text alone");
  assert.ok(followup.some((e) => e.type === "turn.blocked" && e.retryable && e.stage === "box.runtime.unavailable"), "terminal stopped resume surfaces a retryable blocker");
  assert.equal(followup.filter((e) => e.type === "user-box.delta").length, 0, "private runtime never runs after terminal stopped state");
  assert.ok(followup.some((e) => e.type === "billing.stop"), "billing is reconciled when the boot/resume terminates before ready");
  const final = [...followup].reverse().find((e: any) => e.type === "trace" && e.stage === "autostop.gate.evaluated");
  assert.equal(final?.data?.conversation?.activeTurnCount, 0);
  assert.equal(final?.data?.conversation?.unansweredPromptCount, 0);
  assert.equal(final?.data?.conversation?.userBoxBootInFlight, false);
  assert.equal(final?.data?.conversation?.boxLockQueued, false);
  assert.equal(final?.data?.conversation?.privateRoundStates?.needed, 0);
  assert.equal(final?.data?.conversation?.privateRoundStates?.active, 0);
  // The greeting left box-resume stuck+billing; the background reaper force-stops it.
  const stoppedStates = new Set(["archived", "stopped"]);
  for (let i = 0; i < 1000 && !stoppedStates.has((await box.get("box-resume")).state); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(stoppedStates.has((await box.get("box-resume")).state), "background reaper force-stops the orphaned stuck box so it cannot run forever");
  orchestrator.dispose();
});

test("stuck resume times out, recovers, and the queued DIFFERENT follow-up still gets its own round", async () => {
  const box = new StuckResumeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 2, resumeTimeoutMs: 20, handoffTimeoutMs: 200, autoStopIdleMs: 1 });

  const first: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) first.push(e);
  const oldBoxId = first.find((e) => e.type === "turn.done")?.boxId;
  assert.ok(oldBoxId);
  for await (const _ of orchestrator.stopUserBox("u", "c")) void _;
  assert.equal((await box.get(oldBoxId)).state, "archived");

  const tool: any[] = [], chat: any[] = [];
  const gt = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "what's ur ip", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const dt = (async () => { for await (const e of gt) tool.push(e); })();
  await new Promise((r) => setTimeout(r, 5));
  const gc = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "pwd", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const dc = (async () => { for await (const e of gc) chat.push(e); })();
  await Promise.all([dt, dc]);

  // Interrupt semantics: "pwd" (the NEWEST message) aborts the stuck tool turn
  // and owns the conversation. Recovery from the stuck resume happens under the
  // newest turn's own boot, on a FRESH box — and the newest question is answered.
  assert.ok(chat.some((e) => e.type === "lifecycle" && e.state === "resume-timeout") || chat.some((e) => e.type === "user-box.delta"), "newest turn either recovers visibly or lands directly on a fresh box");
  assert.ok(chat.some((e) => e.type === "user-box.delta"), "the newest message is answered by the box after recovery");
  const newBoxId = chat.find((e) => e.type === "turn.done")?.boxId;
  assert.notEqual(newBoxId, oldBoxId, "fresh box recovered from the stale archived box");
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

test("aborted shared bridge releases prepared Box round so next message is not a nudge", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 25;
  const harness: HarnessAdapter = {
    name: "abort-cleanup",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() {
      yield `I’m checking that now.`;
    },
    async *userBox({ latestUserMessage }) {
      yield `BOX_HANDLED:${latestUserMessage}`;
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 1 });
  const selection = { harness: "abort-cleanup", provider: "anthropic", model: "m-1" };

  const first = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run first command", selection });
  const firstIterator = first[Symbol.asyncIterator]();
  const seen: any[] = [];
  while (!seen.some((e) => e.type === "shared.delta")) {
    const n = await firstIterator.next();
    assert.equal(n.done, false, "first turn should reach the shared bridge before cancellation");
    seen.push(n.value);
  }
  await firstIterator.return?.(undefined as never);

  const second: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run second command", selection })) second.push(e);

  assert.ok(second.some((e) => e.type === "handoff.started"), "second turn reaches the Box instead of being suppressed by the orphaned first round");
  assert.equal(second.filter((e) => e.type === "user-box.delta").map((e) => e.text).join(""), "BOX_HANDLED:run second command");
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
  assert.match(html, /if\(isLatest\)routeEvent\(ev\)/);
  assert.match(html, /const t=activeTurns\.get\(localId\)/);
  assert.doesNotMatch(html, /function routeForState/);
  assert.doesNotMatch(html, /Route: handed off to the user machine\./);
  assert.doesNotMatch(html, /waiting for runtime events/);
  assert.match(html, /message accepted · checking Box state/);
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
  // Blockers must surface the REAL error message from the event, never a canned
  // client-side line that hides diagnostics (the old "Private runtime is not
  // ready yet" fabrication buried a real EACCES failure).
  assert.doesNotMatch(html, /Private runtime is not ready yet/);
  assert.match(html, /ev\.message\|\|'private runtime failed'/);
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

test("codebase daemon --no-tools never reads host machine facts", async () => {
  const child = spawn(process.execPath, [
    "dist/examples/codebase-daemon/agentDaemon.js",
    "--stream",
    "--no-tools",
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
  assert.doesNotMatch(stdout, /CPU cores/, "no-tools mode must not read os.cpus()");
  assert.match(stdout, /no-tools mode/);
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
  const chunks: any[] = [];
  for await (const chunk of caps.runHarness({ argv: ["opencode", "run", "--format", "json", "hi"], outputMode: "opencode-json", pollMs: 1 })) chunks.push(chunk);
  assert.deepEqual(chunks.map((c: any) => c.text), ["Hel", "lo"]);
  assert.ok(toolEvents.some((e) => e.toolName === "bash" && e.command === "nproc"));
});



test("realCliHarness uses one phase-aware prompt builder for shared and user-box policies", async () => {
  const { buildHarnessPromptBundle } = await import("../examples/shared.js");
  const base = {
    userId: "u",
    conversationId: "c",
    transcript: [],
    selection: { harness: "h", provider: "anthropic", model: "m-1" },
    hiddenContext: "<consumer-context></consumer-context>",
  };
  const sharedBundle = buildHarnessPromptBundle({
    ...base,
    message: "hello",
    capabilities: createRestrictedSharedCapabilities(),
    machine: { location: "shared-box", tools: false, status: "prewarming" },

  }, { phase: "shared", toolsAllowed: false, runtime: "shared-infra" });
  const userBundle = buildHarnessPromptBundle({
    ...base,
    boxId: "box-1",
    recap: "",
    latestUserMessage: "hello",
    capabilities: createUserBoxCapabilities(new FakeBoxClient(), "box-1"),
    machine: { location: "user-box", tools: true, status: "live", boxId: "box-1" },
    partialShared: "",
  }, { phase: "user-box", toolsAllowed: true, runtime: "user-box" });

  assert.match(sharedBundle.prompt, /<latest-user-request>hello<\/latest-user-request>/);
  assert.match(userBundle.prompt, /<latest-user-request>hello<\/latest-user-request>/);
  assert.match(sharedBundle.instructions, /private tools disabled by framework policy/);
  assert.match(userBundle.instructions, /private tool-enabled environment/);
  assert.equal(sharedBundle.policy.toolsAllowed, false);
  assert.equal(userBundle.policy.toolsAllowed, true);
});

// A HarnessRuntime test double that captures the argv/env the harness is
// launched with and emits a canned stream-json reply. Used to prove the shared
// surface runs the SAME harness code as the Box, only with tools disabled.
class CapturingRuntime {
  readonly location: "shared-infra" | "user-box";
  commands: string[] = [];
  lastArgv: string[] = [];
  lastEnv: Record<string, string> | undefined;
  constructor(location: "shared-infra" | "user-box") { this.location = location; }
  async command(cmd: string): Promise<CommandResult> {
    this.commands.push(cmd);
    // Emulate the real shell contract of the batched workspace-prep command:
    // it ends with a bin check echoing __BIN_OK__ / __BIN_MISSING__.
    if (cmd.includes("__BIN_OK__")) {
      return { exitCode: 0, stdout: "__BIN_OK__\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  }
  async *runHarness(spec: { argv: string[]; env?: Record<string, string> }) {
    this.lastArgv = spec.argv;
    this.lastEnv = spec.env;
    yield { text: "ok", messageId: "assistant-0", messageIndex: 0 };
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
}

function sharedCtx(message: string) {
  return {
    userId: "u",
    conversationId: "c",
    message,
    transcript: [],
    selection: { harness: "unified-proof", provider: "anthropic", model: "m-1" },
    capabilities: createRestrictedSharedCapabilities(),
    hiddenContext: "<consumer-context></consumer-context>",
    machine: { location: "shared-box" as const, tools: false, status: "prewarming" as const },

  };
}

test("realCliHarness runs the SAME harness binary on shared infra with tools structurally disabled (no provider fallback)", async () => {
  const { realCliHarness } = await import("../examples/shared.js");
  const sharedRuntime = new CapturingRuntime("shared-infra");
  const harness = realCliHarness({
    name: "unified-proof",
    description: "proof",
    bin: "proof",
    models: [{ provider: "anthropic", model: "m-1" }],
    outputMode: "claude-stream-json",
    buildArgv: ({ prompt, toolsAllowed }) => ["proof", prompt, ...(toolsAllowed ? ["--go"] : ["--no-tools"])],
  }, { createSharedRuntime: () => sharedRuntime as any });

  const chunks: string[] = [];
  for await (const chunk of harness.shared(sharedCtx("hi from shared"))) chunks.push(chunk);

  // The shared surface launched the real harness argv (not a provider API) with
  // the structural no-tool flag, and streamed the harness' own stdout text.
  assert.equal(chunks.join(""), "ok");
  assert.equal(sharedRuntime.lastArgv[0], "proof");
  assert.ok(sharedRuntime.lastArgv.includes("--no-tools"), "shared run passes the structural no-tool flag");
  assert.ok(!sharedRuntime.lastArgv.includes("--go"), "shared run does not enable tools");
  assert.match(String(sharedRuntime.lastArgv[1]), /<latest-user-request>hi from shared<\/latest-user-request>/);
});

test("realCliHarness shared runtime must report shared-infra location", async () => {
  const { realCliHarness } = await import("../examples/shared.js");
  const wrongRuntime = new CapturingRuntime("user-box");
  const harness = realCliHarness({
    name: "unified-proof",
    description: "proof",
    bin: "proof",
    models: [{ provider: "anthropic", model: "m-1" }],
    buildArgv: () => ["proof"],
  }, { createSharedRuntime: () => wrongRuntime as any });
  await assert.rejects(async () => {
    for await (const _ of harness.shared(sharedCtx("hi"))) { /* drain */ }
  }, /shared runtime must report location 'shared-infra'/);
});

test("no provider fallback module remains", async () => {
  const idx: any = await import("../src/index.js");
  assert.equal(idx.streamSharedAnswer, undefined, "streamSharedAnswer export must be gone");
  const { readFile } = await import("node:fs/promises");
  // import.meta.url is dist/test/orchestrator.test.js, so ../../src is the real source tree.
  await assert.rejects(() => readFile(new URL("../../src/providerClient.ts", import.meta.url), "utf8"), "providerClient.ts source must be deleted");
  await assert.rejects(() => readFile(new URL("../src/providerClient.js", import.meta.url), "utf8"), "providerClient.js build artifact must be gone");
});

test("every adapter structurally disables tools when toolsAllowed is false", async () => {
  const baseInput = {
    prompt: "<latest-user-request>hi</latest-user-request>",
    model: "m-1",
    provider: "anthropic",
    cwd: "/tmp/consumer-agent-test-xyz",
    systemInstructionPath: "/tmp/consumer-agent-test-xyz/CONSUMER_AGENT_SYSTEM.md",
  };
  const cases: Array<{ mod: string; provider?: string; assertNoTools: (argv: string[], env?: Record<string, string>) => void; assertTools: (argv: string[], env?: Record<string, string>) => void }> = [
    {
      mod: "../examples/claude-sdk/adapter.js",
      assertNoTools: (argv) => assert.ok(joinedHas(argv, "--tools", ""), "claude --tools ''"),
      assertTools: (argv) => assert.ok(argv.includes("--dangerously-skip-permissions") && !argv.includes("--tools"), "claude tools on"),
    },
    {
      mod: "../examples/openclaude/adapter.js",
      assertNoTools: (argv) => assert.ok(joinedHas(argv, "--tools", ""), "openclaude --tools ''"),
      assertTools: (argv) => assert.ok(argv.includes("--dangerously-skip-permissions") && !argv.includes("--tools"), "openclaude tools on"),
    },
    {
      mod: "../examples/codex-sdk/adapter.js",
      provider: "openai",
      assertNoTools: (argv) => {
        assert.ok(joinedHas(argv, "-s", "read-only"), "codex read-only sandbox");
        assert.ok(argv.includes("features.shell_tool=false"), "codex shell_tool=false");
        assert.ok(argv.includes('web_search="disabled"'), "codex web_search disabled");
        assert.ok(!argv.includes("--dangerously-bypass-approvals-and-sandbox"), "codex not bypassed");
      },
      assertTools: (argv) => {
        assert.ok(argv.includes("--dangerously-bypass-approvals-and-sandbox"), "codex tools on");
        assert.ok(!argv.includes("features.shell_tool=false"), "codex shell tool present");
      },
    },
    {
      mod: "../examples/pi/adapter.js",
      assertNoTools: (argv) => assert.ok(argv.includes("--no-tools"), "pi --no-tools"),
      assertTools: (argv) => assert.ok(!argv.includes("--no-tools"), "pi tools on"),
    },
    {
      mod: "../examples/codebase-daemon/adapter.js",
      assertNoTools: (argv) => assert.ok(argv.includes("--no-tools"), "daemon --no-tools positional"),
      assertTools: (argv) => assert.ok(!argv.includes("--no-tools"), "daemon tools on"),
    },
    {
      mod: "../examples/opencode/adapter.js",
      provider: "openai",
      assertNoTools: (_argv, env) => {
        assert.ok(env?.OPENCODE_CONFIG_CONTENT, "opencode no-tool env present");
        assert.deepEqual(JSON.parse(env!.OPENCODE_CONFIG_CONTENT), { tools: { "*": false, webfetch: true }, permission: { "*": "allow" } });
      },
      assertTools: (_argv, env) => {
        // Tools on: must auto-approve so `opencode run` doesn't block on a TTY-less
        // permission prompt the first time the agent calls a tool.
        assert.ok(env?.OPENCODE_CONFIG_CONTENT, "opencode tools-on env present");
        assert.deepEqual(JSON.parse(env!.OPENCODE_CONFIG_CONTENT), { permission: { "*": "allow" }, autoupdate: false, snapshot: false });
      },
    },
    {
      mod: "../examples/hermes/adapter.js",
      provider: "openrouter",
      assertNoTools: (_argv, env) => {
        assert.ok(env?.OPENCODE_CONFIG_CONTENT, "hermes no-tool env present");
        assert.deepEqual(JSON.parse(env!.OPENCODE_CONFIG_CONTENT), { tools: { "*": false, webfetch: true }, permission: { "*": "allow" } });
      },
      assertTools: (_argv, env) => {
        assert.ok(env?.OPENCODE_CONFIG_CONTENT, "hermes tools-on env present");
        assert.deepEqual(JSON.parse(env!.OPENCODE_CONFIG_CONTENT), { permission: { "*": "allow" }, autoupdate: false, snapshot: false });
      },
    },
  ];

  for (const c of cases) {
    const { spec }: any = await import(c.mod);
    assert.ok(spec, `${c.mod} exports spec`);
    assert.equal(typeof spec.buildArgv, "function", `${c.mod} has buildArgv`);
    assert.equal(spec.runSharedInfra, undefined, `${c.mod} has no provider-fallback runSharedInfra hook`);
    const input = { ...baseInput, provider: c.provider ?? baseInput.provider };
    const noToolArgv = spec.buildArgv({ ...input, toolsAllowed: false });
    const toolArgv = spec.buildArgv({ ...input, toolsAllowed: true });
    const noToolEnv = spec.buildEnv?.({ provider: input.provider, model: input.model, toolsAllowed: false });
    const toolEnv = spec.buildEnv?.({ provider: input.provider, model: input.model, toolsAllowed: true });
    c.assertNoTools(noToolArgv, noToolEnv);
    c.assertTools(toolArgv, toolEnv);
  }
});

function joinedHas(argv: string[], flag: string, value: string): boolean {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1] === value) return true;
  }
  return false;
}

test("shared-infra runtime streams the same harness stdout with separate message ids", async () => {
  const { createSharedInfraCapabilities } = await import("../src/index.js");
  const lines = [
    `${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg-a" } } })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg-b" } } })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Bye" } } })}\n`,
  ];
  const fakeSpawn = ((_bin: string, _args: string[]) => {
    async function* gen() { for (const l of lines) { yield Buffer.from(l); await new Promise((r) => setTimeout(r, 1)); } }
    const child: any = {
      stdout: gen(),
      stderr: { on() {} },
      exitCode: 0,
      kill() {},
      on(event: string, cb: () => void) { if (event === "close") setTimeout(cb, 0); return child; },
    };
    return child;
  }) as unknown as typeof spawn;

  const runtime = createSharedInfraCapabilities({ spawn: fakeSpawn });
  assert.equal(runtime.location, "shared-infra");
  const chunks: any[] = [];
  for await (const chunk of runtime.runHarness({ argv: ["claude", "-p", "hi"], outputMode: "claude-stream-json" })) chunks.push(chunk);
  assert.deepEqual(chunks.map((c) => [c.messageId, c.text]), [
    ["msg-a", "Hel"],
    ["msg-a", "lo"],
    ["msg-b", "Bye"],
  ]);
});

test("Box harness preserves native assistant message boundaries and token chunks", async () => {
  const snapshots = [
    `${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg-one" } } })}\n${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg-one" } } })}\n${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } })}\n${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } })}\n${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg-two" } } })}\n${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Sec" } } })}\n`,
    `${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg-one" } } })}\n${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } })}\n${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } })}\n${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg-two" } } })}\n${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Sec" } } })}\n${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ond" } } })}\n__CBA_EXIT__:0\n`,
  ];
  const box = new StreamingLogBoxClient(snapshots);
  const caps = createUserBoxCapabilities(box, "box-1", { pollMs: 1 });
  const chunks: any[] = [];
  for await (const chunk of caps.runHarness({ argv: ["claude", "-p", "hi"], outputMode: "claude-stream-json", pollMs: 1 })) chunks.push(chunk);
  assert.deepEqual(chunks.map((c) => [c.messageId, c.text]), [
    ["msg-one", "Hel"],
    ["msg-one", "lo"],
    ["msg-two", "Sec"],
    ["msg-two", "ond"],
  ]);
});

test("orchestrator streams Box chunks immediately instead of buffering whole message", async () => {
  const box = new FakeBoxClient();
  const harness: HarnessAdapter = {
    name: "chunked-box",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() { yield `Checking.`; },
    async *userBox() {
      yield { messageId: "first", text: "Hel" };
      await new Promise((r) => setTimeout(r, 15));
      yield { messageId: "first", text: "lo" };
      yield { messageId: "second", text: "Sec" };
      await new Promise((r) => setTimeout(r, 15));
      yield { messageId: "second", text: "ond" };
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 1 });
  const selection = { harness: "chunked-box", provider: "anthropic", model: "m-1" };
  const seen: any[] = [];
  const started = Date.now();
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run chunk proof", selection })) {
    if (e.type === "user-box.delta") seen.push({ text: e.text, messageId: e.messageId, at: Date.now() - started });
  }
  assert.deepEqual(seen.map((e) => [e.messageId, e.text]), [["first", "Hel"], ["first", "lo"], ["second", "Sec"], ["second", "ond"]]);
  assert.ok(seen[0].at < 15, `first chunk should be emitted before the full message is available, saw ${seen[0].at}ms`);
});

test("chatter after a Box request interrupts it; resending the request gets the answer", async () => {
  const box = new SlowUserBoxClient();
  box.delayMs = 5;
  let privateStarts = 0;
  const harness: HarnessAdapter = {
    name: "transcript-repro",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared({ message }) {
      if (/^hey.*ip/i.test(message)) {
        yield `I don't have a fixed IP address myself. If you want your Box public IP, say so.`;
        return;
      }
      yield `Still working on getting that for you — your Box is finishing provisioning.`;
    },
    async *userBox({ latestUserMessage }) {
      // The box runs every turn, but only the real request produces an answer;
      // the greeting and the shared chatter have nothing to add, so they <end>.
      if (!/yes do please/i.test(latestUserMessage)) { yield "<end>"; return; }
      privateStarts++;
      await new Promise((r) => setTimeout(r, 35));
      yield "The public IP is 135.181.150.124.";
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 1 });
  const selection = { harness: "transcript-repro", provider: "anthropic", model: "m-1" };

  const greeting: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "hey what's ur ip", selection })) greeting.push(e);
  assert.equal(greeting.filter((e) => e.type === "user-box.delta").length, 0, "initial shared answer does not leak a later Box answer");

  // Interrupt semantics: chatter sent while the request is in flight ABORTS the
  // request turn (newest message wins). The request answer may be cut — but
  // nothing double-answers, and RESENDING the request afterwards must work.
  const request: any[] = [];
  const chatter: any[] = [];
  const dr = (async () => { for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "yes do please", selection })) request.push(e); })();
  await waitFor(() => request.some((e) => e.type === "shared.delta"), 500);
  const dc = (async () => { for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "ok thanks", selection })) chatter.push(e); })();
  await Promise.all([dr, dc]);
  assert.equal(chatter.filter((e) => e.type === "user-box.delta").length, 0, "chatter itself adds no private answer (<end>)");

  const resend: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "yes do please", selection })) resend.push(e);
  const answers = [...request, ...chatter, ...resend].filter((e) => e.type === "user-box.delta").map((e) => e.text).join("");
  assert.match(answers, /The public IP is 135\.181\.150\.124\./, "the request is answered (by the original round or the resend)");
  assert.ok(privateStarts <= 2 && privateStarts >= 1, "the box request ran, never duplicated within one turn");
});

// A spawn stub that streams the given stdout lines then closes. Optionally
// records kill signals so abort behavior can be asserted.
function fakeSpawnLines(lines: string[], hooks: { onKill?: (signal?: string) => void; hang?: boolean } = {}): typeof spawn {
  return ((_bin: string, _args: string[]) => {
    let release: (() => void) | undefined;
    const killed = new Promise<void>((r) => { release = r; });
    async function* gen() {
      for (const l of lines) { yield Buffer.from(l); await new Promise((r) => setTimeout(r, 1)); }
      if (hooks.hang) await killed; // block until killed, simulating a long-running harness
    }
    const child: any = {
      stdout: gen(),
      stderr: { on() {} },
      exitCode: null,
      kill(signal?: string) { hooks.onKill?.(signal); this.exitCode = 0; release?.(); return true; },
      on(event: string, cb: () => void) { if (event === "close") setTimeout(cb, 0); return child; },
    };
    return child;
  }) as unknown as typeof spawn;
}

test("session id is extracted once per harness output mode and reported via onSessionId", async () => {
  const { createSharedInfraCapabilities } = await import("../src/index.js");
  const cases: Array<{ mode: string; lines: string[]; expected: string }> = [
    {
      mode: "claude-stream-json",
      // claude emits its assigned/echoed session id on the system init + result events.
      lines: [
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-sess-1", tools: [] })}\n`,
        `${JSON.stringify({ type: "result", session_id: "claude-sess-1", result: "hi" })}\n`,
      ],
      expected: "claude-sess-1",
    },
    {
      mode: "codex-json",
      lines: [
        `${JSON.stringify({ type: "thread.started", thread_id: "codex-thread-9" })}\n`,
        `${JSON.stringify({ type: "item.delta", delta: "hello" })}\n`,
      ],
      expected: "codex-thread-9",
    },
    {
      mode: "opencode-json",
      lines: [
        `${JSON.stringify({ type: "message_update", sessionID: "ses_abc", assistantMessageEvent: { type: "text_delta", delta: "hi" } })}\n`,
      ],
      expected: "ses_abc",
    },
    {
      mode: "pi-json",
      lines: [
        `${JSON.stringify({ type: "session", id: "pi-sess-77" })}\n`,
        `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } })}\n`,
      ],
      expected: "pi-sess-77",
    },
  ];
  for (const c of cases) {
    const ids: string[] = [];
    const runtime = createSharedInfraCapabilities({ spawn: fakeSpawnLines(c.lines) });
    for await (const _ of runtime.runHarness({ argv: ["bin", "-p", "hi"], outputMode: c.mode as any, onSessionId: (id) => ids.push(id) })) { /* drain */ }
    assert.deepEqual(ids, [c.expected], `${c.mode} reports its session id exactly once`);
  }
});

test("each adapter renders its native resume flags from sessionId/resumeSessionId", async () => {
  const base = {
    prompt: "<latest-user-request>hi</latest-user-request>",
    model: "m-1",
    provider: "anthropic",
    cwd: "/tmp/consumer-agent-test-xyz",
    systemInstructionPath: "/tmp/consumer-agent-test-xyz/CONSUMER_AGENT_SYSTEM.md",
    toolsAllowed: true,
  };
  type Check = { mod: string; strategy: "assign" | "capture"; provider?: string; assertAssign?: (argv: string[]) => void; assertResume: (argv: string[]) => void };
  const checks: Check[] = [
    {
      mod: "../examples/claude-sdk/adapter.js",
      strategy: "assign",
      assertAssign: (a) => assert.ok(joinedHas(a, "--session-id", "SID"), "claude assigns --session-id"),
      assertResume: (a) => assert.ok(joinedHas(a, "-r", "RID") && !a.includes("--session-id"), "claude resumes with -r"),
    },
    {
      mod: "../examples/openclaude/adapter.js",
      strategy: "assign",
      assertAssign: (a) => assert.ok(joinedHas(a, "--session-id", "SID"), "openclaude assigns --session-id"),
      assertResume: (a) => assert.ok(joinedHas(a, "-r", "RID") && !a.includes("--session-id"), "openclaude resumes with -r"),
    },
    {
      mod: "../examples/codex-sdk/adapter.js",
      strategy: "capture",
      provider: "openai",
      assertResume: (a) => {
        assert.deepEqual(a.slice(0, 4), ["codex", "exec", "resume", "RID"], "codex resumes via exec resume <id>");
        assert.ok(!a.includes("-s"), "codex resume does not pass -s (rejected by resume)");
        assert.ok(joinedHas(a, "-c", 'sandbox_mode="danger-full-access"'), "codex resume sets sandbox via -c");
      },
    },
    {
      mod: "../examples/pi/adapter.js",
      strategy: "capture",
      assertResume: (a) => assert.ok(joinedHas(a, "--session", "RID"), "pi resumes with --session"),
    },
    {
      mod: "../examples/opencode/adapter.js",
      strategy: "capture",
      provider: "openai",
      assertResume: (a) => assert.ok(joinedHas(a, "-s", "RID"), "opencode resumes with -s"),
    },
    {
      mod: "../examples/hermes/adapter.js",
      strategy: "capture",
      provider: "openrouter",
      assertResume: (a) => assert.ok(joinedHas(a, "-s", "RID"), "hermes resumes with -s"),
    },
    {
      mod: "../examples/codebase-daemon/adapter.js",
      strategy: "assign",
      assertAssign: (a) => assert.ok(a.join(" ").includes("--session-id SID"), "daemon assigns --session-id positional"),
      assertResume: (a) => assert.ok(a.join(" ").includes("--resume RID"), "daemon resumes with --resume positional"),
    },
  ];
  for (const c of checks) {
    const { spec }: any = await import(c.mod);
    assert.equal(spec.sessionStrategy, c.strategy, `${c.mod} declares ${c.strategy} strategy`);
    const input = { ...base, provider: c.provider ?? base.provider };
    if (c.assertAssign) c.assertAssign(spec.buildArgv({ ...input, sessionId: "SID" }));
    c.assertResume(spec.buildArgv({ ...input, resumeSessionId: "RID" }));
    // No session flags when neither id is present (preserves the no-session default).
    const bare = spec.buildArgv(input);
    assert.ok(!bare.includes("-r") && !bare.includes("--session") && !bare.join(" ").includes("--session-id") && !bare.join(" ").includes("--resume") && !(bare[2] === "resume"), `${c.mod} adds no session flags when ids absent`);
  }
});

test("a box-bound turn whose box agent has not settled never auto-stops the box", async () => {
  // Reproduces the reported bug: a second tool message arrives while the first
  // private round is still active. The second turn cannot run its own Box round
  // (it routes to the shared bridge "I'm looking into it"), but the Box is
  // billable. The OLD gate armed the idle auto-stop off that shared completion
  // and killed the Box out from under the still-pending first answer. The Box
  // may only auto-stop once the agent ON the box has settled — never off a
  // shared bridge.
  const box = new FakeBoxClient();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => { releaseFirst = r; });
  const harness: HarnessAdapter = {
    name: "gated",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() {
      yield `I’m looking into it.`;
    },
    async *userBox() {
      await firstGate; // hold the first private round open so the second turn is blocked behind it
      yield "first box answer";
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 1 });
  const selection = { harness: "gated", provider: "anthropic", model: "m-1" };

  const first: any[] = [];
  const second: any[] = [];
  const g1 = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run one", selection });
  const d1 = (async () => { for await (const e of g1) first.push(e); })();
  // Wait until the first round is active and the Box is billing.
  await waitFor(() => first.some((e) => e.type === "billing.start"), 200);

  // Fire the second tool turn while the first round is still active/unsettled.
  // It queues its OWN round behind the box lock (never dropped, never duplicated).
  const d2 = (async () => { for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "run two", selection })) second.push(e); })();
  await waitFor(() => second.some((e) => e.type === "shared.delta"), 500);
  await new Promise((r) => setTimeout(r, 30));

  // While the NEWEST turn's round is unsettled, NOTHING may stop the box. (The
  // first round was interrupted by the second message — its output is cut, but
  // the box must survive for the newest round.)
  assert.ok(![...first, ...second].some((e) => e.type === "billing.stop"), "no stream stops the still-needed Box while the newest round is unsettled");
  assert.ok(![...first, ...second].some((e) => e.type === "autostop.timer" && (e.phase === "started" || e.phase === "stopping")), "no idle auto-stop is armed while the newest round is unsettled");
  assert.notEqual((await box.get([...box.boxes.keys()][0]!)).state, "archived", "Box is still running under the pending round");

  // Release the gate: the NEWEST round answers; only after everything settles
  // may the box auto-stop. The interrupted first turn must not produce a second
  // visible answer.
  releaseFirst();
  await Promise.all([d1, d2]);
  assert.ok(second.some((e) => e.type === "user-box.delta" && /first box answer/.test(e.text)), "the newest message's round answers");
  assert.ok([...first, ...second].some((e) => e.type === "billing.stop"), "with the newest round settled and all streams ended, the Box auto-stops instead of leaking");
});

test("a warm box small-talk follow-up settles via the box <end> sentinel and auto-stops", async () => {
  // The flip side of the gate: the auto-stop must still fire for legitimately
  // idle boxes so warm boxes don't leak after small talk. A greeting follow-up
  // on a WARM box takes the direct path (the box is already ready), so the box
  // agent itself runs and emits the hidden <end> sentinel. That box-agent
  // settlement — not any shared completion — is what arms the idle countdown.
  const box = new FakeBoxClient();
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [probeHarness("alpha")], readinessPollMs: 1, autoStopIdleMs: 20 });

  // Turn 1: tool turn answers and leaves the box warm (idle window 20ms).
  const first: any[] = [];
  const g1 = orchestrator.runTurn({ userId: "u", conversationId: "c", message: "create one", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } });
  const d1 = (async () => { for await (const e of g1) first.push(e); })();
  await waitFor(() => first.some((e) => e.type === "turn.done"), 200);
  const boxId = first.find((e) => e.type === "turn.done")?.boxId;
  assert.equal((await box.get(boxId)).state, "idle", "box is warm after the tool turn");

  // Turn 2: a greeting (needsPrivate:false) within the idle window. The warm box
  // is resumed directly and the box agent answers with the hidden <end>.
  const second: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "hey thanks", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) second.push(e);
  await d1;

  assert.ok(second.some((e) => e.type === "trace" && e.stage === "user-box.response.end"), "the box agent settles this turn by emitting the hidden <end> sentinel");
  assert.equal(second.filter((e) => e.type === "user-box.delta").length, 0, "the <end> sentinel produces no visible box answer");
  assert.ok(second.some((e) => e.type === "autostop.timer" && e.phase === "started"), "box-agent settlement (not a shared completion) re-arms the idle countdown");
  assert.ok(second.some((e) => e.type === "billing.stop"), "the warm box is stopped after the settled follow-up goes idle");
  assert.equal((await box.get(boxId)).state, "archived", "warm box is archived, not leaked");
});

test("box harness loop only settles at the native completion marker, never on tool-call inactivity", async () => {
  // A long-running prompt: the box agent issues tool calls across several polls
  // with NO final text and NO exit marker. The loop must keep running (process
  // alive) and must NOT report completion until the native stream actually ends.
  const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "find / -name secret", description: "search filesystem" } }] } };
  const working = `${JSON.stringify(toolUse)}\n`;
  const snapshots = [
    working,            // working, no answer yet
    working,            // still working
    working,            // still working — a few seconds of no visible text
    `${working}${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Found it" } } })}\n${JSON.stringify({ type: "result", result: "Found it" })}\n__CBA_EXIT__:0\n`,
  ];
  const box = new StreamingLogBoxClient(snapshots);
  const toolEvents: any[] = [];
  const completions: any[] = [];
  const caps = createUserBoxCapabilities(box, "box-1", { pollMs: 1, onHarnessEvent: (e) => toolEvents.push(e) });
  const chunks: any[] = [];
  for await (const chunk of caps.runHarness({ argv: ["claude", "-p", "hi"], outputMode: "claude-stream-json", pollMs: 1, onComplete: (info) => completions.push(info) })) chunks.push(chunk);
  assert.deepEqual(chunks.map((c: any) => c.text), ["Found it"], "final answer is streamed only once, after tool work");
  assert.ok(toolEvents.some((e) => e.phase === "tool_use"), "tool activity was observed during the loop");
  assert.deepEqual(completions.length, 1, "completion is reported exactly once");
  assert.equal(completions[0].reason, "completed", "loop settles via the native exit marker, not inactivity");
  assert.equal(completions[0].exitCode, 0);
  assert.equal(completions[0].sawText, true);
});

test("box harness reports the long safety timeout (not a short inactivity stop) when the agent never finishes", async () => {
  // The process stays alive and never writes an exit marker. With a tiny timeoutMs
  // we simulate the hours-scale safety backstop firing. It must be reported as
  // "timeout" — a distinct, explicit reason — not silently treated as a clean end.
  const working = `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "thinking…" } } })}\n`;
  const box = new StreamingLogBoxClient([working]); // every poll returns the same in-progress log, no marker
  const completions: any[] = [];
  const caps = createUserBoxCapabilities(box, "box-1", { pollMs: 1 });
  const chunks: any[] = [];
  for await (const chunk of caps.runHarness({ argv: ["claude", "-p", "hi"], outputMode: "claude-stream-json", pollMs: 1, timeoutMs: 30, onComplete: (info) => completions.push(info) })) chunks.push(chunk);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].reason, "timeout", "the safety backstop is an explicit timeout, distinct from a clean completion");
});

test("a long tool-running box prompt surfaces tool traces and only auto-stops after the agent settles", async () => {
  // End-to-end through the orchestrator: the box agent runs tools for several
  // polls, then answers and the native stream ends. Tool activity must show up as
  // traces, and the idle auto-stop must arm ONLY after the settled final answer.
  const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la /", description: "inspect filesystem" } }] } };
  const working = `${JSON.stringify(toolUse)}\n`;
  const answer = "Your filesystem has /home and /etc.";
  const snapshots = [
    working,
    working,
    `${working}${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: answer } } })}\n${JSON.stringify({ type: "result", result: answer })}\n__CBA_EXIT__:0\n`,
  ];
  const box = new StreamingLogBoxClient(snapshots);
  const harness: HarnessAdapter = {
    name: "cli",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() { yield `On it.`; },
    async *userBox(ctx) {
      yield* ctx.capabilities.runHarness({
        argv: ["claude", "-p", "hi"],
        outputMode: "claude-stream-json",
        pollMs: 1,
        ...(ctx.onComplete ? { onComplete: ctx.onComplete } : {}),
      });
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 5 });
  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "whats on my filesystem", selection: { harness: "cli", provider: "anthropic", model: "m-1" } })) events.push(e);

  assert.ok(events.some((e) => e.type === "trace" && e.stage === "box.tool.use"), "tool activity is visible as a trace");
  assert.ok(events.some((e) => e.type === "user-box.delta" && /filesystem has/.test(e.text)), "the box agent's final answer is surfaced");
  const done = events.find((e) => e.type === "turn.done" && e.boxId);
  assert.equal(done?.settled, true, "a cleanly-completed loop is marked settled");
  assert.ok(events.some((e) => e.type === "autostop.timer" && e.phase === "started"), "settled answer arms the idle countdown");
  assert.ok(events.some((e) => e.type === "billing.stop"), "box auto-stops only after the settled answer goes idle");
});

test("filesystem question answered when Claude final text arrives as assistant snapshot", async () => {
  // Mirrors the failing run shape: exec/tool activity appears, but there are no
  // `stream_event.content_block_delta` text deltas. The answer is present in the
  // native Claude assistant snapshot and must be surfaced as user-box.delta.
  const toolUse = { type: "assistant", message: { id: "msg-tool", content: [{ type: "tool_use", name: "Bash", input: { command: "find /home/user -maxdepth 1 -type f", description: "list files" } }] } };
  const toolResult = { type: "user", tool_use_result: { stdout: "/home/user/package.json\n/home/user/README.md\n", stderr: "", is_error: false } };
  const answer = "The filesystem contains package.json and README.md at /home/user.";
  const snapshots = [
    `${JSON.stringify(toolUse)}\n`,
    `${JSON.stringify(toolUse)}\n${JSON.stringify(toolResult)}\n`,
    `${JSON.stringify(toolUse)}\n${JSON.stringify(toolResult)}\n${JSON.stringify({ type: "assistant", message: { id: "msg-answer", content: [{ type: "text", text: answer }] } })}\n${JSON.stringify({ type: "result", session_id: "s-1" })}\n__CBA_EXIT__:0\n`,
  ];
  const box = new StreamingLogBoxClient(snapshots);
  const harness: HarnessAdapter = {
    name: "claude-real-shape",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() { yield `On it.`; },
    async *userBox(ctx) {
      yield* ctx.capabilities.runHarness({
        argv: ["claude", "-p", "what is in your filesystem"],
        outputMode: "claude-stream-json",
        pollMs: 1,
        ...(ctx.onComplete ? { onComplete: ctx.onComplete } : {}),
      });
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 5 });
  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "what is in your filesystem", selection: { harness: "claude-real-shape", provider: "anthropic", model: "m-1" } })) events.push(e);

  assert.ok(events.some((e) => e.type === "trace" && e.stage === "box.tool.use"), "tool activity is still traced");
  assert.equal(events.filter((e) => e.type === "user-box.delta").map((e) => e.text).join(""), answer, "assistant snapshot text is surfaced as the private answer");
  assert.equal(events.find((e) => e.type === "turn.done" && e.boxId)?.settled, true, "the real answer settles the turn");
  assert.ok(events.some((e) => e.type === "autostop.timer" && e.phase === "started"), "idle countdown starts only after the surfaced answer");
});

test("a box turn whose harness loop is interrupted (aborted) does not arm the idle auto-stop", async () => {
  // The dangerous case: the loop ended WITHOUT a clean completion (abort). Even
  // though the box is billable, an unsettled loop must never start the countdown —
  // the machine must not be stopped out from under a prompt that never settled.
  const box = new FakeBoxClient();
  const harness: HarnessAdapter = {
    name: "abrt",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() { yield `On it.`; },
    async *userBox(ctx) {
      yield "partial working note";
      ctx.onComplete?.({ reason: "aborted", sawText: true });
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [harness], readinessPollMs: 1, autoStopIdleMs: 5 });
  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "do a long thing", selection: { harness: "abrt", provider: "anthropic", model: "m-1" } })) events.push(e);

  const done = events.find((e) => e.type === "turn.done" && e.boxId);
  assert.equal(done?.settled, false, "an aborted loop is not a settlement");
  assert.ok(events.some((e) => e.type === "trace" && e.stage === "box.runtime.unsettled"), "the unsettled loop is traced");
  assert.ok(!events.some((e) => e.type === "autostop.timer" && e.phase === "started"), "aborted loop does not arm the idle countdown");
  assert.ok(!events.some((e) => e.type === "billing.stop"), "aborted loop does not auto-stop the box");
});

test("aborting a shared-infra harness run interrupts the process (SIGINT then SIGKILL)", async () => {
  const { createSharedInfraCapabilities } = await import("../src/index.js");
  const signals: string[] = [];
  const controller = new AbortController();
  const runtime = createSharedInfraCapabilities({
    spawn: fakeSpawnLines(
      [`${JSON.stringify({ type: "result", session_id: "s-1", result: "partial" })}\n`],
      { hang: true, onKill: (sig) => signals.push(String(sig)) },
    ),
  });
  const drained: any[] = [];
  const run = (async () => {
    for await (const chunk of runtime.runHarness({ argv: ["bin", "-p", "hi"], outputMode: "claude-stream-json", signal: controller.signal })) drained.push(chunk);
  })();
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await run;
  assert.ok(signals.includes("SIGINT"), "abort sends SIGINT to the harness process");
});

test("box run that ends with no answer and no <end> fails loudly, never silently", async () => {
  const box = new FakeBoxClient();
  const silent: HarnessAdapter = {
    name: "silent-fail",
    requiredEnv: [],
    models: [{ provider: "anthropic", model: "m-1" }],
    async *shared() { yield "I’m checking that now."; },
    // Emulates a harness whose provider call errored: the loop ends cleanly but
    // yields no visible text and no <end> sentinel.
    async *userBox({ onComplete }) {
      onComplete?.({ reason: "completed", exitCode: 1, sawText: false, diagnostic: "Error: No endpoints found that support tool use." });
    },
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({ box, harnesses: [silent], readinessPollMs: 1, autoStopIdleMs: 1 });
  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "what's your ip?", selection: { harness: "silent-fail", provider: "anthropic", model: "m-1" } })) events.push(e);
  const blocked = events.find((e) => e.type === "turn.blocked" && e.stage === "box.runtime.no-answer");
  assert.ok(blocked, "no-answer box run must surface a loud turn.blocked");
  assert.match(blocked.message, /exit=1/, "blocker carries the harness exit code");
  assert.match(blocked.message, /No endpoints found/, "blocker carries the harness output tail");
  assert.equal(events.filter((e) => e.type === "user-box.delta").length, 0, "nothing was fabricated");
  assert.ok(events.some((e) => e.type === "billing.stop"), "failed round still releases the box");
});

test("reaper orphan sweep stops running consumer-agent boxes this process is not billing", async () => {
  const box = new FakeBoxClient();
  box.boxes.set("box-orphan", { id: "box-orphan", name: "consumer-agent-user-ghost", state: "running" } as any);
  box.boxes.set("box-foreign", { id: "box-foreign", name: "someone-elses-box", state: "running" } as any);
  const orchestrator = new ConsumerBoxAgentOrchestrator({
    box,
    harnesses: [probeHarness("alpha")],
    readinessPollMs: 1,
    autoStopIdleMs: 1,
    idleReaperIntervalMs: 5,
    orphanBoxName: (name) => name.startsWith("consumer-agent-"),
  });
  try {
    // First sighting arms the grace window; a later sweep stops the orphan.
    await waitFor(async () => (await box.get("box-orphan")).state === "archived", 2000);
    assert.equal((await box.get("box-foreign")).state, "running", "boxes with foreign names are never touched");
  } finally {
    orchestrator.dispose();
  }
});

test("fresh user box is forked from the pre-installed template when its snapshot exists", async () => {
  const box = new FakeBoxClient() as any;
  box.boxes.set("box-template", { id: "box-template", name: "tpl", state: "archived", snapshotAvailable: true } as any);
  let forkedFrom: string | undefined;
  box.fork = async (boxId: string) => {
    forkedFrom = boxId;
    const forked = { id: "box-forked", state: "idle", name: "" };
    box.boxes.set(forked.id, forked);
    return forked;
  };
  const orchestrator = new ConsumerBoxAgentOrchestrator({
    box,
    harnesses: [probeHarness("alpha")],
    readinessPollMs: 1,
    autoStopIdleMs: 1,
    userBoxTemplate: { name: "tpl", installCmd: "echo install" },
  });
  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "what's your CPU count", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) events.push(e);
  assert.equal(forkedFrom, "box-template", "new box is forked from the template snapshot");
  assert.equal(events.find((e) => e.type === "turn.done")?.boxId, "box-forked", "the forked box serves the turn");
  assert.ok(events.some((e) => e.type === "lifecycle" && e.state === "forking"), "boot surfaces honestly as forking");
  const renamed = await box.get("box-forked");
  assert.match(String(renamed.name), /consumer-agent-user-u/, "forked box is renamed to the user box name");
});

test("missing template kicks off a background build and this boot falls back to create", async () => {
  const box = new FakeBoxClient() as any;
  const forkCalls: string[] = [];
  box.fork = async (boxId: string) => { forkCalls.push(boxId); throw new Error("no snapshot"); };
  const orchestrator = new ConsumerBoxAgentOrchestrator({
    box,
    harnesses: [probeHarness("alpha")],
    readinessPollMs: 1,
    autoStopIdleMs: 1,
    userBoxTemplate: { name: "tpl-being-built", installCmd: "echo install" },
  });
  const events: any[] = [];
  for await (const e of orchestrator.runTurn({ userId: "u", conversationId: "c", message: "what's your CPU count", selection: { harness: "alpha", provider: "anthropic", model: "m-1" } })) events.push(e);
  assert.equal(forkCalls.length, 0, "no fork without a template snapshot");
  assert.ok(events.some((e) => e.type === "user-box.delta"), "legacy create path still answers");
  await waitFor(async () => [...box.boxes.values()].some((b: any) => b.name === "tpl-being-built"), 2000);
  const tpl = [...box.boxes.values()].find((b: any) => b.name === "tpl-being-built") as any;
  assert.ok(box.commands.some((c: string) => c === "echo install"), "background build ran the template installCmd");
  await waitFor(async () => (await box.get(tpl.id)).state === "archived", 2000);
});
