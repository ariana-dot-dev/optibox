import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

class FakeClassList {
  names = new Set<string>();
  toggle(name: string, force?: boolean) {
    const next = force ?? !this.names.has(name);
    if (next) this.names.add(name); else this.names.delete(name);
    return next;
  }
  remove(name: string) { this.names.delete(name); }
  add(name: string) { this.names.add(name); }
}

class FakeElement {
  id = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  textContent = "";
  private _innerHTML = "";
  className = "";
  scrollTop = 0;
  scrollHeight = 0;
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  listeners = new Map<string, Function[]>();
  children: FakeElement[] = [];
  queryChildren = new Map<string, FakeElement>();
  // Elements the page addressed by attribute selector, kept stable across
  // lookups so a handler and the reader that follows it see the same node.
  attrNodes = new Map<string, FakeElement>();
  offsetWidth = 1;

  constructor(id = "") {
    this.id = id;
  }

  addEventListener(type: string, fn: Function) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(fn);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ preventDefault() {}, ...event });
    }
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(value: string) { this._innerHTML = value; this.queryChildren.clear(); this.attrNodes.clear(); }

  appendChild(el: FakeElement) {
    this.children.push(el);
    return el;
  }

  remove() {}
  focus() {}
  setAttribute(name: string, value: string) { (this as any)[name] = value; }
  getAttribute(name: string) { return (this as any)[name]; }

  /**
   * Minimal attribute-selector support over the markup the page just wrote:
   * `[data-cred]` / `[data-row="x"]` is how the Agents panel finds its fields.
   */
  private attrMatches(attr: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const m of this._innerHTML.matchAll(new RegExp(`${attr}="([^"]*)"`, "g"))) {
      const key = `${attr}=${m[1]}`;
      let el = this.attrNodes.get(key);
      if (!el) { el = new FakeElement(); el.setAttribute(attr, m[1] as string); this.attrNodes.set(key, el); }
      out.push(el);
    }
    return out;
  }

  querySelectorAll(selector: string) {
    const m = selector.match(/^\[([a-z-]+)\]$/);
    return m ? this.attrMatches(m[1] as string) : [];
  }

  querySelector(selector: string): FakeElement | undefined {
    const attr = selector.match(/^\[([a-z-]+)="([^"]*)"\]$/);
    if (attr) return this.attrMatches(attr[1] as string).find((el) => el.getAttribute(attr[1] as string) === attr[2]);
    if (selector === ".body") return this;
    let el = this.queryChildren.get(selector);
    if (!el) {
      el = new FakeElement(selector);
      if (selector.startsWith('.')) el.className = selector.slice(1);
      this.queryChildren.set(selector, el);
    }
    return el;
  }
}

function extractClientScript(_source: string) {
  return readFileSync("scripts/assets/app.js", "utf8");
}

function makeReadableSse(events: unknown[]) {
  const chunks = events.map((event) =>
    new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
  );
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[index++] };
        },
      };
    },
  };
}

/** Every model the catalog offers is unlocked unless a test says otherwise. */
const DEFAULT_CATALOG = {
  harnesses: [{ name: "claude", label: "Claude Code", models: [{ provider: "anthropic", model: "claude-sonnet", keyAvailable: true }] }],
  runtimeFeasibility: [],
  pricing: { ratePerSecond: 0.001 },
  serverKeysAllowed: true,
  credentialMode: "server-or-byok",
  env: { BOX_API_KEY: true },
};

/**
 * The page under test, in a fake DOM. One helper for every test: they differ
 * only in what /api/send streams back and in what the Agents routes answer.
 */
function bootClient(opts: {
  now: number;
  uuid: () => string;
  sendEvents?: unknown[];
  catalog?: unknown;
  agents?: unknown;
  onAgentsSave?: (body: any) => unknown;
  onOAuth?: (step: string, params: any) => unknown;
} = { now: 1_000_000, uuid: () => "turn-1" }) {
  const elements = new Map<string, FakeElement>();
  const getElement = (id: string) => {
    let el = elements.get(id);
    if (!el) { el = new FakeElement(id); elements.set(id, el); }
    return el;
  };
  for (const id of [
    "composer", "msg", "send", "stopBox", "showTraces", "chat", "empty",
    "schematic", "routeStatus", "machineState", "totalSeconds", "totalCost", "autoStopTimer", "matrix",
    "settingsBackdrop", "settingsHarness", "settingsModel", "settingsReasoningRow", "settingsReasoning",
    "agentsSignin", "agentsCreds", "settingsStatus", "settingsSave", "settingsClose",
    "agentsOpen", "agentsKeysBox", "agentsKeysToggle",
  ]) getElement(id);

  const sendRequests: any[] = [];
  const agentsSaves: any[] = [];
  const oauthCalls: { step: string; params: any }[] = [];
  let now = opts.now;
  const catalog = opts.catalog ?? DEFAULT_CATALOG;
  const agents = opts.agents ?? { ok: true, selection: {}, credentials: [], usingOwnKeys: false, envPending: false };
  const context = vm.createContext({
    console: { ...console, debug() {} },
    AbortController,
    TextDecoder,
    TextEncoder,
    URLSearchParams,
    location: { search: "" },
    setInterval,
    clearInterval,
    setTimeout,
    getComputedStyle: () => ({ lineHeight: "20px" }),
    document: {
      body: new FakeElement("body"),
      getElementById: getElement,
      createElement: () => new FakeElement(),
    },
    globalThis: { crypto: { randomUUID: opts.uuid } },
    Date: Object.assign(class extends Date { static now() { now += 1000; return now; } }, Date),
    fetch: async (url: string, init?: any) => {
      if (url.startsWith("/api/harnesses")) return { ok: true, json: async () => catalog };
      // The OAuth routes must be matched BEFORE /api/agents: they share the prefix.
      if (url.startsWith("/api/agents/oauth/")) {
        const [path, query] = url.slice("/api/agents/oauth/".length).split("?");
        const params = init?.body ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(query ?? ""));
        oauthCalls.push({ step: path as string, params });
        return { ok: true, json: async () => opts.onOAuth?.(path as string, params) ?? { ok: true } };
      }
      if (url.startsWith("/api/agents")) {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body);
          agentsSaves.push(body);
          return { ok: true, json: async () => opts.onAgentsSave?.(body) ?? { ok: true, applied: "now", message: "applied to your box now", selection: body.selection, credentials: [], usingOwnKeys: true, envPending: false } };
        }
        return { ok: true, json: async () => agents };
      }
      if (url === "/api/send") {
        sendRequests.push(JSON.parse(init.body));
        return { ok: true, body: makeReadableSse(opts.sendEvents ?? [{ type: "stream.end" }]) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  vm.runInContext(extractClientScript(""), context);
  return { getElement, sendRequests, agentsSaves, oauthCalls };
}

const settle = async (times = 1) => { for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r)); };
/** Let a zero-delay poll timer fire, then let its promises settle. */
const tick = async (times = 1) => { for (let i = 0; i < times; i++) { await new Promise((r) => setTimeout(r, 2)); await settle(3); } };

/** The credential list the real routes return, with nothing connected. */
const NOTHING_CONNECTED = [
  { id: "claudeSubscription", label: "Claude Pro/Max", hint: "", kind: "env", target: "CLAUDE_CODE_OAUTH_TOKEN", group: "subscription", oauth: "claude", connected: false, last4: "", detail: "" },
  { id: "codexSubscription", label: "ChatGPT", hint: "", kind: "file", target: ".codex/auth.json", group: "subscription", oauth: "codex", connected: false, last4: "", detail: "" },
  { id: "kimiSubscription", label: "Kimi Code", hint: "", kind: "env", target: "KIMI_CODE_ACCESS_TOKEN", group: "subscription", oauth: "kimi", connected: false, last4: "", detail: "" },
  { id: "anthropicApiKey", label: "Anthropic", hint: "sk-ant-…", kind: "env", target: "ANTHROPIC_API_KEY", group: "key", oauth: "", connected: false, last4: "", detail: "" },
  { id: "openaiApiKey", label: "OpenAI", hint: "sk-…", kind: "env", target: "OPENAI_API_KEY", group: "key", oauth: "", connected: false, last4: "", detail: "" },
  { id: "moonshotApiKey", label: "Moonshot", hint: "sk-…", kind: "env", target: "MOONSHOT_API_KEY", group: "key", oauth: "", connected: false, last4: "", detail: "" },
  { id: "openrouterApiKey", label: "OpenRouter", hint: "sk-or-…", kind: "env", target: "OPENROUTER_API_KEY", group: "key", oauth: "", connected: false, last4: "", detail: "" },
  { id: "llmgatewayApiKey", label: "llmgateway", hint: "llmgtwy_…", kind: "env", target: "LLMGATEWAY_API_KEY", group: "key", oauth: "", connected: false, last4: "", detail: "" },
];
const withConnected = (id: string, extra: Record<string, unknown> = {}) =>
  NOTHING_CONNECTED.map((c) => (c.id === id ? { ...c, connected: true, ...extra } : c));

// The app has one dropdown component; these drive it the way a person does.
// Every interaction redraws the host, so the trigger is re-read each time.
const ddTriggerOf = (el: any) => el.querySelector('[data-ddtrigger="1"]')!;
const ddValueOf = (el: any): string => (String(el.innerHTML).match(/<span class="ddValue">([^<]*)<\/span>/) ?? ["", ""])[1] as string;
const ddKey = (el: any, key: string) => ddTriggerOf(el).dispatch("keydown", { key });

test("interactive demo client sends exactly one /api/send after page load", async () => {
  let n = 0;
  const { getElement, sendRequests } = bootClient({ now: 1_000_000, uuid: () => `turn-${++n}` });
  await settle();

  const msg = getElement("msg");
  const send = getElement("send");
  const composer = getElement("composer");

  msg.value = "button message";
  send.dispatch("click");
  await settle();
  assert.equal(sendRequests.length, 1);
  assert.equal(msg.value, "", "send clears the textarea visibly");

  msg.value = "form message";
  composer.dispatch("submit");
  await settle();
  assert.equal(sendRequests.length, 2);

  msg.value = "enter message";
  msg.dispatch("keydown", { key: "Enter", code: "Enter", shiftKey: false });
  await settle();
  assert.equal(sendRequests.length, 3);

  msg.value = "beforeinput message";
  msg.dispatch("beforeinput", { inputType: "insertLineBreak", shiftKey: false });
  await settle();
  assert.equal(sendRequests.length, 4);

  msg.value = "combined enter";
  msg.dispatch("beforeinput", { inputType: "insertParagraph", shiftKey: false });
  msg.dispatch("keydown", { key: "Enter", code: "Enter", shiftKey: false });
  await settle();
  assert.equal(sendRequests.length, 5, "beforeinput + keydown should still produce one request");
  assert.deepEqual(sendRequests.map((r) => r.message), [
    "button message",
    "form message",
    "enter message",
    "beforeinput message",
    "combined enter",
  ]);
  // No secret ever rides a request body: keys live server-side now.
  assert.ok(sendRequests.every((r) => !("apiKeys" in r)), "the send body carries no credentials");
});

test("interactive demo client renders distinct Box assistant messages by native message id", async () => {
  const { getElement } = bootClient({
    now: 2_000_000,
    uuid: () => "turn-ui-proof",
    sendEvents: [
      { type: "user-box.delta", turnId: "turn-1", messageId: "box-msg-1", text: "Hel" },
      { type: "user-box.delta", turnId: "turn-1", messageId: "box-msg-1", text: "lo" },
      { type: "user-box.delta", turnId: "turn-1", messageId: "box-msg-2", text: "Sec" },
      { type: "user-box.delta", turnId: "turn-1", messageId: "box-msg-2", text: "ond" },
      { type: "stream.end" },
    ],
  });
  await settle();

  getElement("msg").value = "prove box messages";
  getElement("composer").dispatch("submit");
  await settle(2);

  const assistants = getElement("chat").children.filter((el) => el.className.includes("assistant"));
  assert.equal(assistants.length, 2, "two native Box assistant messages should create two bubbles");
  assert.deepEqual(assistants.map((el) => el.textContent), ["Hello", "Second"]);
});

test("interactive demo client groups consecutive tool calls into minimal chains", async () => {
  const { getElement } = bootClient({
    now: 3_000_000,
    uuid: () => "turn-tool-proof",
    sendEvents: [
      { type: "harness.tool", phase: "tool_use", toolName: "bash", command: "ls" },
      { type: "harness.tool", phase: "tool_use", toolName: "read", description: "read file xyz" },
      { type: "harness.tool", phase: "tool_result", stdout: "ok" },
      { type: "harness.tool", phase: "tool_result", stdout: "done" },
      { type: "user-box.delta", turnId: "turn-1", messageId: "box-msg-1", text: "message between chains" },
      { type: "harness.tool", phase: "tool_use", toolName: "bash", command: "sleep 10" },
      { type: "stream.end" },
    ],
  });
  await settle();

  getElement("msg").value = "use tools";
  getElement("composer").dispatch("submit");
  await settle(2);

  const children = getElement("chat").children;
  const toolChains = children.filter((el) => el.className === "toolChain");
  assert.equal(toolChains.length, 2, "visible assistant text splits tool-call chains");
  assert.equal(toolChains[0]!.querySelector(".toolChainLabel")!.textContent, "2 tool calls");
  assert.equal(toolChains[1]!.querySelector(".toolChainLabel")!.textContent, "1 tool call");
  assert.ok(toolChains[1]!.classList.names.has("running"), "running tool chain shows the animated ellipsis state");
  const assistantIndex = children.findIndex((el) => el.className.includes("assistant"));
  assert.ok(assistantIndex > children.indexOf(toolChains[0]!) && assistantIndex < children.indexOf(toolChains[1]!), "normal message bubble remains between chains");
});

test("the Agents panel is read top to bottom: your agent, sign in, API keys folded away, one status line", () => {
  const html = readFileSync("scripts/assets/app.html", "utf8");
  const at = (needle: string) => {
    const i = html.indexOf(needle);
    assert.ok(i > 0, `${needle} is missing from the panel`);
    return i;
  };
  const order = [
    at('id="settingsTitle"'),
    at(">Your agent<"), at('id="settingsHarness"'), at('id="settingsModel"'), at('id="settingsReasoning"'),
    at(">Sign in<"), at('id="agentsSignin"'),
    at('class="agentsKeys"'),
    at('id="settingsStatus"'),
    at('id="settingsSave"'),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "markup order IS the reading order");
  assert.match(html, /<span>API keys<\/span><svg class="ddChevron"/, "the disclosure carries the dropdown's own chevron");
  assert.doesNotMatch(html, /class="agentsKeys open"/, "API keys start folded");
  assert.doesNotMatch(html, /<select/, "not one native select is left in the page");
  assert.doesNotMatch(html, /settingsNote/, "the old explanatory note is gone");
  assert.doesNotMatch(html, /settingsGrid/, "the old two-column grid is gone");
});

test("one entry point: the Agents button lives in the prompt box, immediately left of attach", () => {
  const html = readFileSync("scripts/assets/app.html", "utf8");
  const css = readFileSync("scripts/assets/app.css", "utf8");
  assert.ok(html.indexOf('id="msg"') < html.indexOf('id="agentsOpen"'), "it is inside the composer");
  assert.ok(html.indexOf('id="agentsOpen"') < html.indexOf('id="attach"'), "and comes just before the paperclip");
  assert.match(html, /id="agentsOpen"[^>]*aria-label="Agents"/);
  assert.doesNotMatch(html, /agentPill/, "the pill above the box is gone");
  assert.doesNotMatch(html, /settingsOpen/, "and so is the gear in the footer");
  // Size, colour and hover come from ONE declaration shared with its neighbours.
  assert.match(css, /#agentsOpen,#attach,#mic\{[^}]*width:26px;height:26px[^}]*color:var\(--ink3\)/);
  assert.match(css, /#agentsOpen\{right:89px\}#attach\{right:57px\}/, "32px apart, the same step as attach to mic");
  assert.match(css, /#agentsOpen\{right:calc\(85px \+ env\(safe-area-inset-right\)\)/, "same step again on the mobile safe-area offset");
});

test("the prompt box is twice as tall and reserves 3x insets on its right and bottom", () => {
  const css = readFileSync("scripts/assets/app.css", "utf8");
  const desktop = css.match(/(?:^|[\n},])textarea\{([^}]*)\}/)![1]!;
  assert.match(desktop, /min-height:116px/, "twice the old 58px");
  assert.match(desktop, /padding:13px 45px 39px 15px/, "right 3x the left inset, bottom 3x the top one");
  const mobile = css.slice(css.indexOf("@media(max-width:900px)")).match(/textarea\{([^}]*)\}/)![1]!;
  assert.match(mobile, /min-height:104px/, "twice the old 52px");
  assert.match(mobile, /padding:12px 39px 36px 13px/);
  // The icon row sits 9px (3x the old 3px) off the box's right and bottom edges
  // and is 26px tall, so the 39px bottom band clears it: text and buttons can
  // never overlap.
  assert.match(css, /#agentsOpen,#attach,#mic\{position:absolute;bottom:25px/);
  assert.match(css, /#mic\{right:25px\}/);
  // The menu is sized by its labels, never clipped to its trigger.
  assert.match(css, /\.ddMenu\{[^}]*min-width:100%;width:max-content/);
});

test("the dropdown menu hangs from the trigger's right edge when it would overflow the viewport", () => {
  const js = readFileSync("scripts/assets/app.js", "utf8");
  assert.match(js, /d\.right=true;drawDropdown\(el\)/);
  assert.match(js, /\(d\.right\?' right':''\)/);
});

const TWO_HARNESSES = {
  ...DEFAULT_CATALOG,
  harnesses: [
    { name: "claude-code", label: "Claude Code", models: [{ provider: "anthropic", model: "claude-sonnet-5", keyAvailable: true, requiredEnv: "ANTHROPIC_API_KEY", reasoningEffort: ["low", "medium", "high"] }] },
    { name: "prime-agent", label: "Prime Agent", models: [{ provider: "openrouter", model: "glm-5", keyAvailable: true, requiredEnv: "OPENROUTER_API_KEY" }] },
  ],
};

test("the pickers read as display names, and keep the ids as their values", async () => {
  const { getElement } = bootClient({ now: 10_000_000, uuid: () => "turn-labels", catalog: TWO_HARNESSES });
  await settle(2);

  const harness = getElement("settingsHarness").innerHTML;
  assert.match(harness, /data-ddvalue="claude-code"[^>]*><span class="ddLabel">Claude Code<\/span>/, "the CLI's own name, not its id");
  assert.match(harness, /data-ddvalue="prime-agent"[^>]*><span class="ddLabel">Prime Agent<\/span>/);
  const thinking = getElement("settingsReasoning").innerHTML;
  assert.match(thinking, /data-ddvalue=""[^>]*><span class="ddLabel">Default<\/span>/);
  assert.match(thinking, /data-ddvalue="low"[^>]*><span class="ddLabel">Low<\/span>/);
  assert.match(thinking, /data-ddvalue="medium"[^>]*><span class="ddLabel">Medium<\/span>/);
  assert.match(thinking, /data-ddvalue="high"[^>]*><span class="ddLabel">High<\/span>/);
  assert.equal(getElement("settingsReasoningRow").hidden, false, "the level picker only shows when the model takes levels");
});

test("the dropdown is the app's own: a trigger with a chevron, a menu that opens, picks and closes", async () => {
  const { getElement } = bootClient({ now: 11_000_000, uuid: () => "turn-dd", catalog: TWO_HARNESSES });
  await settle(2);

  const harness = getElement("settingsHarness");
  assert.match(harness.innerHTML, /<button type="button" class="ddTrigger"/);
  assert.equal(ddValueOf(harness), "Claude Code", "the trigger shows the current choice");
  assert.match(harness.innerHTML, /<svg class="ddChevron"/, "with the chevron inside the trigger, not glued to a border");
  assert.match(harness.innerHTML, /<div class="ddMenu" role="listbox" hidden>/, "the menu starts closed");

  ddTriggerOf(harness).dispatch("click");
  assert.equal(harness.className, "dd open", "open tints the host, which is what turns the chevron");
  assert.doesNotMatch(harness.innerHTML, /role="listbox" hidden/);

  harness.querySelector('[data-ddvalue="prime-agent"]')!.dispatch("click");
  assert.equal(ddValueOf(harness), "Prime Agent", "picking sets the value");
  assert.equal(harness.className, "dd", "and closes the menu");
  assert.equal(ddValueOf(getElement("settingsModel")), "glm-5", "the model picker follows the harness");
  assert.equal(getElement("settingsReasoningRow").hidden, true, "and the level picker hides when the model takes none");
});

test("the dropdown works from the keyboard: arrows, Enter, Escape, type-ahead", async () => {
  const { getElement } = bootClient({ now: 12_000_000, uuid: () => "turn-dd-keys", catalog: TWO_HARNESSES });
  await settle(2);

  const harness = getElement("settingsHarness");
  ddKey(harness, "ArrowDown");
  assert.equal(harness.className, "dd open", "an arrow opens a closed menu");
  ddKey(harness, "Escape");
  assert.equal(harness.className, "dd", "Escape closes it and changes nothing");
  assert.equal(ddValueOf(harness), "Claude Code");

  ddKey(harness, "ArrowDown");
  ddKey(harness, "ArrowDown");
  ddKey(harness, "Enter");
  assert.equal(ddValueOf(harness), "Prime Agent", "arrow to the next item, Enter takes it");
  assert.equal(harness.className, "dd");

  ddKey(harness, "c");
  assert.equal(ddValueOf(harness), "Claude Code", "type-ahead on the first letter, exactly like the native control");
});

test("the API keys disclosure is the same chevron, and the section animates open", async () => {
  const { getElement } = bootClient({ now: 13_000_000, uuid: () => "turn-disclosure" });
  await settle(2);

  const box = getElement("agentsKeysBox"), toggle = getElement("agentsKeysToggle");
  assert.ok(!box.classList.names.has("open"), "folded by default");
  toggle.dispatch("click");
  assert.ok(box.classList.names.has("open"));
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  toggle.dispatch("click");
  assert.ok(!box.classList.names.has("open"));
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  const css = readFileSync("scripts/assets/app.css", "utf8");
  // 0fr -> 1fr is what lets a disclosure animate without hard-coding a height.
  assert.match(css, /\.agentsKeysBody\{[^}]*grid-template-rows:0fr[^}]*opacity:0[^}]*transition:grid-template-rows \.15s ease,opacity \.15s ease/);
  assert.match(css, /\.agentsKeys\.open \.agentsKeysBody\{[^}]*grid-template-rows:1fr/);
  assert.match(css, /\.ddChevron\{[^}]*width:16px;height:16px[^}]*transition:transform \.15s ease\}/, "one chevron, 16px, animated");
  assert.match(css, /\.dd\.open \.ddChevron,\.agentsKeys\.open \.ddChevron\{transform:rotate\(180deg\)\}/, "and both turn the same way");
});

test("Connect Claude subscription: the approval URL, then the pasted code, then the connected state", async () => {
  const { getElement, oauthCalls } = bootClient({
    now: 7_000_000,
    uuid: () => "turn-claude-oauth",
    agents: { ok: true, selection: {}, usingOwnKeys: false, envPending: false, credentials: NOTHING_CONNECTED },
    onOAuth: (step, params) => {
      if (step === "start") return { ok: true, sessionId: "sess-1", provider: params.provider, url: "https://claude.ai/oauth/authorize?code=true" };
      return { ok: true, status: "connected", applied: "now", selection: {}, usingOwnKeys: true, envPending: false, credentials: withConnected("claudeSubscription") };
    },
  });
  await settle(2);

  const signin = getElement("agentsSignin");
  assert.match(signin.innerHTML, /Connect Claude subscription/);
  assert.match(signin.innerHTML, /Connect ChatGPT subscription/);

  signin.querySelector('[data-connect="claude"]')!.dispatch("click");
  await settle(3);
  assert.deepEqual(oauthCalls.map((c) => c.step), ["start"]);
  assert.equal(oauthCalls[0]!.params.provider, "claude");
  assert.match(signin.innerHTML, /https:\/\/claude\.ai\/oauth\/authorize\?code=true/, "the URL to approve is on screen");
  assert.match(signin.innerHTML, /data-code="claude"/, "and a field for the code Anthropic prints");

  signin.querySelector('[data-code="claude"]')!.value = "the-code#state";
  signin.querySelector('[data-submit="claude"]')!.dispatch("click");
  await settle(4);

  assert.deepEqual(oauthCalls.map((c) => c.step), ["start", "complete"]);
  assert.equal(oauthCalls[1]!.params.sessionId, "sess-1");
  assert.equal(oauthCalls[1]!.params.code, "the-code#state");
  assert.match(signin.innerHTML, /data-disconnect="claude"/, "a connected subscription offers Disconnect");
  assert.ok(!signin.innerHTML.includes('data-connect="claude"'), "and no longer offers Connect");
  assert.equal(getElement("settingsStatus").textContent, "Runs on your subscription · applied now");
});

test("Connect ChatGPT subscription: a user code to type, polled until the box has it", async () => {
  let polls = 0;
  const { getElement, oauthCalls } = bootClient({
    now: 8_000_000,
    uuid: () => "turn-codex-oauth",
    agents: { ok: true, selection: {}, usingOwnKeys: false, envPending: true, credentials: NOTHING_CONNECTED },
    onOAuth: (step) => {
      if (step === "start") return { ok: true, sessionId: "sess-2", url: "https://auth.openai.com/codex/device", userCode: "WDJB-MJHT", interval: 0 };
      if (++polls < 2) return { ok: true, status: "pending" };
      return { ok: true, status: "connected", applied: "next-start", selection: {}, usingOwnKeys: true, envPending: true, credentials: withConnected("codexSubscription", { detail: "account ····ad94" }) };
    },
  });
  await settle(2);

  const signin = getElement("agentsSignin");
  signin.querySelector('[data-connect="codex"]')!.dispatch("click");
  await settle(3);
  assert.match(signin.innerHTML, /WDJB-MJHT/, "the short code the user types is on screen");
  assert.match(signin.innerHTML, /https:\/\/auth\.openai\.com\/codex\/device/);

  await tick(4);
  assert.deepEqual(oauthCalls.map((c) => c.step), ["start", "status", "status"], "polling stops the moment it connects");
  assert.equal(oauthCalls[1]!.params.sessionId, "sess-2");
  assert.match(signin.innerHTML, /account ····ad94/, "the connected row names the account the backend returned");
  assert.match(signin.innerHTML, /data-disconnect="codex"/);
  assert.equal(getElement("settingsStatus").textContent, "Runs on your subscription · applies at next start");
});

test("Connect Kimi subscription: the approval link carries the code, polled until the box has it", async () => {
  let polls = 0;
  const { getElement, oauthCalls } = bootClient({
    now: 8_500_000,
    uuid: () => "turn-kimi-oauth",
    agents: { ok: true, selection: {}, usingOwnKeys: false, envPending: false, credentials: NOTHING_CONNECTED },
    onOAuth: (step) => {
      if (step === "start") return { ok: true, sessionId: "sess-k", url: "https://auth.kimi.com/device?user_code=KIMI-4321", userCode: "KIMI-4321", interval: 0 };
      if (++polls < 2) return { ok: true, status: "pending" };
      return { ok: true, status: "connected", applied: "now", selection: {}, usingOwnKeys: true, envPending: false, credentials: withConnected("kimiSubscription") };
    },
  });
  await settle(2);

  const signin = getElement("agentsSignin");
  assert.match(signin.innerHTML, /Connect Kimi Code subscription/, "offered next to Claude and ChatGPT");
  signin.querySelector('[data-connect="kimi"]')!.dispatch("click");
  await settle(3);
  assert.equal(oauthCalls[0]!.params.provider, "kimi");
  assert.match(signin.innerHTML, /KIMI-4321/, "the code the user confirms is on screen");
  assert.match(signin.innerHTML, /href="https:\/\/auth\.kimi\.com\/device\?user_code=KIMI-4321"/, "the link carries the code");
  assert.match(signin.innerHTML, /data-cancel="kimi"/);

  await tick(4);
  assert.deepEqual(oauthCalls.map((c) => c.step), ["start", "status", "status"], "polling stops the moment it connects");
  assert.equal(oauthCalls[1]!.params.sessionId, "sess-k");
  assert.match(signin.innerHTML, /data-disconnect="kimi"/);
  assert.equal(getElement("settingsStatus").textContent, "Runs on your subscription · applied now");
});

test("a connected subscription can be disconnected, and the status line falls back to the app's keys", async () => {
  const { getElement, oauthCalls } = bootClient({
    now: 9_000_000,
    uuid: () => "turn-disconnect",
    agents: { ok: true, selection: {}, usingOwnKeys: true, envPending: false, credentials: withConnected("claudeSubscription") },
    onOAuth: () => ({ ok: true, applied: "now", selection: {}, usingOwnKeys: false, envPending: false, credentials: NOTHING_CONNECTED }),
  });
  await settle(2);

  const signin = getElement("agentsSignin");
  assert.match(signin.innerHTML, /data-disconnect="claude"/);
  assert.equal(getElement("settingsStatus").textContent, "Runs on your subscription · applied now");

  signin.querySelector('[data-disconnect="claude"]')!.dispatch("click");
  await settle(4);
  assert.deepEqual(oauthCalls.map((c) => c.step), ["disconnect"]);
  assert.equal(oauthCalls[0]!.params.provider, "claude");
  assert.match(signin.innerHTML, /Connect Claude subscription/);
  assert.equal(getElement("settingsStatus").textContent, "Runs on the app's keys · applied now");
});

test("API keys hold only the typed credentials, masked, and Save posts new values and cleared ones", async () => {
  const { getElement, agentsSaves } = bootClient({
    now: 4_000_000,
    uuid: () => "turn-agents",
    agents: {
      ok: true,
      selection: { harness: "claude", provider: "anthropic", model: "claude-sonnet" },
      usingOwnKeys: true, envPending: false,
      credentials: withConnected("anthropicApiKey", { last4: "9xQ2" }),
    },
    // What the route really answers: the fresh view, secrets still absent.
    onAgentsSave: (body: any) => ({
      ok: true, applied: "now", selection: body.selection, usingOwnKeys: true, envPending: false,
      credentials: withConnected("openaiApiKey", { last4: "nai" }),
    }),
  });
  await settle(2);

  const creds = getElement("agentsCreds");
  assert.ok(!creds.innerHTML.includes("Subscription") && !creds.innerHTML.includes("data-cred=\"claudeSubscription\""),
    "subscriptions live under Sign in, never among the keys");
  for (const id of ["anthropicApiKey", "openaiApiKey", "openrouterApiKey", "llmgatewayApiKey"]) {
    assert.ok(creds.innerHTML.includes(`data-row="${id}"`), `${id} has a row`);
  }
  assert.match(creds.innerHTML, /connected ····9xQ2/, "a connected key reports only its last 4");
  assert.ok(!creds.innerHTML.includes("sk-ant-9xQ2"), "the secret itself never reaches the page");
  assert.match(creds.innerHTML, /data-clear="anthropicApiKey"/, "a connected key offers Clear");
  assert.ok(!creds.innerHTML.includes('data-clear="openaiApiKey"'), "an unconnected key has nothing to clear");

  creds.querySelector('[data-clear="anthropicApiKey"]')!.dispatch("click");
  assert.match(creds.innerHTML, /data-state="anthropicApiKey">removed on save</, "Clear turns the row back into an empty field, marked for removal");
  assert.match(creds.innerHTML, /data-cred="anthropicApiKey"/, "and it can be retyped right away");
  creds.querySelector('[data-cred="openaiApiKey"]')!.value = "sk-new-openai";

  getElement("settingsSave").dispatch("click");
  await settle(4);

  assert.equal(agentsSaves.length, 1);
  assert.deepEqual(agentsSaves[0].credentials, { openaiApiKey: "sk-new-openai", anthropicApiKey: "" },
    "typed values are sent; a cleared credential is sent as the empty string");
  assert.equal(agentsSaves[0].selection.harness, "claude");
  assert.equal(agentsSaves[0].selection.model, "claude-sonnet");
  assert.equal(getElement("settingsStatus").textContent, "Runs on your keys · applied now");
  assert.ok(!creds.innerHTML.includes('data-cred="openaiApiKey"'), "the typed secret leaves the form once it is stored");
});

test("the Agents button is the way in, and the status line carries the state the pill used to", async () => {
  const catalog = {
    ...DEFAULT_CATALOG,
    harnesses: [{ name: "claude-code", label: "Claude Code", models: [{ provider: "anthropic", model: "claude-sonnet-5", label: "Claude Code · claude-sonnet-5", keyAvailable: true, requiredEnv: "ANTHROPIC_API_KEY" }] }],
  };
  const { getElement } = bootClient({
    now: 6_000_000,
    uuid: () => "turn-entry",
    catalog,
    agents: {
      ok: true,
      selection: { harness: "claude-code", provider: "anthropic", model: "claude-sonnet-5" },
      usingOwnKeys: false, envPending: false, credentials: NOTHING_CONNECTED,
    },
    onOAuth: (step, params) => {
      if (step === "start") return { ok: true, sessionId: "sess-3", provider: params.provider, url: "https://claude.ai/oauth/authorize?code=true" };
      return { ok: true, status: "connected", applied: "now", selection: {}, usingOwnKeys: true, envPending: false, credentials: withConnected("claudeSubscription") };
    },
  });
  await settle(2);

  assert.ok(!getElement("settingsBackdrop").classList.names.has("open"), "nothing is blocking, so the panel stays shut");
  getElement("agentsOpen").dispatch("click");
  assert.ok(getElement("settingsBackdrop").classList.names.has("open"), "the button in the prompt box opens it");

  // What the pill used to say now lives in the panel: the two pickers name the
  // agent, the one status line names whose credentials it runs on.
  assert.equal(ddValueOf(getElement("settingsHarness")), "Claude Code");
  assert.equal(ddValueOf(getElement("settingsModel")), "claude-sonnet-5");
  assert.equal(getElement("settingsStatus").textContent, "Runs on the app's keys · applied now");

  const signin = getElement("agentsSignin");
  signin.querySelector('[data-connect="claude"]')!.dispatch("click");
  await settle(3);
  signin.querySelector('[data-code="claude"]')!.value = "pasted";
  signin.querySelector('[data-submit="claude"]')!.dispatch("click");
  await settle(4);
  assert.equal(getElement("settingsStatus").textContent, "Runs on your subscription · applied now",
    "connecting a subscription moves the same line");
});

test("every message bubble is inset by the same amount on all four sides, collapsed or not", () => {
  const css = readFileSync("scripts/assets/app.css", "utf8");
  // One value = top and bottom can never drift apart again.
  for (const rule of [...css.matchAll(/(?:^|[},])\.msg\{([^}]*)\}/g)]) {
    assert.match(rule[1]!, /padding:12px(;|$)/, "the bubble's inset is one value on every side");
  }
  // The global reset gives every button a 42px box; inside a bubble that box
  // would sit below the toggle as dead space a normal message does not have.
  assert.match(css, /(^|\})button\{[^}]*min-height:42px/m, "the global button box is what the toggle must opt out of");
  const toggle = css.match(/\.msgMore\{([^}]*)\}/);
  assert.ok(toggle, ".msgMore must be styled");
  assert.match(toggle![1]!, /min-height:0/, "the toggle takes no minimum control height");
  assert.match(toggle![1]!, /padding:0(;|$)/, "the toggle adds no box of its own");
  assert.doesNotMatch(toggle![1]!, /margin-bottom/, "nothing extra below the toggle");
});

test("a model the user has no key for is greyed out and the one status line says which key to add", async () => {
  const { getElement } = bootClient({
    now: 5_000_000,
    uuid: () => "turn-locked",
    catalog: {
      ...DEFAULT_CATALOG,
      harnesses: [{ name: "codex", label: "Codex", models: [{ provider: "openai", model: "gpt-5", label: "Codex · GPT-5", keyAvailable: false, requiredEnv: "OPENAI_API_KEY" }] }],
    },
  });
  await settle(2);

  const model = getElement("settingsModel").innerHTML;
  assert.match(model, /data-ddvalue="openai\|gpt-5" disabled aria-disabled="true"/, "a model without a key cannot be picked");
  assert.match(model, /<span class="ddLabel">gpt-5<\/span><span class="ddWhy">needs OPENAI_API_KEY<\/span>/, "greyed, with its reason on a second line");
  assert.equal(getElement("settingsStatus").textContent, "Add your OPENAI_API_KEY below to use Codex · GPT-5.");
  assert.ok(getElement("settingsBackdrop").classList.names.has("open"), "the panel opens itself when nothing can run");
});
