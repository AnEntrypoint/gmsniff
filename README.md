# gmsniff

Observability for gm agent sessions: query, search, and tail gm-log events from every gm project on the machine, through a terminal CLI and a browser GUI.

gmsniff is read-mostly tooling for the observer. It consumes the central `~/.claude/gm-log` jsonl store (override with `GM_LOG_DIR`), each discovered project's `.gm/prd.yml` and `.gm/mutables.yml`, and `.gm/exec-spool/` watcher state.

## Install

```
npm install -g gmsniff
```

## Daily use

The handful of commands that answer "what is happening right now":

```
gmsniff gui --open                   # browser dashboard: project health, phases, deviations at a glance
gmsniff -f                           # live tail across every discovered project
gmsniff --list-deviations            # what went wrong recently, grouped by kind
gmsniff --list-sessions --since 24h  # per-session summary with phase walk
gmsniff --tree <sess>                # drill into one session chronologically
```

The GUI opens on a Dashboard that leads with a "Projects now" glance (watcher liveness, PRD pending, unresolved mutables, deviation rate per project) and quick links into Live Stream, Deviations, and Sessions. The sidebar is tiered daily-first: Daily and Investigate groups always show; Subsystems, Analytics, and Control panels sit behind a collapsed "Show advanced" toggle. Every panel stays reachable via the Ctrl+K command palette and `#panel=` deep links regardless of the toggle.

**Skill Layout** (`#panel=skill-layout`, top of the Daily group) shows every discovered project's live agent state at a glance: current phase on a PLAN->EXECUTE->EMIT->VERIFY->CONSOLIDATE->COMPLETE step indicator, current skill, and a preview of the instruction text the daemon is actually serving that project right now, color-coded and filterable by cwd/phase/skill. Clicking a project opens a drilldown with the full served instruction text and which of the three resolve tiers is serving it -- a `vendored override` (a per-project `.gm/instructions/<key>.md` file, shown with its exact path), `source-synced` (pulled from a configured upstream repo's cache), or the `compiled default` baked into the wasm guest -- so a surprising local override is never invisible. Live-updates via SSE (`project.phase-changed` frames) as agents progress, no manual refresh needed.

## Investigation

When the glance shows something worth chasing:

```
gmsniff --stats --since 24h          # breakdown by sub / event / sess / day
gmsniff --list-events --sub plugkit  # event-type histogram
gmsniff --efficiency <sess>          # turn count, dispatch ratio, time-to-COMPLETE
gmsniff --updates                    # live drift state + update.* history
gmsniff --watchers                   # liveness + version per project -- recognizes both the legacy per-project JS-wrapper status shape (version+wrapper_sha) and the current agentplug shared-daemon shape (runtime:"agentplug", shared_process:true, one process serving many project cwds), badging shared daemons as shared:<pid>
gmsniff --projects                   # PRD-pending + unresolved mutables per project
gmsniff --rollup out.ndjson --since 7d
```

Filters compose across all of these: `--since/--until`, `--sub`, `--event`, `--sess`, `--grep`, `--cwd`, and more; output shaping via `--json`, `--limit`, `--ctx`, `--reverse`. Run `gmsniff --help` for the full reference.

## Diagnostics (rare)

Deep memory/learning forensics, not daily reading: `--embed-failures`, `--recall-misses`, `--recall-scores`, `--classifier-rejects`, `--memory-leverage`, `--recall-modes`, `--table-drops`, `--discipline-sigil-ignored`.

## Agent-facing

Machine callers get a self-describing contract and write surfaces:

```
gmsniff --schema                                  # machine-readable JSON: flags, types, exit codes
gmsniff --prd-edit <cwd> <id> --status done       # atomic PRD row rewrite
gmsniff --mutable-edit <cwd> <id> --witness "..." # atomic mutable row rewrite
gmsniff --dispatch <cwd> <verb> --json '{...}'    # write a spool request
```

Exit codes: 0 = success (zero-match queries included), 2 = usage error; uncaught exceptions keep Node's non-zero default.

## Agent-facing (new)

Machine-readable monitoring surface for cross-project observability:

```
gmsniff --spool-queue                    # pending dispatch files per verb per project
gmsniff --watcher-versions               # per-project watcher liveness, runtime, version
gmsniff --instruction-tiers              # vendored vs source-synced vs default instruction distribution
```

Every event carries `_schema: "v1"` for versioned parsing. The GUI server exposes these as `/api/spool-queue`, `/api/watcher-versions`, and `/api/instruction-tiers`. Event store is bounded at 1M events (env-overridable via `GM_MAX_EVENTS`) with oldest-event eviction.

## Development

- `node test.js` runs the single mock-free, real-services integration test (real temp log dirs, real watchers, real SSE). Extend this file for new coverage; there is no test framework and no parallel suite by design.
- `gui/ds/` is vendored byte-for-byte from the sibling `../anentrypoint-design` repo via `npm run sync:ds`; never hand-edit files under it.
- Pushing to `main` auto-bumps the patch version and publishes to npm via GitHub Actions; do not hand-bump `package.json`.

## Donations

BTC: `15FLMay4of9rk4jK2davzzL4HDdGQtscGX`
