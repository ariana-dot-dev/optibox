---
name: scenario-timetravel-design
description: "Agreed designs for time-travel (machine rewind) and parallel alternative scenarios, incl. the user's UX spec"
metadata: 
  node_type: memory
  type: project
  originSessionId: a2cc9c89-d23d-4702-8c6a-59b01bb88cad
---

Two flagship features designed 2026-07-10 with the user (pre-PG-rewrite discussion, mapped onto the new engine). Not built yet.

**Time travel / rewind:** fork(boxId) clones only the LATEST snapshot (no snapshot arg; snapshots happen on park). Per-turn rewind needs either (1) checkpoint-by-fork — fork the RUNNING box each turn boundary (~1.5s measured), keep the fork archived as the checkpoint; hinges on the UNVERIFIED question whether forking a running box captures live disk (2-min probe: write marker → fork while running → check marker) — or (2) Box-team API: snapshot-now / fork-from-snapshot-id. Free today: latest-snapshot fork = session-granularity rewind. New-engine fit: checkpoints are `boxes` rows purpose='checkpoint' (+turn provenance); one-active-box unique index only constrains purpose='user' so invariant untouched; rewind = retire active row + fork checkpoint into new purpose='user' row.

**Parallel scenarios:** the SHARED model decides ambiguity (user confirmed "cleaner") via a hidden trailing tag `<optibox-fork>label A | label B</optibox-fork>` (same strip machinery as <optibox-files>); engine forks N ways, same prompt + per-scenario directive. Doesn't violate rule 3 — shared only fans out how many private runs.

User's UX spec (preserve verbatim intent): dashed line in chat at the fork with arrow at its RIGHT end, centered "<N> alternative scenarios", left arrow only when navigable left; chat BELOW swipes as a carousel, one live-streaming pane per scenario; files panel follows the visible pane's machine; time/cost counters AGGREGATE across scenario boxes; auto-stop indicator color-coded to current thread, threads color-coded; tap-to-keep → siblings stopped (billing drops), carousel collapses to linear chat with winner's branch + receipt "explored 2 scenarios · kept B · $X total".

New-engine fit: scenario = boxes row purpose='scenario' + scenario_group/label; transcripts get optional scenario_id; winner-merge copies branch into main; aggregate billing = sum over user's box rows; SSE events gain scenarioId. Build order (shippable steps): (1) engine fan-out + scenario-tagged events behind a flag, (2) carousel UI + colors, (3) winner select/collapse + aggregate receipt.

Related demo ideas ranked earlier: warming-on-type + per-turn receipt (SHIPPED), one bulletproof desktop moment, returning-user story, human-takes-the-wheel, fleet finale. See [[optibox-postgres-rewrite]] for the engine this builds on.

---

## Progress & findings (2026-07-11)

**Time-travel probe result (settled).** `box fork` REQUIRES a completed snapshot; snapshots happen only periodically or on `stop`. There is no snapshot-now or fork-from-snapshot-id in the CLI. So forking a *running* box captures the last snapshot, NOT live disk — the doc's option-1 assumption is false. On-demand checkpoints are only possible via **stop → snapshot → fork** (verified working). Consequences: snapshot-granularity rewind is cheap (fork latest snapshot); exact per-turn rewind needs stop+fork+resume per turn (an extra checkpoint box per turn) or a Box-team API that doesn't exist. Time-travel is deferred; the user chose to build parallel scenarios first.

**Parallel scenarios — step 1 SHIPPED (commit 3abbc959, flagged off in prod).** Engine fan-out behind `EngineOptions.scenariosEnabled` (server env `OPTIBOX_SCENARIOS=1`). The shared model emits `<optibox-fork>A | B</optibox-fork>` — delivered as a REAL system instruction (via `SharedContext.directive` → `buildHarnessInstructions`) that explicitly overrides the shared surface's "never output tags" rule; a directive buried in hidden context was IGNORED (the model treats hidden context as inert). `runTurn` → `runScenarios`: one fresh scenario box per label (`boxes.purpose='scenario'` + scenario_group/label), own conv lock, `mergeGenerators` interleaves the streams, every event stamped scenarioId/scenarioLabel, journaled. Scenario answers written with `transcripts.scenario_id`, kept out of main-line context (`getTranscript` filters `scenario_id is null`). Fan-out stops+retires its boxes; sweep reaps crash-orphans. `wakeBox(boxId)` bills a specific box; `boxes.purpose` CHECK widened to admit scenario/checkpoint. Unit suite 22/22; e2e: fork tag → 2 parallel boxes → 18 scenario-tagged journal events.

**Step 1b reliability — ROOT-CAUSED & FIXED (real logs).** Symptom: a scenario would build+host its site but `box.no-answer`, flakily (one of a pair answered, the other blocked). NOT a warmth/fan-out issue. Ground truth: pi's `--mode json` embeds a CUMULATIVE message snapshot in EVERY event, so a real portfolio build's stdout log grew to **14 MB** (final answer at byte 13.4 MB). The Box command API caps `/commands` stdout at **524288 bytes and returns the TAIL** (both measured). `runHarness`'s poll did `cat log` from the start and tracked `offset = string length`, so on any >512KB run it only ever saw a single shifting 512KB tail window — misaligned, position-dependent — dropping ~96% of the log incl. the assistant text (which streams LAST, after all tool calls) ⇒ `sawText=false` ⇒ box.no-answer. Fix (`src/capabilities.ts` runHarness): read the log **incrementally from a byte offset** — `wc -c` for the true size, `tail -c +$((offset+1)) | head -c 500000` for the new bytes, advance offset by exact file bytes (immune to multibyte mangling at the window edge). Harness-agnostic (helps opencode/codex too). Proven: reconstructs all 14,052,530 bytes in 29 polls and captures the 6515-char answer; live scenario e2e now `turn.done` × 2 with `user-box.delta` × 27 (was 0) and zero box.no-answer. (`warmBoxServe` also added — awaitable serve warmup, real win for resident-serve harnesses, no-op for pi.)

Build order remaining: (2) carousel UI + colors · (3) winner-select/collapse + aggregate receipt.
