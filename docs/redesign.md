# Optibox redesign: Postgres-backed, one truth, one way

2026-07-10. Full rewrite mandate: no feature loss, fix the broken features, 10x
simpler coordination, Postgres as the ONLY state. The other agent's WIP is
absorbed (its intents are in the checklist). This doc is the contract; the
rewrite is wrong wherever it disagrees with this doc, and this doc is wrong
wherever it disagrees with the 6-rule spec.

## The 6 rules (authoritative spec, verbatim intent)

1. Always answer something, even if it's just to make the user wait.
2. The private-machine agent can decide to answer on top.
3. The shared agent decides: has all it needs (no tools) → answers fully;
   needs tools → short social holding line.
4. The machine stops when all pending messages are finished + idle time
   passed; a new message resets the countdown.
5. Skip the shared machine when the user machine is ON and responsive.
6. Box agent declining to answer = exactly `<end>`, nothing shown. No
   preemptive classifying. Binding: NO fallbacks — crash loudly. A box run
   with no text and no `<end>` is a loud `turn.blocked`.

## Why the rewrite (the disease, from 2026-07-09/10 incidents)

1. All coordination state was in one process's RAM → every restart = amnesia
   (orphan reaper existed only to mop that up, then caused cross-instance
   reaping); two processes fought over one Box account; deploys killed turns.
2. Truth was inferred, not recorded: ownership from box NAMES, template
   validity from box STATE (poisoned-template incident), hosting from REGEX
   on command text with no provenance, liveness from poll behavior.
3. Failures swallowed (`catch {}` retry-forever, silent install fallback) —
   invariants broke silently, surfaced hours later as unrelated weirdness.

## Design invariants (enforced by schema, not vigilance)

- ONE user = ONE active box: `UNIQUE (user_key) WHERE purpose='user' AND
  retired_at IS NULL`. Double-create is impossible, not discouraged.
- Billing ends in ONE place: a single UPDATE that folds elapsed into
  `users.billed_seconds` and nulls `billing_since` atomically.
- Every box this system may touch has a row. The sweeper acts ONLY on rows.
  Boxes on the account without rows are invisible (multi-instance safety is
  structural; the name prefix `optibox-<instanceId>-` remains only for human
  legibility and immunity to historical reapers).
- Hosting is a row with provenance (conversation, started_at, url) and a
  durable stop intent. The banner renders rows, never inferences.
- Cross-process mutual exclusion = pg advisory locks (user-scoped for box
  lifecycle, conversation-scoped for turn ordering). No in-memory lock maps,
  no boot-ack promise plumbing (the wedge class dies).
- Templates: `status='ready'` row required to fork. A failed build can never
  be forked (poisoned-template class dies). In-turn reinstall stays deleted.
- No silent catch in the turn/box path: recover loudly or crash loudly.

## Postgres topology (ONE server, no second way)

Postgres 16 in Docker on the hosting box (bx_qkt6gu93), volume
`/home/user/pgdata`, port 5432 on the dedicated IPv4, scram auth, strong
generated password in `.env` (`DATABASE_URL`). Databases: `optibox` (prod),
`optibox_dev` (local dev server), `optibox_test_*` (created/dropped by the
test bootstrap). Local dev and tests connect to the same server over TCP —
no docker locally, no embedded binaries, no emulator. Schema is applied by
`migrate()` at process start (idempotent CREATE ... IF NOT EXISTS).

## Schema

```sql
create table instances (
  id text primary key,             -- persisted .optibox-instance-id
  heartbeat_at timestamptz not null default now()
);
create table users (
  key text primary key,            -- "<fingerprintUserId>-<credHash8>" (BYOK-scoped, as today)
  billed_seconds double precision not null default 0,
  last_activity_at timestamptz not null default now()
);
create table boxes (
  id text primary key,             -- Box API id
  user_key text not null references users(key),
  instance_id text not null,
  purpose text not null check (purpose in ('user','template')),
  billing_since timestamptz,       -- null = parked / not billing
  billing_reason text,             -- 'turn' | 'composing' | 'fs' | ...
  retired_at timestamptz,          -- replaces rename-supersede
  created_at timestamptz not null default now()
);
create unique index one_active_user_box on boxes(user_key)
  where purpose='user' and retired_at is null;
create table conversations (
  user_key text not null,
  id text not null,
  harness_sessions jsonb not null default '{}',  -- {"<harness>:<phase>": "<native id>"}
  primary key (user_key, id)
);
create table transcripts (
  user_key text not null, conversation_id text not null,
  seq bigserial primary key,
  role text not null, content text not null, mode text, at timestamptz not null default now()
);
create index transcripts_conv on transcripts(user_key, conversation_id, seq);
create table turns (
  id uuid primary key,
  user_key text not null, conversation_id text not null,
  message text not null, fingerprint text not null,
  status text not null check (status in ('active','answered','suppressed','blocked','interrupted')),
  created_at timestamptz not null default now(), done_at timestamptz
);
create index turns_active on turns(user_key, conversation_id) where status='active';
create table holds (
  user_key text not null, reason text not null, expires_at timestamptz not null,
  primary key (user_key, reason)
);
create table hosting (
  user_key text not null, port int not null,
  conversation_id text not null,   -- provenance: which chat started it
  box_id text not null, mode text not null check (mode in ('public','private')),
  url text, started_at timestamptz not null default now(),
  stop_requested_at timestamptz,   -- durable stop intent
  misses int not null default 0,   -- consecutive ground-truth probes without the process
  primary key (user_key, port)
);
create table templates (
  instance_id text primary key,
  box_id text not null,
  status text not null check (status in ('building','ready','failed')),
  built_at timestamptz
);
```

## Module map (target sizes)

```
src/db.ts        ~220   pg pool, migrate(), advisory locks, typed query helpers
src/engine.ts    ~750   the 6 rules: turns, box lifecycle, billing, holds,
                        hosting, sweeper, template build (absorbs orchestrator
                        3039 + store + parts of capabilities)
src/boxHttpClient.ts    kept as-is (~220)
src/harness.ts   ~650   realCliHarness + prompt bundle + output parsers +
                        runHarness polling + sharedDirectStream (absorbs
                        examples/shared.ts + capabilities runtimes)
src/types.ts     ~180   slimmed events/options
examples/*/adapter.ts   kept as-is (specs are data)
scripts/server.ts ~500  http routes on engine; graceful drain; static serving
scripts/assets/app.html/app.css/app.js   the UI, moved out of the template
scripts/assets/fs-panel.js/css, mobile.js kept
test/engine.test.ts     behavioral port of the 69 tests (real PG, test db)
test/client.test.ts     client-send regression against app.js as a file
```

Deleted entirely (obsolete by durable truth): orphan sweep, name-based
adoption, rename-supersede, boot-ack promise plumbing + both capped
checkpoints, recovery-event buffering, per-credential orchestrator cache
(engine is one; BoxClient is per-credential at call sites), in-memory
billing/holds/hosting/rounds/sessions/transcripts maps, `.optibox-last-built`
poller marker stays (deploy-side).

## Behavior mapping (regress-nothing checklist)

Turn flow (rules 1/3/5/6):
- [ ] insert turn row; concurrent identical message (same fingerprint, one
      still active/just answered) → suppressed round, original still answers
- [ ] rule 5: box ON + responsive → direct route, no shared bridge text
- [ ] otherwise shared bridge streams immediately (sharedModel, direct
      provider stream); box ensure runs concurrently under user advisory lock
- [ ] box round serialized per conversation (advisory lock), runs with
      freshest transcript; `<end>` renders nothing; no-text-no-end →
      turn.blocked with diagnostic tail (loud)
- [ ] interrupt: client abort kills the in-box process; session id preserved
      for resume; per-harness resume strategies unchanged (assign/capture)
- [ ] per-turn receipt, billing events, lifecycle events, tool events, desktop
      widget trigger (isDesktopCommand), file-deliverables deck (optibox-files
      tag), box.files.ondisk manifest — same event stream contract for the UI
Machine lifecycle (rule 4):
- [ ] wake paths (turn, typing/click, upload, fs) all = one wakeBox() writing
      billing_since + reason; runtime snapshot = one SQL view; UI reconciles
      from it (fast channel on /api/fs/activity response kept)
- [ ] sweeper (5s): stop boxes idle past autoStopIdleMs with no active turns,
      unexpired holds, or hosting; absolute 30min ceiling unless hosting;
      visible countdown = idleStopEta in snapshot (client renders; no server
      tick stream) — stop at countdown zero, billing ends at stop REQUEST
- [ ] fork-from-template only when templates.status='ready' (detached install
      + exit marker + warm pass kept verbatim); no template → plain create;
      box without harness binary → loud crash (reinstall stays banned)
- [ ] wake-on-type cold boot, composing/upload/desktop holds with TTLs
Hosting:
- [ ] detect `host <port> --public|--private` in tool commands → row with
      conversation provenance; banner shows URL + provenance + quiet stop
      (flat white bar, no card/green/red — WIP style absorbed)
- [ ] ground-truth probe rides fs poll: pgrep on the user's ONE box;
      2-miss grace; fresh stop intent kills on sight instead of re-marking
- [ ] stop-hosting: durable intent + kill on the row's box; TTL pushed out
      while hosting; hosting blocks idle-stop and the 30min ceiling
UI (all current features, plus WIP fixes):
- [ ] chat, traces toggle, counters (projection of billed_seconds + live
      window), auto-stop countdown, warming pulse, backend diagram, settings/
      BYOK, model/harness picker, attachments (decks, pending, 150MB cap,
      raw-binary upload), voice messages (whisper), link previews (bare-domain
      detection), full-width carousels + Phosphor caret arrows, no horizontal
      chat overflow, shadow room fix, desktop stream + in-place VNC switch,
      files panel (live/snapshot/upload/delete/viewer), mobile horizontal
      pager + keyboard handling, per-device fingerprint users, hosting bar
Ops:
- [ ] graceful deploy: /api/busy + SIGTERM drain (finish streams ≤8min, refuse
      new sends with a clear retry message); poller waits for idle before
      restart — deploys NEVER kill live turns
- [ ] instance heartbeat row; boxes of a dead instance are adoptable by row
      update, never re-created
- [ ] diagnostics endpoint (audit ring) kept; og proxy, transcribe kept

## Cutover

Branch `redesign` (main stays deployable; poller keeps serving old code).
When the suite + a real e2e pass on the branch against `optibox_dev`, provision
prod PG, fast-forward main, deploy, verify live turn + hosting stop + files.
