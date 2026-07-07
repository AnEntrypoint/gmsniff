import fs from 'fs';
import path from 'path';
import os from 'os';

// Shared .gm/prd.yml + .gm/mutables.yml structured parsing, and multi-project
// discovery/registry logic. Extracted so both cli.js and server.js reuse the
// same row-parsing semantics instead of drifting copies.

const ID_LINE = /^- id:\s*(.*)$/;
const BOUNDARY_LINE = /^- ([a-zA-Z_][\w]*):\s?(.*)$/;
const FIELD_LINE = /^\s{2}([a-zA-Z_][\w]*):\s?(.*)$/;
const LIST_ITEM_LINE = /^\s{2}-\s+(.*)$/;

// Splits a prd.yml/mutables.yml body into structured rows: [{id, fields..., _raw, _start, _end}]
// _raw preserves the exact source slice (including leading boundary line) so an editor can
// rewrite a single row back into the file byte-for-byte for every other row.
// A field written as a YAML block-list (`tags:` on its own line followed by `  - item` lines
// at the same 2-space indent as the field key) parses into an array on that field's key,
// same as gm's own prd.yml emits for e.g. tags.
//
// Row boundary is any top-level `- <field>: ...` line, not just `- id:`. gm's own live
// prd.yml has a legacy row cluster shaped `- title: <text>` with `id:` as a plain field
// further down (not the boundary marker) -- treating only `- id:` as a boundary silently
// drops those rows entirely (confirmed: 11 real rows, incl. severity-tagged ones, invisible
// to readPrd() before this fix). The boundary line's own field (title, id, whatever key it
// uses) is captured like any other field, so `- id: x` rows are byte-identical to before.
export function parseYamlRows(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const rows = [];
  let cur = null;
  let listField = null; // field name currently accumulating block-list items, if any
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bm = line.match(BOUNDARY_LINE);
    if (bm) {
      if (cur) { cur._end = i; rows.push(cur); }
      cur = { id: undefined, _start: i, _lines: [line] };
      cur[bm[1]] = unquote(bm[2].trim());
      if (bm[1] === 'id') cur.id = cur[bm[1]];
      listField = null;
      continue;
    }
    if (cur) {
      if (listField && LIST_ITEM_LINE.test(line)) {
        cur._lines.push(line);
        cur[listField].push(unquote(line.match(LIST_ITEM_LINE)[1].trim()));
        continue;
      }
      if (listField && cur[listField].length === 0) {
        // `key:` had no value AND no list items followed (bare/empty field, not a block-list) --
        // fall back to the pre-existing empty-string behavior rather than leaving an empty array.
        cur[listField] = '';
      }
      listField = null;
      cur._lines.push(line);
      const fm = line.match(FIELD_LINE);
      if (fm) {
        if (fm[2].trim() === '') { cur[fm[1]] = []; listField = fm[1]; }
        else cur[fm[1]] = unquote(fm[2].trim());
        if (fm[1] === 'id') cur.id = cur[fm[1]];
      }
    }
  }
  if (cur) { cur._end = lines.length; rows.push(cur); }
  for (const r of rows) {
    r._raw = r._lines.join('\n');
    delete r._lines;
    // A bare `key:` at true row/file end with no list items following (never closed by the
    // in-loop fallback above, since there was no subsequent line to trigger it) -- same
    // empty-string fallback as the in-loop case.
    for (const k of Object.keys(r)) {
      if (Array.isArray(r[k]) && r[k].length === 0) r[k] = '';
    }
  }
  return rows;
}

function unquote(s) {
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try { return JSON.parse(s); } catch (_) { return s.slice(1, -1); }
  }
  return s;
}

function yamlScalar(s) {
  s = String(s == null ? '' : s);
  if (/^[\w./-]*$/.test(s) && s.length && !/^(true|false|null|~)$/i.test(s) && !/^-?\d+$/.test(s)) return s;
  if (s === '') return "''";
  return `'${s.replace(/'/g, "''")}'`;
}

// Reads and parses a PRD or mutables yml file. Returns { text, mtimeMs, rows } or null if absent.
export function readYamlFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, 'utf-8');
    return { text, mtimeMs: stat.mtimeMs, rows: parseYamlRows(text) };
  } catch (_) {
    return null;
  }
}

export function readPrd(cwd) {
  const f = readYamlFile(path.join(cwd, '.gm', 'prd.yml'));
  if (!f) return { mtimeMs: null, rows: [] };
  return {
    mtimeMs: f.mtimeMs,
    // text is by far the dominant/current free-text field (868 occurrences across
    // ../gm/.gm/prd.yml, 100% of the most recent 300 rows); note/subject are older
    // minority conventions; body is a superseded historical field (66 body-only rows,
    // none in the recent tail) kept as the lowest-priority fallback so those rows don't
    // render empty.
    // severity/tags are additive enrichment (real fields in ../gm's live prd.yml, ~0.5%
    // and ~1.8% of rows respectively) -- surfaced as-is, undefined when absent, so the GUI
    // can badge them without every other row growing spurious empty badges. desc/description/
    // detail/title/acceptance/scope are deliberately NOT added here: they are alternate
    // free-text spellings, not new signal, and would just be a 3rd/4th/5th near-duplicate
    // fallback branch on top of text/note/subject/body.
    rows: f.rows.map(r => ({
      id: r.id,
      status: r.status || 'pending',
      text: r.text || r.note || r.subject || r.body || '',
      witness: r.witness || undefined,
      severity: r.severity || undefined,
      tags: Array.isArray(r.tags) && r.tags.length ? r.tags : undefined,
    })),
  };
}

export function readMutables(cwd) {
  const f = readYamlFile(path.join(cwd, '.gm', 'mutables.yml'));
  if (!f) return { mtimeMs: null, rows: [] };
  return {
    mtimeMs: f.mtimeMs,
    rows: f.rows.map(r => ({ id: r.id, status: r.status || 'unknown', claim: r.claim || '', witness_method: r.witness_method || undefined, witness_evidence: r.witness_evidence || undefined })),
  };
}

// Rewrites a single row's given fields in place inside the raw yml text, preserving all
// other rows byte-for-byte. Returns the new full file text, or null if id not found.
export function rewriteRow(text, id, fields) {
  const rows = parseYamlRows(text);
  const idx = rows.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const target = rows[idx];
  const merged = { ...target, ...fields };
  const lines = [`- id: ${yamlScalar(id)}`];
  for (const [k, v] of Object.entries(merged)) {
    if (k === 'id' || k.startsWith('_')) continue;
    if (v === undefined || v === null || v === '') continue;
    lines.push(`  ${k}: ${yamlScalar(v)}`);
  }
  const newRowText = lines.join('\n');
  const fileLines = text.split('\n');
  const before = fileLines.slice(0, target._start).join('\n');
  const after = fileLines.slice(target._end).join('\n');
  const parts = [];
  if (before) parts.push(before.replace(/\n$/, ''));
  parts.push(newRowText);
  if (after) parts.push(after.replace(/^\n/, ''));
  let out = parts.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

// Atomic write: write to a temp file in the same directory, then rename over the target.
export function atomicWriteFile(filePath, contents) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, contents, 'utf-8');
  fs.renameSync(tmp, filePath);
}

export function readWatcherStatus(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cwd, '.gm', 'exec-spool', '.status.json'), 'utf-8'));
    if (!j || !j.pid) return null;
    let alive = false;
    try { process.kill(j.pid, 0); alive = true; } catch (_) {}
    const age = j.ts ? Date.now() - j.ts : null;
    return { pid: j.pid, version: j.version, wrapper_sha: j.wrapper_sha || null, idle_limit_ms: j.idle_limit_ms || null, alive, age_ms: age };
  } catch (_) { return null; }
}

// mtime-gated per-cwd cache: readPrdMutablesState does 2 reads + regex-parse per call and is
// invoked once per discovered project on every /api/projects and /api/health-summary request.
// At real scale (55 discovered projects under C:/dev, measured live) that serial per-request
// fan-out of blocking sync fs.readFileSync calls was the dominant cost behind observed GUI
// jank under a real event backlog (health-summary/discoverProjects latency, knock-on main-
// thread stalls). A cheap fs.statSync (mtimeMs only, no content read) gates the cache: result
// is reused unless either file's mtime has actually changed since the last read, so the cache
// never serves content staler than what's really on disk.
const _prdMutStateCache = new Map(); // cwd -> { prdMtime, mutMtime, value }

function statMtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return null; }
}

export function readPrdMutablesState(cwd) {
  const prdPath = path.join(cwd, '.gm', 'prd.yml');
  const mutPath = path.join(cwd, '.gm', 'mutables.yml');
  const prdMtime = statMtimeMs(prdPath);
  const mutMtime = statMtimeMs(mutPath);
  const cached = _prdMutStateCache.get(cwd);
  if (cached && cached.prdMtime === prdMtime && cached.mutMtime === mutMtime) return cached.value;

  const out = { prd_pending: 0, prd_total: 0, mut_unknown: 0, mut_total: 0 };
  try {
    const prdText = fs.readFileSync(prdPath, 'utf-8');
    const items = prdText.split(/^- id:/m).slice(1);
    out.prd_total = items.length;
    out.prd_pending = items.filter(i => !/status:\s*(done|complete|completed)/.test(i)).length;
  } catch (_) {}
  try {
    const mutText = fs.readFileSync(mutPath, 'utf-8');
    const items = mutText.split(/^- id:/m).slice(1);
    out.mut_total = items.length;
    out.mut_unknown = items.filter(i => /status:\s*unknown/.test(i)).length;
  } catch (_) {}
  _prdMutStateCache.set(cwd, { prdMtime, mutMtime, value: out });
  return out;
}

function canon(p) {
  return p && path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// discoverProjects re-derives its cwd SET from two O(events)/O(fs) sources every call: a full
// scan of the events array plus a readdirSync walk of every dev root. events only ever grows
// (append-only store), so the cwd set itself is safe to cache keyed on events.length -- a real
// measured burst of 60k+ events showed this repeated full-array scan as a dominant cost behind
// /api/health-summary latency (itself called every 10s per connected client). Only the cwd-SET
// half is cached; per-project alive/prd_pending/prd_total live status is re-read fresh below on
// every call (those change independent of events.length and must never go stale).
let _cwdSetCache = { eventsLength: -1, cwds: null };
function discoverCwdSet(events, extraRoots) {
  const len = (events || []).length;
  if (_cwdSetCache.eventsLength === len && _cwdSetCache.cwds) return _cwdSetCache.cwds;

  const cwds = new Set();
  const norm = new Map();
  const addCwd = (p) => { if (!p) return; const k = canon(p); if (!k) return; if (!norm.has(k)) { norm.set(k, p); cwds.add(p); } };

  for (const e of events || []) {
    if (e._sub === 'plugkit' && e.event === 'watcher.boot' && e.spool_dir) {
      addCwd(path.dirname(path.dirname(e.spool_dir)));
    } else if (e.cwd) {
      addCwd(e.cwd);
    }
  }

  const roots = [...extraRoots];
  if (process.env.DEV_ROOT) roots.push(process.env.DEV_ROOT);
  if (process.env.GM_DEV_ROOT) roots.push(process.env.GM_DEV_ROOT);
  roots.push(process.platform === 'win32' ? 'C:/dev' : path.join(os.homedir(), 'dev'));
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const proj = path.join(root, d.name);
        const marker = path.join(proj, '.gm', 'exec-spool', '.status.json');
        if (fs.existsSync(marker)) addCwd(proj);
      }
    } catch (_) {}
  }

  _cwdSetCache = { eventsLength: len, cwds };
  return cwds;
}

// Discovers project cwds from observed gm-log events (same heuristic as cli.js's watchers())
// plus a scan of common dev roots for .gm/exec-spool/.status.json markers.
export function discoverProjects(events, { extraRoots = [] } = {}) {
  const cwds = discoverCwdSet(events, extraRoots);

  const rows = [];
  for (const cwd of cwds) {
    const status = readWatcherStatus(cwd);
    const ps = readPrdMutablesState(cwd);
    rows.push({
      cwd,
      alive: !!(status && status.alive),
      version: status ? status.version : null,
      prd_pending: ps.prd_pending,
      prd_total: ps.prd_total,
      mut_unknown: ps.mut_unknown,
      mut_total: ps.mut_total,
    });
  }
  rows.sort((a, b) => (b.alive ? 1 : 0) - (a.alive ? 1 : 0) || path.basename(a.cwd).localeCompare(path.basename(b.cwd)));
  return rows;
}

// Exported (not just isKnownVerb) so a capabilities/introspection surface (server.js's
// GET /api/capabilities) can enumerate the exact allowlist an agentic caller's /api/lifecycle
// POST is validated against, rather than that list being duplicated/hardcoded a second place.
export const VERB_ALLOWLIST = new Set([
  'instruction', 'transition', 'prd-add', 'prd-resolve', 'mutable-add', 'mutable-resolve',
  'residual-scan', 'codesearch', 'recall', 'browser', 'exec_js', 'phase-status',
  'git_status', 'git_log', 'git_diff', 'git_show', 'git_branch', 'git_add', 'git_commit',
  'git_finalize', 'git_push', 'git_checkout', 'git_fetch', 'git_rm', 'git_revert', 'git_reset',
  'memorize-fire', 'memorize-prune',
  'auto-recall', 'bash', 'branch_status', 'close', 'discipline-note', 'exec', 'fetch',
  'filter', 'fs_read', 'fs_write', 'health', 'kill-port', 'kv', 'lang', 'learn',
  'learn-debug', 'learn-status', 'memorize', 'memorize-continue', 'mutable-list',
  'prd-list', 'recall_kv', 'task-list', 'task-spawn', 'task-stop',
]);

const VERB_SHAPE = /^[a-zA-Z0-9_-]+$/;

export function isKnownVerb(verb) {
  return typeof verb === 'string' && VERB_SHAPE.test(verb) && VERB_ALLOWLIST.has(verb);
}

export function isAllowedProjectCwd(cwd, allowedCwds) {
  if (!cwd || typeof cwd !== 'string') return false;
  if (cwd.includes('..')) return false;
  const target = canon(cwd);
  if (!target) return false;
  return allowedCwds.some(c => canon(c) === target);
}
