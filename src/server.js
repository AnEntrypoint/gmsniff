import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GmLogWatcher, replayAll, SUBSYSTEMS, DEFAULT_LOG_DIR } from './index.js';
import {
  readPrd, readMutables, rewriteRow, atomicWriteFile, discoverProjects, isKnownVerb, isAllowedProjectCwd,
  readWatcherStatus,
} from './registry.js';

const MAX_QUERY_LEN = 4096;
const HEALTH_WINDOW_MS = 15 * 60 * 1000; // rolling deviation-rate window
const HEALTH_STALE_MS = 5 * 60 * 1000; // stale-heartbeat threshold
const CODESEARCH_POLL_MS = 10000;
const CODESEARCH_POLL_INTERVAL_MS = 200;
const VERB_FILE_SHAPE = /^[a-zA-Z0-9-]+$/;
const RESPONSE_FILE_SHAPE = /^[a-zA-Z0-9._-]+\.json$/;

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

// -- rs-tools aggregation: adapted from cli.js's embedFailures/recallMisses/recallScores/
// classifierRejects/memoryLeverage/recallModes, operating on Store's in-memory this.events
// (equivalent to cli.js's replayAll `all` array) filtered to a scoped cwd.
function rsToolsRecallMisses(evs, top = 20) {
  const misses = evs.filter(e => e.event === 'recall' && e.hit === false);
  const byQuery = new Map();
  for (const e of misses) {
    const q = e.query || '?';
    let s = byQuery.get(q);
    if (!s) { s = { query: q, count: 0, last_ts: '' }; byQuery.set(q, s); }
    s.count++;
    if (e.ts && e.ts > s.last_ts) s.last_ts = e.ts;
  }
  return { total: misses.length, byQuery: [...byQuery.values()].sort((a, b) => b.count - a.count).slice(0, top) };
}

function rsToolsRecallScores(evs, bucket = 0.1) {
  const recalls = evs.filter(e => e.event === 'recall');
  const buckets = new Map();
  let noScore = 0;
  for (const e of recalls) {
    let score = e.top_score;
    if (score === undefined && Array.isArray(e.hits) && e.hits[0] && typeof e.hits[0].score === 'number') score = e.hits[0].score;
    if (typeof score !== 'number') { noScore++; continue; }
    const b = Math.floor(score / bucket) * bucket;
    buckets.set(b.toFixed(2), (buckets.get(b.toFixed(2)) || 0) + 1);
  }
  const histogram = [...buckets.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).map(([bucket, count]) => ({ bucket, count }));
  return { total: recalls.length, noScore, histogram };
}

function rsToolsRecallModes(evs) {
  const recalls = evs.filter(e => e.event === 'recall');
  const byMode = new Map();
  for (const e of recalls) {
    const m = e.mode || '(none)';
    byMode.set(m, (byMode.get(m) || 0) + 1);
  }
  const total = recalls.length || 1;
  return { total: recalls.length, modes: [...byMode.entries()].sort((a, b) => b[1] - a[1]).map(([mode, count]) => ({ mode, count, pct: +(count / total * 100).toFixed(1) })) };
}

function rsToolsClassifierRejects(evs, top = 20) {
  const rejects = evs.filter(e => e.event === 'memorize_reject');
  const byReason = new Map();
  for (const e of rejects) byReason.set(e.reason || '?', (byReason.get(e.reason || '?') || 0) + 1);
  const recent = rejects.slice(-10).reverse().map(e => ({ ts: e.ts, reason: e.reason || '?', text_prefix: String(e.text_prefix || e.text || '').slice(0, 80) }));
  return { total: rejects.length, byReason: [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([reason, count]) => ({ reason, count })), recent };
}

function rsToolsMemoryLeverage(evs, days = 7, sess) {
  const cutoff = Date.now() - days * 86400000;
  const filt = e => { const t = e.ts ? Date.parse(e.ts) : 0; return t >= cutoff && (!sess || (e.sess && e.sess.startsWith(sess))); };
  const filtered = evs.filter(filt);
  const bySess = new Map();
  for (const e of filtered) {
    const k = e.sess || '(no-session)';
    let s = bySess.get(k);
    if (!s) { s = { sess: k, memorized: 0, memorized_keys: new Set(), recalled_back: 0 }; bySess.set(k, s); }
    if (e.event === 'memorize_fired' || e.event === 'memorize.fired') {
      s.memorized++;
      if (e.key) s.memorized_keys.add(String(e.key));
    }
  }
  for (const e of filtered) {
    if (e._sub !== 'rs_learn' || e.event !== 'recall') continue;
    const k = e.sess || '(no-session)';
    const s = bySess.get(k);
    if (!s) continue;
    const hitKeys = [];
    if (Array.isArray(e.hits)) for (const h of e.hits) if (h && h.key) hitKeys.push(String(h.key));
    if (e.key) hitKeys.push(String(e.key));
    for (const hk of hitKeys) if (s.memorized_keys.has(hk)) { s.recalled_back++; break; }
  }
  const rows = [...bySess.values()].filter(s => s.memorized || s.recalled_back)
    .sort((a, b) => b.memorized - a.memorized)
    .map(s => ({ sess: s.sess, memorized: s.memorized, recalled_back: s.recalled_back, leveragePct: s.memorized ? +(s.recalled_back / s.memorized * 100).toFixed(1) : 0 }));
  return { days, rows };
}

function rsToolsEmbedFailures(evs) {
  const structured = evs.filter(e => e.event === 'embed_fail' || (e._sub === 'rs_learn' && e.event === 'embed_fail'));
  const byStep = new Map();
  for (const e of structured) {
    const step = e.step || '?';
    let s = byStep.get(step);
    if (!s) { s = { step, count: 0, last_ts: 0 }; byStep.set(step, s); }
    s.count++;
    const tsNum = typeof e.ts === 'number' ? e.ts : (e.ts ? Date.parse(e.ts) : 0);
    if (tsNum && tsNum > s.last_ts) s.last_ts = tsNum;
  }
  return { total: structured.length, byStep: [...byStep.values()].sort((a, b) => b.count - a.count).slice(0, 20) };
}

// -- .codeinsight parser: plain-text digest, header line "NNf NNL NNfn NNcls cxN.N" (may be
// preceded by prose/markdown lines), followed by section headers ("## Title") and content
// lines. Real sample format has no per-file "file:line:name(N)params" body rows in every
// project -- parse defensively: capture the summary line plus each "## " section's raw text,
// stripping any non-ASCII decorative glyphs from labels this endpoint itself produces.
function stripGlyphs(s) {
  return String(s == null ? '' : s).replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, ' ').trim();
}

function parseCodeInsight(text) {
  // CRLF-safe: strip a trailing \r per line up front so every downstream
  // "^...$" regex (section headers, header line) matches on Windows-authored
  // .codeinsight files exactly like it does on LF-only ones -- JS regex `$`
  // (no /m or /s flag) does not match before a bare trailing \r, so without
  // this every section on a CRLF file silently dropped to zero entries.
  const lines = text.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
  const headerRe = /^#\s*(\d+)f\s+([\d.]+)k?L\s+(\d+)fn\s+(\d+)cls\s+cx([\d.]+)/;
  let summary = { files: null, lines: null, functions: null, classes: null, avgComplexity: null };
  let headerLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (m) {
      summary = {
        files: parseInt(m[1], 10),
        lines: Math.round(parseFloat(m[2]) * (/[\d.]+k?L/.test(m[0]) && m[0].includes('kL') ? 1000 : 1)),
        functions: parseInt(m[3], 10),
        classes: parseInt(m[4], 10),
        avgComplexity: parseFloat(m[5]),
      };
      headerLineIdx = i;
      break;
    }
  }
  const entries = [];
  let currentSection = null;
  let sectionLines = [];
  const flush = () => {
    if (currentSection) entries.push({ section: stripGlyphs(currentSection), content: sectionLines.join('\n').trim() });
    sectionLines = [];
  };
  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const secM = line.match(/^##\s*(.+)$/);
    if (secM) {
      flush();
      currentSection = secM[1];
      continue;
    }
    if (currentSection) sectionLines.push(line);
  }
  flush();
  return { summary, entries, items: extractCodeInsightItems(entries, summary) };
}

// -- per-file treemap items: the real .codeinsight digest has no structured per-file
// {name,size,complexity} table -- it is prose sections ("Large files:", "Long funcs:",
// "Complex funcs:") with embedded "path:line:name(NL)" / "path:NNNL" fragments. Extract
// a best-effort per-file size (line count where stated) and a complexity proxy (count of
// complex/long-func mentions for that path, plus avgComplexity fallback) so the GUI can
// render a treemap without fabricating data the format doesn't provide.
function extractCodeInsightItems(entries, summary) {
  const bySection = {};
  for (const e of entries) bySection[e.section] = e.content;
  const sizeOf = new Map();
  const complexityOf = new Map();
  const bump = (name, complexityInc) => {
    if (!name) return;
    complexityOf.set(name, (complexityOf.get(name) || 0) + complexityInc);
  };
  // "Large files:" -- "path:NNNL" comma-separated fragments carry real line counts.
  const largeFiles = bySection['Code Organization'] || bySection['📊 Code Organization'] || '';
  for (const m of largeFiles.matchAll(/([\w./\\-]+\.\w+):(\d+)L/g)) {
    sizeOf.set(m[1], parseInt(m[2], 10));
  }
  // "Long funcs:" / "Complex funcs:" -- "path:line:name(NL)" or "(NNNL)" fragments bump
  // the complexity proxy for that file; each mention counts as one complexity unit.
  const funcSections = [bySection['Code Organization'], bySection['Issues'], bySection['🚨 Issues']].filter(Boolean).join('\n');
  for (const m of funcSections.matchAll(/([\w./\\-]+\.\w+):\d+:[\w$]+\((\d+)[Lp]\)/g)) {
    bump(m[1], 1);
    if (!sizeOf.has(m[1])) sizeOf.set(m[1], parseInt(m[2], 10));
  }
  const names = new Set([...sizeOf.keys(), ...complexityOf.keys()]);
  const fallbackComplexity = summary.avgComplexity ?? 1;
  const items = [...names].map(name => ({
    name,
    size: sizeOf.get(name) || 1,
    complexity: complexityOf.get(name) || fallbackComplexity,
  }));
  items.sort((a, b) => b.size - a.size);
  return items;
}

// -- memory-graph reader: real schema witnessed via Read on anentrypoint-design's disciplines --
// .gm/disciplines/rs-learn_graph_edges/<id>.json holds {id,src,dst,relation,fact,embedding,...},
// .gm/disciplines/rs-learn_graph_edges_by_src|by_dst/<namespace>.json holds a comma-separated
// list of edge ids for that namespace, .gm/disciplines/<namespace>/<key>.json holds the plain
// memorized text (a `default/mem-*.json` file is a bare text file, not JSON-parseable). Nodes
// are derived from the plain-text memory files (key/text/namespace); edges are read from the
// real graph_edges directory when present (never fabricated).
function readMemoryGraph(cwd) {
  const disciplinesDir = path.join(cwd, '.gm', 'disciplines');
  const nodes = [];
  const nodeKeys = new Set();
  let namespaces = [];
  try {
    namespaces = fs.readdirSync(disciplinesDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('rs-learn_graph_edges') && !d.name.endsWith('-vec') && !d.name.endsWith('-manifest') && !d.name.endsWith('_router'))
      .map(d => d.name);
  } catch (_) { return { nodes: [], edges: [], note: 'no .gm/disciplines directory found for this project' }; }

  for (const ns of namespaces) {
    const nsDir = path.join(disciplinesDir, ns);
    let files = [];
    try { files = fs.readdirSync(nsDir); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const key = f.slice(0, -5);
      let text = null;
      try {
        const raw = fs.readFileSync(path.join(nsDir, f), 'utf-8');
        try {
          const parsed = JSON.parse(raw);
          text = typeof parsed === 'string' ? parsed : (parsed.fact || parsed.text || JSON.stringify(parsed).slice(0, 300));
        } catch (_) {
          text = raw; // plain-text memory file, not JSON (real observed shape)
        }
      } catch (_) { continue; }
      if (nodeKeys.has(key)) continue;
      nodeKeys.add(key);
      let stat = null;
      try { stat = fs.statSync(path.join(nsDir, f)); } catch (_) {}
      nodes.push({ key, text: String(text).slice(0, 500), namespace: ns, mtime: stat ? stat.mtimeMs : null });
    }
  }

  const edges = [];
  const edgesDir = path.join(disciplinesDir, 'rs-learn_graph_edges');
  let edgeFiles = [];
  try { edgeFiles = fs.readdirSync(edgesDir); } catch (_) { edgeFiles = []; }
  for (const f of edgeFiles) {
    if (!f.endsWith('.json')) continue;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(edgesDir, f), 'utf-8'));
      edges.push({ id: e.id, src: e.src, dst: e.dst, relation: e.relation, weight: e.weight ?? null, created_at: e.created_at ?? null });
    } catch (_) {}
  }

  if (!edgeFiles.length) {
    return { nodes, edges: [], note: 'no rs-learn_graph_edges discipline directory found; nodes derived from per-namespace memory files, edges unavailable' };
  }
  return { nodes, edges };
}

function listDisciplines(cwd) {
  const dir = path.join(cwd, '.gm', 'disciplines');
  try {
    return fs.readdirSync(dir).map(name => {
      const full = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { return { name, size: null, mtime: null, isDirectory: null }; }
      return { name, size: stat.isDirectory() ? null : stat.size, mtime: stat.mtimeMs, isDirectory: stat.isDirectory() };
    });
  } catch (_) { return []; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUI_DIR = path.join(__dirname, '..', 'gui');
const OWN_ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const MAX_LIFECYCLE_BODY = 65536;

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

  deviations({ limit = 200, sess, sessionId } = {}) {
    const sessFilter = sess || sessionId;
    let arr = this.events.filter(e => typeof e.event === 'string' && e.event.startsWith('deviation.'));
    if (sessFilter) arr = arr.filter(e => e.sess === sessFilter);
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

  processTree(sess, sessionId) {
    sess = sess || sessionId;
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

function readBody(req, maxLen, cb) {
  let body = '';
  let tooLarge = false;
  req.on('data', c => {
    body += c;
    if (body.length > maxLen) { tooLarge = true; req.destroy(); }
  });
  req.on('end', () => { if (!tooLarge) cb(null, body); });
  req.on('aborted', () => { if (tooLarge) cb(new Error('body too large'), null); });
}

// Resolves the effective target cwd for a control endpoint and validates it against the
// discovered project registry (own repo root always allowed). Returns { ok, cwd, error }.
function resolveScopedCwd(store, cwdParam) {
  const cwd = cwdParam || OWN_ROOT;
  if (typeof cwd !== 'string' || cwd.includes('..')) {
    return { ok: false, error: 'invalid cwd' };
  }
  const projects = discoverProjects(store.events);
  const allowed = [OWN_ROOT, ...projects.map(p => p.cwd)];
  if (!isAllowedProjectCwd(cwd, allowed)) {
    return { ok: false, error: 'cwd not in discovered project registry' };
  }
  return { ok: true, cwd };
}

// Turns a project cwd (absolute path) into a filesystem/header-safe slug for use in
// Content-Disposition filenames: last path segment, non [a-zA-Z0-9-_] chars collapsed
// to '-', falls back to 'project' if the result is empty.
function sanitizeProjectName(cwd) {
  const base = String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'project';
  const slug = base.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'project';
}

// Cross-project health summary: reuses discoverProjects (same discovery heuristic backing
// /api/projects), the deviation.* event stream (same source /api/deviations counts) windowed
// to the last HEALTH_WINDOW_MS, readWatcherStatus (same alive-flag /api/projects surfaces),
// and each project's own last-seen event ts for stale-heartbeat detection.
function healthSummary(store) {
  const projects = discoverProjects(store.events);
  const now = Date.now();
  const out = [];
  for (const proj of projects) {
    const cwd = proj.cwd;
    const projEvents = store.events.filter(e => e.cwd === cwd);
    let lastTs = 0;
    let devCountInWindow = 0;
    for (const e of projEvents) {
      const t = typeof e.ts === 'number' ? e.ts : (e.ts ? Date.parse(e.ts) : 0);
      if (!t) continue;
      if (t > lastTs) lastTs = t;
      if (typeof e.event === 'string' && e.event.startsWith('deviation.') && (now - t) <= HEALTH_WINDOW_MS) {
        devCountInWindow++;
      }
    }
    const windowMinutes = HEALTH_WINDOW_MS / 60000;
    const deviationRate = devCountInWindow / windowMinutes;
    const status = readWatcherStatus(cwd);
    const watcherAlive = !!(status && status.alive);
    const staleSeconds = lastTs ? Math.max(0, Math.floor((now - lastTs) / 1000)) : null;
    out.push({
      cwd,
      name: path.basename(cwd),
      deviationRate,
      watcherAlive,
      staleSeconds,
    });
  }
  return out;
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
      if (p === '/api/process-tree') return send(res, 200, store.processTree(q.sess, q.sessionId));
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
      if (p === '/api/projects') {
        return send(res, 200, { projects: discoverProjects(store.events) });
      }
      if (p === '/api/health-summary') {
        return send(res, 200, healthSummary(store));
      }
      if (p === '/api/prd') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        const { mtimeMs, rows } = readPrd(scope.cwd);
        return send(res, 200, { cwd: scope.cwd, mtimeMs, rows });
      }
      if (p === '/api/mutables') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        const { mtimeMs, rows } = readMutables(scope.cwd);
        return send(res, 200, { cwd: scope.cwd, mtimeMs, rows });
      }
      if (p === '/api/export') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        let prdRows = [], mutablesRows = [];
        try { prdRows = readPrd(scope.cwd).rows || []; } catch (_) { prdRows = []; }
        try { mutablesRows = readMutables(scope.cwd).rows || []; } catch (_) { mutablesRows = []; }
        const bundle = {
          snapshot: store.snapshot(),
          sessions: store.sessions({ limit: 20 }),
          deviations: store.deviations(q),
          prd: prdRows,
          mutables: mutablesRows,
          exportedAt: new Date().toISOString(),
          cwd: scope.cwd,
        };
        const slug = sanitizeProjectName(scope.cwd);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `gmsniff-export-${slug}-${ts}.json`;
        const bodyStr = JSON.stringify(bundle);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(bodyStr);
      }
      if (p === '/api/prd/edit' || p === '/api/mutables/edit') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        readBody(req, MAX_LIFECYCLE_BODY, (err, body) => {
          if (err) return send(res, 413, { error: 'body too large' });
          let payload;
          try { payload = body ? JSON.parse(body) : {}; }
          catch (e) { return send(res, 400, { error: 'body must be JSON', detail: e.message }); }
          const { cwd: cwdParam, id, since } = payload;
          if (!id || typeof id !== 'string') return send(res, 400, { error: 'id is required' });
          const scope = resolveScopedCwd(store, cwdParam);
          if (!scope.ok) return send(res, 403, { error: scope.error });
          const isPrd = p === '/api/prd/edit';
          const relPath = isPrd ? path.join(scope.cwd, '.gm', 'prd.yml') : path.join(scope.cwd, '.gm', 'mutables.yml');
          let stat;
          try { stat = fs.statSync(relPath); }
          catch (e) { return send(res, 404, { error: 'file not found', detail: e.message }); }
          if (since !== undefined && since !== null) {
            const sinceMs = Number(since);
            if (Number.isFinite(sinceMs) && Math.abs(stat.mtimeMs - sinceMs) > 1) {
              const current = isPrd ? readPrd(scope.cwd) : readMutables(scope.cwd);
              const currentRow = current.rows.find(r => r.id === id) || null;
              return send(res, 409, { error: 'conflict: file changed since read', mtimeMs: stat.mtimeMs, currentRow });
            }
          }
          const text = fs.readFileSync(relPath, 'utf-8');
          const fields = {};
          if (isPrd) {
            if (payload.status !== undefined) fields.status = payload.status;
            if (payload.text !== undefined) fields.text = payload.text;
          } else {
            if (payload.status !== undefined) fields.status = payload.status;
            if (payload.witness !== undefined) fields.witness_evidence = payload.witness;
          }
          const newText = rewriteRow(text, id, fields);
          if (newText === null) return send(res, 404, { error: `row not found: ${id}` });
          try { atomicWriteFile(relPath, newText); }
          catch (e) { return send(res, 500, { error: String(e?.message || e) }); }
          const result = isPrd ? readPrd(scope.cwd) : readMutables(scope.cwd);
          const updatedRow = result.rows.find(r => r.id === id) || null;
          return send(res, 200, { ok: true, cwd: scope.cwd, id, row: updatedRow, mtimeMs: result.mtimeMs });
        });
        return;
      }
      if (p === '/api/lifecycle') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        readBody(req, MAX_LIFECYCLE_BODY, (err, body) => {
          if (err) return send(res, 413, { error: 'body too large' });
          let payload;
          try { payload = body ? JSON.parse(body) : {}; }
          catch (e) { return send(res, 400, { error: 'body must be JSON', detail: e.message }); }
          const { cwd: cwdParam, verb, payload: verbPayload } = payload;
          if (!isKnownVerb(verb)) return send(res, 400, { error: 'unknown or invalid verb', verb });
          const scope = resolveScopedCwd(store, cwdParam);
          if (!scope.ok) return send(res, 403, { error: scope.error });
          const verbDir = path.join(scope.cwd, '.gm', 'exec-spool', 'in', verb);
          try {
            fs.mkdirSync(verbDir, { recursive: true });
            const file = path.join(verbDir, `${Date.now()}.txt`);
            fs.writeFileSync(file, JSON.stringify(verbPayload || {}), 'utf-8');
            return send(res, 200, { ok: true, cwd: scope.cwd, verb, file });
          } catch (e) {
            return send(res, 500, { error: String(e?.message || e) });
          }
        });
        return;
      }
      if (p === '/api/rs-tools') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        const evs = store.events.filter(e => e.cwd === scope.cwd);
        return send(res, 200, {
          cwd: scope.cwd,
          eventCount: evs.length,
          embedFailures: rsToolsEmbedFailures(evs),
          recallMisses: rsToolsRecallMisses(evs, q.top ? parseInt(q.top, 10) : 20),
          recallScores: rsToolsRecallScores(evs, q.bucket ? parseFloat(q.bucket) : 0.1),
          classifierRejects: rsToolsClassifierRejects(evs, q.top ? parseInt(q.top, 10) : 20),
          memoryLeverage: rsToolsMemoryLeverage(evs, q.days ? parseInt(q.days, 10) : 7, q.sess),
          recallModes: rsToolsRecallModes(evs),
          disciplines: listDisciplines(scope.cwd),
        });
      }
      if (p === '/api/codeinsight') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        const file = path.join(scope.cwd, '.codeinsight');
        let text;
        try { text = fs.readFileSync(file, 'utf-8'); }
        catch (e) { return send(res, 404, { error: '.codeinsight not found for this project', detail: e.message }); }
        return send(res, 200, { cwd: scope.cwd, ...parseCodeInsight(text) });
      }
      if (p === '/api/memory-graph') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        return send(res, 200, { cwd: scope.cwd, ...readMemoryGraph(scope.cwd) });
      }
      if (p === '/api/codesearch') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        readBody(req, MAX_LIFECYCLE_BODY, (err, body) => {
          if (err) return send(res, 413, { error: 'body too large' });
          let payload;
          try { payload = body ? JSON.parse(body) : {}; }
          catch (e) { return send(res, 400, { error: 'body must be JSON', detail: e.message }); }
          const { cwd: cwdParam, query } = payload;
          if (typeof query !== 'string' || !query.length || query.length > MAX_QUERY_LEN) {
            return send(res, 400, { error: 'query is required and must be a non-empty string under 4096 chars' });
          }
          const scope = resolveScopedCwd(store, cwdParam);
          if (!scope.ok) return send(res, 403, { error: scope.error });
          const verbDir = path.join(scope.cwd, '.gm', 'exec-spool', 'in', 'codesearch');
          const outDir = path.join(scope.cwd, '.gm', 'exec-spool', 'out');
          const ts = `${Date.now()}-${randomSuffix()}`;
          let inFile, outFile;
          try {
            fs.mkdirSync(verbDir, { recursive: true });
            inFile = path.join(verbDir, `${ts}.txt`);
            outFile = path.join(outDir, `codesearch-${ts}.json`);
            fs.writeFileSync(inFile, JSON.stringify({ query }), 'utf-8');
          } catch (e) {
            return send(res, 500, { error: String(e?.message || e) });
          }
          const deadline = Date.now() + CODESEARCH_POLL_MS;
          const poll = () => {
            fs.readFile(outFile, 'utf-8', (readErr, raw) => {
              if (!readErr) {
                let parsed;
                try { parsed = JSON.parse(raw); }
                catch (e) { return send(res, 502, { error: 'codesearch response was not valid JSON', detail: e.message }); }
                const hits = parsed?.data?.hits || parsed?.hits || [];
                return send(res, 200, { ok: true, cwd: scope.cwd, query, hits, raw: parsed });
              }
              if (Date.now() >= deadline) {
                return send(res, 504, { error: 'codesearch dispatch timed out', cwd: scope.cwd, query, waited_ms: CODESEARCH_POLL_MS });
              }
              setTimeout(poll, CODESEARCH_POLL_INTERVAL_MS);
            });
          };
          poll();
        });
        return;
      }
      if (p === '/api/browser-sessions') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        const spoolDir = path.join(scope.cwd, '.gm', 'exec-spool');
        const readJsonSafe = (file) => {
          try { return JSON.parse(fs.readFileSync(path.join(spoolDir, file), 'utf-8')); }
          catch (_) { return null; }
        };
        const sessionsRaw = readJsonSafe('browser-sessions.json');
        const portsRaw = readJsonSafe('browser-ports.json');
        return send(res, 200, {
          cwd: scope.cwd,
          sessions: sessionsRaw == null ? [] : sessionsRaw,
          ports: portsRaw == null ? [] : portsRaw,
          sessionsFileFound: sessionsRaw !== null,
          portsFileFound: portsRaw !== null,
        });
      }
      if (p === '/api/lifecycle/response') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        const verb = q.verb;
        const file = q.file;
        if (typeof verb !== 'string' || !VERB_FILE_SHAPE.test(verb)) {
          return send(res, 400, { error: 'invalid verb parameter' });
        }
        if (typeof file !== 'string' || file.includes('..') || file.includes('/') || file.includes('\\') || !RESPONSE_FILE_SHAPE.test(file)) {
          return send(res, 400, { error: 'invalid file parameter' });
        }
        const outDir = path.join(scope.cwd, '.gm', 'exec-spool', 'out');
        const target = path.join(outDir, file);
        if (path.dirname(target) !== path.resolve(outDir)) {
          return send(res, 400, { error: 'invalid file parameter (path escape)' });
        }
        fs.readFile(target, 'utf-8', (err, raw) => {
          if (err) return send(res, 404, { error: 'response file not found', file });
          let parsed;
          try { parsed = JSON.parse(raw); }
          catch (e) { return send(res, 502, { error: 'response file was not valid JSON', detail: e.message }); }
          return send(res, 200, { ok: true, cwd: scope.cwd, verb, file, response: parsed });
        });
        return;
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
