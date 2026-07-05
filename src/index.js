import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

export const SUBSYSTEMS = ['plugkit', 'exec', 'hook', 'rs_learn', 'rs_codeinsight', 'rs_search', 'bootstrap', 'plugkit_wrapper'];
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

export const DEFAULT_LOG_DIR = process.env.GM_LOG_DIR || path.join(os.homedir(), '.gm', 'gm-log');
const DEBOUNCE_MS = 50;

function todayDir() {
  return new Date().toISOString().slice(0, 10);
}

export class GmLogWatcher extends EventEmitter {
  constructor(logDir = DEFAULT_LOG_DIR) {
    super();
    this._dir = logDir;
    this._tails = new Map();
    this._timers = new Map();
    this._watcher = null;
  }

  start() {
    this._scanAll();
    try {
      this._watcher = fs.watch(this._dir, { recursive: true }, (_, f) => {
        if (f && f.endsWith('.jsonl')) this._debounce(path.join(this._dir, f));
      });
      this._watcher.on('error', e => this.emit('error', e));
    } catch (e) { this.emit('error', e); }
    return this;
  }

  stop() {
    if (this._watcher) try { this._watcher.close(); } catch (_) {}
    for (const s of this._tails.values()) if (s.fd !== null) try { fs.closeSync(s.fd); } catch (_) {}
    for (const t of this._timers.values()) clearTimeout(t);
    this._tails.clear(); this._timers.clear();
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
    const ev = { ...obj, ts: normalizeTs(obj.ts), _sub: sub, _day: day, _fp: fp };
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
    const ev = { ...o, ts, cwd: o.cwd || cwd, _sub: sub, _day: ts.slice(0, 10), _fp: fp, _src: 'watcher.log' };
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
              const ev = { ...o, ts: normalizeTs(o.ts), _sub: sub, _day: day };
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
