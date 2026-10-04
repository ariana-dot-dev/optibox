import assert from "node:assert/strict";
import test from "node:test";
import { BoatHttpClient } from "../src/boatHttpClient.js";

function fakeFetch(statuses: number[]) {
  const calls: string[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const status = statuses.shift() ?? 200;
    return new Response(status === 200 ? JSON.stringify({ sandbox: { id: "bx_1", state: "idle" } }) : "<html>Bad Gateway</html>", { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("a read rides out a 502 from a backend deploy", async () => {
  const f = fakeFetch([502, 503, 200]);
  const client = new BoatHttpClient({ apiKey: "k", baseUrl: "https://boat.test/api/v1", fetchImpl: f.impl });
  const sandbox = await client.get("bx_1");
  assert.equal(sandbox.id, "bx_1");
  assert.equal(f.calls.length, 3);
});

test("a write is never retried, so a prompt can never run twice", async () => {
  const f = fakeFetch([502, 200]);
  const client = new BoatHttpClient({ apiKey: "k", baseUrl: "https://boat.test/api/v1", fetchImpl: f.impl });
  await assert.rejects(client.prompt("bx_1", { provider: "pi", prompt: "hi" }));
  assert.equal(f.calls.length, 1);
});

test("the client speaks the Boat API", async () => {
  const f = fakeFetch([200]);
  const client = new BoatHttpClient({ apiKey: "k", fetchImpl: f.impl });
  await client.get("bx_1");
  assert.equal(f.calls[0], "GET https://boat.dev/api/v1/sandboxes/bx_1");
});
