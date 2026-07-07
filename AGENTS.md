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

## GM_LOG_DIR / spool discovery

Default central log dir is `~/.claude/gm-log` (override via `GM_LOG_DIR`), matching gm's own JS log writer. Per-project fallback/fanout discovers sibling project dirs under `DEV_ROOT`/`GM_DEV_ROOT`/`GM_SPOOL_DIRS`/cwd/`C:/dev` (or `~/dev`), each identified by a `.gm/exec-spool/.status.json` or `.watcher.log` marker.

@.gm/next-step.md
