import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

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
    // Two live .status.json shapes: legacy per-project JS-wrapper (version + wrapper_sha,
    // one process per project) and the current agentplug shared daemon (runtime:"agentplug",
    // shared_process:true, one process serving many project cwds, no version/wrapper_sha field
    // at all since the wasm guest it serves updates independently of the runner binary).
    // version presence alone previously gated aliveness display, silently dropping every
    // agentplug-driven project (the entire current-generation fleet) from callers wanting to
    // label/badge the daemon (e.g. the GUI's health-summary route).
    const runtime = j.runtime || (j.version ? 'wrapper' : null);
    return { pid: j.pid, version: j.version || null, wrapper_sha: j.wrapper_sha || null, idle_limit_ms: j.idle_limit_ms || null, runtime, shared_process: !!j.shared_process, alive, age_ms: age };
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

// Maps a served instruction's leading markdown heading to the skill that drives it. gm/
// gm-continue/wfgy-method are the only skills that mutate .gm state today; PLAN/EXECUTE/EMIT/
// VERIFY/CONSOLIDATE/UPDATE-DOCS headings are all phases inside the gm skill's own walk.
const PHASE_HEADING_TO_SKILL = {
  PLAN: 'gm', EXECUTE: 'gm', EMIT: 'gm', VERIFY: 'gm', CONSOLIDATE: 'gm', 'UPDATE-DOCS': 'gm',
};

// mtime-gated per-cwd cache mirroring readPrdMutablesState's shape -- next-step.md is polled
// once per project per SSE tick, so a cheap statSync-only short-circuit avoids re-parsing
// unchanged content on every poll.
const _phaseStateCache = new Map(); // cwd -> { mtime, value }

// Reads .gm/next-step.md (written by rs-plugkit on every phase/instruction change) and returns
// the live phase + skill + a short excerpt of the currently-served instruction prose. Real
// on-disk shape: "# Next step\n\nPhase: <PHASE>\nUpdated: <epoch-ms>\n\n---\n\n# <PHASE>\n<prose>".
export function readLivePhaseState(cwd) {
  const nextStepPath = path.join(cwd, '.gm', 'next-step.md');
  const mtime = statMtimeMs(nextStepPath);
  if (mtime === null) return { phase: null, skill: null, instruction_heading: null, instruction_excerpt: null, updated_ts: null, stale: true, present: false };
  const cached = _phaseStateCache.get(cwd);
  if (cached && cached.mtime === mtime) return cached.value;

  let value;
  try {
    const text = fs.readFileSync(nextStepPath, 'utf-8');
    const phaseMatch = text.match(/^Phase:\s*(.+)$/m);
    const updatedMatch = text.match(/^Updated:\s*(\d+)$/m);
    const bodyIdx = text.indexOf('\n---\n');
    const body = bodyIdx >= 0 ? text.slice(bodyIdx + 5).trimStart() : '';
    const headingMatch = body.match(/^#\s*(.+?)\s*$/m);
    const heading = headingMatch ? headingMatch[1].trim().toUpperCase() : null;
    const phase = phaseMatch ? phaseMatch[1].trim() : heading;
    const updated_ts = updatedMatch ? Number(updatedMatch[1]) : null;
    // long_gap_threshold_ms is the project's own served staleness bound (turn-summary.json,
    // default 300000ms); fall back to that default when the summary is unavailable rather than
    // guessing a different number here.
    let threshold = 300000;
    try {
      const summary = JSON.parse(fs.readFileSync(path.join(cwd, '.gm', 'exec-spool', '.turn-summary.json'), 'utf-8'));
      if (summary && Number.isFinite(summary.long_gap_threshold_ms)) threshold = summary.long_gap_threshold_ms;
    } catch (_) {}
    value = {
      phase: phase || null,
      skill: heading ? (PHASE_HEADING_TO_SKILL[heading] || null) : null,
      instruction_heading: heading,
      // Full served instruction body, untruncated -- next-step.md instructions routinely run
      // several KB (real PLAN/EXECUTE prose observed multi-KB in production), and clipping to
      // an arbitrary char count silently hid most of the actual instruction from the observer.
      // The GUI drilldown's <pre> already scrolls (max-height + overflow:auto), so there is no
      // rendering reason to cap this server-side; the row-level preview does its own short
      // client-side slice for the list view, independent of this field.
      instruction_excerpt: body,
      updated_ts,
      stale: updated_ts === null ? true : (Date.now() - updated_ts) > threshold,
      present: true,
    };
  } catch (_) {
    // Partial write mid-update or unreadable content -- fail open to an unparseable-but-present
    // state rather than throwing, so one bad project's file doesn't break every other row.
    value = { phase: null, skill: null, instruction_heading: null, instruction_excerpt: null, updated_ts: null, stale: true, present: true, unparseable: true };
  }
  _phaseStateCache.set(cwd, { mtime, value });
  return value;
}

// gm-plugkit's bootstrap.ensureInstructionsBundle() auto-provisions .gm/instructions/gates/*.md
// and .gm/instructions/residual/*.md from its own compiled instructions/ source tree on EVERY
// daemon boot -- this is normal, universal, zero-signal state, not a deliberate per-project
// customization. It tracks what it last wrote via .gm/.instructions-shipped-manifest.json (a
// sha256-per-relative-path map): a local file whose hash still matches its manifest entry is
// exactly what was auto-copied and never touched since, and reporting that as a "vendored
// override" is a false positive that would fire for every single gm-bootstrapped project (the
// bug this function exists to fix -- see AGENTS.md's own "auto-provisioned defaults are not real
// overrides" note). A local file whose hash DIVERGES from its manifest entry is the opposite
// signal: ensureInstructionsBundle's own write_if_absent_or_forced-equivalent logic explicitly
// PRESERVES a user edit across a bundle update rather than overwriting it (staging the new
// default alongside as `<key>.md.new` instead) -- that divergence is the real, load-bearing
// evidence of a deliberate override, independent of whether the file's *current* content happens
// to still equal some other reference text.
let _manifestCache = new Map(); // cwd -> {mtimeMs, manifest}
function readShippedManifest(cwd) {
  const manifestPath = path.join(cwd, '.gm', '.instructions-shipped-manifest.json');
  let stat;
  try { stat = fs.statSync(manifestPath); } catch (_) { return null; }
  const cached = _manifestCache.get(cwd);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.manifest;
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch (_) { manifest = null; }
  _manifestCache.set(cwd, { mtimeMs: stat.mtimeMs, manifest });
  return manifest;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// The manifest is a flat map keyed by the file's path RELATIVE to .gm/instructions, written with
// the host OS's own path separator (observed as backslash on Windows, e.g. "gates\\long-gap-no-
// instruction.md") -- probe both separator forms so this reads correctly cross-platform whether
// the manifest was produced on the machine gmsniff is running on or a different one (a synced
// .gm/ directory, a shared dev environment, CI artifacts inspected after the fact).
function manifestHashFor(manifest, relPath) {
  if (!manifest) return undefined;
  return manifest[relPath] ?? manifest[relPath.split('/').join('\\')] ?? manifest[relPath.split('\\').join('/')];
}

// Is `filePath` (an absolute path under .gm/instructions/) exactly what ensureInstructionsBundle
// last auto-provisioned -- i.e. genuinely untouched since the daemon copied it, not a real
// per-project customization? Returns false (treat as a real override) whenever this can't be
// determined either way -- manifest missing, no entry for this specific file, or a read error --
// since under-reporting a real override as "still default" would hide genuine local
// customization from the observer, the opposite failure mode this function exists to prevent.
function matchesAutoProvisionedDefault(cwd, filePath) {
  const manifest = readShippedManifest(cwd);
  if (!manifest) return false;
  const relPath = path.relative(path.join(cwd, '.gm', 'instructions'), filePath);
  const shippedHash = manifestHashFor(manifest, relPath);
  if (!shippedHash) return false;
  let localHash;
  try { localHash = sha256Hex(fs.readFileSync(filePath)); } catch (_) { return false; }
  return localHash === shippedHash;
}

// Resolves which of the three prose.rs::resolve() tiers is actually serving a given
// instruction key for this project: (1) .gm/instructions/<key>.md, a per-project vendored
// override that always wins -- EXCEPT when that file's content still matches the manifest's
// last-known auto-provisioned hash, in which case it is genuinely still the compiled default,
// just materialized to disk by ensureInstructionsBundle rather than baked into the wasm guest
// (see matchesAutoProvisionedDefault above); (2) .gm/instructions/source.json + a matching
// .gm/instructions-source-cache/<key>.md, synced from a configured source repo; (3) neither,
// meaning the compiled default baked into the wasm guest is what's actually serving it. Covers
// both the phase-prose keys (plan/execute/emit/verify/consolidate/update_docs/entry/browser,
// written only by the fsm-vendor verb -- gm-plugkit's own auto-sync source tree carries no
// phase-level .md files, confirmed by reading it directly, so a phase key found on disk is
// ALWAYS fsm-vendor-sourced and therefore always a genuine per-project customization point, with
// no manifest-match short-circuit even if a stale manifest entry happens to exist for it) and the
// gate/residual namespace (gates/<name>, residual/<name>), which resolve through the identical
// chain per AGENTS.md but ARE auto-synced by ensureInstructionsBundle and therefore DO need the
// manifest check.
const AUTO_SYNCED_NAMESPACES = new Set(['gates', 'residual']);
export function resolveInstructionTier(cwd, key) {
  if (!key) return { tier: 'default', file_path: null, source_repo: null };
  const vendoredPath = path.join(cwd, '.gm', 'instructions', `${key}.md`);
  if (fs.existsSync(vendoredPath)) {
    const namespace = key.includes('/') ? key.split('/')[0] : null;
    const isAutoSyncedNamespace = namespace && AUTO_SYNCED_NAMESPACES.has(namespace);
    if (isAutoSyncedNamespace && matchesAutoProvisionedDefault(cwd, vendoredPath)) {
      return { tier: 'default', file_path: null, source_repo: null, auto_provisioned: true };
    }
    return { tier: 'vendored', file_path: vendoredPath, source_repo: null };
  }

  try {
    const sourceJsonPath = path.join(cwd, '.gm', 'instructions', 'source.json');
    const source = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf-8'));
    const cachePath = path.join(cwd, '.gm', 'instructions-source-cache', `${key}.md`);
    if (fs.existsSync(cachePath)) {
      return { tier: 'source-synced', file_path: cachePath, source_repo: source && source.repo ? source.repo : null };
    }
  } catch (_) {}

  // source.json present but no matching cache file for this specific key still falls through
  // to the compiled default -- the per-key cache miss, not the presence of source.json alone,
  // is what determines the real serving tier.
  return { tier: 'default', file_path: null, source_repo: null };
}

// The fsm-vendor verb (rs-plugkit's fsm_vendor::handle_vendor) writes a WIDER, DIFFERENT surface
// than ensureInstructionsBundle's own gates/residual auto-sync: the full phase-prose set
// (plan/execute/emit/verify/consolidate/update_docs/entry/browser -- these are ONLY ever written
// by fsm-vendor, gm-plugkit's own auto-sync source tree carries none of them, confirmed by
// reading it directly), the FSM graph itself (fsm/graph.json, genuinely load-bearing -- can
// redefine phases/edges/gates wholesale, not documentation), a compiled-predicates reference
// (fsm/predicates.md), an example jit-hook (hooks/example.js), and two example config files
// (browser-config.json, daemon-project-config.json) at .gm/ directly, not under .gm/instructions/.
// None of these are covered by the sha256 shipped-manifest (that mechanism belongs to
// ensureInstructionsBundle alone) -- fsm-vendor's own write_if_absent_or_forced is a one-shot,
// absence-gated write with no ongoing drift-tracking of its own, so presence here always means a
// deliberate local customization surface exists, even if a given file's content still happens to
// equal the compiled default it was seeded from (the project now OWNS that file going forward,
// unlike the gates/residual auto-sync case). This function has NO false-positive risk to guard
// against the way resolveInstructionTier did -- it only reports real, currently-present files.
const FSM_VENDOR_PHASE_KEYS = ['plan', 'execute', 'emit', 'verify', 'consolidate', 'update_docs', 'entry', 'browser'];
export function discoverVendoredSettings(cwd) {
  const instructionsDir = path.join(cwd, '.gm', 'instructions');
  const statOrNull = (p) => { try { return fs.statSync(p); } catch (_) { return null; } };
  const entryFor = (relLabel, absPath) => {
    const st = statOrNull(absPath);
    return { label: relLabel, path: absPath, present: !!st, size: st ? st.size : null, mtime_ts: st ? st.mtimeMs : null };
  };

  const phases = FSM_VENDOR_PHASE_KEYS.map((key) => entryFor(key, path.join(instructionsDir, `${key}.md`)));
  const fsmGraph = entryFor('fsm/graph.json', path.join(instructionsDir, 'fsm', 'graph.json'));
  const fsmPredicates = entryFor('fsm/predicates.md', path.join(instructionsDir, 'fsm', 'predicates.md'));
  const hookExample = entryFor('hooks/example.js', path.join(instructionsDir, 'hooks', 'example.js'));
  const browserConfig = entryFor('browser-config.json', path.join(cwd, '.gm', 'browser-config.json'));
  const daemonProjectConfig = entryFor('daemon-project-config.json', path.join(cwd, '.gm', 'daemon-project-config.json'));

  // Real hooks beyond the shipped example.js: any other .js file under .gm/instructions/hooks/,
  // since a project can add as many jit hooks as its graph.json's gates array references.
  const hooksDir = path.join(instructionsDir, 'hooks');
  let customHooks = [];
  try {
    customHooks = fs.readdirSync(hooksDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js') && e.name !== 'example.js')
      .map((e) => entryFor(`hooks/${e.name}`, path.join(hooksDir, e.name)));
  } catch (_) {}

  const allEntries = [...phases, fsmGraph, fsmPredicates, hookExample, ...customHooks, browserConfig, daemonProjectConfig];
  const presentEntries = allEntries.filter((e) => e.present);

  // A live-editable graph.json is the single highest-signal indicator that this project is
  // actually EXERCISING fsm-vendor's real customization surface (a different phase set, rewired
  // edges, a policy override) rather than just having leftover example files from a one-time run
  // -- surfaced as its own flag so a caller can badge/prioritize it distinctly from "some vendored
  // file exists".
  return {
    vendored: presentEntries.length > 0,
    has_custom_graph: fsmGraph.present,
    file_count: presentEntries.length,
    entries: presentEntries,
  };
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
// Kept in sync against ../gm (gm-plugkit) authoritative source: the orchestrator-verb match in
// rs-plugkit/crates/plugkit-core/src/orchestrator/mod.rs::is_orchestrator_verb plus the
// dispatch-verb match in rs-plugkit/crates/plugkit-core/src/wasm_dispatch/verbs.rs. Do not add
// a verb name here without a corresponding match arm in one of those two real sources --
// phantom entries pass isKnownVerb() but always dispatch to "unknown verb" downstream.
export const VERB_ALLOWLIST = new Set([
  // orchestrator verbs (is_orchestrator_verb)
  'instruction', 'transition', 'prd-add', 'prd-resolve', 'mutable-add', 'mutable-resolve',
  'mutable-list', 'prd-list', 'residual-scan', 'auto-recall', 'phase-status',
  'memorize-fire', 'memorize-continue', 'discipline-note',
  'task-spawn', 'task-list', 'task-stop', 'task-output',
  'fsm-vendor', 'claim-audit', 'submodule-check',
  // dispatch-verb match arms (verbs.rs)
  'fs_read', 'fs_write', 'fs_readdir', 'fs_stat', 'fetch', 'env_get',
  'kv_get', 'kv_put', 'kv_query', 'exec_js', 'lang', 'browser', 'health',
  'sql_open', 'sql_close', 'sql_list_dbs', 'sql_exec', 'sql_query', 'sql_smoke',
  'sql_serialize', 'sql_deserialize', 'codeinsight_index', 'codesearch',
  'memorize', 'memorize-prune', 'memorize_prune', 'recall',
  'bash', 'branch_status', 'git_status', 'git_push', 'git_add', 'git_commit',
  'git_finalize', 'git_log', 'git_diff', 'git_show', 'git_fetch', 'git_branch',
  'git_checkout', 'git_rm', 'git_revert', 'git_reset',
  // Accepted aliases (wasm_dispatch/verbs.rs match arms), not distinct verbs -- gmsniff must
  // recognize these or a real dispatch under an alias name reads as "unknown verb" downstream.
  'nodejs', 'javascript', 'node', 'js', 'python', 'py', 'sh', 'shell', 'zsh',
  'forget', 'discipline', 'close', 'filter', 'status',
  'learn', // retired: verbs.rs match arm always errors, but it IS a real recognized dispatch target
  // lang-runner verbs (shell_exec dispatch)
  'powershell', 'ps1', 'ssh', 'go', 'rust', 'c', 'cpp', 'java', 'deno',
  // Recognized verbs (verbs.rs match arms, though they return errors)
  'wait', 'sleep',
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
