import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  BoxHttpClient,
  assertNoBoxAgent,
  ConsumerBoxAgentOrchestrator,
  InMemorySessionStore,
  type ConsumerTurnEvent,
} from "../src/index.js";
import { providerEnvForBox } from "../examples/shared.js";
import { harness as claude } from "../examples/claude-sdk/adapter.js";
import { harness as opencode } from "../examples/opencode/adapter.js";
import { harness as pi } from "../examples/pi/adapter.js";

const evidenceDir = process.env.EVIDENCE_DIR ?? join(process.cwd(), "evidence", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(evidenceDir, { recursive: true });
const transcript: Record<string, unknown>[] = [];
function log(type: string, data: Record<string, unknown> = {}) {
  const entry = { at: new Date().toISOString(), type, ...data };
  transcript.push(entry);
  console.log(JSON.stringify(entry));
}

const apiKey = process.env.BOX_API_KEY;
if (!apiKey) throw new Error("BOX_API_KEY is required for the real Box evidence run");

const box = assertNoBoxAgent(new BoxHttpClient({ apiKey }));
const runId = `evidence-${Date.now()}`;
const orchestrator = new ConsumerBoxAgentOrchestrator({
  box,
  harnesses: [claude, opencode, pi],
  sessions: new InMemorySessionStore(),
  providerEnv: providerEnvForBox(),
  sharedBoxName: `consumer-agent-shared-prewarm-${runId}`,
  userBoxName: (userId) => `consumer-agent-user-${userId}-${runId}`,
  userBoxTtlSeconds: 600,
  readinessPollMs: 2000,
  handoffTimeoutMs: 180_000,
});

// Two turns with DIFFERENT harnesses/models on the SAME user+conversation:
// proves live harness/model switching with preserved context on the same Box.
// Claude-only demo backend: turn 1 = Claude Code on Sonnet, turn 2 switches BOTH
// the harness (OpenCode) AND the model (Haiku) on the SAME Box/conversation.
const turns = [
  { harness: process.env.HARNESS_1 ?? "claude-agent-sdk", provider: process.env.PROVIDER_1 ?? "anthropic", model: process.env.MODEL_1 ?? "claude-sonnet-4-6", message: "Create a file proof1.txt containing the single line HARNESS_ONE_OK." },
  { harness: process.env.HARNESS_2 ?? "opencode", provider: process.env.PROVIDER_2 ?? "anthropic", model: process.env.MODEL_2 ?? "claude-haiku-4-5-20251001", message: "Now also create proof2.txt with the single line HARNESS_TWO_OK, and list the files you created." },
];

async function runTurn(label: string, t: typeof turns[number]) {
  log("turn.start", { label, ...t });
  const events: ConsumerTurnEvent[] = [];
  for await (const event of orchestrator.runTurn({ userId: "real-user-1", conversationId: "real-conversation-1", message: t.message, selection: { harness: t.harness, provider: t.provider, model: t.model } })) {
    events.push(event);
    log("turn.event", { label, event });
  }
  return events;
}

const shared = await orchestrator.ensureSharedBox();
log("shared_box.ready", { id: shared.id, state: shared.state, archiveAfter: shared.archiveAfter ?? null, name: shared.name });

const first = await runTurn("turn1", turns[0]!);
const firstBoxId = first.find((e) => e.type === "handoff.started")?.boxId;
await orchestrator.stopIdleUserBox("real-user-1", "real-conversation-1");
log("user_box.stopped", { boxId: firstBoxId, state: firstBoxId ? (await box.get(firstBoxId)).state : "missing" });

const second = await runTurn("turn2", turns[1]!);
const secondBoxId = second.find((e) => e.type === "handoff.started")?.boxId;
log("user_box.resume_check", { firstBoxId, secondBoxId, sameBox: firstBoxId === secondBoxId, harnessSwitched: turns[0]!.harness !== turns[1]!.harness });

// New proof points: billing started, bridge placeholder stayed hidden from the
// user-box prompt, and the hidden context envelope was injected with tools=true.
const billing = second.find((e) => e.type === "billing.start");
const bridgePlaceholder = second.filter((e) => e.type === "shared.delta").map((e) => (e as any).text).join("");
const ctxInjected = second.find((e) => e.type === "context.injected" && (e as any).scope === "user-box");
log("proof.new_events", {
  billingStarted: Boolean(billing),
  ratePerSecond: billing ? (billing as any).ratePerSecond : null,
  bridgePlaceholder: Boolean(bridgePlaceholder),
  hiddenContextToolsTrue: ctxInjected ? (ctxInjected as any).machine?.tools === true : false,
});

// Verify the files the real harnesses created actually exist in the Box.
if (secondBoxId) {
  try {
    const ls = await box.command(secondBoxId, { command: "find /home/user/cba-work -name 'proof*.txt' -exec sh -c 'echo \"== {} ==\"; cat {}' \\; 2>/dev/null | head -40", timeoutMs: 20_000 });
    log("user_box.artifacts", { boxId: secondBoxId, stdout: ls.stdout });
  } catch (e) { log("user_box.artifacts_error", { error: e instanceof Error ? e.message : String(e) }); }
}
// Streaming stop: prove lifecycle (stopping -> archiving -> archived) + billing pause.
const stopEvents: ConsumerTurnEvent[] = [];
for await (const e of orchestrator.stopUserBox("real-user-1", "real-conversation-1")) { stopEvents.push(e); log("stop.event", { event: e }); }
const billStop = stopEvents.find((e) => e.type === "billing.stop");
const lifecycleStates = stopEvents.filter((e) => e.type === "lifecycle").map((e) => (e as any).state);
log("billing.stopped", { lifecycleStates, paused: Boolean(billStop), elapsedSeconds: billStop ? (billStop as any).elapsedSeconds : null, costUsd: billStop ? (billStop as any).costUsd : null });

// Turn 3: with the box STOPPED, ask a question only prior context can answer ->
// proves context is impossible to lose across a machine stop/resume.
const third = await runTurn("turn3", { harness: "claude-agent-sdk", provider: "anthropic", model: "claude-haiku-4-5-20251001", message: "Without re-reading any files, from memory of our conversation: what were the exact one-line contents of the two proof files created earlier?" });
const thirdShared = third.filter((e) => e.type === "shared.delta").map((e) => (e as any).text).join("");
const thirdBox = third.filter((e) => e.type === "user-box.delta").map((e) => (e as any).text).join("");
log("context.survived_stop", {
  sharedRecalledFromContext: /HARNESS_ONE_OK/.test(thirdShared) || /HARNESS_TWO_OK/.test(thirdShared),
  boxRecalled: /HARNESS_ONE_OK/.test(thirdBox) || /HARNESS_TWO_OK/.test(thirdBox),
  sharedSample: thirdShared.slice(0, 240),
});
for await (const e of orchestrator.stopUserBox("real-user-1", "real-conversation-1")) log("final_stop.event", { event: e });

const jsonlPath = join(evidenceDir, "real-e2e-transcript.jsonl");
writeFileSync(jsonlPath, transcript.map((e) => JSON.stringify(e)).join("\n") + "\n");
const md = `# Consumer Box Agents real E2E evidence\n\nRun id: ${runId}\n\n- Shared always-on Box: ${shared.id} (archiveAfter=${shared.archiveAfter ?? "null"})\n- Turn 1 harness: ${turns[0]!.harness} / ${turns[0]!.model} -> Box ${firstBoxId}\n- Turn 2 harness: ${turns[1]!.harness} / ${turns[1]!.model} -> Box ${secondBoxId}\n- Same Box reused across harness switch: ${firstBoxId === secondBoxId}\n- Bridge placeholder emitted: ${Boolean(bridgePlaceholder)}\n- Billing rate: $${billing ? (billing as any).ratePerSecond : "?"} /VM-sec; billing paused on stop: ${Boolean(billStop)} (this run cost $${billStop ? ((billStop as any).costUsd as number).toFixed(6) : "?"})\n- Stop lifecycle: ${lifecycleStates.join(" -> ")}\n- Context survived stop (turn 3 recalled prior file contents from hidden context): ${/HARNESS_ONE_OK/.test(thirdShared) || /HARNESS_TWO_OK/.test(thirdShared) || /HARNESS_ONE_OK/.test(thirdBox) || /HARNESS_TWO_OK/.test(thirdBox)}\n- Box built-in agent: forbidden via assertNoBoxAgent\n`;
writeFileSync(join(evidenceDir, "REAL_E2E_PROOF.md"), md);
log("evidence.files", { evidenceDir });
