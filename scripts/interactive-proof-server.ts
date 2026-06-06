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
import { providerEnvForBox, providerKey } from "../examples/shared.js";
import { harness as claude } from "../examples/claude-sdk/adapter.js";
import { harness as opencode } from "../examples/opencode/adapter.js";
import { harness as pi } from "../examples/pi/adapter.js";
import { harness as codex } from "../examples/codex-sdk/adapter.js";
import { harness as hermes } from "../examples/hermes/adapter.js";
import { harness as codebaseDaemon } from "../examples/codebase-daemon/adapter.js";

const apiKey = process.env.BOX_API_KEY;
if (!apiKey)
  throw new Error(
    "BOX_API_KEY is required; this server refuses to run without the real Box credential.",
  );

const port = Number(process.env.PORT ?? 4178);
const box = assertNoBoxAgent(new BoxHttpClient({ apiKey })); // runtime proof: Box's built-in agent is forbidden
// Prefer Claude/Anthropic when its key is configured; the client still falls back to OpenCode/OpenAI if Anthropic is absent.
const allHarnesses = [claude, codebaseDaemon, opencode, pi, hermes, codex];
const orchestrator = new ConsumerBoxAgentOrchestrator({
  box,
  harnesses: allHarnesses,
  sessions: new InMemorySessionStore(),
  providerEnv: providerEnvForBox(),
  sharedBoxName: "consumer-agent-shared-prewarm",
  userBoxName: (userId) => `consumer-agent-user-${userId}`,
  userBoxTtlSeconds: 900,
  readinessPollMs: 2000,
  handoffTimeoutMs: 120_000,
  resumeTimeoutMs: 60_000,
  autoStopIdleMs: 60_000,
});

function keyAvailable(provider: string): boolean {
  return Boolean(providerKey(provider));
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
            OPENAI_API_KEY: keyAvailable("openai"),
            OPENROUTER_API_KEY: keyAvailable("openrouter"),
          },
          runtimeFeasibility: RUNTIME_FEASIBILITY,
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
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f5f1;color:#141414;line-height:1.4}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{min-height:100dvh;background:linear-gradient(180deg,#faf9f5 0%,#f1efe8 100%)}
.shell{height:100dvh;max-width:1120px;margin:0 auto;display:grid;grid-template-columns:minmax(360px,520px) 320px;gap:18px;align-items:stretch;padding:0 18px}.app{height:100dvh;min-width:0;display:flex;flex-direction:column;background:#fff;border-left:1px solid #e2ded3;border-right:1px solid #e2ded3;box-shadow:0 24px 80px rgba(25,20,10,.08)}
.top{position:sticky;top:0;z-index:2;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);border-bottom:1px solid #e6e1d6;padding:calc(12px + env(safe-area-inset-top)) 14px 12px;display:grid;gap:10px}
.counters{display:grid;grid-template-columns:1fr 1fr;gap:8px}.counter{border:1px solid #ded8ca;background:#fbfaf7;border-radius:18px;padding:11px 12px;min-width:0}.label{display:block;color:#736b5c;text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:800}.value{display:block;margin-top:3px;font:800 21px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.state{border:1px solid #171717;background:#171717;color:#fff;border-radius:999px;padding:10px 13px;font-size:13px;font-weight:750;text-align:center;box-shadow:0 10px 24px rgba(0,0,0,.12)}
.chat{flex:1;overflow:auto;padding:16px 14px 18px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}.empty{margin:auto;color:#7c7468;text-align:center;font-size:14px;max-width:280px}.msg{max-width:86%;border-radius:20px;padding:11px 13px;font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 1px 0 rgba(0,0,0,.04)}.msg.user{align-self:flex-end;background:#111;color:#fff;border-bottom-right-radius:6px}.msg.assistant{align-self:flex-start;background:#f1efe8;color:#161616;border:1px solid #e2ded3;border-bottom-left-radius:6px}.msg.trace{align-self:flex-start;background:#fff;border:1px dashed #d6cebf;color:#6d6457;border-radius:14px;font-size:12px;max-width:92%;padding:8px 10px}.tag{display:block;margin-bottom:4px;color:#756d60;text-transform:uppercase;letter-spacing:.08em;font-size:9px;font-weight:900}.msg.user .tag{color:#dedede}.msg.trace .tag{color:#8c8375}
.composer{display:flex;gap:9px;align-items:flex-end;padding:10px 14px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #e6e1d6;background:rgba(255,255,255,.97);backdrop-filter:blur(12px)}textarea{flex:1;min-height:46px;max-height:130px;resize:none;border:1px solid #d8d2c5;border-radius:18px;background:#fbfaf7;color:#111;padding:12px 13px;font:inherit;outline:none}textarea:focus{border-color:#111}button{min-height:46px;border:0;border-radius:18px;background:#111;color:#fff;padding:0 16px;font-weight:850;font:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
.schematic{align-self:center;border:1px solid #e1dbcf;background:rgba(255,255,255,.76);backdrop-filter:blur(14px);border-radius:28px;padding:18px;box-shadow:0 24px 80px rgba(25,20,10,.08);color:#191714}.schematic h2{font-size:13px;margin:0 0 14px;text-transform:uppercase;letter-spacing:.1em;color:#6e6659}.route{display:grid;gap:12px}.node{border:1px solid #ddd6c8;background:#fbfaf7;border-radius:20px;padding:13px;transition:.18s ease}.node strong{display:block;font-size:15px}.node span{display:block;margin-top:3px;color:#746c5f;font-size:12px}.node .dot{width:8px;height:8px;border-radius:999px;background:#c8c0b2;display:inline-block;margin-right:7px}.path{height:34px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;color:#8c8374;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.path:before,.path:after{content:"";height:1px;background:#ded7ca}.path span{border:1px solid #ded7ca;background:#fff;border-radius:999px;padding:5px 8px}.hint{margin:14px 0 0;color:#6f675b;font-size:12px;line-height:1.45}.schematic[data-route="shared"] .shared-node,.schematic[data-route="private"] .private-node{border-color:#111;background:#111;color:#fff;box-shadow:0 12px 28px rgba(0,0,0,.14)}.schematic[data-route="shared"] .shared-node span,.schematic[data-route="private"] .private-node span{color:#e9e4dc}.schematic[data-route="shared"] .shared-node .dot,.schematic[data-route="private"] .private-node .dot{background:#70e000;box-shadow:0 0 0 5px rgba(112,224,0,.16)}.schematic[data-route="private"] .to-private span,.schematic[data-route="shared"] .to-shared span{border-color:#111;color:#111;font-weight:850}.schematic[data-route="idle"] .shared-node{border-color:#bdb4a5}.routeStatus{margin-top:12px;border:1px solid #ded7ca;border-radius:16px;padding:10px 12px;background:#fff;font-size:12px;font-weight:800;color:#26231f}.matrix{margin-top:12px;display:grid;gap:7px}.matrixRow{border:1px solid #e0d9cc;background:#fff;border-radius:13px;padding:8px 9px;font-size:11px}.matrixRow strong{display:block;font-size:12px}.matrixRow span{display:block;color:#72695c;margin-top:2px}
@media(max-width:900px){.shell{display:block;height:100dvh;padding:0}.schematic{display:none}.app{max-width:720px;margin:0 auto}}
@media(max-width:520px){.app{max-width:none;border:0}.top{padding-left:10px;padding-right:10px}.chat{padding-left:10px;padding-right:10px}.composer{padding-left:10px;padding-right:10px}.counter{border-radius:15px;padding:10px}.value{font-size:18px}.state{font-size:12px;line-height:1.25;border-radius:16px}.msg{max-width:90%;font-size:14px}.label{font-size:9px}button{padding:0 14px}}
</style></head><body><div class="shell">
<main class="app">
  <header class="top" aria-label="machine summary">
    <section class="counters" aria-label="totals">
      <div class="counter"><span class="label">total spent</span><span class="value" id="totalCost">$0.000000</span></div>
      <div class="counter"><span class="label">machine time</span><span class="value" id="totalSeconds">0.0s</span></div>
    </section>
    <div class="state" id="machineState">Shared bridge ready · private machine stopped</div>
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
    <div class="node user-node"><strong><span class="dot"></span>You</strong><span>Message enters the demo</span></div>
    <div class="path to-shared"><span>fast path</span></div>
    <div class="node shared-node"><strong><span class="dot"></span>Shared infra</strong><span>Open bridge ack only</span></div>
    <div class="path to-private"><span>handoff</span></div>
    <div class="node private-node"><strong><span class="dot"></span>User machine</strong><span>Private Box with tools + billing</span></div>
  </div>
  <div class="routeStatus" id="routeStatus">Ready: shared infra is listening.</div>
  <div class="matrix" id="matrix"></div>
  <p class="hint">Matrix reports whether live token/chunk streaming is possible for Claude SDK, codebase daemon, Pi, Hermès, and OpenCode. The chat trace proves continuation is an in-Box runtime, not Box prompt/API or the host agent.</p>
</aside>
</div>
<script>
let H=[]; let MATRIX=[]; let PRICING=null; let selectedHarness='', selectedProvider='', selectedModel='', selectedUser=(new URLSearchParams(location.search).get('userId')||'user-a'), selectedConversation=(new URLSearchParams(location.search).get('conversationId')||'conv-1');
let timer=null, billSince=0, billRate=0, billing=false, totalSeconds=0;
const $=id=>document.getElementById(id);
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
const hiddenContextPattern=new RegExp('<consumer-context>[\\s\\S]*?</consumer-context>','g');
function stripHidden(s){return String(s).replace(hiddenContextPattern,'').trim();}
function fmtUsd(n){return '$'+n.toFixed(6);}
function routeForState(text){if(/Error/i.test(text))return 'error';if(/Private machine (running|starting|stopping|archiving)|tools active|assistant has tools|preparing tools|Resume timed out/i.test(text))return 'private';if(/Shared (chat|bridge)|backend|submit event/i.test(text))return 'shared';return 'idle';}
function setRoute(route,text){const s=$('schematic');const r=$('routeStatus');if(!s||!r)return;s.dataset.route=route;r.textContent=route==='private'?'Route: handed off to the user machine.':route==='shared'?'Route: handled by shared infra.':route==='error'?'Route error: check machine state.':'Ready: shared infra is listening.';}
function setState(text){$('machineState').textContent=text;setRoute(routeForState(text),text);}
function activeSeconds(){return totalSeconds+(billing?(Date.now()-billSince)/1000:0);}
function renderTotals(){const seconds=activeSeconds();$('totalSeconds').textContent=seconds.toFixed(1)+'s';$('totalCost').textContent=fmtUsd(seconds*billRate);}
async function load(){const r=await fetch('/api/harnesses');const j=await r.json();H=j.harnesses;MATRIX=j.runtimeFeasibility||[];PRICING=j.pricing;billRate=PRICING.ratePerSecond;renderMatrix();chooseDefaultModel();renderTotals();}
function renderMatrix(){const el=$('matrix');if(!el)return;el.innerHTML=MATRIX.map(r=>'<div class="matrixRow"><strong>'+esc(r.runtime)+' · '+esc(r.streaming)+'</strong><span>'+esc(r.blocker||'true live chunks supported')+'</span></div>').join('');}
function chooseDefaultModel(){const preferred=H.find(h=>h.models.some(m=>m.keyAvailable))||H[0];if(!preferred){setState('No harnesses available');return;}const model=preferred.models.find(m=>m.keyAvailable)||preferred.models[0];selectedHarness=preferred.name;selectedProvider=model.provider;selectedModel=model.model;if(!model.keyAvailable)setState('Waiting for a valid model key · private machine stopped');}
const bubbles=new Map();
function addMsg(cls,tag,text,key){const c=$('chat');$('empty')?.remove();key=key||('seq:'+Date.now()+Math.random()+':'+cls);let el=bubbles.get(key);if(!el){el=document.createElement('div');el.className='msg '+cls;el.innerHTML='<div class="tag">'+esc(tag)+'</div><div class="body"></div>';c.appendChild(el);bubbles.set(key,el);}const body=el.querySelector('.body');body.textContent=stripHidden(body.textContent+text);c.scrollTop=c.scrollHeight;return el;}
function startBilling(sinceMs){if(!billing){billing=true;billSince=sinceMs||Date.now();if(!timer)timer=setInterval(renderTotals,100);}setState('Private machine running · tools active · billing live');renderTotals();}
function stopBilling(elapsed){if(billing){totalSeconds+=(elapsed!=null&&elapsed>0)?elapsed:(Date.now()-billSince)/1000;billing=false;}if(timer){clearInterval(timer);timer=null;}setState('Private machine stopped · billing paused');renderTotals();}
const activeTurns=new Map();
function abortInterruptibleSharedTurns(){for(const [id,t] of activeTurns){if(t.interruptible&&!t.boxStarted)t.controller.abort();}}
function newTurnId(){try{return (globalThis.crypto&&globalThis.crypto.randomUUID)?globalThis.crypto.randomUUID():String(Date.now()+Math.random());}catch{return String(Date.now()+Math.random());}}
async function runTurn(msg){abortInterruptibleSharedTurns();const localId=newTurnId();const controller=new AbortController();activeTurns.set(localId,{controller,interruptible:false,boxStarted:false});addMsg('user','you',msg,'user:'+localId);setState('Shared bridge starting · private machine preparing');try{const res=await fetch('/api/send',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,conversationId:selectedConversation,message:msg,harness:selectedHarness,provider:selectedProvider,model:selectedModel})});await drain(res,localId);}catch(e){if(e.name!=='AbortError'){addMsg('assistant','assistant','Something went wrong: '+String(e&&e.message||e));setState('Error · private machine state unchanged');}}finally{activeTurns.delete(localId);}}
const composer=$('composer'), msgEl=$('msg'), sendBtn=$('send');
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
msgEl.addEventListener('keydown',e=>{if((e.key==='Enter'||e.code==='Enter'||e.keyCode===13||e.which===13)&&!e.shiftKey){e.preventDefault();submitComposer('textarea.enter');}});
msgEl.addEventListener('beforeinput',e=>{if((e.inputType==='insertLineBreak'||e.inputType==='insertParagraph')&&!e.shiftKey){e.preventDefault();submitComposer('textarea.beforeinput');}});
async function drain(res,localId){if(!res){throw new Error('No response object from /api/send');}if(!res.ok){const body=await res.text().catch(()=>'');throw new Error('/api/send failed with HTTP '+res.status+' '+body);}if(!res.body){throw new Error('/api/send did not return a readable SSE body');}const reader=res.body.getReader();const dec=new TextDecoder();const sep=String.fromCharCode(10,10);const nl=String.fromCharCode(10);let buf='';while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split(sep);buf=parts.pop()||'';for(const p of parts){const line=p.split(nl).find(l=>l.startsWith('data:'));if(!line)continue;handle(JSON.parse(line.slice(5)),localId);}}}
function keyFor(ev,localId,cls){return (ev.turnId||localId)+':'+cls;}
function handle(ev,localId){console.debug('[trace] stream event', ev);const t=activeTurns.get(localId);if(t&&['handoff.started','billing.start','user-box.delta','exec'].includes(ev.type)){t.boxStarted=true;t.interruptible=false;}
  if(ev.type==='trace'){addMsg('trace','trace · '+(ev.stage||'event'),(ev.message||JSON.stringify(ev))+'\\n',keyFor(ev,localId,'trace')+':'+(ev.stage||Math.random()));if(/bridge/.test(ev.stage||''))setState('Shared bridge active · private machine preparing');else if(/backend|submit/.test(ev.stage||''))setState('Request received · shared bridge starting');}
  else if(ev.type==='turn.blocked'){addMsg('trace','blocker · '+(ev.stage||'runtime'),(ev.message||'Private runtime unavailable')+'\\n',keyFor(ev,localId,'blocked')+':'+(ev.stage||Math.random()));addMsg('assistant','assistant','Private runtime is not ready yet. This turn stayed on the shared bridge; retry when Box status is ready.');setState('Private runtime unavailable · retry after Box is ready');}
  else if(ev.type==='shared.delta'){addMsg('assistant','assistant · shared infra · no tools',ev.text,keyFor(ev,localId,'shared'));}
  else if(ev.type==='shared.larp'){setState('Shared bridge active · private machine starting/resuming');}
  else if(ev.type==='context.injected'){if(ev.scope==='shared')setState('Shared bridge ready · private machine preparing');}
  else if(ev.type==='billing.start'){startBilling(ev.sinceEpochMs);}
  else if(ev.type==='lifecycle'){if(ev.state==='resume-timeout')setState('Resume timed out · starting a fresh machine');else if(ev.state==='stopping')setState('Private machine stopping · wrapping up');else if(ev.state==='archiving')setState('Private machine archiving · billing about to pause');else if(ev.state==='archived')setState('Private machine archived · billing paused');else setState('Private machine '+String(ev.state).replace(/-/g,' '));}
  else if(ev.type==='handoff.started'){setState('Private machine running · assistant has tools');}
  else if(ev.type==='runtime.proof'){addMsg('trace','proof · no Box prompt/API','boxPromptApiUsed='+ev.boxPromptApiUsed+' · boxBuiltInAgentUsed='+ev.boxBuiltInAgentUsed+' · hostAsciiAgentUsed='+ev.hostAsciiAgentUsed+' · continuation='+ev.continuation+' · streaming='+(ev.streaming||'unknown')+(ev.blocker?' · limitation: '+ev.blocker:'' )+'\\n',keyFor(ev,localId,'proof'));}
  else if(ev.type==='exec'){setState('Private machine running · using tools');if(ev.kind==='harness')addMsg('trace','source path','Started real '+((ev.argv&&ev.argv[0])||'agent')+' harness inside the user machine; stdout/SSE relays native chunks as emitted.',keyFor(ev,localId,'exec'));}
  else if(ev.type==='harness.tool'){setState('Private machine running · using tools');const detail=ev.phase==='tool_use'?((ev.toolName||'tool')+(ev.command?': '+ev.command:'')):(ev.isError?'tool result error':'tool result')+(ev.stdout?': '+ev.stdout.trim():'');addMsg('trace','tool event · user machine',detail+'\\n',keyFor(ev,localId,'tool')+':'+ev.phase+':'+(ev.command||ev.stdout||Math.random()));}
  else if(ev.type==='user-box.delta'){addMsg('assistant','assistant · user machine · tools active',ev.text,keyFor(ev,localId,'box'));}
  else if(ev.type==='billing.stop'){stopBilling(ev.elapsedSeconds);}
  else if(ev.type==='turn.done'){setState('Turn complete · private machine may keep warm briefly');}
  else if(ev.type==='error'){addMsg('assistant','assistant','Error: '+ev.message);setState('Error · check model credentials or machine state');}}
load();
</script></body></html>`;
}
