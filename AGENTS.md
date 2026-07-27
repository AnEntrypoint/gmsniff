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

**Not every unmodeled line is a gap — some are already modeled through the other channel.** gm's panic hook emits *both* halves from one handler: a `host_log` `WASM PANIC at …` text line **and** an `emit_event("wasm_panic", …)` record carrying structured `location`/`message`/`ts`. Measured 13 text lines against 14 evt records, 13/13 twinned, zero orphans. Modeling that text line as its own event would double-count every panic. Before parsing an unmodeled shape, check whether an `evt` record already carries it.

**Counting bugs hide as bigger, more credible numbers.** The live tailer once re-read every line the boot replay had already ingested, doubling every count, rate and per-project total with nothing erroring. It surfaced only because a test asserted an *exact* count against a fixture writing exactly one line. Keep exact-count assertions scoped to a fixture cwd; never relax one to a threshold or paper over it with a dedupe.

## Comments are a liability when names and structure encode the same thing

Write code that explains itself, and delete the comment that was compensating. A comment restating what the line does is a defect: rename the variable, extract the predicate, or name the constant until the code carries the meaning, then remove the prose. `spoofMarker` plus a comment explaining the spoof becomes `markerOnLineClaimingAnotherProjectsCwd` with no comment; a `[src, dest]` tuple list needing a comment to explain the tuple becomes a flat path list; a 26-line usage banner becomes a real `--help`.

A comment is admissible only when it states something the code structurally **cannot**: a measurement taken against real data, a defect in another repo that this code works around, or an alternative that was tried and rejected. Those cost real investigation to obtain and the next reader reintroduces the bug without them. Everything else belongs in a name, and a rule binding future work belongs in this file rather than in a source comment.

Any comment pass must be provably behavior-preserving: run `node test.js` and re-witness the affected surface before and after. A rename that misses one call site is a silent break.

**A comment pass is also a dead-code audit.** Prose describing what a function is *for* makes an uncalled function look load-bearing. Removing it exposes the truth: seven dead surfaces were found this way here, the sharpest being a `loadState` helper whose comment called itself "the through-line of this rework" and claimed every panel built one, while it had zero call sites. The prose asserted an architecture the code did not have.

Four verification traps, each of which produced a false pass in this repo:

- **`node --check` cannot catch a partial rename.** It parses without resolving identifiers, so a name left undeclared by a half-finished rename reads as clean and fails only at runtime. Verify a rename by *executing* the module.
- **A browser witness that merely navigates can re-run stale modules from Chrome's memory cache**, reporting "unchanged" for code you just edited. Force a cache-defeating reload before reading the DOM.
- **A scripted whole-file rewrite from a stale buffer silently reverts another writer's work.** After every scripted edit, grep for the identifiers it was supposed to introduce and treat their absence as a clobber, not as success.
- **The `browser` verb runs its body inside the page, so a `page.evaluate` witness fails in a way that reads as "the verb is broken".** The body is browser-context JS with bare `document`/`window` access and a plain `return`; only the `url=`/`timeout=` prefix lines are parsed by the watcher. A body referencing Playwright's `page` object returns `ReferenceError: page is not defined` under `cdp-eval`, which looks identical to an unavailable browser surface — one session burned eight retries on it and recorded a false external blocker, then verified every client-side change through `curl` and `node --check` instead. Use `await new Promise(r => setTimeout(r, ms))` rather than `page.waitForTimeout`, and wait on the out-file appearing rather than concluding the watcher died, because a real dispatch takes seconds.

## Report measurements, never bake in a verdict

gmsniff observes; the reader judges. Do not add a route, field, or panel that decides something is an error and then acts on that decision — no invented severity scores, no threshold that omits a project from a result set, no `ok`/`degraded`/`critical` label standing in for the numbers behind it.

The failure this rule exists to prevent is concrete: `stuck-projects` once decided 15min was "stale", 10 rows a "backlog" and 5 deviations/min "high", summed invented weights into a severity, and returned only projects scoring above zero. An issue those thresholds did not anticipate was not merely unranked — it was invisible, and a project one minute under a cutoff looked identical to a healthy one.

So: report the measurement **and how old it is**, for **every** project, and let the caller sort or threshold. A threshold that only affects *presentation* is fine (the health banner, the CLI's working-only default) provided the underlying numbers stay reachable and the reason is always named alongside the flag — a bare word with no measurement behind it is exactly what this forbids. Naming a real causal chain the data implies (`embed_query_failed` cascading into dropped vector hits, so codesearch silently answers from bm25 only) is an observation, not a verdict, and is encouraged.

**Ranking is not scoring.** `attentionScore` weights ten conditions and orders the agent list by the result — and that is fine, because it ranks a *complete* list, attaches a `reasons` array naming each contributing cause, and drops nothing. `stuckProjects` used the same shape and was wrong, because it returned only the projects scoring above zero. The line is whether anything becomes unreachable: order freely, surface the cause, never omit. A ranked list with its reasons hidden degrades back into a bare number and fails this rule again.

**Reporting another system's classification is not minting your own.** `DEVIATION_META` maps each gm deviation kind to the recovery verb gm itself documents, and gm writes a `severity` field into its own `prd.yml` rows; passing those through is reporting gm's facts. Inventing a severity gmsniff computed is not.

**A nullable measurement can invert its own meaning in a comparator.** The health banner sorted `staleSeconds == null` — "no events ever" — as *zero seconds silent*, so the most suspicious project sorted last. Any sort, min/max or average over a field that can be null needs an explicit decision: absent means zero, means `Infinity`, or must be excluded and reported separately. Never let the default numeric coercion decide.

**gm writes its stores with the host's line endings, so parse CRLF.** `.gm/prd.yml` and `.gm/mutables.yml` arrive CRLF on Windows. Splitting on `\n` alone leaves a trailing `\r` that breaks every `$` anchor, and the file parses to **zero rows** — gmsniff read its own 15-row PRD as empty, with nothing thrown and an empty store looking exactly like a finished one. Strip `\r` for *matching* only; keep row offsets against the original lines so an untouched row is still rewritten byte-for-byte.

**A paged route cannot be counted client-side.** `/api/prd` and `/api/mutables` return at most `YAML_ROWS_LIMIT` rows alongside a true `total` and a `truncated` flag. Counting `r.rows` therefore reports a number silently capped at the page size: `LifecycleControl` displayed "0 PRD pending" for a project with 314 pending, because its 250-row page happened to contain none. Count from `total`, from a whole-file count another route already computes, or server-side — never from the rows a paged route handed you. And when a list caps what it displays, print the omitted count; three lists here truncated silently.

## Liveness has three distinct meanings

Keep them separate; substituting one for another is the recurring bug.

- `discoverProjects().alive` — **is this project working**, judged from real per-project activity within `PROJECT_ACTIVE_MS`. On a typical machine this is a handful out of a hundred-plus discovered.
- `readWatcherStatus().alive` / `daemon_alive` — **is the shared daemon up**. Machine-wide, one `agentplug-runner.exe` serving every project, so it is near-uniformly true and says nothing about any individual project.
- `readProjectLiveness(cwd).active` — the per-project judgement with its component clocks (`log_age_ms`, `summary_age_ms`, `turn_age_ms`) broken out.

**`.gm/exec-spool/.status.json`'s `ts` is a daemon heartbeat, not a per-project activity signal.** The shared daemon rewrites it for every project it serves several times a second, so it reads fresh for a project that has been idle for days. Never derive per-project activity or "last seen" from it.

## The agentplug runtime is a shared daemon

`.gm/exec-spool/.status.json` is `{pid, ts, daemon: true, shared_process: true, runtime: "agentplug"}`. There is no `busy_until`, no `version`, no `wrapper_sha`, no `idle_limit_ms`, and `pid` is a machine-wide shared daemon pid — never treat it as this project's own process. Machine-global state lives in `~/.gm-tools/` (`daemon-status.json`, `daemon-registry.txt`, `plugkit.version`, `gm-plugkit.version`), and that is where the runtime version comes from.

`~/.gm-tools/daemon-registry.txt` is the daemon's own list of served cwds and is the discovery hint that reaches deep worktree paths a one-level scan misses. It is append-only and never self-prunes, so every candidate must be filtered against real filesystem existence before use.

**`GM_SPOOL_DIRS` adds a discovery root; it does not restrict discovery.** `C:/dev` and `process.cwd()` are always scanned as well. A test that sets it and then asserts a fleet-wide total is machine-dependent and will fail elsewhere — scope every fixture assertion to the fixture's own cwd.

## Correlation identity is ranked, never assumed

There is no universal session key. `src/correlation.js` ranks the identities that actually exist: `sess` → `session_id` → `cwd#run` → `cwd`. In real data the overwhelming majority of events fall back to `cwd#run`. Any surface that groups events must report which identity it actually used and say plainly that a run-keyed group is a daemon run, not an agent session. Do not invent a synthetic session id to make a grouping look tidier than the data supports.

## Per-project state files are authoritative over prose scraping

`.gm/turn-state.json` `{phase, session_id, last_skill, updated_at_ms}` is the **primary** phase source; regex-scraping `next-step.md` is the fallback, not the other way round. Also read directly: `.gm/last-dispatch-ts`, `.gm/last-instruction-ts`, `.gm/last-prompt.txt` (the raw driving user prompt), and the two fired-markers — which are **not** the same shape. `.gm/residual-check-fired` is a zero-byte existence marker. `.gm/claim-audit-fired` carries a short verdict body (`clean`, 5 bytes, measured on gm/gmsniff/spoint/casey). Read presence and verdict apart: "fired and clean", "fired, verdict unknown" and "never fired" are three distinct states, and collapsing them to existence-only discards the verdict.

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

Never hand-edit a file under `gui/ds/` — fix it in `../anentrypoint-design`, then `npm run sync:ds`, then `npm run sync:ds:check` for zero drift. **Vendoring a file means vendoring its whole import closure**, and confirming in a browser that the rules actually apply: a CSS manifest whose targets are absent is silently inert, with only 404s to show for it. (Mechanics — why vendored rather than a dep or a live import, which sources to take, the `npm pack --dry-run` check — recall `gui/ds vendoring`.)

## Packaging

`files` is `["src/", "gui/"]`, so anything added under either tree ships automatically — but a *partial vendor* is caught by the closure rule above, never by packaging. Verify with a real `npm pack --dry-run`; the tarball is all an installed user has.

## Information tiering (deliberate)

The GUI sidebar and CLI help are tiered daily-first, live-manager-view leading, with Subsystems/Analytics/Control behind a collapsed "Show advanced" toggle. **Do not flatten, merge, or re-alphabetize that ordering as cleanup** — demoted panels stay reachable via the Ctrl+K palette and `#panel=` deep links.

`src/index.js` `SUBSYSTEMS` and `gui/panels.js` `SUB_LIST` are the same literal, duplicated because the browser cannot import the Node module. **The two must stay identical**, and neither changes without confirming against current `../gm` source and real watcher-log data. (Toggle key, tier fields, the runtime `observedSubsystems` merge — recall `gmsniff information-tiering`.)

@.gm/next-step.md
