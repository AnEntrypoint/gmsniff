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
