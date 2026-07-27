import fs from 'fs';

// Single parser for the per-project .gm/exec-spool/.watcher.log format, shared by index.js's
// replay + tail paths and exported for cli.js so the two never drift apart.
//
// The file is NOT "evt: {json} lines plus noise". Measured across three real live projects
// (gmsniff 13,718 evt of 33,511 lines; spoint 10,040 of 85,170; casey 3,108 of 19,544 -- 20%
// overall), the ~80% that is not an evt: record carries the highest-value live-manager signal
// in the whole file, and discarding it was the actual data loss:
//
//   [dispatch] -> verb=V task=N body=Nb   the dispatch-START stream. There is NO dispatch.start
//                                         evt record anywhere -- this line is the only source of
//                                         what a verb is doing right now. Pairs with the
//                                         dispatch.end evt record for real in-flight duration.
//   [dispatch] <- verb=V task=N ms=N out=Nb  dispatch close (the arrow form; also evt-sourced)
//   [plugkit-wasm] plugkit vX.Y.Z (wasm)  the REAL per-project served version. .status.json
//                                         dropped its `version` field entirely, so this banner
//                                         is now the only per-project version signal that exists.
//   --- watcher spawn <iso> supervisor=<pid> reason=<r> ---   the per-boot EPOCH boundary
//   --- daemon spawn <iso> parent=<pid> ...   process lineage (rarer: 5/1/0 across the three)
//   [plugkit-wasm] stale lock (holder pid=N dead, age=Nms); taking over   contention/recovery
//   [plugkit-wasm:warn] instruction::handle start body_len=N   true turn-entry boundary
//   [wrapper-drift-check] error: ...      installation-integrity failure
//   [retention] swept N out/ files older than Nh   spool churn
//
// Lines synthesized from these shapes are emitted as real events carrying _src:'watcher.log'
// and _origin:'line' (evt-sourced records carry _origin:'evt'), so a consumer can always tell
// provenance and never mistakes a synthesized dispatch.start for an upstream-emitted record.
export const EVT_RE = /evt:\s*(\{.*\})\s*$/;
const DISPATCH_OPEN_RE = /^(?:\[[^\]]+\]\s*)?\[dispatch\]\s*->\s*verb=(\S+)\s+task=(\S+)(?:\s+body=(\d+)b)?/;
const DISPATCH_CLOSE_RE = /^(?:\[[^\]]+\]\s*)?\[dispatch\]\s*<-\s*verb=(\S+)\s+task=(\S+)(?:\s+ms=(\d+))?(?:\s+out=(\d+)b)?/;
const WATCHER_SPAWN_RE = /^---\s*watcher spawn\s+(\S+)(?:\s+supervisor=(\d+))?(?:\s+reason=(\S+))?/;
const DAEMON_SPAWN_RE = /^---\s*daemon spawn\s+(\S+)(?:\s+parent=(\d+))?/;
const VERSION_RE = /plugkit\s+v(\d+\.\d+\.\d+)\s*\(wasm\)/;
const STALE_LOCK_RE = /stale lock \(holder pid=(\d+) dead, age=(\d+)ms\)/;
const INSTRUCTION_START_RE = /instruction::handle start(?:\s+body_len=(\d+))?/;
const WRAPPER_DRIFT_RE = /^\[wrapper-drift-check\]\s*(?:(error|warn):\s*)?(.*)$/;
const RETENTION_RE = /^\[retention\]\s*swept\s+(\d+)\s+(\S+)\s+files older than\s+(\S+)/;

export function classifyLine(raw) {
  if (!raw || !raw.trim()) return 'blank';
  if (EVT_RE.test(raw)) return 'event';
  if (DISPATCH_OPEN_RE.test(raw) || DISPATCH_CLOSE_RE.test(raw)) return 'dispatch';
  if (WATCHER_SPAWN_RE.test(raw) || DAEMON_SPAWN_RE.test(raw)) return 'spawn';
  if (WRAPPER_DRIFT_RE.test(raw)) return 'drift';
  if (RETENTION_RE.test(raw)) return 'retention';
  if (VERSION_RE.test(raw)) return 'version';
  if (STALE_LOCK_RE.test(raw)) return 'lock';
  if (INSTRUCTION_START_RE.test(raw)) return 'turn';
  if (/^\[plugkit-wasm(:warn)?\]/.test(raw)) return 'runtime';
  return 'other';
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
  return null;
}

export function parseVersionLine(raw) {
  const m = raw.match(VERSION_RE);
  return m ? m[1] : null;
}

export function normalizeTs(ts) {
  if (typeof ts === 'string') return ts;
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString();
  return '';
}

// Per-line-class counters. Keys are deliberately suffixed _lines so that spreading a stats
// object alongside real per-project fields (version, epoch) cannot silently overwrite them with
// a counter -- a collision that really did replace the served version string with a line count.
export const LINE_CLASSES = ['event', 'dispatch', 'spawn', 'version', 'lock', 'turn', 'drift', 'retention', 'runtime', 'other'];

export function newParseStats() {
  const s = { total: 0, blank: 0, malformed_json: 0, synthesized: 0 };
  for (const c of LINE_CLASSES) s[`${c}_lines`] = 0;
  return s;
}

// Coverage accounting. `drop_ratio` is deliberately NOT presented as a severity signal on its
// own: most dropped lines are genuine runtime chatter, and a high ratio is normal. What matters
// is `unmodeled_ratio` -- lines that matched no known shape at all ('other'), which is the only
// number that indicates a real upstream format the parser does not yet understand.
export function parseCoverage(stats) {
  const considered = stats.total - stats.blank;
  const modeled = LINE_CLASSES.reduce((n, c) => n + (c === 'other' ? 0 : stats[`${c}_lines`] || 0), 0);
  const r = (n) => (considered > 0 ? Number((n / considered).toFixed(4)) : null);
  return {
    ...stats,
    considered,
    modeled,
    parsed_ratio: r(stats.event_lines),
    drop_ratio: r(considered - stats.event_lines),
    modeled_ratio: r(modeled),
    unmodeled_ratio: r(stats.other_lines),
  };
}

function mkEvent(event, extra, { cwd, fp, schema, ts, epoch }) {
  const ev = {
    event, ts: ts || '', cwd, _sub: 'plugkit', _day: (ts || '').slice(0, 10),
    _fp: fp, _src: 'watcher.log', _origin: 'line', ...extra,
  };
  if (epoch) ev._run = epoch;
  if (schema) ev._schema = schema;
  return ev;
}

// Parses one raw line into a structured event, or null.
//
// cwd is always supplied by the caller (the discovered project directory), never taken from the
// line's own JSON body -- trusting log content for attribution would let a crafted watcher.log
// claim an arbitrary cwd outside the discovered project registry.
//
// ctx is a mutable per-file cursor carrying { epoch, lastTs, version }: non-JSON lines carry no
// timestamp of their own, so they inherit the most recent evt-sourced ts, and every line is
// tagged with the watcher-spawn epoch it falls under.
export function newParseContext() {
  return { epoch: null, epoch_ts: null, lastTs: '', version: null, spawns: [], versions: [] };
}

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

  if (cls === 'spawn') {
    const s = parseSpawnLine(raw);
    if (!s) return null;
    const iso = normalizeTs(s.iso) || s.iso;
    if (c) {
      c.epoch = iso;
      c.epoch_ts = iso;
      if (iso) c.lastTs = iso;
      c.spawns.push(s);
    }
    if (stats) stats.synthesized++;
    return mkEvent(s.kind === 'daemon' ? 'daemon.spawn' : 'watcher.spawn', {
      spawn_kind: s.kind, supervisor_pid: s.supervisor_pid ?? null,
      parent_pid: s.parent_pid ?? null, reason: s.reason,
    }, { ...base, ts: iso, epoch: iso });
  }

  if (cls === 'dispatch') {
    const d = parseDispatchLine(raw);
    if (!d) return null;
    if (stats) stats.synthesized++;
    if (d.dir === 'open') {
      return mkEvent('dispatch.start', { verb: d.verb, task: d.task, body_bytes: d.body_bytes }, base);
    }
    return mkEvent('dispatch.end', { verb: d.verb, task: d.task, ms: d.ms, out_bytes: d.out_bytes }, base);
  }

  if (cls === 'version') {
    const v = parseVersionLine(raw);
    if (!v) return null;
    if (c) { c.version = v; if (!c.versions.includes(v)) c.versions.push(v); }
    if (stats) stats.synthesized++;
    return mkEvent('plugkit.version', { version: v }, base);
  }

  if (cls === 'lock') {
    const m = raw.match(STALE_LOCK_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('lock.stale-takeover', { holder_pid: Number(m[1]), age_ms: Number(m[2]) }, base);
  }

  if (cls === 'turn') {
    const m = raw.match(INSTRUCTION_START_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('instruction.handle-start', { body_len: m[1] ? Number(m[1]) : null }, base);
  }

  if (cls === 'drift') {
    const m = raw.match(WRAPPER_DRIFT_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('wrapper.drift', { level: m[1] || 'info', detail: (m[2] || '').trim() }, base);
  }

  if (cls === 'retention') {
    const m = raw.match(RETENTION_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('retention.swept', { swept: Number(m[1]), dir: m[2], older_than: m[3] }, base);
  }

  return null;
}

// Back-compat: evt-record-only parse, used where a caller genuinely wants just upstream records.
export function parseEventLine(raw, opts = {}) {
  if (!EVT_RE.test(raw)) return null;
  return parseLine(raw, opts);
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
  return {
    events, stats: parseCoverage(stats), ctx, truncated, size,
    epoch: ctx.epoch, version: ctx.version,
  };
}
