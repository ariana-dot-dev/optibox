# Eve sandbox backend for Ascii Box

Optibox exports an Eve `SandboxBackend` factory for running Eve sandboxes on Ascii Box (`box.ascii.dev` / the Box public API).

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { asciiBox } from "@ascii-prototypes/consumer-box-agents";

export default defineSandbox({
  backend: asciiBox({
    apiKey: process.env.BOX_API_KEY!,
    ttlSeconds: 3600,
  }),
});
```

Folder layout with seeded files works too:

```ts title="agent/sandbox/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { asciiBox } from "@ascii-prototypes/consumer-box-agents";

export default defineSandbox({
  backend: asciiBox({
    apiKey: process.env.BOX_API_KEY!,
    name: ({ sessionKey }) => `eve-${sessionKey}`,
  }),
  async onSession({ use }) {
    const sandbox = await use({ networkPolicy: "allow-all" });
    await sandbox.writeTextFile({ path: "SESSION.txt", content: `${sandbox.id}\n` });
  },
});
```

## Capability mapping

- `create`/resume: creates a Box through the v1 API, or reconnects to `metadata.boxId` from Eve's persisted session state.
- `create` uses Box v1 `ttlSeconds`; set `ttlSeconds: 300` for five-minute test boxes or your desired app retention window.
- `run`: maps to `POST /boxes/{boxId}/commands` with `cwd` as a relative path inside the Box work directory, per the current Box API.
- `spawn`: starts a background shell process in the Box and exposes `stdout`, `stderr`, `wait()`, and `kill()` by polling files in `.eve-spawn/`.
- `readTextFile`/`writeTextFile`: map Eve `/workspace/...` paths to Box file API paths relative to the Box work directory (`workspace/...`).
- `readBinaryFile`/`writeBinaryFile`: use Box `base64` file encoding via the current Box v1 API when the client provides binary methods; otherwise fall back to UTF-8.
- `removePath`: maps to `rm` inside the Box workspace.
- `resolvePath`: anchors relative paths to `/workspace`, matching Eve's sandbox contract.

## Current gaps

Ascii Box currently does not expose Eve's firewall/credential-brokering network policy API. The adapter accepts `"allow-all"` as a no-op and throws `EveBoxUnsupportedError` for `"deny-all"`, allow-lists, subnet rules, or credential transforms so applications do not get a false sense of isolation.

Box also does not expose cloneable Eve template snapshots. `prewarm()` records seed files and bootstrap code in-process, then replays them when a new session Box is created. This supports local/dev usage, but production deployments that require build-time template materialization should avoid `bootstrap`/seed files with this backend until Box exposes snapshot cloning.

## Real API tests

The Eve backend tests intentionally use the real Box API. They require `BOX_API_KEY` and create one shared Box per test process with `ttlSeconds: 300` (five minutes), then reuse that Box for every Eve adapter assertion in the file. No fake Box client, mocks, stubs, or per-test Boxes are used for this adapter.

```bash
BOX_API_KEY=box_... npm run test:eve-box
# or run the full suite, which includes the real Eve Box adapter tests:
BOX_API_KEY=box_... npm test
```

The implementation was aligned with the current Box docs index (`https://docs.ascii.dev/llms.txt`), the TypeScript SDK guide, and the Box v1 create/command/file endpoint references.
