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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>Box chat demo</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f5f1;color:#141414;line-height:1.4}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{min-height:100dvh;background:linear-gradient(180deg,#faf9f5 0%,#f1efe8 100%)}
.app{height:100dvh;max-width:720px;margin:0 auto;display:flex;flex-direction:column;background:#fff;border-left:1px solid #e2ded3;border-right:1px solid #e2ded3;box-shadow:0 24px 80px rgba(25,20,10,.08)}
.top{position:sticky;top:0;z-index:2;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);border-bottom:1px solid #e6e1d6;padding:calc(12px + env(safe-area-inset-top)) 14px 12px;display:grid;gap:10px}
.counters{display:grid;grid-template-columns:1fr 1fr;gap:8px}.counter{border:1px solid #ded8ca;background:#fbfaf7;border-radius:18px;padding:11px 12px;min-width:0}.label{display:block;color:#736b5c;text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:800}.value{display:block;margin-top:3px;font:800 21px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.state{border:1px solid #171717;background:#171717;color:#fff;border-radius:999px;padding:10px 13px;font-size:13px;font-weight:750;text-align:center;box-shadow:0 10px 24px rgba(0,0,0,.12)}
.chat{flex:1;overflow:auto;padding:16px 14px 18px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}.empty{margin:auto;color:#7c7468;text-align:center;font-size:14px;max-width:280px}.msg{max-width:86%;border-radius:20px;padding:11px 13px;font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 1px 0 rgba(0,0,0,.04)}.msg.user{align-self:flex-end;background:#111;color:#fff;border-bottom-right-radius:6px}.msg.assistant{align-self:flex-start;background:#f1efe8;color:#161616;border:1px solid #e2ded3;border-bottom-left-radius:6px}.tag{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.composer{display:flex;gap:9px;align-items:flex-end;padding:10px 14px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #e6e1d6;background:rgba(255,255,255,.97);backdrop-filter:blur(12px)}textarea{flex:1;min-height:46px;max-height:130px;resize:none;border:1px solid #d8d2c5;border-radius:18px;background:#fbfaf7;color:#111;padding:12px 13px;font:inherit;outline:none}textarea:focus{border-color:#111}button{min-height:46px;border:0;border-radius:18px;background:#111;color:#fff;padding:0 16px;font-weight:850;font:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
@media(max-width:520px){.app{max-width:none;border:0}.top{padding-left:10px;padding-right:10px}.chat{padding-left:10px;padding-right:10px}.composer{padding-left:10px;padding-right:10px}.counter{border-radius:15px;padding:10px}.value{font-size:18px}.state{font-size:12px;line-height:1.25;border-radius:16px}.msg{max-width:90%;font-size:14px}.label{font-size:9px}button{padding:0 14px}}
</style></head><body><main class="app">
  <header class="top" aria-label="machine summary">
    <section class="counters" aria-label="totals">
      <div class="counter"><span class="label">total spent</span><span class="value" id="totalCost">$0.000000</span></div>
      <div class="counter"><span class="label">machine time</span><span class="value" id="totalSeconds">0.0s</span></div>
    </section>
    <div class="state" id="machineState">Shared chat ready · private machine stopped</div>
  </header>
  <section class="chat" id="chat" aria-live="polite"><div class="empty" id="empty">Send a message to start the demo.</div></section>
  <form class="composer" id="composer">
    <textarea id="msg" placeholder="Message…" aria-label="Message"></textarea>
    <button id="send" type="submit">Send</button>
  </form>
</main>
<script>
let H=[]; let PRICING=null; let selectedHarness='', selectedProvider='', selectedModel='', selectedUser='user-a';
let timer=null, billSince=0, billRate=0, billing=false, totalSeconds=0;
const $=id=>document.getElementById(id);
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function stripHidden(s){return String(s).replace(/<consumer-context>[\s\S]*?<\/consumer-context>/g,'').trim();}
function fmtUsd(n){return '$'+n.toFixed(6);}
function setState(text){$('machineState').textContent=text;}
function activeSeconds(){return totalSeconds+(billing?(Date.now()-billSince)/1000:0);}
function renderTotals(){const seconds=activeSeconds();$('totalSeconds').textContent=seconds.toFixed(1)+'s';$('totalCost').textContent=fmtUsd(seconds*billRate);}
async function load(){const r=await fetch('/api/harnesses');const j=await r.json();H=j.harnesses;PRICING=j.pricing;billRate=PRICING.ratePerSecond;chooseDefaultModel();renderTotals();}
function chooseDefaultModel(){const preferred=H.find(h=>h.models.some(m=>m.keyAvailable))||H[0];if(!preferred){setState('No harnesses available');return;}const model=preferred.models.find(m=>m.keyAvailable)||preferred.models[0];selectedHarness=preferred.name;selectedProvider=model.provider;selectedModel=model.model;if(!model.keyAvailable)setState('Waiting for a valid model key · private machine stopped');}
const bubbles=new Map();
function addMsg(cls,tag,text,key){const c=$('chat');$('empty')?.remove();key=key||('seq:'+Date.now()+Math.random()+':'+cls);let el=bubbles.get(key);if(!el){el=document.createElement('div');el.className='msg '+cls;el.innerHTML='<div class="tag">'+esc(tag)+'</div><div class="body"></div>';c.appendChild(el);bubbles.set(key,el);}const body=el.querySelector('.body');body.textContent=stripHidden(body.textContent+text);c.scrollTop=c.scrollHeight;return el;}
function startBilling(sinceMs){if(!billing){billing=true;billSince=sinceMs||Date.now();if(!timer)timer=setInterval(renderTotals,100);}setState('Private machine running · tools active · billing live');renderTotals();}
function stopBilling(elapsed){if(billing){totalSeconds+=(elapsed!=null&&elapsed>0)?elapsed:(Date.now()-billSince)/1000;billing=false;}if(timer){clearInterval(timer);timer=null;}setState('Private machine stopped · billing paused');renderTotals();}
const activeTurns=new Map();
function abortInterruptibleSharedTurns(){for(const [id,t] of activeTurns){if(t.interruptible&&!t.boxStarted)t.controller.abort();}}
async function runTurn(msg){abortInterruptibleSharedTurns();const localId=(crypto.randomUUID?crypto.randomUUID():String(Date.now()+Math.random()));const controller=new AbortController();activeTurns.set(localId,{controller,interruptible:false,boxStarted:false});addMsg('user','you',msg,'user:'+localId);setState('Shared chat thinking · private machine stopped');try{const res=await fetch('/api/send',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,conversationId:'conv-1',message:msg,harness:selectedHarness,provider:selectedProvider,model:selectedModel})});await drain(res,localId);}catch(e){if(e.name!=='AbortError'){addMsg('assistant','assistant','Something went wrong: '+String(e&&e.message||e));setState('Error · private machine state unchanged');}}finally{activeTurns.delete(localId);}}
$('composer').addEventListener('submit',e=>{e.preventDefault();const msg=$('msg').value.trim();if(!msg)return;$('msg').value='';runTurn(msg);});
$('msg').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('composer').requestSubmit();}});
async function drain(res,localId){const reader=res.body.getReader();const dec=new TextDecoder();let buf='';while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split('\n\n');buf=parts.pop();for(const p of parts){const line=p.split('\n').find(l=>l.startsWith('data:'));if(!line)continue;handle(JSON.parse(line.slice(5)),localId);}}}
function keyFor(ev,localId,cls){return (ev.turnId||localId)+':'+cls;}
function handle(ev,localId){const t=activeTurns.get(localId);if(t&&ev.type==='shared.larp'&&ev.toolIntent===false)t.interruptible=true;if(t&&['handoff.started','billing.start','user-box.delta','exec'].includes(ev.type)){t.boxStarted=true;t.interruptible=false;}
  if(ev.type==='shared.delta'){addMsg('assistant','assistant',ev.text,keyFor(ev,localId,'shared'));}
  else if(ev.type==='shared.larp'){setState(ev.toolIntent?'Private machine starting · preparing tools':'Shared chat replying · private machine stopped');}
  else if(ev.type==='context.injected'){if(ev.scope==='shared')setState('Shared chat ready · private machine stopped');}
  else if(ev.type==='billing.start'){startBilling(ev.sinceEpochMs);}
  else if(ev.type==='lifecycle'){if(ev.state==='resume-timeout')setState('Resume timed out · starting a fresh machine');else if(ev.state==='stopping')setState('Private machine stopping · wrapping up');else if(ev.state==='archiving')setState('Private machine archiving · billing about to pause');else if(ev.state==='archived')setState('Private machine archived · billing paused');else setState('Private machine '+String(ev.state).replace(/-/g,' '));}
  else if(ev.type==='handoff.started'){setState('Private machine running · assistant has tools');}
  else if(ev.type==='exec'){setState('Private machine running · using tools');}
  else if(ev.type==='user-box.delta'){addMsg('assistant','assistant',ev.text,keyFor(ev,localId,'box'));}
  else if(ev.type==='billing.stop'){stopBilling(ev.elapsedSeconds);}
  else if(ev.type==='turn.done'){setState(ev.route==='shared-only'?'Shared chat ready · private machine stopped':'Turn complete · private machine may keep warm briefly');}
  else if(ev.type==='error'){addMsg('assistant','assistant','Error: '+ev.message);setState('Error · check model credentials or machine state');}}
load();
</script></body></html>`;
}
