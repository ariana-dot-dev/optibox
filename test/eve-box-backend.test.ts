import assert from "node:assert/strict";
import test from "node:test";
import { asciiBox, EveBoxUnsupportedError, type EveBoxClient } from "../src/index.js";

class FakeBoxClient implements EveBoxClient {
  boxes = new Map<string, { id: string; state: string; name?: string }>();
  files = new Map<string, Uint8Array>();
  commands: Array<{ boxId: string; input: { command: string; cwd?: string; timeoutMs?: number } }> = [];
  created = 0;
  resumed: string[] = [];

  async create(input: { name?: string; ttlSeconds?: number | null }) {
    const id = `bx_fake${++this.created}`;
    const box = { id, state: "ready", ...(input.name ? { name: input.name } : {}) };
    this.boxes.set(id, box);
    return box;
  }
  async get(boxId: string) { return this.boxes.get(boxId) ?? { id: boxId, state: "ready" }; }
  async update(boxId: string, input: { name?: string }) {
    const box = { ...(await this.get(boxId)), ...input };
    this.boxes.set(boxId, box);
    return box;
  }
  async stop() { return { ok: true }; }
  async resume(boxId: string) { this.resumed.push(boxId); return this.get(boxId); }
  async command(boxId: string, input: { command: string; cwd?: string; timeoutMs?: number }) {
    this.commands.push({ boxId, input });
    if (input.command.startsWith("rm ")) return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 7, stdout: `ran:${input.command}`, stderr: "err" };
  }
  async readFile(boxId: string, path: string) {
    const bytes = this.files.get(`${boxId}:${path}`);
    if (!bytes) throw Object.assign(new Error("missing"), { status: 404 });
    return new TextDecoder().decode(bytes);
  }
  async writeFile(boxId: string, path: string, content: string) {
    this.files.set(`${boxId}:${path}`, new TextEncoder().encode(content));
  }
  async readFileBinary(boxId: string, path: string) { return this.files.get(`${boxId}:${path}`) ?? null; }
  async writeFileBinary(boxId: string, path: string, content: Uint8Array) { this.files.set(`${boxId}:${path}`, content); }
}

test("asciiBox creates an Eve backend that runs commands and persists box metadata", async () => {
  const client = new FakeBoxClient();
  const backend = asciiBox({ client, name: ({ sessionKey }) => `eve-${sessionKey}`, networkPolicy: "allow-all" });
  assert.equal(backend.name, "ascii-box");

  const handle = await backend.create({ templateKey: null, sessionKey: "session-1", runtimeContext: { appRoot: "/app" } });
  const sandbox = await handle.useSessionFn({ networkPolicy: "allow-all" });

  assert.equal(sandbox.id, "session-1");
  assert.equal(sandbox.resolvePath("foo.txt"), "/workspace/foo.txt");

  const result = await sandbox.run({ command: "echo hi", workingDirectory: "repo", env: { TOKEN: "secret value" } });
  assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /ran:export TOKEN='secret value'; echo hi/);
  assert.equal(client.commands.at(-1)?.input.cwd, "repo");

  await sandbox.writeTextFile({ path: "dir/a.txt", content: "one\ntwo\nthree\n" });
  assert.equal(await sandbox.readTextFile({ path: "/workspace/dir/a.txt", startLine: 2, endLine: 2 }), "two\n");

  await sandbox.writeBinaryFile({ path: "bin.dat", content: new Uint8Array([0, 255, 42]) });
  assert.deepEqual([...(await sandbox.readBinaryFile({ path: "bin.dat" }) ?? [])], [0, 255, 42]);

  await sandbox.removePath({ path: "dir", recursive: true, force: true });
  assert.match(client.commands.at(-1)?.input.command ?? "", /^rm -fr -- 'dir'/);

  const state = await handle.captureState();
  assert.deepEqual(state, { backendName: "ascii-box", sessionKey: "session-1", metadata: { boxId: "bx_fake1" } });
});

test("asciiBox reconnects to the persisted Box id instead of creating a new Box", async () => {
  const client = new FakeBoxClient();
  client.boxes.set("bx_keep", { id: "bx_keep", state: "ready" });
  const backend = asciiBox({ client });
  const handle = await backend.create({ templateKey: null, sessionKey: "session-2", existingMetadata: { boxId: "bx_keep" }, runtimeContext: { appRoot: "/app" } });
  assert.equal(client.created, 0);
  assert.deepEqual(client.resumed, ["bx_keep"]);
  assert.equal((await handle.captureState()).metadata.boxId, "bx_keep");
});

test("asciiBox explicitly rejects unsupported network policies", async () => {
  const client = new FakeBoxClient();
  assert.throws(() => asciiBox({ client, networkPolicy: "deny-all" }), EveBoxUnsupportedError);
  const backend = asciiBox({ client });
  const handle = await backend.create({ templateKey: null, sessionKey: "session-3", runtimeContext: { appRoot: "/app" } });
  await assert.rejects(() => handle.session.setNetworkPolicy("deny-all"), EveBoxUnsupportedError);
});

test("asciiBox replays recorded seed files and bootstrap on first create", async () => {
  const client = new FakeBoxClient();
  const backend = asciiBox({ client });
  await backend.prewarm({
    templateKey: "tpl",
    runtimeContext: { appRoot: "/app" },
    seedFiles: [{ path: "seed.txt", content: "seeded" }],
    bootstrap: async ({ use }) => {
      const sandbox = await use();
      await sandbox.writeTextFile({ path: "boot.txt", content: "booted" });
    },
  });
  const handle = await backend.create({ templateKey: "tpl", sessionKey: "session-4", runtimeContext: { appRoot: "/app" } });
  assert.equal(await handle.session.readTextFile({ path: "seed.txt" }), "seeded");
  assert.equal(await handle.session.readTextFile({ path: "boot.txt" }), "booted");
});
