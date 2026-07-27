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

// Seed for the subsystem tag universe -- gui/panels.js keeps a matching literal since the
// browser bundle cannot import this module. This is a SEED, not a closed set: observeSubsystems
// grows it from whatever tags real events actually carry, which is the only defence against the
// hardcode drifting stale again.
//
// Verified against live per-project watcher.log data (the real current source; ~/.claude/gm-log
// is dead): plugkit (untagged default, 11,979), hook (955), rs_learn (666), memory (88).
// 'rs_learn' is restored -- the rs-learn CRATE is retired, but the TAG is still what every
// pre-cutover recall event in real log history carries, and dropping it silently hid 666 real
// events. 'memory' is the same event class under its current tag (recall.rs). 'bootstrap' has
// zero live events in any discovered project but is retained as a seed only, since its absence
// is an absence of activity rather than proof the tag was retired.
export const SUBSYSTEMS = ['plugkit', 'hook', 'bootstrap', 'memory', 'rs_learn'];

const _observedSubsystems = new Set(SUBSYSTEMS);

// Records a tag seen in real data and returns the current union. Called from every parse path so
// a genuinely new upstream tag becomes visible without a code change.
export function observeSubsystem(sub) {
  if (sub && !_observedSubsystems.has(sub)) _observedSubsystems.add(sub);
  return _observedSubsystems;
}

export function observedSubsystems() {
  return [..._observedSubsystems].sort();
}

// Derives the tag universe from a real event array rather than trusting the seed alone.
export function deriveSubsystems(events) {
  for (const e of events || []) observeSubsystem(e && e._sub);
  return observedSubsystems();
}

// Schema version stamped on every parsed event — consumers can reject events with unknown
// schema versions rather than silently misinterpreting a shape change. Bumped whenever the
// event envelope shape (ts, event, _sub, _day, _fp, _src, cwd) changes in a non-additive way.
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

// The central ~/.claude/gm-log tree is a DEAD ARCHIVE, and is never blended into the live
// stream. Measured on a real machine: 72 day-dirs spanning 2026-05-11..2026-07-23 holding
// 1,131,698 jsonl events, newest 4+ days old -- against 26,866 live spool evt records. The
// archive is 42x LARGER than live data.
//
// That magnitude is exactly why a merge is wrong rather than merely imprecise: blended, every
// count, rate, top-event, by-day figure and health percentage would be computed over ~98% dead
// history while looking entirely plausible, with nothing for a user to notice. A silent blend
// is worse than either source alone.
//
// Disposition: the live/default path reads the per-project spool ONLY. gm-log is reachable only
// behind an explicit archive opt-in (replayAll's opts.archive / replayGmLog directly), and is
// still honored when a user deliberately sets GM_LOG_DIR -- but even then it is a SOURCE
// SELECTION, not an addition to live data. Every normalized event carries _src ('watcher.log'
// or 'gm-log') so a consumer can always tell live from archive.
export const GM_LOG_DIR_EXPLICIT = !!process.env.GM_LOG_DIR;

// A selected source whose newest event is far older than now is reporting history as if it were
// current. staleness() makes that explicit so a caller can warn loudly instead of rendering dead
// numbers silently -- the present failure mode is entirely invisible.
export const STALE_SOURCE_MS = parseInt(process.env.GM_STALE_SOURCE_MS, 10) || 6 * 60 * 60 * 1000;

export function sourceStaleness(events, now = Date.now()) {
  let newest = 0;
  for (const e of events || []) {
    const t = e && e.ts ? Date.parse(e.ts) : NaN;
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  if (!newest) return { newest_ts: null, age_ms: null, stale: true, reason: 'no timestamped events' };
  const age = now - newest;
  return {
    newest_ts: new Date(newest).toISOString(),
    age_ms: age,
    stale: age > STALE_SOURCE_MS,
    reason: age > STALE_SOURCE_MS ? `newest event is ${Math.round(age / 3600000)}h old` : null,
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
// Real wall-clock gap given to libuv after issuing fs.watch handle closes, before a stop()
// caller is allowed to proceed (e.g. to process.exit()) -- see GmLogWatcher.stop/
// MultiProjectWatcher.stop for the Windows UV_HANDLE_CLOSING race this avoids.
const WATCH_CLOSE_DRAIN_MS = parseInt(process.env.GM_WATCH_CLOSE_DRAIN_MS, 10) || 250;

function todayDir() {
  return new Date().toISOString().slice(0, 10);
}

// Retry interval for GmLogWatcher's watch-setup when this._dir does not exist yet at start()
// (e.g. a fresh machine before any event has ever been written to the central log) or the
// watch handle needs re-arming after the directory reappears -- fs.watch() throws ENOENT
// synchronously for a non-existent path (verified: Node re-checks the path at watch-call time,
// it does not wait for the path to appear), so without a retry loop a directory created any
// time after start() is silently never observed, permanently, for that process's lifetime.
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

  // A watch handle that later errors (e.g. the directory is removed out from under it) is
  // torn down and the same retry loop used for start()'s ENOENT case re-arms it once the
  // directory is available again, so recovery after any transient directory loss looks
  // identical to first-boot-before-directory-exists recovery.
  _rearm() {
    if (this._watcher) { try { this._watcher.close(); } catch (_) {} this._watcher = null; }
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._stopped || this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._stopped) return;
      this._scanAll(); // pick up any files written while unwatched, same as a fresh start()
      this._armWatch();
    }, WATCH_RETRY_MS);
  }

  // async + real drain for the same reason MultiProjectWatcher.stop() drains: closing an
  // fs.watch handle is asynchronous under the hood even though FSWatcher.close() returns
  // immediately, and an immediate process.exit() after a synchronous stop() can race libuv's
  // handle-close bookkeeping (Windows UV_HANDLE_CLOSING assertion, reproduced and fixed
  // identically on the per-project tailer path -- see WATCH_CLOSE_DRAIN_MS).
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
      // Truncation/rotation reset, matching ProjectLogTailer._read: a rotated or re-created
      // jsonl shrinks below the retained offset, and without this the tail would sit past EOF
      // forever and silently stop emitting for that file for the process's lifetime.
      if (stat.size < s.offset) { s.offset = 0; s.partial = ''; }
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

// Parse-completeness audit, re-measured against real current data (C:/dev/gmsniff's own
// watcher.log, 33,482 lines / 13,688 evt lines, re-verified this pass): the earlier claim that
// evt: lines do NOT carry phase.transitioned, dispatch.*, prd.*, mutable.*, or instruction.served
// is FALSE for current gm-plugkit. All of those are live as their own evt: lines today
// (phase.transitioned 18 -- and it carries a `from` field; dispatch.end 360 with verb+ms;
// prd.added 157; prd.resolved 50; mutable.added 11; mutable.resolved 5; instruction.served 21,
// carrying prd_pending_count/mutables_pending_count, NOT prd_pending/mutables_pending).
//
// What evt: genuinely does NOT cover is the ~58% of non-blank lines that are runtime chatter,
// dispatch arrow lines, and supervisor spawn banners. Those are no longer silently discarded:
// see watcher-log.js classifyLine and the parse-coverage stats returned alongside every replay.
export function replayWatcherLog(fp, cwd) {
  return replayWatcherLogWithStats(fp, cwd, EVENT_SCHEMA_VERSION).events;
}

// Same replay, plus the per-file parse-coverage counters (total/blank/event/dispatch/spawn/
// runtime/retention/other/malformed_json + parsed_ratio/drop_ratio) so a caller can surface how
// much of the file produced no structured event rather than letting that loss stay invisible.
export function replayWatcherLogAudited(fp, cwd) {
  return replayWatcherLogWithStats(fp, cwd, EVENT_SCHEMA_VERSION);
}

// Machine-global gm-plugkit install dir. daemon-registry.txt is the AUTHORITATIVE list of every
// cwd the shared daemon actually serves -- including worktree-hosted projects nested several
// levels deep (real example: C:\dev\spoint\.claude\worktrees\wf_26bd1b5f-888-1), which the
// one-level readdir scan of dev roots structurally cannot see.
export const GM_TOOLS_DIR = process.env.GM_TOOLS_DIR || path.join(os.homedir(), '.gm-tools');

// daemon-registry.txt is a DISCOVERY HINT, never a liveness list: it is append-only and never
// self-prunes. Measured on a real machine, only 3 of its 12 entries still exist on disk (the
// other 9 are deleted spoint worktrees and a removed C:\dev\test). Its value is purely that it
// reaches deep worktree paths a one-level readdir cannot see; every candidate it yields is then
// filtered by real existence downstream in discoverSpoolLogs.
export function readDaemonRegistry({ existingOnly = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(GM_TOOLS_DIR, 'daemon-registry.txt'), 'utf8')
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

// Primary replay path: every discovered project's watcher.log. Name kept for backward
// compatibility with existing callers even though this is no longer a "fallback".
export function replaySpoolFallback(explicit) {
  return replaySpool(explicit).events;
}

// Same replay with per-project parse-coverage stats, current watcher-spawn epoch, and the
// per-project served plugkit version aggregated.
//
// The read is BOUNDED by default (opts.maxBytes, default DEFAULT_REPLAY_BYTES = 2MB per file):
// a real watcher.log reaches 6.1MB/85k lines, and reading full history on every CLI invocation
// and GUI boot is the dominant cost of a cold read. Pass maxBytes:0 to read full history.
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

// Per-project live signals derived from the watcher.log itself: the current watcher-spawn epoch
// (the only real correlation anchor available, since `sess` is absent from every live record)
// and the served plugkit version banner (the only per-project version signal that still exists
// -- .status.json dropped its `version` field entirely).
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

// Read lazily (function, not a frozen module-load-time const) so a caller that sets
// GM_FANOUT_REDISCOVER_MS after this module has already been imported elsewhere in the
// process (as every test/CLI invocation does, since index.js is imported for DEFAULT_LOG_DIR
// well before any per-test env override) still gets the overridden interval.
function defaultRediscoverMs() {
  return parseInt(process.env.GM_FANOUT_REDISCOVER_MS, 10) || 30000;
}

// Tails a single project's .gm/exec-spool/.watcher.log incrementally (evt: line format,
// same EVT_RE the replay path uses), emitting 'event' with cwd attribution preserved.
// Mirrors GmLogWatcher's fd-offset tailing shape but sourced from the per-project
// watcher.log file directly rather than a day/subsystem jsonl tree.
class ProjectLogTailer extends EventEmitter {
  constructor(cwd, fp) {
    super();
    this.cwd = cwd;
    this._fp = fp;
    this._fd = null;
    this._offset = 0;
    this._partial = '';
    this._watcher = null;
    this._timer = null;
    this._ctx = newParseContext();
    this._stats = newParseStats();
  }

  // Live parse-coverage counters for this project's tail, plus the current watcher-spawn epoch
  // and the last version banner seen -- surfaced so a caller can report real coverage rather
  // than assuming every line produced an event.
  stats() {
    return { cwd: this.cwd, fp: this._fp, epoch: this._ctx.epoch, version: this._ctx.version, ...parseCoverage(this._stats) };
  }

  start() {
    this._read(); // pick up any lines already present since last known offset (0 on first start)
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
      const stat = fs.fstatSync(this._fd);
      if (stat.size < this._offset) { this._offset = 0; this._partial = ''; } // truncated/rotated
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

  // cwd is always this tailer's own discovered project cwd, never o.cwd from the log line's
  // JSON body -- see replayWatcherLog's identical hardening for the rationale. Structured
  // non-JSON lines (dispatch arrows, spawn banners, version banners, stale-lock takeovers) are
  // synthesized into real events by the shared parser and emitted on the same stream, tagged
  // _origin:'line' so a consumer can always distinguish them from upstream evt: records.
  _line(raw) {
    const ev = parseLine(raw, { cwd: this.cwd, fp: this._fp, schema: EVENT_SCHEMA_VERSION, stats: this._stats, ctx: this._ctx });
    if (!ev) return;
    observeSubsystem(ev._sub);
    this.emit('event', ev);
    this.emit(`sub:${ev._sub}`, ev);
  }
}

// Fans a live event stream out across every project discoverSpoolLogs finds, one
// ProjectLogTailer per project, merged into a single 'event' stream with cwd attribution
// preserved on every emitted event. Periodically re-runs discovery so a project whose
// watcher.log appears after this process started is picked up, and stops+drops the tailer
// for a project whose watcher.log disappears -- both without a process restart.
export class MultiProjectWatcher extends EventEmitter {
  constructor({ explicit, rediscoverMs } = {}) {
    super();
    this._explicit = explicit;
    this._rediscoverMs = rediscoverMs != null ? rediscoverMs : defaultRediscoverMs();
    this._tailers = new Map(); // key (lowercased resolved fp) -> ProjectLogTailer
    this._rediscoverTimer = null;
    this._stopped = true;
  }

  start() {
    this._stopped = false;
    this._sync();
    this._scheduleRediscover();
    return this;
  }

  // Returns a Promise that resolves only after every fs.watch handle's close has actually
  // been processed by libuv, not merely requested -- fs.FSWatcher.close() looks synchronous
  // but the underlying uv_fs_event_t handle closes asynchronously on Windows; a caller that
  // process.exit()s (or otherwise tears the process down) immediately after a synchronous
  // stop() can race libuv's own handle-close bookkeeping and crash with a
  // UV_HANDLE_CLOSING assertion. setImmediate alone (microtask-adjacent, no real wall-clock
  // gap) was NOT sufficient at real scale (55+ concurrent fs.watch handles across discovered
  // projects) -- reproduced still crashing 3/3 with a setImmediate-only drain. A real
  // WATCH_CLOSE_DRAIN_MS timer (default 250ms, tunable for slower/loaded machines) is what
  // measurably avoided the crash across repeated runs.
  async stop() {
    this._stopped = true;
    if (this._rediscoverTimer) { clearTimeout(this._rediscoverTimer); this._rediscoverTimer = null; }
    for (const t of this._tailers.values()) t.stop();
    this._tailers.clear();
    await new Promise(r => setTimeout(r, WATCH_CLOSE_DRAIN_MS));
  }

  // Current set of project cwds actively tailed (for status/diagnostics surfacing).
  projects() {
    return [...this._tailers.values()].map(t => ({ cwd: t.cwd, fp: t._fp }));
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
      if (this._tailers.has(key)) continue;
      const t = new ProjectLogTailer(cwd, fp);
      t.on('event', ev => this.emit('event', ev));
      t.on('error', e => this.emit('error', Object.assign(e instanceof Error ? e : new Error(String(e)), { cwd })));
      t.start();
      this._tailers.set(key, t);
      this.emit('project.added', { cwd, fp });
    }
    for (const [key, t] of this._tailers) {
      if (seen.has(key)) continue;
      if (fs.existsSync(t._fp)) continue; // still present, just not returned this cycle (defensive)
      t.stop();
      this._tailers.delete(key);
      this.emit('project.removed', { cwd: t.cwd, fp: t._fp });
    }
  }
}

// Reads the legacy central gm-log tree only. Kept separate so replayAll can MERGE it rather
// than choose between it and the live source.
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

// PRIMARY read path: the per-project watcher.log fleet, and nothing else.
//
// This inverts the previous polarity, which consulted the spool only when gm-log was absent or
// yielded zero events. That condition is provably never satisfied on a real machine -- gm-log
// exists with 1.13M archived events -- so every non-tail read (every CLI invocation, every
// Store.load()) returned a dead dataset and never saw live data at all.
//
// The archive is NOT merged. opts.archive:true selects gm-log INSTEAD, as a deliberate
// historical query; GM_LOG_DIR being set also selects it, since setting it is an explicit
// statement about which tree to read. Use replayAllAudited to get the source/staleness
// accounting alongside the events.
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

  const useArchive = opts.archive === true || (opts.archive !== false && GM_LOG_DIR_EXPLICIT);
  if (useArchive) {
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
