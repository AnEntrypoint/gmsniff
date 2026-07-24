# gmsniff — Formal Specification

Specified as dependent types. Validated once. Implemented as constructive inhabitants.

## Module 1: Event Parser (`src/index.js` — GmLogWatcher, replayAll, replayWatcherLog)

### Type: `Event`

```
Event : Set where
  mkEvent : (ts : ISO8601) → (event : EventName) → (_sub : Subsystem) → 
            (_day : DateString) → (_fp : FilePath) → (fields : Map String Value) → Event
```

### Pre/Post: `parseLine : RawLine → Accepted Event | Rejected ParseError`

```
parseLine : String → ParseResult
  pre:  raw is a non-empty string (raw.length > 0)
  post: result is Accepted(e) ∨ Rejected(reason)
  invariant: parseLine never throws — every code path returns a ParseResult
  invariant: Accepted(e) ⇒ e.ts is valid ISO8601
  invariant: Accepted(e) ⇒ e.event is defined (falls back to '?' per current behavior)
  version: parseLine carries schema version tag in _schema field
```

### Pre/Post: `GmLogWatcher._read : FilePath → Unit`

```
_read : FilePath → Unit
  pre:  fp is a valid filesystem path, fp exists
  post: all complete lines in fp since last read offset are emitted as 'event'
  invariant: partial line at EOF is preserved in this._partial for next read
  invariant: fd is closed on ENOENT (file deleted mid-read)
  resource-bound: max open fds ≤ this._tails.size
```

### Pre/Post: `replayWatcherLog : FilePath → Cwd → List Event`

```
replayWatcherLog : FilePath → Cwd → List Event
  pre:  fp is a valid filesystem path
  post: returns all parseable evt: lines from fp, each with cwd attribution
  invariant: cwd is ALWAYS the caller-provided cwd, NEVER o.cwd from the log line
  invariant: never throws — missing/unreadable file returns []
  security: cwd-spoof resistance (verified in test.js fanout test)
```

### Pre/Post: `replayAll : LogDir → List Event`

```
replayAll : LogDir → List Event
  pre:  logDir is a valid directory path
  post: returns all parseable events from jsonl files ∪ fallback from spool logs
  invariant: never throws — missing directory returns []
  invariant: events sorted by ts ascending
```

## Module 2: Event Store (`src/server.js` — Store)

### Type: `Store`

```
Store : Set where
  mkStore : (events : List Event) → (maxEvents : Nat) → (maxMemoryBytes : Nat) → Store
```

### Invariant: `store-invariant`

```
store-invariant : Store → Bool
store-invariant (mkStore events maxEvents maxMemoryBytes) =
  (length events ≤ maxEvents) ∧
  (memoryUsage events ≤ maxMemoryBytes) ∧
  (all event-valid? events)
```

### Pre/Post: `Store.load : Unit → Unit`

```
load : Unit → Unit
  pre:  this.logDir is set
  post: this.events = replayAll(this.logDir)
  invariant: never throws
  resource-bound: this.events.length ≤ MAX_EVENTS (default: 1_000_000)
```

### Pre/Post: `Store.startLive : Unit → Unit`

```
startLive : Unit → Unit
  pre:  this.watcher = null ∧ this.fanout = null
  post: this.watcher ≠ null ∧ this.fanout ≠ null
  post: both watcher and fanout are actively tailing
  invariant: idempotent — second call is no-op
  effect: starts two concurrent event sources (central log + per-project fanout)
```

### Pre/Post: `Store.snapshot : Unit → Snapshot`

```
snapshot : Unit → Snapshot
  post: result.total = length(this.events)
  post: result.bySub is a complete subsystem → count mapping
  invariant: length-keyed cache — recomputed only when this.events.length changes
  performance: O(1) on cache hit, O(events) on cache miss
```

### Pre/Post: `Store._buildCwdActivityIndex : Unit → ActivityIndex`

```
_buildCwdActivityIndex : Unit → ActivityIndex
  post: index.latestSessByCwd maps each normalized cwd to its most recent session
  post: index.eventsBySess maps each session to its events (insertion order)
  performance: single O(events) pass, reused across all projects in one request
  invariant: never throws
```

## Module 3: Project Registry (`src/registry.js`)

### Type: `Project`

```
Project : Set where
  mkProject : (cwd : CanonicalPath) → (alive : Bool) → (version : Maybe Version) →
              (prd_pending : Nat) → (prd_total : Nat) → 
              (mut_unknown : Nat) → (mut_total : Nat) → Project
```

### Pre/Post: `readWatcherStatus : Cwd → Maybe WatcherStatus`

```
readWatcherStatus : Cwd → Maybe WatcherStatus
  post: result is Just(status) iff .gm/exec-spool/.status.json exists and is valid
  post: status.alive = process.kill(pid, 0) succeeds
  invariant: never throws — returns Nothing on any error
  invariant: alive is a real process liveness probe, not a stale mtime heuristic
  version: status.runtime ∈ {"agentplug", "wrapper", null}
```

### Pre/Post: `readLivePhaseState : Cwd → PhaseState`

```
readLivePhaseState : Cwd → PhaseState
  pre:  cwd is a valid project directory
  post: phaseState.present = (next-step.md exists)
  post: phaseState.phase is the current FSM phase
  invariant: mtime-gated cache — statSync only, no re-read on unchanged mtime
  invariant: never throws — returns {unparseable: true} on partial writes
  invariant: instruction_excerpt is the FULL untruncated body (no length cap)
```

### Pre/Post: `parseYamlRows : Text → List YamlRow`

```
parseYamlRows : Text → List YamlRow
  post: each row has id, _raw (exact source slice), _start, _end
  invariant: row boundary is ANY top-level `- <field>: ...` line, not just `- id:`
  invariant: never throws — empty/malformed text returns []
  invariant: _raw preserves byte-for-byte fidelity for rewriteRow
```

### Pre/Post: `rewriteRow : Text → Id → Fields → Maybe Text`

```
rewriteRow : Text → Id → Fields → Maybe Text
  pre:  text is valid YAML rows format
  post: result is Just(newText) where row with id has updated fields, all other rows unchanged
  post: result is Nothing if id not found
  invariant: idempotent — rewriting a row with the same fields produces the same output
```

### Pre/Post: `atomicWriteFile : FilePath → Text → Unit`

```
atomicWriteFile : FilePath → Text → Unit
  pre:  filePath is a valid writable path
  post: filePath contains contents
  invariant: write is atomic (tmp file + rename), no partial-write window
  effect: filesystem write
```

## Module 4: API Server (`src/server.js` — createServer, route handlers)

### Type: `HttpResponse`

```
HttpResponse : Set where
  mkResponse : (status : Nat) → (body : Json) → (infoLabel : InfoLabel) → HttpResponse
```

### Pre/Post: `createServer : Config → Promise Server`

```
createServer : Config → Promise Server
  post: server is listening on the configured port
  post: Store is loaded and live
  invariant: close() stops watchers with libuv drain (no UV_HANDLE_CLOSING race)
  security: all paths are validated against GUI_DIR (no path traversal)
  security: cwd parameters validated against project registry (no arbitrary fs access)
```

### Pre/Post: Each route handler

```
routeHandler : Request → HttpResponse
  pre:  request is a valid HTTP request
  post: response.status ∈ {200, 400, 403, 404, 405, 409, 413, 500, 502, 504}
  post: response carries info-flow label (see below)
  invariant: never throws — all errors caught and returned as HTTP error responses
  invariant: body size bounded (MAX_LIFECYCLE_BODY = 65536, MAX_QUERY_LEN = 4096)
  resource-bound: request body ≤ MAX_LIFECYCLE_BODY
```

### Info-Flow Labels

```
InfoLabel : Set where
  public        : InfoLabel  — aggregate statistics, no PII
  project-local : InfoLabel  — data scoped to one project
  session-local : InfoLabel  — data scoped to one session
  internal      : InfoLabel  — raw event data, may contain paths/PIDs

labelOf : Route → InfoLabel
labelOf /api/snapshot     = public
labelOf /api/projects     = public
labelOf /api/sessions     = public
labelOf /api/events       = internal
labelOf /api/process-tree = session-local
labelOf /api/prd          = project-local
labelOf /api/mutables     = project-local
labelOf /api/stream       = internal
```

## Module 5: Resource Bounds

```
ResourceBounds : Set where
  mkBounds : (maxEvents : Nat) → (maxMemoryMB : Nat) → 
             (maxOpenFds : Nat) → (maxSSEClients : Nat) → ResourceBounds

defaultBounds : ResourceBounds
defaultBounds = mkBounds
  1_000_000    -- maxEvents: 1M events in memory
  512          -- maxMemoryMB: soft memory limit
  100          -- maxOpenFds: concurrent file handles
  50           -- maxSSEClients: concurrent SSE connections
```

## Module 6: Versioned Schemas

```
SchemaVersion : Set where
  v1 : SchemaVersion  — current event format

EventV1 : Set where
  mkEventV1 : (ts : ISO8601) → (event : EventName) → (_sub : Subsystem) →
              (_day : DateString) → (cwd : Maybe CanonicalPath) → EventV1

versionCheck : Event → SchemaVersion → Bool
versionCheck e v = e._schema == v  -- reject events with unknown schema versions
```

## Module 7: Performance Contracts

```
-- Snapshot: O(1) on cache hit, triggered by events.length change only
snapshot-complexity : Store → Complexity
snapshot-complexity s = if cache-valid? then O(1) else O(n)

-- Activity index: single O(events) pass, reused across all projects
activity-index-complexity : Store → Complexity  
activity-index-complexity s = O(n)  -- one pass, not O(n * projects)

-- Phase poll: O(projects) statSync calls, each O(1) on cache hit
phase-poll-complexity : List Project → Complexity
phase-poll-complexity ps = O(|ps|)  -- statSync per project, no reads on cache hit

-- Multi-project fanout: O(projects) fs.watch handles, O(events) total
fanout-complexity : List Project → Complexity
fanout-complexity ps = O(|ps|) handles, O(total events) memory
```

## Module 8: Missing Monitoring Surface (discovered via formal analysis)

The following gaps exist between what gm produces and what gmsniff surfaces:

1. **Spool queue depth**: `.gm/exec-spool/in/` directory file count per project — how many pending dispatches?
2. **Response latency**: `.gm/exec-spool/out/` response time distribution — how fast is the watcher?
3. **Memory store health**: `.gm/rs-learn.db` and `.gm/memories/` growth rate, file count, total size
4. **CodeInsight age**: `.codeinsight` file mtime vs now — how stale is the index?
5. **Watcher version drift**: per-project plugkit version vs latest published — who's behind?
6. **Instruction tier distribution**: across all projects, how many are vendored vs source-synced vs default?