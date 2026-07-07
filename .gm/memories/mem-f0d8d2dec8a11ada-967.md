---
key: mem-f0d8d2dec8a11ada-967
ns: default
created: 1783367616767
updated: 1783367616767
---

Resuming after an externally-stopped session on a single assigned PRD row: read .gm/prd.yml row status directly first -- if status:completed with a full witness already present (including a cross-repo commit sha + CI-run confirmation), the fix landed pre-stop; the only residual is usually an uncommitted vendored-sync copy in the consumer repo's working tree (dirty git_status on the synced file) left by the interrupted turn. Verify the upstream commit is actually on origin (not just local) and CI is green on that exact sha via a real CI-list-by-commit check, not narrated trust in the witness text. Then git_finalize the consumer repo's dirty sync file, confirm CI green on the new consumer sha too. Do not force residual-scan/COMPLETE across the whole chain if unrelated PRD rows are pending outside the assigned row's scope -- per-row resolution with clean+pushed+CI-green satisfies a row-scoped task even while the overall multi-row chain phase stays EXECUTE.
