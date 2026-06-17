import assert from "node:assert/strict";
import { BoxHttpClient } from "../src/index.js";

async function main() {
  const apiKey = process.env.BOX_API_KEY;
  if (!apiKey) throw new Error("Set BOX_API_KEY for real Box smoke test");
  const box = new BoxHttpClient({ apiKey });
  const created = await box.create({ name: `eve-box-smoke-${Date.now()}`, ttlSeconds: 300 });
  console.log(`created ${created.id}`);
  try {
    let current = created;
    for (let i = 0; i < 60 && !["ready", "idle", "running"].includes(current.state); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      current = await box.get(created.id);
    }
    assert.ok(["ready", "idle", "running"].includes(current.state), `box became runnable: ${current.state}`);
    if (box.command) {
      const result = await box.command(created.id, { command: "printf box-user-mode-ok", timeoutMs: 10_000 });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /box-user-mode-ok/);
      console.log(`command ok on ${created.id}: ${result.stdout}`);
    }
    if (box.writeFile && box.readFile) {
      await box.writeFile(created.id, "eve-box-smoke.txt", "box-file-ok\n");
      const content = await box.readFile(created.id, "eve-box-smoke.txt");
      assert.match(content, /box-file-ok/);
      console.log(`file write/read ok on ${created.id}`);
    }
  } finally {
    await box.stop(created.id).catch(() => undefined);
    console.log(`stopped ${created.id}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
