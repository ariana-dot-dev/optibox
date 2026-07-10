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
