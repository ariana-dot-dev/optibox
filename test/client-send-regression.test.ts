import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

class FakeClassList {
  toggle(_name: string, _force?: boolean) {}
}

class FakeElement {
  id = "";
  value = "";
  checked = false;
  disabled = false;
  textContent = "";
  innerHTML = "";
  className = "";
  scrollTop = 0;
  scrollHeight = 0;
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  listeners = new Map<string, Function[]>();
  children: FakeElement[] = [];

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

  appendChild(el: FakeElement) {
    this.children.push(el);
    return el;
  }

  remove() {}
  focus() {}

  querySelector(selector: string) {
    if (selector === ".body") return this;
    return null;
  }
}

function extractClientScript(source: string) {
  const match = source.match(/return `([\s\S]*)`;\n}\s*$/);
  assert(match, "interactive demo html() template should be extractable");
  const html = Function(`return \`${match[1]}\`;`)() as string;
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert(script, "interactive demo should include inline client script");
  return script;
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

test("interactive demo client sends exactly one /api/send after page load", async () => {
  const script = extractClientScript(readFileSync("scripts/interactive-proof-server.ts", "utf8"));
  const elements = new Map<string, FakeElement>();
  const getElement = (id: string) => {
    let el = elements.get(id);
    if (!el) {
      el = new FakeElement(id);
      elements.set(id, el);
    }
    return el;
  };
  for (const id of [
    "composer",
    "msg",
    "send",
    "stopBox",
    "showTraces",
    "chat",
    "empty",
    "schematic",
    "routeStatus",
    "machineState",
    "totalSeconds",
    "totalCost",
    "autoStopTimer",
    "matrix",
  ]) getElement(id);

  const sendRequests: any[] = [];
  let now = 1_000_000;
  const context = vm.createContext({
    console: { ...console, debug() {} },
    AbortController,
    TextDecoder,
    TextEncoder,
    URLSearchParams,
    location: { search: "" },
    setInterval,
    clearInterval,
    document: {
      body: new FakeElement("body"),
      getElementById: getElement,
      createElement: () => new FakeElement(),
    },
    globalThis: { crypto: { randomUUID: () => `turn-${sendRequests.length + 1}` } },
    Date: Object.assign(class extends Date { static now() { now += 1000; return now; } }, Date),
    fetch: async (url: string, init?: any) => {
      if (url === "/api/harnesses") {
        return {
          ok: true,
          json: async () => ({
            harnesses: [{ name: "claude", models: [{ provider: "anthropic", model: "claude-sonnet", keyAvailable: true }] }],
            runtimeFeasibility: [],
            pricing: { ratePerSecond: 0.001 },
          }),
        };
      }
      if (url === "/api/send") {
        sendRequests.push(JSON.parse(init.body));
        return { ok: true, body: makeReadableSse([{ type: "stream.end" }]) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  vm.runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));

  const msg = getElement("msg");
  const send = getElement("send");
  const composer = getElement("composer");

  msg.value = "button message";
  send.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendRequests.length, 1);
  assert.equal(msg.value, "", "send clears the textarea visibly");

  msg.value = "form message";
  composer.dispatch("submit");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendRequests.length, 2);

  msg.value = "enter message";
  msg.dispatch("keydown", { key: "Enter", code: "Enter", shiftKey: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendRequests.length, 3);

  msg.value = "beforeinput message";
  msg.dispatch("beforeinput", { inputType: "insertLineBreak", shiftKey: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendRequests.length, 4);

  msg.value = "combined enter";
  msg.dispatch("beforeinput", { inputType: "insertParagraph", shiftKey: false });
  msg.dispatch("keydown", { key: "Enter", code: "Enter", shiftKey: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendRequests.length, 5, "beforeinput + keydown should still produce one request");
  assert.deepEqual(sendRequests.map((r) => r.message), [
    "button message",
    "form message",
    "enter message",
    "beforeinput message",
    "combined enter",
  ]);
});
