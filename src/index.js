import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

// Single source of truth for the subsystem tag universe -- gui/panels.js imports this rather
// than keeping its own copy. Confirmed against real ../gm source + the last 7 days of every
// discovered project's real gm-log data: rs_learn (crate explicitly retired, rs-plugkit
// wasm_dispatch/verbs.rs), rs_codeinsight, rs_search, plugkit_wrapper, acp-launcher, learning,
// git, and exec all had zero live events in that window and no current emitter in ../gm source
// -- removed. 'memory' added: rs-plugkit orchestrator/recall.rs tags every recall event
// sub:"memory", confirmed live (hundreds/day in real logs) and previously unmodeled here.
export const SUBSYSTEMS = ['plugkit', 'hook', 'bootstrap', 'memory'];

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

function normalizeTs(ts) {
  if (typeof ts === 'string') return ts;
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString();
  return '';
}

const EVT_RE = /evt:\s*(\{.*\})\s*$/;

// Parse-completeness audit (real .watcher.log content from 6 live gm-plugkit repos, 87k+
// lines): EVT_RE correctly parses every line gm-plugkit actually prefixes with "evt: ", but
// that prefix covers only deviation.*, recall, embed.*, memory.*/memorize_*, git.*, and
// codeinsight_rebuild -- it does NOT carry phase.transitioned, dispatch.start/end,
// prd.added/resolved, mutable.added/resolved, instruction.served, or residual.fired/skipped
// in any observed repo (those event classes were seen only inside git.commit summary text,
// never as their own evt: line). This is a real upstream gap, not a parser bug: any project
// whose only live source is this file (the common case -- gm-log is typically empty/absent,
// see replayAll's fallback) will show near-empty Store.sessions()/healthSummary() phase-walk
// and dispatch counts even while its .status.json proves the watcher is alive and busy.
export function replayWatcherLog(fp, cwd) {
  const events = [];
  let text;
  try { text = fs.readFileSync(fp, 'utf8'); } catch { return events; }
  for (const line of text.split('\n')) {
    const m = line.match(EVT_RE);
    if (!m) continue;
    let o;
    try { o = JSON.parse(m[1]); } catch { continue; }
    const sub = o.sub || 'plugkit';
    const ts = normalizeTs(o.ts);
    // cwd is always the discovered file's own project dir, never o.cwd from the log line's
    // JSON body -- trusting log content for attribution would let a crafted watcher.log line
    // claim an arbitrary cwd outside the discovered project registry (security scoping).
    const ev = { ...o, ts, cwd, _sub: sub, _day: ts.slice(0, 10), _fp: fp, _src: 'watcher.log', _schema: EVENT_SCHEMA_VERSION };
    if (!ev.event) ev.event = o.phase || o.action || o.kind || o.type || '?';
    events.push(ev);
  }
  return events;
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

export function replaySpoolFallback(explicit) {
  const events = [];
  for (const { cwd, fp } of discoverSpoolLogs(explicit)) events.push(...replayWatcherLog(fp, cwd));
  return events.sort((a, b) => (a.ts || '') < (b.ts || '') ? -1 : 1);
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

  _line(raw) {
    const m = raw.match(EVT_RE);
    if (!m) return;
    let o;
    try { o = JSON.parse(m[1]); } catch { return; }
    const sub = o.sub || 'plugkit';
    const ts = normalizeTs(o.ts);
    // cwd is always this tailer's own discovered project cwd, never o.cwd from the log
    // line's JSON body -- see replayWatcherLog's identical hardening for the rationale.
    const ev = { ...o, ts, cwd: this.cwd, _sub: sub, _day: ts.slice(0, 10), _fp: this._fp, _src: 'watcher.log', _schema: EVENT_SCHEMA_VERSION };
    if (!ev.event) ev.event = o.phase || o.action || o.kind || o.type || '?';
    this.emit('event', ev);
    this.emit(`sub:${sub}`, ev);
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

export function replayAll(logDir = DEFAULT_LOG_DIR, opts = {}) {
  const events = [];
  if (opts.spool) return replaySpoolFallback(opts.spool);
  if (!fs.existsSync(logDir)) return replaySpoolFallback();
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
  if (!events.length) return replaySpoolFallback();
  return events.sort((a, b) => (a.ts || '') < (b.ts || '') ? -1 : 1);
}
