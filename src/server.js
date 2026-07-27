import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  GmLogWatcher, MultiProjectWatcher, replayAll, SUBSYSTEMS, DEFAULT_LOG_DIR, EVENT_SCHEMA_VERSION,
  correlationOf, correlationCoverage, GM_TOOLS_DIR, replayAllAudited, sourceStaleness,
} from './index.js';
import { pairDispatches } from './watcher-log.js';
import {
  readPrd, readMutables, rewriteRow, atomicWriteFile, discoverProjects, isKnownVerb, isRetiredVerb, isAllowedProjectCwd,
  readWatcherStatus, VERB_ALLOWLIST, readLivePhaseState, resolveInstructionTier, discoverVendoredSettings,
  readProjectLiveness as registryProjectLiveness, readTurnState, readTurnSummary, readProjectMarkers,
  readDaemonStatus, readInstalledVersions,
} from './registry.js';

const MAX_QUERY_LEN = 4096;
const HEALTH_WINDOW_MS = 15 * 60 * 1000; // rolling deviation-rate window
const CODESEARCH_POLL_MS = 10000;
const CODESEARCH_POLL_INTERVAL_MS = 200;
const VERB_FILE_SHAPE = /^[a-zA-Z0-9-]+$/;
const RESPONSE_FILE_SHAPE = /^[a-zA-Z0-9._-]+\.json$/;

// -- Resource bounds (formal spec Module 5) --
// Store.events is append-only and unbounded by default; at real scale (1.6M+ events observed
// on this machine) the in-memory array alone accounts for the dominant resident set. These
// bounds are enforced on every event push in Store.startLive's event handlers.
const MAX_EVENTS = parseInt(process.env.GM_MAX_EVENTS, 10) || 1_000_000; // hard cap
const EVICT_BATCH = 5000; // evict this many oldest events when the cap is exceeded
const MAX_SSE_CLIENTS = parseInt(process.env.GM_MAX_SSE_CLIENTS, 10) || 50;

// -- Info-flow labels (formal spec Module 4) --
// Every API response carries an X-Info-Label header classifying the sensitivity of the
// returned data. Labels follow the formal spec's InfoLabel type: public (aggregate stats,
// no PII), project-local (scoped to one project), session-local (scoped to one session),
// internal (raw event data, may contain paths/PIDs).
const INFO_LABELS = {
  '/api/capabilities': 'public',
  '/api/snapshot': 'public',
  '/api/days': 'public',
  '/api/events': 'internal',
  '/api/subsystem': 'internal',
  '/api/event-types': 'public',
  '/api/pids': 'internal',
  '/api/recall': 'public',
  '/api/exec': 'public',
  '/api/hooks': 'public',
  '/api/search': 'internal',
  '/api/deviations': 'internal',
  '/api/sessions': 'public',
  '/api/process-tree': 'session-local',
  '/api/observed-subsystems': 'public',
  '/api/distinct': 'public',
  '/api/query': 'internal',
  '/api/projects': 'public',
  '/api/projects/live-state': 'project-local',
  '/api/health-summary': 'public',
  '/api/prd': 'project-local',
  '/api/mutables': 'project-local',
  '/api/export': 'project-local',
  '/api/prd/edit': 'project-local',
  '/api/mutables/edit': 'project-local',
  '/api/lifecycle': 'project-local',
  '/api/rs-tools': 'project-local',
  '/api/codeinsight': 'project-local',
  '/api/memory-graph': 'project-local',
  '/api/codesearch': 'project-local',
  '/api/browser-sessions': 'project-local',
  '/api/lifecycle/response': 'project-local',
  '/api/stream': 'internal',
  '/api/spool-queue': 'public',
  '/api/watcher-versions': 'public',
  '/api/instruction-tiers': 'public',
  '/api/stuck-projects': 'public',
  '/api/throughput': 'public',
  '/api/memory-store-health': 'public',
  '/api/codeinsight-age': 'public',
  '/api/vendored-settings': 'project-local',
  '/api/source': 'public',
  '/api/daemon': 'internal',
  '/api/gates': 'project-local',
  '/api/embed-health': 'public',
  '/api/fsm-graph': 'project-local',
};

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

// Default phase walk. This is a FALLBACK ONLY: .gm/instructions/fsm/graph.json is a real
// per-project override that is live on this machine today (C:/dev/gm), so a project's own graph
// -- not this array -- is authoritative wherever one exists. Single module-level declaration;
// no function-local redeclaration may shadow it.
const PHASES = ['PLAN', 'EXECUTE', 'EMIT', 'VERIFY', 'CONSOLIDATE', 'COMPLETE'];

// Recall/embed telemetry carries two subsystem tags in real data -- `rs_learn` on every
// pre-cutover event and `memory` on current-generation ones. Both are the same event class.
const MEMORY_SUBS = new Set(['memory', 'rs_learn']);
function isMemorySub(sub) { return MEMORY_SUBS.has(sub); }

// gm's runtime-failure vocabulary. None of these events carry `ok:false` or `err`, so the
// snapshot's `errors` counter reads 0 while 23 wasm panics, 9,288 unprocessable spool requests
// and 1,221 failed retention sweeps sit in the same event set (measured across 161 projects,
// 304k events). Counted per name rather than summed into one number: a panic and an EPERM sweep
// are different failures, and `retention.failed` specifically means spool space is never
// reclaimed. `wasm_panic` is the evt record gm's panic hook emits alongside its "WASM PANIC at"
// text line (rs-plugkit wasm_dispatch/events.rs install_panic_hook writes both from one handler);
// the evt record is the structured half and the only one counted, so a panic is not double-counted.
const RUNTIME_FAILURE_EVENTS = new Set([
  'wasm_panic', 'spool.process-error', 'retention.failed', 'turn-state.parse-failed',
  'spool.stale-swept', 'lock.stale-takeover', 'wrapper.drift',
]);

// Real embed/vector failure event names, measured against live watcher.log data. `embed_fail`
// (the name the old filter used) has zero live occurrences.
const EMBED_FAILURE_EVENTS = new Set([
  'embed_init_fail', 'embed_query_failed', 'code_index_slow_file_embed',
  'rssearch_vector_hits_failed', 'rssearch_vectors_write_failed', 'rssearch_vectors_migrate_row_failed',
]);

// -- Silent semantic-search degradation --
// Live data shows embed_query_failed cascading into rssearch_vector_hits_failed on dispatch:
// the vector half of codesearch fails, the query silently falls back to bm25, and the caller
// still receives a success response with hits. Nothing in the response says the semantic half
// was skipped. This returns-success-while-broken class is precisely what an observability tool
// exists to catch, so it is surfaced as an explicit degradation verdict rather than left to be
// inferred from a raw event count.
function embedDegradation(events, cwd = null) {
  const scoped = cwd ? events.filter(e => e.cwd === cwd) : events;
  const byEvent = {};
  let newest = 0;
  const recent = [];
  for (const e of scoped) {
    if (!EMBED_FAILURE_EVENTS.has(e.event)) continue;
    byEvent[e.event] = (byEvent[e.event] || 0) + 1;
    const t = e.ts ? Date.parse(e.ts) : 0;
    if (t > newest) newest = t;
    recent.push({ ts: e.ts, event: e.event, cwd: e.cwd || null, detail: e.detail ?? e.err ?? null });
  }
  const queryFailures = (byEvent.embed_query_failed || 0) + (byEvent.embed_init_fail || 0);
  const vectorFailures = (byEvent.rssearch_vector_hits_failed || 0) + (byEvent.rssearch_vectors_write_failed || 0);
  // Counts and the causal note, not a verdict. A 'severity: ok|partial|silent-degradation' label
  // here would be gmsniff deciding on the reader's behalf where the line between fine and broken
  // sits; the counts and their timestamps let the reader see that for themselves, and a single
  // failure stays visible instead of being rounded down to "ok".
  return {
    byEvent,
    query_failures: queryFailures,
    vector_failures: vectorFailures,
    last_failure_ts: newest ? new Date(newest).toISOString() : null,
    recent: recent.slice(-20).reverse(),
    // Names the causal chain these two counts imply when both are non-zero. This is an
    // observation about how the subsystem fails, not a judgement about whether it is acceptable.
    note: queryFailures > 0 && vectorFailures > 0
      ? 'embedding queries are failing AND vector hits are being dropped: codesearch still returns success but is answering from bm25 only, so semantic results are silently missing'
      : null,
  };
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
    if (!isMemorySub(e._sub) || e.event !== 'recall') continue;
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
  // Real live embed/vector failure events, measured: embed_init_fail, embed_query_failed,
  // rssearch_vector_hits_failed, rssearch_vectors_write_failed,
  // rssearch_vectors_migrate_row_failed, code_index_slow_file_embed. The single `embed_fail`
  // name this filtered on has zero live occurrences.
  const structured = evs.filter(e => EMBED_FAILURE_EVENTS.has(e.event));
  const byStep = new Map();
  for (const e of structured) {
    const step = e.step || '?';
    let s = byStep.get(step);
    if (!s) { s = { step, count: 0, last_ts: 0 }; byStep.set(step, s); }
    s.count++;
    const tsNum = e.ts ? Date.parse(e.ts) : 0;
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

// Total parser: returns {accepted:true, value:{summary,entries,items}} | {accepted:false, reason:String}.
// Never throws — every code path returns a discriminated result. This is the proof-assistant
// invariant "total parser (Accepted A | Rejected R, never exception)" applied to the
// .codeinsight format. Callers match on `.accepted` instead of wrapping in try/catch.
function parseCodeInsight(text) {
  if (typeof text !== 'string' || !text.trim()) return { accepted: false, reason: 'empty or non-string input' };
  try {
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
    if (summary.files === null) return { accepted: false, reason: 'no header line matched in .codeinsight content' };
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
    return { accepted: true, value: { summary, entries, items: extractCodeInsightItems(entries, summary) } };
  } catch (e) {
    return { accepted: false, reason: `parse error: ${e?.message || e}` };
  }
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
// .gm/memories/*.md is the current, converged memory corpus (content-hash-keyed md files with
// a small YAML-ish frontmatter block: key/ns/created/updated) -- .gm/disciplines/default/*.json
// is a legacy mirror that stops receiving writes once a project converts (confirmed live: this
// repo's own .gm/disciplines/default/*.json mtimes freeze at a fixed point while .gm/memories/
// keeps gaining fresh files every session). Reading the frozen mirror silently showed a stale
// snapshot forever; read the real corpus instead. The md corpus has no cross-reference/edge
// convention (no [[wikilink]]-style links observed in any real memory file), so this returns
// nodes only -- an "edges" key would have to be fabricated with no current backing data.
function readMemoryGraph(cwd) {
  const memoriesDir = path.join(cwd, '.gm', 'memories');
  const nodes = [];
  let files = [];
  try { files = fs.readdirSync(memoriesDir).filter(f => f.endsWith('.md')); }
  catch (_) { return { nodes: [], edges: [], note: 'no .gm/memories directory found for this project' }; }

  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(memoriesDir, f), 'utf-8'); } catch (_) { continue; }
    const key = f.slice(0, -3);
    let ns = 'default', created = null, updated = null;
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    let body = raw;
    if (fmMatch) {
      body = fmMatch[2];
      for (const line of fmMatch[1].split(/\r?\n/)) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (!m) continue;
        if (m[1] === 'ns') ns = m[2].trim();
        else if (m[1] === 'created') created = Number(m[2].trim()) || null;
        else if (m[1] === 'updated') updated = Number(m[2].trim()) || null;
      }
    }
    // CRLF-authored memory files (confirmed live: this repo's own .gm/memories/*.md are CRLF)
    // otherwise leave embedded \r bytes in every returned node's text -- normalize the body's
    // own line endings the same way stripGlyphs/parseCodeInsight already does for .codeinsight.
    nodes.push({ key, text: body.replace(/\r\n/g, '\n').trim().slice(0, 500), namespace: ns, mtime: updated || created });
  }
  return { nodes, edges: [], note: nodes.length ? undefined : 'no memory files found in .gm/memories for this project' };
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

// -- Per-project .gm state files --
// Every one of these carries authoritative live truth that no event stream reproduces, and all
// of them were unread before. Paths verified against real on-disk state in every discovered
// project this session. All readers are total: a missing/garbage file yields null, never a throw.
function readJsonFile(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return null; }
}
function readTextFile(fp, max = 8192) {
  try { return fs.readFileSync(fp, 'utf-8').slice(0, max); } catch (_) { return null; }
}
function readNumberFile(fp) {
  const t = readTextFile(fp, 64);
  if (t === null) return null;
  const n = Number(t.trim());
  return Number.isFinite(n) ? n : null;
}
function statMs(fp) {
  try { return fs.statSync(fp).mtimeMs; } catch (_) { return null; }
}

// A marker file's mere presence is the signal; its body (when non-empty) is the verdict --
// .gm/claim-audit-fired really contains "clean" on a passing project, while
// .gm/residual-check-fired is a real zero-byte touch file. Return both so a consumer can tell
// "fired and clean" from "fired, verdict unknown" from "never fired".
function readMarker(fp) {
  const mtime = statMs(fp);
  if (mtime === null) return { fired: false, verdict: null, ts: null };
  const body = (readTextFile(fp, 256) || '').trim();
  return { fired: true, verdict: body || null, ts: Math.round(mtime) };
}

// The eight FSM gates gm-plugkit actually enforces. Only residual-scan-fired was ever modeled.
// Each entry resolves to {gate, state: 'pass'|'fail'|'unknown', detail, ts} from real on-disk
// evidence -- never from a guess. 'unknown' is an honest verdict for a gate whose evidence file
// this project has never produced, and is deliberately NOT collapsed into 'fail'.
const FSM_GATES = [
  'residual-scan-fired', 'prd-all-closed', 'mutables-all-resolved', 'worktree-clean',
  'ci-validated-fresh', 'browser-witness-coverage', 'claim-audit-clean', 'submodules-clean',
];

// The six-phase walk is a DEFAULT, not the model. .gm/instructions/fsm/graph.json is a real
// per-project override that exists on this machine today (C:/dev/gm), and it is what actually
// declares which edges exist and which gates each edge carries -- including that every
// re-plan edge (EXECUTE->PLAN, EMIT->PLAN, VERIFY->PLAN) has an empty `gates` array, while
// VERIFY->CONSOLIDATE carries the real gate list. Read it per-project so gate evaluation and
// phase-walk validity are driven by the project's own graph rather than a hardcode.
function readFsmGraph(cwd) {
  const fp = path.join(cwd, '.gm', 'instructions', 'fsm', 'graph.json');
  const j = readJsonFile(fp);
  if (!j || !Array.isArray(j.states) || !Array.isArray(j.edges)) {
    return { present: false, source: null, phases: PHASES, states: null, edges: null, gatesByEdge: {} };
  }
  const gatesByEdge = {};
  for (const e of j.edges) {
    if (!e || !e.from || !e.to) continue;
    gatesByEdge[`${e.from}->${e.to}`] = Array.isArray(e.gates) ? e.gates : [];
  }
  return {
    present: true,
    source: fp,
    phases: j.states.map(s => s.key).filter(Boolean),
    states: j.states.map(s => ({ key: s.key, prose_key: s.prose_key ?? null, skill: s.skill ?? null })),
    edges: j.edges.map(e => ({ from: e.from, to: e.to, gates: Array.isArray(e.gates) ? e.gates : [] })),
    gatesByEdge,
  };
}

function readFsmGates(cwd, { prd_pending = null, mut_unknown = null, phase = null } = {}) {
  const spool = path.join(cwd, '.gm', 'exec-spool');
  const gm = path.join(cwd, '.gm');
  const residual = readMarker(path.join(gm, 'residual-check-fired'));
  const claim = readMarker(path.join(gm, 'claim-audit-fired'));
  const ciValidated = readJsonFile(path.join(spool, '.ci-validated'));
  const lastGate = readJsonFile(path.join(spool, '.last-gate-fired.json'));
  const repeats = readJsonFile(path.join(spool, '.gate-deviation-repeats.json')) || {};
  const witnessMtime = statMs(path.join(gm, 'witness'));
  const hasSubmodules = statMs(path.join(cwd, '.gitmodules')) !== null;

  const g = (gate, state, detail, ts = null) => ({ gate, state, detail, ts });
  const gates = [
    // .gm/residual-check-fired is a 0-byte touch file on every live project -- existence and
    // mtime ARE the whole signal, an empty body is not missing data.
    g('residual-scan-fired', residual.fired ? 'pass' : 'unknown',
      residual.fired ? 'residual-check-fired marker present (touch file, no body)' : 'no .gm/residual-check-fired marker', residual.ts),
    g('prd-all-closed', prd_pending === null ? 'unknown' : (prd_pending === 0 ? 'pass' : 'fail'),
      prd_pending === null ? 'prd.yml not readable' : `${prd_pending} pending PRD rows`),
    g('mutables-all-resolved', mut_unknown === null ? 'unknown' : (mut_unknown === 0 ? 'pass' : 'fail'),
      mut_unknown === null ? 'mutables.yml not readable' : `${mut_unknown} unresolved mutables`),
    // worktree-clean / submodules-clean are git-state gates: gmsniff is a read-only observer and
    // must not shell out to git on every request, so evidence is limited to what plugkit itself
    // wrote. Absence is reported as unknown rather than fabricated as pass.
    g('worktree-clean', 'unknown', 'git worktree state is not recorded in .gm; not observable read-only'),
    g('ci-validated-fresh', ciValidated && ciValidated.head_sha ? 'pass' : 'unknown',
      ciValidated && ciValidated.head_sha ? `.ci-validated at ${String(ciValidated.head_sha).slice(0, 12)}` : 'no .ci-validated record',
      statMs(path.join(spool, '.ci-validated'))),
    g('browser-witness-coverage', witnessMtime === null ? 'unknown' : 'pass',
      witnessMtime === null ? 'no .gm/witness directory' : '.gm/witness present',
      witnessMtime === null ? null : Math.round(witnessMtime)),
    g('claim-audit-clean',
      !claim.fired ? 'unknown' : (claim.verdict === null || claim.verdict === 'clean' ? 'pass' : 'fail'),
      claim.fired ? `claim-audit-fired verdict: ${claim.verdict || '(empty)'}` : 'no .gm/claim-audit-fired marker',
      claim.ts),
    g('submodules-clean', hasSubmodules ? 'unknown' : 'pass',
      hasSubmodules ? '.gitmodules present; submodule state not observable read-only' : 'no .gitmodules — vacuously clean'),
  ];
  const byGate = new Map(gates.map(x => [x.gate, x]));
  const graph = readFsmGraph(cwd);
  // Which gates actually apply RIGHT NOW is an edge property, not a project property: only the
  // outgoing edges from the current phase can block. Re-plan edges carry no gates at all, so a
  // project sitting at VERIFY with failing gates is still free to go back to PLAN -- reporting
  // it as flatly "blocked" would be wrong.
  const outgoing = [];
  const edges = graph.present ? graph.edges : DEFAULT_EDGES;
  for (const e of edges) {
    if (phase && e.from !== phase) continue;
    const required = e.gates.map(g => byGate.get(g) || { gate: g, state: 'unknown', detail: 'gate not modeled', ts: null });
    const failing = required.filter(g => g.state === 'fail');
    outgoing.push({ from: e.from, to: e.to, gates: required, blocked: failing.length > 0, blockers: failing });
  }
  const currentBlockers = outgoing.filter(e => e.blocked);
  const openEdges = outgoing.filter(e => !e.blocked);
  const lastGateTs = lastGate && Number.isFinite(lastGate.ts) ? lastGate.ts : null;
  return {
    gates,
    // Project-wide failing gates, regardless of whether any current edge requires them.
    blockers: gates.filter(x => x.state === 'fail'),
    // Edge-scoped truth: is the agent actually stuck, and which way can it still go?
    phase,
    fsm_graph: { present: graph.present, source: graph.source, phases: graph.phases },
    outgoing_edges: outgoing,
    blocked: outgoing.length > 0 && openEdges.length === 0,
    open_edges: openEdges.map(e => `${e.from}->${e.to}`),
    blocked_edges: currentBlockers.map(e => ({ edge: `${e.from}->${e.to}`, blockers: e.blockers.map(g => g.gate) })),
    // last-gate-fired is the last-EVER gate firing, not a currently-blocking one: gmsniff's
    // points days back while an active project's is minutes old. Age is always returned so a
    // client never renders a stale marker as a live block.
    last_gate_fired: lastGate && lastGate.key
      ? { key: lastGate.key, ts: lastGateTs, age_ms: lastGateTs ? Date.now() - lastGateTs : null, is_current_block: false }
      : null,
    // `{}` is the NORMAL healthy state here (2 bytes on every live project), not missing data.
    gate_deviation_repeats: repeats,
    gate_deviation_repeat_count: Object.keys(repeats).length,
  };
}

// Fallback edge set when a project has no graph.json override: the linear walk plus the
// gate-free re-plan edges, matching the real graph.json's own shape.
const DEFAULT_EDGES = [
  ...PHASES.slice(0, -1).map((from, i) => ({ from, to: PHASES[i + 1], gates: [] })),
  { from: 'EXECUTE', to: 'PLAN', gates: [] },
  { from: 'EMIT', to: 'PLAN', gates: [] },
  { from: 'VERIFY', to: 'PLAN', gates: [] },
];

// .gm/exec-spool/.codeinsight-digest is the index-freshness record plugkit itself maintains, and
// it was never read -- the codeinsight routes only ever stat'd the repo-root .codeinsight file.
// Real shape (measured): "v3:296bc62dce39fec4:files=28".
function readCodeInsightDigest(cwd) {
  const fp = path.join(cwd, '.gm', 'exec-spool', '.codeinsight-digest');
  const raw = readTextFile(fp, 512);
  if (raw === null) return null;
  const text = raw.trim();
  const m = text.match(/^v(\d+):([0-9a-f]+):files=(\d+)/i);
  const mtime = statMs(fp);
  return {
    raw: text,
    version: m ? Number(m[1]) : null,
    hash: m ? m[2] : null,
    files: m ? Number(m[3]) : null,
    mtimeMs: mtime === null ? null : Math.round(mtime),
    age_ms: mtime === null ? null : Math.round(Date.now() - mtime),
  };
}

// The REAL per-project served plugkit version. .status.json's `version` field is null on every
// agentplug-driven project (the whole current fleet), because the wasm guest updates
// independently of the runner binary. The version is announced in watcher.log's own
// "[plugkit-wasm] plugkit v0.1.824 (wasm)" banner -- the only place it is stated per project.
const WASM_VERSION_RE = /\[plugkit-wasm\][^\n]*plugkit v([0-9][0-9.]*)\s*\(wasm\)/;
const WASM_VERSION_TAIL_BYTES = 256 * 1024;

function readServedVersion(cwd) {
  return cachedPerProject('version', cwd, () => _readServedVersion(cwd));
}

function _readServedVersion(cwd) {
  const fp = path.join(cwd, '.gm', 'exec-spool', '.watcher.log');
  let fd = null;
  try {
    const size = fs.statSync(fp).size;
    fd = fs.openSync(fp, 'r');
    // The banner is re-emitted on every daemon boot, so the newest one is near the tail; reading
    // a bounded tail avoids pulling a 6MB log into memory per request.
    const start = Math.max(0, size - WASM_VERSION_TAIL_BYTES);
    const buf = Buffer.allocUnsafe(size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8', 0, n);
    let version = null;
    for (const line of text.split('\n')) {
      const m = line.match(WASM_VERSION_RE);
      if (m) version = m[1];
    }
    return version ? { version, source: 'watcher.log wasm banner' } : { version: null, source: null };
  } catch (_) {
    return { version: null, source: null };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
  }
}

// Machine-global shared-daemon heartbeat: ~/.gm-tools/daemon-status.json {pid, ts,
// active_projects}. Its ts is observed DAYS stale on this machine while dispatches are actively
// firing -- a real anomaly, so staleness is reported as an explicit boolean rather than left for
// a consumer to notice.
const DAEMON_HEARTBEAT_STALE_MS = parseInt(process.env.GM_DAEMON_STALE_MS, 10) || 10 * 60 * 1000;

function readDaemonStatusGlobal() {
  const fp = path.join(GM_TOOLS_DIR, 'daemon-status.json');
  const j = readJsonFile(fp);
  if (!j) return { present: false, pid: null, ts: null, active_projects: null, age_ms: null, stale: true, alert: null };
  const ts = Number.isFinite(j.ts) ? j.ts : null;
  const age = ts ? Date.now() - ts : null;
  const stale = age === null || age > DAEMON_HEARTBEAT_STALE_MS;
  let pidAlive = null;
  if (j.pid) { try { process.kill(j.pid, 0); pidAlive = true; } catch (_) { pidAlive = false; } }
  const alert = stale
    ? `daemon heartbeat is ${age === null ? 'absent' : Math.round(age / 60000) + 'min'} stale (threshold ${Math.round(DAEMON_HEARTBEAT_STALE_MS / 60000)}min)`
    : null;
  return {
    present: true, pid: j.pid ?? null, pid_alive: pidAlive, ts,
    active_projects: Number.isFinite(j.active_projects) ? j.active_projects : null,
    age_ms: age, stale, stale_threshold_ms: DAEMON_HEARTBEAT_STALE_MS, alert,
  };
}

// -- Per-project liveness --
// registry.readProjectLiveness is authoritative: it derives activity ONLY from signals this
// project's own work writes (watcher.log mtime, turn-summary ts, turn-state ts) and deliberately
// excludes .status.json's ts, which the shared daemon rewrites for every registered project
// every ~200ms and which therefore marks the entire fleet permanently active.
//
// Added here on top of it: the three-way idle-vs-dead classification. Real dispatch ages span
// 143s (actively dispatching) to 173,718s (abandoned ~2 days), and an agent idle between turns
// is healthy -- collapsing idle and abandoned into one boolean is what made stuckProjects'
// highest-severity signal meaningless.
const PROJECT_LIVE_WINDOW_MS = parseInt(process.env.GM_PROJECT_LIVE_WINDOW_MS, 10) || 5 * 60 * 1000;
const PROJECT_ABANDONED_MS = parseInt(process.env.GM_PROJECT_ABANDONED_MS, 10) || 6 * 3600 * 1000;

// Marker/summary reads are ~5ms per project each across 161 projects; both are memoized on the
// same short TTL so a single request pays for each project at most once.
function markersOf(cwd) { return cachedPerProject('markers', cwd, () => readProjectMarkers(cwd)); }
function turnSummaryOf(cwd) { return cachedPerProject('turnsummary', cwd, () => readTurnSummary(cwd)); }
function turnStateOf(cwd) { return cachedPerProject('turnstate', cwd, () => readTurnState(cwd)); }
function phaseStateOf(cwd) { return cachedPerProject('phasestate', cwd, () => readLivePhaseState(cwd)); }
function tierOf(cwd, key) { return cachedPerProject(`tier|${key}`, cwd, () => resolveInstructionTier(cwd, key)); }
function gatesOf(cwd, opts) {
  return cachedPerProject(`gates|${opts.phase}|${opts.prd_pending}|${opts.mut_unknown}`, cwd, () => readFsmGates(cwd, opts));
}

function readProjectLiveness(cwd) {
  return cachedPerProject('liveness', cwd, () => {
    const base = registryProjectLiveness(cwd);
    const markers = markersOf(cwd);
    const now = Date.now();
    const dispatchAge = markers && markers.last_dispatch_ts
      ? Math.max(0, now - markers.last_dispatch_ts)
      : base.last_activity_age_ms;
    const activity = dispatchAge === null ? 'unknown'
      : dispatchAge <= PROJECT_LIVE_WINDOW_MS ? 'dispatching'
      : dispatchAge <= PROJECT_ABANDONED_MS ? 'idle'
      : 'abandoned';
    return {
      ...base,
      alive: base.active,
      activity,
      dispatch_age_ms: dispatchAge,
      live_window_ms: PROJECT_LIVE_WINDOW_MS,
      abandoned_after_ms: PROJECT_ABANDONED_MS,
      last_dispatch_ts: markers ? markers.last_dispatch_ts : null,
      last_instruction_ts: markers ? markers.last_instruction_ts : null,
    };
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUI_DIR = path.join(__dirname, '..', 'gui');
const OWN_ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const MAX_LIFECYCLE_BODY = 65536;

// -- Replay source selection + window bound --
// Measured this session: ~/.claude/gm-log holds 1,131,698 events across 71 day dirs whose
// newest is 2026-07-23, while the live per-project spool holds ~26,866. replayAll only falls
// back to the spool when gm-log is absent or empty, so the default load ingested 42x its own
// weight in dead history and every headline number (/api/snapshot totals, /api/throughput
// rates, /api/days, health-summary deviation rates, stuckProjects severity) was computed
// mostly over events days stale -- with no symptom a user could see.
//
// Default is therefore LIVE SPOOL ONLY. gm-log is reachable only via explicit opt-in
// (GM_INCLUDE_ARCHIVE=1, or ?source=archive|all on the routes that accept it) and is never
// silently blended. Every aggregate route carries provenance so a client renders
// "live spool, N events, window X" rather than an unlabelled total.
const REPLAY_WINDOW_MS = (() => {
  const raw = process.env.GM_REPLAY_WINDOW_MS;
  if (raw === 'all' || raw === '0') return null; // explicit widen-to-everything
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 7 * 86400000;
})();
const INCLUDE_ARCHIVE = process.env.GM_INCLUDE_ARCHIVE === '1';
// A selected source whose newest event is older than this is reported as a first-class warning
// rather than being allowed to look like a normal quiet period.
const SOURCE_STALE_MS = parseInt(process.env.GM_SOURCE_STALE_MS, 10) || 6 * 3600000;
// Inter-event gap for the same cwd that marks a daemon-boot boundary. Real watcher.log spawn
// banners cluster restarts seconds apart within a run; a 10-minute quiet gap is a new run.
const RUN_GAP_MS = parseInt(process.env.GM_RUN_GAP_MS, 10) || 10 * 60 * 1000;

// -- SSE liveness + replay --
// Frames are id-stamped and retained so a reconnecting client replays its gap via Last-Event-ID.
// The heartbeat is a comment frame (":hb ..."), which is valid SSE, is ignored by EventSource's
// message dispatch, and keeps proxies/browsers from silently reaping an idle stream.
const SSE_RING_SIZE = parseInt(process.env.GM_SSE_RING, 10) || 500;
const SSE_HEARTBEAT_MS = parseInt(process.env.GM_SSE_HEARTBEAT_MS, 10) || 15000;
// Output-append frames coalesce briefly so a burst of watcher.log lines becomes one frame per
// cwd instead of one frame per event.
const OUTPUT_COALESCE_MS = parseInt(process.env.GM_SSE_OUTPUT_COALESCE_MS, 10) || 250;
// Output-feed depth. The old hardcoded 30 was applied silently with no payload, no duration and
// no indication that anything sat above it; the cap is now explicit in every response.
const RECENT_EVENTS_LIMIT = parseInt(process.env.GM_RECENT_EVENTS_LIMIT, 10) || 200;
// The list view needs enough output to show what an agent is doing, not its whole history.
const LIST_EVENTS_LIMIT = parseInt(process.env.GM_LIST_EVENTS_LIMIT, 10) || 25;
const INSTRUCTION_PREVIEW_CHARS = parseInt(process.env.GM_INSTRUCTION_PREVIEW_CHARS, 10) || 240;
// .gm YAML row stores reach real size (spoint's prd.yml: 2.1MB / 965 rows, previously parsed and
// serialized whole on every request). Default page keeps the common view cheap; GM_YAML_ROWS_MAX
// bounds what an explicit ?limit= can ask for, so a client cannot re-create the unbounded read.
const YAML_ROWS_LIMIT = parseInt(process.env.GM_YAML_ROWS_LIMIT, 10) || 250;
const YAML_ROWS_MAX = parseInt(process.env.GM_YAML_ROWS_MAX, 10) || 2000;

function hashText(s) {
  if (typeof s !== 'string' || !s) return null;
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

// Per-project filesystem reads are now O(63+ projects) on every request to live-state,
// health-summary, projects, stuck-projects, instruction-tiers and watcher-versions -- measured
// at 1.4MB/4.1s for a single live-state call. These readers are pure functions of on-disk
// state, so a short TTL cache collapses the repeated fan-out within and across requests while
// still reflecting real changes within one poll interval.
// TTL must exceed a single sweep's own duration (measured ~2s of registry reads across 174
// projects), or consecutive requests never hit the cache at all. 5s still reflects a real change
// within one SSE poll interval, and the SSE output-append path means a client no longer depends
// on refetching this route to see new activity.
const PROJECT_CACHE_TTL_MS = parseInt(process.env.GM_PROJECT_CACHE_TTL_MS, 10) || 5000;
const _projectCache = new Map(); // `${fn}|${cwd}` -> {at, value}

// discoverProjects walks 161+ project directories doing real synchronous stat/read work --
// measured at 2.18s per call, and it is invoked by nearly every route (often more than once per
// request). Its result is a pure function of on-disk state, so one short-TTL memo per event-count
// generation collapses the whole fan-out.
let _discoverCache = { at: 0, len: -1, value: null };
function discoverProjectsCached(events) {
  const now = Date.now();
  if (_discoverCache.value && (now - _discoverCache.at) < PROJECT_CACHE_TTL_MS) return _discoverCache.value;
  const value = discoverProjects(events);
  _discoverCache = { at: now, len: events.length, value };
  return value;
}

function cachedPerProject(tag, cwd, fn) {
  const key = `${tag}|${cwd}`;
  const now = Date.now();
  const hit = _projectCache.get(key);
  if (hit && (now - hit.at) < PROJECT_CACHE_TTL_MS) return hit.value;
  const value = fn();
  _projectCache.set(key, { at: now, value });
  if (_projectCache.size > 4000) {
    for (const [k, v] of _projectCache) if ((now - v.at) >= PROJECT_CACHE_TTL_MS) _projectCache.delete(k);
  }
  return value;
}

function sseFrame({ id, kind, data }) {
  return `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Re-plan edges are LEGAL and gate-free (EXECUTE->PLAN, EMIT->PLAN, VERIFY->PLAN). A linear
// PHASES.indexOf comparison treats every forward re-walk after a re-plan as a skipped phase and
// emits a false `phase-skipped` gap; it also loses the re-plan itself from the walk.
function isReplanEdge(from, to) {
  return to === 'PLAN' && from !== null && from !== 'PLAN';
}

// Single per-event node classifier, shared by _processTreeFromEvents (whole-walk reconstruction)
// and _emitOutputAppend (incremental SSE frames) so the node shape can never drift between the
// initial live-state fetch and the frames a client appends to it.
function classifyOutputNode(e) {
  if (!e || typeof e.event !== 'string') return null;
  const base = { ts: e.ts, cwd: e.cwd || null, run: e._run || null };
  if (e.event.startsWith('deviation.')) {
    return { ...base, kind: 'deviation', deviation: e.event, detail: e.detail ?? e.reason ?? null, source: e.source ?? null, sub: e._sub ?? null };
  }
  if (e._sub !== 'plugkit') return null;
  switch (e.event) {
    // instruction.served really carries prd_pending_count/mutables_pending_count -- the
    // prd_pending/mutables_pending names read before were undefined on every live event.
    case 'instruction.served':
      return { ...base, kind: 'instruction', phase: e.phase ?? null,
        prd_pending_count: e.prd_pending_count ?? null, mutables_pending_count: e.mutables_pending_count ?? null };
    case 'phase.transitioned':
      return { ...base, kind: 'transition', phase: e.phase ?? null, from: e.from ?? null, replan: isReplanEdge(e.from ?? null, e.phase ?? null) };
    // The `[dispatch] <-` completion TEXT line is richer than the dispatch.end evt record: it
    // carries `out=<n>b` response bytes alongside ms=. watcher-log.js already parses both, and
    // this node dropped out_bytes on the floor -- so "how long did it take" was observable while
    // "how much did it produce" was not, for the exact same event. task is carried too so a node
    // can be paired back to its `[dispatch] ->` start.
    // `inflight: true` (not a distinct kind) is what gui/live-agents.js normalizeStreamEvent
    // already emits for dispatch.start, so a seeded row and a streamed row render identically.
    case 'dispatch.start':
      return { ...base, kind: 'dispatch', verb: e.verb ?? null, task: e.task ?? null, body_bytes: e.body_bytes ?? null, inflight: true };
    case 'dispatch.end':
      return { ...base, kind: 'dispatch', verb: e.verb ?? null, task: e.task ?? null, ms: e.ms ?? null, out_bytes: e.out_bytes ?? null };
    case 'prd.added': return { ...base, kind: 'prd-add', id: e.id ?? null, rescoped: e.rescoped ?? null };
    case 'prd.resolved': return { ...base, kind: 'prd-resolve', id: e.id ?? null };
    case 'mutable.added': return { ...base, kind: 'mutable-add', id: e.id ?? null };
    case 'mutable.resolved': return { ...base, kind: 'mutable-resolve', id: e.id ?? null };
    case 'memorize.fired':
    case 'memorize_fired': return { ...base, kind: 'memorize', key: e.key ?? null };
    default: return null;
  }
}

class Store {
  // explicitLogDir: the caller named a specific tree (createServer({logDir}) or GM_LOG_DIR).
  // That request must win over automatic spool discovery -- see load().
  constructor(logDir, { explicitLogDir = false } = {}) {
    this.logDir = logDir;
    this.explicitLogDir = explicitLogDir;
    this.events = [];
    this.sseClients = new Set();
    this.watcher = null;
    this.fanout = null;
    this.watchedProjects = [];
    this._evictedCount = 0; // cumulative evicted events since boot
    this._evictedBatches = 0; // number of eviction passes
    this._sseSeq = 0;
    this._sseRing = [];
    this._outputPending = new Map();
    this._outputFlushTimer = null;
    this._heartbeatTimer = null;
    this._lastLiveTs = new Map(); // cwd -> last live event ts (ms), for _run continuity
    this._liveRun = new Map(); // cwd -> current daemon-boot epoch id
    this.source = { selected: 'none', include_archive: false, window_ms: REPLAY_WINDOW_MS, live_total: 0 };
  }

  // Single live-ingest path for both watchers: assigns the daemon-boot epoch the same way
  // _tagRunEpochs does for replayed history (so a live event's _run matches the run its replayed
  // siblings carry), stores it, broadcasts the raw frame, and queues the incremental
  // output-append frame that lets a client grow its feed without refetching.
  _ingestLive(ev) {
    if (ev && ev.cwd) {
      const t = ev.ts ? Date.parse(ev.ts) : 0;
      const prev = this._lastLiveTs.get(ev.cwd);
      if (t) {
        if (prev === undefined || (t - prev) > RUN_GAP_MS) this._liveRun.set(ev.cwd, ev.ts);
        this._lastLiveTs.set(ev.cwd, t);
      }
      ev._run = this._liveRun.get(ev.cwd) || null;
    }
    this._pushWithBound(ev);
    this._broadcast('event', ev);
    this._emitOutputAppend(ev);
  }

  // Enforces the MAX_EVENTS resource bound (formal spec Module 5). Called on every event
  // push. When the cap is exceeded, evicts the oldest EVICT_BATCH events from the head of
  // the array — keeping the most recent events and preserving the append-only semantics
  // for the tail while bounding total memory.
  _pushWithBound(ev) {
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, EVICT_BATCH);
      this._evictedCount += EVICT_BATCH;
      this._evictedBatches++;
      this._snapshotCache = null; // invalidate: total count changed
    }
  }

  // Live spool is the ONLY default source. `includeArchive` blends the legacy gm-log tree in,
  // and is off unless explicitly requested. `windowMs` bounds how far back the replay reaches
  // (watcher.log reaches 6.1MB/81k lines per project, so an unbounded boot read is real cost);
  // null means no bound. Both are recorded on this.source so every route can report provenance.
  // Source selection is delegated entirely to replayAllAudited, which already encodes the rule
  // that an EXPLICITLY-REQUESTED source wins over automatic discovery: opts.spool pins one
  // project, an explicit GM_LOG_DIR (or archive:true) selects the archive, and only an
  // unqualified call falls through to fleet-wide spool discovery. Reimplementing selection here
  // is what broke the explicit-logDir contract -- a server scoped to a temp dir silently loaded
  // the whole machine's fleet instead, taking test isolation with it.
  load({ includeArchive = INCLUDE_ARCHIVE, windowMs = REPLAY_WINDOW_MS, spool } = {}) {
    const opts = {};
    if (spool !== undefined) opts.spool = spool;
    else if (this.explicitLogDir) opts.archive = true;
    else if (includeArchive) opts.archive = true;
    const audited = replayAllAudited(this.logDir, opts);

    const cutoffIso = windowMs ? new Date(Date.now() - windowMs).toISOString() : null;
    const kept = cutoffIso ? audited.events.filter(e => !e.ts || e.ts >= cutoffIso) : audited.events;
    this.events = kept;
    this._tagRunEpochs();
    this.source = {
      selected: audited.source,
      archive_used: audited.archive_used,
      // ONE fact, stated once: did the operator name a source tree? True only for GM_LOG_DIR or a
      // genuinely non-default path (see createServer). `sources.gm_log.explicit` reports the
      // narrower env-var-only half of the same fact; previously this flag also counted our own
      // CLI's resolved default, so the two disagreed about one directory and neither was
      // trustworthy. `explicit_reason` names which input made it explicit so no reader has to
      // infer it from two booleans.
      explicit_log_dir: !!this.explicitLogDir,
      explicit_reason: this.explicitLogDir
        ? (process.env.GM_LOG_DIR ? 'GM_LOG_DIR' : 'caller-supplied non-default logDir')
        : null,
      log_dir: this.logDir,
      include_archive: !!(opts.archive),
      window_ms: windowMs,
      window_start: cutoffIso,
      total_before_window: audited.events.length,
      total_in_window: kept.length,
      sources: audited.sources,
      warnings: audited.warnings || [],
      // Which population the counts describe, so a client never has to guess why one surface
      // reports a different project total than another.
      population: opts.spool ? 'single explicitly-scoped project'
        : audited.archive_used ? 'legacy gm-log archive tree'
        : 'every project with a discoverable .gm/exec-spool/.watcher.log',
      project_count: (audited.projects || []).length,
      projects: audited.projects || [],
      stats: audited.stats || null,
      loaded_at: new Date().toISOString(),
    };
    this._snapshotCache = null;
  }

  // Assigns each event a daemon-boot epoch (`_run`), the correlation identity correlation.js
  // ranks third and the only one covering 100% of live events. watcher.log carries real
  // "--- watcher|daemon|supervisor spawn <iso> ---" banners, but those lines are not events, so
  // the epoch is reconstructed per-cwd from inter-event gaps: a jump larger than
  // RUN_GAP_MS between consecutive events for the same project is a boot boundary. The run id
  // is the ISO ts of that run's first event, which is stable across reloads.
  _tagRunEpochs() {
    const lastTsByCwd = new Map();
    const runByCwd = new Map();
    for (const e of this.events) {
      if (!e.cwd) continue;
      const t = e.ts ? Date.parse(e.ts) : 0;
      if (!t) { e._run = runByCwd.get(e.cwd) || null; continue; }
      const prev = lastTsByCwd.get(e.cwd);
      if (prev === undefined || (t - prev) > RUN_GAP_MS) runByCwd.set(e.cwd, e.ts);
      lastTsByCwd.set(e.cwd, t);
      e._run = runByCwd.get(e.cwd);
    }
    // Hand the epoch state to the live path so the first event after boot continues the run its
    // replayed predecessors belong to instead of opening a spurious new one.
    this._lastLiveTs = lastTsByCwd;
    this._liveRun = runByCwd;
  }

  // How stale the selected source is, as a first-class warning rather than a silent zero.
  // Per-project parse rows and their totals live on this.source for /api/parse-health; they are
  // dropped here because sourceHealth is embedded in several large payloads (live-state, snapshot)
  // where a 161-project array would dominate the response.
  sourceHealth() {
    let newest = 0;
    for (let i = this.events.length - 1; i >= 0 && i > this.events.length - 500; i--) {
      const t = this.events[i].ts ? Date.parse(this.events[i].ts) : 0;
      if (t > newest) newest = t;
    }
    const age = newest ? Date.now() - newest : null;
    const stale = age === null || age > SOURCE_STALE_MS;
    const { projects: _perProjectParseRows, stats: _parseTotals, ...sourceWithoutParseDetail } = this.source;
    return {
      ...sourceWithoutParseDetail,
      event_count: this.events.length,
      newest_event_ts: newest ? new Date(newest).toISOString() : null,
      newest_age_ms: age,
      stale,
      stale_threshold_ms: SOURCE_STALE_MS,
      warning: stale
        ? (this.events.length === 0
          ? 'selected source produced ZERO events — the live spool may be undiscovered'
          : `selected source's newest event is ${age === null ? 'undated' : Math.round(age / 3600000) + 'h'} old`)
        : null,
    };
  }

  // Live coverage is two concurrent sources merged into the same broadcast/events array,
  // each cwd-tagged: (1) the central ~/.gm/gm-log tree (single machine-wide GmLogWatcher,
  // present when a central log aggregates events), and (2) a MultiProjectWatcher fanning
  // out across every project discoverSpoolLogs finds (one tailer per project's
  // .gm/exec-spool/.watcher.log), which is the live path this environment actually uses
  // since gm-log is typically absent/empty and replayAll falls back to per-project logs.
  // Running both concurrently means a project is observed the moment either source carries
  // its events, and dynamic project appearance/disappearance (fanout side) needs no restart.
  startLive() {
    if (this.watcher || this.fanout) return;
    // The legacy central log is only tailed when the archive source was explicitly opted into;
    // otherwise a live gm-log write would reintroduce exactly the stale blending load() avoids.
    if (this.source.include_archive || this.explicitLogDir) {
      this.watcher = new GmLogWatcher(this.logDir);
      this.watcher.on('event', ev => {
        this._ingestLive(ev);
      });
      this.watcher.on('error', e => this._broadcast('error', { msg: String(e?.message || e) }));
      this.watcher.start();
    }

    // Fleet-wide spool fanout is the DEFAULT, not an override: a server explicitly scoped to one
    // log tree stays scoped to it, so a temp-dir-scoped server (every test) observes only its own
    // events rather than the whole machine's 260k-event fleet.
    // Store.load()'s replay has already delivered every line currently on disk, so the fanout's
    // first sync seeks each existing project's tailer to EOF instead of re-reading from offset 0.
    // Projects discovered on a LATER sync still get their full history.
    this.fanout = new MultiProjectWatcher({ replayHasConsumedExistingContent: true });
    this.fanout.on('event', ev => {
      this._ingestLive(ev);
    });
    this.fanout.on('error', e => this._broadcast('error', { msg: String(e?.message || e), cwd: e?.cwd }));
    this.fanout.on('project.added', p => { this.watchedProjects = this.fanout.projects(); this._broadcast('project.added', p); });
    this.fanout.on('project.removed', p => { this.watchedProjects = this.fanout.projects(); this._broadcast('project.removed', p); });
    this.fanout.start();
    this.watchedProjects = this.fanout.projects();

    // Live-witnessed this session: the fanout's own event stream tails each project's
    // .gm/exec-spool/.watcher.log, a legacy per-project JS-wrapper log format the current
    // shared agentplug daemon never writes to -- so an fanout.on('event')-triggered recheck
    // never fires for any current-generation project (confirmed: gm root shows watching:true
    // in the fanout's own registry, yet its .watcher.log tail is stale by hours while real
    // dispatch activity is happening). next-step.md's own mtime is the reliable signal instead
    // (rs-plugkit writes it directly on every genuine phase/instruction change, independent of
    // the legacy log), so this polls it directly rather than piggybacking on a broken proxy.
    // readLivePhaseState's own mtime-gated cache means each tick is a cheap statSync per
    // project in the common no-change case -- polling here, push to the client via SSE.
    this._lastPhaseSig = new Map(); // cwd -> `${phase}|${instruction_heading}|${updated_ts}`
    // Skip the tick body entirely when nobody is listening: discoverProjects (real synchronous
    // statSync/readFileSync per discovered project) has no reason to run just to broadcast to
    // zero SSE clients -- live-witnessed this session as a real contributor to the event loop
    // getting starved under a populated multi-project log even with the GUI closed.
    this._phasePollTimer = setInterval(() => {
      if (this.sseClients.size === 0) return;
      for (const cwd of discoverProjectsCached(this.events).map(p => p.cwd)) {
        this._maybeBroadcastPhaseChange(cwd);
      }
    }, 2500);
    this._phasePollTimer.unref?.();

    // Heartbeat: an SSE comment frame on a fixed interval. Without it an idle stream is
    // indistinguishable from a dead one to both the client and any intermediary, and a silently
    // reaped connection produced no reconnect and no visible error.
    this._heartbeatTimer = setInterval(() => {
      if (this.sseClients.size === 0) return;
      const hb = `: hb ${Date.now()} seq=${this._sseSeq}\n\n`;
      for (const res of this.sseClients) { try { res.write(hb); } catch {} }
    }, SSE_HEARTBEAT_MS);
    this._heartbeatTimer.unref?.();
  }

  // async: both watcher.stop() and fanout.stop() now return Promises that resolve only
  // after libuv has actually finished closing every fs.watch handle (not merely requested
  // it) -- callers awaiting Store.stop() before process.exit() avoid the Windows
  // UV_HANDLE_CLOSING race that an immediate exit after a synchronous stop() could hit.
  async stop() {
    if (this._phasePollTimer) { clearInterval(this._phasePollTimer); this._phasePollTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._outputFlushTimer) { clearTimeout(this._outputFlushTimer); this._outputFlushTimer = null; }
    if (this.watcher) await this.watcher.stop();
    if (this.fanout) await this.fanout.stop();
    this.watcher = null;
    this.fanout = null;
    this.watchedProjects = [];
    for (const r of this.sseClients) try { r.end(); } catch {}
    this.sseClients.clear();
  }

  // Every broadcast frame carries a monotonic id and is retained in a bounded ring buffer, so a
  // client reconnecting with Last-Event-ID replays exactly the frames it missed instead of
  // silently losing the gap. Frames are emitted with SSE's own `id:` field, which browsers echo
  // back automatically in the Last-Event-ID request header.
  _broadcast(kind, data) {
    const id = ++this._sseSeq;
    const frame = { id, kind, data };
    this._sseRing.push(frame);
    if (this._sseRing.length > SSE_RING_SIZE) this._sseRing.splice(0, this._sseRing.length - SSE_RING_SIZE);
    const payload = sseFrame(frame);
    for (const res of this.sseClients) { try { res.write(payload); } catch {} }
    return id;
  }

  // Frames strictly newer than lastId, or null when the requested id has already been evicted
  // from the ring (the client must do a full refetch -- reported honestly rather than served a
  // partial replay that would look complete).
  replaySince(lastId) {
    if (!Number.isFinite(lastId)) return { frames: [], gap: false, from: null, to: this._sseSeq };
    const oldest = this._sseRing.length ? this._sseRing[0].id : this._sseSeq + 1;
    if (lastId + 1 < oldest) return { frames: [], gap: true, from: lastId, to: this._sseSeq };
    return { frames: this._sseRing.filter(f => f.id > lastId), gap: false, from: lastId, to: this._sseSeq };
  }

  // -- incremental per-agent output --
  // Every SSE frame previously forced the client to refetch the whole of
  // /api/projects/live-state to learn what an agent had produced. This emits the newly-appended
  // output nodes for one cwd, already classified into the same node shape live-state's
  // recent_events uses, so a client APPENDS instead of refetching. Per-cwd high-water mark is
  // the node's ts, so a reconnect + replay never double-appends.
  _emitOutputAppend(ev) {
    if (!ev || !ev.cwd) return;
    const node = classifyOutputNode(ev);
    if (!node) return;
    const cwd = ev.cwd;
    let buf = this._outputPending.get(cwd);
    if (!buf) { buf = []; this._outputPending.set(cwd, buf); }
    buf.push(node);
    if (this._outputFlushTimer) return;
    this._outputFlushTimer = setTimeout(() => {
      this._outputFlushTimer = null;
      for (const [c, nodes] of this._outputPending) {
        if (!nodes.length) continue;
        this._broadcast('agent.output', {
          cwd: c,
          run: nodes[nodes.length - 1].run || null,
          nodes,
          since_ts: nodes[0].ts || null,
          until_ts: nodes[nodes.length - 1].ts || null,
        });
      }
      this._outputPending.clear();
    }, OUTPUT_COALESCE_MS);
    this._outputFlushTimer.unref?.();
  }

  // Re-reads a project's live phase state (mtime-gated, so this is a cheap statSync in the
  // common no-change case) and broadcasts 'project.phase-changed' only when the phase,
  // instruction heading, or updated_ts genuinely differ from the last-seen signature for that
  // cwd -- avoids flooding SSE clients with a frame per raw watcher.log line when the actual
  // served instruction hasn't moved.
  _maybeBroadcastPhaseChange(cwd) {
    let phaseState, tier;
    try {
      phaseState = readLivePhaseState(cwd);
      const key = phaseState.instruction_heading ? phaseState.instruction_heading.toLowerCase().replace('update-docs', 'update_docs') : null;
      tier = phaseState.present ? resolveInstructionTier(cwd, key) : { tier: 'default', file_path: null, source_repo: null };
    } catch (_) { return; }
    const sig = `${phaseState.phase}|${phaseState.instruction_heading}|${phaseState.updated_ts}`;
    if (this._lastPhaseSig.get(cwd) === sig) return;
    this._lastPhaseSig.set(cwd, sig);
    this._broadcast('project.phase-changed', {
      cwd, phase: phaseState.phase, skill: phaseState.skill,
      instruction_heading: phaseState.instruction_heading,
      instruction_excerpt: phaseState.instruction_excerpt,
      instruction_tier: tier.tier, instruction_source_file: tier.file_path, instruction_source_repo: tier.source_repo,
      instruction_auto_provisioned: !!tier.auto_provisioned,
      updated_ts: phaseState.updated_ts, stale: phaseState.stale,
    });
  }

  snapshot() {
    // events is append-only, so this aggregate is immutable for a given
    // length. The Dashboard (default panel) hits this on every load and every
    // SSE-driven overview re-render; measured 8.7s TTFB at 1.6M events when
    // recomputed each call. Same length-keyed pattern as registry.js's
    // _cwdSetCache.
    if (this._snapshotCache && this._snapshotCache.len === this.events.length) return this._snapshotCache.value;
    const bySub = {}, byEvent = {}, byDay = {}, pids = new Set();
    let errors = 0;
    const runtimeFailures = {};
    let runtimeFailuresTotal = 0;
    for (const e of this.events) {
      bySub[e._sub] = (bySub[e._sub] || 0) + 1;
      byEvent[e.event || '?'] = (byEvent[e.event || '?'] || 0) + 1;
      if (e._day) byDay[e._day] = (byDay[e._day] || 0) + 1;
      if (e.pid) pids.add(e.pid);
      if (e.ok === false || e.err) errors++;
      if (RUNTIME_FAILURE_EVENTS.has(e.event)) {
        runtimeFailures[e.event] = (runtimeFailures[e.event] || 0) + 1;
        runtimeFailuresTotal++;
      }
    }
    const observed = this.observedSubsystems();
    const value = {
      total: this.events.length, bySub, byEvent, byDay, pids: pids.size, errors,
      runtimeFailures, runtimeFailuresTotal,
      // Advertise what real data actually carries. The hardcoded seed named `bootstrap` and
      // `rs_learn`, both with zero events in this window, so a client rendering `subsystems`
      // showed tags that could never populate. The seed is still reported, separately labelled,
      // so a genuinely-new-but-empty tag is not invisible either.
      subsystems: observed,
      seededSubsystems: SUBSYSTEMS,
      observedSubsystems: observed,
      evictedCount: this._evictedCount, evictedBatches: this._evictedBatches, maxEvents: MAX_EVENTS,
      // Provenance + window bound: a total is meaningless without which source produced it and
      // how far back it reaches.
      source: this.sourceHealth(),
      schemaVersion: EVENT_SCHEMA_VERSION,
    };
    this._snapshotCache = { len: this.events.length, value };
    return value;
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

  // Recall telemetry lives under BOTH subsystem tags in real data: 666 events tagged `rs_learn`
  // (every pre-cutover recall in log history) and 88 tagged `memory` (recall.rs, the current
  // tag). Filtering on `memory` alone returned all zeros while 753 real recall events sat in the
  // store. The tag is what drifted; the event class did not.
  recallStats() {
    const evs = this.events.filter(e => isMemorySub(e._sub) && e.event === 'recall');
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

  deviations({ limit = 200, sess, sessionId, cwd } = {}) {
    const sessFilter = sess || sessionId;
    let arr = this.events.filter(e => typeof e.event === 'string' && e.event.startsWith('deviation.'));
    if (sessFilter) arr = arr.filter(e => correlationOf(e).key === sessFilter);
    if (cwd) {
      const norm = String(cwd).replace(/\\/g, '/').toLowerCase();
      arr = arr.filter(e => !!e.cwd && String(e.cwd).replace(/\\/g, '/').toLowerCase() === norm);
    }
    const byKind = {};
    const bySession = {}; // keyed on the real correlation key, not the absent `sess` field
    const byCwd = {};
    for (const e of arr) {
      byKind[e.event] = (byKind[e.event] || 0) + 1;
      bySession[correlationOf(e).key] = (bySession[correlationOf(e).key] || 0) + 1;
      if (e.cwd) byCwd[e.cwd] = (byCwd[e.cwd] || 0) + 1;
    }
    return {
      total: arr.length,
      byKind,
      bySession,
      byCwd,
      correlation: correlationCoverage(arr),
      recent: arr.slice(-limit).reverse(),
    };
  }

  // Grouped by the real correlation identity (see _buildCwdActivityIndex). Every row reports
  // `correlation_kind` so the caller can label the grouping honestly -- on live data every row
  // is kind 'run' (cwd + daemon-boot epoch), not a true agent session.
  sessions({ limit = 100 } = {}) {
    const map = new Map();
    for (const e of this.events) {
      const c = correlationOf(e);
      const key = c.key;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          sess: key,
          correlation_kind: c.kind,
          run: c.run || null,
          first_ts: e.ts || '',
          last_ts: e.ts || '',
          events: 0,
          phases: new Set(),
          phase_walk: [],
          replans: 0,
          prd_adds: 0,
          prd_resolves: 0,
          mutable_adds: 0,
          mutable_resolves: 0,
          deviations: 0,
          dispatches: 0,
          dispatch_ms_total: 0,
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
          const from = e.from ?? (entry.phase_walk.length ? entry.phase_walk[entry.phase_walk.length - 1].phase : null);
          const replan = isReplanEdge(from, e.phase);
          if (replan) entry.replans++;
          entry.phase_walk.push({ ts: e.ts, phase: e.phase, from, replan });
        }
        if (e.event === 'instruction.served' && e.phase) entry.phases.add(e.phase);
        if (e.event === 'prd.added') entry.prd_adds++;
        if (e.event === 'prd.resolved') entry.prd_resolves++;
        if (e.event === 'mutable.added') entry.mutable_adds++;
        if (e.event === 'mutable.resolved') entry.mutable_resolves++;
        if (e.event === 'dispatch.end') {
          entry.dispatches++;
          if (Number.isFinite(e.ms)) entry.dispatch_ms_total += e.ms;
          if (e.verb) entry.last_dispatch_verbs.push({ verb: e.verb, ms: e.ms ?? null, ts: e.ts });
          if (entry.last_dispatch_verbs.length > 20) entry.last_dispatch_verbs.shift();
        }
      }
      if (typeof e.event === 'string' && e.event.startsWith('deviation.')) entry.deviations++;
    }
    const arr = [];
    for (const v of map.values()) {
      // Authoritative visited SET, not index math: a re-planned walk genuinely revisits phases,
      // and an index-based "furthest reached" understates it (a session that re-planned shows 2
      // reached where index math gives 1).
      const reached = PHASES.map(p => v.phases.has(p));
      arr.push({
        sess: v.sess,
        correlation_kind: v.correlation_kind,
        run: v.run,
        phases_visited: [...v.phases],
        replans: v.replans,
        dispatch_ms_total: v.dispatch_ms_total,
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
        deviations: v.deviations,
        last_verbs: v.last_dispatch_verbs,
        cwds: [...v.cwds],
        pids: [...v.pids],
      });
    }
    arr.sort((a,b) => (b.last_ts || '').localeCompare(a.last_ts || ''));
    return { total: arr.length, rows: arr.slice(0, limit) };
  }

  // Accepts a correlation key (what sessions() now returns) or a raw cwd -- a caller holding a
  // project path should not have to know the epoch to see that project's walk.
  processTree(sess, sessionId) {
    const key = sess || sessionId;
    if (!key) return { sess: null, nodes: [], gaps: [], phase_walk: [], phase_reached: PHASES.map(() => false) };
    const normKey = String(key).replace(/\\/g, '/').toLowerCase();
    const evs = this.events
      .filter(e => {
        const c = correlationOf(e);
        if (c.key === key) return true;
        // cwd-only match: every run of that project.
        return !!e.cwd && String(e.cwd).replace(/\\/g, '/').toLowerCase() === normKey;
      })
      .slice().sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    return this._processTreeFromEvents(key, evs);
  }

  // Node-classification core shared by processTree (filters this.events fresh, for the
  // Process Tree/Conversation History panels' explicit single-session queries) and
  // recentEventsForCwd (reads from the pre-built _buildCwdActivityIndex, for the Skill Layout
  // multi-project sweep) -- one implementation of the instruction/transition/prd/mutable/
  // deviation node shape, never two copies to keep in sync. `evs` must already be this
  // session's events in chronological order.
  _processTreeFromEvents(sess, evs) {
    const nodes = [];
    const gaps = [];
    const phaseWalk = [];
    let currentPhase = null;
    let firstInstructionSeen = false;
    let firstWrite = null;
    for (const e of evs) {
      const node = classifyOutputNode(e);
      if (node) {
        if (node.kind === 'transition') {
          // `from` is emitted by plugkit on every real phase.transitioned event; trusting it
          // instead of a stateful currentPhase is what makes a re-plan visible at all.
          const from = node.from ?? currentPhase;
          if (node.replan || isReplanEdge(from, node.phase)) {
            phaseWalk.push({ ts: e.ts, phase: node.phase, from, replan: true });
          } else {
            const fromIdx = PHASES.indexOf(from);
            const toIdx = PHASES.indexOf(node.phase);
            // A forward jump is only a real skip when it is not a re-walk after a re-plan --
            // after PLAN, every forward step is legal regardless of how far the prior walk got.
            if (from && fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx + 1) {
              gaps.push({ ts: e.ts, kind: 'phase-skipped', from, to: node.phase });
            }
            phaseWalk.push({ ts: e.ts, phase: node.phase, from, replan: false });
          }
          currentPhase = node.phase;
        } else if (node.kind === 'instruction') {
          firstInstructionSeen = true;
          if (node.phase && node.phase !== currentPhase) currentPhase = node.phase;
        }
        if (node.kind === 'deviation') gaps.push({ ts: e.ts, kind: 'deviation', deviation: node.deviation, detail: node.detail });
        nodes.push(node.kind === 'transition' || node.kind === 'instruction' ? node : { ...node, phase: node.phase ?? currentPhase });
      }
      if ((e.event === 'dispatch.start' || e.event === 'spawn') && !firstInstructionSeen && !firstWrite) {
        firstWrite = { ts: e.ts, event: e.event, verb: e.verb };
      }
    }
    if (firstWrite && !firstInstructionSeen) {
      gaps.unshift({ ts: firstWrite.ts, kind: 'no-instruction-dispatched', detail: firstWrite });
    }
    const reachedSet = new Set(phaseWalk.map(w => w.phase));
    for (const e of evs) if (e._sub === 'plugkit' && e.event === 'instruction.served' && e.phase) reachedSet.add(e.phase);
    return {
      sess, nodes, gaps,
      phase_walk: phaseWalk,
      replans: phaseWalk.filter(w => w.replan).length,
      phase_reached: PHASES.map(p => reachedSet.has(p)),
    };
  }

  // Builds { cwdKey -> latestSess, sess -> events[] } in ONE pass over this.events, for
  // recentEventsForCwdBatch below. /api/projects/live-state calls that once per request and
  // reuses the index across every discovered project -- the naive per-project O(events) scan
  // this replaced (git-blame: recentEventsForCwd) made a single live-state request O(projects *
  // events), which on a real multi-project multi-million-event log measurably blocked the
  // single-threaded event loop long enough to starve every other connection (SSE clients
  // included) for the duration -- live-witnessed as the local GUI server going fully
  // unresponsive under a real browser tab + the 2.5s phase-poll timer during this session.
  // Keyed on the real correlation identity, NOT on `sess`. Live watcher.log events carry no
  // `sess` field at all (zero occurrences across every discovered project), so the prior
  // `if (!e.sess) continue` short-circuited on 100% of live events and left recent_events empty
  // for every real project. correlationOf ranks sess > session_id > cwd#run > cwd and reports
  // which one it used, so a consumer knows whether it is grouped by agent session or by daemon
  // run rather than being told a fidelity the data does not have.
  _buildCwdActivityIndex() {
    const latestByCwd = new Map(); // normalized cwd -> {key, kind, ts}
    const eventsByKey = new Map(); // correlation key -> events[] (chronological)
    for (const e of this.events) {
      const c = correlationOf(e);
      if (c.key === '(none)') continue;
      let arr = eventsByKey.get(c.key);
      if (!arr) { arr = []; eventsByKey.set(c.key, arr); }
      arr.push(e);
      if (!e.cwd) continue;
      const norm = String(e.cwd).replace(/\\/g, '/').toLowerCase();
      const cur = latestByCwd.get(norm);
      if (!cur || (e.ts && e.ts > cur.ts)) latestByCwd.set(norm, { key: c.key, kind: c.kind, run: c.run, ts: e.ts || '' });
    }
    return { latestByCwd, eventsByKey };
  }

  // Recent activity for one project's most-recently-active session, for the Skill Layout
  // drilldown's output-alongside-instruction view: reuses processTree's own per-event node
  // classification (instruction/transition/prd-add/prd-resolve/mutable-add/mutable-resolve/
  // deviation) via processTreeFromEvents below, scoped to whichever session last touched this
  // cwd per the shared index, capped to the most recent `limit` nodes (newest first). Callers
  // build the index once (_buildCwdActivityIndex) and pass it in -- never re-scans this.events.
  recentEventsForCwd(cwd, index, limit = RECENT_EVENTS_LIMIT) {
    const empty = { sess: null, correlation_key: null, correlation_kind: null, run: null, nodes: [], total: 0, limit, truncated: false, more_above: 0 };
    if (!cwd) return empty;
    const norm = String(cwd).replace(/\\/g, '/').toLowerCase();
    const best = index.latestByCwd.get(norm);
    if (!best) return empty;
    const evs = index.eventsByKey.get(best.key) || [];
    const { nodes } = this._processTreeFromEvents(best.key, evs);
    const shown = nodes.slice(-limit).reverse();
    return {
      // `sess` retains its historical name for existing consumers, but it now carries the real
      // correlation key -- correlation_kind says what that key actually is.
      sess: best.key,
      correlation_key: best.key,
      correlation_kind: best.kind,
      run: best.run || null,
      nodes: shown,
      total: nodes.length,
      limit,
      truncated: nodes.length > shown.length,
      more_above: Math.max(0, nodes.length - shown.length),
    };
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

function send(res, code, body, type = 'application/json', reqPath = null) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' };
  if (reqPath && INFO_LABELS[reqPath]) {
    headers['X-Info-Label'] = INFO_LABELS[reqPath];
  }
  res.writeHead(code, headers);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Route-scoped send that captures the request path for info-flow labelling.
function routeSend(res, p, code, body, type = 'application/json') {
  return send(res, code, body, type, p);
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
  const projects = discoverProjectsCached(store.events);
  const allowed = [OWN_ROOT, ...projects.map(p => p.cwd)];
  if (!isAllowedProjectCwd(cwd, allowed)) {
    return { ok: false, error: 'cwd not in discovered project registry' };
  }
  return { ok: true, cwd };
}

// Bounded, honestly-degrading read of a .gm YAML row store (prd.yml / mutables.yml).
//
// Two real failures this fixes, both measured on live data:
//
// 1. COST. C:/dev/spoint's prd.yml is 2.1MB / 965 rows and was parsed AND serialized in full on
//    every request (555KB response). Rows are now capped at YAML_ROWS_LIMIT with `total`,
//    `returned`, `truncated` and `offset` reported, so a caller paging a huge store knows it is
//    seeing a window rather than silently receiving a partial list as if it were the whole one.
//    `file_bytes`/`parse_ms` make the cost visible instead of inferred.
//
// 2. HONEST ABSENCE. readPrd returns {mtimeMs: null, rows: []} for BOTH "no prd.yml exists"
//    (C:/dev/gm has none) and "prd.yml exists and is empty" -- indistinguishable to a client, so
//    a missing store rendered as a satisfied one. `present` is stat-derived and separates them.
function yamlRowsPayload(cwd, filename, reader, q) {
  const t0 = Date.now();
  // present/bytes come from the reader, which already stats the file to distinguish an ABSENT
  // store from an empty one. Re-stat'ing here was a second, independent read of the same fact
  // that could disagree with the reader's under concurrent writes.
  let mtimeMs = null, all = [], error = null, present = false, fileBytes = null;
  try {
    const r = reader(cwd);
    mtimeMs = r.mtimeMs; all = r.rows || []; present = !!r.present; fileBytes = r.bytes ?? null;
  } catch (e) { error = String(e?.message || e); }
  const parseMs = Date.now() - t0;
  const offset = Number.isFinite(q?.offset) && q.offset > 0 ? q.offset : 0;
  const limit = Number.isFinite(q?.limit) && q.limit > 0
    ? Math.min(q.limit, YAML_ROWS_MAX) : YAML_ROWS_LIMIT;
  const rows = all.slice(offset, offset + limit);
  return {
    cwd, file: `.gm/${filename}`,
    // The distinction a client cannot otherwise make: absent store vs empty store.
    present, file_bytes: fileBytes, parse_ms: parseMs, error,
    mtimeMs, rows,
    total: all.length, returned: rows.length, offset, limit,
    truncated: offset + rows.length < all.length,
  };
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
  const projects = discoverProjectsCached(store.events);
  const now = Date.now();
  // Single O(events) pass building a per-cwd {lastTs, devCountInWindow} accumulator, instead
  // of the prior O(events * projects) shape (store.events.filter(e => e.cwd === cwd) run once
  // per discovered project) -- at real scale (60k+ events, multiple discovered projects) the
  // filter-per-project loop measured as the dominant cost behind observed GUI jank under a
  // real event backlog (health-summary request latency and knock-on main-thread stalls),
  // since this same aggregation re-runs on every refreshDeviationBadge poll (10s interval,
  // gui/app.js:365) for every connected client.
  const byCwd = new Map();
  for (const proj of projects) byCwd.set(proj.cwd, { lastTs: 0, devCountInWindow: 0 });
  for (const e of store.events) {
    const acc = byCwd.get(e.cwd);
    if (!acc) continue;
    // ts is always an ISO string after normalizeTs -- the numeric branch this used to carry was
    // unreachable.
    const t = e.ts ? Date.parse(e.ts) : 0;
    if (!t) continue;
    if (t > acc.lastTs) acc.lastTs = t;
    if (typeof e.event === 'string' && e.event.startsWith('deviation.') && (now - t) <= HEALTH_WINDOW_MS) {
      acc.devCountInWindow++;
    }
  }
  const windowMinutes = HEALTH_WINDOW_MS / 60000;
  const out = [];
  for (const proj of projects) {
    const cwd = proj.cwd;
    const acc = byCwd.get(cwd);
    const deviationRate = acc.devCountInWindow / windowMinutes;
    // watcherAlive was the shared-daemon pid check, identical for every project on the machine.
    // Real per-project liveness replaces it; the daemon pid remains available, clearly labelled.
    const liveness = readProjectLiveness(cwd);
    const staleSeconds = acc.lastTs ? Math.max(0, Math.floor((now - acc.lastTs) / 1000)) : null;
    out.push({
      cwd,
      name: path.basename(cwd),
      deviationRate,
      watcherAlive: liveness.alive,
      activity: liveness.activity,
      idleMs: liveness.idle_ms,
      dispatchAgeMs: liveness.dispatch_age_ms,
      daemonPidAlive: liveness.daemon_pid_alive,
      daemonShared: liveness.daemon_shared,
      staleSeconds,
    });
  }
  return out;
}

// -- Stuck-project detection (formal spec Module 8 extension) --
// Scans all discovered projects and flags: stale phase (>N min unchanged), dead watcher,
// growing PRD backlog (pending > threshold), and high deviation rate. Returns a ranked list
// Reports the measurements an operator triages on, for EVERY project, with no verdict attached.
//
// This deliberately carries no thresholds, no severity weights and no filtering. The previous
// shape decided that 15min was "stale", 10 rows a "backlog" and 5 deviations/min "high", summed
// invented weights into a severity score, and then omitted every project that scored zero -- so
// an issue the thresholds did not anticipate was not merely unranked, it was invisible, and a
// project one minute under a cutoff looked identical to a healthy one. Ranking is the reader's
// job (or the client's, which can sort on any field here); gmsniff's job is to report what it
// observed and how old each observation is, so the numbers themselves make the issue findable.
function projectSignals(store) {
  const projects = discoverProjectsCached(store.events);
  const now = Date.now();
  const healthByCwd = new Map(healthSummary(store).map(h => [h.cwd, h]));
  return projects.map(proj => {
    const hr = healthByCwd.get(proj.cwd);
    const phaseState = readLivePhaseState(proj.cwd);
    const liveness = readProjectLiveness(proj.cwd);
    const gateState = readFsmGates(proj.cwd, {
      prd_pending: proj.prd_pending ?? null,
      mut_unknown: proj.mut_unknown ?? null,
      phase: phaseState.phase,
    });
    return {
      cwd: proj.cwd,
      name: path.basename(proj.cwd),
      phase: phaseState.present ? phaseState.phase : null,
      phase_present: phaseState.present,
      phase_age_ms: phaseState.updated_ts ? now - phaseState.updated_ts : null,
      activity: liveness.activity,
      dispatch_age_ms: liveness.dispatch_age_ms ?? null,
      last_activity_age_ms: liveness.last_activity_age_ms ?? null,
      event_age_ms: hr && hr.staleSeconds != null ? Math.round(hr.staleSeconds * 1000) : null,
      deviation_rate_per_min: hr ? hr.deviationRate : null,
      prd_pending: proj.prd_pending ?? null,
      prd_total: proj.prd_total ?? null,
      mut_unknown: proj.mut_unknown ?? null,
      mut_total: proj.mut_total ?? null,
      queue_depth: proj.queue_depth ?? null,
      gates_failing: gateState.failing || [],
      gates_blocked_edges: gateState.blocked_edges || [],
      every_edge_gate_blocked: !!gateState.blocked,
    };
  });
}

// -- Event throughput metrics (formal spec Module 8 extension) --
// Computes ingestion rate over configurable windows (1m, 5m, 15m, 1h, 24h) plus a per-subsystem
// breakdown for the most recent window. Single O(events) pass, same pattern as healthSummary.
function throughputMetrics(store) {
  const now = Date.now();
  const windows = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '24h': 86_400_000 };
  const counts = {};
  const bySub = {};
  for (const key of Object.keys(windows)) { counts[key] = 0; bySub[key] = {}; }
  let total = 0;
  for (const e of store.events) {
    const t = e.ts ? Date.parse(e.ts) : 0; // ts is ISO after normalizeTs
    if (!t) continue;
    total++;
    for (const [key, ms] of Object.entries(windows)) {
      if (now - t <= ms) {
        counts[key]++;
        bySub[key][e._sub] = (bySub[key][e._sub] || 0) + 1;
      }
    }
  }
  const rates = {};
  for (const [key, ms] of Object.entries(windows)) {
    const minutes = ms / 60_000;
    rates[key] = { count: counts[key], perMinute: +(counts[key] / minutes).toFixed(1), bySub: bySub[key] };
  }
  return { total, rates, schemaVersion: EVENT_SCHEMA_VERSION };
}

// -- Memory store health (formal spec Module 8, item 3) --
// .gm/gm.db is the REAL store and it is large: measured 174.9MB (gm), 28.6MB (spoint), 19.8MB
// (casey), 18.8MB (gmsniff). .gm/rs-learn.db, which this used to stat, exists only in C:/dev/gm
// as a 434KB fossil and nowhere else -- so this route reported null for every current project
// while the actual multi-hundred-megabyte store went unwatched. Both are reported now, with
// rs_learn_db_size explicitly labelled as the legacy fossil.
//
// out/ retention pressure is measured in the same sweep: the spool sweeper only removes entries
// older than an hour, and real backlogs are substantial (3,845 files / 19.9MB in gm).
function memoryStoreHealth(store) {
  const projects = discoverProjectsCached(store.events);
  const out = [];
  for (const proj of projects) {
    const memoriesDir = path.join(proj.cwd, '.gm', 'memories');
    let memoriesCount = 0, memoriesSize = 0;
    try {
      for (const f of fs.readdirSync(memoriesDir)) {
        if (!f.endsWith('.md')) continue;
        try { const s = fs.statSync(path.join(memoriesDir, f)); memoriesCount++; memoriesSize += s.size; } catch (_) {}
      }
    } catch (_) {}
    const sizeOf = fp => { try { return fs.statSync(fp).size; } catch (_) { return null; } };
    const dbSize = sizeOf(path.join(proj.cwd, '.gm', 'gm.db'));
    const legacyDbSize = sizeOf(path.join(proj.cwd, '.gm', 'rs-learn.db'));
    const outDir = outDirPressure(proj.cwd);
    const totalSize = memoriesSize + (dbSize || 0) + (legacyDbSize || 0);
    if (memoriesCount || dbSize !== null || legacyDbSize !== null || outDir.files) {
      out.push({
        cwd: proj.cwd, name: path.basename(proj.cwd),
        memoriesCount, memoriesSize,
        dbSize, dbPath: '.gm/gm.db',
        rs_learn_db_size: legacyDbSize, // legacy fossil, present only where it was never cleaned up
        out_dir: outDir,
        totalSize,
      });
    }
  }
  out.sort((a, b) => b.totalSize - a.totalSize);
  return { projects: out, schemaVersion: EVENT_SCHEMA_VERSION };
}

// Spool out/ backlog: the sweeper only removes entries older than an hour, so a busy project
// accumulates thousands of response files. Reported per-project so the pressure is visible.
function outDirPressure(cwd) {
  const dir = path.join(cwd, '.gm', 'exec-spool', 'out');
  let files = 0, bytes = 0, oldest = null, newest = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        const s = fs.statSync(path.join(dir, f));
        if (!s.isFile()) continue;
        files++; bytes += s.size;
        if (oldest === null || s.mtimeMs < oldest) oldest = s.mtimeMs;
        if (newest === null || s.mtimeMs > newest) newest = s.mtimeMs;
      } catch (_) {}
    }
  } catch (_) { return { files: 0, bytes: 0, oldest_ms: null, newest_ms: null, oldest_age_ms: null }; }
  return {
    files, bytes,
    oldest_ms: oldest === null ? null : Math.round(oldest),
    newest_ms: newest === null ? null : Math.round(newest),
    oldest_age_ms: oldest === null ? null : Math.round(Date.now() - oldest),
  };
}

// -- CodeInsight age (formal spec Module 8, item 4) --
// Reads .codeinsight mtime for each discovered project, returning staleness (seconds since
// last update) and a ranked list. A stale codeinsight means the index is out of date.
function codeInsightAge(store) {
  const projects = discoverProjectsCached(store.events);
  const now = Date.now();
  const out = [];
  for (const proj of projects) {
    const ciPath = path.join(proj.cwd, '.codeinsight');
    let mtimeMs = null, ageSeconds = null, summary = null;
    try {
      const stat = fs.statSync(ciPath);
      mtimeMs = stat.mtimeMs;
      ageSeconds = Math.max(0, Math.floor((now - stat.mtimeMs) / 1000));
      const text = fs.readFileSync(ciPath, 'utf-8');
      const parsed = parseCodeInsight(text);
      if (parsed.accepted) summary = parsed.value.summary;
    } catch (_) {}
    const digest = readCodeInsightDigest(proj.cwd);
    if (mtimeMs !== null || digest) {
      out.push({ cwd: proj.cwd, name: path.basename(proj.cwd), mtimeMs, ageSeconds, summary, digest });
    }
  }
  out.sort((a, b) => b.ageSeconds - a.ageSeconds);
  return { projects: out, schemaVersion: EVENT_SCHEMA_VERSION };
}

// Declarative route manifest -- single source of truth served by GET /api/capabilities so an
// agentic HTTP caller (or the GUI) can introspect every route/method/param/response-shape
// without hardcoding route knowledge duplicated from this file. Kept directly above the
// handler it describes so a route added/changed in createServer's dispatch chain below is
// reviewed in the same diff hunk as its manifest entry -- proximity is the drift guard, since
// this array is documentation of the handler rather than code the handler is generated from.
const API_ROUTES = [
  { path: '/api/capabilities', method: 'GET', params: [], response: '{routes: API_ROUTES, verbAllowlist, subsystems}' },
  { path: '/api/snapshot', method: 'GET', params: [], response: '{total, bySub, byEvent, byDay, pids, errors, runtimeFailures, runtimeFailuresTotal, subsystems, observedSubsystems}. `errors` counts events carrying ok:false/err and reads 0 on real data; gm\'s runtime failures carry neither flag, so runtimeFailures breaks them out BY NAME (wasm_panic, spool.process-error, retention.failed, turn-state.parse-failed, spool.stale-swept, lock.stale-takeover, wrapper.drift). Kept per-name, not summed into a severity: a wasm panic and an EPERM retention sweep are different failures, and retention.failed specifically means spool space is never reclaimed. Every name is independently queryable via /api/events?event=<name>.' },
  { path: '/api/days', method: 'GET', params: [], response: '[{day, total, bySub}]' },
  { path: '/api/events', method: 'GET', params: ['limit', 'offset', 'sub', 'event', 'day', 'q'], response: '{total, rows}' },
  { path: '/api/subsystem', method: 'GET', params: ['sub', 'limit', 'offset', 'event', 'day', 'q', 'pid'], response: '{total, rows}' },
  { path: '/api/event-types', method: 'GET', params: ['sub'], response: '[{event, count}]' },
  { path: '/api/pids', method: 'GET', params: ['sub'], response: '[{pid, count, first, last}]' },
  { path: '/api/recall', method: 'GET', params: [], response: '{total, hits, misses, hitRate, avgDur, recent}' },
  { path: '/api/exec', method: 'GET', params: [], response: '{total, byRuntime, errors, recent}' },
  { path: '/api/hooks', method: 'GET', params: [], response: '{total, byEvent, recent}' },
  { path: '/api/search', method: 'GET', params: ['q', 'sub', 'limit'], response: '{q, results}' },
  { path: '/api/deviations', method: 'GET', params: ['sess', 'sessionId', 'limit'], response: '{total, byKind, bySession, recent}' },
  { path: '/api/sessions', method: 'GET', params: ['limit'], response: '{total, rows}' },
  { path: '/api/process-tree', method: 'GET', params: ['sess', 'sessionId'], response: '{sess, nodes, gaps, phase_reached}' },
  { path: '/api/observed-subsystems', method: 'GET', params: [], response: '{subsystems}' },
  { path: '/api/distinct', method: 'GET', params: ['field', 'sub', 'limit'], response: '{field, values: [{value, count}]}' },
  { path: '/api/query', method: 'GET', params: ['q (JSON-encoded query spec)'], response: '{total, groupBy?, groups?} or {total, returned, rows}' },
  { path: '/api/query', method: 'POST', params: ['body: {filter, projection, groupBy, sort, limit}'], response: '{total, groupBy?, groups?} or {total, returned, rows}' },
  { path: '/api/projects', method: 'GET', params: [], response: '{projects: [{cwd, alive, version, prd_pending, prd_total, mut_unknown, mut_total, watching}]}' },
  { path: '/api/health-summary', method: 'GET', params: [], response: '[{cwd, name, deviationRate, watcherAlive, staleSeconds}]' },
  { path: '/api/prd', method: 'GET', params: ['cwd', 'limit', 'offset'], response: '{cwd, file, present, file_bytes, parse_ms, error, mtimeMs, rows, total, returned, offset, limit, truncated}. `present` is stat-derived and distinguishes NO prd.yml (C:/dev/gm has none) from an empty one — both previously returned rows:[]. Rows are paged (spoint: 2.1MB/965 rows), so `total` vs `returned` is the whole-vs-window signal.' },
  { path: '/api/mutables', method: 'GET', params: ['cwd', 'limit', 'offset'], response: '{cwd, file, present, file_bytes, parse_ms, error, mtimeMs, rows, total, returned, offset, limit, truncated}. Same bounded/honest-absence contract as /api/prd.' },
  { path: '/api/export', method: 'GET', params: ['cwd'], response: 'file download: {snapshot, sessions, deviations, prd, mutables, exportedAt, cwd}' },
  { path: '/api/prd/edit', method: 'POST', params: ['body: {cwd, id, since?, status?, text?}'], response: '{ok, cwd, id, row, mtimeMs} | 409 conflict {error, mtimeMs, currentRow}' },
  { path: '/api/mutables/edit', method: 'POST', params: ['body: {cwd, id, since?, status?, witness?}'], response: '{ok, cwd, id, row, mtimeMs} | 409 conflict {error, mtimeMs, currentRow}' },
  { path: '/api/lifecycle', method: 'POST', params: ['body: {cwd, verb, payload}'], response: '{ok, cwd, verb, file}; verb must be in the known-verb allowlist (see verbAllowlist in this same response) AND not retired. A retired verb (learn/wait/sleep) is a real match arm in verbs.rs whose handler always errors, so it is rejected 400 {retired:true} rather than written to the spool where it could only ever fail -- matching the CLI --dispatch contract.' },
  { path: '/api/rs-tools', method: 'GET', params: ['cwd', 'top', 'bucket', 'days', 'sess'], response: '{cwd, eventCount, embedFailures, recallMisses, recallScores, classifierRejects, memoryLeverage, recallModes, disciplines}' },
  { path: '/api/codeinsight', method: 'GET', params: ['cwd'], response: '{cwd, summary, entries, items} | 404 if .codeinsight absent' },
  { path: '/api/memory-graph', method: 'GET', params: ['cwd'], response: '{cwd, nodes, edges, note?}' },
  { path: '/api/codesearch', method: 'POST', params: ['body: {cwd, query}'], response: '{ok, cwd, query, hits, raw} | 504 on dispatch timeout' },
  { path: '/api/browser-sessions', method: 'GET', params: ['cwd'], response: '{cwd, sessions, ports, sessionsFileFound, portsFileFound}' },
  { path: '/api/lifecycle/response', method: 'GET', params: ['cwd', 'verb', 'file'], response: '{ok, cwd, verb, file, response} | 404 if not yet written' },
  { path: '/api/stream', method: 'GET', params: ['Last-Event-ID header (or ?last_event_id=)'], response: 'text/event-stream. EVERY frame carries "id: <n>" (monotonic) so a reconnect resumes exactly where it left off. Frame kinds: "hello" {server_seq, heartbeat_ms, ring_size, replayed, gap, resumed_from, source} sent first on every connection (gap:true means the requested Last-Event-ID fell out of the ring and the client MUST refetch /api/projects/live-state); "event" (raw normalized event); "agent.output" {cwd, run, nodes[], since_ts, until_ts} — INCREMENTAL per-agent output the client APPENDS instead of refetching, node shape identical to live-state recent_events; "project.added"; "project.removed"; "project.phase-changed"; "error". Heartbeat is an SSE comment line ": hb <ms> seq=<n>" every GM_SSE_HEARTBEAT_MS (default 15000), ignored by EventSource message dispatch.' },
  { path: '/api/projects/instruction', method: 'GET', params: ['cwd'], response: '{cwd, present, phase, skill, instruction_key, instruction_heading, instruction_excerpt (FULL body), instruction_hash, instruction_tier, instruction_source_file, instruction_source_repo, instruction_auto_provisioned, updated_ts, stale, unparseable, last_prompt}. The drilldown source — live-state list mode deliberately omits the multi-KB body.' },
  { path: '/api/source', method: 'GET', params: [], response: '{selected, archive_used, explicit_log_dir, log_dir, window_ms, window_start, total_in_window, sources, warnings, population, project_count, event_count, newest_event_ts, newest_age_ms, stale, warning, daemon}. Provenance + window bound for every aggregate number.' },
  { path: '/api/daemon', method: 'GET', params: [], response: '{present, pid, pid_alive, ts, active_projects, age_ms, stale, stale_threshold_ms, alert}. Machine-global shared-daemon heartbeat (~/.gm-tools/daemon-status.json); its ts is observed days stale while dispatches fire, hence the explicit alert.' },
  { path: '/api/parse-health', method: 'GET', params: [], response: '{totals, correlation, dispatch_totals, projects: [{cwd, name, size, truncated, version, epoch, considered, modeled, signal, ignored, modeled_ratio, ignored_ratio, signal_ratio, unmodeled_ratio, other_lines, malformed_json, dispatch}], project_count, source, schemaVersion}. Parse coverage, dispatch pairing and correlation fidelity for EVERY project -- nothing filtered, no ratio compared against a threshold, no field collapsed into a word. ignored_ratio/signal_ratio split modeled_ratio: coverage built entirely from host noise (node deprecation warnings, Bun crash dumps) is a different state from coverage built from gm telemetry, and only that split distinguishes them. dispatch.malformed_verb_starts counts starts excluded from pairing because an upstream filename-split bug made the verb a path fragment -- they can never close, so they are kept apart from orphan_starts (benign in-flight/window-clipping) rather than inflating it. correlation.dominant_kind/dominant_ratio report what the grouping is really worth, since a handful of sess-carrying events makes best_kind "sess" while the rest of the set is run-keyed.' },
  { path: '/api/gates', method: 'GET', params: ['cwd?'], response: 'with cwd: {cwd, gates: [{gate, state: "pass"|"fail"|"unknown", detail, ts}], blockers, phase, fsm_graph, outgoing_edges: [{from, to, gates, blocked, blockers}], blocked, open_edges, blocked_edges, last_gate_fired: {key, ts, age_ms, is_current_block:false}, gate_deviation_repeats, gate_deviation_repeat_count}. Without cwd: {projects: [...]}. All 8 FSM gates; "unknown" is an honest verdict, never collapsed into "fail". last_gate_fired is the last-EVER firing, not a current block — always carries age_ms.' },
  { path: '/api/embed-health', method: 'GET', params: ['cwd?'], response: '{cwd, byEvent, query_failures, vector_failures, last_failure_ts, recent, note}. Raw failure counts, no verdict: when both counts are non-zero `note` names the causal chain (embed_query_failed cascading into rssearch_vector_hits_failed, so codesearch returns success while answering from bm25 only and silently missing semantic results).' },
  { path: '/api/fsm-graph', method: 'GET', params: ['cwd'], response: '{cwd, present, source, phases, states, edges: [{from, to, gates}], gatesByEdge}. The project\'s own .gm/instructions/fsm/graph.json where one exists (real override live on this machine); present:false means the default six-phase walk applies.' },
  { path: '/api/projects/live-state', method: 'GET', params: ['full=1 (opt into full instruction bodies)', 'limit (recent_events cap)'], response: '{projects: [...], mode: "list"|"full", instruction_body_count, instruction_bodies (full mode only: {hash: body} deduped), recent_limit, correlation, source, daemon}. Per project: {cwd, alive, activity: "dispatching"|"idle"|"abandoned"|"unknown", liveness, is_live_agent, phase, phase_authoritative (turn-state.json, AUTHORITATIVE), phase_served (next-step.md), phase_divergence, skill, in_phase_ms, last_event_ms, instruction_served_ms, instruction_key, instruction_heading, instruction_preview, instruction_truncated, instruction_length, instruction_hash, instruction_excerpt (FULL MODE ONLY), instruction_tier, instruction_source_file, instruction_source_repo, instruction_auto_provisioned, updated_ts, stale, present, unparseable, turn_state, turn_summary, last_prompt, last_dispatch_ts, last_instruction_ts, served_version, codeinsight_digest, gates, prd_pending, prd_total, mut_unknown, mut_total, recent_sess, recent_correlation_kind, recent_run, recent_events, recent_total, recent_limit, recent_truncated, recent_more_above}. DEFAULT IS THE LIGHT LIST PAYLOAD -- the full form is measured at 1.4MB/174 projects, so the multi-KB instruction body is served only via ?full=1 or /api/projects/instruction. `alive`/`activity` are PER-PROJECT (watcher.log mtime / turn-summary / turn-state / last-dispatch age), never the machine-wide shared daemon pid. recent_events node kinds: instruction {phase, prd_pending_count, mutables_pending_count} | transition {phase, from, replan} | dispatch {verb, ms} | prd-add {id, rescoped} | prd-resolve {id} | mutable-add {id} | mutable-resolve {id} | memorize {key} | deviation {deviation, detail, source, sub}; every node also carries {ts, cwd, run}. instruction_tier is one of "vendored" (a real per-project override -- content diverges from what ensureInstructionsBundle last auto-provisioned, or the file is fsm-vendor-sourced with no auto-sync ambiguity at all), "source-synced", or "default". instruction_auto_provisioned is true only when tier="default" but a file is nonetheless present on disk, byte-identical to gm-plugkit\'s own last-known-shipped hash for it (materialized by the bootstrap sync, not baked into the wasm guest, and NOT a real customization -- distinguish this from a genuine "no file at all" default when displaying).' },
  { path: '/api/spool-queue', method: 'GET', params: [], response: '{queues: [{cwd, name, totalPending, byVerb}], schemaVersion}' },
  { path: '/api/watcher-versions', method: 'GET', params: [], response: '{projects: [{cwd, name, alive, pid, runtime, shared, version}], schemaVersion}' },
  { path: '/api/instruction-tiers', method: 'GET', params: [], response: '{byTier: {vendored, source-synced, default, auto_provisioned}, details: [{cwd, name, tier, source_file, source_repo, auto_provisioned?}], schemaVersion}. auto_provisioned is a sub-count of default (real defaults materialized to disk by the bootstrap sync, not a fourth tier) -- byTier.default already includes every auto-provisioned project.' },
  { path: '/api/vendored-settings', method: 'GET', params: ['cwd?'], response: 'without cwd: {projects: [{cwd, name, vendored, has_custom_graph, file_count, entries}], schemaVersion} -- every project that has run the fsm-vendor verb at least once. with cwd: {cwd, vendored, has_custom_graph, file_count, entries: [{label, path, present, size, mtime_ts}], schemaVersion} for that one project. Covers the fsm-vendor verb\'s own real customization surface (phase-prose .md files, fsm/graph.json, fsm/predicates.md, hooks/*.js, browser-config.json, daemon-project-config.json) -- a WIDER, separately-tracked set from the gates/residual auto-sync instruction-tiers endpoint above, with no false-positive risk since every entry here is a real file whose presence always means a deliberate local customization surface exists (fsm-vendor is absence-gated, one-shot, never auto-overwritten).' },
  { path: '/api/project-signals', method: 'GET', params: [], response: '[{cwd, name, phase, phase_present, phase_age_ms, activity, dispatch_age_ms, last_activity_age_ms, event_age_ms, deviation_rate_per_min, prd_pending, prd_total, mut_unknown, mut_total, queue_depth, gates_failing, gates_blocked_edges, every_edge_gate_blocked}]. Raw per-project measurements for EVERY discovered project -- no thresholds, no severity score, nothing filtered out. Sort/threshold client-side; a verdict baked in here would hide whatever it did not anticipate. /api/stuck-projects is the former name and returns the same payload.' },
  { path: '/api/throughput', method: 'GET', params: [], response: '{total, rates: {window: {count, perMinute, bySub}}, schemaVersion}' },
  { path: '/api/memory-store-health', method: 'GET', params: [], response: '{projects: [{cwd, name, memoriesCount, memoriesSize, dbSize, totalSize}], schemaVersion}' },
  { path: '/api/codeinsight-age', method: 'GET', params: [], response: '{projects: [{cwd, name, mtimeMs, ageSeconds, summary}], schemaVersion}' },
];

export { parseCodeInsight };

export function createServer({ logDir, port = 0, host = '127.0.0.1' } = {}) {
  // "Explicit" means THE OPERATOR NAMED A TREE -- GM_LOG_DIR set, or a caller passing a
  // genuinely non-default path (test.js's temp dir, `--log-dir`). It must NOT mean "some caller
  // handed us a value", because our own CLI passes the resolved DEFAULT_LOG_DIR unconditionally:
  // treating that as explicit made every default `gmsniff gui` launch select the legacy gm-log
  // archive (`archive_used: true`, 958,616 dead events, live spool unused) and compute every
  // aggregate over dead history -- the precise failure AGENTS.md's "spool is primary, archive is
  // opt-in" invariant exists to prevent, and invisible because bigger numbers look more credible.
  // Comparing against DEFAULT_LOG_DIR keeps BOTH behaviors: a default launch falls through to
  // fleet-wide spool discovery, while a genuinely non-default path still wins end-to-end.
  const resolvedLogDir = logDir || DEFAULT_LOG_DIR;
  const namedNonDefault = logDir !== undefined
    && path.resolve(logDir) !== path.resolve(DEFAULT_LOG_DIR);
  const explicitLogDir = namedNonDefault || !!process.env.GM_LOG_DIR;
  const store = new Store(resolvedLogDir, { explicitLogDir });
  store.load();
  store.startLive();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = pq(u);
    const p = u.pathname;
    const send_ = (code, body, type) => send(res, code, body, type, p);
    if (!p.startsWith('/api/')) return serveStatic(req, res);
    try {
      if (p === '/api/capabilities') {
        return send(res, 200, { routes: API_ROUTES, verbAllowlist: [...VERB_ALLOWLIST], subsystems: SUBSYSTEMS });
      }
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
        const watchedKeys = new Set((store.watchedProjects || []).map(w => path.resolve(w.cwd).replace(/\\/g, '/').toLowerCase()));
        const projects = discoverProjectsCached(store.events).map(proj => {
          const liveness = readProjectLiveness(proj.cwd);
          return {
            ...proj,
            // Overrides discoverProjects' shared-daemon-pid boolean, which reported every
            // project on the machine alive/dead together.
            alive: liveness.alive,
            activity: liveness.activity,
            liveness,
            version: readServedVersion(proj.cwd).version,
            watching: watchedKeys.has(path.resolve(proj.cwd).replace(/\\/g, '/').toLowerCase()),
          };
        });
        return send(res, 200, { projects, source: store.sourceHealth() });
      }
      // Full instruction body for ONE project -- the drilldown's source. Split out of
      // live-state so the list view never pays for 63 multi-KB instruction bodies.
      if (p === '/api/projects/instruction') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        const ps = readLivePhaseState(scope.cwd);
        const key = ps.instruction_heading ? ps.instruction_heading.toLowerCase().replace('update-docs', 'update_docs') : null;
        const tier = ps.present ? resolveInstructionTier(scope.cwd, key) : { tier: 'default', file_path: null, source_repo: null };
        return send(res, 200, {
          cwd: scope.cwd, present: ps.present, phase: ps.phase, skill: ps.skill,
          instruction_key: key, instruction_heading: ps.instruction_heading,
          instruction_excerpt: ps.instruction_excerpt,
          instruction_hash: hashText(ps.instruction_excerpt),
          instruction_tier: tier.tier, instruction_source_file: tier.file_path, instruction_source_repo: tier.source_repo,
          instruction_auto_provisioned: !!tier.auto_provisioned,
          updated_ts: ps.updated_ts, stale: ps.stale, unparseable: !!ps.unparseable,
          last_prompt: readTextFile(path.join(scope.cwd, '.gm', 'last-prompt.txt'), 8192),
        }, 'application/json', p);
      }
      if (p === '/api/projects/live-state') {
        // Default is the LIGHT list payload: no full instruction bodies. Measured at real scale
        // (174 discovered projects) the full form is 1.4MB/4.1s per request, and the client
        // refetched it on every SSE frame. ?full=1 keeps the old shape for callers that
        // genuinely want everything; the drilldown uses /api/projects/instruction instead.
        const full = q.full === '1' || q.full === 'true';
        const base = discoverProjectsCached(store.events);
        const activityIndex = store._buildCwdActivityIndex();
        const limit = Number.isFinite(q.limit) ? q.limit : (full ? RECENT_EVENTS_LIMIT : LIST_EVENTS_LIMIT);
        // Identical instruction bodies are common (every COMPLETE project serves byte-identical
        // UPDATE-DOCS prose). Send each distinct body once, keyed by hash, and reference it.
        const bodies = {};
        const projects = base.map(proj => {
          const phaseState = phaseStateOf(proj.cwd);
          const key = phaseState.instruction_heading ? phaseState.instruction_heading.toLowerCase().replace('update-docs', 'update_docs') : null;
          const tier = phaseState.present ? tierOf(proj.cwd, key) : { tier: 'default', file_path: null, source_repo: null };
          const recent = store.recentEventsForCwd(proj.cwd, activityIndex, limit);
          const turnState = turnStateOf(proj.cwd);
          const turnSummary = turnSummaryOf(proj.cwd);
          const liveness = readProjectLiveness(proj.cwd);
          const markers = markersOf(proj.cwd);
          const phase = phaseState.phase || (turnState && turnState.phase) || null;
          const gates = gatesOf(proj.cwd, { prd_pending: proj.prd_pending ?? null, mut_unknown: proj.mut_unknown ?? null, phase });
          const body = phaseState.instruction_excerpt || null;
          const bodyHash = hashText(body);
          if (bodyHash && !(bodyHash in bodies)) bodies[bodyHash] = body;
          return {
            cwd: proj.cwd,
            // A discovered directory with no readable gm state is NOT a live agent. Labelled
            // explicitly rather than surfaced as an unknown phase, so discovery breadth does not
            // become noise in the list.
            is_live_agent: !!phaseState.present && phase !== null && phase !== '?',
            instruction_hash: bodyHash,
            // Two genuinely different ages an observer needs side by side: how long this agent
            // has sat in its current phase, vs how long since it emitted ANY event. A long
            // in-phase age with a fresh last-event age is a working agent; both long is stuck.
            in_phase_ms: turnState && turnState.updated_at_ms ? Date.now() - turnState.updated_at_ms : null,
            last_event_ms: liveness.last_activity_age_ms,
            instruction_served_ms: phaseState.updated_ts ? Date.now() - phaseState.updated_ts : null,
            // next-step.md (the served prose) can genuinely lag turn-state.json (the authoritative
            // FSM state) -- observed live on C:/dev/spoint with next-step on PLAN while turn-state
            // had moved to EXECUTE. Neither source is silently preferred: turn-state is reported
            // as authoritative, next-step as instruction provenance, and the divergence is flagged.
            phase_authoritative: turnState ? turnState.phase : null,
            phase_served: phaseState.phase,
            phase_divergence: !!(turnState && turnState.phase && phaseState.phase && turnState.phase !== phaseState.phase),
            // Per-project liveness from this project's OWN signals; the shared-daemon pid is
            // reported separately and never conflated with it.
            alive: liveness.alive, activity: liveness.activity,
            phase, skill: phaseState.skill,
            instruction_key: key, instruction_heading: phaseState.instruction_heading,
            // Light mode carries a bounded preview plus the hash; the full body is in `bodies`
            // (deduped) and via /api/projects/instruction.
            instruction_preview: body ? body.slice(0, INSTRUCTION_PREVIEW_CHARS) : null,
            instruction_truncated: !!body && body.length > INSTRUCTION_PREVIEW_CHARS,
            instruction_length: body ? body.length : 0,
            ...(full ? { instruction_excerpt: body } : {}),
            instruction_tier: tier.tier, instruction_source_file: tier.file_path, instruction_source_repo: tier.source_repo,
            instruction_auto_provisioned: !!tier.auto_provisioned,
            updated_ts: phaseState.updated_ts, stale: phaseState.stale, present: phaseState.present, unparseable: !!phaseState.unparseable,
            ...(full ? { turn_state: turnState, turn_summary: turnSummary, liveness } : {}),
            // The raw user prompt driving this agent -- the single most useful missing context
            // for an observer, and previously unread.
            last_prompt: markers && markers.last_prompt ? markers.last_prompt.slice(0, full ? 4096 : 400) : null,
            last_dispatch_ts: markers ? markers.last_dispatch_ts : null,
            last_instruction_ts: markers ? markers.last_instruction_ts : null,
            served_version: readServedVersion(proj.cwd).version,
            codeinsight_digest: markers ? markers.codeinsight_digest : null,
            // List mode carries only the verdict an observer scans for; the full per-gate
            // evidence is a drilldown concern (/api/gates?cwd=).
            ...(full ? { gates } : {
              gates_blocked: gates.blocked,
              gates_blocked_edges: gates.blocked_edges,
              gates_failing: gates.blockers.map(g => g.gate),
            }),
            prd_pending: proj.prd_pending ?? null, prd_total: proj.prd_total ?? null,
            mut_unknown: proj.mut_unknown ?? null, mut_total: proj.mut_total ?? null,
            recent_sess: recent.sess,
            recent_correlation_kind: recent.correlation_kind,
            recent_run: recent.run,
            recent_events: recent.nodes,
            recent_total: recent.total, recent_limit: recent.limit,
            recent_truncated: recent.truncated, recent_more_above: recent.more_above,
          };
        });
        // Idle-hiding is the correct default at this scale: 678 discovered projects, a handful
        // working. ?activity=dispatching,idle (or ?all=1) selects the population explicitly, and
        // the hidden count is always reported so nothing disappears silently.
        const all = q.all === '1' || q.all === 'true';
        const wanted = typeof q.activity === 'string' && q.activity
          ? new Set(q.activity.split(',').map(s => s.trim()).filter(Boolean))
          : (all ? null : new Set(['dispatching', 'idle']));
        const shown = wanted ? projects.filter(x => wanted.has(x.activity)) : projects;
        return send(res, 200, {
          projects: shown,
          discovered: projects.length,
          shown: shown.length,
          hidden: projects.length - shown.length,
          filter: wanted ? [...wanted] : 'all',
          byActivity: projects.reduce((m, x) => { m[x.activity] = (m[x.activity] || 0) + 1; return m; }, {}),
          // hash -> distinct instruction body, sent once each. In light mode this is omitted
          // entirely; the client resolves a hash via /api/projects/instruction on drilldown.
          ...(full ? { instruction_bodies: bodies } : {}),
          instruction_body_count: Object.keys(bodies).length,
          mode: full ? 'full' : 'list',
          recent_limit: limit,
          // Lets the client label the grouping honestly ("grouped by daemon run, not agent
          // session") instead of implying a session fidelity the data does not have.
          correlation: correlationCoverage(store.events),
          source: store.sourceHealth(),
          daemon: readDaemonStatusGlobal(),
        });
      }
      if (p === '/api/health-summary') {
        return send(res, 200, healthSummary(store));
      }
      if (p === '/api/prd') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        return send(res, 200, yamlRowsPayload(scope.cwd, 'prd.yml', readPrd, q));
      }
      if (p === '/api/mutables') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        return send(res, 200, yamlRowsPayload(scope.cwd, 'mutables.yml', readMutables, q));
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
          if (isRetiredVerb(verb)) {
            return send(res, 400, {
              error: 'retired verb: recognized by the daemon but its handler always returns an error',
              verb, retired: true,
            });
          }
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
        const parsed = parseCodeInsight(text);
        if (!parsed.accepted) return send(res, 422, { error: 'unparseable .codeinsight', reason: parsed.reason });
        return send(res, 200, { cwd: scope.cwd, ...parsed.value });
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
        if (store.sseClients.size >= MAX_SSE_CLIENTS) {
          return send(res, 503, { error: 'too many SSE clients', max: MAX_SSE_CLIENTS }, 'application/json', p);
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
          'X-Accel-Buffering': 'no',
        });
        // Last-Event-ID (browser EventSource sets it automatically; ?last_event_id= for manual
        // clients) drives a bounded replay of exactly the frames missed while disconnected.
        const rawLast = req.headers['last-event-id'] ?? q.last_event_id;
        const lastId = rawLast === undefined ? NaN : parseInt(rawLast, 10);
        const replay = store.replaySince(lastId);
        res.write(sseFrame({
          id: store._sseSeq,
          kind: 'hello',
          data: {
            server_seq: store._sseSeq,
            heartbeat_ms: SSE_HEARTBEAT_MS,
            ring_size: SSE_RING_SIZE,
            replayed: replay.frames.length,
            // gap:true means the requested id fell out of the ring -- the client MUST refetch
            // /api/projects/live-state rather than assume its feed is continuous.
            gap: replay.gap,
            resumed_from: Number.isFinite(lastId) ? lastId : null,
            source: store.sourceHealth(),
          },
        }));
        for (const f of replay.frames) { try { res.write(sseFrame(f)); } catch {} }
        store.sseClients.add(res);
        req.on('close', () => store.sseClients.delete(res));
        return;
      }
      // -- Missing monitoring surface (formal spec Module 8) --
      // Spool queue depth: count of pending dispatch files per verb across all projects.
      if (p === '/api/spool-queue') {
        const projects = discoverProjectsCached(store.events);
        const queues = [];
        for (const proj of projects) {
          const inDir = path.join(proj.cwd, '.gm', 'exec-spool', 'in');
          const byVerb = {};
          try {
            for (const verbDir of fs.readdirSync(inDir, { withFileTypes: true })) {
              if (!verbDir.isDirectory()) continue;
              try {
                const files = fs.readdirSync(path.join(inDir, verbDir.name));
                if (files.length) byVerb[verbDir.name] = files.length;
              } catch (_) {}
            }
          } catch (_) {}
          const totalPending = Object.values(byVerb).reduce((s, c) => s + c, 0);
          if (totalPending > 0) queues.push({ cwd: proj.cwd, name: path.basename(proj.cwd), totalPending, byVerb });
        }
        queues.sort((a, b) => b.totalPending - a.totalPending);
        return send(res, 200, { queues, schemaVersion: EVENT_SCHEMA_VERSION }, 'application/json', p);
      }

      // Watcher version drift: per-project version vs latest published (from any .status.json
      // that carries an update_available field, or the server's own knowledge from the most
      // recent instruction response).
      if (p === '/api/watcher-versions') {
        const projects = discoverProjectsCached(store.events);
        const rows = [];
        for (const proj of projects) {
          const status = readWatcherStatus(proj.cwd);
          if (!status) continue;
          rows.push({
            cwd: proj.cwd, name: path.basename(proj.cwd),
            alive: status.alive, pid: status.pid,
            runtime: status.runtime, shared: status.shared_process,
            version: status.version,
          });
        }
        return send(res, 200, { projects: rows, schemaVersion: EVENT_SCHEMA_VERSION }, 'application/json', p);
      }

      // Instruction tier distribution: across all discovered projects, count how many are
      // served by vendored overrides, source-synced cache, or compiled defaults.
      if (p === '/api/instruction-tiers') {
        const projects = discoverProjectsCached(store.events);
        // auto_provisioned is a sub-count of `default` (a real default, just materialized to disk
        // by ensureInstructionsBundle rather than compiled into the wasm guest), not a fourth tier
        // -- byTier.default already includes every auto-provisioned project, so a consumer summing
        // byTier values still gets the correct total; auto_provisioned is purely additive detail.
        const byTier = { vendored: 0, 'source-synced': 0, default: 0, auto_provisioned: 0 };
        const details = [];
        for (const proj of projects) {
          const phaseState = readLivePhaseState(proj.cwd);
          if (!phaseState.present) continue;
          const key = phaseState.instruction_heading ? phaseState.instruction_heading.toLowerCase().replace('update-docs', 'update_docs') : null;
          const tier = resolveInstructionTier(proj.cwd, key);
          byTier[tier.tier] = (byTier[tier.tier] || 0) + 1;
          if (tier.auto_provisioned) byTier.auto_provisioned++;
          if (tier.tier !== 'default') {
            details.push({ cwd: proj.cwd, name: path.basename(proj.cwd), tier: tier.tier, source_file: tier.file_path, source_repo: tier.source_repo });
          } else if (tier.auto_provisioned) {
            details.push({ cwd: proj.cwd, name: path.basename(proj.cwd), tier: 'default', auto_provisioned: true, source_file: null, source_repo: null });
          }
        }
        return send(res, 200, { byTier, details, schemaVersion: EVENT_SCHEMA_VERSION }, 'application/json', p);
      }

      // fsm-vendor's own real customization surface (phase prose, fsm/graph.json, hooks,
      // browser-config.json, daemon-project-config.json) -- a WIDER, separately-tracked set from
      // resolveInstructionTier's gates/residual auto-sync coverage above (see
      // discoverVendoredSettings's own header comment in registry.js for why these two surfaces
      // don't share a detection mechanism). ?cwd=<path> drills into one project's own file list;
      // omitted, returns a per-project summary across every discovered project for a Dashboard-
      // style glance (which projects have actually exercised fsm-vendor at all, and which of those
      // have a genuinely custom FSM graph vs just leftover example files).
      if (p === '/api/vendored-settings') {
        if (q.cwd) {
          const scoped = resolveScopedCwd(store, q.cwd);
          if (!scoped.ok) return send(res, 400, { error: scoped.error });
          return send(res, 200, { cwd: scoped.cwd, ...discoverVendoredSettings(scoped.cwd), schemaVersion: EVENT_SCHEMA_VERSION }, 'application/json', p);
        }
        const projects = discoverProjectsCached(store.events);
        const rows = projects
          .map((proj) => ({ cwd: proj.cwd, name: path.basename(proj.cwd), ...discoverVendoredSettings(proj.cwd) }))
          .filter((r) => r.vendored);
        return send(res, 200, { projects: rows, schemaVersion: EVENT_SCHEMA_VERSION }, 'application/json', p);
      }

      // -- Stuck-project detection: which projects need operator attention? --
      if (p === '/api/stuck-projects' || p === '/api/project-signals') {
        return send(res, 200, projectSignals(store), 'application/json', p);
      }

      // -- Event throughput: ingestion rate over configurable time windows --
      if (p === '/api/throughput') {
        return send(res, 200, throughputMetrics(store), 'application/json', p);
      }

      // -- Memory store health: .gm/memories/ + .gm/rs-learn.db growth --
      if (p === '/api/memory-store-health') {
        return send(res, 200, memoryStoreHealth(store), 'application/json', p);
      }

      // -- CodeInsight age: staleness of .codeinsight across projects --
      if (p === '/api/codeinsight-age') {
        return send(res, 200, codeInsightAge(store), 'application/json', p);
      }

      // -- Replay-source provenance + staleness warning --
      // Every aggregate route's numbers are only meaningful alongside which source produced them
      // and how far back it reaches. Exposed as its own route so a client can render
      // "live spool, 26,866 events, 7d window" instead of an unlabelled total.
      if (p === '/api/source') {
        return send(res, 200, { ...store.sourceHealth(), daemon: readDaemonStatusGlobal() }, 'application/json', p);
      }

      if (p === '/api/parse-health') {
        const PER_PROJECT_PARSE_FIELDS = [
          'considered', 'modeled', 'signal', 'ignored', 'modeled_ratio',
          'ignored_ratio', 'signal_ratio', 'unmodeled_ratio', 'other_lines', 'malformed_json',
        ];
        const eventsByCwd = new Map();
        for (const ev of store.events) {
          if (!ev.cwd) continue;
          if (!eventsByCwd.has(ev.cwd)) eventsByCwd.set(ev.cwd, []);
          eventsByCwd.get(ev.cwd).push(ev);
        }
        const projects = (store.source.projects || []).map(perProjectStats => {
          const row = {
            cwd: perProjectStats.cwd,
            name: path.basename(perProjectStats.cwd),
            size: perProjectStats.size ?? null,
            truncated: !!perProjectStats.truncated,
            version: perProjectStats.version ?? null,
            epoch: perProjectStats.epoch ?? null,
            dispatch: pairDispatches(eventsByCwd.get(perProjectStats.cwd) || []),
          };
          for (const field of PER_PROJECT_PARSE_FIELDS) row[field] = perProjectStats[field] ?? null;
          delete row.dispatch.pairs;
          return row;
        });
        const SUMMABLE_DISPATCH_FIELDS = ['starts', 'ends', 'paired', 'orphan_starts', 'orphan_ends', 'malformed_verb_starts'];
        const dispatchTotals = {};
        for (const field of SUMMABLE_DISPATCH_FIELDS) {
          dispatchTotals[field] = projects.reduce((sum, pr) => sum + (pr.dispatch[field] || 0), 0);
        }
        return send(res, 200, {
          totals: store.source.stats || null,
          correlation: correlationCoverage(store.events),
          dispatch_totals: dispatchTotals,
          projects,
          project_count: projects.length,
          source: store.sourceHealth(),
          schemaVersion: EVENT_SCHEMA_VERSION,
        }, 'application/json', p);
      }

      // -- Machine-global shared daemon heartbeat --
      if (p === '/api/daemon') {
        return send(res, 200, readDaemonStatusGlobal(), 'application/json', p);
      }

      // -- Per-project FSM gate pass/fail: WHY is a transition blocked? --
      if (p === '/api/gates') {
        if (q.cwd) {
          const scope = resolveScopedCwd(store, q.cwd);
          if (!scope.ok) return send(res, 403, { error: scope.error });
          const ps = readLivePhaseState(scope.cwd);
          const ts = readTurnState(scope.cwd);
          const pm = discoverProjectsCached(store.events).find(x => x.cwd === scope.cwd) || {};
          return send(res, 200, {
            cwd: scope.cwd,
            ...readFsmGates(scope.cwd, { prd_pending: pm.prd_pending ?? null, mut_unknown: pm.mut_unknown ?? null, phase: ps.phase || (ts && ts.phase) || null }),
            schemaVersion: EVENT_SCHEMA_VERSION,
          }, 'application/json', p);
        }
        const rows = discoverProjectsCached(store.events).map(proj => {
          const ps = readLivePhaseState(proj.cwd);
          const ts = readTurnState(proj.cwd);
          const g = readFsmGates(proj.cwd, { prd_pending: proj.prd_pending ?? null, mut_unknown: proj.mut_unknown ?? null, phase: ps.phase || (ts && ts.phase) || null });
          return { cwd: proj.cwd, name: path.basename(proj.cwd), phase: g.phase, blocked: g.blocked, blocked_edges: g.blocked_edges, open_edges: g.open_edges, gates: g.gates, last_gate_fired: g.last_gate_fired, fsm_graph: g.fsm_graph };
        });
        return send(res, 200, { projects: rows, schemaVersion: EVENT_SCHEMA_VERSION }, 'application/json', p);
      }

      // -- Silent semantic-search degradation (returns-success-while-broken) --
      if (p === '/api/embed-health') {
        let cwd = null;
        if (q.cwd) {
          const scope = resolveScopedCwd(store, q.cwd);
          if (!scope.ok) return send(res, 403, { error: scope.error });
          cwd = scope.cwd;
        }
        return send(res, 200, { cwd, ...embedDegradation(store.events, cwd), schemaVersion: EVENT_SCHEMA_VERSION }, 'application/json', p);
      }

      // -- Per-project FSM phase graph (the real override where one exists) --
      if (p === '/api/fsm-graph') {
        const scope = resolveScopedCwd(store, q.cwd);
        if (!scope.ok) return send(res, 403, { error: scope.error });
        return send(res, 200, { cwd: scope.cwd, ...readFsmGraph(scope.cwd), schemaVersion: EVENT_SCHEMA_VERSION }, 'application/json', p);
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: String(e?.message || e) }, 'application/json', p);
    }
  });

  return new Promise(resolve => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, store, url: `http://${host}:${addr.port}`, port: addr.port, close: async () => { await store.stop(); return new Promise(r => server.close(r)); } });
    });
  });
}
