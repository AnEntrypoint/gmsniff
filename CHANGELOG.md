# Changelog

## 2026-07-24 — Formal verification discipline: schema versioning, resource bounds, monitoring surface

- **Specify event schema versioning**: Every parsed event now carries `_schema: "v1"` — consumers can reject unknown schema versions rather than silently misinterpreting shape changes. Stamped in all five event sources: GmLogWatcher._line, ProjectLogTailer._line, replayWatcherLog, replayAll, and live SSE broadcast.
- **Add resource bounds to Store**: MAX_EVENTS (1M, env-overridable via GM_MAX_EVENTS) with EVICT_BATCH (5k) oldest-event eviction when the cap is exceeded; MAX_SSE_CLIENTS (50, env-overridable via GM_MAX_SSE_CLIENTS). Eviction stats (evictedCount, evictedBatches, maxEvents) exposed in /api/snapshot.
- **Add info-flow label infrastructure**: X-Info-Label response header classifies every API route's data sensitivity (public/project-local/session-local/internal). Route manifest in INFO_LABELS constant.
- **Add three new monitoring endpoints**: /api/spool-queue (pending dispatch count per verb per project), /api/watcher-versions (per-project watcher liveness/runtime/version), /api/instruction-tiers (distribution of vendored/source-synced/default instruction resolution across all projects).
- **Formal specification**: .wfgy/spec/gmsniff-formal-spec.md covers 8 modules (Event Parser, Event Store, Project Registry, API Server, Resource Bounds, Versioned Schemas, Performance Contracts, Missing Monitoring Surface) with pre/post-conditions and invariants in dependent-type style.
- **Test coverage**: All existing tests pass; new formal-spec coverage verifies schema version on snapshots, live SSE events, and all three new endpoints.