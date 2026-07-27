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
// Both arrow generations are matched. The wrapper that wrote this line changed its arrow glyph
// from Unicode U+2192/U+2190 to ASCII ->/<- around 2026-05-30; measured across 60 discovered
// projects, 29,029 Unicode-form dispatch lines exist in real history (zel 10,295, thebird 6,649,
// streaming-gltf 1,854, 247420 1,313...) and SEVEN projects -- cj, findphone, fsbrowse, kitten,
// portabox, stream-glb, streamtts -- wrote the Unicode form EXCLUSIVELY, so matching only ASCII
// made those projects' entire dispatch stream invisible while reporting no error. Both forms
// carry an identical field grammar, so one alternation covers both rather than a second parser.
//
// Neither form is emitted by the current agentplug-runner: it logs dispatch.end as an `evt`
// record instead. These lines are therefore a HISTORICAL stream, still the only dispatch-start
// signal that exists for any log written before the cutover, and still present in logs as recent
// as 3 days old (casey, diagen) that predate a given project's runtime upgrade.
const DISPATCH_ARROW_OPEN = '(?:->|\\u2192)';
const DISPATCH_ARROW_CLOSE = '(?:<-|\\u2190)';
const DISPATCH_OPEN_RE = new RegExp(`^(?:\\[[^\\]]+\\]\\s*)?\\[dispatch\\]\\s*${DISPATCH_ARROW_OPEN}\\s*verb=(\\S+)\\s+task=(\\S+)(?:\\s+body=(\\d+)b)?`);
const DISPATCH_CLOSE_RE = new RegExp(`^(?:\\[[^\\]]+\\]\\s*)?\\[dispatch\\]\\s*${DISPATCH_ARROW_CLOSE}\\s*verb=(\\S+)\\s+task=(\\S+)(?:\\s+ms=(\\d+))?(?:\\s+out=(\\d+)b)?`);
const WATCHER_SPAWN_RE = /^---\s*watcher spawn\s+(\S+)(?:\s+supervisor=(\d+))?(?:\s+reason=(\S+))?/;
// The supervisor banner is the same epoch-boundary shape as the watcher/daemon ones and was the
// single largest unmodeled non-dispatch class (1,579 lines) before being modeled here.
const SUPERVISOR_SPAWN_RE = /^---\s*supervisor spawn\s+(\S+)(?:\s+parent=(\d+))?/;
const DAEMON_SPAWN_RE = /^---\s*daemon spawn\s+(\S+)(?:\s+parent=(\d+))?/;
const VERSION_RE = /plugkit\s+v(\d+\.\d+\.\d+)\s*\(wasm\)/;
const STALE_LOCK_RE = /stale lock \(holder pid=(\d+) dead, age=(\d+)ms\)/;
const INSTRUCTION_START_RE = /instruction::handle start(?:\s+body_len=(\d+))?/;
const WRAPPER_DRIFT_RE = /^\[wrapper-drift-check\]\s*(?:(error|warn):\s*)?(.*)$/;
const RETENTION_RE = /^\[retention\]\s*swept\s+(\d+)\s+(\S+)\s+files older than\s+(\S+)/;
// Retention does not only succeed: a locked browser profile makes the sweep fail with EPERM
// repeatedly (1,221 real lines), which is spool growth going unreclaimed -- the opposite signal
// from a successful sweep and previously unmodeled.
const RETENTION_FAIL_RE = /^\[retention\]\s*failed to sweep\s+(\S+?):\s*(.*)$/;
// An available-update banner carries the installed and latest versions. This is the only place a
// per-project "you are behind" signal appears in the log stream.
const UPDATE_RE = /^\[update\]\s*available:\s*installed=(\S+)\s+latest=(\S+)/;
// The stale-sweep auto-fails a spool request whose response never arrived -- a real dispatch
// failure, and the only record that the request was abandoned rather than answered.
const STALE_SWEEP_RE = /^\[stale-sweep\]\s*(auto-failed|failed to write error for)\s+(\S+)(?:\s+\(age=(\d+)ms\))?/;
// gm's own turn-state deserializer rejecting the file and backing it up. This is the on-disk
// corruption path AGENTS.md's turn-state notes depend on, visible only here.
const TURN_STATE_FAIL_RE = /^turn-state\.json parse failed\s*\((.*?)\)/;
// A spool request the runtime could not process at all. This is the terminal record for a
// dispatch that opened and never closed -- see MALFORMED_VERB_RE.
const PROCESS_ERROR_RE = /^\[plugkit-wasm(?::\w+)?\]\s*error processing\s+(\S+):\s*(.*)$/;
// A verb name containing a path separator is not a verb. Real cause (confirmed in C:\dev\zel,
// 8,911 lines): an old wrapper derived verb/task by splitting a spool FILENAME on '-', so
// `prd-resolve\.gm\exec-spool\.status.json` was parsed as verb=`prd-resolve\.gm\exec-spool`
// task=`.status`. Every one of these is immediately followed by an ENOENT "error processing"
// line -- the dispatch genuinely never completed, so it has no close line and never can.
// These are tagged rather than dropped: they are real evidence of an upstream defect, and
// silently discarding them would also silently discard that evidence. They are excluded from
// dispatch pairing, because counting 6,637 permanently-unclosable starts as "in flight" is what
// inflated the orphan-start rate to 11% and would have been read as live work that never landed.
const MALFORMED_VERB_RE = /[\\/]/;
// Runtime lines are routinely wrapped in ANSI SGR sequences by the wrapper's own colorizer, which
// defeated the anchored [plugkit-wasm] prefix test and dropped them into 'other'. Stripped before
// classification rather than matched around, so every prefix-anchored rule below sees clean text.
const ANSI_RE = /[[0-9;]*m/g;

// Strips ANSI SGR wrappers and leading whitespace so prefix-anchored rules see the real text.
export function stripAnsi(raw) {
  return raw.indexOf('') >= 0 ? raw.replace(ANSI_RE, '') : raw;
}

export function classifyLine(raw) {
  if (!raw || !raw.trim()) return 'blank';
  if (EVT_RE.test(raw)) return 'event';
  const s = stripAnsi(raw).trimStart();
  if (DISPATCH_OPEN_RE.test(s) || DISPATCH_CLOSE_RE.test(s)) return 'dispatch';
  if (WATCHER_SPAWN_RE.test(s) || DAEMON_SPAWN_RE.test(s) || SUPERVISOR_SPAWN_RE.test(s)) return 'spawn';
  if (WRAPPER_DRIFT_RE.test(s)) return 'drift';
  if (RETENTION_RE.test(s) || RETENTION_FAIL_RE.test(s)) return 'retention';
  if (UPDATE_RE.test(s)) return 'update';
  if (STALE_SWEEP_RE.test(s)) return 'sweep';
  if (TURN_STATE_FAIL_RE.test(s)) return 'statefail';
  if (PROCESS_ERROR_RE.test(s)) return 'procerror';
  if (VERSION_RE.test(s)) return 'version';
  if (STALE_LOCK_RE.test(s)) return 'lock';
  if (INSTRUCTION_START_RE.test(s)) return 'turn';
  if (/^\[plugkit-(wasm|supervisor)(:warn)?\]/.test(s)) return 'runtime';
  // Host-process noise from the Node wrapper the daemon spawns, deliberately classified rather
  // than left unmodeled: these lines say nothing about gm and are never synthesized into events,
  // but counting them separately keeps unmodeled_ratio meaningful as "format we don't understand"
  // instead of being dominated by node's own deprecation warnings and stack frames.
  if (/^\(node:\d+\)/.test(s) || /^\(Use `node --trace-/.test(s)) return 'hostnoise';
  if (/^Reparsing as ES module|^To eliminate this warning, add/.test(s)) return 'hostnoise';
  if (/^\s*at /.test(raw) || /^[A-Za-z]*Error: /.test(s)) return 'hostnoise';
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
  m = raw.match(SUPERVISOR_SPAWN_RE);
  if (m) return { kind: 'supervisor', iso: m[1], parent_pid: m[2] ? Number(m[2]) : null, reason: null };
  return null;
}

const SPAWN_EVENT = { watcher: 'watcher.spawn', daemon: 'daemon.spawn', supervisor: 'supervisor.spawn' };

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
// 'hostnoise' is modeled-but-not-signal: node's own deprecation warnings and stack frames from
// the wrapper process, which are not gm telemetry at all. It counts as modeled (we recognize the
// shape exactly and deliberately emit no event) so that unmodeled_ratio keeps meaning "an
// upstream format we do not understand" rather than being dominated by Node's chatter.
export const LINE_CLASSES = ['event', 'dispatch', 'spawn', 'version', 'lock', 'turn', 'drift', 'retention', 'update', 'sweep', 'statefail', 'procerror', 'runtime', 'hostnoise', 'other'];

// Classes we recognize but deliberately synthesize no event from. Reported separately so a
// consumer can see that coverage is high because lines are understood, not because they were
// quietly swept into a catch-all.
export const IGNORED_LINE_CLASSES = ['runtime', 'hostnoise'];

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
  const ignored = IGNORED_LINE_CLASSES.reduce((n, c) => n + (stats[`${c}_lines`] || 0), 0);
  return {
    ...stats,
    considered,
    modeled,
    // Lines whose shape we recognize and deliberately emit no event for (see
    // IGNORED_LINE_CLASSES). Separated from `modeled` so the coverage figure is interpretable.
    ignored,
    signal: modeled - ignored,
    parsed_ratio: r(stats.event_lines),
    drop_ratio: r(considered - stats.event_lines),
    modeled_ratio: r(modeled),
    ignored_ratio: r(ignored),
    signal_ratio: r(modeled - ignored),
    unmodeled_ratio: r(stats.other_lines),
  };
}

function mkEvent(event, extra, { cwd, fp, schema, ts, epoch }) {
  const ev = {
    event, ts: ts || '', cwd, _sub: 'plugkit', _day: (ts || '').slice(0, 10),
    _fp: fp, _src: 'watcher.log', _origin: 'line', ...extra,
  };
  // A synthesized line-event inherits ctx.lastTs, but lines preceding the file's FIRST evt record
  // have no preceding ts to inherit -- measured live, 102 of 203,970 events across 6 projects
  // (thebird 66, tv8 24, zel 7) sit in that head region, worst case 3,291 lines deep before the
  // first evt line. Left with ts:'' they are silently dropped or misplaced by every surface that
  // sorts, day-buckets, ages or windows by time. They are flagged here and backfilled from the
  // first following known ts by backfillUntimed, which is sound precisely because the file is
  // append-ordered: an event before the first timestamp cannot be later than that timestamp.
  if (!ev.ts) ev._untimed = true;
  if (epoch) ev._run = epoch;
  if (schema) ev._schema = schema;
  return ev;
}

// Backfills ts onto head-region events that had no preceding timestamp, carrying the first
// FOLLOWING known ts backwards. `_untimed` is retained on every event it touches so a consumer
// can always tell a real upstream timestamp from an order-derived one, and `_ts_source:'backfill'`
// names the derivation. Events still untimed after this pass (a file with no timestamp anywhere)
// keep ts:'' and _untimed, and must be excluded from time-based views rather than sorted as epoch 0.
export function backfillUntimed(events) {
  let next = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.ts) { next = e.ts; continue; }
    if (!next) continue;
    e.ts = next;
    e._day = next.slice(0, 10);
    e._ts_source = 'backfill';
  }
  return events;
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
  // Every non-evt branch below matches against the ANSI-stripped, left-trimmed text, exactly as
  // classifyLine did -- matching the raw form here would classify a colorized line correctly and
  // then fail to extract its fields, dropping the event silently.
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
    const malformed = MALFORMED_VERB_RE.test(d.verb) || undefined;
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
    const m = line.match(STALE_LOCK_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('lock.stale-takeover', { holder_pid: Number(m[1]), age_ms: Number(m[2]) }, base);
  }

  if (cls === 'turn') {
    const m = line.match(INSTRUCTION_START_RE);
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
    const m = line.match(RETENTION_RE);
    if (m) {
      if (stats) stats.synthesized++;
      return mkEvent('retention.swept', { swept: Number(m[1]), dir: m[2], older_than: m[3] }, base);
    }
    const f = line.match(RETENTION_FAIL_RE);
    if (!f) return null;
    if (stats) stats.synthesized++;
    return mkEvent('retention.failed', { dir: f[1], detail: (f[2] || '').trim() }, base);
  }

  if (cls === 'update') {
    const m = line.match(UPDATE_RE);
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
    const m = line.match(TURN_STATE_FAIL_RE);
    if (!m) return null;
    if (stats) stats.synthesized++;
    return mkEvent('turn-state.parse-failed', { detail: m[1] }, base);
  }

  if (cls === 'procerror') {
    const m = line.match(PROCESS_ERROR_RE);
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
  backfillUntimed(events);
  return {
    events, stats: parseCoverage(stats), ctx, truncated, size,
    epoch: ctx.epoch, version: ctx.version,
    dispatch: pairDispatches(events),
  };
}
