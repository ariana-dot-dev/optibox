// Per-device identity. Boxes are named per userId server-side, so a shared link
// with a fixed id would put every visitor on ONE box (shared files, one billing
// meter, colliding turns). Derive a stable id from a browser fingerprint plus a
// persisted random suffix — the fingerprint separates device models even when
// storage is wiped; the random suffix separates two identical devices; the
// localStorage cache keeps the SAME device on the SAME box (and its files)
// across reloads. Every branch is guarded so the headless client test (no
// navigator/screen/localStorage/crypto) still falls back to a random id.
function fnv1a(s){let h=0x811c9dc5>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return h.toString(36);}
function canvasFp(){try{var c=document.createElement('canvas');var x=c.getContext('2d');if(!x)return'nocanvas';x.textBaseline='top';x.font="14px 'Arial'";x.fillStyle='#f60';x.fillRect(0,0,80,20);x.fillStyle='#069';x.fillText('optibox-fp-😀-☃',2,2);return c.toDataURL();}catch(_){return'nocanvas';}}
function deviceUserId(){
  try{var q=new URLSearchParams(location.search).get('userId');if(q)return q;}catch(_){}
  try{var s=localStorage.getItem('optibox_uid');if(s)return s;}catch(_){}
  var id;
  try{
    var n=navigator, sig=[n.userAgent,n.language,(n.languages||[]).join(','),n.platform,n.hardwareConcurrency,n.deviceMemory,screen.width+'x'+screen.height+'x'+screen.colorDepth,window.devicePixelRatio,Intl.DateTimeFormat().resolvedOptions().timeZone,new Date().getTimezoneOffset(),canvasFp()].join('|');
    var fp=fnv1a(sig)+fnv1a(sig.split('').reverse().join('')+'x');
    var rnd;try{var a=new Uint8Array(6);crypto.getRandomValues(a);rnd=Array.from(a).map(function(b){return(b%36).toString(36);}).join('');}catch(_){rnd=Math.random().toString(36).slice(2,8);}
    id='u-'+fp+'-'+rnd;
    try{localStorage.setItem('optibox_uid',id);}catch(_){}
  }catch(_){id='u-'+Math.random().toString(36).slice(2,10);}
  return id;
}
// The conversation id must PERSIST across reloads (url > localStorage > new),
// or reopening the app would start a fresh conversation and its history would
// be empty. This is what makes reopen-and-restore resume the SAME conversation.
function persistConversationId(id){try{localStorage.setItem('optibox_conv',id);}catch(_){}return id;}
function loadConversationId(){
  try{var q=new URLSearchParams(location.search).get('conversationId');if(q)return persistConversationId(q);}catch(_){}
  try{var s=localStorage.getItem('optibox_conv');if(s)return s;}catch(_){}
  return persistConversationId('conv-'+Math.random().toString(36).slice(2,10));
}
let H=[]; let PRICING=null; let HARNESS_META={serverKeysAllowed:false,credentialMode:'byok-required',env:{}}; let selectedHarness='', selectedProvider='', selectedModel='', selectedUser=deviceUserId(), selectedConversation=loadConversationId();
let timer=null, billSince=0, billRate=0, billing=false, totalSeconds=0;
let autoStopInterval=null, autoStopDeadline=0, autoStopBoxId=null;
const $=id=>document.getElementById(id);
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
const SETTINGS_KEY='optibox.demo.settings.v1';
function readSettings(){try{return JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')||{};}catch{return {};}}
function writeSettings(next){localStorage.setItem(SETTINGS_KEY,JSON.stringify(next));}
function has(v){return typeof v==='string'&&v.trim().length>0;}
function clientProviderKeyAvailable(provider){const s=readSettings();if(provider==='anthropic')return has(s.anthropicApiKey)||Boolean(HARNESS_META.env&&HARNESS_META.env.ANTHROPIC_API_KEY);if(provider==='openrouter')return has(s.openrouterApiKey)||Boolean(HARNESS_META.env&&HARNESS_META.env.OPENROUTER_API_KEY);return has(s.openaiApiKey)||Boolean(HARNESS_META.env&&HARNESS_META.env.OPENAI_API_KEY);}
function clientBoxKeyAvailable(){const s=readSettings();return has(s.boxApiKey)||Boolean(HARNESS_META.env&&HARNESS_META.env.BOX_API_KEY);}
function currentApiKeys(){const s=readSettings();return {boxApiKey:s.boxApiKey||'',anthropicApiKey:s.anthropicApiKey||'',openaiApiKey:s.openaiApiKey||'',openrouterApiKey:s.openrouterApiKey||''};}
function selectedModelOption(){const h=H.find(x=>x.name===selectedHarness);return h&&h.models.find(m=>m.provider===selectedProvider&&m.model===selectedModel);}
function currentSettingsStatus(){const model=selectedModelOption();if(!clientBoxKeyAvailable())return {ok:false,msg:'BOX_API_KEY required for this preview.'};if(model&&!clientProviderKeyAvailable(model.provider))return {ok:false,msg:(model.requiredEnv||'Provider key')+' required for '+(model.label||model.model)+'.'};return {ok:true,msg:HARNESS_META.serverKeysAllowed&&!Object.values(currentApiKeys()).some(Boolean)?'Using private server keys for this preview.':'BYOK credentials ready.'};}
function updateSettingsStatus(){const st=currentSettingsStatus();const el=$('settingsStatus');if(el){el.className='settingsStatus '+(st.ok?'okText':'dangerText');el.textContent=st.msg;}if(!st.ok)setState('Settings required · '+st.msg);}
function renderSettingsControls(){const hs=$('settingsHarness'), ms=$('settingsModel');if(!hs||!ms)return;hs.innerHTML=H.map(h=>'<option value="'+esc(h.name)+'">'+esc(h.name)+'</option>').join('');hs.value=selectedHarness;const h=H.find(x=>x.name===selectedHarness);ms.innerHTML=(h?h.models:[]).map(m=>'<option value="'+esc(m.provider+'|'+m.model)+'">'+esc((m.label||m.model)+' · '+m.requiredEnv+(clientProviderKeyAvailable(m.provider)?' ✓':''))+'</option>').join('');ms.value=selectedProvider+'|'+selectedModel;updateSettingsStatus();}
function openSettings(){const s=readSettings();if(!$('settingsBackdrop')||!$('settingsBoxKey'))return;$('settingsBoxKey').value=s.boxApiKey||'';$('settingsAnthropicKey').value=s.anthropicApiKey||'';$('settingsOpenaiKey').value=s.openaiApiKey||'';$('settingsOpenrouterKey').value=s.openrouterApiKey||'';renderSettingsControls();$('settingsBackdrop').classList.add('open');$('settingsHarness').focus();}
function closeSettings(){if($('settingsBackdrop'))$('settingsBackdrop').classList.remove('open');}
function saveSettings(){writeSettings({boxApiKey:$('settingsBoxKey').value.trim(),anthropicApiKey:$('settingsAnthropicKey').value.trim(),openaiApiKey:$('settingsOpenaiKey').value.trim(),openrouterApiKey:$('settingsOpenrouterKey').value.trim(),harness:selectedHarness,provider:selectedProvider,model:selectedModel});renderSettingsControls();updateSettingsStatus();closeSettings();}
function clearSettings(){writeSettings({harness:selectedHarness,provider:selectedProvider,model:selectedModel});$('settingsBoxKey').value='';$('settingsAnthropicKey').value='';$('settingsOpenaiKey').value='';$('settingsOpenrouterKey').value='';renderSettingsControls();}
const hiddenContextPattern=new RegExp('<consumer-context>[\s\S]*?</consumer-context>','g');
// Never trim the ACCUMULATED buffer: deltas arrive in pieces, and a mid-stream
// trim eats the whitespace joint between chunks ("them." + "\n" + "Good," →
// "them.Good,"). Trim only the display copy, recomputed from full raw anyway.
function stripHidden(s){return String(s).replace(hiddenContextPattern,'');}
function fmtUsd(n){return '$'+n.toFixed(6);}
const routeState={phase:'idle',boxId:null,billing:false,finalRoute:null,done:false};
function setRoute(route,text){const r=$('routeStatus');if(r)r.textContent=text||'';}
// The Backend diagram is painted from routeState alone: one function decides which
// node is lit, whether it is "processing", where the packet sits, and when the
// answer is delivered back to You. A single message emoji travels the arrows.
function diagramStage(){const p=routeState.phase,box=routeState.boxId;
  if(routeState.done)return {owner:box?'private':'shared',packet:'you',deliver:true};
  if(p==='error')return {owner:'private',packet:'private',error:true};
  if(!p||(p==='idle'&&!box))return {owner:null,packet:'you',hidden:true};
  if(p==='accepted')return {owner:'shared',packet:'shared',proc:true,traveling:true};
  if(p==='shared-bridge'||p==='shared')return {owner:'shared',packet:'shared',proc:true};
  if(p==='shared-delta')return {owner:'shared',packet:'you',deliver:true};
  if(p==='handoff')return {owner:'private',packet:'private',traveling:true};
  if(['starting','provisioning','provisioned','cloning','resuming','resume-timeout'].includes(p))return {owner:'private',packet:'private',proc:true};
  if(p==='tools')return {owner:'private',packet:'private',proc:true,tools:true};
  if(p==='user-box')return {owner:'private',packet:'you',deliver:true};
  if(['ready','running','billing','runtime-proof'].includes(p)||(p==='idle'&&box))return {owner:'private',packet:'private',proc:true};
  return {owner:'shared',packet:'shared',proc:true};}
function paintDiagram(){const s=$('schematic'),packet=$('packet');if(!s||!packet||!packet.style)return;const d=diagramStage();
  const nodes={you:s.querySelector('.user-node'),shared:s.querySelector('.shared-node'),private:s.querySelector('.private-node')};
  for(const k in nodes){const n=nodes[k];if(!n)continue;n.dataset.active=(d.owner===k)?'1':'0';n.dataset.proc=(d.proc&&d.owner===k)?'1':'0';n.dataset.tools=(d.tools&&k==='private')?'1':'0';n.dataset.deliver=(d.deliver&&k==='you')?'1':'0';}
  s.dataset.route=d.error?'error':(d.owner==='private'?'private':d.owner==='shared'?'shared':'idle');
  const target=nodes[d.packet||'you'];if(target){packet.style.left=(target.offsetLeft+target.offsetWidth)+'px';packet.style.top=target.offsetTop+'px';}
  packet.style.opacity=d.hidden?'0':'1';
  var kind=d.deliver?'ok':d.error?'warn':'mail';
  if(packet.dataset.kind!==kind){packet.dataset.kind=kind;packet.innerHTML=PACKET_ICONS[kind];}}
var PACKET_ICONS={
mail:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM203.43,64,128,133.15,52.57,64ZM216,192H40V74.19l82.59,75.71a8,8,0,0,0,10.82,0L216,74.19V192Z"/></svg>',
ok:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"/></svg>',
warn:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM222.93,203.8a8.5,8.5,0,0,1-7.48,4.2H40.55a8.5,8.5,0,0,1-7.48-4.2,7.59,7.59,0,0,1,0-7.72L120.52,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.93,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z"/></svg>'};
function setState(text){$('machineState').textContent=text;}
function fmtAutoStopRemaining(ms){return Math.max(0,Math.ceil(ms/1000))+'s';}
function clearAutoStopTimer(label){autoStopDeadline=0;autoStopBoxId=null;if(autoStopInterval){clearInterval(autoStopInterval);autoStopInterval=null;}$('autoStopTimer').textContent=label||'idle';}
function renderAutoStopTimer(){if(!autoStopDeadline){$('autoStopTimer').textContent='idle';return;}const remaining=Math.max(0,autoStopDeadline-Date.now());$('autoStopTimer').textContent=remaining<=0?'stopping…':fmtAutoStopRemaining(remaining);if(remaining<=0&&autoStopInterval){clearInterval(autoStopInterval);autoStopInterval=null;}}
function startAutoStopTimer(ev){autoStopDeadline=ev.deadlineEpochMs||(Date.now()+Math.max(0,ev.remainingMs||0));autoStopBoxId=ev.boxId||autoStopBoxId;renderAutoStopTimer();if(autoStopInterval)clearInterval(autoStopInterval);autoStopInterval=setInterval(renderAutoStopTimer,200);}
function describeAutoStop(ev){const remaining=fmtAutoStopRemaining(ev.remainingMs||0);if(ev.phase==='started'||ev.phase==='tick')return 'Assistant done · user idle · Box auto-stops in '+remaining;if(ev.phase==='held')return 'Auto-stop paused · Box still needed (uploading / composing)';if(ev.phase==='stopping')return 'Auto-stop countdown reached 0s · stopping Box now';if(ev.phase==='canceled')return 'Auto-stop timer reset · new message is using the Box';return ev.note||'Auto-stop timer updated';}
function boxLabel(id){return id&&id!=='pending'?' · '+id:'';}
function resetRouteForTurn(){clearAutoStopTimer('paused');routeState.phase='accepted';routeState.boxId=null;routeState.billing=false;routeState.finalRoute=null;routeState.done=false;setRoute('shared','message accepted · checking Box state, opening the shared bridge');paintDiagram();}
function routeIsPrivate(){return Boolean(routeState.boxId)||['billing','starting','provisioning','provisioned','cloning','resuming','ready','idle','running','handoff','runtime-proof','tools','user-box'].includes(routeState.phase);}
function routeEvent(ev){_routeEvent(ev);if(ev.type==='turn.done')routeState.done=true;paintDiagram();}
function _routeEvent(ev){
  if(ev.type==='stream.end')return;
  if(ev.type==='error'||ev.type==='turn.blocked'){routeState.phase='error';setRoute('error','Route error: private runtime did not complete; see trace for the real event.');return;}
  if(ev.type==='trace'&&/backend|submit/.test(ev.stage||'')){routeState.phase='accepted';setRoute('shared','Route: backend accepted the message; shared bridge is live while Box status resolves.');return;}
  if(ev.type==='trace'&&ev.stage==='route.direct'){routeState.phase='user-box';setRoute('private','Route: private Box is warm; message routed directly to it (no shared bridge).');return;}
  if(ev.type==='trace'&&ev.stage==='shared.bridge.start'){if(routeIsPrivate()){setRoute('private','Route: shared agent is answering first while private Box status continues'+boxLabel(routeState.boxId)+'.');return;}routeState.phase='shared-bridge';setRoute('shared','Route: shared agent answers first while the private Box starts/resumes.');return;}
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
async function load(){const r=await fetch('/api/harnesses');const j=await r.json();H=j.harnesses;PRICING=j.pricing;HARNESS_META={serverKeysAllowed:j.serverKeysAllowed===undefined?true:Boolean(j.serverKeysAllowed),credentialMode:j.credentialMode||(j.serverKeysAllowed===false?'byok-required':'server-or-byok'),env:j.env||{BOX_API_KEY:true,ANTHROPIC_API_KEY:H.some(h=>h.models.some(m=>m.provider==='anthropic'&&m.keyAvailable)),OPENAI_API_KEY:H.some(h=>h.models.some(m=>m.provider==='openai'&&m.keyAvailable)),OPENROUTER_API_KEY:H.some(h=>h.models.some(m=>m.provider==='openrouter'&&m.keyAvailable))}};billRate=PRICING.ratePerSecond;chooseDefaultModel();renderSettingsControls();const note=$('settingsNote');if(note)note.textContent=HARNESS_META.serverKeysAllowed?'Private preview: configured server keys are available; BYOK overrides them.':'Public/dev preview: server keys are disabled. Add your own Box and model provider keys.';renderTotals();paintDiagram();if(!currentSettingsStatus().ok)openSettings();}
function chooseDefaultModel(){const saved=readSettings();const savedHarness=H.find(h=>h.name===saved.harness);const savedModel=savedHarness&&savedHarness.models.find(m=>m.provider===saved.provider&&m.model===saved.model);if(savedHarness&&savedModel&&clientProviderKeyAvailable(savedModel.provider)){selectedHarness=savedHarness.name;selectedProvider=savedModel.provider;selectedModel=savedModel.model;return;}const preferred=H.find(h=>h.models.some(m=>clientProviderKeyAvailable(m.provider)))||H[0];if(!preferred){setState('No harnesses available');return;}const model=preferred.models.find(m=>clientProviderKeyAvailable(m.provider))||preferred.models[0];selectedHarness=preferred.name;selectedProvider=model.provider;selectedModel=model.model;if(!clientProviderKeyAvailable(model.provider)||!clientBoxKeyAvailable())setState('Waiting for BYOK settings · private machine stopped');}
const bubbles=new Map();
// ONE working indicator, owned by the latest turn. Concurrent/superseded turns
// never create a second one (fixes the double "working…"). It is shown while the
// latest turn is unanswered and removed the moment that turn reaches a terminal
// event — never by an older, still-draining turn.
let workingEl=null;
// Stick-to-bottom ONLY when the user is already reading the bottom: forced
// scrolls on every event (auto-stop ticks re-render a hidden trace bubble every
// second) yank the user down while they are reading history.
function chatStick(c){return (c.scrollHeight||0)-(c.scrollTop||0)-(c.clientHeight||0)<90;}
function showWorking(){const c=$('chat');const stick=chatStick(c);$('empty')?.remove();if(!workingEl){workingEl=document.createElement('div');workingEl.className='working';workingEl.textContent='working';}moveWorkingToBottom();if(stick)c.scrollTop=c.scrollHeight;}
// The "working…" indicator lives in the FOOTER of the message currently streaming
// (activeBoxKey), so it reads as "this message is still being written". When no
// message is streaming — a fresh turn, or the last message is already finalized —
// it falls back to a standalone line at the bottom of the chat.
function moveWorkingToBottom(){if(!workingEl)return;const host=activeBoxKey?bubbles.get(activeBoxKey):null;if(host){workingEl.classList.add('inMsg');host.appendChild(workingEl);}else{workingEl.classList.remove('inMsg');$('chat').appendChild(workingEl);}}
function clearWorking(){if(workingEl){workingEl.remove();workingEl=null;}}
let showTraces=false;
function syncTraceVisibility(){document.body.classList.toggle('hide-traces',!showTraces);}
// Markdown-lite. RegExp-from-string only: this script text must parse BOTH as
// the served page and inside the source-level regression harness, and regex
// literals with backslashes cannot be valid at both escape levels.
// GFM pipe tables. Runs on already-escaped text, BEFORE the inline passes, so
// each cell still gets bold/code formatting after. Line-based (no regex) to stay
// clear of the inline-script escape rules; a table is a row containing '|'
// followed by an all-[-:| ] separator row that also has a '|'. Emits the whole
// table on ONE line so the bubble's pre-wrap doesn't inject blank lines inside.
function mdTables(s){
  const lines=s.split('\n');const out=[];let i=0;let inCode=false;
  const isSep=function(l){const t=l.trim();if(t.indexOf('-')<0)return false;for(let k=0;k<t.length;k++){const ch=t.charAt(k);if(ch!=='-'&&ch!==':'&&ch!=='|'&&ch!==' ')return false;}return true;};
  const cells=function(l){let t=l.trim();if(t.charAt(0)==='|')t=t.slice(1);if(t.charAt(t.length-1)==='|')t=t.slice(0,-1);return t.split('|').map(function(x){return x.trim();});};
  while(i<lines.length){
    const line=lines[i];const tl=line.trim();
    if(tl.slice(0,3)==='```'){inCode=!inCode;out.push(line);i++;continue;}
    if(!inCode&&line.indexOf('|')>=0&&i+1<lines.length&&isSep(lines[i+1])&&lines[i+1].indexOf('|')>=0){
      const head=cells(line);let j=i+2;const rows=[];
      while(j<lines.length&&lines[j].indexOf('|')>=0&&lines[j].trim()!==''){rows.push(cells(lines[j]));j++;}
      let h='<table class="mdt"><thead><tr>';for(let a=0;a<head.length;a++)h+='<th>'+head[a]+'</th>';h+='</tr></thead><tbody>';
      for(let r=0;r<rows.length;r++){h+='<tr>';for(let c=0;c<head.length;c++)h+='<td>'+(rows[r][c]||'')+'</td>';h+='</tr>';}
      h+='</tbody></table>';out.push(h);i=j;continue;
    }
    out.push(line);i++;
  }
  return out.join('\n');
}
function md(t){let s=esc(t);
s=mdTables(s);
s=s.replace(new RegExp('```[A-Za-z]*\\n?([\\s\\S]*?)```','g'),function(_,c){return '<pre><code>'+c.replace(new RegExp('\\n$'),'')+'</code></pre>';});
s=s.replace(new RegExp('`([^`\\n]+)`','g'),'<code>$1</code>');
s=s.replace(new RegExp('\\*\\*([^*]+)\\*\\*','g'),'<strong>$1</strong>');
s=s.replace(new RegExp('(^|[\\s(])\\*([^*\\n]+)\\*(?=[\\s).,!?:;]|$)','g'),'$1<em>$2</em>');
s=s.replace(new RegExp('\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)','g'),'<a href="$2" target="_blank" rel="noopener">$1</a>');
s=s.replace(new RegExp('^#{1,6}\\s+(.+)$','gm'),'<strong class="mdh">$1</strong>');
s=s.replace(new RegExp('^[ ]*(?:[-*]|[0-9]+[.])[ ]+(.+)$','gm'),'<span class="mdli">$1</span>');
s=s.replace(new RegExp('\\n?(<pre>)','g'),'$1').replace(new RegExp('(</pre>)\\n?','g'),'$1');
return s;}
// One live desktop widget per reply loop: the FIRST desktop-touching tool call
// of a turn embeds the box's desktop stream (view-only until clicked); later
// desktop calls in the same turn reuse it; a new turn's widget ends the old
// one. (Cross-origin iframes cannot be recorded client-side, so no replay.)
// Default mode is the box's OWN desktop stream (Moonlight, 60fps), embedded at
// 480p via moonlight-web's width/height URL params (verified in
// /opt/moonlight-web/static/stream.js). noVNC is the fallback behind "switch to
// VNC" — plain websockets, for networks that block WebRTC/UDP where Moonlight
// never connects. It was briefly the default for that reason; that traded the
// good stream away from everyone to spare the minority a click.
function capStreamRes(url,vnc){
  if(vnc){
    // The API's noVNC URL bakes resize=remote (ask the SERVER to resize the X
    // session), which the box's VNC server doesn't honor — the desktop then
    // renders 1:1 native pixels inside the 540px preview: zoomed-in AND
    // cropped. resize=scale scales the remote framebuffer client-side to fit
    // the iframe (letterboxed, whole desktop visible).
    if(/[?&]resize=/.test(url)) return url.replace(/([?&])resize=[^&]*/,'$1resize=scale');
    return url+(url.indexOf('?')>=0?'&':'?')+'resize=scale';
  }
  return url+(url.indexOf('?')>=0?'&':'?')+'width=854&height=480';
}
var desktopWidget=null;
var DESKTOP_MARKS=['xdotool','wmctrl','xdg-open','ydotool','wtype','scrot','DISPLAY=','chromium','google-chrome','firefox','lux '];
function isDesktopCommand(cmd){cmd=String(cmd||'');for(var i=0;i<DESKTOP_MARKS.length;i++)if(cmd.indexOf(DESKTOP_MARKS[i])>=0)return true;return false;}
function endDesktopWidget(){if(!desktopWidget)return;try{if(desktopWidget.frame)desktopWidget.frame.src='about:blank';}catch(_){}desktopWidget.el.classList.add('ended');var tag=desktopWidget.el.querySelector('.desktopTag span');if(tag)tag.textContent='desktop · session ended';desktopWidget=null;}
// A finished desktop session recording (box-side ffmpeg, emitted at round end).
// Swaps the live stream widget for a seekable <video> IN PLACE — or, on replay
// (where the live widget was never created), makes a fresh one. Reads the mp4
// via /api/fs/read, which serves it from the box OR its snapshot, so playback
// works long after the machine parked. Not gated by isLatest/replaying: the
// recording should render live AND on reopen.
async function renderDesktopRecording(ev,localId){
  const c=$('chat');if(!c)return;const stick=chatStick(c);
  let el=(desktopWidget&&desktopWidget.localId===localId)?desktopWidget.el:null;
  if(el&&desktopWidget){try{if(desktopWidget.frame)desktopWidget.frame.src='about:blank';}catch(_){}desktopWidget=null;}
  if(!el){$('empty')?.remove();el=document.createElement('div');el.className='msg desktop';el.innerHTML='<div class="desktopTag"><span>desktop · session recording</span></div><div class="desktopWrap"></div>';c.appendChild(el);}
  el.classList.remove('ended');
  const tag=el.querySelector('.desktopTag span');if(tag)tag.textContent='desktop · session recording';
  const wrap=el.querySelector('.desktopWrap');if(!wrap)return;
  wrap.innerHTML='<div class="desktopNote">loading recording…</div>';if(stick)c.scrollTop=c.scrollHeight;
  // The event can land BEFORE the bytes are servable: ffmpeg may still be
  // flushing the moov atom on a long turn, and the snapshot fallback only
  // contains the clip once the post-turn stop completes. Retry for ~60s before
  // declaring the recording unavailable — previously a single shot, which is
  // why it said "recording unavailable" until a manual reload.
  const attempt=(el.__recAttempt||0)+1;el.__recAttempt=attempt;
  for(let i=0;i<24;i++){
    if(el.__recAttempt!==attempt)return;
    try{
      const res=await fetch('/api/fs/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,path:ev.path,apiKeys:currentApiKeys()})});
      if(!res.ok)throw new Error('read '+res.status);
      const url=URL.createObjectURL(new Blob([await res.arrayBuffer()],{type:'video/mp4'}));
      if(el.__recAttempt!==attempt)return;
      const v=document.createElement('video');v.className='desktopFrame';v.src=url;v.controls=true;v.playsInline=true;v.preload='metadata';
      wrap.innerHTML='';wrap.appendChild(v);
      if(!el.querySelector('a.dtDownload')){const links=el.querySelector('.dtLinks')||(function(){const s=document.createElement('span');s.className='dtLinks';el.querySelector('.desktopTag').appendChild(s);return s;})();const a=document.createElement('a');a.className='dtDownload';a.textContent='download';a.href=url;a.download=String(ev.path||'desktop.mp4').split('/').pop();links.appendChild(a);}
      break;
    }catch(e){
      if(i===23){if(el.__recAttempt===attempt)wrap.innerHTML='<div class="desktopNote">recording unavailable</div>';}
      else await new Promise(function(r){setTimeout(r,2500);});
    }
  }
  if(stick)c.scrollTop=c.scrollHeight;
}
function ensureDesktopWidget(localId){
  if(desktopWidget&&desktopWidget.localId===localId)return;
  endDesktopWidget();
  const c=$('chat');const stick=chatStick(c);$('empty')?.remove();
  const el=document.createElement('div');el.className='msg desktop';
  el.innerHTML='<div class="desktopTag"><span>desktop · connecting</span><span class="dtLinks"><a href="#" class="dtVnc" style="display:none">switch to VNC</a><a href="#" class="dtOpen" target="_blank" rel="noopener" style="display:none">open in tab</a></span></div><div class="desktopWrap"><div class="desktopNote">starting desktop stream…</div></div>';
  c.appendChild(el);moveWorkingToBottom();if(stick)c.scrollTop=c.scrollHeight;
  // The box's own stream first; VNC stays one click away for networks that
  // block WebRTC.
  desktopWidget={localId:localId,el:el,frame:null,vnc:false};
  el.querySelector('a.dtVnc').addEventListener('click',function(e){e.preventDefault();swapDesktopMode(desktopWidget);});
  attachDesktopStream(desktopWidget);
}
// In-place stream/VNC switch: the Moonlight WebRTC stream never connects on
// some networks (UDP/WebRTC blocked); noVNC rides plain websockets and loads
// where Moonlight can't. Swaps the SAME preview iframe's src — never a new
// tab. Polls while the VNC server provisions (~20s on first switch).
async function swapDesktopMode(w){
  if(!w||desktopWidget!==w||w.switching)return;
  w.switching=true;w.vnc=!w.vnc;
  var vlink=w.el.querySelector('a.dtVnc');if(vlink)vlink.textContent=w.vnc?'switch to stream':'switch to VNC';
  var target=w.vnc?'VNC':'stream';
  var tag=w.el.querySelector('.desktopTag span');if(tag)tag.textContent='desktop · switching to '+target+'…';
  try{
    // Cold VNC provisioning: the box's noVNC server is started on first switch
    // and can take ~30-60s to come up (measured). Poll patiently (~90s) and
    // surface the API's live status ("Preparing VNC desktop…") so the wait
    // never looks frozen. Each poll also renews the server-side box hold, so
    // the machine can't park out from under a switch in progress.
    for(var i=0;i<45;i++){
      if(desktopWidget!==w)return;
      const res=await fetch('/api/fs/desktop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,vnc:w.vnc,apiKeys:currentApiKeys()})});
      const j=await res.json();
      if(desktopWidget!==w)return;
      if(j.ok&&j.desktopUrl&&!j.provisioning){
        if(w.frame)w.frame.src=capStreamRes(j.desktopUrl,w.vnc);
        var open=w.el.querySelector('a.dtOpen');if(open)open.href=j.desktopUrl;
        if(tag)tag.textContent='desktop · '+(w.vnc?'VNC':'live');
        return;
      }
      if(j.ok===false){if(tag)tag.textContent='desktop · switch failed: '+(j.message||'machine is off');return;}
      if(tag)tag.textContent='desktop · '+(j.message||'preparing '+target+'…');
      await new Promise(function(r){setTimeout(r,2000);});
    }
    if(tag)tag.textContent='desktop · '+target+' is slow to start — tap “switch to '+target+'” to retry';
  }catch(_){if(tag)tag.textContent='desktop · switch failed';}
  finally{w.switching=false;}
}
async function attachDesktopStream(w){
  for(var i=0;i<30;i++){
    if(desktopWidget!==w)return;
    try{
      const res=await fetch('/api/fs/desktop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,...(w.vnc?{vnc:true}:{}),apiKeys:currentApiKeys()})});
      const j=await res.json();
      if(desktopWidget!==w)return;
      if(j.ok&&j.desktopUrl&&!j.provisioning){
        const wrap=w.el.querySelector('.desktopWrap');
        const frame=document.createElement('iframe');
        frame.className='desktopFrame';frame.setAttribute('allow','clipboard-read; clipboard-write; fullscreen; autoplay; pointer-lock; gamepad');frame.src=capStreamRes(j.desktopUrl,w.vnc);
        const overlay=document.createElement('div');overlay.className='desktopOverlay';overlay.innerHTML='<span>click to take over</span>';
        overlay.addEventListener('click',function(){overlay.remove();var tag=w.el.querySelector('.desktopTag span');if(tag)tag.textContent='desktop · interactive';});
        wrap.innerHTML='';wrap.appendChild(frame);wrap.appendChild(overlay);
        w.frame=frame;
        var tag=w.el.querySelector('.desktopTag span');if(tag)tag.textContent='desktop · '+(w.vnc?'VNC':'live');
        var link=w.el.querySelector('.desktopTag a.dtOpen');if(link){link.href=j.desktopUrl;link.style.display='';}
        var vl=w.el.querySelector('.desktopTag a.dtVnc');if(vl)vl.style.display='';
        // Heartbeat: renew the server-side desktop hold while this widget's
        // turn is still running, so the machine stays up under the stream.
        // Renew ONLY while the agent's turn is still producing its answer. Keying
        // off boxDone (set on turn.done), not the SSE lifetime: the stream stays
        // open after the answer to carry auto-stop ticks, and renewing across
        // that window pins the box forever (the desktop hold keeps the turn
        // "active", which keeps renewing the hold — the box never stops). Once
        // renewal ceases the 45s TTL lapses and the countdown/reaper stop the box.
        (async function(){
          const alive=function(){const t=activeTurns.get(w.localId);return desktopWidget===w&&t&&!t.boxDone;};
          while(alive()){
            await new Promise(function(r){setTimeout(r,20000);});
            if(!alive())return;
            try{await fetch('/api/fs/desktop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,apiKeys:currentApiKeys()})});}catch(_){}
          }
        })();
        return;
      }
      if(j.ok===false){var n1=w.el.querySelector('.desktopNote');if(n1)n1.textContent='desktop unavailable: '+(j.message||'machine is off');return;}
    }catch(_){}
    await new Promise(function(r){setTimeout(r,2000);});
  }
  var n2=w.el.querySelector('.desktopNote');if(n2)n2.textContent='desktop stream did not start';
}
function addMsg(cls,tag,text,key){const c=$('chat');const stick=cls==='user'||chatStick(c);$('empty')?.remove();key=key||('seq:'+Date.now()+Math.random()+':'+cls);let el=bubbles.get(key);const isNew=!el;const isBox=cls==='assistant'&&!!tag&&/machine/.test(tag);
// Reset the running tool chain only when a genuinely NEW bubble appears. A message
// that keeps streaming (same key) then keeps stacking its interleaved tool calls
// into ONE chain, instead of spawning a fresh numbered chain every speak/tool loop.
if(cls!=='trace'&&isNew)currentToolChain=null;
if(isNew){el=document.createElement('div');el.className='msg '+cls;el.innerHTML=(tag?'<div class="tag">'+esc(tag)+'</div>':'')+'<div class="body"></div>';c.appendChild(el);bubbles.set(key,el);}
const body=el.querySelector('.body');
// A new speak segment landing in a bubble that already has text (a tool call ran
// between speaks) starts a fresh paragraph, so successive speaks in one message
// don't run together into an unreadable wall of text.
let incoming=String(text==null?'':text);
if(isBox&&!isNew&&boxBreakPending&&body.dataset.raw)incoming='\n\n'+incoming;
if(isBox)boxBreakPending=false;
const raw=stripHidden((body.dataset.raw||'')+incoming);body.dataset.raw=raw;const shown=stripEndSentinel(stripFileDecl(raw)).trim();body.textContent=shown;if(cls==='assistant'||cls==='user')body.innerHTML=md(shown);
// Rule 6: a box round that emits ONLY the <end> silence sentinel must render
// NOTHING — no empty "user machine" bubble. Collapse it; it re-shows if real
// text streams in later (reversible per render).
if(isBox&&el.style)el.style.display=shown.trim()?'':'none';
if(cls==='assistant'||cls==='user')applyClamp(el,key);
moveWorkingToBottom();if(stick)c.scrollTop=c.scrollHeight;return el;}
// Long messages collapse to COLLAPSE_LINES with a Show more / Show less toggle,
// so a chatty streamed message doesn't bury the rest of the conversation. The
// bubble that is still actively streaming (activeBoxKey) is never clamped, so the
// user always sees the live tail; it collapses once the turn moves on.
const COLLAPSE_LINES=7;
function applyClamp(el,key){const body=el&&el.querySelector('.body');if(!body)return;const lh=parseFloat(getComputedStyle(body).lineHeight)||20;
// scrollHeight is the full content height even while max-height clamps the body,
// so the line count stays accurate without un-clamping (no flicker). A message
// clamps as soon as it passes the threshold — including while it is still
// streaming — and the label counts the hidden lines live, so you watch it grow
// without expanding. A manual expand (userExpanded) is respected across renders.
const total=Math.round(body.scrollHeight/lh);let btn=el.querySelector('.msgMore');
if(total<=COLLAPSE_LINES+0.5){el.classList.remove('clamped');if(btn)btn.remove();return;}
el.style.setProperty('--clamp-px',Math.round(lh*COLLAPSE_LINES)+'px');el.dataset.hiddenLines=String(Math.max(1,total-COLLAPSE_LINES));
if(!btn){btn=document.createElement('button');btn.className='msgMore';btn.type='button';btn.addEventListener('click',function(){const nowClamped=el.classList.toggle('clamped');el.dataset.userExpanded=nowClamped?'':'1';btn.textContent=nowClamped?clampMoreLabel(el):'Show less';});el.appendChild(btn);}
if(el.dataset.userExpanded==='1'){el.classList.remove('clamped');btn.textContent='Show less';}
else{el.classList.add('clamped');btn.textContent=clampMoreLabel(el);}}
// The collapsed label counts the hidden lines ("Show 24 more lines") and updates
// on every render, so a message that keeps growing while collapsed shows it is
// still growing without the reader having to expand it.
function clampMoreLabel(el){const n=parseInt(el.dataset.hiddenLines||'0',10)||0;return 'Show '+n+' more line'+(n===1?'':'s');}
// The box agent declares files it created/modified in a trailing tag
// <optibox-files>a, b</optibox-files> (see the FILE MANIFEST instruction). Strip
// it from the visible chat (even a partial one mid-stream) and parse the names.
function stripFileDecl(s){s=String(s);const i=s.indexOf('<optibox');return (i>=0?s.slice(0,i):s).trimEnd();}
// Rule 6: <end> is the box agent's intentional-silence sentinel — the host must
// NEVER show it. The server now withholds any trailing partial while streaming
// ("<", "<end" — see engine.ts), so it should never arrive; strip BOTH a
// complete trailing sentinel and a trailing partial prefix here anyway, as a
// display safety net (also cleans replays of pre-fix journals). A bare-<end>
// message collapses to empty (see addMsg); partials re-render correctly because
// the raw buffer keeps every byte.
function stripEndSentinel(s){return String(s).replace(/\s*<end>\s*$/i,'').replace(/<(e(n(d)?)?)?$/i,'');}
function parseFileDecl(s){s=String(s);const a=s.indexOf('<optibox-files');if(a<0)return [];const b=s.indexOf('>',a);if(b<0)return [];const c=s.indexOf('</optibox-files',b);const inner=c>=0?s.slice(b+1,c):s.slice(b+1);const out=[];const seen={};inner.split(',').forEach(function(x){let t=x.trim();while(t.charAt(0)==='.'||t.charAt(0)==='/')t=t.slice(1);if(t&&!seen[t]){seen[t]=1;out.push(t);}});return out;}
const toolChains=[];
let currentToolChain=null;
let toolSeq=0;
// Set when a tool call runs; the next box speak that lands in the same bubble
// inserts a paragraph break before its text (see addMsg). activeBoxKey is the key
// of the box message currently streaming — it is never clamped and it hosts the
// "working…" footer.
let boxBreakPending=false;
let activeBoxKey=null;
function toolLabel(count){return count+' tool call'+(count===1?'':'s');}
function isToolFinished(call){return call.state==='finished'||call.state==='error';}
function compactToolText(value,limit){const text=String(value||'').trim();if(!text)return '';return text.length>limit?text.slice(0,limit)+'…':text;}
function toolTitle(call){return call.toolName||'tool';}
function toolStateFromEvent(ev){if(ev.isError)return 'error';if(ev.phase==='tool_result')return ev.isError?'error':'finished';if(ev.stdout||ev.stderr)return ev.isError?'error':'finished';return 'running';}
function findRunningTool(){for(let i=toolChains.length-1;i>=0;i--){const chain=toolChains[i];for(let j=chain.calls.length-1;j>=0;j--){if(!isToolFinished(chain.calls[j]))return chain.calls[j];}}return null;}
function ensureToolChain(localId){const c=$('chat');const stick=chatStick(c);$('empty')?.remove();if(currentToolChain)return currentToolChain;const id='tool-chain:'+(localId||'turn')+':'+toolChains.length+':'+Date.now();const el=document.createElement('div');el.className='toolChain';el.setAttribute('data-tool-chain-id',id);el.innerHTML='<div class="toolChainSummary" role="button" tabindex="0" aria-expanded="false"><span class="toolChainLabel">0 tool calls</span><span class="toolChainEllipsis" aria-hidden="true"></span><span class="toolChainChevron" aria-hidden="true">›</span></div><div class="toolChainDetails"></div>';const summary=el.querySelector('.toolChainSummary');summary.addEventListener('click',()=>toggleToolChain(chain));summary.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleToolChain(chain);}});c.appendChild(el);const chain={id,el,summary,label:el.querySelector('.toolChainLabel'),details:el.querySelector('.toolChainDetails'),calls:[],open:false,lastCount:0};toolChains.push(chain);currentToolChain=chain;moveWorkingToBottom();if(stick)c.scrollTop=c.scrollHeight;return chain;}
function toggleToolChain(chain){chain.open=!chain.open;chain.el.classList.toggle('open',chain.open);chain.summary.setAttribute('aria-expanded',String(chain.open));}
function renderToolChain(chain){const cc=$('chat');const stick=chatStick(cc);const count=chain.calls.length;chain.label.textContent=toolLabel(count);if(count!==chain.lastCount){chain.label.classList.remove('bump');void chain.label.offsetWidth;chain.label.classList.add('bump');setTimeout(()=>chain.label.classList.remove('bump'),180);chain.lastCount=count;}const running=chain.calls.some(c=>!isToolFinished(c));chain.el.classList.toggle('running',running);chain.details.innerHTML=chain.calls.map((call,idx)=>{const status=call.state==='error'?'error':(isToolFinished(call)?'finished':'running');const bits=[];if(call.command)bits.push('command: '+compactToolText(call.command,300));if(call.description)bits.push('description: '+compactToolText(call.description,300));if(call.stderr)bits.push('stderr: '+compactToolText(call.stderr,800));const out=call.stdout?'<pre class="toolCallOutput">'+esc(compactToolText(call.stdout,2000))+'</pre>':'';return '<div class="toolCallDetail"><div class="toolCallHead">'+(idx+1)+'. '+esc(toolTitle(call))+' · '+esc(status)+'</div>'+(bits.length?'<div class="toolCallMeta">'+esc(bits.join('\n'))+'</div>':'')+out+'</div>';}).join('');if(stick)cc.scrollTop=cc.scrollHeight;}
function addToolEvent(ev,localId){let chain=currentToolChain;if(ev.phase==='tool_result'){const running=findRunningTool();if(running){Object.assign(running,{state:toolStateFromEvent(ev),stdout:ev.stdout||running.stdout||'',stderr:ev.stderr||running.stderr||'',isError:Boolean(ev.isError),resultSeen:true});const owner=toolChains.find(ch=>ch.calls.includes(running));if(owner)renderToolChain(owner);return owner&&owner.el;}}
chain=ensureToolChain(localId);const call={id:'tool-'+(++toolSeq),toolName:ev.toolName||'tool',command:ev.command||'',description:ev.description||'',stdout:ev.stdout||'',stderr:ev.stderr||'',isError:Boolean(ev.isError),state:toolStateFromEvent(ev),resultSeen:ev.phase==='tool_result'};chain.calls.push(call);renderToolChain(chain);
// A tool ran, so the next speak into the current box bubble opens a new paragraph.
boxBreakPending=true;return chain.el;}
function startBilling(sinceMs){if(!billing){billing=true;billSince=sinceMs||Date.now();if(!timer)timer=setInterval(renderTotals,100);}document.body.dataset.billing='1';setWarmingPulse(false);setState('private machine running · tools active · billing live');renderTotals();}
// totalSeconds ownership: the SERVER's cumulative billedSecondsTotal is the one
// truth (applyRuntimeStatus ASSIGNS it from every snapshot). The += here is only
// an optimistic bridge so the display doesn't dip in the sub-second gap between
// a billing.stop event and the next snapshot — assignment then overwrites it,
// so the client total can never drift from what was actually billed.
// reconciled=true: the caller is a runtime snapshot whose billedSecondsTotal
// ALREADY contains the just-ended window (it was assigned a line earlier in
// applyRuntimeStatus) — folding it here too would double-count. SSE events
// (no snapshot in hand) fold optimistically and the next snapshot overwrites.
function stopBilling(elapsed,reconciled){if(billing){if(!reconciled)totalSeconds+=(elapsed!=null&&elapsed>0)?elapsed:(Date.now()-billSince)/1000;billing=false;}if(timer){clearInterval(timer);timer=null;}delete document.body.dataset.billing;setWarmingPulse(false);clearAutoStopTimer('stopped');setState('private machine stopped · billing paused');renderTotals();}
// Reconcile ALL machine counters from the polled runtime snapshot (rides every
// fs tree poll). This is the ground truth: a machine woken by typing or an
// upload has no SSE stream, so without this the counter/cost/auto-stop UI
// simply never learns it is running. SSE turn events still land first and
// faster; this corrects drift and covers the streams that don't exist.
// Hosting indicator: the box is intentionally staying up because it exposes a
// hosted service (host CLI). Badge + stop button live in the header; state
// arrives on the same runtime snapshot as every other counter.
// Hosting bar: one uncluttered strip under the header. One service -> its URL
// + a single stop button. Several -> "hosting N services" toggles a compact
// dropdown with one row (link + stop) per service; the bar button stops all.
let hostingList=[];
async function stopHostingReq(port){
  try{
    await fetch('/api/host/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,...(port?{port}:{}),apiKeys:currentApiKeys()})});
    hostingList=port?hostingList.filter(h=>h.port!==port):[];
    syncHostingBar(hostingList);
    try{window.__optiboxFs.poke();}catch(_){}
  }catch(e){addMsg('assistant','error','Stop hosting failed: '+String(e&&e.message||e));}
}
function hostLabel(h){return (h.url||'').replace(/^https?:[/][/]/i,'')||(':'+h.port+' '+h.mode);}
function syncHostingBar(list){
  try{
    list=Array.isArray(list)?list:[];hostingList=list;
    const bar=$('hostingBar');if(!bar||!bar.style)return;
    const menu=document.getElementById&&document.getElementById('hbMenu');
    if(!list.length){bar.style.display='none';if(menu)menu.remove();return;}
    bar.style.display='flex';
    const text=$('hbText'),link=$('hbLink'),stop=$('hbStop');
    if(list.length===1){
      const h=list[0];
      if(text)text.textContent='hosting';
      if(link&&link.style){if(h.url){link.textContent=hostLabel(h);link.href=h.url;link.style.display='';}else{link.style.display='none';}}
      if(!h.url&&text)text.textContent='hosting :'+h.port+' '+h.mode;
      if(stop)stop.textContent='stop hosting';
      if(menu)menu.remove();
      if(text)text.style&&(text.style.cursor='');text&&(text.onclick=null);
    }else{
      if(link&&link.style)link.style.display='none';
      if(text){text.textContent='hosting '+list.length+' services ▾';if(text.style)text.style.cursor='pointer';
        text.onclick=()=>{
          let m=document.getElementById('hbMenu');
          if(m){m.remove();return;}
          m=document.createElement('div');m.id='hbMenu';m.className='hbMenu';
          hostingList.forEach(h=>{
            const row=document.createElement('div');row.className='hbRow';
            const a=document.createElement('a');a.target='_blank';a.rel='noopener noreferrer';a.textContent=hostLabel(h);if(h.url)a.href=h.url;row.appendChild(a);
            const b=document.createElement('button');b.type='button';b.className='hbStop';b.textContent='stop';b.onclick=()=>{stopHostingReq(h.port);const mm=document.getElementById('hbMenu');if(mm)mm.remove();};row.appendChild(b);
            m.appendChild(row);
          });
          bar.appendChild(m);
        };}
      if(stop)stop.textContent='stop all';
    }
  }catch(_){}
}
$('hbStop')?.addEventListener('click',()=>stopHostingReq());
function applyRuntimeStatus(rt){
  if(!rt)return;
  syncHostingBar(rt.hosting||[]);
  // Authoritative assignment (never +=): the server accumulates billed seconds
  // in ONE place (endBilling) and every snapshot carries the total, so the
  // header is a pure projection: total + live window since billingSinceEpochMs.
  if(typeof rt.billedSecondsTotal==='number'&&isFinite(rt.billedSecondsTotal))totalSeconds=rt.billedSecondsTotal;
  const turnActiveClient=activeTurns.size>0;
  if(rt.billingSinceEpochMs){
    if(!billing)startBilling(rt.billingSinceEpochMs);
    // Holds ("still needed": typing, uploads, desktop) freeze the countdown even
    // during a turn tail — checked BEFORE deferring to the live stream, because
    // the stream goes silent while held and the client's local timer would
    // otherwise free-run to zero. Freezing during active generation is a no-op
    // (no countdown is shown then), so this is always safe.
    if(rt.holds&&rt.holds.length){clearAutoStopTimer('held');setState('private machine held · '+rt.holds.join(', '));return;}
    if(rt.activeTurn||turnActiveClient)return; // the live turn stream owns the display
    if(rt.idleStopEtaEpochMs&&(!autoStopDeadline||Math.abs(autoStopDeadline-rt.idleStopEtaEpochMs)>2000)){
      startAutoStopTimer({deadlineEpochMs:rt.idleStopEtaEpochMs,boxId:rt.boxId});
      setState('private machine idle · auto-stop counting down');
    }
  }else if(billing&&!turnActiveClient){
    stopBilling(null,true);
  }
}
const activeTurns=new Map();
// The most recently sent turn. Only its events drive the side diagram and the
// working indicator, so overlapping turns (rapid <30s sends, interrupt semantics)
// can't desync the graph or leave a stale indicator.
let latestLocalId=null;
let lastAgentMsgEl=null;
let lastSharedMsgEl=null;
function abortInterruptibleSharedTurns(){for(const [id,t] of activeTurns){if(t.interruptible&&!t.boxStarted)t.controller.abort();}}
function newTurnId(){try{return (globalThis.crypto&&globalThis.crypto.randomUUID)?globalThis.crypto.randomUUID():String(Date.now()+Math.random());}catch{return String(Date.now()+Math.random());}}
async function runTurn(msg,files,opts){opts=opts||{};clearAutoStopTimer('paused');abortInterruptibleSharedTurns();const localId=newTurnId();latestLocalId=localId;const controller=new AbortController();activeTurns.set(localId,{controller,interruptible:false,boxStarted:false,boxDone:false,startSeconds:activeSeconds()});document.body.dataset.busy='1';
  const userEl=addMsg('user','',msg,'user:'+localId);
  let atts=[];
  if(files&&files.length){
    // Files staged while composing are already in the box — send just their
    // name (alreadyUploaded); only un-staged ones ship bytes with the message.
    atts=await Promise.all(files.map(async f=>({name:f.name.replace(/[\/\\]/g,'_'),b64:f.__uploaded?'':await readAsB64(f),bytes:new Uint8Array(await f.arrayBuffer()),uploaded:Boolean(f.__uploaded)})));
    renderAttachDeck(userEl,atts,'right');
  }
  // Tell the agent where the files landed so it can use them. Voice messages
  // skip the note: the transcript already IS the message, and naming an audio
  // file only makes the shared model apologise about not "processing audio".
  // Files still upload silently so they show in chat and the panel.
  const sendMsg=(atts.length&&!opts.silent)?msg+'\n\n[Attached files, saved in /home/user/attachments/: '+atts.map(a=>a.name).join(', ')+']':msg;
  const attachPayload=atts.map(a=>a.uploaded?{name:a.name,alreadyUploaded:true}:{name:a.name,contentB64:a.b64});
  showWorking();setState('shared bridge starting · private Box boot requested');resetRouteForTurn();
  try{const res=await fetch('/api/send',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,conversationId:selectedConversation,message:sendMsg,harness:selectedHarness,provider:selectedProvider,model:selectedModel,apiKeys:currentApiKeys(),attachments:attachPayload})});await drain(res,localId);}catch(e){if(e.name!=='AbortError'){addMsg('assistant','error','Something went wrong: '+String(e&&e.message||e));setState('Error · private machine state unchanged');}}finally{if(localId===latestLocalId)clearWorking();activeTurns.delete(localId);if(activeTurns.size===0)delete document.body.dataset.busy;}}
const composer=$('composer'), msgEl=$('msg'), sendBtn=$('send');
const stopBtn=$('stopBox');
const diagnosticsBtn=$('downloadDiagnostics');
const showTracesEl=$('showTraces');
if(showTracesEl){showTracesEl.checked=false;showTracesEl.addEventListener('change',()=>{showTraces=Boolean(showTracesEl.checked);syncTraceVisibility();});}
$('settingsOpen')?.addEventListener('click',openSettings);$('settingsClose')?.addEventListener('click',closeSettings);$('settingsSave')?.addEventListener('click',saveSettings);$('settingsClear')?.addEventListener('click',clearSettings);$('settingsBackdrop')?.addEventListener('click',e=>{if(e.target===$('settingsBackdrop'))closeSettings();});$('settingsHarness')?.addEventListener('change',e=>{selectedHarness=e.target.value;const h=H.find(x=>x.name===selectedHarness);const m=h&&h.models[0];if(m){selectedProvider=m.provider;selectedModel=m.model;}renderSettingsControls();});$('settingsModel')?.addEventListener('change',e=>{const [provider,model]=String(e.target.value).split('|');selectedProvider=provider;selectedModel=model;renderSettingsControls();});
syncTraceVisibility();
let lastSubmitAt=0;
// ---- attachments ----------------------------------------------------------
// Files the user attached to the NEXT message. Each carries its bytes so the
// chat deck previews and opens them locally (no box needed to view), and they
// upload into the box under attachments/ so the panel and the agent see them.
let pendingFiles=[];
const IMG_RE=/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const VID_RE=/\.(mp4|m4v|mov|ogv)$/i;
const AUD_RE=/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i;
const MIC_SVG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M80,128V64a48,48,0,0,1,96,0v64a48,48,0,0,1-96,0Zm128,0a8,8,0,0,0-16,0,64,64,0,0,1-128,0,8,8,0,0,0-16,0,80.11,80.11,0,0,0,72,79.6V240a8,8,0,0,0,16,0V207.6A80.11,80.11,0,0,0,208,128Z"/></svg>';
const X_SVG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>';
function isAudioName(n){return AUD_RE.test(n)||/^voice-/i.test(n)||(/\.webm$/i.test(n)&&/^voice-/i.test(n));}
function fileExt(n){const p=(n.split('.').pop()||'').toLowerCase();return p.length>4?'file':p;}
function readAsB64(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]||'');r.onerror=()=>rej(new Error('read failed'));r.readAsDataURL(file);});}
function addPendingFiles(list){for(const f of list){if(pendingFiles.length>=12)break;if(f.size>150*1024*1024){addMsg('trace','attachment','"'+f.name+'" is over the 150MB message-attachment limit — drop it on the Files panel instead (larger uploads allowed there)\n');continue;}pendingFiles.push(f);stageAttachment(f);}renderPending();notifyComposing();}
// Eagerly stage the attachment into the box the moment it lands in the
// composer (raw binary, wakes a parked machine). Send then just references it
// (alreadyUploaded) instead of re-shipping the bytes; removing it before send
// deletes it from the box again.
function stageAttachment(f){
  f.__dest='attachments/'+f.name.replace(/[\/\\]/g,'_');
  f.__uploading=true;f.__uploaded=false;
  fetch('/api/fs/upload?'+new URLSearchParams({userId:selectedUser,path:f.__dest}),{method:'POST',headers:{'content-type':'application/octet-stream','x-fs-keys':JSON.stringify(currentApiKeys())},body:f})
    .then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok||j.ok===false)throw new Error(j.message||r.statusText);f.__uploaded=true;})
    .catch(()=>{f.__uploaded=false;})
    .finally(()=>{f.__uploading=false;renderPending();try{window.__optiboxFs.poke();}catch(_){}});
}
function unstageAttachment(f){
  if(!f.__dest||(!f.__uploaded&&!f.__uploading))return;
  fetch('/api/fs/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,path:f.__dest,apiKeys:currentApiKeys()})})
    .then(()=>{try{window.__optiboxFs.poke();}catch(_){}})
    .catch(()=>{});
}
function renderPending(){
  const c=$('pendingAttach');if(!c)return;c.innerHTML='';
  updateComposerMode();
  if(!pendingFiles.length)return;
  c.className='pendingAttach attachDeck';
  pendingFiles.forEach((f,i)=>{
    const card=document.createElement('div');card.className='card';card.title=f.name;
    if(IMG_RE.test(f.name)){const img=document.createElement('img');img.src=URL.createObjectURL(f);card.appendChild(img);}
    else if(VID_RE.test(f.name)){const v=document.createElement('video');v.src=URL.createObjectURL(f);v.muted=true;card.appendChild(v);}
    else if(isAudioName(f.name)){const e=document.createElement('div');e.className='cardIcon cardAudio';e.innerHTML=MIC_SVG+'<span>voice</span>';card.appendChild(e);}
    else{const e=document.createElement('div');e.className='cardIcon';e.textContent=fileExt(f.name);card.appendChild(e);}
    const nm=document.createElement('div');nm.className='cardName';nm.textContent=f.name;card.appendChild(nm);
    if(f.__uploading){const up=document.createElement('div');up.className='cardUp';up.textContent='uploading…';card.appendChild(up);}
    const x=document.createElement('button');x.type='button';x.className='cardRemove';x.innerHTML=X_SVG;x.title='remove';
    x.addEventListener('click',ev=>{ev.stopPropagation();pendingFiles.splice(i,1);renderPending();unstageAttachment(f);});card.appendChild(x);
    card.addEventListener('click',async()=>{try{window.__optiboxFs.openBytes(f.name,new Uint8Array(await f.arrayBuffer()));}catch(_){}});
    c.appendChild(card);
  });
}
// Render the fanned deck inside a just-created user message bubble.
// The deck sits ABOVE its message bubble as its own chat row (right-aligned for
// the user, left for the agent), not inside the bubble.
// Wrap a deck in a horizontal carousel: single row, hidden scrollbar, floating
// circular arrows that only show when scrolling that direction is possible.
// Decks must never grow the chat vertically no matter how many cards they hold.
function makeCarousel(deck,side){
  try{
    const wrap=document.createElement('div');wrap.className='deckWrap '+(side==='right'?'deckRight':'deckLeft');
    wrap.appendChild(deck);
    // Phosphor caret-left / caret-right (256 viewBox), inline so no CDN dependency.
    const CARET_L='<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z"/></svg>';
    const CARET_R='<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"/></svg>';
    const mk=(dir)=>{const b=document.createElement('div');b.className='deckNav '+dir+' hiddenNav';b.innerHTML=dir==='left'?CARET_L:CARET_R;b.addEventListener('click',e=>{e.stopPropagation();e.preventDefault();try{deck.scrollBy({left:(dir==='left'?-1:1)*Math.max(120,deck.clientWidth*0.8),behavior:'smooth'});}catch(_){deck.scrollLeft+=(dir==='left'?-1:1)*160;}});wrap.appendChild(b);return b;};
    const L=mk('left'),R=mk('right');
    const sync=()=>{try{const can=deck.scrollWidth-deck.clientWidth>4;L.classList.toggle('hiddenNav',!can||deck.scrollLeft<=2);R.classList.toggle('hiddenNav',!can||deck.scrollLeft+deck.clientWidth>=deck.scrollWidth-2);}catch(_){}};
    deck.addEventListener('scroll',sync);
    wrap.addEventListener('mouseenter',()=>setTimeout(sync,220));
    if(typeof ResizeObserver!=='undefined'){try{new ResizeObserver(sync).observe(deck);}catch(_){}}
    setTimeout(sync,60);setTimeout(sync,600);
    return wrap;
  }catch(_){return deck;}
}
// A deck card shows the real picture, not its file extension. Bytes for a box
// file are fetched through the fs panel's reader and swapped in over the
// placeholder icon; a Blob must carry its MIME type or a blob: URL is served
// with none, which <video> refuses to render (the empty rectangle).
const THUMB_MAX_BYTES=25*1024*1024;
function thumbElement(name,bytes){
  const fs=window.__optiboxFs||{};
  const url=URL.createObjectURL(new Blob([bytes],{type:(fs.mimeFor&&fs.mimeFor(name))||''}));
  if(VID_RE.test(name)||/\.webm$/i.test(name)){
    const v=document.createElement('video');v.src=url;v.muted=true;v.playsInline=true;v.preload='metadata';return v;
  }
  const img=document.createElement('img');img.src=url;img.alt=name;return img;
}
// Replace a card's extension icon with a thumbnail of the box file at `path`.
// Silent on failure: the icon it started with is a fine fallback.
async function thumbFromBox(card,path,name,size){
  try{
    if(!(IMG_RE.test(name)||VID_RE.test(name)))return;
    if(size!==undefined&&size>THUMB_MAX_BYTES)return;
    const fs=window.__optiboxFs;if(!fs||!fs.readBytes)return;
    const bytes=await fs.readBytes(path);
    if(!bytes||!bytes.length)return;
    const media=thumbElement(name,bytes);
    const icon=card.querySelector('.cardIcon');
    if(icon)icon.replaceWith(media);else card.insertBefore(media,card.firstChild);
  }catch(_){}
}
function renderAttachDeck(el,atts,side){
  if(!el||!el.parentNode)return;
  const deck=document.createElement('div');deck.className='attachDeck '+(side==='left'?'deckLeft':'deckRight');
  atts.forEach(a=>{
    const card=document.createElement('div');card.className='card';card.title=a.name;
    // On REPLAY we have the filename/type but not the bytes (they aren't in the
    // journal) — fall through to the generic ext card and drop the click-open.
    if((IMG_RE.test(a.name)||VID_RE.test(a.name))&&a.bytes){card.appendChild(thumbElement(a.name,a.bytes));}
    else if(isAudioName(a.name)){const ic=document.createElement('div');ic.className='cardIcon cardAudio';ic.innerHTML=MIC_SVG+'<span>voice</span>';card.appendChild(ic);}
    else{
      const ic=document.createElement('div');ic.className='cardIcon';ic.textContent=fileExt(a.name);card.appendChild(ic);
      // Replay has the name but not the bytes (the journal stores metadata
      // only). Uploads land at a KNOWN path, so a reopened conversation can
      // show its pictures again instead of a wall of extension cards.
      if(IMG_RE.test(a.name)||VID_RE.test(a.name)){
        const dest='attachments/'+a.name.replace(/[/\\]/g,'_');
        void thumbFromBox(card,dest,a.name).then(()=>{
          if(card.querySelector('img,video'))card.addEventListener('click',()=>{try{window.__optiboxFs.openPath(dest);}catch(_){}});
        });
      }
    }
    const nm=document.createElement('div');nm.className='cardName';nm.textContent=a.name;card.appendChild(nm);
    if(a.bytes)card.addEventListener('click',()=>{try{window.__optiboxFs.openBytes(a.name,a.bytes);}catch(_){}});
    deck.appendChild(card);
  });
  el.parentNode.insertBefore(makeCarousel(deck,side),el);
}
// Agent "attachments": files the box agent produced this turn, shown as a
// left-aligned deck BELOW its last bubble. Primary signal is its explicit
// <optibox-files>…</optibox-files> manifest; as a fallback (models sometimes
// forget the tag) we also resolve files it NAMES in prose to a single tree file.
// Both are precise — neither is the old mtime diff that surfaced every touched
// file. A named path only shows if it actually exists under /home/user.
const AGENT_FILE_EXT=/\.(png|jpe?g|gif|webp|bmp|avif|svg|pdf|mp4|webm|m4v|mov|ogv|mp3|wav|ogg|oga|m4a|opus|csv|xlsx?|json|txt|md|py|js|ts|tsx|html?|css|zip|sqlite3?|db|docx?|pptx?)$/i;
async function fetchTreeFiles(){
  try{const t=await (await fetch('/api/fs/tree',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,apiKeys:currentApiKeys()})})).json();
    return (t.entries||[]).filter(e=>e.kind!=='directory'&&e.kind!=='d'&&e.kind!=='dir');
  }catch(_){return null;}
}
// Noise: build/cache/dotfile churn is never a deliverable the user cares about.
function isNoisePath(p){return p.split('/').some(seg=>seg.startsWith('.')||seg==='node_modules'||seg==='__pycache__');}
async function renderAgentAttachments(el){
  if(!el||el.__deckDone||!el.parentNode)return;el.__deckDone=true;
  const body=el.querySelector('.body');if(!body)return;
  const raw=body.dataset.raw||'';
  const declared=parseFileDecl(raw);
  // Fallback: filename-ish tokens the agent mentioned in its visible prose.
  const mentioned=[];const mseen={};let m;const mre=/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}/g;
  const shown=stripFileDecl(raw);
  while((m=mre.exec(shown))){let t=m[0].replace(/^[./]+/,'');if(AGENT_FILE_EXT.test(t)&&!mseen[t]){mseen[t]=1;mentioned.push(t);}}
  const cands=declared.concat(mentioned);
  if(!cands.length)return;
  const files=await fetchTreeFiles();if(!files)return;
  const ordered=[];const chosen={};
  for(const c of cands){
    const base=c.split('/').pop();
    const matches=[...new Set(files.filter(e=>{const p=e.path;return p===c||p.endsWith('/'+c)||p===base||p.endsWith('/'+base)||p.split('/').pop()===base;}).map(e=>e.path))];
    // Prefer an exact path match; otherwise accept a unique basename match.
    let pick=matches.find(p=>p===c||p.endsWith('/'+c));
    if(!pick&&matches.length===1)pick=matches[0];
    if(pick&&!chosen[pick]&&!isNoisePath(pick)){chosen[pick]=1;ordered.push(pick);}
  }
  const hits=ordered.slice(0,8);
  if(!hits.length)return;
  const sizeOf={};for(const e of files)if(e&&e.path!==undefined)sizeOf[e.path]=e.size;
  const deck=document.createElement('div');deck.className='attachDeck deckLeft';
  hits.forEach(path=>{
    const name=path.split('/').pop();
    const card=document.createElement('div');card.className='card';card.title=path;
    if(isAudioName(name)){const ic=document.createElement('div');ic.className='cardIcon cardAudio';ic.innerHTML=MIC_SVG+'<span>voice</span>';card.appendChild(ic);}
    else{
      const ic=document.createElement('div');ic.className='cardIcon';ic.textContent=fileExt(name);card.appendChild(ic);
      // The agent's own files live in the box, so the deck has to go and get
      // them. Without this every picture the agent made rendered as the word
      // "PNG" in a grey rectangle.
      void thumbFromBox(card,path,name,sizeOf[path]);
    }
    const nm=document.createElement('div');nm.className='cardName';nm.textContent=name;card.appendChild(nm);
    card.addEventListener('click',()=>{try{if(window.__optiboxFs&&window.__optiboxFs.openPath)window.__optiboxFs.openPath(path);}catch(_){}});
    deck.appendChild(card);
  });
  // BELOW the agent's last bubble (user asked for it under the message/tool line).
  el.parentNode.insertBefore(makeCarousel(deck,'left'),el.nextSibling);
}
// OG link previews: when the agent mentions links (markdown or bare URLs) in a
// finished message, embed preview cards render in a row below it — same slot
// and carousel behavior as agent file attachments. Card data comes from the
// host's /api/og proxy (browser can't read cross-origin pages); a link whose
// page yields no usable OG data still gets a plain domain card.
const OG_SKIP_RE=/\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|ogg|pdf|zip|csv|xlsx?|docx?)([?#]|$)/i;
function extractLinks(text){
  const out=[];const seen={};
  // NOTE: no \/ escapes outside char classes here — the raw-source compile
  // check parses this template before unescaping, and \/ ends a regex literal
  // there. [/] is equivalent and parses identically in both forms.
  // Trailing junk includes markdown emphasis (**url**, _url_, backticked url):
  // agents routinely bold their links and the asterisks would otherwise ride
  // into the href as %2A%2A and split one link into several mangled ones.
  const push=u=>{u=String(u).replace(/[).,;:!?\]'"\u00BB*_\u0060]+$/,'');if(!/^https?:[/][/]/i.test(u)||OG_SKIP_RE.test(u)||u.length>600)return;const k=u.replace(/^https?:[/][/](www\.)?/i,'').replace(/[/]$/,'').toLowerCase();if(!seen[k]){seen[k]=1;out.push(u);}};
  let m;const mdre=/\[[^\]]*\]\((https?:[/][/][^\s)]+)\)/g;while((m=mdre.exec(text)))push(m[1]);
  const bare=/https?:[/][/][^\s<>"')\]]+/g;while((m=bare.exec(text)))push(m[0]);
  // Bare domain mentions ("meteofrance.com", "Windy.com (great maps)") — agents
  // list sites without schemes constantly. TLD-allowlisted to avoid matching
  // filenames; (?<!@) skips e-mail addresses; scheme added for the preview.
  // The TLD alternation is matched CASE-SENSITIVELY (labels stay case-insensitive):
  // when a model drops the space at a sentence joint ("issue.No", "version.It",
  // "desktop.No" — all observed), the capitalized next word must NOT read as a
  // TLD. Real prose domains are lowercase-TLD ("Windy.com" still matches).
  const dom=/(?<![@\w])((?:[a-zA-Z0-9-]+\.)+(?:com|org|net|io|dev|fr|co|uk|de|app|ai|me|tv|gg|so|edu|gov|in|info|eu|es|it|nl|be|ch|at|se|no|dk|fi|pl|pt|us|ca|au|nz|jp|br|ly|to|cc|fm|sh|im|xyz|site|online|tech|live|news|store|shop|blog|cloud|wiki))(?![a-z0-9@-])((?:[/][^\s<>"')\]]*)?)/g;
  while((m=dom.exec(text)))push('https://'+m[1]+(m[2]||''));
  return out.slice(0,8);
}
async function renderLinkPreviews(el){
  if(!el||el.__ogDone||!el.parentNode)return;el.__ogDone=true;
  try{
    const body=el.querySelector('.body');if(!body)return;
    const shown=stripEndSentinel(stripFileDecl(body.dataset.raw||''));
    const links=extractLinks(shown);if(!links.length)return;
    // Sites hosted from the box itself (host CLI → *.on.ascii.dev) get a LIVE
    // iframe embed the size of the screen-share widget, not a small card.
    const framed=links.filter(u=>/[.]on[.]ascii[.]dev/i.test(u));
    const rest=links.filter(u=>framed.indexOf(u)<0);
    framed.slice(0,2).forEach(u=>{
      const box=document.createElement('div');box.className='siteEmbed';
      const bar=document.createElement('div');bar.className='siteEmbedBar';
      const nm=document.createElement('span');nm.textContent=u.replace(/^https?:[/][/]/i,'');bar.appendChild(nm);
      const open=document.createElement('a');open.href=u;open.target='_blank';open.rel='noopener noreferrer';open.textContent='open in tab';bar.appendChild(open);
      box.appendChild(bar);
      const fr=document.createElement('iframe');fr.src=u;fr.loading='lazy';fr.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups');box.appendChild(fr);
      el.parentNode.insertBefore(box,el.nextSibling);
    });
    if(!rest.length)return;
    const metas=await Promise.all(rest.map(u=>fetch('/api/og?url='+encodeURIComponent(u)).then(r=>r.json()).catch(()=>null)));
    if(!el.parentNode)return;
    const deck=document.createElement('div');deck.className='ogDeck';
    rest.forEach((u,i)=>{
      const meta=(metas[i]&&metas[i].ok)?metas[i]:null;
      const a=document.createElement('a');a.className='ogCard';a.href=u;a.target='_blank';a.rel='noopener noreferrer';a.title=u;
      let host='';try{host=new URL(u).hostname.replace(/^www\./,'');}catch(_){}
      if(meta&&meta.image){const img=document.createElement('img');img.className='ogImg';img.src=meta.image;img.loading='lazy';img.addEventListener('error',()=>{try{img.remove();}catch(_){}});a.appendChild(img);}
      const b=document.createElement('div');b.className='ogBody';
      const title=(meta&&meta.title)||host||u;
      const t=document.createElement('div');t.className='ogTitle';t.textContent=title;b.appendChild(t);
      if(meta&&meta.description){const d=document.createElement('div');d.className='ogDesc';d.textContent=meta.description;b.appendChild(d);}
      // Site line only when it adds information the title doesn't already show.
      const site=(meta&&meta.site)||host;
      if(site&&site!==title){const s=document.createElement('div');s.className='ogSite';s.textContent=site;b.appendChild(s);}
      a.appendChild(b);deck.appendChild(a);
    });
    el.parentNode.insertBefore(makeCarousel(deck,'left'),el.nextSibling);
  }catch(_){}
}
function submitComposer(source){
  const text=msgEl.value.trim();
  const hasFiles=pendingFiles.length>0;
  console.debug('[trace] submit event fired', {source, hasText:Boolean(text), files:pendingFiles.length});
  if(!text&&!hasFiles){console.debug('[trace] empty submit ignored', {source});return false;}
  const st=currentSettingsStatus();
  if(!st.ok){addMsg('trace','settings required',st.msg+'\n');openSettings();return false;}
  const now=Date.now();
  if(now-lastSubmitAt<150){console.debug('[trace] duplicate submit suppressed', {source});return false;}
  lastSubmitAt=now;
  const files=pendingFiles;pendingFiles=[];renderPending();
  msgEl.value='';msgEl.focus();
  runTurn(text||'(see attached)',files);
  return true;
}
composer.addEventListener('submit',e=>{e.preventDefault();submitComposer('form.submit');});
sendBtn.addEventListener('click',e=>{e.preventDefault();submitComposer('button.click');});
const attachBtn=$('attach'),fileInput=$('fileInput');
attachBtn.addEventListener('click',()=>fileInput.click());
fileInput.addEventListener('change',()=>{if(fileInput.files.length)addPendingFiles(fileInput.files);fileInput.value='';});
composer.addEventListener('dragover',e=>{if(e.dataTransfer&&[...e.dataTransfer.types].includes('Files')){e.preventDefault();composer.classList.add('attachDrop');}});
composer.addEventListener('dragleave',e=>{if(e.target===composer||!composer.contains(e.relatedTarget))composer.classList.remove('attachDrop');});
composer.addEventListener('drop',e=>{composer.classList.remove('attachDrop');if(e.dataTransfer&&e.dataTransfer.files.length){e.preventDefault();addPendingFiles(e.dataTransfer.files);}});
stopBtn.addEventListener('click',async e=>{e.preventDefault();stopBtn.disabled=true;addMsg('trace','manual stop','pause request sent for this conversation\n');setState('Private machine stopping · manual pause requested');try{const res=await fetch('/api/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,conversationId:selectedConversation,apiKeys:currentApiKeys()})});await drain(res,newTurnId());}catch(err){addMsg('assistant','error','Stop failed: '+String(err&&err.message||err));}finally{stopBtn.disabled=false;}});
diagnosticsBtn?.addEventListener('click',e=>{e.preventDefault();const a=document.createElement('a');a.href='/api/diagnostics?format=json';a.download='optibox-diagnostics.json';document.body.appendChild(a);a.click();a.remove();addMsg('trace','diagnostics','downloaded redacted JSON event log from /api/diagnostics\n');});
msgEl.addEventListener('keydown',e=>{if((e.key==='Enter'||e.code==='Enter'||e.keyCode===13||e.which===13)&&!e.shiftKey){e.preventDefault();submitComposer('textarea.enter');}});
msgEl.addEventListener('beforeinput',e=>{if((e.inputType==='insertLineBreak'||e.inputType==='insertParagraph')&&!e.shiftKey){e.preventDefault();submitComposer('textarea.beforeinput');}});
msgEl.addEventListener('input',()=>{updateComposerMode();notifyComposing();});
msgEl.addEventListener('focus',()=>notifyComposing(true));
msgEl.addEventListener('pointerdown',()=>notifyComposing(true));
// "Box still needed" flag: typing or staged attachments ping the server every
// few seconds — the rolling hold pauses any countdown at full and wakes a
// parked machine so it's warm by the time the message is sent. Stop typing
// and the hold expires in ~15s; the countdown resumes on its own.
let lastComposePing=0;
// Make the wake-on-type VISIBLE: the machine wakes because the user typed, so
// the status line should say so the instant the first keystroke lands, pulsing
// until billing confirms the machine is actually up (startBilling clears it).
function setWarmingPulse(on){const st=$('machineState');if(st&&st.classList){if(on)st.classList.add('warming');else st.classList.remove('warming');}}
function notifyComposing(force){
  // force=true: focus/click in the prompt box counts as compose intent even
  // before any text exists — the machine starts warming on the very first
  // gesture toward writing, not the first character.
  const composing=Boolean(force)||((msgEl&&msgEl.value||'').trim().length>0)||pendingFiles.length>0;
  if(!composing)return;
  if(!billing){setState('private machine warming · woken by your typing');setWarmingPulse(true);}
  const now=Date.now();
  if(now-lastComposePing<4000)return;
  lastComposePing=now;
  // The response carries the same runtime snapshot as the tree poll — apply it
  // through the SAME reducer so the counters reconcile within one ping of the
  // wake instead of waiting out the 4s poll (which raced short compose windows).
  fetch('/api/fs/activity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,conversationId:selectedConversation,apiKeys:currentApiKeys()})}).then(r=>r.json()).then(j=>{if(j&&j.runtime)applyRuntimeStatus(j.runtime);}).catch(()=>{});
}
// ---- voice messages -------------------------------------------------------
// Telegram-style: mic shows when the box is empty; press it to record with a
// live waveform, pause/resume, trash, or send. Send transcribes via Whisper
// (server key) and posts the transcript AND the audio file as an attachment.
function updateComposerMode(){if(!composer||!composer.classList)return;composer.classList.toggle('hasText',((msgEl&&msgEl.value||'').trim().length>0)||pendingFiles.length>0);}
let mediaRec=null,mediaStream=null,audioCtx=null,analyser=null,recChunks=[],recStart=0,recElapsed=0,recPaused=false,recRAF=0,recTimer=0,recMime='audio/webm';
const PAUSE_SVG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M216,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h40A16,16,0,0,1,216,48ZM96,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z"/></svg>';
const PLAY_SVG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"/></svg>';
function fmtTime(s){const m=Math.floor(s/60);const ss=Math.floor(s%60);return m+':'+(ss<10?'0':'')+ss;}
function recTimeNow(){return recElapsed+(recPaused?0:(Date.now()-recStart)/1000);}
function getSavedMicId(){try{return localStorage.getItem('optibox.micDeviceId')||'';}catch(_){return '';}}
function saveMicId(id){try{localStorage.setItem('optibox.micDeviceId',id||'');}catch(_){}}
// Open a mic stream on a specific device (falls back to default if that exact
// device is gone) and wire up the recorder, waveform and timer.
async function beginStream(deviceId){
  let stream;
  try{stream=await navigator.mediaDevices.getUserMedia({audio:deviceId?{deviceId:{exact:deviceId}}:true});}
  catch(e){
    try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}
    catch(e2){addMsg('trace','microphone','microphone unavailable: '+String(e2&&e2.message||e2)+'\n');composer.classList.remove('recording');return false;}
  }
  mediaStream=stream;recChunks=[];recPaused=false;
  const pick=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'].find(t=>window.MediaRecorder&&MediaRecorder.isTypeSupported(t))||'';
  recMime=pick||'audio/webm';
  mediaRec=new MediaRecorder(stream,pick?{mimeType:pick}:undefined);
  mediaRec.ondataavailable=e=>{if(e.data&&e.data.size)recChunks.push(e.data);};
  mediaRec.start(100);recStart=Date.now();
  try{audioCtx=new (window.AudioContext||window.webkitAudioContext)();const src=audioCtx.createMediaStreamSource(stream);analyser=audioCtx.createAnalyser();analyser.fftSize=1024;src.connect(analyser);drawWave();}catch(_){}
  try{clearInterval(recTimer);}catch(_){}
  recTimer=setInterval(()=>{$('recTime').textContent=fmtTime(recTimeNow());},200);
  return true;
}
async function startRecording(){
  if(composer.classList.contains('recording'))return;
  recElapsed=0;recPaused=false;
  $('recBar').classList.remove('paused');$('recPause').innerHTML=PAUSE_SVG;$('recPause').title='Pause';$('recTime').textContent='0:00';
  composer.classList.add('recording');
  const ok=await beginStream(getSavedMicId());
  if(ok)populateDeviceMenu();
}
// Switch input device mid-recording. Two webm segments can't be stitched into
// one valid file, so switching restarts a fresh recording on the new device
// (you switch because the first one was silent anyway) — and remembers it.
async function applyMicDevice(id){
  saveMicId(id);
  if(!composer.classList.contains('recording'))return;
  if(mediaRec){mediaRec.ondataavailable=null;mediaRec.onstop=null;if(mediaRec.state!=='inactive')try{mediaRec.stop();}catch(_){}}
  try{cancelAnimationFrame(recRAF);}catch(_){}
  if(mediaStream)mediaStream.getTracks().forEach(t=>t.stop());
  if(audioCtx&&audioCtx.close)try{audioCtx.close();}catch(_){}
  audioCtx=null;analyser=null;mediaStream=null;mediaRec=null;recChunks=[];recElapsed=0;recPaused=false;
  $('recBar').classList.remove('paused');$('recPause').innerHTML=PAUSE_SVG;$('recPause').title='Pause';$('recTime').textContent='0:00';
  const ok=await beginStream(id);
  if(ok)populateDeviceMenu();
}
function closeDeviceMenu(){const m=$('recDeviceMenu');if(m)m.classList.remove('open');}
async function populateDeviceMenu(){
  const menu=$('recDeviceMenu');if(!menu)return;
  let devs=[];try{devs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput');}catch(_){}
  let activeId='';try{const tr=mediaStream&&mediaStream.getAudioTracks&&mediaStream.getAudioTracks()[0];activeId=(tr&&tr.getSettings&&tr.getSettings().deviceId)||'';}catch(_){}
  const saved=getSavedMicId();
  menu.innerHTML='';
  if(!devs.length){const r=document.createElement('div');r.className='recDevItem';r.textContent='No microphones found';menu.appendChild(r);return;}
  devs.forEach((d,i)=>{
    const row=document.createElement('div');row.className='recDevItem';
    if((activeId&&d.deviceId===activeId)||(!activeId&&saved&&d.deviceId===saved))row.classList.add('sel');
    row.textContent=d.label||('Microphone '+(i+1));
    row.addEventListener('click',ev=>{ev.stopPropagation();closeDeviceMenu();applyMicDevice(d.deviceId);});
    menu.appendChild(row);
  });
}
function drawWave(){
  const c=$('recWave');if(!c||!analyser)return;
  const ctx=c.getContext('2d');const dpr=window.devicePixelRatio||1;const W=c.clientWidth||300,H=c.clientHeight||34;
  if(c.width!==Math.round(W*dpr)){c.width=Math.round(W*dpr);c.height=Math.round(H*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}
  const buf=new Uint8Array(analyser.frequencyBinCount);
  const loop=()=>{
    if(!composer.classList.contains('recording'))return;
    recRAF=requestAnimationFrame(loop);
    analyser.getByteTimeDomainData(buf);
    ctx.clearRect(0,0,W,H);ctx.fillStyle=recPaused?'#bbb':'#fc4b55';
    const bars=Math.max(20,Math.floor(W/4));const step=Math.max(1,Math.floor(buf.length/bars));const bw=W/bars;
    for(let i=0;i<bars;i++){let peak=0;for(let j=0;j<step;j++){const v=Math.abs(buf[i*step+j]-128)/128;if(v>peak)peak=v;}const bh=Math.max(2,peak*H*0.92);ctx.fillRect(i*bw+bw*0.25,(H-bh)/2,Math.max(1,bw*0.5),bh);}
  };
  loop();
}
function pauseResume(){
  if(!mediaRec)return;
  if(recPaused){if(mediaRec.resume)mediaRec.resume();recPaused=false;recStart=Date.now();if(audioCtx&&audioCtx.resume)audioCtx.resume();$('recBar').classList.remove('paused');$('recPause').innerHTML=PAUSE_SVG;$('recPause').title='Pause';}
  else{recElapsed=recTimeNow();if(mediaRec.pause)mediaRec.pause();recPaused=true;$('recBar').classList.add('paused');$('recPause').innerHTML=PLAY_SVG;$('recPause').title='Resume';}
}
function stopRecTracks(){try{cancelAnimationFrame(recRAF);}catch(_){}try{clearInterval(recTimer);}catch(_){}if(mediaStream)mediaStream.getTracks().forEach(t=>t.stop());if(audioCtx&&audioCtx.close)try{audioCtx.close();}catch(_){}audioCtx=null;analyser=null;mediaStream=null;}
function endRecUI(){composer.classList.remove('recording');$('recTime').textContent='0:00';updateComposerMode();}
function trashRecording(){if(mediaRec){mediaRec.ondataavailable=null;mediaRec.onstop=null;if(mediaRec.state!=='inactive')try{mediaRec.stop();}catch(_){}}mediaRec=null;recChunks=[];stopRecTracks();endRecUI();}
async function finishRecording(){
  if(!mediaRec)return;const rec=mediaRec;mediaRec=null;
  // Force a final chunk out before stopping (short clips can otherwise flush
  // nothing and produce a 0-byte file), then assemble once onstop fires.
  const blob=await new Promise(resolve=>{
    rec.onstop=()=>resolve(new Blob(recChunks,{type:recMime}));
    try{if(rec.state==='paused'&&rec.resume)rec.resume();if(rec.state!=='inactive'&&rec.requestData)rec.requestData();}catch(_){}
    if(rec.state!=='inactive'){try{rec.stop();}catch(_){resolve(new Blob(recChunks,{type:recMime}));}}else resolve(new Blob(recChunks,{type:recMime}));
  });
  stopRecTracks();endRecUI();
  if(!blob||!blob.size){addMsg('assistant','error','Voice recording was empty — no audio was captured. Try the mic-device picker in the recorder to select a working input.');return;}
  const ext=recMime.indexOf('mp4')>=0?'m4a':recMime.indexOf('ogg')>=0?'ogg':'webm';
  const file=new File([blob],'voice-'+Date.now()+'.'+ext,{type:recMime});
  addMsg('trace','voice','transcribing voice message…\n');
  let text='';
  try{
    const b64=await readAsB64(file);
    const r=await fetch('/api/transcribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({audioB64:b64,mime:recMime,apiKeys:currentApiKeys()})});
    const j=await r.json();
    if(!j.ok)throw new Error(j.message||'transcription failed');
    text=(j.text||'').trim();
  }catch(e){addMsg('assistant','error','Could not transcribe voice message: '+String(e&&e.message||e));return;}
  runTurn(text||'(voice message)',[file],{silent:true});
}
$('mic').addEventListener('click',startRecording);
$('recTrash').addEventListener('click',trashRecording);
$('recPause').addEventListener('click',pauseResume);
$('recSend').addEventListener('click',finishRecording);
$('recDevice').addEventListener('click',e=>{e.stopPropagation();const m=$('recDeviceMenu');if(m.classList.contains('open'))closeDeviceMenu();else{populateDeviceMenu();m.classList.add('open');}});
if(document.addEventListener)document.addEventListener('click',()=>closeDeviceMenu());
updateComposerMode();
async function drain(res,localId){if(!res){throw new Error('No response object from /api/send');}if(!res.ok){const body=await res.text().catch(()=>'');throw new Error('/api/send failed with HTTP '+res.status+' '+body);}if(!res.body){throw new Error('/api/send did not return a readable SSE body');}const reader=res.body.getReader();const dec=new TextDecoder();const sep=String.fromCharCode(10,10);const nl=String.fromCharCode(10);let buf='';while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split(sep);buf=parts.pop()||'';for(const p of parts){const line=p.split(nl).find(l=>l.startsWith('data:'));if(!line)continue;handle(JSON.parse(line.slice(5)),localId);}}}
function keyFor(ev,localId,cls){return (ev.turnId||localId)+':'+cls+(ev.messageId?':msg:'+ev.messageId:(ev.messageIndex!=null?':msg:'+ev.messageIndex:''));}
// When true we're REPLAYING the persisted journal on reopen (or tailing a turn
// that ran while the tab was closed). handle() then rebuilds the chat DOM but
// must NOT touch live counters/timers — those are owned by applyRuntimeStatus
// from the runtime poll. (The route diagram, working indicator, receipt and
// desktop-widget effects are already gated by isLatest/td, both false here.)
let replaying=false;
function handle(ev,localId){console.debug('[trace] stream event', ev);const isLatest=(localId===latestLocalId);
  // Only the latest turn's events drive the side diagram — otherwise a still-draining
  // older turn's box/billing events fight the newest turn's route and the graph desyncs.
  if(isLatest)routeEvent(ev);
  if(!replaying&&['billing.start','billing.stop','exec','turn.done','lifecycle'].includes(ev.type)){try{if(window.__optiboxFs&&window.__optiboxFs.poke)window.__optiboxFs.poke();}catch(_){}}
  const t=activeTurns.get(localId);if(t&&['handoff.started','billing.start','user-box.delta','exec'].includes(ev.type)){t.boxStarted=true;t.interruptible=false;}
  // "working…" stays until the LATEST turn is fully finished: both surfaces answered
  // (or the box chose <end>) and the stream reached its terminal event. An older
  // turn reaching a terminal event must NOT clear the newest turn's indicator.
  if(isLatest&&(ev.type==='turn.done'||ev.type==='turn.blocked'||ev.type==='error'||ev.type==='stream.end'))clearWorking();
  if(ev.type==='trace'){addMsg('trace','trace · '+(ev.stage||'event'),(ev.message||JSON.stringify(ev))+'\n',keyFor(ev,localId,'trace')+':'+(ev.stage||Math.random()));if(/bridge/.test(ev.stage||''))setState('Shared bridge active · private Box booting');else if(/backend|submit/.test(ev.stage||''))setState('Request received · shared bridge starting');}
  else if(ev.type==='turn.blocked'){addMsg('assistant','error',(ev.stage?'['+ev.stage+'] ':'')+(ev.message||'private runtime failed'),keyFor(ev,localId,'blocked')+':'+(ev.stage||Math.random()));setState('Private runtime error · see message');}
  else if(ev.type==='shared.delta'){lastSharedMsgEl=addMsg('assistant','shared infra · no tools',ev.text,keyFor(ev,localId,'shared'));}
  else if(ev.type==='context.injected'){if(ev.scope==='shared')setState('Shared bridge ready · private Box booting in parallel');}
  else if(ev.type==='billing.start'){if(!replaying)startBilling(ev.sinceEpochMs);}
  else if(ev.type==='lifecycle'){if(ev.state==='resume-timeout')setState('Resume timed out · starting a fresh machine');else if(ev.state==='stopping')setState('Private machine stopping · wrapping up');else if(ev.state==='archiving')setState('Private machine archiving · billing about to pause');else if(ev.state==='archived')setState('Private machine archived · billing paused');else setState('Private machine '+String(ev.state).replace(/-/g,' '));}
  else if(ev.type==='handoff.started'){setState('Private machine running · assistant has tools');}
  else if(ev.type==='runtime.proof'){addMsg('trace','proof · no Box prompt/API','boxPromptApiUsed='+ev.boxPromptApiUsed+' · boxBuiltInAgentUsed='+ev.boxBuiltInAgentUsed+' · hostAsciiAgentUsed='+ev.hostAsciiAgentUsed+' · continuation='+ev.continuation+' · streaming='+(ev.streaming||'unknown')+(ev.blocker?' · limitation: '+ev.blocker:'' )+'\n',keyFor(ev,localId,'proof'));}
  else if(ev.type==='exec'){setState('Private machine running · using tools');if(ev.kind==='harness')addMsg('trace','source path','Started real '+((ev.argv&&ev.argv[0])||'agent')+' harness inside the user machine; stdout/SSE relays native chunks as emitted.',keyFor(ev,localId,'exec'));}
  else if(ev.type==='harness.tool'){setState('Private machine running · using tools');if(isDesktopCommand(ev.command)){if(ev.phase==='tool_use'&&localId===latestLocalId)ensureDesktopWidget(localId);}else{addToolEvent(ev,localId);}}
  else if(ev.type==='user-box.delta'){const k=keyFor(ev,localId,'box');if(activeBoxKey&&activeBoxKey!==k){const prevKey=activeBoxKey,prev=bubbles.get(prevKey);activeBoxKey=null;if(prev)applyClamp(prev,prevKey);}activeBoxKey=k;lastAgentMsgEl=addMsg('assistant','user machine · tools active',ev.text,k);}
  else if(ev.type==='desktop.recording'){renderDesktopRecording(ev,localId);}
  else if(ev.type==='billing.stop'){if(!replaying){stopBilling(ev.elapsedSeconds);endDesktopWidget();}}
  else if(ev.type==='autostop.timer'){if(!replaying){if(ev.phase==='started'||ev.phase==='tick'){startAutoStopTimer(ev);}else if(ev.phase==='held'){clearAutoStopTimer('held');}else if(ev.phase==='stopping'){clearAutoStopTimer('stopping…');}else if(ev.phase==='canceled'){clearAutoStopTimer('reset');}}addMsg('trace','auto-stop',describeAutoStop(ev)+' · '+(ev.note||'')+'\n',keyFor(ev,localId,'autostop')+':'+ev.phase+':'+Math.ceil((ev.remainingMs||0)/1000));if(!replaying)setState(describeAutoStop(ev));}
  else if(ev.type==='turn.done'){setState('Turn complete · waiting for visible auto-stop countdown');const td=activeTurns.get(localId);if(td)td.boxDone=true;
    // The streaming target is finalized: drop the active marker and clamp it if it
    // grew past the collapse threshold, and detach the working footer.
    if(activeBoxKey){const fk=activeBoxKey,fb=bubbles.get(fk);activeBoxKey=null;if(fb)applyClamp(fb,fk);}
    if(lastAgentMsgEl){renderAgentAttachments(lastAgentMsgEl);renderLinkPreviews(lastAgentMsgEl);lastAgentMsgEl=null;}if(lastSharedMsgEl){renderLinkPreviews(lastSharedMsgEl);lastSharedMsgEl=null;}
    // Per-turn receipt: the economic argument for per-second billing, made
    // legible per artifact — "that PDF cost you $0.0041". Only for turns that
    // actually ran the private machine, and only when a real amount accrued.
    if(td&&td.boxStarted&&!td.receiptShown){const used=activeSeconds()-(td.startSeconds||0);if(used>=0.1&&billRate>0){td.receiptShown=true;const r=document.createElement('div');r.className='receipt';r.textContent=used.toFixed(1)+'s machine time · '+fmtUsd(used*billRate);const c=$('chat');const stick=chatStick(c);c.appendChild(r);if(stick)c.scrollTop=c.scrollHeight;}}}
  else if(ev.type==='error'){addMsg('assistant','error','Error: '+ev.message);setState('Error · check model credentials or machine state');}}
if(typeof window!=='undefined')window.addEventListener('resize',paintDiagram);
if(typeof window!=='undefined')window.__optiboxFs={ctx:function(){return {userId:selectedUser,conversationId:selectedConversation,apiKeys:currentApiKeys()};},onRuntime:applyRuntimeStatus};
load();

// ---- reopen & restore ------------------------------------------------------
// The conversation's rendered event journal (Postgres, written server-side as
// the turn streams — so it keeps recording even after you close the tab) is the
// source of truth for what was on screen. On load we REPLAY it through the very
// same handle() renderer, so chat + tool chains + attachment decks come back
// exactly as they were. Counters, machine state and the hosting bar arrive
// separately via the runtime poll (applyRuntimeStatus). If the latest turn is
// still running (or finished while the tab was closed), we TAIL new journal
// events until it completes — that's the "the agent kept working while I was
// away" case.
let historyMaxSeq=0, lastTurnComplete=true, tailTimer=0;
function renderUserMessage(ev,seq){
  const el=addMsg('user','',ev.text||'','user:hist:'+seq);
  if(ev.attachments&&ev.attachments.length)
    renderAttachDeck(el, ev.attachments.map(function(a){return {name:String((a&&a.name)||'file'),type:a&&a.type};}), 'right');
}
function replayEvent(ev,seq){
  if(!ev||typeof ev!=='object')return;
  if(seq>historyMaxSeq)historyMaxSeq=seq;
  if(ev.type==='user.message'){lastTurnComplete=false;renderUserMessage(ev,seq);return;}
  if(ev.type==='turn.done'||ev.type==='turn.blocked'||ev.type==='error')lastTurnComplete=true;
  handle(ev, ev.turnId||('hist:'+seq));
}
async function fetchHistory(sinceSeq){
  try{
    const r=await(await fetch('/api/history',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,conversationId:selectedConversation,sinceSeq:sinceSeq,apiKeys:currentApiKeys()})})).json();
    return (r&&r.ok&&Array.isArray(r.events))?r.events:[];
  }catch(_){return [];}
}
function replayBatch(events){
  replaying=true;
  try{for(const row of events)replayEvent(row.body,row.seq||0);}
  finally{replaying=false;}
}
function startTail(){
  if(tailTimer)return;
  const tick=async function(){
    tailTimer=0;
    const events=await fetchHistory(historyMaxSeq);
    if(events.length)replayBatch(events);
    if(lastTurnComplete){clearWorking();setState('caught up · your machine finished while you were away');return;}
    tailTimer=setTimeout(tick,1500);
  };
  tailTimer=setTimeout(tick,1500);
}
async function restoreConversation(){
  const events=await fetchHistory(0);
  if(!events.length)return;
  const emptyEl=$('empty');if(emptyEl)emptyEl.remove();
  replayBatch(events);
  if(!lastTurnComplete){showWorking();setState('reconnecting — your machine kept working while you were away…');startTail();}
}
restoreConversation();

// Full user reset (bottom-right): deletes the machine + snapshots and every
// server-side record of this user (billing total, transcripts, holds,
// hosting), then starts a clean conversation locally.
(function(){
  try{
    var b=document.createElement('button');
    b.type='button';b.className='resetBtn';b.textContent='reset my data';
    b.addEventListener('click',async function(){
      if(!window.confirm('Delete your machine, its snapshots, and all messages/billing history?'))return;
      b.disabled=true;b.textContent='resetting…';
      try{
        var r=await(await fetch('/api/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:selectedUser,apiKeys:currentApiKeys()})})).json();
        if(!r||r.ok!==true)throw new Error((r&&r.message)||'reset failed');
        selectedConversation=persistConversationId('conv-'+Math.random().toString(36).slice(2,10));historyMaxSeq=0;lastTurnComplete=true;if(tailTimer){clearTimeout(tailTimer);tailTimer=0;}
        var c=$('chat');if(c)c.innerHTML='<div class="empty" id="empty">Send a message to start the demo.</div>';
        totalSeconds=0;stopBilling(null,true);renderTotals();clearAutoStopTimer('idle');
        pendingFiles=[];renderPending();syncHostingBar([]);
        try{window.__optiboxFs.poke();}catch(_){}
        setState('fresh start · machine deleted, history erased');
      }catch(e){addMsg('assistant','error','Reset failed: '+String(e&&e.message||e));}
      finally{b.disabled=false;b.textContent='reset my data';}
    });
    document.body.appendChild(b);
  }catch(_){}
})();
