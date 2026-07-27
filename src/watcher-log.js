import fs from 'fs';

// Single parser for the per-project .gm/exec-spool/.watcher.log format, shared by index.js's
// replay + tail paths and exported for cli.js so the two never drift apart.
//
// MEASURED across three real live projects (gmsniff 13,718 evt of 33,511 lines; spoint 10,040 of
// 85,170; casey 3,108 of 19,544 -- 20% overall): the ~80% of lines that are NOT evt: records
// carry the highest-value live-manager signal in the whole file, and discarding them was the
// actual data loss. Two facts drive that: there is NO upstream dispatch.start evt record
// anywhere, so the [dispatch] -> line is the only source of what a verb is doing right now; and
// .status.json dropped its `version` field entirely, so the wasm banner is the only per-project
// version signal that still exists.
export const EVT_RE = /evt:\s*(\{.*\})\s*$/;

// MEASURED: the wrapper changed its dispatch arrow glyph from Unicode U+2192/U+2190 to ASCII
// ->/<- around 2026-05-30. Across 60 discovered projects 29,029 Unicode-form dispatch lines exist
// in real history (zel 10,295, thebird 6,649, streaming-gltf 1,854, 247420 1,313...) and SEVEN
// projects -- cj, findphone, fsbrowse, kitten, portabox, stream-glb, streamtts -- wrote the
// Unicode form EXCLUSIVELY, so matching only ASCII made those projects' entire dispatch stream
// invisible while reporting no error. Both generations share one field grammar, hence one
// alternation rather than a second parser.
//
// Neither form is emitted by the current agentplug-runner, which logs dispatch.end as an evt
// record instead. These lines are a HISTORICAL stream, still the only dispatch-start signal for
// any log written before the cutover, and still present in logs as recent as 3 days old (casey,
// diagen) that predate a given project's runtime upgrade.
const ARROW_EITHER_GENERATION_OPEN = '(?:->|\\u2192)';
const ARROW_EITHER_GENERATION_CLOSE = '(?:<-|\\u2190)';

const DISPATCH_OPEN_RE = new RegExp(`^(?:\\[[^\\]]+\\]\\s*)?\\[dispatch\\]\\s*${ARROW_EITHER_GENERATION_OPEN}\\s*verb=(\\S+)\\s+task=(\\S+)(?:\\s+body=(\\d+)b)?`);
const DISPATCH_CLOSE_RE = new RegExp(`^(?:\\[[^\\]]+\\]\\s*)?\\[dispatch\\]\\s*${ARROW_EITHER_GENERATION_CLOSE}\\s*verb=(\\S+)\\s+task=(\\S+)(?:\\s+ms=(\\d+))?(?:\\s+out=(\\d+)b)?`);
const WATCHER_SPAWN_RE = /^---\s*watcher spawn\s+(\S+)(?:\s+supervisor=(\d+))?(?:\s+reason=(\S+))?/;
// MEASURED: the single largest unmodeled non-dispatch class (1,579 lines) before being modeled.
const SUPERVISOR_SPAWN_RE = /^---\s*supervisor spawn\s+(\S+)(?:\s+parent=(\d+))?/;
const DAEMON_SPAWN_RE = /^---\s*daemon spawn\s+(\S+)(?:\s+parent=(\d+))?/;
const PLUGKIT_WASM_VERSION_RE = /plugkit\s+v(\d+\.\d+\.\d+)\s*\(wasm\)/;
const STALE_LOCK_TAKEOVER_RE = /stale lock \(holder pid=(\d+) dead, age=(\d+)ms\)/;
const INSTRUCTION_HANDLE_START_RE = /instruction::handle start(?:\s+body_len=(\d+))?/;
const WRAPPER_DRIFT_RE = /^\[wrapper-drift-check\]\s*(?:(error|warn):\s*)?(.*)$/;
const RETENTION_SWEPT_RE = /^\[retention\]\s*swept\s+(\d+)\s+(\S+)\s+files older than\s+(\S+)/;
// MEASURED: a locked browser profile makes the sweep fail with EPERM repeatedly (1,221 real
// lines) -- spool growth going unreclaimed, the opposite signal from a successful sweep.
const RETENTION_FAILED_RE = /^\[retention\]\s*failed to sweep\s+(\S+?):\s*(.*)$/;
const UPDATE_AVAILABLE_RE = /^\[update\]\s*available:\s*installed=(\S+)\s+latest=(\S+)/;
const STALE_SWEEP_RE = /^\[stale-sweep\]\s*(auto-failed|failed to write error for)\s+(\S+)(?:\s+\(age=(\d+)ms\))?/;
const TURN_STATE_PARSE_FAILED_RE = /^turn-state\.json parse failed\s*\((.*?)\)/;
const SPOOL_PROCESS_ERROR_RE = /^\[plugkit-wasm(?::\w+)?\]\s*error processing\s+(\S+):\s*(.*)$/;
const PLUGKIT_RUNTIME_PREFIX_RE = /^\[plugkit-(wasm|supervisor)(:warn)?\]/;
const NODE_WRAPPER_NOISE_RE = /^\(node:\d+\)|^\(Use \`node --trace-/;
const NODE_MODULE_WARNING_RE = /^Reparsing as ES module|^To eliminate this warning, add/;
const STACK_FRAME_RE = /^\s*at /;
const ERROR_HEADER_RE = /^[A-Za-z]*Error: /;

// UPSTREAM DEFECT (confirmed in C:\dev\zel, 8,911 lines): an old wrapper derived verb/task by
// splitting a spool FILENAME on '-', so `prd-resolve\.gm\exec-spool\.status.json` was parsed as
// verb=`prd-resolve\.gm\exec-spool` task=`.status`. Every one is immediately followed by an
// ENOENT "error processing" line -- the dispatch genuinely never completed, so it has no close
// line and never can. Tagged rather than dropped, because these lines ARE the evidence of the
// defect; excluded from pairing, because counting 6,637 permanently-unclosable starts as
// "in flight" is what inflated the orphan-start rate to 11%.
const VERB_NAME_CONTAINING_PATH_SEPARATOR_RE = /[\\/]/;

// MEASURED: the wrapper's own colorizer wraps runtime lines in ANSI SGR sequences, which defeated
// the anchored [plugkit-wasm] prefix test and dropped those lines into 'other'.
const ANSI_SGR_RE = /\[[0-9;]*m/g;
const ANSI_ESCAPE_INTRODUCER = '';

export function stripAnsi(raw) {
  return raw.indexOf(ANSI_ESCAPE_INTRODUCER) >= 0 ? raw.replace(ANSI_SGR_RE, '') : raw;
}

export function classifyLine(raw) {
  if (!raw || !raw.trim()) return 'blank';
  if (EVT_RE.test(raw)) return 'event';
  const s = stripAnsi(raw).trimStart();
  if (DISPATCH_OPEN_RE.test(s) || DISPATCH_CLOSE_RE.test(s)) return 'dispatch';
  if (WATCHER_SPAWN_RE.test(s) || DAEMON_SPAWN_RE.test(s) || SUPERVISOR_SPAWN_RE.test(s)) return 'spawn';
  if (WRAPPER_DRIFT_RE.test(s)) return 'drift';
  if (RETENTION_SWEPT_RE.test(s) || RETENTION_FAILED_RE.test(s)) return 'retention';
  if (UPDATE_AVAILABLE_RE.test(s)) return 'update';
  if (STALE_SWEEP_RE.test(s)) return 'sweep';
  if (TURN_STATE_PARSE_FAILED_RE.test(s)) return 'statefail';
  if (SPOOL_PROCESS_ERROR_RE.test(s)) return 'procerror';
  if (PLUGKIT_WASM_VERSION_RE.test(s)) return 'version';
  if (STALE_LOCK_TAKEOVER_RE.test(s)) return 'lock';
  if (INSTRUCTION_HANDLE_START_RE.test(s)) return 'turn';
  if (PLUGKIT_RUNTIME_PREFIX_RE.test(s)) return 'runtime';
  if (isNodeHostNoise(raw, s)) return 'hostnoise';
  return 'other';
}

// Chatter from the Node wrapper process the daemon spawns -- not gm telemetry at all. Classified
// rather than left unmodeled so unmodeled_ratio keeps meaning "an upstream format we do not
// understand" instead of being dominated by Node's own deprecation warnings and stack frames.
function isNodeHostNoise(raw, ansiStripped) {
  return NODE_WRAPPER_NOISE_RE.test(ansiStripped)
    || NODE_MODULE_WARNING_RE.test(ansiStripped)
    || STACK_FRAME_RE.test(raw)
    || ERROR_HEADER_RE.test(ansiStripped);
}

export function parseDispatchLine(raw) {
  let m = raw.match(DISPATCH_OPEN_RE);
  if (m) return { dir: 'open', verb: m[1], task: m[2], body_bytes: m[3] ? Number(m[3]) : null };
  m = raw.match(DISPATCH_CLOSE_RE);
  if (m) return { dir: 'close', verb: m[1], task: m[2], ms: m[3] ? Number(m[3]) : null, out_bytes: m[4] ? Number(m[4]) : null };
  return null;
}

export function parseSpawnLine(raw) {
  let m = raw.match(WATCHER_SPAWN_RE);
  if (m) return { kind: 'watcher', iso: m[1], supervisor_pid: m[2] ? Number(m[2]) : null, reason: m[3] || null };
  m = raw.match(DAEMON_SPAWN_RE);
  if (m) return { kind: 'daemon', iso: m[1], parent_pid: m[2] ? Number(m[2]) : null, reason: null };
  m = raw.match(SUPERVISOR_SPAWN_RE);
  if (m) return { kind: 'supervisor', iso: m[1], parent_pid: m[2] ? Number(m[2]) : null, reason: null };
  return null;
}

const SPAWN_EVENT = { watcher: 'watcher.spawn', daemon: 'daemon.spawn', supervisor: 'supervisor.spawn' };

export function parseVersionLine(raw) {
  const m = raw.match(PLUGKIT_WASM_VERSION_RE);
  return m ? m[1] : null;
}

export function normalizeTs(ts) {
  if (typeof ts === 'string') return ts;
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString();
  return '';
}

// Counter keys are suffixed _lines because a stats object is routinely spread alongside real
// per-project fields (version, epoch); an unsuffixed `version` counter really did overwrite the
// served version string with a line count.
export const LINE_CLASSES = ['event', 'dispatch', 'spawn', 'version', 'lock', 'turn', 'drift', 'retention', 'update', 'sweep', 'statefail', 'procerror', 'runtime', 'hostnoise', 'other'];

const UNMODELED_LINE_CLASS = 'other';

// Recognized exactly, and deliberately synthesized into no event. Counted as modeled, and
// reported separately, so coverage reads as "lines are understood" rather than "lines were
// quietly swept into a catch-all".
export const IGNORED_LINE_CLASSES = ['runtime', 'hostnoise'];

export function newParseStats() {
  const s = { total: 0, blank: 0, malformed_json: 0, synthesized: 0 };
  for (const c of LINE_CLASSES) s[`${c}_lines`] = 0;
  return s;
}

export function parseCoverage(stats) {
  const considered = stats.total - stats.blank;
  const linesIn = (cls) => stats[`${cls}_lines`] || 0;
  const modeled = LINE_CLASSES.reduce((n, c) => n + (c === UNMODELED_LINE_CLASS ? 0 : linesIn(c)), 0);
  const ignored = IGNORED_LINE_CLASSES.reduce((n, c) => n + linesIn(c), 0);
  const ratioOfConsidered = (n) => (considered > 0 ? Number((n / considered).toFixed(4)) : null);
  return {
    ...stats,
    considered,
    modeled,
    ignored,
    signal: modeled - ignored,
    parsed_ratio: ratioOfConsidered(stats.event_lines),
    drop_ratio: ratioOfConsidered(considered - stats.event_lines),
    modeled_ratio: ratioOfConsidered(modeled),
    ignored_ratio: ratioOfConsidered(ignored),
    signal_ratio: ratioOfConsidered(modeled - ignored),
    unmodeled_ratio: ratioOfConsidered(stats.other_lines),
  };
}

function mkEvent(event, extra, { cwd, fp, schema, ts, epoch }) {
  const ev = {
    event, ts: ts || '', cwd, _sub: 'plugkit', _day: (ts || '').slice(0, 10),
    _fp: fp, _src: 'watcher.log', _origin: 'line', ...extra,
  };
  // MEASURED: lines preceding a file's FIRST evt record have no ctx.lastTs to inherit, and 102 of
  // 203,970 events across 6 projects (thebird 66, tv8 24, zel 7) sit in that head region -- worst
  // case 3,291 lines deep before the first evt line. Left with ts:'' they are silently dropped or
  // misplaced by every surface that sorts, day-buckets, ages or windows by time.
  if (!ev.ts) ev._untimed = true;
  if (epoch) ev._run = epoch;
  if (schema) ev._schema = schema;
  return ev;
}

// Carries the first FOLLOWING known ts backwards onto head-region events. Sound precisely
// because the file is append-ordered: an event before the first timestamp cannot be later than
// that timestamp. `_untimed` is retained on every event it touches so a consumer can always tell
// a real upstream timestamp from an order-derived one.
export function backfillUntimedFromNextKnownTs(events) {
  let nextKnownTs = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.ts) { nextKnownTs = e.ts; continue; }
    if (!nextKnownTs) continue;
    e.ts = nextKnownTs;
    e._day = nextKnownTs.slice(0, 10);
    e._ts_source = 'backfill';
  }
  return events;
}
export { backfillUntimedFromNextKnownTs as backfillUntimed };

export function newParseContext() {
  return { epoch: null, epoch_ts: null, lastTs: '', version: null, spawns: [], versions: [] };
}

// cwd is always the caller's discovered project directory, never o.cwd from the line's own JSON
// body: trusting log content for attribution would let a crafted watcher.log claim an arbitrary
// cwd outside the discovered project registry.
export function parseLine(raw, { cwd, fp, schema, stats, ctx } = {}) {
  const cls = classifyLine(raw);
  if (stats) {
    stats.total++;
    if (cls === 'blank') { stats.blank++; return null; }
    stats[`${cls}_lines`]++;
  } else if (cls === 'blank') return null;

  const c = ctx || null;
  const epoch = c ? c.epoch : null;

  if (cls === 'event') {
    const m = raw.match(EVT_RE);
    let o;
    try { o = JSON.parse(m[1]); } catch { if (stats) { stats.event_lines--; stats.malformed_json++; } return null; }
    const sub = o.sub || 'plugkit';
    const ts = normalizeTs(o.ts);
    if (c && ts) c.lastTs = ts;
    const ev = { ...o, ts, cwd, _sub: sub, _day: ts.slice(0, 10), _fp: fp, _src: 'watcher.log', _origin: 'evt' };
    if (epoch) ev._run = epoch;
    if (schema) ev._schema = schema;
    if (!ev.event) ev.event = o.phase || o.action || o.kind || o.type || '?';
    return ev;
  }

  const ts = c ? c.lastTs : '';
  const base = { cwd, fp, schema, ts, epoch };
  // Every non-evt branch below must match this, not `raw`, for the same reason classifyLine does:
  // matching the raw form would classify a colorized line correctly and then fail to extract its
  // fields, dropping the event silently.
  const line = stripAnsi(raw).trimStart();

  if (cls === 'spawn') {
    const s = parseSpawnLine(line);
    if (!s) return null;
    const iso = normalizeTs(s.iso) || s.iso;
    if (c) {
      c.epoch = iso;
      c.epoch_ts = iso;
      if (iso) c.lastTs = iso;
      c.spawns.push(s);
    }
    if (stats) stats.synthesized++;
    return mkEvent(SPAWN_EVENT[s.kind] || 'watcher.spawn', {
      spawn_kind: s.kind, supervisor_pid: s.supervisor_pid ?? null,
      parent_pid: s.parent_pid ?? null, reason: s.reason,
    }, { ...base, ts: iso, epoch: iso });
  }

  if (cls === 'dispatch') {
    const d = parseDispatchLine(line);
    if (!d) return null;
    if (stats) stats.synthesized++;
    const malformed = VERB_NAME_CONTAINING_PATH_SEPARATOR_RE.test(d.verb) || undefined;
    if (d.dir === 'open') {
      return mkEvent('dispatch.start', { verb: d.verb, task: d.task, body_bytes: d.body_bytes, _malformed_verb: malformed }, base);
    }
    return mkEvent('dispatch.end', { verb: d.verb, task: d.task, ms: d.ms, out_bytes: d.out_bytes, _malformed_verb: malformed }, base);
  }

  if (cls === 'version') {
    const v = parseVersionLine(line);
    if (!v) return null;
    if (c) { c.version = v; if (!c.versions.includes(v)) c.versions.push(v); }
    if (stats) stats.synthesized++;
    return mkEvent('plugkit.version', { version: v }, base);
  }

  if (cls === 'lock') {
    const m = line.match(STALE_LOCK_TAKEOVER_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('lock.stale-takeover', { holder_pid: Number(m[1]), age_ms: Number(m[2]) }, base);
  }

  if (cls === 'turn') {
    const m = line.match(INSTRUCTION_HANDLE_START_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('instruction.handle-start', { body_len: m[1] ? Number(m[1]) : null }, base);
  }

  if (cls === 'drift') {
    const m = line.match(WRAPPER_DRIFT_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('wrapper.drift', { level: m[1] || 'info', detail: (m[2] || '').trim() }, base);
  }

  if (cls === 'retention') {
    const m = line.match(RETENTION_SWEPT_RE);
    if (m) {
      if (stats) stats.synthesized++;
      return mkEvent('retention.swept', { swept: Number(m[1]), dir: m[2], older_than: m[3] }, base);
    }
    const f = line.match(RETENTION_FAILED_RE);
    if (!f) return null;
    if (stats) stats.synthesized++;
    return mkEvent('retention.failed', { dir: f[1], detail: (f[2] || '').trim() }, base);
  }

  if (cls === 'update') {
    const m = line.match(UPDATE_AVAILABLE_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('update.available', { installed: m[1], latest: m[2] }, base);
  }

  if (cls === 'sweep') {
    const m = line.match(STALE_SWEEP_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('spool.stale-swept', {
      action: m[1] === 'auto-failed' ? 'auto-failed' : 'error-write-failed',
      request: m[2], age_ms: m[3] ? Number(m[3]) : null,
    }, base);
  }

  if (cls === 'statefail') {
    const m = line.match(TURN_STATE_PARSE_FAILED_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('turn-state.parse-failed', { detail: m[1] }, base);
  }

  if (cls === 'procerror') {
    const m = line.match(SPOOL_PROCESS_ERROR_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('spool.process-error', { request: m[1], detail: (m[2] || '').trim() }, base);
  }

  return null;
}

// Back-compat: evt-record-only parse, used where a caller genuinely wants just upstream records.
export function parseEventLine(raw, opts = {}) {
  if (!EVT_RE.test(raw)) return null;
  return parseLine(raw, opts);
}

// Pairs synthesized dispatch.start lines to their dispatch.end partners, producing per-dispatch
// duration AND response size -- a richer record than the upstream `dispatch.end` evt, which
// carries `ms` but no `out` byte count and has no start counterpart at all.
//
// Pairing is BY TASK ID within a cwd, not by verb: task is the wrapper's own per-dispatch handle,
// and pairing on verb alone mis-pairs concurrent dispatches of the same verb. A start is matched
// by the next unconsumed end with the same (cwd, verb, task).
//
// ORPHAN STARTS ARE NORMAL, NOT CORRUPTION. Two effects produce them legitimately: a dispatch
// genuinely in flight when the log was read, and a bounded tail read (the default) slicing a
// start away from an end that lies outside the window. Measured on full-history reads, orphan
// starts run well under 1% of dispatches. The count is exposed so a consumer can show it as
// in-flight rather than inferring a fault. Note the counts here are LINE-derived only: comparing
// them against the separate `dispatch.end` evt-record population is comparing two different
// populations and manufactures a phantom imbalance.
export function pairDispatches(events) {
  const openByKey = new Map();
  const pairs = [];
  let starts = 0, ends = 0, orphanEnds = 0, malformed = 0;
  for (const e of events) {
    if (e._origin !== 'line') continue;
    // Excluded from pairing entirely -- an upstream filename-split bug produced these and they
    // have no close line by construction. Counting them would report 6,637 permanently-dead
    // dispatches as in-flight work.
    if (e._malformed_verb) { if (e.event === 'dispatch.start') malformed++; continue; }
    if (e.event === 'dispatch.start') {
      starts++;
      const k = `${e.cwd}|${e.verb}|${e.task}`;
      if (!openByKey.has(k)) openByKey.set(k, []);
      openByKey.get(k).push(e);
    } else if (e.event === 'dispatch.end') {
      ends++;
      const k = `${e.cwd}|${e.verb}|${e.task}`;
      const q = openByKey.get(k);
      const start = q && q.length ? q.shift() : null;
      if (!start) { orphanEnds++; continue; }
      pairs.push({
        cwd: e.cwd, verb: e.verb, task: e.task,
        start_ts: start.ts || null, end_ts: e.ts || null,
        // ms comes from the wrapper's own measurement, not from a ts subtraction: the synthesized
        // start inherits a ts from a preceding evt line and so is only as precise as that line.
        ms: e.ms ?? null,
        body_bytes: start.body_bytes ?? null,
        out_bytes: e.out_bytes ?? null,
      });
    }
  }
  let orphanStarts = 0;
  for (const q of openByKey.values()) orphanStarts += q.length;
  const withMs = pairs.filter(p => p.ms !== null);
  const durations = withMs.map(p => p.ms).sort((a, b) => a - b);
  const pct = (p) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] : null);
  let outTotal = 0, bodyTotal = 0;
  for (const p of pairs) { outTotal += p.out_bytes || 0; bodyTotal += p.body_bytes || 0; }
  return {
    pairs,
    starts,
    ends,
    paired: pairs.length,
    // In-flight or window-clipped, never presented as an error condition.
    orphan_starts: orphanStarts,
    orphan_start_ratio: starts ? Number((orphanStarts / starts).toFixed(4)) : null,
    // Starts excluded by the upstream malformed-verb bug -- a real defect count, kept apart from
    // orphan_starts so the benign in-flight figure is not inflated by it.
    malformed_verb_starts: malformed,
    // An end with no start is the tail-window mirror of an orphan start, same benign cause.
    orphan_ends: orphanEnds,
    ms_p50: pct(0.5),
    ms_p95: pct(0.95),
    ms_max: durations.length ? durations[durations.length - 1] : null,
    out_bytes_total: outTotal,
    body_bytes_total: bodyTotal,
  };
}

// Aggregates paired dispatches per verb: call count, duration distribution and response size.
// This is the per-verb cost surface the `out=` field makes possible and the evt record cannot.
export function dispatchVerbStats(pairing) {
  const byVerb = new Map();
  for (const p of (pairing && pairing.pairs) || []) {
    let v = byVerb.get(p.verb);
    if (!v) { v = { verb: p.verb, count: 0, ms: [], out_bytes: 0, body_bytes: 0 }; byVerb.set(p.verb, v); }
    v.count++;
    if (p.ms !== null) v.ms.push(p.ms);
    v.out_bytes += p.out_bytes || 0;
    v.body_bytes += p.body_bytes || 0;
  }
  const rows = [];
  for (const v of byVerb.values()) {
    v.ms.sort((a, b) => a - b);
    rows.push({
      verb: v.verb, count: v.count,
      ms_p50: v.ms.length ? v.ms[Math.floor(v.ms.length * 0.5)] : null,
      ms_p95: v.ms.length ? v.ms[Math.min(v.ms.length - 1, Math.floor(v.ms.length * 0.95))] : null,
      ms_max: v.ms.length ? v.ms[v.ms.length - 1] : null,
      ms_total: v.ms.reduce((n, x) => n + x, 0),
      out_bytes: v.out_bytes,
      body_bytes: v.body_bytes,
      out_bytes_avg: v.count ? Math.round(v.out_bytes / v.count) : 0,
    });
  }
  return rows.sort((a, b) => b.ms_total - a.ms_total);
}

// Reads only the tail of a large file. watcher.log reaches 6.1MB/85k lines in real use, and
// reading full history on every CLI invocation and GUI boot is the dominant cost of a cold read.
// Reads the last `maxBytes` and discards the first (likely partial) line.
export function readTail(fp, maxBytes) {
  const stat = fs.statSync(fp);
  if (!maxBytes || stat.size <= maxBytes) return { text: fs.readFileSync(fp, 'utf8'), truncated: false, size: stat.size };
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    const text = buf.toString('utf8', 0, n);
    const nl = text.indexOf('\n');
    return { text: nl >= 0 ? text.slice(nl + 1) : text, truncated: true, size: stat.size };
  } finally { fs.closeSync(fd); }
}

// Default replay window. Bounded by default so a cold read is O(window), not O(history); a
// caller wanting the full file passes maxBytes:0.
export const DEFAULT_REPLAY_BYTES = parseInt(process.env.GM_REPLAY_MAX_BYTES, 10) || 2 * 1024 * 1024;

// Full replay with parse-coverage accounting and epoch/version extraction.
export function replayWatcherLogWithStats(fp, cwd, schema, opts = {}) {
  const events = [];
  const stats = newParseStats();
  const ctx = newParseContext();
  const maxBytes = opts.maxBytes === undefined ? DEFAULT_REPLAY_BYTES : opts.maxBytes;
  let text, truncated = false, size = null;
  try {
    const r = readTail(fp, maxBytes);
    text = r.text; truncated = r.truncated; size = r.size;
  } catch { return { events, stats: parseCoverage(stats), ctx, truncated: false, size: null }; }
  for (const line of text.split('\n')) {
    const ev = parseLine(line, { cwd, fp, schema, stats, ctx });
    if (ev) events.push(ev);
  }
  backfillUntimedFromNextKnownTs(events);
  return {
    events, stats: parseCoverage(stats), ctx, truncated, size,
    epoch: ctx.epoch, version: ctx.version,
    dispatch: pairDispatches(events),
  };
}
