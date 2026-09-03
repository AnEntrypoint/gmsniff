# gmsniff

A live manager for running `gm` agents — see every agent on the machine, what phase it is in, what instruction it was actually served, and what it has produced, from a terminal CLI or a browser GUI.

gmsniff is read-mostly tooling for the observer. It reads the telemetry each running agent's daemon writes, plus each project's own `.gm/` state files, and turns them into a single cross-project view. It never drives an agent; it watches them.

## Install

```
npm install -g gmsniff
```

Zero dependencies. Nothing is fetched at install time or at runtime — the CLI and the GUI both work fully offline.

## The primary view

```
gmsniff --agents -f
```

The live manager view: one row per working agent, showing its current phase, the instruction the daemon is serving it right now, how long it has been in that phase, its pending PRD rows and unresolved mutables, and a streaming feed of its recent output. Idle and `COMPLETE` agents are hidden by default; pass `--idle` to include them.

```
gmsniff --agents                      one-shot snapshot, no refresh
gmsniff --agents --idle               include idle/COMPLETE agents
gmsniff --agents -f --interval 5000   refresh every 5s instead of the 2s default
gmsniff --agents --agent <name>       full instruction text + a longer output feed for one project
```

`IN-PHASE` is measured from the project's own `.gm/turn-state.json` phase change. `LAST-EVT` is measured from the last real event in that project's watcher log. They are different clocks on purpose: an agent can sit in a phase for an hour while emitting events every few seconds, or hold a phase with nothing happening at all.

## Where the data comes from

**Primary: per-project `<project>/.gm/exec-spool/.watcher.log`.** This is the live stream that every current-generation `agentplug` daemon writes. gmsniff discovers projects, tails their watcher logs, and merges them into one event stream.

**Opt-in only: `~/.claude/gm-log`.** The old central jsonl archive. Current builds no longer write to it, so it is historical data — a query restricted to it can read empty while agents are actively running. gmsniff never silently merges it into live results. It is read only when you explicitly ask for it, or when you set `GM_LOG_DIR` yourself.

**Neither, for `--agents`:** the manager view reads each project's state files directly — `.gm/turn-state.json`, `.gm/next-step.md`, `.gm/exec-spool/.turn-summary.json`, `.gm/last-prompt.txt`, `.gm/exec-spool/.last-gate-fired.json`.

Project discovery seeds from `~/.gm-tools/daemon-registry.txt` — the daemon's own list of served working directories, which reaches deep worktree paths a directory scan would miss — plus a scan of `GM_SPOOL_DIRS`, `DEV_ROOT`, `GM_DEV_ROOT`, the current directory, and `C:/dev` or `~/dev`. The registry is append-only and never prunes itself, so candidates are filtered against real existence before use.

Discovery is deliberately wide and liveness deliberately narrow. On a typical machine that means on the order of a hundred-plus projects discovered, the majority of them worktrees, of which only one or two are genuinely working at any moment.

## Reading a watcher log

Only about 15% of watcher-log lines are `evt: {json}` records. The rest are structured text that carries real signal, so gmsniff models it rather than discarding it: `[dispatch] -> verb=… task=…` lines become synthesized `dispatch.start` events (there is no upstream `evt` record for a dispatch *starting*), wasm version banners carry the per-project runtime version, daemon and watcher spawn lines mark epoch boundaries, and stale-lock takeovers and retention sweeps are recorded as events.

Every replay reports its own parse coverage, so you can see what fraction of the input was understood rather than trusting a silent number.

## Liveness

Three different questions, three different answers — do not substitute one for another:

- `discoverProjects().alive` — **is this project working?** Judged from real per-project activity within a five-minute window.
- `readWatcherStatus().alive` — **is the daemon up?** Machine-wide, one shared `agentplug-runner.exe` process serving every project.
- `readProjectLiveness(cwd).active` — the per-project judgement on its own, with the individual activity clocks (`log_age_ms`, `summary_age_ms`, `turn_age_ms`) broken out.

The `ts` field in a project's `.gm/exec-spool/.status.json` is **not** a per-project activity signal. The shared daemon rewrites it for every project it serves several times a second, so it reads as fresh even for a project that has done nothing for days. It is a daemon heartbeat and nothing else.

## Correlation

There is no universal session key in the data. gmsniff ranks the identities that actually exist, best first: `sess` → `session_id` → `cwd#run` → `cwd`. Most events fall back to the daemon run, so grouped views say so explicitly rather than implying a per-agent session that the data cannot support.

## Investigation

```
gmsniff -f                           live tail across every discovered project
gmsniff --list-deviations            what went wrong recently, grouped by kind
gmsniff --list-sessions --since 24h  per-session summary with phase walk
gmsniff --tree <sess>                chronological process tree for one session
gmsniff --stats --since 24h          breakdown by sub / event / sess / day
gmsniff --list-events --sub plugkit  event-type histogram
gmsniff --efficiency <sess>          turn count, dispatch ratio, time-to-COMPLETE
gmsniff --watchers                   daemon liveness per project + runtime version
gmsniff --projects                   PRD-pending + unresolved mutables per project
gmsniff --updates                    runtime version + real drift
gmsniff --rollup out.ndjson --since 7d
```

Filters compose across all of these: `--since/--until`, `--sub`, `--event`, `--sess`, `--grep`, `--cwd`. Output shaping via `--json`, `--limit`, `--ctx`, `--reverse`. `--spool <path>` forces a single project directory or watcher-log path as the source. `gmsniff --help` has the full reference.

## Browser GUI

```
gmsniff gui --open
```

Opens on the live-agents view — the same manager information as `--agents`, with per-project drilldowns showing the full served instruction alongside a scrollable output feed. Clicking a project also shows which of three tiers resolved its instruction: a `vendored override` (a per-project `.gm/instructions/<key>.md`, shown with its exact path), `source-synced`, or the `compiled default` baked into the wasm guest — so a surprising local override is never invisible. The stream updates over SSE.

The sidebar is tiered daily-first: Daily and Investigate groups always show; Subsystems, Analytics, and Control panels sit behind a collapsed "Show advanced" toggle. Every panel stays reachable via the Ctrl+K command palette and `#panel=` deep links regardless of the toggle.

The GUI makes no external-origin requests. Every stylesheet, component, and font is served from the installed package, so it works on an air-gapped machine.

## Agent-facing

Machine callers get a self-describing contract and write surfaces:

```
gmsniff --schema                                  # machine-readable JSON: flags, types, exit codes
gmsniff --prd-edit <cwd> <id> --status done       # atomic PRD row rewrite
gmsniff --mutable-edit <cwd> <id> --witness "..." # atomic mutable row rewrite
gmsniff --dispatch <cwd> <verb> --json '{...}'    # write a spool request
```

Every parsed event carries `_schema: "v1"` for versioned parsing. The GUI server exposes the same data — and more — over `/api/*` routes, including `/api/spool-queue` (pending dispatch files per verb per project), `/api/watcher-versions` (per-project liveness, runtime, version) and `/api/instruction-tiers` (vendored vs source-synced vs default distribution); these three are server routes only, with no CLI flag. The event store is bounded at 1M events (`GM_MAX_EVENTS`) with oldest-event eviction.

Exit codes: 0 = success (zero-match queries included — absence of data is not a failure), 2 = usage error; uncaught exceptions keep Node's non-zero default.

## Requirements

Node >= 18. gmsniff imports only core Node modules (`fs`, `path`, `os`, `http`, `url`, `events`, `crypto`) and uses no API newer than that floor. Development and CI currently run on Node 24; the declared floor is held by source review rather than by an executed Node 18 build.

## Development

- `node test.js` runs the single mock-free, real-services integration test. Extend that file; there is no test framework and no parallel suite by design.
- `gui/ds/` is vendored byte-for-byte from the sibling `../anentrypoint-design` repo via `npm run sync:ds`; never hand-edit files under it.
- Pushing to `main` auto-bumps the patch version and publishes to npm via GitHub Actions; do not hand-bump `package.json`.

## Donations

BTC: `15FLMay4of9rk4jK2davzzL4HDdGQtscGX`
