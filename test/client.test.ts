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
  harnesses: [{ name: "claude", models: [{ provider: "anthropic", model: "claude-sonnet", keyAvailable: true }] }],
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
    "agentsCreds", "settingsNote", "settingsStatus", "settingsSave", "settingsClose", "settingsOpen", "agentPill",
  ]) getElement(id);

  const sendRequests: any[] = [];
  const agentsSaves: any[] = [];
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
  return { getElement, sendRequests, agentsSaves };
}

const settle = async (times = 1) => { for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r)); };

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

test("Agents panel shows connected credentials masked, and Save posts new values, cleared ones and the selection", async () => {
  const { getElement, agentsSaves } = bootClient({
    now: 4_000_000,
    uuid: () => "turn-agents",
    agents: {
      ok: true,
      selection: { harness: "claude", provider: "anthropic", model: "claude-sonnet" },
      usingOwnKeys: true,
      envPending: false,
      credentials: [
        { id: "anthropicApiKey", label: "Anthropic API key", hint: "sk-ant-…", kind: "env", target: "ANTHROPIC_API_KEY", multiline: false, connected: true, last4: "9xQ2" },
        { id: "openaiApiKey", label: "OpenAI API key", hint: "sk-…", kind: "env", target: "OPENAI_API_KEY", multiline: false, connected: false, last4: "" },
        { id: "codexSubscription", label: "Codex ChatGPT subscription", hint: "auth.json", kind: "file", target: ".codex/auth.json", multiline: true, connected: false, last4: "" },
      ],
    },
    // What the route really answers: the fresh view, secrets still absent.
    onAgentsSave: (body: any) => ({
      ok: true, applied: "now", message: "applied to your box now", selection: body.selection, usingOwnKeys: true, envPending: false,
      credentials: [
        { id: "anthropicApiKey", label: "Anthropic API key", hint: "sk-ant-…", kind: "env", target: "ANTHROPIC_API_KEY", multiline: false, connected: false, last4: "" },
        { id: "openaiApiKey", label: "OpenAI API key", hint: "sk-…", kind: "env", target: "OPENAI_API_KEY", multiline: false, connected: true, last4: "nai" },
        { id: "codexSubscription", label: "Codex ChatGPT subscription", hint: "auth.json", kind: "file", target: ".codex/auth.json", multiline: true, connected: false, last4: "" },
      ],
    }),
  });
  await settle(2);

  const creds = getElement("agentsCreds");
  assert.match(creds.innerHTML, /connected · ••••9xQ2/, "a connected credential reports only its last 4");
  assert.ok(!creds.innerHTML.includes("sk-ant-9xQ2"), "the secret itself never reaches the page");
  assert.match(creds.innerHTML, /data-clear="anthropicApiKey"/, "a connected credential offers Clear");
  assert.ok(!creds.innerHTML.includes('data-clear="openaiApiKey"'), "an unconnected credential has nothing to clear");
  assert.match(creds.innerHTML, /<textarea[^>]*data-cred="codexSubscription"/, "the Codex auth.json is a textarea");

  // Type a new OpenAI key, and clear the Anthropic one.
  creds.querySelector('[data-cred="openaiApiKey"]')!.value = "sk-new-openai";
  creds.querySelector('[data-clear="anthropicApiKey"]')!.dispatch("click");
  assert.equal(creds.querySelector('[data-state="anthropicApiKey"]')!.textContent, "will be removed on save");

  getElement("settingsSave").dispatch("click");
  await settle(4);

  assert.equal(agentsSaves.length, 1);
  assert.deepEqual(agentsSaves[0].credentials, { openaiApiKey: "sk-new-openai", anthropicApiKey: "" },
    "typed values are sent; a cleared credential is sent as the empty string");
  assert.equal(agentsSaves[0].selection.harness, "claude");
  assert.equal(agentsSaves[0].selection.model, "claude-sonnet");
  assert.equal(getElement("settingsStatus").textContent, "applied to your box now");
  assert.equal(creds.querySelector('[data-cred="openaiApiKey"]')!.value, "", "typed secrets are wiped from the form after the save");
});

test("the composer pill names the running agent and whose keys it runs on, and opens the panel", async () => {
  const catalog = {
    ...DEFAULT_CATALOG,
    harnesses: [{ name: "claude-code", models: [{ provider: "anthropic", model: "claude-sonnet-5", label: "Claude Code · claude-sonnet-5", keyAvailable: true, requiredEnv: "ANTHROPIC_API_KEY" }] }],
  };
  const { getElement } = bootClient({
    now: 6_000_000,
    uuid: () => "turn-pill",
    catalog,
    agents: {
      ok: true,
      selection: { harness: "claude-code", provider: "anthropic", model: "claude-sonnet-5" },
      usingOwnKeys: false,
      envPending: false,
      credentials: [{ id: "anthropicApiKey", label: "Anthropic API key", hint: "sk-ant-…", kind: "env", target: "ANTHROPIC_API_KEY", multiline: false, connected: false, last4: "" }],
    },
    onAgentsSave: (body: any) => ({
      ok: true, applied: "now", message: "applied to your box now", selection: body.selection, usingOwnKeys: true, envPending: false,
      credentials: [{ id: "anthropicApiKey", label: "Anthropic API key", hint: "sk-ant-…", kind: "env", target: "ANTHROPIC_API_KEY", multiline: false, connected: true, last4: "hro1" }],
    }),
  });
  await settle(2);

  const pill = getElement("agentPill");
  assert.equal(pill.textContent, "Claude Code · claude-sonnet-5 · server keys",
    "the pill mirrors the selection GET /api/agents returned");

  // It is the same entry point as the gear.
  pill.dispatch("click");
  assert.ok(getElement("settingsBackdrop").classList.names.has("open"));

  getElement("agentsCreds").querySelector('[data-cred="anthropicApiKey"]')!.value = "sk-ant-hro1";
  getElement("settingsSave").dispatch("click");
  await settle(4);
  assert.equal(pill.textContent, "Claude Code · claude-sonnet-5 · your keys",
    "saving a key of your own flips the pill to 'your keys'");
});

test("the 'Show N more lines' toggle is a text row, so a collapsed bubble ends with the same padding as any other", () => {
  const css = readFileSync("scripts/assets/app.css", "utf8");
  // The global reset gives every button a 42px box; inside a bubble that box
  // would sit below the toggle as dead space a normal message does not have.
  assert.match(css, /(^|\})button\{[^}]*min-height:42px/m, "the global button box is what the toggle must opt out of");
  const rule = css.match(/\.msgMore\{([^}]*)\}/);
  assert.ok(rule, ".msgMore must be styled");
  assert.match(rule![1]!, /min-height:0/, "the toggle takes no minimum control height");
  assert.match(rule![1]!, /padding:0(;|$)/, "the toggle adds no vertical padding of its own");
  // Only the bubble's own padding separates the last row from the bubble edge,
  // whichever row that is.
  assert.doesNotMatch(rule![1]!, /margin-bottom/, "nothing extra below the toggle");
});

test("a model the user has no key for is greyed out and the panel says which key to add", async () => {
  const { getElement } = bootClient({
    now: 5_000_000,
    uuid: () => "turn-locked",
    catalog: {
      ...DEFAULT_CATALOG,
      harnesses: [{ name: "codex", models: [{ provider: "openai", model: "gpt-5", label: "Codex · GPT-5", keyAvailable: false, requiredEnv: "OPENAI_API_KEY" }] }],
    },
  });
  await settle(2);

  assert.match(getElement("settingsModel").innerHTML, /disabled/, "a model without a key cannot be picked");
  assert.match(getElement("settingsStatus").textContent, /Add your OPENAI_API_KEY in Agents/);
  assert.ok(getElement("settingsBackdrop").classList.names.has("open"), "the panel opens itself when nothing can run");
});
