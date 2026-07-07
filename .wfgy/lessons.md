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
