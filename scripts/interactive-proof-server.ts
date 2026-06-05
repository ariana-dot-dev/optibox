import http from "node:http";
import { URL } from "node:url";
import {
  BoxHttpClient,
  assertNoBoxAgent,
  BOX_PRICING,
  ConsumerBoxAgentOrchestrator,
  InMemorySessionStore,
  createRestrictedSharedCapabilities,
  type ConsumerTurnEvent,
} from "../src/index.js";
import { providerEnvForBox, providerKey } from "../examples/shared.js";
import { harness as claude } from "../examples/claude-sdk/adapter.js";
import { harness as opencode } from "../examples/opencode/adapter.js";
import { harness as pi } from "../examples/pi/adapter.js";

const apiKey = process.env.BOX_API_KEY;
if (!apiKey)
  throw new Error(
    "BOX_API_KEY is required; this server refuses to run without the real Box credential.",
  );

const port = Number(process.env.PORT ?? 4178);
const box = assertNoBoxAgent(new BoxHttpClient({ apiKey })); // runtime proof: Box's built-in agent is forbidden
// Prefer Claude/Anthropic when its key is configured; the client still falls back to OpenCode/OpenAI if Anthropic is absent.
const allHarnesses = [claude, opencode, pi];
const orchestrator = new ConsumerBoxAgentOrchestrator({
  box,
  harnesses: allHarnesses,
  sessions: new InMemorySessionStore(),
  providerEnv: providerEnvForBox(),
  sharedBoxName: "consumer-agent-shared-prewarm",
  userBoxName: (userId) => `consumer-agent-user-${userId}`,
  userBoxTtlSeconds: 900,
  readinessPollMs: 2000,
  handoffTimeoutMs: 180_000,
  resumeTimeoutMs: 20_000,
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
          },
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
        for await (const event of orchestrator.runTurn({
          userId: String(body.userId ?? "user-a"),
          conversationId: String(body.conversationId ?? "conv-1"),
          message: String(body.message ?? ""),
          selection,
        })) {
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
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Box agent demo</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fff;color:#111;line-height:1.45}
*{box-sizing:border-box}body{margin:0}.page{max-width:1120px;margin:0 auto;padding:24px}
h1{font-size:22px;line-height:1.2;margin:0}.sub{margin:4px 0 0;color:#666;font-size:13px}.title{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#666;font-weight:700;margin:0 0 12px}.shell{display:grid;grid-template-columns:minmax(0,1fr) 340px;border-left:1px solid #d9d9d9;border-top:1px solid #d9d9d9}.cell{border-right:1px solid #d9d9d9;border-bottom:1px solid #d9d9d9;padding:16px;background:#fff}.header,.controls{grid-column:1/-1}.controls{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end}.field{display:grid;gap:6px;font-size:12px;color:#555}.field select{min-width:180px}select,textarea{background:#fff;color:#111;border:1px solid #cfcfcf;border-radius:0;padding:10px;font:inherit}button{background:#111;color:#fff;border:1px solid #111;border-radius:0;padding:10px 14px;font-weight:650;cursor:pointer}button.stop{background:#fff;color:#555;border:0;padding:0;font-size:12px;font-weight:600;text-decoration:underline;text-underline-offset:2px}button:disabled{opacity:.5;cursor:not-allowed}
.chat-panel{min-height:500px;display:flex;flex-direction:column}.chat{height:360px;overflow:auto;border:1px solid #d9d9d9;background:#fff;padding:12px;display:flex;flex-direction:column;gap:10px}.msg{padding:10px 12px;border:1px solid #d9d9d9;max-width:88%;background:#fff}.msg.user{align-self:flex-end;background:#111;color:#fff;border-color:#111}.msg.shared,.msg.box{align-self:flex-start}.msg.swap{align-self:center;max-width:96%;color:#444;font-size:12px}.tag{font-size:11px;color:#666;margin-bottom:4px}.msg.user .tag{color:#ddd}.composer{display:flex;gap:10px;margin-top:12px}textarea{resize:vertical;min-height:52px;flex:1}.activity{min-height:16px;text-align:right;font-size:11px;color:#666;margin-top:6px}
.side{display:grid;grid-template-rows:auto auto minmax(0,1fr)}.money{display:grid;grid-template-columns:1fr 1fr;border-left:1px solid #d9d9d9;border-top:1px solid #d9d9d9}.metric{padding:12px;border-right:1px solid #d9d9d9;border-bottom:1px solid #d9d9d9}.metric .label{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.04em}.metric .value{font:700 18px ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:4px}.rows{display:grid;gap:0}.row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #eee;font-size:13px}.row:last-child{border-bottom:0}.row span:first-child{color:#666}.billing-controls{display:flex;align-items:baseline;gap:10px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.status{font-weight:700}.steps{display:grid;gap:8px;margin-top:12px}.step{display:flex;gap:8px;align-items:center;color:#777;font-size:13px}.step:before{content:"";width:8px;height:8px;border:1px solid #aaa;background:#fff}.step.on{color:#111;font-weight:650}.step.on:before{background:#111;border-color:#111}.log{height:170px;overflow:auto;border:1px solid #d9d9d9;padding:10px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:#333}.line{padding:4px 0;border-bottom:1px solid #eee}.line:last-child{border-bottom:0}.ok,.warn,.err,.acc,.mag{color:#111}
@media(max-width:900px){.shell,.controls{grid-template-columns:1fr}.header,.controls{grid-column:auto}.field select{min-width:0}.chat{height:420px}.composer{flex-direction:column}}
</style></head><body><main class="page">
  <section class="shell">
    <header class="cell header">
      <h1>Box demo</h1>
      <p class="sub">Lifecycle, live cost, harness/model, status, and chat.</p>
    </header>

    <section class="cell controls">
      <label class="field">Harness<select id="harness"></select></label>
      <label class="field">Model<select id="model"></select></label>
      <label class="field">User<select id="user"><option>user-a</option><option>user-b</option></select></label>
    </section>

    <section class="cell chat-panel">
      <p class="title">Chat</p>
      <div class="chat" id="chat"></div>
      <div class="composer">
        <textarea id="msg" placeholder="Type a message…"></textarea>
        <div><button id="send">Send</button><div id="qpill" class="activity"></div></div>
      </div>
    </section>

    <aside class="side">
      <section class="cell">
        <p class="title">Live cost</p>
        <div class="money">
          <div class="metric"><div class="label">Cost</div><div class="value" id="cost">$0.000000</div></div>
          <div class="metric"><div class="label">Time</div><div class="value" id="elapsed">0.0s</div></div>
          <div class="metric"><div class="label">Rate</div><div class="value" id="rate">—</div></div>
          <div class="metric"><div class="label">30 days</div><div class="value" id="proj">—</div></div>
        </div>
        <p class="sub" id="valueprop"></p>
      </section>

      <section class="cell">
        <p class="title">Box lifecycle / infra</p>
        <div class="rows">
          <div class="row"><span>Status</span><b id="statusText" class="status">idle</b></div>
          <div class="row"><span>Box</span><span id="boxid" class="mono">—</span></div>
          <div class="row"><span>Location</span><span id="loc">shared · no tools</span></div>
          <div class="row"><span>Billing</span><span class="billing-controls"><span id="billstate">stopped · $0</span><button class="stop" id="stop">stop box</button></span></div>
          <div class="row"><span>Last event</span><span id="lastEvent" class="mono">—</span></div>
        </div>
        <div class="steps" id="steps">
          <span class="step" data-s="ready">Ready</span>
          <span class="step" data-s="running">Running + billing</span>
          <span class="step" data-s="stopping">Stopping</span>
          <span class="step" data-s="archiving">Archiving</span>
          <span class="step" data-s="archived">Archived</span>
          <span class="step" data-s="billing-stopped">Billing stopped</span>
        </div>
      </section>

      <section class="cell">
        <p class="title">Progress</p>
        <div class="log" id="log"></div>
      </section>
    </aside>
  </section>
</main>
<script>
let H=[]; let ENV={}; let PRICING=null;
let timer=null, billSince=0, billRate=0, billFrozen=0, billing=false, lastSec=0;
const $=id=>document.getElementById(id);
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function stripHidden(s){return String(s).replace(/<consumer-context>[\\s\\S]*?<\\/consumer-context>/g,'').trim();}
function fmtUsd(n){return '$'+n.toFixed(6);}
function setStatus(text){$('statusText').textContent=text;$('lastEvent').textContent=new Date().toLocaleTimeString();}
function log(level,src,msg,data){const el=$('log');const d=data?'\\n  '+esc(JSON.stringify(data)):'';el.insertAdjacentHTML('beforeend','<div class="line">['+esc(src)+'] '+esc(msg)+d+'</div>');el.scrollTop=el.scrollHeight;}
function setStep(s){document.querySelectorAll('.step').forEach(e=>{if(e.dataset.s===s)e.classList.add('on');});}
function clearSteps(){document.querySelectorAll('.step').forEach(e=>e.classList.remove('on'));}
function setLoc(loc,tools){$('loc').textContent=loc+(tools?' · tools':' · no tools');}
async function load(){const r=await fetch('/api/harnesses');const j=await r.json();H=j.harnesses;ENV=j.env;PRICING=j.pricing;
  $('rate').textContent='$'+PRICING.ratePerSecond.toFixed(5)+'/s';
  billRate=PRICING.ratePerSecond;
  $('valueprop').textContent='Cost only increases while the user Box is running.';
  const preferred=H.find(h=>h.models.some(m=>m.keyAvailable))||H[0];
  $('harness').innerHTML=H.map(h=>'<option value="'+h.name+'"'+(preferred&&h.name===preferred.name?' selected':'')+'>'+h.name+'</option>').join('');
  fillModels();
  log('ok','ready','demo loaded');}
function fillModels(){const h=H.find(x=>x.name===$('harness').value);const preferred=h.models.findIndex(m=>m.keyAvailable);$('model').innerHTML=h.models.map((m,i)=>'<option value="'+m.provider+'|'+m.model+'"'+(i===(preferred>=0?preferred:0)?' selected':'')+'>'+(m.label||m.model)+(m.keyAvailable?'':' (needs key)')+'</option>').join('');}
$('harness').onchange=()=>{fillModels();log('warn','switch','harness -> '+$('harness').value);};
$('model').onchange=()=>log('warn','switch','model -> '+$('model').value);
const bubbles=new Map();
function addMsg(cls,tag,text,key){const c=$('chat');key=key||('seq:'+Date.now()+Math.random()+':'+cls);let el=bubbles.get(key);if(!el){el=document.createElement('div');el.className='msg '+cls;el.innerHTML='<div class="tag">'+esc(tag)+'</div><div class="body"></div>';c.appendChild(el);bubbles.set(key,el);}el.querySelector('.body').textContent=stripHidden(el.querySelector('.body').textContent+text);c.scrollTop=c.scrollHeight;return el;}
function tick(){const sec=billFrozen+(billing?(Date.now()-billSince)/1000:0);lastSec=sec;$('elapsed').textContent=sec.toFixed(1)+'s';const cost=sec*billRate;$('cost').textContent=fmtUsd(cost);$('proj').textContent='$'+(cost*30).toFixed(2);}
function startBilling(sinceMs){billing=true;billSince=sinceMs||Date.now();$('billstate').textContent='running · billing';setStatus('billing');setStep('running');if(!timer)timer=setInterval(tick,100);tick();}
function stopBilling(elapsed,cost){billing=false;if(timer){clearInterval(timer);timer=null;}billFrozen=0;$('billstate').textContent='stopped · $0';const sec=(elapsed!=null&&elapsed>0)?elapsed:lastSec;const c=(elapsed!=null&&elapsed>0)?cost:lastSec*billRate;$('elapsed').textContent=sec.toFixed(1)+'s final';$('cost').textContent=fmtUsd(c);setStatus('stopped');}
const activeTurns=new Map();
function updateActivity(){const n=activeTurns.size;$('qpill').textContent=n?(n+' active'):'';}
function abortInterruptibleSharedTurns(){for(const [id,t] of activeTurns){if(t.interruptible&&!t.boxStarted){t.controller.abort();log('warn','interrupt','cancelled stale shared stream '+id.slice(0,8));}}}
async function runTurn(msg){abortInterruptibleSharedTurns();const localId=(crypto.randomUUID?crypto.randomUUID():String(Date.now()+Math.random()));const controller=new AbortController();activeTurns.set(localId,{controller,interruptible:false,boxStarted:false});updateActivity();addMsg('user','you',msg,'user:'+localId);clearSteps();const [provider,model]=$('model').value.split('|');const harness=$('harness').value;log('acc','send','turn: '+harness+' / '+model);setStatus('sending');try{const res=await fetch('/api/send',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({userId:$('user').value,conversationId:'conv-1',message:msg,harness,provider,model})});await drain(res,localId);}catch(e){if(e.name==='AbortError')log('warn','interrupt','shared stream aborted');else log('err','send',String(e&&e.message||e));}finally{activeTurns.delete(localId);updateActivity();}}
$('send').onclick=()=>{const msg=$('msg').value.trim();if(!msg)return;$('msg').value='';runTurn(msg);};
$('msg').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('send').onclick();}});
async function drain(res,localId){const reader=res.body.getReader();const dec=new TextDecoder();let buf='';while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split('\\n\\n');buf=parts.pop();for(const p of parts){const line=p.split('\\n').find(l=>l.startsWith('data:'));if(!line)continue;handle(JSON.parse(line.slice(5)),localId);}}}
function keyFor(ev,localId,cls){return (ev.turnId||localId)+':'+cls;}
function handle(ev,localId){const t=activeTurns.get(localId);if(t&&ev.type==='shared.larp'&&ev.toolIntent===false)t.interruptible=true;if(t&&['handoff.started','billing.start','user-box.delta','exec'].includes(ev.type)){t.boxStarted=true;t.interruptible=false;}
  if(ev.type==='shared.delta'){addMsg('shared','shared · '+ev.harness,ev.text,keyFor(ev,localId,'shared'));}
  else if(ev.type==='shared.larp'){log('acc','shared',ev.note);setStatus(ev.toolIntent?'starting box':'shared reply');}
  else if(ev.type==='context.injected'){setLoc(ev.machine.location,ev.machine.tools);log('acc','context',ev.machine.location+' tools='+ev.machine.tools);if(ev.scope==='shared')setStep('ready');}
  else if(ev.type==='billing.start'){setStep('ready');startBilling(ev.sinceEpochMs);log('ok','billing','started on Box '+ev.boxId);}
  else if(ev.type==='lifecycle'){if(ev.boxId)$('boxid').textContent=ev.boxId;if(['stopping','archiving','archived','resume-timeout'].includes(ev.state))setStep(ev.state);log(ev.state==='resume-timeout'?'warn':'ok','box',(ev.note||ev.state)+' '+ev.boxId+' ['+ev.state+']');setStatus(ev.state);}
  else if(ev.type==='handoff.started'){log('ok','handoff','Box '+ev.boxId+' · '+ev.harness+'/'+ev.model);addMsg('box',ev.harness+' · '+ev.model+' · Box '+ev.boxId,'',keyFor(ev,localId,'box'));setStatus('running in box');}
  else if(ev.type==='exec'){log('acc','exec',ev.kind+': '+esc((ev.argv?ev.argv.join(' '):ev.command||'').slice(0,200)));}
  else if(ev.type==='user-box.delta'){addMsg('box',ev.harness+' · '+ev.model+' · Box '+ev.boxId,ev.text,keyFor(ev,localId,'box'));}
  else if(ev.type==='billing.stop'){stopBilling(ev.elapsedSeconds,ev.costUsd);setStep('billing-stopped');log('warn','billing',ev.note+' · '+ev.elapsedSeconds.toFixed(1)+'s = '+fmtUsd(ev.costUsd));}
  else if(ev.type==='turn.done'){log('ok','done','turn complete route='+(ev.route||'')+' box='+(ev.boxId||'—'));setStatus('idle');}
  else if(ev.type==='error'){log('err','error',ev.message);setStatus('error');}}
let stopping=false;
$('stop').onclick=async()=>{if(stopping)return;stopping=true;$('stop').disabled=true;clearSteps();log('warn','lifecycle','stop requested');setStatus('stopping');try{const res=await fetch('/api/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:$('user').value,conversationId:'conv-1'})});await drain(res);}finally{stopping=false;$('stop').disabled=false;}};
load();
</script></body></html>`;
}
