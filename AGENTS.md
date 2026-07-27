# AGENTS.md — gmsniff

gmsniff is an observability CLI/GUI for gm. It reads per-project `.gm/exec-spool/.watcher.log` telemetry, `.gm/turn-state.json`, `.gm/prd.yml`, `.gm/mutables.yml`, and the rest of each discovered project's `.gm/` state, and exposes them via `src/cli.js` (terminal) and `gui/` (browser). Its primary product is the live manager view (`--agents`, and the GUI's live-agents panel): who is running, what phase they are in, what instruction they were served, what they have produced.

## Source of truth for gm's own vocabulary

gmsniff is a consumer, not gm itself. Event names, deviation kinds, verb names, phase names, gate names, and `.gm/` file shapes are all defined by the separate gm-plugkit tool (sibling repo `../gm`), not by gmsniff. When gmsniff's parsing/display code and `../gm`'s actual current behavior disagree, `../gm` is authoritative — treat gmsniff's hardcoded vocabulary as a cache that can drift stale, not as the spec. Verify against `../gm`'s real source and real current watcher-log data before trusting a memorized event/verb name; do not assume gmsniff's existing constants are current.

## Event sources: spool is primary, archive is opt-in

The live telemetry stream is the per-project `<cwd>/.gm/exec-spool/.watcher.log`. `~/.claude/gm-log` is a legacy archive that current gm builds no longer write to.

`replayAllAudited` must return `source: "spool"` with `archive_used: false` on a normal call. The archive is read **only** on an explicit `{archive: true}` or when the operator sets `GM_LOG_DIR` themselves (`GM_LOG_DIR_EXPLICIT`). Never silently merge archive events into a live result set: an archive holds far more history than the live spool, so a silent merge makes every count a count over dead history, and the failure is invisible because the numbers look bigger and therefore more credible. Any new code path that reads events must declare which source it used and surface that in its output.

## Watcher-log parsing is not just JSON

Roughly 15% of watcher-log lines are `evt: {json}`; the remaining structured-text lines carry the highest-value signal and must not be discarded. `src/watcher-log.js` models them: `[dispatch] -> verb=… task=… body=…b` lines are the dispatch-start stream and are synthesized into `dispatch.start` events (there is no upstream evt record for a dispatch starting — the only `evt` is `dispatch.end`), wasm version banners carry the per-project runtime version now that `.status.json` no longer does, daemon/watcher spawn lines mark epoch boundaries, and stale-lock takeovers and retention sweeps are events.

Parse coverage is reported, not assumed: every replay carries `parse_stats` with `modeled_ratio` / `unmodeled_ratio`. A change that drops modeled coverage is a regression even if nothing throws. Do not "simplify" the parser to the JSON path only.

## Liveness has three distinct meanings

Keep them separate; substituting one for another is the recurring bug.

- `discoverProjects().alive` — **is this project working**, judged from real per-project activity within `PROJECT_ACTIVE_MS`. On a typical machine this is a handful out of a hundred-plus discovered.
- `readWatcherStatus().alive` / `daemon_alive` — **is the shared daemon up**. Machine-wide, one `agentplug-runner.exe` serving every project, so it is near-uniformly true and says nothing about any individual project.
- `readProjectLiveness(cwd).active` — the per-project judgement with its component clocks (`log_age_ms`, `summary_age_ms`, `turn_age_ms`) broken out.

**`.gm/exec-spool/.status.json`'s `ts` is a daemon heartbeat, not a per-project activity signal.** The shared daemon rewrites it for every project it serves several times a second, so it reads fresh for a project that has been idle for days. Never derive per-project activity or "last seen" from it.

## The agentplug runtime is a shared daemon

`.gm/exec-spool/.status.json` is `{pid, ts, daemon: true, shared_process: true, runtime: "agentplug"}`. There is no `busy_until`, no `version`, no `wrapper_sha`, no `idle_limit_ms`, and `pid` is a machine-wide shared daemon pid — never treat it as this project's own process. Machine-global state lives in `~/.gm-tools/` (`daemon-status.json`, `daemon-registry.txt`, `plugkit.version`, `gm-plugkit.version`), and that is where the runtime version comes from.

`~/.gm-tools/daemon-registry.txt` is the daemon's own list of served cwds and is the discovery hint that reaches deep worktree paths a one-level scan misses. It is append-only and never self-prunes, so every candidate must be filtered against real filesystem existence before use.

## Correlation identity is ranked, never assumed

There is no universal session key. `src/correlation.js` ranks the identities that actually exist: `sess` → `session_id` → `cwd#run` → `cwd`. In real data the overwhelming majority of events fall back to `cwd#run`. Any surface that groups events must report which identity it actually used and say plainly that a run-keyed group is a daemon run, not an agent session. Do not invent a synthetic session id to make a grouping look tidier than the data supports.

## Per-project state files are authoritative over prose scraping

`.gm/turn-state.json` `{phase, session_id, last_skill, updated_at_ms}` is the **primary** phase source; regex-scraping `next-step.md` is the fallback, not the other way round. Also read directly: `.gm/last-dispatch-ts`, `.gm/last-instruction-ts`, `.gm/last-prompt.txt` (the raw driving user prompt), and the existence-only zero-byte markers `.gm/claim-audit-fired` and `.gm/residual-check-fired` (check existence, never content).

`.gm/exec-spool/.last-gate-fired.json` `{key, ts}` is the **last-ever** gate fired, not a currently-blocking gate — its `ts` is routinely days old, so any surface showing it must show its age alongside it or it reads as a live block. `.gate-deviation-repeats.json` being `{}` is the normal healthy state, not missing data. `.gm/gm.db` is the live store; `.gm/rs-learn.db` is a retired fossil.

## gm's FSM: re-plan edges are legal

Phases are PLAN, EXECUTE, EMIT, VERIFY, CONSOLIDATE, COMPLETE. The graph has **gate-free re-plan edges** EXECUTE→PLAN, EMIT→PLAN and VERIFY→PLAN, so a phase can legally be revisited. Any phase-walk display that computes gaps by linear index math will emit false "skipped phase" reports; walk the real edges. The eight gates are `residual-scan-fired`, `prd-all-closed`, `mutables-all-resolved`, `worktree-clean`, `ci-validated-fresh`, `browser-witness-coverage`, `claim-audit-clean`, `submodules-clean`. A project's `.gm/instructions/fsm/graph.json` can override the graph per-project, so read the project's own graph when one exists rather than assuming the default.

## Zero dependencies

`package.json` has no `dependencies` and no `devDependencies`, and there is no lockfile. This is a load-bearing property, not an accident: gmsniff is an offline observability tool that must install and run on an air-gapped machine and must never be a supply-chain surface for the agent host it observes. Do not add a runtime dependency, a test library, a build step, or a bundler. `src/` imports only core Node modules (`fs`, `path`, `os`, `http`, `url`, `events`, `crypto`).

The same rule extends to the browser: the served `gui/` tree makes **zero external-origin runtime fetches** — no CDN scripts, no remote fonts, no remote stylesheets. Vendor anything you need into `gui/ds/` or `gui/`. This is why the markdown/Prism chain is deliberately not vendored from upstream: its upstream form fetches from a CDN.

## Node engine floor

`engines` declares `node >= 18`. Hold that floor: no `import.meta.dirname`, `Array.fromAsync`, `Promise.withResolvers`, `toSorted`/`toReversed`, `fs.globSync`, `util.styleText`, or `node:test`. If a newer API becomes genuinely necessary, raise `engines` in the same change rather than silently breaking Node 18 installs.

The floor is currently held by source review, not by execution — there is no Node 18 runtime in the dev environment or in CI, so `>=18` is an asserted contract rather than a tested one. Treat a change that needs a newer API as a decision to raise `engines`, not as something a green local run has cleared.

## Testing

No test framework, no `test/` directory. `test.js` at repo root is the single, mock-free, real-services integration test (`node test.js`) — it spins up a real temp log dir, a real `GmLogWatcher`/`MultiProjectWatcher`, writes real jsonl lines, and asserts against real SSE/replay output. Extend this file for new coverage; never add a second test file or a testing library.

## gui/ds vendoring

`gui/ds/` is vendored from the sibling repo `../anentrypoint-design` via `scripts/sync-ds.mjs` (byte-for-byte copy, listed file pairs in `FILES`). Never hand-edit a file under `gui/ds/` directly — the next `npm run sync:ds` silently overwrites it. Fix the file in `../anentrypoint-design` first, then `npm run sync:ds` to pull it down, then `npm run sync:ds:check` to confirm zero drift before committing.

**Vendoring a CSS import manifest means vendoring its targets.** `gui/ds/app-shell.css` is a manifest of `@import url('./src/css/app-shell/*.css')` — it contains no rules of its own. If those parts are absent, every rule it references is silently inert: no error, no console warning, only 404s and unstyled components that look like a design bug. When vendoring any file, follow its imports and vendor the whole closure, then confirm in the browser that the rules actually apply.

## Packaging

`package.json` `files` is `["src/", "gui/"]`, which ships everything under both trees plus `package.json` and `README.md`. Any new module under `src/` or asset under `gui/` is included automatically — but a partial vendor is not caught by packaging, it is caught by the closure rule above. Verify with a real `npm pack --dry-run` after adding or vendoring files; the published tarball is the only thing an installed user has.

## Information tiering (deliberate)

The GUI sidebar (`gui/app.js` renderShell) and CLI help (`src/cli.js` printHelp) are tiered daily-first for the observer: the live-agents/manager view leads, then Daily and Investigate; Subsystems, Analytics, and Control panels sit behind a collapsed-by-default "Show advanced" toggle (localStorage key `gmsniff.nav.advanced`, whitelist-validated). `--help` opens with QUICK START before INVESTIGATION/DIAGNOSTICS/AGENT-FACING, and `--schema` subcommands carry a matching `tier` field. Do not flatten, merge, or re-alphabetize this ordering as cleanup. Demoted panels stay reachable via the Ctrl+K palette and `#panel=` deep links, which auto-expand the group session-only.

`src/index.js` `SUBSYSTEMS` is the hardcoded seed for the subsystem-tag universe; `gui/panels.js` `SUB_LIST` seeds from the identical literal because the browser bundle cannot import the Node module. Both grow at runtime from `Dashboard`'s `snap.observedSubsystems` merge when a genuinely new tag appears in real data. Do not add or remove a subsystem tag in either list without confirming against current `../gm` source and recent real watcher-log data — the two literals must stay identical to each other.

@.gm/next-step.md
