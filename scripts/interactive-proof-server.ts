import http from "node:http";
import { URL } from "node:url";
import {
  BoxHttpClient,
  assertNoBoxAgent,
  BOX_PRICING,
  ConsumerBoxAgentOrchestrator,
  InMemorySessionStore,
  createRestrictedSharedCapabilities,
  RUNTIME_FEASIBILITY,
  type ConsumerTurnEvent,
} from "../src/index.js";
import { harness as claude } from "../examples/claude-sdk/adapter.js";

const apiKey = process.env.BOX_API_KEY;
if (!apiKey)
  throw new Error(
    "BOX_API_KEY is required; this server refuses to run without the real Box credential.",
  );
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicApiKey)
  throw new Error(
    "ANTHROPIC_API_KEY is required; demo backend proof is Claude-only and will not substitute OpenAI/Codex/GPT providers.",
  );

const port = Number(process.env.PORT ?? 4178);
const box = assertNoBoxAgent(new BoxHttpClient({ apiKey })); // runtime proof: Box's built-in agent is forbidden
// Demo proof is Claude-only: Sonnet/Haiku via Anthropic, never Opus by default, never OpenAI/Codex/GPT fallback.
const allHarnesses = [claude];
const orchestrator = new ConsumerBoxAgentOrchestrator({
  box,
  harnesses: allHarnesses,
  sessions: new InMemorySessionStore(),
  providerEnv: { ANTHROPIC_API_KEY: anthropicApiKey },
  sharedBoxName: "consumer-agent-shared-prewarm",
  userBoxName: (userId) => `consumer-agent-user-${userId}`,
  userBoxTtlSeconds: 900,
  readinessPollMs: 2000,
  handoffTimeoutMs: 120_000,
  resumeTimeoutMs: 60_000,
  autoStopIdleMs: 10_000,
});

function keyAvailable(provider: string): boolean {
  return provider === "anthropic" && Boolean(anthropicApiKey);
}

function harnessInfo() {
  return allHarnesses.map((h) => ({
    name: h.name,
    description: h.description,
    models: h.models.map((m) => ({
      ...m,
      keyAvailable: keyAvailable(m.provider),
    })),
  }));
}

function sse(res: http.ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  return (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function auditEvent(event: ConsumerTurnEvent, input: { userId: string; conversationId: string; message: string }) {
  const redacted: any = { ...event };
  if (redacted.hidden) redacted.hidden = "[redacted hidden context]";
  if (redacted.recap) redacted.recap = "[redacted recap]";
  if (Array.isArray(redacted.argv)) redacted.argv = redacted.argv.map((v: unknown) => {
    const text = String(v);
    return /<consumer-agent-system-instructions>|<consumer-context>|<latest-user-request>/.test(text) || text.length > 300
      ? "[redacted harness prompt]"
      : text.slice(0, 120);
  });
  if (typeof redacted.command === "string" && redacted.command.includes("base64 -d")) redacted.command = "[redacted instruction-file write]";
  if (redacted.text && String(redacted.text).length > 160) redacted.text = String(redacted.text).slice(0, 160) + "…";
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    audit: "turn-event",
    userId: input.userId,
    conversationId: input.conversationId,
    message: input.message,
    event: redacted,
  }));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(html());
    }

    if (req.method === "GET" && url.pathname === "/api/harnesses") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({
          harnesses: harnessInfo(),
          env: {
            ANTHROPIC_API_KEY: keyAvailable("anthropic"),
          },
          runtimeFeasibility: RUNTIME_FEASIBILITY.filter((r) => r.harnessName === claude.name),
          boxAgent: "disabled (assertNoBoxAgent guard)",
          pricing: BOX_PRICING,
        }),
      );
    }

    // Live restricted-mode proof: exercise the shared capabilities and show denials.
    if (req.method === "POST" && url.pathname === "/api/restricted-proof") {
      const caps = createRestrictedSharedCapabilities();
      const results: { action: string; denied: boolean; message: string }[] =
        [];
      for (const [action, call] of [
        ["readFile(/etc/passwd)", () => caps.readFile("/etc/passwd")],
        ["bash(id)", () => caps.bash("id")],
        ["writeFile(proof.txt)", () => caps.writeFile("proof.txt", "x")],
        ["controlComputer(click)", () => caps.controlComputer("click 0 0")],
      ] as const) {
        try {
          await call();
          results.push({
            action,
            denied: false,
            message: "UNEXPECTEDLY ALLOWED",
          });
        } catch (e) {
          results.push({
            action,
            denied: true,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ results }));
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      const body = await readBody(req);
      const send = sse(res);
      const selection = {
        harness: String(body.harness),
        provider: String(body.provider),
        model: String(body.model),
      };
      try {
        const turnInput = {
          userId: String(body.userId ?? "user-a"),
          conversationId: String(body.conversationId ?? "conv-1"),
          message: String(body.message ?? ""),
          selection,
        };
        send({
          type: "trace",
          stage: "backend.request.received",
          message: "POST /api/send reached backend; SSE stream opened",
          harness: selection.harness,
          model: selection.model,
        });
        for await (const event of orchestrator.runTurn(turnInput)) {
          auditEvent(event as ConsumerTurnEvent, turnInput);
          send(event as ConsumerTurnEvent);
        }
        send({ type: "stream.end" });
      } catch (e) {
        send({
          type: "error",
          message: e instanceof Error ? (e.stack ?? e.message) : String(e),
        });
      }
      return void res.end();
    }

    // Stop streams the full lifecycle (stopping -> archiving -> archived) and the
    // exact moment billing pauses.
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const body = await readBody(req);
      const send = sse(res);
      try {
        for await (const event of orchestrator.stopUserBox(
          String(body.userId ?? "user-a"),
          String(body.conversationId ?? "conv-1"),
        )) {
          send(event as ConsumerTurnEvent);
        }
        send({ type: "stream.end" });
      } catch (e) {
        send({
          type: "error",
          message: e instanceof Error ? (e.stack ?? e.message) : String(e),
        });
      }
      return void res.end();
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      }),
    );
  }
});

server.listen(port, "0.0.0.0", () =>
  console.log(`interactive proof server on 0.0.0.0:${port}`),
);

function html() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>Box chat demo</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fff;color:#111;line-height:1.4;font-weight:400}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{min-height:100dvh;background:#fff}body.hide-traces .msg.trace{display:none}
.shell{height:100dvh;max-width:1180px;margin:0 auto;display:grid;grid-template-columns:minmax(380px,560px) 330px;gap:24px;align-items:stretch;padding:0 24px}.app{height:100dvh;min-width:0;display:flex;flex-direction:column;background:#fff;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0}
.top{position:sticky;top:0;z-index:2;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);border-bottom:1px solid #e0e0e0;padding:calc(14px + env(safe-area-inset-top)) 16px 14px;display:grid;gap:12px}
.counters{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}.counter{border:1px solid #e0e0e0;background:#f6f6f6;padding:11px 12px;min-width:0}.label{display:block;color:#555;letter-spacing:.01em;font-size:12px;font-weight:400}.value{display:block;margin-top:3px;font:400 21px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.state{border:1px solid #111;background:#111;color:#fff;padding:10px 13px;font-size:13px;font-weight:400;text-align:center}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.controls button,.traceToggle{min-height:36px;background:#fff;color:#111;border:1px solid #d9d9d9;padding:0 12px;font-weight:400;font-size:12px;display:inline-flex;align-items:center;gap:7px;cursor:pointer}.traceToggle input{accent-color:#111}
.chat{flex:1;overflow:auto;padding:18px 16px 20px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}.empty{margin:auto;color:#555;text-align:center;font-size:14px;max-width:280px}.msg{max-width:86%;padding:11px 13px;font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere;font-weight:400;border:1px solid transparent}.msg.user{align-self:flex-end;background:#111;color:#fff}.msg.assistant{align-self:flex-start;background:#f6f6f6;color:#111;border-color:#e0e0e0}.msg.trace{align-self:flex-start;background:#fff;border:1px dashed #d9d9d9;color:#555;font-size:12px;max-width:92%;padding:8px 10px}.tag{display:block;margin-bottom:4px;color:#555;letter-spacing:.01em;font-size:10px;font-weight:400}.msg.user .tag{color:#d9d9d9}.msg.trace .tag{color:#777}
.composer{position:relative;display:block;padding:12px 16px calc(14px + env(safe-area-inset-bottom));border-top:1px solid #e0e0e0;background:rgba(255,255,255,.97);backdrop-filter:blur(12px)}textarea{width:100%;min-height:58px;max-height:140px;resize:none;border:1px solid #d9d9d9;background:#fff;color:#111;padding:13px 92px 13px 13px;font:inherit;font-weight:400;outline:none;display:block}textarea:focus{border-color:#111}button{min-height:42px;border:0;background:#111;color:#fff;padding:0 16px;font:inherit;font-weight:400;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}#send{position:absolute;right:16px;bottom:calc(14px + env(safe-area-inset-bottom));height:42px;min-height:42px;background:#fc4b55;color:#fff;border:1px solid #fc4b55}
.schematic{align-self:center;border:1px solid #e0e0e0;background:#fff;padding:20px;color:#111}.schematic h2{font-family:"Funnel Display",Inter,ui-sans-serif,system-ui,sans-serif;font-size:22px;line-height:1.15;letter-spacing:-.02em;margin:0 0 18px;color:#111;font-weight:400}.route{display:grid;gap:10px}.node{border:1px solid #e0e0e0;background:#f6f6f6;padding:13px;transition:.18s ease}.node .nodeTitle{display:block;font-size:15px;font-weight:400;color:inherit}.node span{display:block;margin-top:3px;color:#555;font-size:12px;font-weight:400}.path{min-height:22px;display:flex;align-items:center;color:#777;font-size:13px;letter-spacing:0}.path span{display:block}.path span:before{content:"↓ ";color:#fc4b55}.schematic[data-route="shared"] .shared-node,.schematic[data-route="private"] .private-node{border-color:#111;background:#111;color:#fff}.schematic[data-route="shared"] .shared-node span,.schematic[data-route="private"] .private-node span{color:#efefef}.schematic[data-route="private"] .to-private span,.schematic[data-route="shared"] .to-shared span{color:#fc4b55}.routeStatus{margin-top:12px;border:1px solid #e0e0e0;padding:10px 12px;background:#fff;font-size:12px;font-weight:400;color:#111}.matrix{margin-top:12px;display:grid;gap:7px}.matrixRow{border:1px solid #e0e0e0;background:#fff;padding:8px 9px;font-size:11px;font-weight:400}.matrixRow .matrixTitle{display:block;font-size:12px;font-weight:400}.matrixRow span{display:block;color:#555;margin-top:2px;font-weight:400}
@media(max-width:900px){.shell{display:block;height:100dvh;padding:0}.schematic{display:none}.app{max-width:720px;margin:0 auto}}
@media(max-width:520px){.app{max-width:none;border:0}.top{padding-left:10px;padding-right:10px}.chat{padding-left:10px;padding-right:10px}.composer{padding-left:10px;padding-right:10px}.counter{padding:10px}.value{font-size:18px}.state{font-size:12px;line-height:1.25}.msg{max-width:90%;font-size:14px}.label{font-size:11px}button{padding:0 14px}#send{right:10px}}
</style></head><body class="hide-traces"><div class="shell">
<main class="app">
  <header class="top" aria-label="machine summary">
    <section class="counters" aria-label="totals">
      <div class="counter"><span class="label">total spent</span><span class="value" id="totalCost">$0.000000</span></div>
      <div class="counter"><span class="label">machine time</span><span class="value" id="totalSeconds">0.0s</span></div>
      <div class="counter"><span class="label">auto-stop</span><span class="value" id="autoStopTimer">idle</span></div>
    </section>
    <div class="state" id="machineState">Shared bridge ready · private machine stopped</div>
    <div class="controls"><button id="stopBox" type="button">Pause Box now</button><label class="traceToggle"><input id="showTraces" type="checkbox"/> Show traces</label></div>
  </header>
  <section class="chat" id="chat" aria-live="polite"><div class="empty" id="empty">Send a message to start the demo.</div></section>
  <form class="composer" id="composer">
    <textarea id="msg" placeholder="Message…" aria-label="Message"></textarea>
    <button id="send" type="submit">Send</button>
  </form>
</main>
<aside class="schematic" id="schematic" data-route="idle" aria-label="message route schematic">
  <h2>Message route</h2>
  <div class="route">
    <div class="node user-node"><span class="nodeTitle">You</span><span>Message enters the demo</span></div>
    <div class="path to-shared"><span>fast path</span></div>
    <div class="node shared-node"><span class="nodeTitle">Shared infra</span><span>Natural answer, or bridge when tools need time</span></div>
    <div class="path to-private"><span>handoff</span></div>
    <div class="node private-node"><span class="nodeTitle">User machine</span><span>Private Box with tools + billing</span></div>
  </div>
  <div class="routeStatus" id="routeStatus">Ready: shared infra is listening.</div>
  <div class="matrix" id="matrix"></div>
</aside>
</div>
<script>
let H=[]; let MATRIX=[]; let PRICING=null; let selectedHarness='', selectedProvider='', selectedModel='', selectedUser=(new URLSearchParams(location.search).get('userId')||'user-a'), selectedConversation=(new URLSearchParams(location.search).get('conversationId')||'conv-1');
let timer=null, billSince=0, billRate=0, billing=false, totalSeconds=0;
let autoStopInterval=null, autoStopDeadline=0, autoStopBoxId=null;
const $=id=>document.getElementById(id);
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
const hiddenContextPattern=new RegExp('<consumer-context>[\\s\\S]*?</consumer-context>','g');
function stripHidden(s){return String(s).replace(hiddenContextPattern,'').trim();}
function fmtUsd(n){return '$'+n.toFixed(6);}
const routeState={phase:'idle',boxId:null,billing:false,finalRoute:null};
function setRoute(route,text){const s=$('schematic');const r=$('routeStatus');if(!s||!r)return;s.dataset.route=route;r.textContent=text;}
function setState(text){$('machineState').textContent=text;}
function fmtAutoStopRemaining(ms){return Math.max(0,Math.ceil(ms/1000))+'s';}
function clearAutoStopTimer(label){autoStopDeadline=0;autoStopBoxId=null;if(autoStopInterval){clearInterval(autoStopInterval);autoStopInterval=null;}$('autoStopTimer').textContent=label||'idle';}
function renderAutoStopTimer(){if(!autoStopDeadline){$('autoStopTimer').textContent='idle';return;}const remaining=Math.max(0,autoStopDeadline-Date.now());$('autoStopTimer').textContent=fmtAutoStopRemaining(remaining);if(remaining<=0&&autoStopInterval){clearInterval(autoStopInterval);autoStopInterval=null;}}
function startAutoStopTimer(ev){autoStopDeadline=ev.deadlineEpochMs||(Date.now()+Math.max(0,ev.remainingMs||0));autoStopBoxId=ev.boxId||autoStopBoxId;renderAutoStopTimer();if(autoStopInterval)clearInterval(autoStopInterval);autoStopInterval=setInterval(renderAutoStopTimer,200);}
function describeAutoStop(ev){const remaining=fmtAutoStopRemaining(ev.remainingMs||0);if(ev.phase==='started'||ev.phase==='tick')return 'Assistant done · user idle · Box auto-stops in '+remaining;if(ev.phase==='stopping')return 'Auto-stop countdown reached 0s · stopping Box now';if(ev.phase==='canceled')return 'Auto-stop timer reset · new message is using the Box';return ev.note||'Auto-stop timer updated';}
function boxLabel(id){return id&&id!=='pending'?' · '+id:'';}
function resetRouteForTurn(){clearAutoStopTimer('paused');routeState.phase='accepted';routeState.boxId=null;routeState.billing=false;routeState.finalRoute=null;setRoute('shared','Route: message accepted; checking Box state and opening the shared bridge now.');}
function routeIsPrivate(){return Boolean(routeState.boxId)||['billing','starting','provisioning','provisioned','cloning','resuming','ready','idle','running','handoff','runtime-proof','tools','user-box'].includes(routeState.phase);}
function routeEvent(ev){
  if(ev.type==='stream.end')return;
  if(ev.type==='error'||ev.type==='turn.blocked'){routeState.phase='error';setRoute('error','Route error: private runtime did not complete; see trace for the real event.');return;}
  if(ev.type==='trace'&&/backend|submit/.test(ev.stage||'')){routeState.phase='accepted';setRoute('shared','Route: backend accepted the message; shared bridge is live while Box status resolves.');return;}
  if(ev.type==='shared.larp'){if(routeIsPrivate()){setRoute('private','Route: shared bridge is covering latency while private Box status continues'+boxLabel(routeState.boxId)+'.');return;}routeState.phase='shared-bridge';setRoute('shared','Route: shared bridge is covering latency while the private Box starts/resumes.');return;}
  if(ev.type==='context.injected'&&ev.scope==='shared'){if(routeIsPrivate()){setRoute('private','Route: private Box is active'+boxLabel(routeState.boxId)+'; shared bridge is only covering latency.');return;}routeState.phase='shared';setRoute('shared','Route: shared infra is answering while the private Box boots in parallel.');return;}
  if(ev.type==='shared.delta'&&routeState.phase!=='handoff'&&routeState.phase!=='user-box'){if(routeIsPrivate()){setRoute('private','Route: private Box path is active'+boxLabel(routeState.boxId)+'; shared text is just the bridge response.');return;}routeState.phase='shared-delta';setRoute('shared','Route: shared infra is streaming the bridge response; private Box events will take over when ready.');return;}
  if(ev.type==='billing.start'){routeState.boxId=ev.boxId||routeState.boxId;routeState.billing=true;routeState.phase='billing';setRoute('private','Route: private Box billing is live'+boxLabel(routeState.boxId)+'; handoff/runtime events are active.');return;}
  if(ev.type==='lifecycle'){routeState.boxId=ev.boxId||routeState.boxId;const state=String(ev.state||'');
    if(['starting','provisioning','provisioned','cloning','resuming'].includes(state)){routeState.phase=state;setRoute('private','Route: private Box is '+state+boxLabel(routeState.boxId)+'; waiting for ready/handoff events.');return;}
    if(['ready','idle','running'].includes(state)){routeState.phase=state;setRoute('private','Route: private Box is '+state+boxLabel(routeState.boxId)+'; user-machine runtime is taking this turn.');return;}
    if(state==='resume-timeout'){routeState.phase=state;setRoute('private','Route: previous Box resume timed out; starting a fresh private Box.');return;}
    if(['stopping','archiving','archived','none'].includes(state)){routeState.phase=state;setRoute('private','Route: private Box is '+state+boxLabel(routeState.boxId)+'; billing state is being reconciled.');return;}
  }
  if(ev.type==='handoff.started'){routeState.boxId=ev.boxId||routeState.boxId;routeState.phase='handoff';setRoute('private','Route: handoff started on the user machine'+boxLabel(routeState.boxId)+'; tools are available.');return;}
  if(ev.type==='runtime.proof'){routeState.boxId=ev.boxId||routeState.boxId;routeState.phase='runtime-proof';setRoute('private','Route: confirmed in-Box '+ev.harness+' runtime'+boxLabel(routeState.boxId)+'; streaming='+String(ev.streaming||'unknown')+'.');return;}
  if(ev.type==='exec'||ev.type==='harness.tool'){routeState.boxId=ev.boxId||routeState.boxId;routeState.phase='tools';setRoute('private','Route: private Box runtime is using tools'+boxLabel(routeState.boxId)+'.');return;}
  if(ev.type==='user-box.delta'){routeState.boxId=ev.boxId||routeState.boxId;routeState.phase='user-box';setRoute('private','Route: user-machine answer is streaming'+boxLabel(routeState.boxId)+'.');return;}
  if(ev.type==='billing.stop'){routeState.boxId=ev.boxId||routeState.boxId;routeState.billing=false;setRoute('private','Route: billing paused for private Box'+boxLabel(routeState.boxId)+'.');return;}
  if(ev.type==='autostop.timer'){routeState.boxId=ev.boxId||routeState.boxId;if(ev.phase==='canceled'){setRoute('private','Route: auto-stop reset because a newer message arrived; countdown restarts after the active answer.');}else if(ev.phase==='stopping'){setRoute('private','Route: visible auto-stop countdown reached zero; stopping private Box'+boxLabel(routeState.boxId)+'.');}else{setRoute('private','Route: assistant finished and user is idle; auto-stop in '+fmtAutoStopRemaining(ev.remainingMs||0)+boxLabel(routeState.boxId)+'.');}return;}
  if(ev.type==='turn.done'){routeState.boxId=ev.boxId||routeState.boxId;routeState.finalRoute=ev.route||null;const route=ev.route||((ev.boxId||routeState.phase==='user-box'||routeState.phase==='handoff')?'user-box':'shared');const routeLabel=route==='bridge'?'private Box bridge':route==='direct'?'warm private Box':route==='user-box'?'user-machine':route;setRoute(route==='shared'?'shared':'private',route==='shared'?'Route: turn completed on shared infra; no stale private waiting state.':'Route: turn completed via '+routeLabel+' runtime'+boxLabel(routeState.boxId)+'.');return;}
}
function activeSeconds(){return totalSeconds+(billing?(Date.now()-billSince)/1000:0);}
function renderTotals(){const seconds=activeSeconds();$('totalSeconds').textContent=seconds.toFixed(1)+'s';$('totalCost').textContent=fmtUsd(seconds*billRate);}
async function load(){const r=await fetch('/api/harnesses');const j=await r.json();H=j.harnesses;MATRIX=j.runtimeFeasibility||[];PRICING=j.pricing;billRate=PRICING.ratePerSecond;renderMatrix();chooseDefaultModel();renderTotals();}
function renderMatrix(){const el=$('matrix');if(!el)return;el.innerHTML=MATRIX.map(r=>'<div class="matrixRow"><span class="matrixTitle">'+esc(r.runtime)+' · '+esc(r.streaming)+'</span>'+(r.blocker?'<span>'+esc(r.blocker)+'</span>':'')+'</div>').join('');}
function chooseDefaultModel(){const preferred=H.find(h=>h.models.some(m=>m.keyAvailable))||H[0];if(!preferred){setState('No harnesses available');return;}const model=preferred.models.find(m=>m.keyAvailable)||preferred.models[0];selectedHarness=preferred.name;selectedProvider=model.provider;selectedModel=model.model;if(!model.keyAvailable)setState('Waiting for a valid model key · private machine stopped');}
const bubbles=new Map();
let showTraces=false;
function syncTraceVisibility(){document.body.classList.toggle('hide-traces',!showTraces);}
function addMsg(cls,tag,text,key){const c=$('chat');$('empty')?.remove();key=key||('seq:'+Date.now()+Math.random()+':'+cls);let el=bubbles.get(key);if(!el){el=document.createElement('div');el.className='msg '+cls;el.innerHTML='<div class="tag">'+esc(tag)+'</div><div class="body"></div>';c.appendChild(el);bubbles.set(key,el);}const body=el.querySelector('.body');body.textContent=stripHidden(body.textContent+text);c.scrollTop=c.scrollHeight;return el;}
function startBilling(sinceMs){if(!billing){billing=true;billSince=sinceMs||Date.now();if(!timer)timer=setInterval(renderTotals,100);}setState('Private machine running · tools active · billing live');renderTotals();}
function stopBilling(elapsed){if(billing){totalSeconds+=(elapsed!=null&&elapsed>0)?elapsed:(Date.now()-billSince)/1000;billing=false;}if(timer){clearInterval(timer);timer=null;}clearAutoStopTimer('stopped');setState('Private machine stopped · billing paused');renderTotals();}
const activeTurns=new Map();
function abortInterruptibleSharedTurns(){for(const [id,t] of activeTurns){if(t.interruptible&&!t.boxStarted)t.controller.abort();}}
function newTurnId(){try{return (globalThis.crypto&&globalThis.crypto.randomUUID)?globalThis.crypto.randomUUID():String(Date.now()+Math.random());}catch{return String(Date.now()+Math.random());}}
async function runTurn(msg){clearAutoStopTimer('paused');abortInterruptibleSharedTurns();const localId=newTurnId();const controller=new AbortController();activeTurns.set(localId,{controller,interruptible:false,boxStarted:false});addMsg('user','you',msg,'user:'+localId);setState('Shared bridge starting · private Box boot requested');resetRouteForTurn();try{const res=await fetch('/api/send',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,conversationId:selectedConversation,message:msg,harness:selectedHarness,provider:selectedProvider,model:selectedModel})});await drain(res,localId);}catch(e){if(e.name!=='AbortError'){addMsg('assistant','assistant','Something went wrong: '+String(e&&e.message||e));setState('Error · private machine state unchanged');}}finally{activeTurns.delete(localId);}}
const composer=$('composer'), msgEl=$('msg'), sendBtn=$('send');
const stopBtn=$('stopBox');
const showTracesEl=$('showTraces');
if(showTracesEl){showTracesEl.checked=false;showTracesEl.addEventListener('change',()=>{showTraces=Boolean(showTracesEl.checked);syncTraceVisibility();});}
syncTraceVisibility();
let lastSubmitAt=0;
function submitComposer(source){
  const text=msgEl.value.trim();
  console.debug('[trace] submit event fired', {source, hasText:Boolean(text), harness:selectedHarness, model:selectedModel});
  if(!text){console.debug('[trace] empty submit ignored', {source});return false;}
  const now=Date.now();
  if(now-lastSubmitAt<150){console.debug('[trace] duplicate submit suppressed', {source});return false;}
  lastSubmitAt=now;
  addMsg('trace','submit trace','submit event fired from '+source+' · request starting\\n');
  msgEl.value='';
  msgEl.focus();
  runTurn(text);
  return true;
}
composer.addEventListener('submit',e=>{e.preventDefault();submitComposer('form.submit');});
sendBtn.addEventListener('click',e=>{e.preventDefault();submitComposer('button.click');});
stopBtn.addEventListener('click',async e=>{e.preventDefault();stopBtn.disabled=true;addMsg('trace','manual stop','pause request sent for this conversation\\n');setState('Private machine stopping · manual pause requested');try{const res=await fetch('/api/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,conversationId:selectedConversation})});await drain(res,newTurnId());}catch(err){addMsg('assistant','assistant','Stop failed: '+String(err&&err.message||err));}finally{stopBtn.disabled=false;}});
msgEl.addEventListener('keydown',e=>{if((e.key==='Enter'||e.code==='Enter'||e.keyCode===13||e.which===13)&&!e.shiftKey){e.preventDefault();submitComposer('textarea.enter');}});
msgEl.addEventListener('beforeinput',e=>{if((e.inputType==='insertLineBreak'||e.inputType==='insertParagraph')&&!e.shiftKey){e.preventDefault();submitComposer('textarea.beforeinput');}});
async function drain(res,localId){if(!res){throw new Error('No response object from /api/send');}if(!res.ok){const body=await res.text().catch(()=>'');throw new Error('/api/send failed with HTTP '+res.status+' '+body);}if(!res.body){throw new Error('/api/send did not return a readable SSE body');}const reader=res.body.getReader();const dec=new TextDecoder();const sep=String.fromCharCode(10,10);const nl=String.fromCharCode(10);let buf='';while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split(sep);buf=parts.pop()||'';for(const p of parts){const line=p.split(nl).find(l=>l.startsWith('data:'));if(!line)continue;handle(JSON.parse(line.slice(5)),localId);}}}
function keyFor(ev,localId,cls){return (ev.turnId||localId)+':'+cls;}
function handle(ev,localId){console.debug('[trace] stream event', ev);routeEvent(ev);const t=activeTurns.get(localId);if(t&&['handoff.started','billing.start','user-box.delta','exec'].includes(ev.type)){t.boxStarted=true;t.interruptible=false;}
  if(ev.type==='trace'){addMsg('trace','trace · '+(ev.stage||'event'),(ev.message||JSON.stringify(ev))+'\\n',keyFor(ev,localId,'trace')+':'+(ev.stage||Math.random()));if(/bridge/.test(ev.stage||''))setState('Shared bridge active · private Box booting');else if(/backend|submit/.test(ev.stage||''))setState('Request received · shared bridge starting');}
  else if(ev.type==='turn.blocked'){addMsg('trace','blocker · '+(ev.stage||'runtime'),(ev.message||'Private runtime unavailable')+'\\n',keyFor(ev,localId,'blocked')+':'+(ev.stage||Math.random()));addMsg('assistant','assistant','Private runtime is not ready yet. This turn stayed on the shared bridge; retry when Box status is ready.');setState('Private runtime unavailable · retry after Box is ready');}
  else if(ev.type==='shared.delta'){addMsg('assistant','assistant · shared infra · no tools',ev.text,keyFor(ev,localId,'shared'));}
  else if(ev.type==='shared.larp'){setState('Shared bridge active · private Box starting/resuming');}
  else if(ev.type==='context.injected'){if(ev.scope==='shared')setState('Shared bridge ready · private Box booting in parallel');}
  else if(ev.type==='billing.start'){startBilling(ev.sinceEpochMs);}
  else if(ev.type==='lifecycle'){if(ev.state==='resume-timeout')setState('Resume timed out · starting a fresh machine');else if(ev.state==='stopping')setState('Private machine stopping · wrapping up');else if(ev.state==='archiving')setState('Private machine archiving · billing about to pause');else if(ev.state==='archived')setState('Private machine archived · billing paused');else setState('Private machine '+String(ev.state).replace(/-/g,' '));}
  else if(ev.type==='handoff.started'){setState('Private machine running · assistant has tools');}
  else if(ev.type==='runtime.proof'){addMsg('trace','proof · no Box prompt/API','boxPromptApiUsed='+ev.boxPromptApiUsed+' · boxBuiltInAgentUsed='+ev.boxBuiltInAgentUsed+' · hostAsciiAgentUsed='+ev.hostAsciiAgentUsed+' · continuation='+ev.continuation+' · streaming='+(ev.streaming||'unknown')+(ev.blocker?' · limitation: '+ev.blocker:'' )+'\\n',keyFor(ev,localId,'proof'));}
  else if(ev.type==='exec'){setState('Private machine running · using tools');if(ev.kind==='harness')addMsg('trace','source path','Started real '+((ev.argv&&ev.argv[0])||'agent')+' harness inside the user machine; stdout/SSE relays native chunks as emitted.',keyFor(ev,localId,'exec'));}
  else if(ev.type==='harness.tool'){setState('Private machine running · using tools');const detail=ev.phase==='tool_use'?((ev.toolName||'tool')+(ev.command?': '+ev.command:'')):(ev.isError?'tool result error':'tool result')+(ev.stdout?': '+ev.stdout.trim():'');addMsg('trace','tool event · user machine',detail+'\\n',keyFor(ev,localId,'tool')+':'+ev.phase+':'+(ev.command||ev.stdout||Math.random()));}
  else if(ev.type==='user-box.delta'){addMsg('assistant','assistant · user machine · tools active',ev.text,keyFor(ev,localId,'box'));}
  else if(ev.type==='billing.stop'){stopBilling(ev.elapsedSeconds);}
  else if(ev.type==='autostop.timer'){if(ev.phase==='started'||ev.phase==='tick'){startAutoStopTimer(ev);}else if(ev.phase==='stopping'){clearAutoStopTimer('0s');}else if(ev.phase==='canceled'){clearAutoStopTimer('reset');}addMsg('trace','auto-stop',describeAutoStop(ev)+' · '+(ev.note||'')+'\n',keyFor(ev,localId,'autostop')+':'+ev.phase+':'+Math.ceil((ev.remainingMs||0)/1000));setState(describeAutoStop(ev));}
  else if(ev.type==='turn.done'){setState('Turn complete · waiting for visible auto-stop countdown');}
  else if(ev.type==='error'){addMsg('assistant','assistant','Error: '+ev.message);setState('Error · check model credentials or machine state');}}
load();
</script></body></html>`;
}
