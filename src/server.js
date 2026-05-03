import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { GmLogWatcher, replayAll, SUBSYSTEMS } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUI_DIR = path.join(__dirname, '..', 'gui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const DEFAULT_LOG_DIR = process.env.GM_LOG_DIR || path.join(os.homedir(), '.claude', 'gm-log');

class Store {
  constructor(logDir) {
    this.logDir = logDir;
    this.events = [];
    this.sseClients = new Set();
    this.watcher = null;
  }

  load() {
    this.events = replayAll(this.logDir);
  }

  startLive() {
    if (this.watcher) return;
    this.watcher = new GmLogWatcher(this.logDir);
    this.watcher.on('event', ev => {
      this.events.push(ev);
      this._broadcast('event', ev);
    });
    this.watcher.on('error', e => this._broadcast('error', { msg: String(e?.message || e) }));
    this.watcher.start();
  }

  stop() {
    if (this.watcher) this.watcher.stop();
    for (const r of this.sseClients) try { r.end(); } catch {}
    this.sseClients.clear();
  }

  _broadcast(kind, data) {
    const payload = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) { try { res.write(payload); } catch {} }
  }

  snapshot() {
    const bySub = {}, byEvent = {}, byDay = {}, pids = new Set();
    let errors = 0;
    for (const e of this.events) {
      bySub[e._sub] = (bySub[e._sub] || 0) + 1;
      byEvent[e.event || '?'] = (byEvent[e.event || '?'] || 0) + 1;
      if (e._day) byDay[e._day] = (byDay[e._day] || 0) + 1;
      if (e.pid) pids.add(e.pid);
      if (e.ok === false || e.err) errors++;
    }
    return { total: this.events.length, bySub, byEvent, byDay, pids: pids.size, errors, subsystems: SUBSYSTEMS };
  }

  subsystem(sub, { limit = 200, offset = 0, event: evFilter, day, q, pid } = {}) {
    let arr = this.events.filter(e => e._sub === sub);
    if (evFilter) arr = arr.filter(e => e.event === evFilter);
    if (day) arr = arr.filter(e => e._day === day);
    if (pid) arr = arr.filter(e => String(e.pid) === String(pid));
    if (q) {
      const lq = q.toLowerCase();
      arr = arr.filter(e => JSON.stringify(e).toLowerCase().includes(lq));
    }
    arr = arr.slice().reverse();
    return { total: arr.length, rows: arr.slice(offset, offset + limit) };
  }

  days() {
    const map = {};
    for (const e of this.events) {
      if (!e._day) continue;
      if (!map[e._day]) map[e._day] = { day: e._day, total: 0, bySub: {} };
      map[e._day].total++;
      map[e._day].bySub[e._sub] = (map[e._day].bySub[e._sub] || 0) + 1;
    }
    return Object.values(map).sort((a, b) => b.day.localeCompare(a.day));
  }

  eventTypes(sub) {
    const map = {};
    const arr = sub ? this.events.filter(e => e._sub === sub) : this.events;
    for (const e of arr) { const k = e.event || '?'; map[k] = (map[k] || 0) + 1; }
    return Object.entries(map).map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count);
  }

  pids(sub) {
    const map = {};
    const arr = sub ? this.events.filter(e => e._sub === sub) : this.events;
    for (const e of arr) {
      if (!e.pid) continue;
      if (!map[e.pid]) map[e.pid] = { pid: e.pid, count: 0, first: e.ts, last: e.ts };
      map[e.pid].count++;
      if (e.ts > map[e.pid].last) map[e.pid].last = e.ts;
    }
    return Object.values(map).sort((a, b) => b.last.localeCompare(a.last));
  }

  recallStats() {
    const evs = this.events.filter(e => e._sub === 'rs_learn' && e.event === 'recall');
    const hits = evs.filter(e => e.hit).length;
    const misses = evs.filter(e => !e.hit).length;
    const avgDur = evs.length ? Math.round(evs.reduce((s, e) => s + (e.dur_ms || 0), 0) / evs.length) : 0;
    const recent = evs.slice(-20).reverse().map(e => ({ ts: e.ts, query: e.query, hit: e.hit, dur_ms: e.dur_ms }));
    return { total: evs.length, hits, misses, hitRate: evs.length ? (hits / evs.length).toFixed(2) : '0', avgDur, recent };
  }

  execStats() {
    const evs = this.events.filter(e => e._sub === 'exec' && e.event === 'spawn');
    const byRuntime = {};
    let errors = 0;
    for (const e of evs) {
      byRuntime[e.runtime || '?'] = (byRuntime[e.runtime || '?'] || 0) + 1;
      if (!e.ok) errors++;
    }
    const recent = evs.slice(-20).reverse().map(e => ({ ts: e.ts, runtime: e.runtime, ok: e.ok, pid: e.pid, cwd: e.cwd, code_len: e.code_len }));
    return { total: evs.length, byRuntime, errors, recent };
  }

  hookStats() {
    const evs = this.events.filter(e => e._sub === 'hook');
    const byEvent = {};
    for (const e of evs) { byEvent[e.event || '?'] = (byEvent[e.event || '?'] || 0) + 1; }
    const recent = evs.slice(-30).reverse().map(e => ({ ts: e.ts, event: e.event, phase: e.phase, pid: e.pid, dur_ms: e.dur_ms }));
    return { total: evs.length, byEvent, recent };
  }

  search(q, { sub, limit = 100 } = {}) {
    if (!q) return [];
    const lq = q.toLowerCase();
    let arr = this.events;
    if (sub) arr = arr.filter(e => e._sub === sub);
    const out = [];
    for (const e of [...arr].reverse()) {
      if (JSON.stringify(e).toLowerCase().includes(lq)) { out.push(e); if (out.length >= limit) break; }
    }
    return out;
  }

  allEvents({ limit = 200, offset = 0, sub, event: evFilter, day, q } = {}) {
    let arr = this.events;
    if (sub) arr = arr.filter(e => e._sub === sub);
    if (evFilter) arr = arr.filter(e => e.event === evFilter);
    if (day) arr = arr.filter(e => e._day === day);
    if (q) { const lq = q.toLowerCase(); arr = arr.filter(e => JSON.stringify(e).toLowerCase().includes(lq)); }
    arr = arr.slice().reverse();
    return { total: arr.length, rows: arr.slice(offset, offset + limit) };
  }
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(GUI_DIR, p);
  if (!file.startsWith(GUI_DIR)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    const ext = path.extname(file);
    send(res, 200, buf, MIME[ext] || 'application/octet-stream');
  });
}

function pq(u) {
  const q = {};
  for (const [k, v] of u.searchParams) q[k] = v;
  if (q.limit) q.limit = parseInt(q.limit, 10);
  if (q.offset) q.offset = parseInt(q.offset, 10);
  return q;
}

export function createServer({ logDir = DEFAULT_LOG_DIR, port = 0, host = '127.0.0.1' } = {}) {
  const store = new Store(logDir);
  store.load();
  store.startLive();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = pq(u);
    const p = u.pathname;
    if (!p.startsWith('/api/')) return serveStatic(req, res);
    try {
      if (p === '/api/snapshot') return send(res, 200, store.snapshot());
      if (p === '/api/days') return send(res, 200, store.days());
      if (p === '/api/events') return send(res, 200, store.allEvents(q));
      if (p === '/api/subsystem') return send(res, 200, store.subsystem(q.sub, q));
      if (p === '/api/event-types') return send(res, 200, store.eventTypes(q.sub));
      if (p === '/api/pids') return send(res, 200, store.pids(q.sub));
      if (p === '/api/recall') return send(res, 200, store.recallStats());
      if (p === '/api/exec') return send(res, 200, store.execStats());
      if (p === '/api/hooks') return send(res, 200, store.hookStats());
      if (p === '/api/search') return send(res, 200, { q: q.q || '', results: store.search(q.q, q) });
      if (p === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        res.write('event: hello\ndata: {}\n\n');
        store.sseClients.add(res);
        req.on('close', () => store.sseClients.delete(res));
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: String(e?.message || e) });
    }
  });

  return new Promise(resolve => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, store, url: `http://${host}:${addr.port}`, port: addr.port, close: () => { store.stop(); return new Promise(r => server.close(r)); } });
    });
  });
}
