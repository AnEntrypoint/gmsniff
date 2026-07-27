import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import {
  EVT_RE, classifyLine, parseLine, parseEventLine, parseSpawnLine, parseDispatchLine,
  parseVersionLine, newParseStats, newParseContext, parseCoverage, replayWatcherLogWithStats,
  readTail, DEFAULT_REPLAY_BYTES, normalizeTs,
} from './watcher-log.js';

export {
  EVT_RE, classifyLine, parseLine, parseEventLine, parseSpawnLine, parseDispatchLine,
  parseVersionLine, newParseStats, newParseContext, parseCoverage, replayWatcherLogWithStats,
  readTail, DEFAULT_REPLAY_BYTES, normalizeTs,
};
export { correlationOf, correlationKey, correlationCoverage, CORRELATION_KINDS } from './correlation.js';

// MEASURED against BOTH ../gm source and a full-history replay of all 60 discovered projects
// (233,443 events). Each tag is here for a reason a source-only check would get wrong:
//
//   hook      -- 4 emit sites in rs-plugkit/crates/plugkit-core (wasm_dispatch/events.rs:9,
//                gates.rs:119, lib.rs:128, orchestrator/instructions/mod.rs:251). 2,781 events
//                across 60 projects, 2026-05-22..now. Every deviation.* event.
//   memory    -- 1 emit site (orchestrator/recall.rs:39). 5,516 events across 47 projects,
//                2026-07-07..now. All `recall`.
//   rs_learn  -- zero string literals left in ../gm source, so a source-only check concludes it
//                is retired and drops it. But it carries 5,295 real events across 28 projects
//                spanning 2026-06-20..2026-07-07 -- the SAME `recall` event `memory` carries
//                after that date, a clean rename cutover, not a retirement. Commit 17af397
//                ("fix subsystem tags (memory not rs_learn)") read the rename as a correction and
//                removed the old tag, making 5,295 events of still-readable history untaggable.
//   plugkit   -- never emitted as a `sub` by gm at all. It is THIS parser's default tag for an
//                evt record with no `sub` (41,925 such records) and for every synthesized
//                line-event, so it is a real tag in gmsniff's own output.
//   bootstrap -- bin/bootstrap.js emits it through obsEvent(), which writes to the ARCHIVE tree
//                (~/.claude/gm-log/<day>/bootstrap.jsonl), never .gm/exec-spool/.watcher.log. It
//                is structurally unreachable on the live spool path, so zero live events is
//                expected rather than evidence of retirement.
export const SUBSYSTEMS = ['plugkit', 'hook', 'bootstrap', 'memory', 'rs_learn'];

const subsystemsSeededThenGrownFromRealEvents = new Set(SUBSYSTEMS);

export function observeSubsystem(sub) {
  if (sub && !subsystemsSeededThenGrownFromRealEvents.has(sub)) subsystemsSeededThenGrownFromRealEvents.add(sub);
  return subsystemsSeededThenGrownFromRealEvents;
}

export function observedSubsystems() {
  return [...subsystemsSeededThenGrownFromRealEvents].sort();
}

export function deriveSubsystems(events) {
  for (const e of events || []) observeSubsystem(e && e._sub);
  return observedSubsystems();
}

// Bump whenever the event envelope shape (ts, event, _sub, _day, _fp, _src, cwd) changes in a
// non-additive way, so a consumer can reject an unknown version rather than misinterpret it.
export const EVENT_SCHEMA_VERSION = 'v1';
export function discoverSubsystems(logDir) {
  const out = new Set();
  if (!fs.existsSync(logDir)) return [...out];
  try {
    for (const d of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dayDir = path.join(logDir, d.name);
      try {
        for (const f of fs.readdirSync(dayDir)) {
          if (f.endsWith('.jsonl')) out.add(path.basename(f, '.jsonl'));
        }
      } catch (_) {}
    }
  } catch (_) {}
  return [...out].sort();
}

export const DEFAULT_LOG_DIR = process.env.GM_LOG_DIR || path.join(os.homedir(), '.claude', 'gm-log');

// MEASURED on a real machine: the ~/.claude/gm-log archive holds 1,131,698 jsonl events across 72
// day-dirs (2026-05-11..2026-07-23, newest 4+ days old) against 26,866 live spool evt records --
// 42x LARGER than live data. That magnitude is why a merge is wrong rather than merely imprecise:
// blended, every count, rate, top-event, by-day figure and health percentage would be computed
// over ~98% dead history while looking entirely plausible, with nothing for a user to notice.
export const GM_LOG_DIR_EXPLICIT = !!process.env.GM_LOG_DIR;

export const STALE_SOURCE_MS = parseInt(process.env.GM_STALE_SOURCE_MS, 10) || 6 * 60 * 60 * 1000;

// Throws on a missing `events` rather than defaulting: it previously fell through the empty loop
// and returned {stale:true, reason:'no timestamped events'} -- a confident STALE verdict about a
// source it had never looked at, which fed a user-facing warning. A call-site bug and a genuinely
// empty source must not produce the same output.
export function sourceStaleness(events, now = Date.now()) {
  if (events === undefined || events === null) {
    throw new TypeError('sourceStaleness(events) requires an events array; call it with the events whose source you are auditing');
  }
  let newestParsedTs = 0;
  // Events with no parseable ts are structurally invisible to every time-based surface (sort,
  // day-bucket, age, window), so the count is reported rather than left as a silent shortfall.
  let timed = 0, untimed = 0;
  for (const e of events) {
    const t = e && e.ts ? Date.parse(e.ts) : NaN;
    if (Number.isFinite(t)) { timed++; if (t > newestParsedTs) newestParsedTs = t; } else untimed++;
  }
  if (!newestParsedTs) return { newest_ts: null, age_ms: null, stale: true, reason: 'no timestamped events', timed, untimed };
  const age = now - newestParsedTs;
  const reportingHistoryAsIfCurrent = age > STALE_SOURCE_MS;
  return {
    newest_ts: new Date(newestParsedTs).toISOString(),
    age_ms: age,
    stale: reportingHistoryAsIfCurrent,
    reason: reportingHistoryAsIfCurrent ? `newest event is ${Math.round(age / 3600000)}h old` : null,
    timed,
    untimed,
  };
}

export function gmLogDirHasEvents(logDir = DEFAULT_LOG_DIR) {
  try {
    for (const d of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(logDir, d.name))) {
        if (!f.endsWith('.jsonl')) continue;
        try { if (fs.statSync(path.join(logDir, d.name, f)).size > 0) return true; } catch (_) {}
      }
    }
  } catch (_) {}
  return false;
}
const DEBOUNCE_MS = 50;
const WATCH_CLOSE_DRAIN_MS = parseInt(process.env.GM_WATCH_CLOSE_DRAIN_MS, 10) || 250;

function todayDir() {
  return new Date().toISOString().slice(0, 10);
}

// VERIFIED: fs.watch() throws ENOENT synchronously for a non-existent path -- Node re-checks the
// path at watch-call time and does not wait for it to appear. Without this retry loop a directory
// created any time after start() is silently never observed, permanently, for the process's life.
const WATCH_RETRY_MS = parseInt(process.env.GM_WATCH_RETRY_MS, 10) || 1000;

export class GmLogWatcher extends EventEmitter {
  constructor(logDir = DEFAULT_LOG_DIR) {
    super();
    this._dir = logDir;
    this._tails = new Map();
    this._timers = new Map();
    this._watcher = null;
    this._retryTimer = null;
    this._stopped = false;
  }

  start() {
    this._scanAll();
    this._armWatch();
    return this;
  }

  _armWatch() {
    if (this._stopped || this._watcher) return;
    try {
      fs.mkdirSync(this._dir, { recursive: true });
    } catch (e) {
      this.emit('error', e);
    }
    try {
      this._watcher = fs.watch(this._dir, { recursive: true }, (_, f) => {
        if (f && f.endsWith('.jsonl')) this._debounce(path.join(this._dir, f));
      });
      this._watcher.on('error', e => { this.emit('error', e); this._rearm(); });
    } catch (e) {
      this.emit('error', e);
      this._scheduleRetry();
    }
  }

  _rearm() {
    if (this._watcher) { try { this._watcher.close(); } catch (_) {} this._watcher = null; }
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._stopped || this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._stopped) return;
      this._scanAll();
      this._armWatch();
    }, WATCH_RETRY_MS);
  }

  // Drains for the same measured reason MultiProjectWatcher.stop() does -- see the note there.
  async stop() {
    this._stopped = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._watcher) try { this._watcher.close(); } catch (_) {}
    for (const s of this._tails.values()) if (s.fd !== null) try { fs.closeSync(s.fd); } catch (_) {}
    for (const t of this._timers.values()) clearTimeout(t);
    this._tails.clear(); this._timers.clear();
    await new Promise(r => setTimeout(r, WATCH_CLOSE_DRAIN_MS));
  }

  _scanAll() {
    if (!fs.existsSync(this._dir)) return;
    try {
      for (const d of fs.readdirSync(this._dir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dayDir = path.join(this._dir, d.name);
        for (const f of fs.readdirSync(dayDir)) {
          if (f.endsWith('.jsonl')) this._read(path.join(dayDir, f));
        }
      }
    } catch (_) {}
  }

  _debounce(fp) {
    const t = this._timers.get(fp);
    if (t) clearTimeout(t);
    this._timers.set(fp, setTimeout(() => { this._timers.delete(fp); this._read(fp); }, DEBOUNCE_MS));
  }

  _read(fp) {
    const parts = fp.replace(/\\/g, '/').split('/');
    const day = parts[parts.length - 2];
    const sub = path.basename(fp, '.jsonl');
    let s = this._tails.get(fp);
    if (!s) { s = { fd: null, offset: 0, partial: '' }; this._tails.set(fp, s); }
    try {
      if (s.fd === null) s.fd = fs.openSync(fp, 'r');
      const stat = fs.fstatSync(s.fd);
      const rotatedOrTruncated = stat.size < s.offset;
      if (rotatedOrTruncated) { s.offset = 0; s.partial = ''; }
      if (stat.size <= s.offset) return;
      const buf = Buffer.allocUnsafe(stat.size - s.offset);
      const n = fs.readSync(s.fd, buf, 0, buf.length, s.offset);
      s.offset += n;
      const text = s.partial + buf.toString('utf8', 0, n);
      const lines = []; let start = 0, idx;
      while ((idx = text.indexOf('\n', start)) !== -1) { lines.push(text.slice(start, idx).trim()); start = idx + 1; }
      s.partial = text.slice(start);
      for (const l of lines) if (l) this._line(l, sub, day, fp);
    } catch (e) {
      if (e.code !== 'ENOENT') this.emit('error', e);
      if (s && s.fd !== null) { try { fs.closeSync(s.fd); } catch (_) {} s.fd = null; }
    }
  }

  _line(raw, sub, day, fp) {
    let obj;
    try { obj = JSON.parse(raw); } catch { return; }
    const ev = { ...obj, ts: normalizeTs(obj.ts), _sub: sub, _day: day, _fp: fp, _schema: EVENT_SCHEMA_VERSION };
    if (!ev.event) ev.event = obj.phase || obj.action || obj.kind || obj.type || '?';
    this.emit('event', ev);
    this.emit(`sub:${sub}`, ev);
  }
}

// MEASURED against real current data (C:/dev/gmsniff's own watcher.log, 33,482 lines / 13,688 evt
// lines): an earlier claim that evt: lines do NOT carry phase.transitioned, dispatch.*, prd.*,
// mutable.* or instruction.served is FALSE for current gm-plugkit. All are live as their own evt:
// lines today (phase.transitioned 18, carrying a `from` field; dispatch.end 360 with verb+ms;
// prd.added 157; prd.resolved 50; mutable.added 11; mutable.resolved 5; instruction.served 21,
// carrying prd_pending_count/mutables_pending_count, NOT prd_pending/mutables_pending). What evt:
// genuinely does not cover is the ~58% of non-blank lines that are runtime chatter, dispatch
// arrow lines and supervisor spawn banners -- see watcher-log.js classifyLine.
export function replayWatcherLog(fp, cwd) {
  return replayWatcherLogWithStats(fp, cwd, EVENT_SCHEMA_VERSION).events;
}

export function replayWatcherLogAudited(fp, cwd) {
  return replayWatcherLogWithStats(fp, cwd, EVENT_SCHEMA_VERSION);
}

export const GM_TOOLS_DIR = process.env.GM_TOOLS_DIR || path.join(os.homedir(), '.gm-tools');
export const AGENTPLUG_DIR = process.env.AGENTPLUG_DIR || path.join(os.homedir(), '.agentplug');

export function readDaemonRegistry({ existingOnly = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(AGENTPLUG_DIR, 'daemon-registry.txt'), 'utf8')
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch (_) { return []; }
  if (!existingOnly) return raw;
  return raw.filter(p => { try { return fs.existsSync(path.join(p, '.gm')); } catch (_) { return false; } });
}

export function discoverSpoolLogs(explicit) {
  const found = new Map();
  const addProject = (proj) => {
    if (!proj) return;
    const key = path.resolve(proj).replace(/\\/g, '/').toLowerCase();
    if (found.has(key)) return;
    const fp = path.join(proj, '.gm', 'exec-spool', '.watcher.log');
    if (fs.existsSync(fp)) found.set(key, { cwd: path.resolve(proj), fp });
  };
  if (explicit) {
    const p = path.resolve(explicit);
    if (p.endsWith('.log')) {
      const proj = path.dirname(path.dirname(path.dirname(p)));
      if (fs.existsSync(p)) found.set(p.toLowerCase(), { cwd: proj, fp: p });
    } else addProject(p);
    return [...found.values()];
  }
  for (const cwd of readDaemonRegistry()) addProject(cwd);
  const roots = [];
  if (process.env.GM_SPOOL_DIRS) roots.push(...process.env.GM_SPOOL_DIRS.split(path.delimiter).filter(Boolean));
  for (const env of ['DEV_ROOT', 'GM_DEV_ROOT']) if (process.env[env]) roots.push(process.env[env]);
  roots.push(process.cwd());
  roots.push(process.platform === 'win32' ? 'C:/dev' : path.join(os.homedir(), 'dev'));
  for (const root of roots) {
    addProject(root);
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory()) addProject(path.join(root, d.name));
      }
    } catch {}
  }
  return [...found.values()];
}

// Name kept only for backward compatibility with existing callers -- this is the PRIMARY replay
// path, not a fallback.
export function replaySpoolFallback(explicit) {
  return replaySpool(explicit).events;
}

export function replaySpool(explicit, opts = {}) {
  const events = [];
  const perProject = [];
  const totals = newParseStats();
  for (const { cwd, fp } of discoverSpoolLogs(explicit)) {
    const r = replayWatcherLogWithStats(fp, cwd, EVENT_SCHEMA_VERSION, opts);
    events.push(...r.events);
    perProject.push({ cwd, fp, epoch: r.epoch, version: r.version, truncated: r.truncated, size: r.size, ...r.stats });
    for (const k of Object.keys(totals)) totals[k] += r.stats[k] || 0;
  }
  deriveSubsystems(events);
  return {
    events: events.sort((a, b) => (a.ts || '') < (b.ts || '') ? -1 : 1),
    stats: parseCoverage(totals),
    projects: perProject,
  };
}

// The watcher-spawn epoch is the only real correlation anchor available (`sess` is absent from
// every live record) and the plugkit version banner is the only per-project version signal that
// still exists (.status.json dropped its `version` field entirely).
export function readProjectLogSignals(cwd, opts = {}) {
  const fp = path.join(cwd, '.gm', 'exec-spool', '.watcher.log');
  let stat;
  try { stat = fs.statSync(fp); } catch (_) { return { present: false, epoch: null, version: null, mtime_ms: null, size: null }; }
  const r = replayWatcherLogWithStats(fp, cwd, EVENT_SCHEMA_VERSION, { maxBytes: opts.maxBytes === undefined ? DEFAULT_REPLAY_BYTES : opts.maxBytes });
  return {
    present: true,
    epoch: r.epoch,
    version: r.version,
    versions: r.ctx ? r.ctx.versions : [],
    mtime_ms: stat.mtimeMs,
    size: stat.size,
    truncated: r.truncated,
    stats: r.stats,
  };
}

// A function rather than a module-load-time const because every test/CLI invocation imports
// index.js for DEFAULT_LOG_DIR before setting GM_FANOUT_REDISCOVER_MS; frozen at load, the
// override would never take effect.
function readRediscoverMsFromEnvEachCall() {
  return parseInt(process.env.GM_FANOUT_REDISCOVER_MS, 10) || 30000;
}

// Mirrors GmLogWatcher's fd-offset tailing shape, sourced from one project's watcher.log directly
// rather than from a day/subsystem jsonl tree.
class ProjectLogTailer extends EventEmitter {
  constructor(cwd, fp, { skipExistingContent = false } = {}) {
    super();
    this.cwd = cwd;
    this._fp = fp;
    this._fd = null;
    this._skipExistingContent = skipExistingContent;
    this._inode = null;
    this._offset = 0;
    this._partial = '';
    this._watcher = null;
    this._timer = null;
    this._ctx = newParseContext();
    this._stats = newParseStats();
  }

  stats() {
    return { cwd: this.cwd, fp: this._fp, epoch: this._ctx.epoch, version: this._ctx.version, ...parseCoverage(this._stats) };
  }

  start() {
    // A replay has already delivered every line currently in this file. Reading from offset 0
    // here would deliver each of them a second time, and the duplication is invisible in the
    // output: every count, rate and per-project total simply doubles, which reads as more data
    // rather than as a bug.
    if (this._skipExistingContent) {
      try { this._offset = fs.statSync(this._fp).size; } catch (_) { this._offset = 0; }
    }
    this._read();
    try {
      this._watcher = fs.watch(this._fp, () => this._debounce());
      this._watcher.on('error', e => this.emit('error', e));
    } catch (e) { this.emit('error', e); }
    return this;
  }

  stop() {
    if (this._watcher) { try { this._watcher.close(); } catch (_) {} this._watcher = null; }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._fd !== null) { try { fs.closeSync(this._fd); } catch (_) {} this._fd = null; }
  }

  _debounce() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this._read(); }, DEBOUNCE_MS);
  }

  _read() {
    try {
      if (this._fd === null) this._fd = fs.openSync(this._fp, 'r');
      // Size alone cannot detect rotation: a replacement file of equal or greater size leaves
      // stat.size >= offset, so the reset never fires and the tail keeps reading a stale offset
      // into unrelated bytes. Measured: a 110-byte log rewritten to 77 bytes recovered, the same
      // log rewritten at equal size silently missed every new line. The open fd also still points
      // at the replaced inode, so fstat cannot see the new file at all -- stat the PATH and
      // compare identity, then reopen.
      const onDisk = fs.statSync(this._fp);
      const replacedOnDisk = this._inode != null && String(onDisk.ino) !== this._inode;
      if (replacedOnDisk) {
        try { fs.closeSync(this._fd); } catch (_) {}
        this._fd = fs.openSync(this._fp, 'r');
        this._offset = 0;
        this._partial = '';
      }
      this._inode = String(onDisk.ino);
      const stat = fs.fstatSync(this._fd);
      const truncatedInPlace = stat.size < this._offset;
      if (truncatedInPlace) { this._offset = 0; this._partial = ''; }
      if (stat.size <= this._offset) return;
      const buf = Buffer.allocUnsafe(stat.size - this._offset);
      const n = fs.readSync(this._fd, buf, 0, buf.length, this._offset);
      this._offset += n;
      const text = this._partial + buf.toString('utf8', 0, n);
      const lines = []; let start = 0, idx;
      while ((idx = text.indexOf('\n', start)) !== -1) { lines.push(text.slice(start, idx)); start = idx + 1; }
      this._partial = text.slice(start);
      for (const l of lines) this._line(l);
    } catch (e) {
      if (e.code !== 'ENOENT') this.emit('error', e);
      if (this._fd !== null) { try { fs.closeSync(this._fd); } catch (_) {} this._fd = null; }
    }
  }

  _line(raw) {
    const ev = parseLine(raw, { cwd: this.cwd, fp: this._fp, schema: EVENT_SCHEMA_VERSION, stats: this._stats, ctx: this._ctx });
    if (!ev) return;
    observeSubsystem(ev._sub);
    this.emit('event', ev);
    this.emit(`sub:${ev._sub}`, ev);
  }
}

// One ProjectLogTailer per discovered project, merged into a single 'event' stream with cwd
// attribution preserved. Rediscovery runs on a timer so a project whose watcher.log appears or
// disappears after this process started is picked up or dropped without a restart.
export class MultiProjectWatcher extends EventEmitter {
  constructor({ explicit, rediscoverMs, replayHasConsumedExistingContent = false } = {}) {
    super();
    this._explicit = explicit;
    this._rediscoverMs = rediscoverMs != null ? rediscoverMs : readRediscoverMsFromEnvEachCall();
    this._tailersByLowercasedResolvedFp = new Map();
    this._rediscoverTimer = null;
    this._stopped = true;
    this._replayHasConsumedExistingContent = replayHasConsumedExistingContent;
    this._isFirstSync = true;
  }

  start() {
    this._stopped = false;
    this._sync();
    this._isFirstSync = false;
    this._scheduleRediscover();
    return this;
  }

  // Resolves only after every fs.watch handle's close has actually been processed by libuv, not
  // merely requested: FSWatcher.close() looks synchronous but the underlying uv_fs_event_t handle
  // closes asynchronously on Windows, and a caller that process.exit()s right after a synchronous
  // stop() races libuv's handle-close bookkeeping and crashes with a UV_HANDLE_CLOSING assertion.
  //
  // REJECTED: setImmediate alone (microtask-adjacent, no real wall-clock gap). At real scale --
  // 55+ concurrent fs.watch handles across discovered projects -- it still crashed 3/3.
  // A real WATCH_CLOSE_DRAIN_MS timer is what measurably avoided the crash across repeated runs.
  async stop() {
    this._stopped = true;
    if (this._rediscoverTimer) { clearTimeout(this._rediscoverTimer); this._rediscoverTimer = null; }
    for (const t of this._tailersByLowercasedResolvedFp.values()) t.stop();
    this._tailersByLowercasedResolvedFp.clear();
    await new Promise(r => setTimeout(r, WATCH_CLOSE_DRAIN_MS));
  }

  // Current set of project cwds actively tailed (for status/diagnostics surfacing).
  projects() {
    return [...this._tailersByLowercasedResolvedFp.values()].map(t => ({ cwd: t.cwd, fp: t._fp }));
  }

  _scheduleRediscover() {
    if (this._stopped) return;
    this._rediscoverTimer = setTimeout(() => {
      if (this._stopped) return;
      this._sync();
      this._scheduleRediscover();
    }, this._rediscoverMs);
  }

  _sync() {
    let found;
    try { found = discoverSpoolLogs(this._explicit); } catch (e) { this.emit('error', e); found = []; }
    const seen = new Set();
    for (const { cwd, fp } of found) {
      const key = fp.replace(/\\/g, '/').toLowerCase();
      seen.add(key);
      if (this._tailersByLowercasedResolvedFp.has(key)) continue;
      const alreadyDeliveredByReplay = this._replayHasConsumedExistingContent && this._isFirstSync;
      const t = new ProjectLogTailer(cwd, fp, { skipExistingContent: alreadyDeliveredByReplay });
      t.on('event', ev => this.emit('event', ev));
      t.on('error', e => this.emit('error', Object.assign(e instanceof Error ? e : new Error(String(e)), { cwd })));
      t.start();
      this._tailersByLowercasedResolvedFp.set(key, t);
      this.emit('project.added', { cwd, fp });
    }
    for (const [key, t] of this._tailersByLowercasedResolvedFp) {
      if (seen.has(key)) continue;
      const stillOnDiskJustNotReturnedThisCycle = fs.existsSync(t._fp);
      if (stillOnDiskJustNotReturnedThisCycle) continue;
      t.stop();
      this._tailersByLowercasedResolvedFp.delete(key);
      this.emit('project.removed', { cwd: t.cwd, fp: t._fp });
    }
  }
}

// Reads the legacy central gm-log archive tree only. Kept separate so replayAll can SELECT
// between it and the live source, never blend them.
export function replayGmLog(logDir = DEFAULT_LOG_DIR) {
  const events = [];
  if (!fs.existsSync(logDir)) return events;
  try {
    for (const d of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dayDir = path.join(logDir, d.name);
      for (const f of fs.readdirSync(dayDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const sub = path.basename(f, '.jsonl');
        const day = d.name;
        try {
          const lines = fs.readFileSync(path.join(dayDir, f), 'utf8').split('\n');
          for (const l of lines) {
            if (!l.trim()) continue;
            try {
              const o = JSON.parse(l);
              const ev = { ...o, ts: normalizeTs(o.ts), _sub: sub, _day: day, _schema: EVENT_SCHEMA_VERSION };
              if (!ev.event) ev.event = o.phase || o.action || o.kind || o.type || '?';
              events.push(ev);
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}
  return events;
}

// REJECTED: the previous polarity, which consulted the spool only when gm-log was absent or
// yielded zero events. That condition is provably never satisfied on a real machine (gm-log
// exists with 1.13M archived events), so every non-tail read -- every CLI invocation, every
// Store.load() -- returned a dead dataset and never saw live data at all.
export function replayAll(logDir = DEFAULT_LOG_DIR, opts = {}) {
  return replayAllAudited(logDir, opts).events;
}

export function replayAllAudited(logDir = DEFAULT_LOG_DIR, opts = {}) {
  if (opts.spool) {
    const one = replaySpool(opts.spool);
    return {
      events: one.events, source: 'spool', archive_used: false,
      sources: { spool: { events: one.events.length, projects: one.projects.length }, gm_log: { used: false } },
      stats: one.stats, projects: one.projects,
      staleness: sourceStaleness(one.events), subsystems: observedSubsystems(),
    };
  }

  // Selects the archive INSTEAD of live data, never in addition to it. Setting GM_LOG_DIR counts
  // as the same explicit statement about which tree to read as passing archive:true.
  const readArchiveInsteadOfLive = opts.archive === true || (opts.archive !== false && GM_LOG_DIR_EXPLICIT);
  if (readArchiveInsteadOfLive) {
    const events = replayGmLog(logDir).sort((a, b) => (a.ts || '') < (b.ts || '') ? -1 : 1);
    deriveSubsystems(events);
    const staleness = sourceStaleness(events);
    return {
      events, source: 'gm-log', archive_used: true,
      sources: { spool: { used: false }, gm_log: { dir: logDir, explicit: GM_LOG_DIR_EXPLICIT, used: true, events: events.length } },
      stats: null, projects: [],
      staleness,
      warnings: staleness.stale ? [`archive source ${logDir} is stale: ${staleness.reason}`] : [],
      subsystems: observedSubsystems(),
    };
  }

  const spool = replaySpool(undefined);
  const staleness = sourceStaleness(spool.events);
  const warnings = [];
  if (staleness.stale) warnings.push(`live spool source is stale: ${staleness.reason}`);
  if (!spool.events.length && gmLogDirHasEvents(logDir)) {
    warnings.push(`no live spool events; a legacy archive exists at ${logDir} (not merged -- pass archive:true to read it)`);
  }
  return {
    events: spool.events, source: 'spool', archive_used: false,
    sources: {
      spool: { events: spool.events.length, projects: spool.projects.length },
      gm_log: { dir: logDir, explicit: GM_LOG_DIR_EXPLICIT, used: false, available: gmLogDirHasEvents(logDir) },
    },
    stats: spool.stats, projects: spool.projects,
    staleness, warnings, subsystems: observedSubsystems(),
  };
}
