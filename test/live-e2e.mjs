// Live end-to-end measurement of the optibox engine against a real Box backend.
// usage: DATABASE_URL=... BOX_API_KEY=... BOX_API_URL=https://<host>/api/box/v1 ANTHROPIC_API_KEY=... node test/live-e2e.mjs
// Runs one user through: cold turn (shared bridge + box answer), warm follow-up with memory,
// harness switch mid-conversation, a tool-using turn, an interrupt, stop + resume with memory.
// Prints a table of timings and outcomes; exit code 1 when any step fails.
import { openDb } from "../dist/src/db.js";
import { Engine } from "../dist/src/engine.js";
import { BoxHttpClient } from "../dist/src/boxHttpClient.js";

const need = (k) => { if (!process.env[k]) { console.error(`${k} required`); process.exit(2); } return process.env[k]; };
const db = await openDb(need("DATABASE_URL"));
const providerEnv = {};
for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) if (process.env[k]) providerEnv[k] = process.env[k];
const engine = new Engine({
  db, box: new BoxHttpClient({ apiKey: need("BOX_API_KEY") }), instanceId: "live-e2e", credHash: "e2e" + Date.now().toString(36).slice(-4),
  providerEnv, sharedModel: process.env.SHARED_MODEL ?? (providerEnv.OPENROUTER_API_KEY ? "openrouter/anthropic/claude-haiku-4.5" : providerEnv.ANTHROPIC_API_KEY ? "anthropic/claude-haiku-4-5" : "openai/gpt-4.1-mini"),
  autoStopIdleMs: 60_000, sweepIntervalMs: 0, directMinWarmMs: 15_000,
});
const user = "e2e-user", conv = "e2e-conv";
const rows = [];
let failed = 0;
async function turn(name, message, selection, opts = {}) {
  const t0 = Date.now();
  // `text` is what the box streamed; `sharedText` what the bridge streamed. The user sees both, and
  // rule 6 lets the box add NOTHING when the bridge already answered in full, so a memory check
  // reads `visible`, never the box half alone.
  const stats = { name, sharedMs: null, boxMs: null, tools: 0, route: null, done: false, blocked: null, text: "", sharedText: "", lifecycle: [], get visible() { return this.sharedText + this.text; } };
  const run = engine.runTurn({ userId: user, conversationId: conv, message, selection });
  let interrupted = false;
  for await (const e of run) {
    if (e.type === "shared.delta") { if (stats.sharedMs === null) stats.sharedMs = Date.now() - t0; stats.sharedText += e.text; }
    if (e.type === "user-box.delta") { if (stats.boxMs === null) stats.boxMs = Date.now() - t0; stats.text += e.text; if (opts.interruptAfterText && !interrupted) { interrupted = true; engine.interrupt(e.turnId); } }
    if (e.type === "harness.tool" && e.phase === "tool_use") stats.tools++;
    if (e.type === "lifecycle") stats.lifecycle.push(e.state);
    if (e.type === "turn.done") { stats.done = true; stats.route = e.route; }
    if (e.type === "turn.blocked") stats.blocked = e.message.slice(0, 120);
    if (e.type === "trace" && e.stage === "turn.interrupted") stats.route = "interrupted";
  }
  stats.totalMs = Date.now() - t0;
  const ok = opts.check ? opts.check(stats) : stats.done && !stats.blocked;
  if (!ok) failed++;
  rows.push({ ...stats, ok });
  console.log(`${ok ? "ok " : "FAIL"} ${name}: shared ${stats.sharedMs ?? "-"}ms, box ${stats.boxMs ?? "-"}ms, total ${stats.totalMs}ms, tools ${stats.tools}, route ${stats.route}${stats.blocked ? ", blocked: " + stats.blocked : ""} :: ${stats.text.replace(/\s+/g, " ").slice(0, 90)}`);
  return stats;
}
const claude = { harness: "claude-code", provider: "anthropic", model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5" };
const pi = { harness: "pi", provider: "openai", model: process.env.PI_MODEL ?? "gpt-5.4-mini", reasoningEffort: "low" };
const codeword = "PLUM-" + Math.random().toString(36).slice(2, 6).toUpperCase();
try {
  await turn("cold: bridge + box (memory seed)", `Remember: my codeword is ${codeword}. Reply only OK.`, claude);
  await turn("warm follow-up: memory", "What is my codeword? Answer with the codeword only.", claude, { check: (s) => s.done && s.visible.includes(codeword) });
  await turn("harness switch keeps memory", "Which harness are you, and what is my codeword? One line.", pi, { check: (s) => s.done && s.visible.includes(codeword) });
  await turn("tool turn: shell fact", "Run `nproc` and reply with the number of cores only.", claude, { check: (s) => s.done && s.tools >= 1 && /\d/.test(s.text) });
  await turn("interrupt mid-answer", "Count slowly from 1 to 200, one number per line, and explain each.", claude, { interruptAfterText: true, check: (s) => s.route === "interrupted" && !s.blocked });
  await turn("after interrupt: still remembers", "What is my codeword? Codeword only.", claude, { check: (s) => s.done && s.visible.includes(codeword) });
  const t0 = Date.now();
  for await (const e of engine.stopUserBox(user, conv)) if (e.type === "lifecycle") rows.push({ name: `stop: ${e.state}`, totalMs: Date.now() - t0, ok: true });
  // A different sentence on purpose: the engine folds an identical message re-sent within 60 s into
  // the previous turn (no second box round), which is not what this step measures.
  await turn("resume from snapshot: memory survives stop", "We are back after the stop. What is my codeword? Codeword only.", claude, { check: (s) => s.done && s.visible.includes(codeword) && s.lifecycle.includes("resuming") });
} catch (e) {
  failed++;
  console.log("FAIL exception:", e instanceof Error ? e.message : String(e));
}
console.log("\n| step | shared first token | box first token | total | tools | ok |\n|---|---:|---:|---:|---:|:-:|");
for (const r of rows) console.log(`| ${r.name} | ${r.sharedMs ?? "-"} | ${r.boxMs ?? "-"} | ${r.totalMs} | ${r.tools ?? "-"} | ${r.ok ? "yes" : "NO"} |`);
const rt = await engine.userRuntimeStatus(user);
console.log(`\nbilled seconds ${rt.billedSecondsTotal.toFixed(0)}, box ${rt.boxId ?? "-"}`);
for await (const _ of engine.stopUserBox(user, conv)) void _;
engine.dispose();
await db.close();
process.exit(failed ? 1 : 0);
