import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// gm's own live prd.yml carries a legacy row cluster shaped `- title: <text>` with `id:` as a
// plain field further down -- 11 real rows, including severity-tagged ones, that a `- id:`-only
// boundary rule dropped entirely from readPrd(). Hence ANY top-level `- <field>:` opens a row.
const ROW_BOUNDARY_LINE = /^- ([a-zA-Z_][\w]*):\s?(.*)$/;
const FIELD_LINE = /^\s{2}([a-zA-Z_][\w]*):\s?(.*)$/;
const BLOCK_LIST_ITEM_LINE = /^\s{2}-\s+(.*)$/;

const EMPTY_FIELD_VALUE = '';

// -> [{id, <fields>..., _raw, _start, _end, _boundary}]. `_raw` is the exact source slice from
// the boundary line onward, so rewriteRow can put every untouched row back byte-for-byte.
export function parseYamlRows(text) {
  if (!text) return [];
  // gm writes these files with the host's own line endings, so on Windows they arrive CRLF. A
  // trailing \r left on each line makes every boundary and field regex fail its `$` anchor, and
  // the file parses to ZERO rows -- gmsniff reading its own PRD store as empty while 15 rows sit
  // in it. Strip the \r for matching only; _start/_end still index the original lines so
  // rewriteRow puts every untouched row back byte-for-byte, CRLF included.
  const lines = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const rows = [];
  let cur = null;
  let fieldAccumulatingBlockList = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const boundary = line.match(ROW_BOUNDARY_LINE);
    if (boundary) {
      if (cur) { cur._end = i; rows.push(cur); }
      cur = { id: undefined, _start: i, _lines: [line], _boundary: boundary[1] };
      cur[boundary[1]] = unquote(boundary[2].trim());
      if (boundary[1] === 'id') cur.id = cur[boundary[1]];
      fieldAccumulatingBlockList = null;
      continue;
    }
    if (cur) {
      if (fieldAccumulatingBlockList && BLOCK_LIST_ITEM_LINE.test(line)) {
        cur._lines.push(line);
        cur[fieldAccumulatingBlockList].push(unquote(line.match(BLOCK_LIST_ITEM_LINE)[1].trim()));
        continue;
      }
      if (fieldAccumulatingBlockList && cur[fieldAccumulatingBlockList].length === 0) {
        cur[fieldAccumulatingBlockList] = EMPTY_FIELD_VALUE;
      }
      fieldAccumulatingBlockList = null;
      cur._lines.push(line);
      const fm = line.match(FIELD_LINE);
      if (fm) {
        if (fm[2].trim() === '') { cur[fm[1]] = []; fieldAccumulatingBlockList = fm[1]; }
        else cur[fm[1]] = unquote(fm[2].trim());
        if (fm[1] === 'id') cur.id = cur[fm[1]];
      }
    }
  }
  if (cur) { cur._end = lines.length; rows.push(cur); }
  for (const r of rows) {
    r._raw = r._lines.join('\n');
    delete r._lines;
    for (const k of Object.keys(r)) {
      if (Array.isArray(r[k]) && r[k].length === 0) r[k] = EMPTY_FIELD_VALUE;
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

// Quotes only what plain YAML actually requires. A space is not one of those things: requiring
// [\w./-] meant every multi-word value came back quoted, so rewriting one row reshaped the text
// of every other field on it -- "- subject: legacy boundary row" became "- subject: 'legacy
// boundary row'" and the byte-preservation promise this function makes was broken by its own
// re-emit rather than by the caller.
function yamlScalar(s) {
  s = String(s == null ? '' : s);
  if (s === '') return "''";
  const needsQuoting = /^[\s-]|[\s]$|[:#'"\[\]{}|>&*!%@`,]/.test(s)
    || /^(true|false|null|~|yes|no|on|off)$/i.test(s)
    || /^-?\d+(\.\d+)?$/.test(s);
  if (!needsQuoting) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

export function readYamlFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, 'utf-8');
    return { text, mtimeMs: stat.mtimeMs, bytes: stat.size, rows: parseYamlRows(text) };
  } catch (_) {
    return null;
  }
}

// `present` distinguishes an ABSENT store from an empty one -- C:/dev/gm genuinely has no
// prd.yml, while an empty prd.yml is the different and real state of a store closed out.
export function readPrd(cwd) {
  const f = readYamlFile(path.join(cwd, '.gm', 'prd.yml'));
  if (!f) return { present: false, mtimeMs: null, bytes: null, rows: [] };
  return {
    present: true,
    mtimeMs: f.mtimeMs,
    bytes: f.bytes,
    // Measured across ../gm/.gm/prd.yml: `text` 868 occurrences and 100% of the most recent 300
    // rows; note/subject are older minority conventions; `body` is superseded (66 body-only rows,
    // none in the recent tail) and so is the lowest-priority fallback. severity ~0.5% of rows,
    // tags ~1.8%. desc/description/detail/title/acceptance/scope were tried and rejected: they
    // are alternate spellings of the same free text, not new signal.
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

// Returns the new full file text with only `id`'s row rewritten, or null if id is not found.
export function rewriteRow(text, id, fields) {
  const rows = parseYamlRows(text);
  const idx = rows.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const target = rows[idx];
  const merged = { ...target, ...fields };
  // Unconditionally re-emitting `- id:` was tried and rejected: on the legacy `- title:` cluster
  // it moved the boundary onto a different key and demoted title to an indented field,
  // restructuring rows the caller never asked to touch.
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

export const GM_TOOLS_DIR = process.env.GM_TOOLS_DIR || path.join(os.homedir(), '.gm-tools');
export const AGENTPLUG_DIR = process.env.AGENTPLUG_DIR || path.join(os.homedir(), '.agentplug');

export function readDaemonStatus() {
  const j = readJsonOrNull(path.join(AGENTPLUG_DIR, 'daemon-status.json'));
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

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// Resolving by whichever file the caller happened to consult was tried and rejected: it made
// readWatcherStatus(cwd).daemon_alive say true off the per-project pid while
// readProjectLiveness(cwd).daemon_alive said false off the stale global pid, for the same project
// in the same process at the same instant. Precedence here is by VERIFIED LIVENESS instead.
export function daemonAliveFor(status, daemon, { now = Date.now() } = {}) {
  const projectPid = status && status.pid ? status.pid : null;
  const globalPid = daemon && daemon.pid ? daemon.pid : null;
  const projectPidResponds = pidAlive(projectPid);
  const globalPidResponds = !!(daemon && daemon.alive);
  const projectHeartbeatAge = status && status.ts ? now - status.ts : null;
  const globalHeartbeatAge = daemon && daemon.ts ? now - daemon.ts : null;

  let pid = null, source = null;
  if (projectPidResponds && globalPidResponds) {
    const globalHeartbeatIsFresher = projectHeartbeatAge !== null && globalHeartbeatAge !== null
      && globalHeartbeatAge < projectHeartbeatAge;
    pid = globalHeartbeatIsFresher ? globalPid : projectPid;
    source = globalHeartbeatIsFresher ? 'daemon-status.json' : 'status.json';
  } else if (projectPidResponds) {
    pid = projectPid; source = 'status.json';
  } else if (globalPidResponds) {
    pid = globalPid; source = 'daemon-status.json';
  }

  return {
    daemon_alive: projectPidResponds || globalPidResponds,
    daemon_pid: pid,
    daemon_pid_source: source,
    daemon_pid_project: projectPid,
    daemon_pid_global: globalPid,
    daemon_pid_conflict: !!(projectPid && globalPid && projectPid !== globalPid),
    daemon_status_stale: !!(globalPid && !globalPidResponds),
  };
}

// INSTALL versions, distinct from the per-project SERVED version index.js's
// readProjectLogSignals recovers from the watcher.log banner.
export function readInstalledVersions() {
  return {
    plugkit: readTextOrNull(path.join(GM_TOOLS_DIR, 'plugkit.version')),
    gm_plugkit: readTextOrNull(path.join(GM_TOOLS_DIR, 'gm-plugkit.version')),
  };
}

// .status.json's `pid` is one machine-wide agentplug daemon serving every project at once
// (confirmed: identical pid 3364 across gmsniff/spoint/casey/test simultaneously), so
// process.kill(pid,0) is true for every project whenever the daemon runs at all -- including
// projects idle for weeks. It answers "is the daemon up", never "is this project active".
export const PROJECT_ACTIVE_MS = parseInt(process.env.GM_PROJECT_ACTIVE_MS, 10) || 5 * 60 * 1000;

// The spool ABI is in/<verb>/<N>.txt, so a file with any other extension sits
// there forever -- no watcher consumes it and the count can never reach zero.
// Measured across six live projects: gm queued 19 of which 19 were unconsumable
// .md (its entire displayed backlog was residue), gmsniff 12 of 12 five days
// stale, aloop 3 of 3, casey 2 of 2, while spoint had 33 queued with only 2 dead
// -- so a single number made a real backlog indistinguishable from dead residue.
const SPOOL_CONSUMABLE_EXT = '.txt';

// Exported so /api/spool-queue reads the SAME counter the CLI does. The route
// carried its own readdir walk that skipped neither dot-directories nor
// dot-files and called every file pending, so the two surfaces reported 35 and
// 0 for one directory tree -- a reader had no way to tell which to trust.
export function spoolQueueDepth(spoolDir) {
  let consumable = 0;
  let unconsumable = 0;
  let oldestUnconsumableMs = null;
  const byVerb = {};
  const unknownVerbs = [];
  try {
    for (const verbDir of fs.readdirSync(path.join(spoolDir, 'in'), { withFileTypes: true })) {
      // A stray `.gm/` holding a nested exec-spool/ was rendering as a verb
      // queue on spoint; dot-entries are never verbs.
      if (!verbDir.isDirectory() || verbDir.name.startsWith('.')) continue;
      const dir = path.join(spoolDir, 'in', verbDir.name);
      let names = [];
      try { names = fs.readdirSync(dir).filter(f => !f.startsWith('.')); } catch (_) { continue; }
      let verbConsumable = 0;
      let verbUnconsumable = 0;
      for (const name of names) {
        if (name.endsWith(SPOOL_CONSUMABLE_EXT)) { consumable++; verbConsumable++; continue; }
        unconsumable++;
        verbUnconsumable++;
        try {
          const ageMs = Date.now() - fs.statSync(path.join(dir, name)).mtimeMs;
          if (oldestUnconsumableMs === null || ageMs > oldestUnconsumableMs) oldestUnconsumableMs = ageMs;
        } catch (_) {}
      }
      if (verbConsumable || verbUnconsumable) {
        byVerb[verbDir.name] = { consumable: verbConsumable, unconsumable: verbUnconsumable };
        if (!isKnownVerb(verbDir.name)) unknownVerbs.push(verbDir.name);
      }
    }
  } catch (_) {}
  return {
    total: consumable + unconsumable,
    consumable,
    unconsumable,
    oldest_unconsumable_age_ms: oldestUnconsumableMs,
    byVerb,
    unknown_verb_dirs: unknownVerbs,
  };
}

export function readProjectLiveness(cwd, { now = Date.now() } = {}) {
  const spoolDir = path.join(cwd, '.gm', 'exec-spool');
  const status = readJsonOrNull(path.join(spoolDir, '.status.json'));
  const summary = readJsonOrNull(path.join(spoolDir, '.turn-summary.json'));
  const watcherMtime = statMtimeMs(path.join(spoolDir, '.watcher.log'));
  const turnState = readTurnState(cwd);

  // DIAGNOSTIC ONLY -- deliberately excluded from the activity computation below. Measured live:
  // the shared daemon rewrites every registered project's .status.json every ~200ms regardless of
  // whether that project is doing anything, so its age is ~0 for every project always (gmsniff
  // 281ms, spoint 131ms, casey 210ms, test 258ms -- simultaneously, while casey's real work was
  // 2.2 hours cold). Treating it as activity marks the entire fleet permanently active.
  const heartbeat_age_ms = status && status.ts ? now - status.ts : null;

  const agesOfSignalsThisProjectsOwnWorkWrites = [];
  const log_age_ms = watcherMtime !== null ? now - watcherMtime : null;
  if (log_age_ms !== null) agesOfSignalsThisProjectsOwnWorkWrites.push(log_age_ms);
  const summary_age_ms = summary && summary.ts ? now - summary.ts : null;
  if (summary_age_ms !== null) agesOfSignalsThisProjectsOwnWorkWrites.push(summary_age_ms);
  const turn_age_ms = turnState && turnState.updated_at_ms ? now - turnState.updated_at_ms : null;
  if (turn_age_ms !== null) agesOfSignalsThisProjectsOwnWorkWrites.push(turn_age_ms);

  const last_activity_age_ms = agesOfSignalsThisProjectsOwnWorkWrites.length
    ? Math.min(...agesOfSignalsThisProjectsOwnWorkWrites) : null;
  const spoolQueue = spoolQueueDepth(spoolDir);
  // Kept numeric because five surfaces already read it as a count; the split
  // rides alongside rather than changing the type under them.
  const queue_depth = spoolQueue.total;
  const daemon = readDaemonStatus();
  const daemonState = daemonAliveFor(status, daemon, { now });

  return {
    active: last_activity_age_ms !== null && last_activity_age_ms <= PROJECT_ACTIVE_MS,
    last_activity_age_ms,
    activity_sources: { log_age_ms, summary_age_ms, turn_age_ms },
    heartbeat_age_ms,
    log_age_ms,
    summary_age_ms,
    turn_age_ms,
    queue_depth,
    queue_consumable: spoolQueue.consumable,
    queue_unconsumable: spoolQueue.unconsumable,
    queue_oldest_unconsumable_age_ms: spoolQueue.oldest_unconsumable_age_ms,
    ...daemonState,
    shared_process: !!(status && status.shared_process),
  };
}

// The legacy phaseless {turnId, ...} branch is kept even though ../gm's only writer
// (orchestrator/state.rs::write_state) no longer produces it: 20 of 85 real projects on this
// machine still HAVE that file on disk (ai-animate-vrm, cam, flatspace, test, ...), unmodified
// since before the cutover, and dropping the branch reclassifies them as "phase: null" (idle in
// no phase) rather than "present but phaseless", which is what they really are.
//
// A bare `{}` is a third, distinct state: gm's lib.rs resets the file by writing it, its own
// deserializer then rejects it (no serde defaults), and it backs the file up to
// turn-state.json.corrupted-<ts> and restarts at PLAN. 98 such backups exist on disk right now.
export function readTurnState(cwd) {
  const j = readJsonOrNull(path.join(cwd, '.gm', 'turn-state.json'));
  if (!j) return null;
  return {
    present: true,
    legacy_shape: !('phase' in j) && ('turnId' in j),
    reset_shape: Object.keys(j).length === 0,
    phase: typeof j.phase === 'string' ? j.phase : null,
    session_id: j.session_id || null,
    last_skill: j.last_skill || null,
    updated_at_ms: Number.isFinite(j.updated_at_ms) ? j.updated_at_ms : null,
    pending_step_id: j.pending_step_id || null,
    pending_step_deadline_ms: Number.isFinite(j.pending_step_deadline_ms) ? j.pending_step_deadline_ms : null,
    turn_id: j.turnId || null,
  };
}

const CODEINSIGHT_DIGEST_SHAPE = /^v(\d+):([0-9a-f]+):files=(\d+)$/;

export function readProjectMarkers(cwd) {
  const gm = path.join(cwd, '.gm');
  const spool = path.join(gm, 'exec-spool');
  const num = (p) => { const t = readTextOrNull(p); const n = t ? Number(t) : NaN; return Number.isFinite(n) ? n : null; };

  const lastGate = readJsonOrNull(path.join(spool, '.last-gate-fired.json'));
  const digestRaw = readTextOrNull(path.join(spool, '.codeinsight-digest'));
  const dm = digestRaw ? digestRaw.match(CODEINSIGHT_DIGEST_SHAPE) : null;
  const pollScan = readJsonOrNull(path.join(spool, '.poll-scan-offset.json'));
  const claimAudit = readTextOrNull(path.join(gm, 'claim-audit-fired'));
  const residual = readTextOrNull(path.join(gm, 'residual-check-fired'));

  return {
    last_dispatch_ts: num(path.join(gm, 'last-dispatch-ts')),
    last_instruction_ts: num(path.join(gm, 'last-instruction-ts')),
    last_prompt: readTextOrNull(path.join(gm, 'last-prompt.txt')),
    // "clean" is the observed claim-audit body; residual's is empty. An empty marker is still a
    // fired marker, so firing and verdict are reported apart.
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

// runtime-key collision: .turn-summary.json's `runtime` is the EXECUTION runtime of the wasm
// guest (observed "native"), while .status.json's `runtime` is the HOST process kind (observed
// "agentplug"). Same key name, two different meanings -- hence guest_runtime here and
// host_runtime in readWatcherStatus, never merged.
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
    // Both spellings are real and both live in this same file: prd_pending_count is what
    // instruction.served emits today, prd_pending is the older field.
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
    // version/wrapper_sha/idle_limit_ms are retained for consumer compatibility but the current
    // agentplug shared-daemon shape ({pid, ts, daemon, shared_process, runtime:"agentplug"})
    // carries none of them, so they stay null here rather than being fabricated -- the real
    // per-project version comes from the watcher.log banner via index.js readProjectLogSignals.
    const daemonState = daemonAliveFor(j, readDaemonStatus());
    const daemonIsUpMachineWide = daemonState.daemon_alive;
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
      alive: daemonIsUpMachineWide,
      daemon_alive: daemonIsUpMachineWide,
      daemon_pid: daemonState.daemon_pid,
      daemon_pid_source: daemonState.daemon_pid_source,
      daemon_pid_conflict: daemonState.daemon_pid_conflict,
      daemon_status_stale: daemonState.daemon_status_stale,
      shared_pid: !!j.shared_process,
      age_ms: age,
    };
  } catch (_) { return null; }
}

// Measured live at 55 discovered projects under C:/dev: readPrdMutablesState's per-request
// fan-out of blocking sync readFileSync calls was the dominant cost behind observed GUI jank
// under a real event backlog. Caches are bounded because the daemon registry lists deleted
// worktrees forever, so cwd keys accumulate past what is live.
const REGISTRY_CACHE_MAX = parseInt(process.env.GM_REGISTRY_CACHE_MAX, 10) || 256;

function cacheSetEvictingLeastRecentlyUsed(map, key, value, max = REGISTRY_CACHE_MAX) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}

function cacheGetRefreshingRecency(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}

const _prdMutStateCache = new Map();

function statMtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return null; }
}

// Closed-status vocabulary is POLICY, not a fact about the file format: a project can adopt any
// closed-status word, and a hardcoded list miscounts every row using another one as pending.
// Defaults are what gm's own prd.yml uses today. Mutables invert the question -- `unknown` is
// the OPEN state, everything else closed.
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
  const cached = cacheGetRefreshingRecency(_prdMutStateCache, cwd);
  if (cached && cached.prdMtime === prdMtime && cached.mutMtime === mutMtime && cached.policyKey === policyKey) return cached.value;

  // A second `split(/^- id:/m)` definition of "what is a row" was tried and rejected: it
  // disagreed with parseYamlRows on real data. ../gm's live mutables.yml has 259 rows, only 218
  // of which open with `- id:` -- the other 41 use a legacy boundary key (mutable_id 21, text 10,
  // subject 4, name 2, prd_id 2, title 1, repo 1). The split path undercounted mut_total by 41
  // and could not see those rows' status at all; all 41 happen to be closed today, so mut_unknown
  // was coincidentally right and the next open row in that shape would have been invisible.
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
  cacheSetEvictingLeastRecentlyUsed(_prdMutStateCache, cwd, { prdMtime, mutMtime, policyKey, value: out });
  return out;
}

const PHASE_HEADING_TO_SKILL = {
  SPECIFY: 'gm', PROVE: 'gm', EMIT: 'gm', STATE: 'gm', CONC: 'gm', SEC: 'gm', RES: 'gm', DECIDE: 'gm', 'UPDATE-DOCS': 'gm',
};

const _phaseStateCache = new Map();
const DEFAULT_LONG_GAP_THRESHOLD_MS = 300000;

// Reads .gm/next-step.md, whose real on-disk shape is
// "# Next step\n\nPhase: <PHASE>\nUpdated: <epoch-ms>\n\n---\n\n# <PHASE>\n<prose>".
export function readLivePhaseState(cwd) {
  const nextStepPath = path.join(cwd, '.gm', 'next-step.md');
  const summaryPath = path.join(cwd, '.gm', 'exec-spool', '.turn-summary.json');
  const turnStatePath = path.join(cwd, '.gm', 'turn-state.json');
  const mtime = statMtimeMs(nextStepPath);
  // Keying the cache on next-step.md's mtime alone was tried and rejected: it served a stale
  // phase whenever turn-state.json or turn-summary.json moved without next-step.md being
  // rewritten, which is the common case (observed simultaneously: gmsniff turn-state EXECUTE vs
  // turn-summary PLAN, casey turn-state COMPLETE vs turn-summary CONSOLIDATE).
  const summaryMtime = statMtimeMs(summaryPath);
  const turnStateMtime = statMtimeMs(turnStatePath);
  const turnState = readTurnState(cwd);

  if (mtime === null) {
    if (turnState && turnState.phase) {
      return {
        phase: turnState.phase, skill: turnState.last_skill || null, instruction_heading: null,
        instruction_excerpt: null, updated_ts: turnState.updated_at_ms, stale: true, present: false,
        phase_source: 'turn-state.json', session_id: turnState.session_id || null,
      };
    }
    return { phase: null, skill: null, instruction_heading: null, instruction_excerpt: null, updated_ts: null, stale: true, present: false, phase_source: null };
  }
  const cached = cacheGetRefreshingRecency(_phaseStateCache, cwd);
  if (cached && cached.mtime === mtime && cached.summaryMtime === summaryMtime && cached.turnStateMtime === turnStateMtime) return cached.value;

  let value;
  try {
    const text = fs.readFileSync(nextStepPath, 'utf-8');
    const phaseMatch = text.match(/^Phase:\s*(.+)$/m);
    const updatedMatch = text.match(/^Updated:\s*(\d+)$/m);
    const bodyIdx = text.indexOf('\n---\n');
    const body = bodyIdx >= 0 ? text.slice(bodyIdx + 5).trimStart() : '';
    // gm concatenates the constant ORCHESTRATOR preamble ahead of the
    // phase-specific section, so the first `#` heading is ORCHESTRATOR on every
    // project and carries nothing -- measured identical across gm, spoint,
    // gmsniff and aloop. The operative instruction is the last TOP-LEVEL
    // heading (spoint: ORCHESTRATOR then EMIT). `^#\s` excludes `##` subsection
    // headings: matching those made every project report "DISPATCH", trading one
    // constant for another and breaking the skill lookup.
    const topLevelHeadings = [...body.matchAll(/^#[ \t]+(.+?)[ \t]*$/gm)].map(m => m[1].trim().toUpperCase());
    const heading = topLevelHeadings.length ? topLevelHeadings[topLevelHeadings.length - 1] : null;
    const prosePhase = phaseMatch ? phaseMatch[1].trim() : heading;
    const structuredPhaseAvailable = !!(turnState && turnState.phase);
    const phase = structuredPhaseAvailable ? turnState.phase : prosePhase;
    const proseUpdated = updatedMatch ? Number(updatedMatch[1]) : null;
    const updated_ts = structuredPhaseAvailable && turnState.updated_at_ms ? turnState.updated_at_ms : proseUpdated;
    // The project's own served staleness bound; this default is gm's own when the summary is
    // unreadable, never a number invented here.
    let threshold = DEFAULT_LONG_GAP_THRESHOLD_MS;
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
      if (summary && Number.isFinite(summary.long_gap_threshold_ms)) threshold = summary.long_gap_threshold_ms;
    } catch (_) {}
    value = {
      phase: phase || null,
      skill: heading ? (PHASE_HEADING_TO_SKILL[heading] || null) : null,
      instruction_heading: heading,
      // Untruncated: real PLAN/EXECUTE prose runs multi-KB in production, and a server-side char
      // cap was tried and rejected because it hid most of the instruction from the observer. The
      // GUI drilldown's <pre> already scrolls, and the list view does its own client-side slice.
      instruction_excerpt: body,
      updated_ts,
      stale: updated_ts === null ? true : (Date.now() - updated_ts) > threshold,
      present: true,
      phase_source: structuredPhaseAvailable ? 'turn-state.json' : 'next-step.md',
      prose_phase: prosePhase || null,
      phase_divergence: !!(structuredPhaseAvailable && prosePhase && prosePhase !== turnState.phase),
      session_id: turnState ? turnState.session_id : null,
      last_skill: turnState ? turnState.last_skill : null,
    };
  } catch (_) {
    value = { phase: null, skill: null, instruction_heading: null, instruction_excerpt: null, updated_ts: null, stale: true, present: true, unparseable: true, phase_source: null };
  }
  cacheSetEvictingLeastRecentlyUsed(_phaseStateCache, cwd, { mtime, summaryMtime, turnStateMtime, value });
  return value;
}

// ../gm's bootstrap.ensureInstructionsBundle() auto-provisions .gm/instructions/gates/*.md and
// residual/*.md on EVERY daemon boot and records the sha256 of each in
// .gm/.instructions-shipped-manifest.json. It also PRESERVES a user edit across a bundle update
// rather than overwriting it (staging the new default alongside as `<key>.md.new`), so a hash
// diverging from the manifest is load-bearing evidence of a deliberate override, while a hash
// still matching it is universal zero-signal state that would otherwise read as an override on
// every gm-bootstrapped project.
let _manifestCache = new Map();
function readShippedManifest(cwd) {
  const manifestPath = path.join(cwd, '.gm', '.instructions-shipped-manifest.json');
  let stat;
  try { stat = fs.statSync(manifestPath); } catch (_) { return null; }
  const cached = cacheGetRefreshingRecency(_manifestCache, cwd);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.manifest;
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch (_) { manifest = null; }
  cacheSetEvictingLeastRecentlyUsed(_manifestCache, cwd, { mtimeMs: stat.mtimeMs, manifest });
  return manifest;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// The manifest is keyed by path relative to .gm/instructions using the HOST OS's own separator
// (observed as backslash on Windows, e.g. "gates\\long-gap-no-instruction.md"), so a .gm/ synced
// from another machine needs both forms probed.
function manifestHashFor(manifest, relPath) {
  if (!manifest) return undefined;
  return manifest[relPath] ?? manifest[relPath.split('/').join('\\')] ?? manifest[relPath.split('\\').join('/')];
}

// Undeterminable (manifest missing, no entry, read error) answers false -- treat as a real
// override -- because under-reporting a genuine customization as "still default" hides it from
// the observer entirely, while the reverse merely adds a row.
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

// Which of ../gm prose.rs::resolve()'s three tiers is actually serving `key` for this project.
// Only the gates/residual namespace needs the manifest check: gm-plugkit's auto-sync source tree
// carries no phase-level .md files at all (confirmed by reading it directly), so a phase key
// found on disk is ALWAYS fsm-vendor-sourced and therefore always a genuine customization, even
// if a stale manifest entry happens to exist for it.
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

  return { tier: 'default', file_path: null, source_repo: null };
}

// The fsm-vendor verb (../gm fsm_vendor::handle_vendor) writes a WIDER surface than
// ensureInstructionsBundle's gates/residual auto-sync, and none of it is covered by the sha256
// shipped-manifest. fsm-vendor's own write is one-shot and absence-gated with no drift-tracking,
// so mere presence always means a deliberate customization surface exists -- the project OWNS
// that file going forward even if its content still equals the default it was seeded from.
const FSM_VENDOR_PHASE_KEYS = ['specify', 'prove', 'emit', 'state', 'conc', 'sec', 'res', 'decide', 'update_docs', 'entry', 'browser'];
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

  // A project can add as many jit hooks as its graph.json's gates array references.
  const hooksDir = path.join(instructionsDir, 'hooks');
  let customHooks = [];
  try {
    customHooks = fs.readdirSync(hooksDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js') && e.name !== 'example.js')
      .map((e) => entryFor(`hooks/${e.name}`, path.join(hooksDir, e.name)));
  } catch (_) {}

  const allEntries = [...phases, fsmGraph, fsmPredicates, hookExample, ...customHooks, browserConfig, daemonProjectConfig];
  const presentEntries = allEntries.filter((e) => e.present);

  // has_custom_graph is flagged apart from `vendored` because graph.json can redefine phases,
  // edges and gates wholesale -- it distinguishes a project genuinely EXERCISING fsm-vendor from
  // one merely holding leftover example files from a one-time run.
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

export function readDaemonRegistryCwds() {
  try {
    return fs.readFileSync(path.join(AGENTPLUG_DIR, 'daemon-registry.txt'), 'utf-8')
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}

// Keyed on the events array IDENTITY as well as its length: a length-only key was tried and
// rejected because a Store replacing its events array (re-load, source switch, bounded-window
// re-read) can produce a different array of coincidentally equal length, and the cache then
// served the previous source's cwd set indefinitely.
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
        const worktreeHostDir = path.join(proj, '.claude', 'worktrees');
        try {
          for (const w of fs.readdirSync(worktreeHostDir, { withFileTypes: true })) {
            if (!w.isDirectory()) continue;
            const wproj = path.join(worktreeHostDir, w.name);
            if (fs.existsSync(path.join(wproj, '.gm', 'exec-spool', '.status.json'))) addCwd(wproj);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  _cwdSetCache = { eventsRef: arr, eventsLength: len, rootsKey, at: Date.now(), cwds };
  return cwds;
}

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
      alive: live.active,
      daemon_alive: live.daemon_alive,
      last_activity_age_ms: live.last_activity_age_ms,
      queue_depth: live.queue_depth,
      phase: turnState ? turnState.phase : null,
      last_skill: turnState ? turnState.last_skill : null,
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

// Kept in sync against ../gm's two authoritative sources: the orchestrator-verb match in
// rs-plugkit/crates/plugkit-core/src/orchestrator/mod.rs::is_orchestrator_verb and the
// dispatch-verb match in rs-plugkit/crates/plugkit-core/src/wasm_dispatch/verbs.rs. A verb with
// no match arm in one of those passes isKnownVerb() but always dispatches to "unknown verb".
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
  'git_merge', 'git_merge_abort', 'git_branch_delete',
  // Accepted aliases (verbs.rs match arms), not distinct verbs.
  'nodejs', 'javascript', 'node', 'js', 'python', 'py', 'sh', 'shell', 'zsh',
  'forget', 'discipline', 'close', 'filter', 'status',
  // lang-runner verbs (shell_exec dispatch)
  'powershell', 'ps1', 'ssh', 'go', 'rust', 'c', 'cpp', 'java', 'deno', 'pwsh', 'cmd',
  // Handled by the agentplug daemon itself, not the wasm guest
  // (agentplug-runner/src/daemon.rs handle_plugin_refresh_request / handle_background_convert).
  'plugin-refresh', 'background-convert',
  // Retired -- listed here so a real dispatch is still classified correctly, see RETIRED_VERBS.
  'learn', 'wait', 'sleep',
]);

// Real verbs.rs match arms that exist purely to return an informative error, so a dispatch under
// one of these names is recognized but can never succeed:
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
