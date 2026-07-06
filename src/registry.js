import fs from 'fs';
import path from 'path';
import os from 'os';

// Shared .gm/prd.yml + .gm/mutables.yml structured parsing, and multi-project
// discovery/registry logic. Extracted so both cli.js and server.js reuse the
// same row-parsing semantics instead of drifting copies.

const ID_LINE = /^- id:\s*(.*)$/;
const FIELD_LINE = /^\s{2}([a-zA-Z_][\w]*):\s?(.*)$/;

// Splits a prd.yml/mutables.yml body into structured rows: [{id, fields..., _raw, _start, _end}]
// _raw preserves the exact source slice (including leading "- id:" line) so an editor can
// rewrite a single row back into the file byte-for-byte for every other row.
export function parseYamlRows(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const rows = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idm = line.match(ID_LINE);
    if (idm) {
      if (cur) { cur._end = i; rows.push(cur); }
      cur = { id: unquote(idm[1].trim()), _start: i, _lines: [line] };
      continue;
    }
    if (cur) {
      if (line.match(/^- /) && !ID_LINE.test(line)) {
        // a non-"- id:" top-level list item -- treat as boundary too (defensive)
        cur._end = i;
        rows.push(cur);
        cur = null;
        continue;
      }
      cur._lines.push(line);
      const fm = line.match(FIELD_LINE);
      if (fm) cur[fm[1]] = unquote(fm[2].trim());
    }
  }
  if (cur) { cur._end = lines.length; rows.push(cur); }
  for (const r of rows) {
    r._raw = r._lines.join('\n');
    delete r._lines;
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
    rows: f.rows.map(r => ({ id: r.id, status: r.status || 'pending', text: r.text || r.note || r.subject || '', witness: r.witness || undefined })),
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

export function readPrdMutablesState(cwd) {
  const out = { prd_pending: 0, prd_total: 0, mut_unknown: 0, mut_total: 0 };
  try {
    const prdText = fs.readFileSync(path.join(cwd, '.gm', 'prd.yml'), 'utf-8');
    const items = prdText.split(/^- id:/m).slice(1);
    out.prd_total = items.length;
    out.prd_pending = items.filter(i => !/status:\s*(done|complete|completed)/.test(i)).length;
  } catch (_) {}
  try {
    const mutText = fs.readFileSync(path.join(cwd, '.gm', 'mutables.yml'), 'utf-8');
    const items = mutText.split(/^- id:/m).slice(1);
    out.mut_total = items.length;
    out.mut_unknown = items.filter(i => /status:\s*unknown/.test(i)).length;
  } catch (_) {}
  return out;
}

function canon(p) {
  return p && path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Discovers project cwds from observed gm-log events (same heuristic as cli.js's watchers())
// plus a scan of common dev roots for .gm/exec-spool/.status.json markers.
export function discoverProjects(events, { extraRoots = [] } = {}) {
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
]);

const VERB_SHAPE = /^[a-zA-Z0-9-]+$/;

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
