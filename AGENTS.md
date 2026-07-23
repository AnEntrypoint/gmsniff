# AGENTS.md — gmsniff

gmsniff is an observability CLI/GUI for gm — it reads gm-log jsonl events, `.gm/prd.yml`, `.gm/mutables.yml`, and `.gm/exec-spool/` state across every discovered gm project on the machine, and exposes them via `src/cli.js` (terminal) and `gui/` (browser).

## Source of truth for gm's own vocabulary

gmsniff is a consumer, not gm itself. Event names, deviation kinds, verb names, phase names, and `.gm/` file shapes are all defined by the separate gm-plugkit tool (sibling repo `../gm`), not by gmsniff. When gmsniff's parsing/display code and `../gm`'s actual current behavior disagree, `../gm` is authoritative — treat gmsniff's hardcoded vocabulary as a cache that can drift stale, not as the spec. Verify against `../gm`'s real source and real production `~/.claude/gm-log` data before trusting a memorized event/verb name; do not assume gmsniff's existing constants are current.

## Testing

No test framework, no `test/` directory. `test.js` at repo root is the single, mock-free, real-services integration test (`node test.js`) — it spins up a real temp log dir, a real `GmLogWatcher`/`MultiProjectWatcher`, writes real jsonl lines, and asserts against real SSE/replay output. Extend this file for new coverage; never add a second test file or a testing library.

## gui/ds vendoring

`gui/ds/` is vendored from the sibling repo `../anentrypoint-design` via `scripts/sync-ds.mjs` (byte-for-byte copy, listed file pairs in `FILES`). Never hand-edit a file under `gui/ds/` directly — the next `npm run sync:ds` silently overwrites it. Fix the file in `../anentrypoint-design` first, then `npm run sync:ds` to pull it down, then `npm run sync:ds:check` to confirm zero drift before committing.

## Release

Pushing to `main` triggers `.github/workflows/publish-npm.yml`: auto-bumps the patch version and publishes to npm, then commits `chore: auto-bump version to X [skip ci]` back to `main`. Don't hand-bump `package.json`'s version — the workflow owns it.

## Information tiering (deliberate)

The GUI sidebar (`gui/app.js` renderShell) and CLI help (`src/cli.js` printHelp) are deliberately tiered daily-first for the observer: Daily/Investigate groups lead; Subsystems/Analytics/Control panels sit behind a collapsed-by-default "Show advanced" toggle (localStorage key `gmsniff.nav.advanced`, whitelist-validated); `--help` opens with QUICK START before INVESTIGATION/DIAGNOSTICS/AGENT-FACING, and `--schema` subcommands carry a matching `tier` field. Do not flatten, merge, or re-alphabetize this ordering as cleanup. Demoted panels stay reachable via the Ctrl+K palette and `#panel=` deep links (which auto-expand the group session-only).

Advanced nav is deliberately thin: Analytics holds only CodeInsight and Memory Graph (both confirmed to have live current-generation data sources); Control holds PRD/Mutables Editor, Lifecycle Control, Codesearch, GM Call Console, Browser Sessions. RS Tools, Recall Stats, Exec Stats, Hook Stats, and the Query panel were removed entirely (not just demoted) after a real-data audit found them structurally reading dead subsystem tags (`rs_learn`/`exec`, both zero live events across every discovered project for the last 7 real days of gm-log data, confirmed by direct grep) or fully redundant with Deviations/AllEvents/Search. If a future data source resurrects recall/embed telemetry, repoint it at the real `memory` subsystem tag (`rs-plugkit/crates/plugkit-core/src/orchestrator/recall.rs`) rather than reintroducing the dead `rs_learn` tag.

`src/index.js` `SUBSYSTEMS` is the single hardcoded seed for the subsystem-tag universe (`['plugkit', 'hook', 'bootstrap', 'memory']`, confirmed against real `../gm` source + a week of real gm-log data across every discovered project); `gui/panels.js` `SUB_LIST` seeds from the identical literal (the browser bundle can't import the Node module) and both grow at runtime from `Dashboard`'s `snap.observedSubsystems` merge if a genuinely new tag appears in real data. Do not add a subsystem tag back to either list without confirming a live emitter against current `../gm` source and recent real log data — that is exactly the drift this rework corrected.

Skill Layout / Live Agents (`gui/panels.js` `SkillLayout`, backed by `GET /api/projects/live-state`) is the boot-time default panel: for every discovered project it shows the live agent's current phase, the FULL served instruction text (`readLivePhaseState` in `src/registry.js` returns the entire `next-step.md` body, no length cap — the drilldown's `<pre>` scrolls rather than clipping), instruction-resolution tier (vendored/source-synced/default), and a recent-activity output feed (`recent_sess`/`recent_events`, sourced from `Store._buildCwdActivityIndex` + `_processTreeFromEvents` in `src/server.js`) — the single highest-value daily view (who's running, what they're doing, what they've produced) ahead of the aggregate Dashboard. Capped at `SKILL_LAYOUT_GLANCE_MAX` (20) rows with alive projects always shown in full and an explicit hidden-count for the rest, same pattern as Dashboard's own `GLANCE_MAX`. Live-updates on `project.phase-changed` and plain plugkit-subsystem SSE frames while active. The glance row's instruction preview (140 chars) carries an explicit "(preview -- click for full instruction)" hint once truncated, so it is never mistaken for the complete text. The drilldown dialog (`SkillDrilldownDialog`) renders as a wide dialog (`Dialog({size:'wide'})`, vendored from `../anentrypoint-design`) with the instruction and the output feed as two independently-scrollable side-by-side columns (`.gm-split-pane` in `gui/gui-extra.css`, gmsniff-owned not vendored) — an observer reading recent output never loses the instruction out of view, and vice versa; falls back to stacked columns under a 900px viewport.

## GM_LOG_DIR / spool discovery

Central log defaults to `~/.claude/gm-log` (`GM_LOG_DIR` overrides); project discovery roots and markers live in `src/registry.js` discoverCwdSet -- full details in the memory store (drained entry) and `README.md`.

@.gm/next-step.md
