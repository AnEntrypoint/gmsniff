# WFGY lessons — gmsniff

## 2026-07-07 — JSON embedded in spool dispatch bodies silently mangles regex literals
Goal (G): sugar all JSON rendering across gmsniff GUI + CLI.
What drifted / what went wrong: an exec_js dispatch body is JSON; writing a JS regex literal like /\r?\n/ inside it turned \r into a real carriage return at JSON-parse time, producing "Unterminated regexp literal" in the spawned Node. First fix attempt double-escaped only some sequences and still failed.
Fix / resolution: rewrote the probe entirely regex-free (string includes/startsWith/endsWith), and for anything non-trivial, write the script to a scratch file with the Write tool and have exec_js run `node <path>` instead of inlining code in JSON.
Generalizes to: never inline regex-bearing JS into a JSON dispatch body in this project; scratch-file + execFileSync is the reliable shape.

## 2026-07-07 — a naive ANSI open/reset balance count is confounded by color(s, 0)
Goal (G): witness that truncated colorized CLI output never leaks an unclosed color state.
What drifted / what went wrong: asserting opens === resets failed, suggesting a leak; the real cause is the pre-existing `color(s, 0)` idiom whose "open" escape is itself `\x1b[0m`, so it counts as a reset.
Fix / resolution: the correct invariant is "strip every complete SGR sequence, then assert zero bare ESC bytes remain" plus "last escape is a reset" — both passed.
Generalizes to: when verifying escape-sequence hygiene here, test for dangling partial sequences, not open/close arithmetic.

## 2026-07-07 — browser verb spool body is raw JS, not JSON
Goal (G): daily-first information tiering across gmsniff GUI/CLI, witnessed via browser verb.
What drifted / what went wrong: first browser dispatch wrapped the script in {"script":"..."} JSON like exec_js; the executor eval'd the whole JSON as code and threw SyntaxError. Separately, one plain `node test.js` run aborted 0xC0000409 with zero output and never reproduced (3 subsequent full passes) — the same abort signature later appeared inside playwriter's own stderr (libuv UV_HANDLE_CLOSING assert), marking it a Windows/libuv teardown flake, not a code defect.
Fix / resolution: browser spool body = raw script text, optionally prefixed 'capture\n' for {result, debug} capture; exec_js stays JSON with required timeoutMs. For one-off aborts with empty output, instrument a transient marker copy and re-run before suspecting the diff.
Generalizes to: verb body shapes differ per verb — probe with a cheap dispatch and read the error before fanning out; treat 0xC0000409-with-no-output on this machine as retry-first.

## 2026-07-23 -- gm-plugkit shared daemon bert-embed crash wedges codesearch/prd-add
Goal (G): Reorganize gmsniff's observer UI (agent list + instruction + output) while keeping the gm PLAN/EXECUTE process moving.
What drifted / what went wrong: gm-plugkit's shared agentplug-runner.exe daemon crashed its bert embed plugin (wasm trap, embed_query_failed/rssearch_vectors invalid query embedding) on every digest-absent codeinsight_rebuild of gmsniff's own repo -- the digest never persists across sessions so this retriggers on ~every fresh gm session against this repo. codesearch/prd-add dispatches returned "plugin gm not loaded" for 1-2 min stretches, 3+ times in one session, before self-recovering. `bun x gm-plugkit@latest spool` only re-registers the project against the shared daemon -- it does NOT restart a wedged shared process.
Fix / resolution: Applied BBCR bounded retry (3 observed cycles), then escalated to a hard `taskkill //F` on the daemon pid followed by fresh `bun x gm-plugkit@latest spool` respawn -- got a new pid with a clean heartbeat immediately. In this instance the daemon had actually self-recovered moments before the kill, so the hard-kill wasn't strictly required, but it's the correct escalation path once self-recovery windows are exhausted. Filed the root-cause itself as PRD row bug-codesearch-plugin-crash-report (upstream fix belongs in ../gm's rs-plugkit or bert embed plugin, not gmsniff).
Generalizes to: In this environment, if codesearch/prd-add/mutable-add return "plugin gm not loaded" repeatedly (3+ times) with watcher.log showing embed_query_failed/bert plugin call failed, don't keep blind-retrying past 3 cycles -- check status.json heartbeat staleness (>30s with no busy_until = structurally dead), and if genuinely stuck, `taskkill //F` the daemon pid from status.json then `bun x gm-plugkit@latest spool` to respawn, rather than looping Monitor waits indefinitely. The shared agentplug daemon serves ALL concurrent gm projects on the machine, so a hard kill has real blast radius -- only do it after real bounded retries are exhausted, not preemptively.
