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
      cur = { id: undefined, _start: i, _lines: [line], _boundary: bm[1] };
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

// Reads and parses a PRD or mutables yml file. Returns { text, mtimeMs, bytes, rows } or null
// if absent.
export function readYamlFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, 'utf-8');
    return { text, mtimeMs: stat.mtimeMs, bytes: stat.size, rows: parseYamlRows(text) };
  } catch (_) {
    return null;
  }
}

// ABSENT vs EMPTY. Both readPrd and readMutables returned {mtimeMs: null, rows: []} for a file
// that does not exist AND {mtimeMs: <n>, rows: []} for one that exists but parses to no rows --
// a distinction only recoverable by a caller re-stat'ing the file itself, which is exactly what
// server.js's yamlRowsPayload had to do to keep a missing store from rendering as a satisfied
// one (C:/dev/gm genuinely has no prd.yml, while an empty prd.yml is a real and different state:
// a store that exists and is closed out). Every caller needs that distinction, so `present` is
// reported here rather than reconstructed per-route. mtimeMs stays null when absent, so existing
// consumers keep their current behavior.
export function readPrd(cwd) {
  const f = readYamlFile(path.join(cwd, '.gm', 'prd.yml'));
  if (!f) return { present: false, mtimeMs: null, bytes: null, rows: [] };
  return {
    present: true,
    mtimeMs: f.mtimeMs,
    bytes: f.bytes,
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
  if (!f) return { present: false, mtimeMs: null, bytes: null, rows: [] };
  return {
    present: true,
    mtimeMs: f.mtimeMs,
    bytes: f.bytes,
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
  // The rewritten row keeps its ORIGINAL boundary field. parseYamlRows treats any top-level
  // `- <field>:` as a row boundary (gm's live prd.yml has a legacy `- title:` cluster with id as
  // a plain field), and unconditionally re-emitting `- id:` reshaped those rows on write --
  // moving the boundary onto a different key and demoting title to an indented field. That
  // contradicts this function's own byte-preservation contract for the row being edited, and
  // silently rewrote rows the caller never asked to restructure.
  const boundaryKey = target._boundary || 'id';
  const boundaryVal = merged[boundaryKey] !== undefined ? merged[boundaryKey] : id;
  const lines = [`- ${boundaryKey}: ${yamlScalar(boundaryVal)}`];
  for (const [k, v] of Object.entries(merged)) {
    if (k === boundaryKey || k.startsWith('_')) continue;
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      lines.push(`  ${k}:`);
      for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
      continue;
    }
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

function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}

function readTextOrNull(p) {
  try { return fs.readFileSync(p, 'utf-8').trim(); } catch (_) { return null; }
}

// Machine-global gm-plugkit install dir. Mirrors index.js's GM_TOOLS_DIR (kept local so
// registry.js has no import cycle with index.js).
export const GM_TOOLS_DIR = process.env.GM_TOOLS_DIR || path.join(os.homedir(), '.gm-tools');

// Machine-level daemon health from ~/.gm-tools/daemon-status.json ({pid, ts, active_projects}).
// This is the ONLY place a real daemon pid liveness check belongs: the pid in each project's
// .status.json is the same shared machine-wide daemon pid, so probing it per-project tells you
// nothing about that project (all projects flip together).
//
// ~/.gm-tools/daemon-status.json is NOT self-healing: a daemon that dies without unwinding leaves
// its pid there forever, and the successor daemon does not always rewrite it. Measured live, the
// global file held pid 4304 with a ts 3 DAYS old and dead, while every project's own .status.json
// carried pid 11132, freshly heartbeat and demonstrably alive. So this file alone answers
// "is a daemon up" wrong in exactly the case that matters. See daemonAliveFor below.
export function readDaemonStatus() {
  const j = readJsonOrNull(path.join(GM_TOOLS_DIR, 'daemon-status.json'));
  if (!j || !j.pid) return { present: false, pid: null, alive: false, ts: null, age_ms: null, active_projects: null };
  let alive = false;
  try { process.kill(j.pid, 0); alive = true; } catch (_) {}
  return {
    present: true,
    pid: j.pid,
    alive,
    ts: j.ts || null,
    age_ms: j.ts ? Date.now() - j.ts : null,
    active_projects: Number.isFinite(j.active_projects) ? j.active_projects : null,
  };
}

// Resolves daemon liveness for one project from BOTH pid sources, preferring whichever is
// actually verified alive rather than whichever file happened to be consulted.
//
// The bug this fixes: readWatcherStatus(cwd).daemon_alive probed the project's own .status.json
// pid and said true, while readProjectLiveness(cwd).daemon_alive probed only the machine-global
// daemon-status.json pid and said false -- for the same project in the same process at the same
// instant. Both were reporting the same machine-wide fact and contradicting each other, because
// the global file is stale-prone and the per-project one is rewritten every ~200ms.
//
// Precedence is by VERIFIED LIVENESS, not by file: an alive pid from either source wins over a
// dead pid from the other, and when both are alive the fresher heartbeat names the pid. Only when
// neither pid responds is daemon_alive false. This can never report false while a real daemon pid
// is demonstrably serving the project, which was the whole failure.
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

export function daemonAliveFor(status, daemon, { now = Date.now() } = {}) {
  const projectPid = status && status.pid ? status.pid : null;
  const globalPid = daemon && daemon.pid ? daemon.pid : null;
  const projectAlive = pidAlive(projectPid);
  const globalAlive = !!(daemon && daemon.alive);
  const projectAge = status && status.ts ? now - status.ts : null;
  const globalAge = daemon && daemon.ts ? now - daemon.ts : null;

  let pid = null, source = null;
  if (projectAlive && globalAlive) {
    // Both respond. The fresher heartbeat is the one actually serving; ties go to the
    // per-project file, which the live daemon rewrites continuously.
    const preferGlobal = projectAge !== null && globalAge !== null && globalAge < projectAge;
    pid = preferGlobal ? globalPid : projectPid;
    source = preferGlobal ? 'daemon-status.json' : 'status.json';
  } else if (projectAlive) {
    pid = projectPid; source = 'status.json';
  } else if (globalAlive) {
    pid = globalPid; source = 'daemon-status.json';
  }

  return {
    daemon_alive: projectAlive || globalAlive,
    daemon_pid: pid,
    daemon_pid_source: source,
    // Both pids are surfaced whenever they disagree, so a stale global file is visible as the
    // diagnostic it is rather than being silently papered over by the precedence rule.
    daemon_pid_project: projectPid,
    daemon_pid_global: globalPid,
    daemon_pid_conflict: !!(projectPid && globalPid && projectPid !== globalPid),
    daemon_status_stale: !!(globalPid && !globalAlive),
  };
}

// Machine-wide installed versions. These are INSTALL versions, distinct from the per-project
// SERVED version that index.js's readProjectLogSignals recovers from the watcher.log banner.
export function readInstalledVersions() {
  return {
    plugkit: readTextOrNull(path.join(GM_TOOLS_DIR, 'plugkit.version')),
    gm_plugkit: readTextOrNull(path.join(GM_TOOLS_DIR, 'gm-plugkit.version')),
  };
}

// Per-project liveness derived from REAL per-project signals, never the shared daemon pid.
//
// .status.json's `pid` is one machine-wide agentplug daemon serving every project at once
// (confirmed: identical pid 3364 across gmsniff/spoint/casey/test simultaneously), so
// process.kill(pid,0) is true for every project whenever the daemon runs at all -- including
// projects that have been idle for weeks. It answers "is the daemon up", never "is this project
// active". The real per-project signals are: the heartbeat ts .status.json carries for THIS
// project, this project's watcher.log mtime, its turn-summary ts, and its spool queue depth.
export const PROJECT_ACTIVE_MS = parseInt(process.env.GM_PROJECT_ACTIVE_MS, 10) || 5 * 60 * 1000;

function spoolQueueDepth(spoolDir) {
  let pending = 0;
  try {
    for (const verbDir of fs.readdirSync(path.join(spoolDir, 'in'), { withFileTypes: true })) {
      if (!verbDir.isDirectory()) continue;
      try { pending += fs.readdirSync(path.join(spoolDir, 'in', verbDir.name)).filter(f => !f.startsWith('.')).length; } catch (_) {}
    }
  } catch (_) {}
  return pending;
}

export function readProjectLiveness(cwd, { now = Date.now() } = {}) {
  const spoolDir = path.join(cwd, '.gm', 'exec-spool');
  const status = readJsonOrNull(path.join(spoolDir, '.status.json'));
  const summary = readJsonOrNull(path.join(spoolDir, '.turn-summary.json'));
  const watcherMtime = statMtimeMs(path.join(spoolDir, '.watcher.log'));
  const turnState = readTurnState(cwd);

  // .status.json's ts is DELIBERATELY EXCLUDED from the activity computation. Measured live:
  // the shared daemon rewrites every registered project's .status.json every ~200ms regardless
  // of whether that project is doing anything, so its age is ~0 for every project always
  // (gmsniff 281ms, spoint 131ms, casey 210ms, test 258ms -- simultaneously, while casey's real
  // work was 2.2 hours cold). Treating it as activity marks the entire fleet permanently active,
  // which is the same false-positive as trusting the shared pid, one layer down. It is reported
  // as heartbeat_age_ms for diagnostics only.
  const heartbeat_age_ms = status && status.ts ? now - status.ts : null;

  const ages = [];
  const log_age_ms = watcherMtime !== null ? now - watcherMtime : null;
  if (log_age_ms !== null) ages.push(log_age_ms);
  const summary_age_ms = summary && summary.ts ? now - summary.ts : null;
  if (summary_age_ms !== null) ages.push(summary_age_ms);
  const turn_age_ms = turnState && turnState.updated_at_ms ? now - turnState.updated_at_ms : null;
  if (turn_age_ms !== null) ages.push(turn_age_ms);

  const last_activity_age_ms = ages.length ? Math.min(...ages) : null;
  const queue_depth = spoolQueueDepth(spoolDir);
  const daemon = readDaemonStatus();
  const daemonState = daemonAliveFor(status, daemon, { now });

  return {
    // Real per-project activity, the field a caller should badge on: derived only from signals
    // this project's own work writes (watcher.log mtime, turn-summary ts, turn-state ts).
    active: last_activity_age_ms !== null && last_activity_age_ms <= PROJECT_ACTIVE_MS,
    last_activity_age_ms,
    activity_sources: { log_age_ms, summary_age_ms, turn_age_ms },
    heartbeat_age_ms,
    log_age_ms,
    summary_age_ms,
    turn_age_ms,
    queue_depth,
    // Machine-level, deliberately named apart from `active` so it can never be mistaken for a
    // per-project signal. Resolved across both pid sources -- see daemonAliveFor.
    ...daemonState,
    shared_process: !!(status && status.shared_process),
  };
}

// .gm/turn-state.json -- the authoritative live phase source, written on every transition.
// Two real on-disk shapes exist: the current {phase, session_id, last_skill, updated_at_ms,
// pending_step_id, pending_step_deadline_ms}, and a legacy shape carrying only
// {turnId, execCallsSinceMemorize, firstToolFired, recallFiredThisTurn} and NO phase at all.
//
// The legacy branch is KEPT even though no current code path writes it. ../gm's only writer is
// orchestrator/state.rs::write_state, which serializes the current six-field TurnState struct, so
// nothing produces the legacy shape any more -- but 20 of 85 real projects on this machine still
// HAVE that file on disk (ai-animate-vrm, cam, flatspace, test, ...), unmodified since before the
// cutover. gmsniff reads what is on disk, not what the current writer emits, so removing the
// branch would silently reclassify 20 real projects as "phase: null" -- a project idle in no
// phase -- instead of "present but phaseless", which is what they actually are.
//
// A third state exists and is distinct from both: gm's lib.rs resets the file by writing `{}`,
// which its own deserializer then rejects (phase/session_id/last_skill/updated_at_ms carry no
// serde default), backing the file up to turn-state.json.corrupted-<ts> and restarting at PLAN.
// 98 such backups exist on disk right now. A bare `{}` is a RESET, not a legacy file, and is
// reported as reset_shape so it is not misread as either.
export function readTurnState(cwd) {
  const j = readJsonOrNull(path.join(cwd, '.gm', 'turn-state.json'));
  if (!j) return null;
  const keys = Object.keys(j);
  const legacy = !('phase' in j) && ('turnId' in j);
  const reset = keys.length === 0;
  return {
    present: true,
    legacy_shape: legacy,
    reset_shape: reset,
    phase: typeof j.phase === 'string' ? j.phase : null,
    session_id: j.session_id || null,
    last_skill: j.last_skill || null,
    updated_at_ms: Number.isFinite(j.updated_at_ms) ? j.updated_at_ms : null,
    pending_step_id: j.pending_step_id || null,
    pending_step_deadline_ms: Number.isFinite(j.pending_step_deadline_ms) ? j.pending_step_deadline_ms : null,
    turn_id: j.turnId || null,
  };
}

// The remaining per-project marker files, none of which were previously read. Each is small and
// carries live state a live-manager view wants: dispatch/instruction heartbeat timestamps, the
// last prompt body, gate-fire markers, the codeinsight digest, and the poll-scan cursor.
export function readProjectMarkers(cwd) {
  const gm = path.join(cwd, '.gm');
  const spool = path.join(gm, 'exec-spool');
  const num = (p) => { const t = readTextOrNull(p); const n = t ? Number(t) : NaN; return Number.isFinite(n) ? n : null; };

  const lastGate = readJsonOrNull(path.join(spool, '.last-gate-fired.json'));
  const digestRaw = readTextOrNull(path.join(spool, '.codeinsight-digest'));
  // Real format: "v3:<hash>:files=<n>"
  const dm = digestRaw ? digestRaw.match(/^v(\d+):([0-9a-f]+):files=(\d+)$/) : null;
  const pollScan = readJsonOrNull(path.join(spool, '.poll-scan-offset.json'));
  const claimAudit = readTextOrNull(path.join(gm, 'claim-audit-fired'));
  const residual = readTextOrNull(path.join(gm, 'residual-check-fired'));

  return {
    last_dispatch_ts: num(path.join(gm, 'last-dispatch-ts')),
    last_instruction_ts: num(path.join(gm, 'last-instruction-ts')),
    last_prompt: readTextOrNull(path.join(gm, 'last-prompt.txt')),
    // Marker files exist-or-not AND carry a body ("clean" observed for claim-audit; empty for
    // residual) -- both facts are surfaced, since an empty marker is still a fired marker.
    claim_audit_fired: claimAudit !== null,
    claim_audit_result: claimAudit || null,
    residual_check_fired: residual !== null,
    residual_check_result: residual || null,
    last_gate: lastGate && lastGate.key ? { key: lastGate.key, ts: lastGate.ts || null } : null,
    gate_deviation_repeats: readJsonOrNull(path.join(spool, '.gate-deviation-repeats.json')) || {},
    codeinsight_digest: dm ? { version: Number(dm[1]), hash: dm[2], files: Number(dm[3]), raw: digestRaw } : (digestRaw ? { raw: digestRaw } : null),
    poll_scan: pollScan ? { date: pollScan.date || null, last_scan_ms: pollScan.last_scan_ms || null, offset: Number.isFinite(pollScan.offset) ? pollScan.offset : null } : null,
  };
}

// Fully consumes .gm/exec-spool/.turn-summary.json. Every field is real and current:
// {last_instruction_age_ms, last_instruction_ts, long_gap_threshold_ms, mutables_pending_count,
//  phase, prd_pending, prd_pending_count, runtime, ts, update_available}.
//
// runtime-key collision: .turn-summary.json's `runtime` is the EXECUTION runtime of the wasm
// guest (observed "native"), while .status.json's `runtime` is the HOST process kind (observed
// "agentplug"). Same key name, two different meanings, and conflating them would report a
// project as running under the wrong runtime. They are surfaced under distinct names --
// guest_runtime here, host_runtime in readWatcherStatus -- and never merged.
export function readTurnSummary(cwd) {
  const j = readJsonOrNull(path.join(cwd, '.gm', 'exec-spool', '.turn-summary.json'));
  if (!j) return null;
  return {
    present: true,
    phase: typeof j.phase === 'string' ? j.phase : null,
    ts: Number.isFinite(j.ts) ? j.ts : null,
    last_instruction_ts: Number.isFinite(j.last_instruction_ts) ? j.last_instruction_ts : null,
    last_instruction_age_ms: Number.isFinite(j.last_instruction_age_ms) ? j.last_instruction_age_ms : null,
    long_gap_threshold_ms: Number.isFinite(j.long_gap_threshold_ms) ? j.long_gap_threshold_ms : null,
    // Both spellings are real: prd_pending_count is what instruction.served emits and what the
    // summary carries today; prd_pending is the older field, still present in the same file.
    prd_pending_count: Number.isFinite(j.prd_pending_count) ? j.prd_pending_count : (Number.isFinite(j.prd_pending) ? j.prd_pending : null),
    mutables_pending_count: Number.isFinite(j.mutables_pending_count) ? j.mutables_pending_count : null,
    guest_runtime: j.runtime || null,
    update_available: j.update_available ?? null,
  };
}

export function readWatcherStatus(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cwd, '.gm', 'exec-spool', '.status.json'), 'utf-8'));
    if (!j || !j.pid) return null;
    const age = j.ts ? Date.now() - j.ts : null;
    // Current live shape is the agentplug shared daemon: {pid, ts, daemon, shared_process,
    // runtime:"agentplug"} -- it carries NO version, wrapper_sha, idle_limit_ms or busy_until.
    // Those keys are kept in the returned shape for consumer compatibility but are sourced
    // honestly: version comes from the watcher.log banner via index.js readProjectLogSignals
    // (the only real per-project version signal left), not from this file, so it stays null here
    // rather than being fabricated. wrapper_sha/idle_limit_ms exist only in the legacy per-
    // project JS-wrapper shape and are null on every current-generation project.
    //
    // `alive` is DAEMON liveness, not project liveness: this pid is one machine-wide daemon
    // shared by every project, so it is identical across all of them and flips them together.
    // Use readProjectLiveness(cwd).active for a real per-project answer.
    //
    // Resolved through the SAME daemonAliveFor precedence readProjectLiveness uses, so the two
    // functions can never again return opposite daemon_alive values for one project in one
    // process at one instant (the real contradiction: this said true on the live per-project pid
    // while readProjectLiveness said false on a 3-day-stale global pid).
    const d = daemonAliveFor(j, readDaemonStatus());
    const alive = d.daemon_alive;
    const runtime = j.runtime || (j.version ? 'wrapper' : null);
    return {
      pid: j.pid,
      version: j.version || null,
      version_source: j.version ? 'status.json' : null,
      wrapper_sha: j.wrapper_sha || null,
      idle_limit_ms: j.idle_limit_ms || null,
      runtime,
      host_runtime: runtime,
      daemon: !!j.daemon,
      shared_process: !!j.shared_process,
      alive,
      daemon_alive: alive,
      daemon_pid: d.daemon_pid,
      daemon_pid_source: d.daemon_pid_source,
      daemon_pid_conflict: d.daemon_pid_conflict,
      daemon_status_stale: d.daemon_status_stale,
      shared_pid: !!j.shared_process,
      age_ms: age,
    };
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
// Every registry cache is bounded. These are keyed by project cwd and a machine can accumulate
// far more discovered cwds than are live (the daemon registry alone lists deleted worktrees),
// so an unbounded Map is a slow leak in a long-running GUI server process. LRU-by-insertion:
// re-setting a key refreshes its position.
const REGISTRY_CACHE_MAX = parseInt(process.env.GM_REGISTRY_CACHE_MAX, 10) || 256;

function cacheSet(map, key, value, max = REGISTRY_CACHE_MAX) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}

function cacheGet(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}

const _prdMutStateCache = new Map(); // cwd -> { prdMtime, mutMtime, value }

function statMtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return null; }
}

// Closed-status vocabulary is POLICY, not a fact about the file format. gm's own prd.yml uses
// done/complete/completed today, but a project can adopt any closed-status word, and hardcoding
// the list silently miscounts every row using another one as still-pending. Overridable via
// GM_PRD_CLOSED_STATUSES / GM_MUT_OPEN_STATUSES (comma-separated), with the observed gm defaults
// retained. Mutables invert the question: `unknown` is the OPEN state, everything else closed.
function policyList(envKey, fallback) {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const items = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : fallback;
}

export function prdClosedStatuses() {
  return policyList('GM_PRD_CLOSED_STATUSES', ['done', 'complete', 'completed']);
}

export function mutableOpenStatuses() {
  return policyList('GM_MUT_OPEN_STATUSES', ['unknown']);
}

export function statusPolicy() {
  return { prd_closed: prdClosedStatuses(), mutable_open: mutableOpenStatuses(), default_prd_status: 'pending', default_mutable_status: 'unknown' };
}

export function readPrdMutablesState(cwd) {
  const prdPath = path.join(cwd, '.gm', 'prd.yml');
  const mutPath = path.join(cwd, '.gm', 'mutables.yml');
  const prdMtime = statMtimeMs(prdPath);
  const mutMtime = statMtimeMs(mutPath);
  const policy = statusPolicy();
  const policyKey = `${policy.prd_closed.join('|')}#${policy.mutable_open.join('|')}`;
  const cached = cacheGet(_prdMutStateCache, cwd);
  if (cached && cached.prdMtime === prdMtime && cached.mutMtime === mutMtime && cached.policyKey === policyKey) return cached.value;

  // Counted through parseYamlRows, the SAME parser readPrd/readMutables use, rather than a
  // second `split(/^- id:/m)` implementation of "what is a row". Those two answers disagreed on
  // real data: ../gm's live mutables.yml has 259 rows, of which only 218 open with `- id:` --
  // the other 41 use a legacy boundary key (mutable_id 21, text 10, subject 4, name 2, prd_id 2,
  // title 1, repo 1), exactly the cluster parseYamlRows's boundary rule exists to catch. The
  // split path silently undercounted mut_total by 41 and could not see those rows' status at
  // all; all 41 happen to be closed today, so mut_unknown was coincidentally right, and the next
  // open row written in that shape would have been invisible to every pending count in the GUI.
  // Status is read off the parsed field, not regex-tested against the row's raw text, so a
  // status word appearing inside a claim/witness string can no longer be mistaken for the row's
  // own status.
  const closedSet = new Set(policy.prd_closed);
  const openSet = new Set(policy.mutable_open);
  const out = { prd_present: false, prd_pending: 0, prd_total: 0, mut_present: false, mut_unknown: 0, mut_total: 0 };
  try {
    const rows = parseYamlRows(fs.readFileSync(prdPath, 'utf-8'));
    out.prd_present = true;
    out.prd_total = rows.length;
    out.prd_pending = rows.filter(r => !closedSet.has(String(r.status || 'pending').toLowerCase())).length;
  } catch (_) {}
  try {
    const rows = parseYamlRows(fs.readFileSync(mutPath, 'utf-8'));
    out.mut_present = true;
    out.mut_total = rows.length;
    out.mut_unknown = rows.filter(r => openSet.has(String(r.status || 'unknown').toLowerCase())).length;
  } catch (_) {}
  cacheSet(_prdMutStateCache, cwd, { prdMtime, mutMtime, policyKey, value: out });
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
  const summaryPath = path.join(cwd, '.gm', 'exec-spool', '.turn-summary.json');
  const turnStatePath = path.join(cwd, '.gm', 'turn-state.json');
  const mtime = statMtimeMs(nextStepPath);
  // Cache key covers EVERY file whose content this result depends on. Keying on next-step.md's
  // mtime alone served a stale phase whenever turn-state.json or turn-summary.json changed
  // without next-step.md being rewritten -- which is the common case, since a transition updates
  // turn-state.json on every phase change while next-step.md only changes when new prose is
  // served (real divergence: gmsniff turn-state EXECUTE vs turn-summary PLAN, casey turn-state
  // COMPLETE vs turn-summary CONSOLIDATE, both observed simultaneously).
  const summaryMtime = statMtimeMs(summaryPath);
  const turnStateMtime = statMtimeMs(turnStatePath);
  const turnState = readTurnState(cwd);

  if (mtime === null) {
    // next-step.md absent but turn-state.json can still carry a real phase.
    if (turnState && turnState.phase) {
      return {
        phase: turnState.phase, skill: turnState.last_skill || null, instruction_heading: null,
        instruction_excerpt: null, updated_ts: turnState.updated_at_ms, stale: true, present: false,
        phase_source: 'turn-state.json', session_id: turnState.session_id || null,
      };
    }
    return { phase: null, skill: null, instruction_heading: null, instruction_excerpt: null, updated_ts: null, stale: true, present: false, phase_source: null };
  }
  const cached = cacheGet(_phaseStateCache, cwd);
  if (cached && cached.mtime === mtime && cached.summaryMtime === summaryMtime && cached.turnStateMtime === turnStateMtime) return cached.value;

  let value;
  try {
    const text = fs.readFileSync(nextStepPath, 'utf-8');
    const phaseMatch = text.match(/^Phase:\s*(.+)$/m);
    const updatedMatch = text.match(/^Updated:\s*(\d+)$/m);
    const bodyIdx = text.indexOf('\n---\n');
    const body = bodyIdx >= 0 ? text.slice(bodyIdx + 5).trimStart() : '';
    const headingMatch = body.match(/^#\s*(.+?)\s*$/m);
    const heading = headingMatch ? headingMatch[1].trim().toUpperCase() : null;
    // turn-state.json is the PRIMARY phase source: it is written by the transition itself and is
    // structured, where next-step.md's "Phase:" line is prose that is only rewritten when new
    // instruction text is served. The prose scrape remains the fallback for projects whose
    // turn-state.json is absent or carries the legacy phaseless {turnId,...} shape.
    const prosePhase = phaseMatch ? phaseMatch[1].trim() : heading;
    const useTurnState = !!(turnState && turnState.phase);
    const phase = useTurnState ? turnState.phase : prosePhase;
    const proseUpdated = updatedMatch ? Number(updatedMatch[1]) : null;
    const updated_ts = useTurnState && turnState.updated_at_ms ? turnState.updated_at_ms : proseUpdated;
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
      phase_source: useTurnState ? 'turn-state.json' : 'next-step.md',
      // The prose phase is retained alongside so a divergence between the structured source and
      // the served instruction text is visible rather than silently resolved -- a project whose
      // turn-state says EXECUTE while the served prose still reads PLAN is mid-transition, and
      // that IS the signal a live-manager view wants.
      prose_phase: prosePhase || null,
      phase_divergence: !!(useTurnState && prosePhase && prosePhase !== turnState.phase),
      session_id: turnState ? turnState.session_id : null,
      last_skill: turnState ? turnState.last_skill : null,
    };
  } catch (_) {
    // Partial write mid-update or unreadable content -- fail open to an unparseable-but-present
    // state rather than throwing, so one bad project's file doesn't break every other row.
    value = { phase: null, skill: null, instruction_heading: null, instruction_excerpt: null, updated_ts: null, stale: true, present: true, unparseable: true, phase_source: null };
  }
  cacheSet(_phaseStateCache, cwd, { mtime, summaryMtime, turnStateMtime, value });
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
  const cached = cacheGet(_manifestCache, cwd);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.manifest;
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch (_) { manifest = null; }
  cacheSet(_manifestCache, cwd, { mtimeMs: stat.mtimeMs, manifest });
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

// Authoritative deep-path discovery source. daemon-registry.txt lists every cwd the shared
// daemon has served, INCLUDING worktree-hosted projects nested several levels deep
// (C:\dev\spoint\.claude\worktrees\wf_*) that a one-level readdir of the dev roots structurally
// cannot reach. It is append-only and never self-prunes -- measured live, only 3 of its 12
// entries still exist on disk -- so it is a discovery HINT whose every candidate must be
// existence-filtered, never a liveness list.
export function readDaemonRegistryCwds() {
  try {
    return fs.readFileSync(path.join(GM_TOOLS_DIR, 'daemon-registry.txt'), 'utf-8')
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}

// discoverProjects re-derives its cwd SET from O(events)/O(fs) sources every call. The cache is
// keyed on the events array IDENTITY plus its length, not length alone: a Store that replaces
// its events array (a re-load, a source switch, a bounded-window re-read) can produce a
// different array with a coincidentally equal length, and a length-only key would then serve the
// previous source's cwd set indefinitely. A TTL additionally bounds staleness for the fs-scan
// half, which changes independent of events entirely.
const CWDSET_TTL_MS = parseInt(process.env.GM_CWDSET_TTL_MS, 10) || 30000;
let _cwdSetCache = { eventsRef: null, eventsLength: -1, rootsKey: null, at: 0, cwds: null };
function discoverCwdSet(events, extraRoots) {
  const arr = events || [];
  const len = arr.length;
  const rootsKey = (extraRoots || []).join('|');
  const fresh = Date.now() - _cwdSetCache.at < CWDSET_TTL_MS;
  if (fresh && _cwdSetCache.cwds && _cwdSetCache.eventsRef === arr && _cwdSetCache.eventsLength === len && _cwdSetCache.rootsKey === rootsKey) {
    return _cwdSetCache.cwds;
  }

  const cwds = new Set();
  const norm = new Map();
  const addCwd = (p) => { if (!p) return; const k = canon(p); if (!k) return; if (!norm.has(k)) { norm.set(k, p); cwds.add(p); } };

  for (const e of arr) {
    if (e._sub === 'plugkit' && e.event === 'watcher.boot' && e.spool_dir) {
      addCwd(path.dirname(path.dirname(e.spool_dir)));
    } else if (e.cwd) {
      addCwd(e.cwd);
    }
  }

  // Registry candidates are existence-filtered on the real marker, exactly like a scanned root.
  for (const p of readDaemonRegistryCwds()) {
    try { if (fs.existsSync(path.join(p, '.gm', 'exec-spool', '.status.json'))) addCwd(p); } catch (_) {}
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
        // Second level: worktree hosts keep their projects under <root>/<proj>/.claude/worktrees/
        // (real shape from daemon-registry.txt). A one-level scan misses every one of them.
        const wt = path.join(proj, '.claude', 'worktrees');
        try {
          for (const w of fs.readdirSync(wt, { withFileTypes: true })) {
            if (!w.isDirectory()) continue;
            const wproj = path.join(wt, w.name);
            if (fs.existsSync(path.join(wproj, '.gm', 'exec-spool', '.status.json'))) addCwd(wproj);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  _cwdSetCache = { eventsRef: arr, eventsLength: len, rootsKey, at: Date.now(), cwds };
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
    const live = readProjectLiveness(cwd);
    const turnState = readTurnState(cwd);
    rows.push({
      cwd,
      // `alive` now means THIS PROJECT is active, derived from its own watcher.log/turn-summary/
      // turn-state timestamps. It previously meant "the shared daemon pid responds", which was
      // true for every discovered project simultaneously and so distinguished nothing.
      alive: live.active,
      daemon_alive: live.daemon_alive,
      last_activity_age_ms: live.last_activity_age_ms,
      queue_depth: live.queue_depth,
      phase: turnState ? turnState.phase : null,
      last_skill: turnState ? turnState.last_skill : null,
      // Per-project served version does not live in .status.json any more; index.js's
      // readProjectLogSignals recovers it from the watcher.log banner. Null here is honest
      // rather than fabricated -- see readWatcherStatus's version_source.
      version: status ? status.version : null,
      version_source: status ? status.version_source : null,
      prd_pending: ps.prd_pending,
      prd_total: ps.prd_total,
      mut_unknown: ps.mut_unknown,
      mut_total: ps.mut_total,
    });
  }
  rows.sort((a, b) => (b.alive ? 1 : 0) - (a.alive ? 1 : 0)
    || (a.last_activity_age_ms ?? Infinity) - (b.last_activity_age_ms ?? Infinity)
    || path.basename(a.cwd).localeCompare(path.basename(b.cwd)));
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
  // lang-runner verbs (shell_exec dispatch)
  'powershell', 'ps1', 'ssh', 'go', 'rust', 'c', 'cpp', 'java', 'deno',
  // Runner-level verbs handled by the agentplug daemon itself, not the wasm guest
  // (agentplug/crates/agentplug-runner/src/daemon.rs: handle_plugin_refresh_request,
  // handle_background_convert, and the in/background-convert spool directory).
  'plugin-refresh', 'background-convert',
  // RETIRED verbs. These are still real match arms in verbs.rs, so a dispatch under one of these
  // names is recognized rather than falling through to "unknown verb" -- but the arm always
  // returns an error, so it can never succeed. Kept in the allowlist so gmsniff classifies a
  // real dispatch correctly, and listed in RETIRED_VERBS so a caller can warn instead of
  // presenting them as usable.
  'learn', 'wait', 'sleep',
]);

// verbs.rs arms that exist purely to return an informative error:
//   "learn" -> "verb retired: the rs-learn crate is removed; memory routes through
//               memorize/recall/memorize-prune"
//   "wait" | "sleep" -> "verb not supported: wasm has no real timer/async-sleep primitive here"
export const RETIRED_VERBS = new Set(['learn', 'wait', 'sleep']);

const VERB_SHAPE = /^[a-zA-Z0-9_-]+$/;

export function isKnownVerb(verb) {
  return typeof verb === 'string' && VERB_SHAPE.test(verb) && VERB_ALLOWLIST.has(verb);
}

export function isRetiredVerb(verb) {
  return typeof verb === 'string' && RETIRED_VERBS.has(verb);
}

// Usable = recognized AND not one of the always-error retired arms.
export function isUsableVerb(verb) {
  return isKnownVerb(verb) && !isRetiredVerb(verb);
}

export function isAllowedProjectCwd(cwd, allowedCwds) {
  if (!cwd || typeof cwd !== 'string') return false;
  if (cwd.includes('..')) return false;
  const target = canon(cwd);
  if (!target) return false;
  return allowedCwds.some(c => canon(c) === target);
}
