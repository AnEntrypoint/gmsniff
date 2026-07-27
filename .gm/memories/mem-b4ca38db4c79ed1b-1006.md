---
key: mem-b4ca38db4c79ed1b-1006
ns: default
created: 1785153637448
updated: 1785153637448
---

gm runtime telemetry moved to agentplug (2026-07): the central ~/.claude/gm-log jsonl tree is DEAD (measured: 71 day dirs, 959386 events, newest 2026-07-23) and the ONLY live stream is per-project <cwd>/.gm/exec-spool/.watcher.log. The agentplug host writes it via the WASM guest host_log import: any message prefixed "evt: " is appended to watcher.log, everything else goes to unclaimed daemon stderr. Machine-global runtime state lives in ~/.gm-tools/: daemon-status.json {pid,ts,active_projects}, daemon-registry.txt (append-only, never self-prunes -- measured 9 of 12 entries nonexistent, so it is a discovery HINT that reaches deep worktree paths, never a liveness list), daemon-config.json, plugkit.version. .gm/exec-spool/.status.json is now {pid,ts,daemon,shared_process,runtime:"agentplug"} where pid is a SHARED machine-wide daemon pid -- process.kill(pid,0) makes every project report alive/dead together, so per-project liveness must come from last-dispatch-ts age or watcher.log mtime instead.
