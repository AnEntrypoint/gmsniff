import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GmLogWatcher, replayAll, SUBSYSTEMS, DEFAULT_LOG_DIR } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUI_DIR = path.join(__dirname, '..', 'gui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

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
    return { total: this.events.length, bySub, byEvent, byDay, pids: pids.size, errors, subsystems: SUBSYSTEMS, observedSubsystems: this.observedSubsystems() };
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

  deviations({ limit = 200, sess } = {}) {
    let arr = this.events.filter(e => typeof e.event === 'string' && e.event.startsWith('deviation.'));
    if (sess) arr = arr.filter(e => e.sess === sess);
    const byKind = {};
    for (const e of arr) byKind[e.event] = (byKind[e.event] || 0) + 1;
    const bySession = {};
    for (const e of arr) {
      const k = e.sess || '(no-session)';
      bySession[k] = (bySession[k] || 0) + 1;
    }
    return {
      total: arr.length,
      byKind,
      bySession,
      recent: arr.slice(-limit).reverse(),
    };
  }

  sessions({ limit = 100 } = {}) {
    const map = new Map();
    for (const e of this.events) {
      const key = e.sess || '(no-session)';
      let entry = map.get(key);
      if (!entry) {
        entry = {
          sess: key,
          first_ts: e.ts || '',
          last_ts: e.ts || '',
          events: 0,
          phases: new Set(),
          phase_walk: [],
          prd_adds: 0,
          prd_resolves: 0,
          mutable_adds: 0,
          mutable_resolves: 0,
          deviations: 0,
          residual_fires: 0,
          residual_skips: 0,
          dispatches: 0,
          last_dispatch_verbs: [],
          cwds: new Set(),
          pids: new Set(),
        };
        map.set(key, entry);
      }
      entry.events++;
      if (e.ts) { if (!entry.first_ts || e.ts < entry.first_ts) entry.first_ts = e.ts; if (e.ts > entry.last_ts) entry.last_ts = e.ts; }
      if (e.cwd) entry.cwds.add(e.cwd);
      if (e.pid) entry.pids.add(e.pid);
      if (e._sub === 'plugkit') {
        if (e.event === 'phase.transitioned' && e.phase) {
          entry.phases.add(e.phase);
          entry.phase_walk.push({ ts: e.ts, phase: e.phase });
        }
        if (e.event === 'instruction.served' && e.phase) entry.phases.add(e.phase);
        if (e.event === 'prd.added') entry.prd_adds++;
        if (e.event === 'prd.resolved') entry.prd_resolves++;
        if (e.event === 'mutable.added') entry.mutable_adds++;
        if (e.event === 'mutable.resolved') entry.mutable_resolves++;
        if (e.event === 'residual.fired') entry.residual_fires++;
        if (e.event === 'residual.skipped') entry.residual_skips++;
        if (e.event === 'dispatch.end') {
          entry.dispatches++;
          if (e.verb) entry.last_dispatch_verbs.push(e.verb);
          if (entry.last_dispatch_verbs.length > 20) entry.last_dispatch_verbs.shift();
        }
      }
      if (typeof e.event === 'string' && e.event.startsWith('deviation.')) entry.deviations++;
    }
    const PHASES = ['PLAN','EXECUTE','EMIT','VERIFY','COMPLETE'];
    const arr = [];
    for (const v of map.values()) {
      const reached = PHASES.map(p => v.phases.has(p));
      arr.push({
        sess: v.sess,
        first_ts: v.first_ts,
        last_ts: v.last_ts,
        events: v.events,
        dispatches: v.dispatches,
        phases_reached: reached,
        phase_walk: v.phase_walk,
        prd_adds: v.prd_adds,
        prd_resolves: v.prd_resolves,
        mutable_adds: v.mutable_adds,
        mutable_resolves: v.mutable_resolves,
        residual_fires: v.residual_fires,
        residual_skips: v.residual_skips,
        deviations: v.deviations,
        last_verbs: v.last_dispatch_verbs,
        cwds: [...v.cwds],
        pids: [...v.pids],
      });
    }
    arr.sort((a,b) => (b.last_ts || '').localeCompare(a.last_ts || ''));
    return { total: arr.length, rows: arr.slice(0, limit) };
  }

  processTree(sess) {
    if (!sess) return { sess: null, nodes: [], gaps: [] };
    const match = sess === '(no-session)' ? '' : sess;
    const evs = this.events.filter(e => (e.sess || '') === match).slice().sort((a,b)=>(a.ts||'').localeCompare(b.ts||''));
    const PHASES = ['PLAN','EXECUTE','EMIT','VERIFY','COMPLETE'];
    const nodes = [];
    const gaps = [];
    let currentPhase = null;
    let firstInstructionSeen = false;
    let firstWrite = null;
    for (const e of evs) {
      if (e._sub === 'plugkit') {
        if (e.event === 'instruction.served') {
          if (!firstInstructionSeen) firstInstructionSeen = true;
          if (e.phase && e.phase !== currentPhase) currentPhase = e.phase;
          nodes.push({ ts: e.ts, kind: 'instruction', phase: e.phase, prd_pending: e.prd_pending, mutables_pending: e.mutables_pending });
        } else if (e.event === 'phase.transitioned') {
          if (e.phase && currentPhase) {
            const fromIdx = PHASES.indexOf(currentPhase);
            const toIdx = PHASES.indexOf(e.phase);
            if (fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx + 1) {
              gaps.push({ ts: e.ts, kind: 'phase-skipped', from: currentPhase, to: e.phase });
            }
          }
          currentPhase = e.phase;
          nodes.push({ ts: e.ts, kind: 'transition', phase: e.phase });
        } else if (e.event === 'prd.added') {
          nodes.push({ ts: e.ts, kind: 'prd-add', id: e.id, phase: currentPhase });
        } else if (e.event === 'prd.resolved') {
          nodes.push({ ts: e.ts, kind: 'prd-resolve', id: e.id, phase: currentPhase });
        } else if (e.event === 'mutable.added') {
          nodes.push({ ts: e.ts, kind: 'mutable-add', id: e.id, phase: currentPhase });
        } else if (e.event === 'mutable.resolved') {
          nodes.push({ ts: e.ts, kind: 'mutable-resolve', id: e.id, phase: currentPhase });
        } else if (e.event === 'residual.fired' || e.event === 'residual.skipped') {
          nodes.push({ ts: e.ts, kind: e.event, reason: e.reason, phase: currentPhase });
        } else if (e.event === 'memorize.fired') {
          nodes.push({ ts: e.ts, kind: 'memorize', key: e.key, phase: currentPhase });
        }
      }
      if (typeof e.event === 'string' && e.event.startsWith('deviation.')) {
        nodes.push({ ts: e.ts, kind: 'deviation', deviation: e.event, reason: e.reason, residuals: e.residuals, phase: currentPhase });
        gaps.push({ ts: e.ts, kind: 'deviation', deviation: e.event });
      }
      if ((e.event === 'dispatch.start' || e.event === 'spawn') && !firstInstructionSeen && !firstWrite) {
        firstWrite = { ts: e.ts, event: e.event, verb: e.verb };
      }
    }
    if (firstWrite && !firstInstructionSeen) {
      gaps.unshift({ ts: firstWrite.ts, kind: 'no-instruction-dispatched', detail: firstWrite });
    }
    return { sess, nodes, gaps, phase_reached: PHASES.map(p => evs.some(e => (e._sub === 'plugkit' && (e.event === 'phase.transitioned' || e.event === 'instruction.served') && e.phase === p))) };
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

  observedSubsystems() {
    const set = new Set();
    for (const e of this.events) if (e._sub) set.add(e._sub);
    return [...set].sort();
  }

  distinctValues(field, { sub, limit = 50 } = {}) {
    const counts = new Map();
    for (const e of this.events) {
      if (sub && e._sub !== sub) continue;
      const v = pickField(e, field);
      if (v === undefined || v === null || v === '') continue;
      const k = typeof v === 'object' ? JSON.stringify(v) : String(v);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([value, count]) => ({ value, count }));
  }

  query(spec) {
    spec = spec || {};
    const filter = spec.filter || {};
    const projection = Array.isArray(spec.projection) ? spec.projection : null;
    const groupBy = Array.isArray(spec.groupBy) ? spec.groupBy : null;
    const sort = Array.isArray(spec.sort) ? spec.sort : [['ts', 'desc']];
    const limit = Math.min(parseInt(spec.limit, 10) || 200, 5000);

    let arr = this.events.filter(e => matchesFilter(e, filter));

    for (const [field, dir] of sort.slice().reverse()) {
      const mul = dir === 'asc' ? 1 : -1;
      arr.sort((a, b) => {
        const av = pickField(a, field);
        const bv = pickField(b, field);
        if (av === bv) return 0;
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        return av < bv ? -1 * mul : 1 * mul;
      });
    }

    const total = arr.length;
    arr = arr.slice(0, limit);

    if (groupBy && groupBy.length) {
      const groups = new Map();
      for (const e of arr) {
        const key = groupBy.map(f => {
          const v = pickField(e, f);
          return v === undefined || v === null ? '∅' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        }).join(' | ');
        let g = groups.get(key);
        if (!g) { g = { key, count: 0, sample: [] }; groups.set(key, g); }
        g.count++;
        if (g.sample.length < 3) g.sample.push(projection ? project(e, projection) : e);
      }
      return {
        total,
        groupBy,
        groups: [...groups.values()].sort((a, b) => b.count - a.count),
      };
    }

    const rows = projection ? arr.map(e => project(e, projection)) : arr;
    return { total, returned: rows.length, rows };
  }
}

function pickField(obj, path) {
  if (!path) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function project(e, fields) {
  const out = {};
  for (const f of fields) {
    const v = pickField(e, f);
    if (v !== undefined) out[f] = v;
  }
  return out;
}

function matchesFilter(e, filter) {
  if (!filter || typeof filter !== 'object') return true;
  if (Array.isArray(filter.and)) return filter.and.every(f => matchesFilter(e, f));
  if (Array.isArray(filter.or)) return filter.or.some(f => matchesFilter(e, f));
  if (filter.not) return !matchesFilter(e, filter.not);
  for (const [key, condition] of Object.entries(filter)) {
    if (['and', 'or', 'not'].includes(key)) continue;
    const v = pickField(e, key);
    if (!matchesCondition(v, condition)) return false;
  }
  return true;
}

function matchesCondition(value, cond) {
  if (cond === null || cond === undefined) return value === cond;
  if (typeof cond === 'string' || typeof cond === 'number' || typeof cond === 'boolean') return value === cond;
  if (Array.isArray(cond)) return cond.includes(value);
  if (typeof cond === 'object') {
    if (cond.eq !== undefined && value !== cond.eq) return false;
    if (cond.ne !== undefined && value === cond.ne) return false;
    if (cond.in && !cond.in.includes(value)) return false;
    if (cond.nin && cond.nin.includes(value)) return false;
    if (cond.gte !== undefined && !(value >= cond.gte)) return false;
    if (cond.gt !== undefined && !(value > cond.gt)) return false;
    if (cond.lte !== undefined && !(value <= cond.lte)) return false;
    if (cond.lt !== undefined && !(value < cond.lt)) return false;
    if (cond.regex) {
      try {
        const re = new RegExp(cond.regex, cond.flags || '');
        if (!re.test(String(value === undefined ? '' : value))) return false;
      } catch (_) { return false; }
    }
    if (cond.contains && !String(value === undefined ? '' : value).includes(cond.contains)) return false;
    if (cond.exists === true && (value === undefined || value === null)) return false;
    if (cond.exists === false && value !== undefined && value !== null) return false;
    return true;
  }
  return false;
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
      if (p === '/api/deviations') return send(res, 200, store.deviations(q));
      if (p === '/api/sessions') return send(res, 200, store.sessions(q));
      if (p === '/api/process-tree') return send(res, 200, store.processTree(q.sess));
      if (p === '/api/observed-subsystems') return send(res, 200, { subsystems: store.observedSubsystems() });
      if (p === '/api/distinct') return send(res, 200, { field: q.field, values: store.distinctValues(q.field, q) });
      if (p === '/api/query') {
        if (req.method === 'GET') {
          let spec = {};
          if (q.q) { try { spec = JSON.parse(q.q); } catch (e) { return send(res, 400, { error: 'q must be valid JSON', detail: e.message }); } }
          return send(res, 200, store.query(spec));
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 65536) { req.destroy(); } });
          req.on('end', () => {
            let spec;
            try { spec = body ? JSON.parse(body) : {}; }
            catch (e) { return send(res, 400, { error: 'body must be JSON', detail: e.message }); }
            try { send(res, 200, store.query(spec)); }
            catch (e) { send(res, 500, { error: String(e?.message || e) }); }
          });
          return;
        }
        return send(res, 405, { error: 'method not allowed' });
      }
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
