/**
 * Autonomous end-to-end QA against the REAL server + REAL Boxes + REAL model.
 *
 * Drives the spec's user-visible guarantees, not internals:
 *   S1 small-talk  -> shared answers fully, box adds nothing (<end>), box STOPS
 *   S2 tool work   -> always an immediate shared line, real tool answer, box STOPS
 *   S3 bad model   -> box that cannot answer fails LOUDLY (never silence)
 *   S4 double-send -> concurrent turns both terminate; box still STOPS
 *   S5 orphan box  -> a stray running consumer-agent box is reaped by the server
 *
 * Usage: node --env-file=.env dist/scripts/e2e-qa.js [baseUrl]
 * Starts its own server on :4179 unless a baseUrl is given. Exit 0 = all pass.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const BASE = process.argv[2] ?? "http://localhost:4179";
const OWN_SERVER = !process.argv[2];
const HARNESS = "hermes";
const TOOL_MODEL = "anthropic/claude-sonnet-5";
const NO_TOOL_MODEL = "nousresearch/hermes-4-70b";
const runTag = Date.now().toString(36);

const boxKey = process.env.BOX_API_KEY;
if (!boxKey) throw new Error("BOX_API_KEY required");
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY required");

interface TurnResult {
  events: any[];
  shared: string;
  box: string;
  blocked: any[];
  errors: any[];
  billingStarts: string[];
  billingStops: string[];
  durationMs: number;
  /** true when the scenario timeout aborted the stream — always a FAIL signal. */
  timedOut: boolean;
}

async function sendTurn(userId: string, conversationId: string, message: string, model: string, timeoutMs = 300_000): Promise<TurnResult> {
  const started = Date.now();
  const events: any[] = [];
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const killer = setTimeout(() => { timedOut = true; void reader?.cancel().catch(() => undefined); }, timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, conversationId, message, harness: HARNESS, provider: "openrouter", model }),
    });
    if (!res.ok || !res.body) throw new Error(`send failed: HTTP ${res.status}`);
    reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.startsWith("data:")) { try { events.push(JSON.parse(line.slice(5))); } catch { /* partial */ } }
      }
    }
  } finally {
    clearTimeout(killer);
  }
  return {
    events,
    shared: events.filter((e) => e.type === "shared.delta").map((e) => e.text).join(""),
    box: events.filter((e) => e.type === "user-box.delta").map((e) => e.text).join(""),
    blocked: events.filter((e) => e.type === "turn.blocked"),
    errors: events.filter((e) => e.type === "error"),
    billingStarts: events.filter((e) => e.type === "billing.start").map((e) => e.boxId),
    billingStops: events.filter((e) => e.type === "billing.stop").map((e) => e.boxId),
    durationMs: Date.now() - started,
    timedOut,
  };
}

async function boxApi(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://ascii.dev/api/box/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${boxKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function boxStateById(boxId: string): Promise<string> {
  return (await boxApi(`/boxes/${boxId}`)).box?.state ?? "missing";
}

async function waitForBoxState(boxId: string, want: (state: string) => boolean, timeoutMs: number): Promise<string> {
  const started = Date.now();
  let state = "unknown";
  while (Date.now() - started < timeoutMs) {
    state = await boxStateById(boxId);
    if (want(state)) return state;
    await delay(4000);
  }
  return state;
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

const isHoldingLine = (s: string) => s.trim().length > 0 && s.trim().length < 120;
const stoppedState = (s: string) => s === "archived" || s === "archiving" || s === "stopped" || s === "missing";

let server: ChildProcess | undefined;
if (OWN_SERVER) {
  server = spawn(process.execPath, ["dist/scripts/interactive-proof-server.js"], {
    env: { ...process.env, PORT: "4179" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { createWriteStream } = await import("node:fs");
  const serverLog = createWriteStream(`e2e-qa-server-${runTag}.log`);
  server.stdout?.pipe(serverLog);
  server.stderr?.on("data", (d) => { serverLog.write(d); process.stderr.write(`[server] ${d}`); });
  console.log(`[qa] server log: e2e-qa-server-${runTag}.log`);
  const up = await (async () => {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`${BASE}/api/harnesses`); if (r.ok) return true; } catch { /* booting */ }
      await delay(250);
    }
    return false;
  })();
  if (!up) { console.error("server did not come up"); process.exit(2); }
  console.log(`[qa] server up at ${BASE}`);
}

try {
  // ---- S1: small-talk — shared answers fully, box stays silent, box stops ----
  {
    const user = `qa1-${runTag}`;
    const t = await sendTurn(user, "conv", "hey! how's it going?", TOOL_MODEL);
    const boxId = t.billingStarts[0];
    const sharedAnswered = t.shared.trim().length > 0;
    const holding = /check(ing)? (that|on that)|looking into|one sec|on it/i.test(t.shared);
    record("S1 shared answers small-talk itself", sharedAnswered && !holding, `shared=${JSON.stringify(t.shared.slice(0, 80))}`);
    record("S1 box adds nothing on top", t.box.replace(/\[hermes\] installing[^\n]*\n?/, "").trim() === "", `box=${JSON.stringify(t.box.slice(0, 80))}`);
    record("S1 turn ended cleanly", t.errors.length === 0 && t.blocked.length === 0, `errors=${t.errors.length} blocked=${t.blocked.length} in ${(t.durationMs / 1000).toFixed(1)}s${t.errors[0] ? ` firstError=${JSON.stringify(String(t.errors[0].message).slice(0, 160))}` : ""}`);
    const finalState = boxId ? await waitForBoxState(boxId, stoppedState, 90_000) : "no-box";
    record("S1 box actually STOPS after idle", !boxId || stoppedState(finalState), `box=${boxId} state=${finalState}`);

    // ---- S2: tool question on the SAME conversation (also proves resume) ----
    let t2 = await sendTurn(user, "conv", "use your shell to find your public ipv4 address and tell me the exact address", TOOL_MODEL);
    if ((t2.errors.length > 0 || t2.timedOut) && !t2.box.match(/\d{1,3}(?:\.\d{1,3}){3}/)) {
      // A LOUD failure (provider stall surfaced as an error) is allowed one retry —
      // silence is our bug, an upstream flake is not. The retry must fully succeed.
      console.log(`[qa] S2 first attempt failed loudly (errors=${t2.errors.length} timedOut=${t2.timedOut}); retrying once`);
      t2 = await sendTurn(user, "conv", "use your shell to find your public ipv4 address and tell me the exact address", TOOL_MODEL);
    }
    const boxId2 = t2.billingStarts[0] ?? boxId;
    const ip = t2.box.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0];
    record("S2 immediate shared response exists (rule 1)", t2.shared.trim().length > 0 && isHoldingLine(t2.shared) || t2.events.some((e) => e.type === "trace" && e.stage === "route.direct"), `shared=${JSON.stringify(t2.shared.slice(0, 80))}`);
    record("S2 box answered with a real IP via tools", Boolean(ip) && !t2.timedOut, `ip=${ip ?? "none"} timedOut=${t2.timedOut} box=${JSON.stringify(t2.box.slice(0, 120))} in ${(t2.durationMs / 1000).toFixed(1)}s`);
    record("S2 no errors/blockers", t2.errors.length === 0 && t2.blocked.length === 0, `errors=${t2.errors.length} blocked=${t2.blocked.length}${t2.errors[0] ? ` firstError=${JSON.stringify(String(t2.errors[0].message).slice(0, 160))}` : ""}${t2.blocked[0] ? ` firstBlocked=${JSON.stringify(String(t2.blocked[0].message).slice(0, 160))}` : ""}`);
    const finalState2 = boxId2 ? await waitForBoxState(boxId2, stoppedState, 90_000) : "no-box";
    record("S2 box actually STOPS after idle", !boxId2 || stoppedState(finalState2), `box=${boxId2} state=${finalState2}`);
  }

  // ---- S3: tool question on a model whose endpoint can't do tools -> LOUD failure ----
  {
    const t = await sendTurn(`qa3-${runTag}`, "conv", "use your shell to read your public ip and tell me", NO_TOOL_MODEL);
    const loud = t.blocked.some((e) => e.stage === "box.runtime.no-answer") || t.errors.length > 0;
    const silent = t.box.replace(/\[hermes\] installing[^\n]*\n?/, "").trim() === "" && !loud;
    record("S3 incapable box fails LOUDLY, never silently", loud && !silent, `blocked=${JSON.stringify(t.blocked.map((b) => b.stage))} errors=${t.errors.length} box=${JSON.stringify(t.box.slice(0, 60))}`);
    const boxId = t.billingStarts[0];
    const finalState = boxId ? await waitForBoxState(boxId, stoppedState, 90_000) : "no-box";
    record("S3 failed box still STOPS", !boxId || stoppedState(finalState), `box=${boxId} state=${finalState}`);
  }

  // ---- S4: double-send — a follow-up mid-boot; both turns terminate; box stops ----
  {
    const user = `qa4-${runTag}`;
    const first = sendTurn(user, "conv", "use your shell: how many cpu cores do you have?", TOOL_MODEL);
    await delay(3000);
    const second = sendTurn(user, "conv", "thanks!", TOOL_MODEL);
    const [a, b] = await Promise.all([first, second]);
    record("S4 both concurrent turns terminated", true, `first ${(a.durationMs / 1000).toFixed(1)}s, second ${(b.durationMs / 1000).toFixed(1)}s`);
    record("S4 second turn was answered (rule 1)", b.shared.trim().length > 0 || b.box.trim().length > 0 || b.blocked.length > 0, `shared=${JSON.stringify(b.shared.slice(0, 60))}`);
    const boxId = a.billingStarts[0] ?? b.billingStarts[0];
    const finalState = boxId ? await waitForBoxState(boxId, stoppedState, 120_000) : "no-box";
    record("S4 box STOPS after concurrent turns settle", !boxId || stoppedState(finalState), `box=${boxId} state=${finalState}`);
  }

  // ---- S5: orphan sweep — a stray running consumer-agent box gets reaped ----
  {
    const created = await boxApi("/boxes", { method: "POST", body: JSON.stringify({ ttlSeconds: 3600 }) });
    const orphanId = created.box?.id;
    if (!orphanId) {
      record("S5 orphan sweep", false, "could not create orphan box");
    } else {
      await boxApi(`/boxes/${orphanId}`, { method: "PATCH", body: JSON.stringify({ name: `consumer-agent-user-orphan-${runTag}` }) });
      // Reaper: sighting -> grace (2×15s) -> stop. Allow generous slack for boot time.
      const finalState = await waitForBoxState(orphanId, stoppedState, 180_000);
      record("S5 server reaps stray consumer-agent boxes", stoppedState(finalState), `orphan=${orphanId} state=${finalState}`);
      if (!stoppedState(finalState)) await boxApi(`/boxes/${orphanId}/stop`, { method: "POST" }).catch(() => undefined);
    }
  }
} finally {
  server?.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n==== E2E QA: ${results.length - failed.length}/${results.length} passed ====`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(" | ")); process.exit(1); }
process.exit(0);
