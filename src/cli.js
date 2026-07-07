#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GmLogWatcher, MultiProjectWatcher, replayAll, DEFAULT_LOG_DIR } from './index.js';

const PHASES = ['PLAN', 'EXECUTE', 'EMIT', 'VERIFY', 'CONSOLIDATE', 'COMPLETE'];

// EXIT CODE CONTRACT (single source of truth -- printed by --schema/--describe and --help so
// an agentic caller never has to infer this from source): 0 = success (including zero-match,
// empty-result queries -- absence of data is not a failure), 2 = usage error (bad/missing
// argument, unresolvable session, malformed flag value). No code path exits 0 on a thrown
// error or genuine failure; uncaught exceptions propagate to Node's default non-zero exit.
const EXIT_CODES = { 0: 'success (includes zero-match queries)', 2: 'usage error (bad/missing argument, malformed value)' };

// Declarative flag registry -- single source of truth for parseArgs, printHelp, and
// --schema/--describe. Every flag an agentic caller can pass is described here with its
// type, default, and one-line meaning; nothing in parseArgs recognizes a flag this registry
// does not also describe, so help text and machine-schema output cannot drift from behavior.
const FLAG_DEFS = [
  { name: 'help', alias: 'h', type: 'bool', desc: 'print human-readable help and exit 0' },
  { name: 'schema', type: 'bool', desc: 'print machine-readable JSON description of every flag + output shape, then exit 0' },
  { name: 'spool', type: 'string', desc: 'force one project dir (or .watcher.log path) as the event source' },
  { name: 'since', type: 'string', desc: 'ISO date, epoch ms, or relative Ns/Nm/Nh/Nd/Nw; alias --after' },
  { name: 'after', type: 'string', desc: 'alias for --since' },
  { name: 'until', type: 'string', desc: 'ISO date, epoch ms, or relative Ns/Nm/Nh/Nd/Nw; alias --before' },
  { name: 'before', type: 'string', desc: 'alias for --until' },
  { name: 'sub', type: 'multi', desc: 'filter by subsystem (plugkit, hook, exec, rs_learn, ...); repeat = OR' },
  { name: 'event', type: 'multi', desc: 'filter by event type (dispatch.end, deviation.gate-deny, ...); repeat = OR' },
  { name: 'sess', type: 'multi', desc: 'filter by session id prefix; repeat = OR' },
  { name: 'exclude-sess', type: 'multi', desc: 'exclude session id prefix; repeat = exclude any' },
  { name: 'exclude-cwd', type: 'multi', desc: 'exclude working-dir regex; repeat = exclude any' },
  { name: 'pid', type: 'multi', desc: 'filter by process id; repeat = OR' },
  { name: 'grep', type: 'multi', desc: 'text regex the JSON-stringified event must match; repeat = AND' },
  { name: 'igrep', type: 'multi', desc: 'text regex that excludes an event if matched' },
  { name: 'day', type: 'string', desc: 'restrict to one day, YYYY-MM-DD' },
  { name: 'cwd', type: 'string', desc: 'working-dir regex filter' },
  { name: 'sort', type: 'string', default: 'ts', desc: 'sort key: ts|sub|event|sess|pid' },
  { name: 'rollup', type: 'string', desc: 'dump filtered events as ndjson to this file path' },
  { name: 'efficiency', type: 'string', desc: 'session id: turn count, dispatch ratio, time-to-COMPLETE' },
  { name: 'tree', type: 'string', desc: 'session id (or "current"/"."/"@" to auto-resolve from cwd): chronological process tree' },
  { name: 'bucket', type: 'string', default: '0.1', desc: 'histogram bucket width for --recall-scores' },
  { name: 'days', type: 'string', default: '7', desc: 'day window for --memory-leverage' },
  { name: 'limit', alias: 'head', type: 'number', default: 0, desc: 'stop after N matches (0 = unlimited); --head is an alias' },
  { name: 'head', type: 'number', desc: 'alias for --limit' },
  { name: 'tail-n', type: 'number', desc: 'keep only the last N rows after sort' },
  { name: 'ctx', type: 'number', default: 0, desc: 'N events of context before+after each match' },
  { name: 'truncate', type: 'number', default: 200, desc: 'max chars per row body; default 200 human / 2000 --json; --full disables' },
  { name: 'top', type: 'number', default: 20, desc: 'top-N cutoff for --recall-misses/--classifier-rejects' },
  { name: 'json', alias: 'ndjson', type: 'bool', desc: 'emit ndjson rows (one JSON event per line) instead of human-formatted text' },
  { name: 'ndjson', type: 'bool', desc: 'alias for --json' },
  { name: 'tail', alias: 'f', type: 'bool', desc: 'live tail after replay, fanned out across every discovered project + central log (also -f); narrow with --spool' },
  { name: 'full', type: 'bool', desc: 'do not truncate row bodies' },
  { name: 'reverse', type: 'bool', desc: 'newest first' },
  { name: 'invert', type: 'bool', desc: 'invert the filter result' },
  { name: 'count', type: 'bool', desc: 'print only the match count, then exit 0' },
  { name: 'stats', type: 'bool', desc: 'breakdown by sub / event / sess / day' },
  { name: 'list-sessions', type: 'bool', desc: 'per-session summary with phase walk' },
  { name: 'list-deviations', type: 'bool', desc: 'recent deviations grouped by kind, own/foreign split, severity, recovery verb' },
  { name: 'own-only', type: 'bool', desc: 'with --list-deviations: only own-session deviations' },
  { name: 'foreign-only', type: 'bool', desc: 'with --list-deviations: only foreign-session deviations' },
  { name: 'list-events', type: 'bool', desc: 'event-type histogram (optionally scoped by --sub)' },
  { name: 'updates', type: 'bool', desc: 'live drift state + update.* event history' },
  { name: 'watchers', type: 'bool', desc: 'one-line liveness + version per project cwd' },
  { name: 'conformance', alias: 'projects', type: 'bool', desc: 'paper S14 metrics: unresolved-mutables + PRD-pending per project; --projects is an alias' },
  { name: 'projects', type: 'bool', desc: 'alias for --conformance' },
  { name: 'all', type: 'bool', desc: 'with --watchers: include dead watchers too' },
  { name: 'all-dispatch', type: 'bool', desc: 'with --tree: show dispatch.start events too (dropped by default)' },
  { name: 'no-color', type: 'bool', desc: 'disable ANSI color in output' },
  { name: 'embed-failures', type: 'bool', desc: 'rs-learn embed_text step failures (structured + watcher.log fallback)' },
  { name: 'recall-misses', type: 'bool', desc: 'recall events with hit=false grouped by query' },
  { name: 'recall-scores', type: 'bool', desc: 'histogram of top-hit recall scores' },
  { name: 'classifier-rejects', type: 'bool', desc: 'memorize_reject events grouped by reason' },
  { name: 'memory-leverage', type: 'bool', desc: 'memorize_fired vs subsequent recall reuse per session' },
  { name: 'recall-modes', type: 'bool', desc: 'distribution of recall.mode (vector_top_k|fallback_like|kv_query)' },
  { name: 'table-drops', type: 'bool', desc: 'catastrophic table_dropped events with dim deltas' },
  { name: 'discipline-sigil-ignored', type: 'bool', desc: 'discipline_sigil_ignored events (doc-vs-code drift)' },
];

const FLAGS = {
  string: FLAG_DEFS.filter(f => f.type === 'string').map(f => f.name),
  multi: FLAG_DEFS.filter(f => f.type === 'multi').map(f => f.name),
  number: FLAG_DEFS.filter(f => f.type === 'number').map(f => f.name),
  bool: FLAG_DEFS.filter(f => f.type === 'bool').map(f => f.name),
};
const KNOWN_FLAG_NAMES = new Set(FLAG_DEFS.map(f => f.name));

function schemaObject() {
  return {
    exitCodes: EXIT_CODES,
    flags: FLAG_DEFS.map(f => ({ flag: `--${f.name}`, alias: f.alias ? `--${f.alias}` : undefined, type: f.type, default: f.default, description: f.desc })),
    subcommands: [
      { name: 'gui', usage: 'gmsniff gui [--port N] [--open]', desc: 'launch the browser GUI server' },
      { name: '--prd-edit', usage: 'gmsniff --prd-edit <cwd> <id> [--status <s>] [--text <t>]', desc: 'rewrite a PRD row\'s status/text in <cwd>/.gm/prd.yml, atomic write' },
      { name: '--mutable-edit', usage: 'gmsniff --mutable-edit <cwd> <id> [--status <s>] [--witness <w>]', desc: 'rewrite a mutable row\'s status/witness in <cwd>/.gm/mutables.yml, atomic write' },
      { name: '--dispatch', usage: 'gmsniff --dispatch <cwd> <verb> [--json <payload>]', desc: 'write payload (default {}) to <cwd>/.gm/exec-spool/in/<verb>/<ts>.txt' },
    ],
    outputModes: {
      human: 'default: fixed-width columns, ANSI color unless --no-color/NO_COLOR/non-TTY, truncated to --truncate (default 200 chars)',
      json: '--json/--ndjson: one JSON object per line (ndjson), untruncated up to --truncate (default 2000 chars); same field set as human mode, no fields hidden or renamed between modes',
    },
    notes: [
      'An unrecognized --flag is a usage error (exit 2), never a silent no-op.',
      'A --limit/--head/--ctx/--truncate/--top/--tail-n value that does not parse as an integer is a usage error (exit 2), never a silent 0.',
      'This object is generated from the same FLAG_DEFS table that drives argument parsing and --help text -- it cannot drift from actual CLI behavior.',
    ],
  };
}

function printSchema() {
  const text = JSON.stringify(schemaObject(), null, 2) + '\n';
  // Colorize only on an interactive terminal: piped/machine consumers get
  // byte-identical output to the pre-sugar contract.
  process.stdout.write(process.stdout.isTTY && !process.env.NO_COLOR ? colorJson(text) : text);
}

function parseArgs(argv) {
  const opts = { _multi: {} };
  for (const k of FLAGS.multi) opts._multi[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (a === '-f') { opts.tail = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (!KNOWN_FLAG_NAMES.has(key)) {
      process.stderr.write(`unknown flag: --${key}\nrun 'gmsniff --help' for the flag list, or 'gmsniff --schema' for machine-readable flag descriptions\n`);
      process.exit(2);
    }
    if (FLAGS.bool.includes(key)) { opts[key] = true; continue; }
    const val = argv[++i];
    if (FLAGS.multi.includes(key)) { opts._multi[key].push(val); continue; }
    if (FLAGS.number.includes(key)) {
      const n = parseInt(val, 10);
      if (val === undefined || Number.isNaN(n)) {
        process.stderr.write(`--${key} requires an integer value, got: ${val === undefined ? '(missing)' : JSON.stringify(val)}\n`);
        process.exit(2);
      }
      opts[key] = n;
      continue;
    }
    opts[key] = val;
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`gmsniff — query, search, and tail gm-log events

USAGE
  gmsniff [filters] [output]            dump matching events (requires ≥1 flag)
  gmsniff -f [filters]                  live tail, fanned out across every discovered project
  gmsniff --list-sessions [filters]     per-session summary with phase walk
  gmsniff --list-deviations             recent deviations grouped by kind, with own/foreign split,
                                        severity, recovery verb, and per-hour rate
  gmsniff --list-deviations --own-only  only own-session deviations (real defects, not foreign gate-positives)
  gmsniff --list-deviations --foreign-only  only foreign-session deviations (predictability-regardless-of-LLM)
  gmsniff --list-events [--sub <s>]     event-type histogram
  gmsniff --stats [filters]             breakdown by sub / event / sess / day
  gmsniff --tree <sess>                 chronological process tree for one session
  gmsniff --efficiency <sess>           turn count, dispatch ratio, time-to-COMPLETE
  gmsniff --rollup <out.ndjson>         dump filtered events to file
  gmsniff --updates                     live drift state + update.* event history
  gmsniff --watchers                    one-line liveness + version per project cwd
  gmsniff --conformance                 paper §14 metrics: ε (unresolved mutables) + PRD-pending per project
  gmsniff --projects                    alias for --conformance: alive/dead, version, PRD-pending, mutable-unknown per discovered project
  gmsniff --prd-edit <cwd> <id> [--status <s>] [--text <t>]      rewrite a PRD row's status/text in <cwd>/.gm/prd.yml, atomic write
  gmsniff --mutable-edit <cwd> <id> [--status <s>] [--witness <w>]  rewrite a mutable row's status/witness in <cwd>/.gm/mutables.yml, atomic write
  gmsniff --dispatch <cwd> <verb> [--json <payload>]  write payload (default {}) to <cwd>/.gm/exec-spool/in/<verb>/<ts>.txt
  gmsniff --embed-failures [--stats]    rs-learn embed_text step failures (structured + watcher.log fallback)
  gmsniff --recall-misses [--top N]     recall events with hit=false grouped by query
  gmsniff --recall-scores [--bucket B]  histogram of top-hit recall scores (B default 0.1)
  gmsniff --classifier-rejects [--top N] memorize_reject grouped by reason
  gmsniff --memory-leverage [--sess id] [--days N] memorize_fired vs subsequent recall reuse per session
  gmsniff --recall-modes [--stats]      distribution of recall.mode (vector_top_k|fallback_like|kv_query)
  gmsniff --table-drops                 catastrophic table_dropped events with dim deltas
  gmsniff --discipline-sigil-ignored    discipline_sigil_ignored events (doc-vs-code drift)
  gmsniff --tree <sess> [--all-dispatch] drops dispatch.start unless --all-dispatch
  gmsniff gui [--port N] [--open]       launch browser GUI
  gmsniff --schema                      machine-readable JSON: every flag, type, default, exit codes,
                                        output-mode contract -- for agentic/programmatic callers

EXIT CODES
  0                      success (includes zero-match/empty-result queries -- absence of
                         data is not a failure)
  2                      usage error: bad/missing argument, unresolvable session id, or a
                         numeric flag value that failed to parse as an integer
  (other)                uncaught exception (Node default); never silently mapped to 0

SOURCES
  default                ~/.gm/gm-log (or GM_LOG_DIR) day/subsystem jsonl files
  fallback               when gm-log is empty/absent, evt: lines from each discovered
                         <project>/.gm/exec-spool/.watcher.log (roots: GM_SPOOL_DIRS,
                         DEV_ROOT, GM_DEV_ROOT, cwd, C:/dev or ~/dev)
  --spool <path>         force one project dir (or .watcher.log path) as the source
  -f / --tail            live: both sources run concurrently -- the central log watcher plus
                         a per-project .watcher.log tailer for every discovered project,
                         merged into one stream with cwd attribution preserved; rediscovers
                         new/removed projects every GM_FANOUT_REDISCOVER_MS (default 30000)
                         without restart. --spool with -f pins the fanout to one project.

TIME
  --since <t>            ISO date, epoch ms, or relative Ns/Nm/Nh/Nd/Nw
  --until <t>            (alias: --after, --before)

FILTERS (repeat = OR within a flag, AND across flags)
  --grep <re>            text regex; repeat = AND
  --igrep <re>           exclude if regex matches
  --invert               invert the filter result
  --sub <name>           subsystem (plugkit, hook, exec, rs_learn, …)
  --event <name>         event type (dispatch.end, deviation.gate-deny, …)
  --sess <id>            session id; repeat = OR
  --exclude-sess <id>    exclude session id prefix; repeat = exclude any
  --exclude-cwd <re>     exclude working-dir regex; repeat = exclude any
  --pid <n>              process id; repeat = OR
  --day <YYYY-MM-DD>     restrict to one day
  --cwd <re>             working-dir regex

OUTPUT
  --json                 ndjson rows (one event per line)
  --ndjson               alias for --json
  --full                 do not truncate
  --truncate <N>         max chars per row (default 200, 2000 in --json)
  --ctx <N>              N events of context before+after each match
  --limit <N>            stop after N matches
  --head <N>             alias for --limit
  --tail-n <N>           keep only the last N
  --reverse              newest first
  --sort <key>           ts|sub|event|sess|pid (default ts)
  --count                print only the match count
  -f, --tail             live tail after replay, fanned out across every discovered project
  --no-color             disable ANSI color

EXAMPLES
  gmsniff --since 1h --sub plugkit --event dispatch.end --limit 20
  gmsniff --sub hook --grep "deviation\\." --stats
  gmsniff --list-sessions --since 24h
  gmsniff --tree <sess-id>
  gmsniff --efficiency <sess-id>
  gmsniff -f --sub plugkit --event phase.transitioned
  gmsniff --rollup /tmp/dev-events.ndjson --since 7d --sub plugkit
  gmsniff gui --open
`);
}

function parseTime(t) {
  if (!t) return 0;
  if (typeof t === 'number') return t;
  const m = String(t).trim().match(/^(\d+)([smhdw])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const mul = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]];
    return Date.now() - n * mul;
  }
  if (/^\d+$/.test(String(t))) return parseInt(t, 10);
  const ts = Date.parse(t);
  if (isNaN(ts)) throw new Error(`bad time: ${t}`);
  return ts;
}

function buildFilter(opts) {
  const subs = opts._multi.sub.length ? new Set(opts._multi.sub) : null;
  const events = opts._multi.event.length ? new Set(opts._multi.event) : null;
  const sesss = opts._multi.sess.length ? opts._multi.sess : null;
  const excludeSesss = opts._multi['exclude-sess'] && opts._multi['exclude-sess'].length ? opts._multi['exclude-sess'] : null;
  const excludeCwdRes = opts._multi['exclude-cwd'] && opts._multi['exclude-cwd'].length ? opts._multi['exclude-cwd'].map(r => new RegExp(r, 'i')) : null;
  const pids = opts._multi.pid.length ? new Set(opts._multi.pid.map(String)) : null;
  const greps = opts._multi.grep.map(r => new RegExp(r, 'i'));
  const igreps = opts._multi.igrep.map(r => new RegExp(r, 'i'));
  const cwdRe = opts.cwd ? new RegExp(opts.cwd, 'i') : null;
  const since = parseTime(opts.since || opts.after);
  const until = parseTime(opts.until || opts.before);
  const day = opts.day;
  return (e) => {
    if (subs && !subs.has(e._sub)) return opts.invert;
    if (events && !events.has(e.event)) return opts.invert;
    if (sesss && !sesss.some(s => e.sess && e.sess.startsWith(s))) return opts.invert;
    if (excludeSesss && excludeSesss.some(s => e.sess && e.sess.startsWith(s))) return opts.invert;
    if (excludeCwdRes && e.cwd && excludeCwdRes.some(r => r.test(e.cwd))) return opts.invert;
    if (pids && !pids.has(String(e.pid))) return opts.invert;
    if (day && e._day !== day) return opts.invert;
    if (cwdRe && (!e.cwd || !cwdRe.test(e.cwd))) return opts.invert;
    if (since || until) {
      const ts = e.ts ? Date.parse(e.ts) : 0;
      if (since && ts < since) return opts.invert;
      if (until && ts > until) return opts.invert;
    }
    if (greps.length || igreps.length) {
      const s = JSON.stringify(e);
      for (const r of greps) if (!r.test(s)) return opts.invert;
      for (const r of igreps) if (r.test(s)) return opts.invert;
    }
    return !opts.invert;
  };
}

const SUB_COLORS = {
  plugkit: 31, hook: 35, exec: 34, rs_learn: 32, rs_codeinsight: 33,
  rs_search: 33, bootstrap: 36, plugkit_wrapper: 32, 'acp-launcher': 35,
};
function color(s, code) {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

// ANSI JSON sugar for human-mode output: keys cyan, strings green, numbers
// yellow, booleans magenta, null dim. Single-pass scan (no regex, no
// backtracking) gated by the exact same NO_COLOR/TTY rules as color(); every
// escape it emits is self-terminated, so a payload truncated mid-string can
// never leak an unclosed color state into the terminal. Raw control bytes in
// event data are escaped in both color and no-color paths so hostile log
// content cannot inject terminal sequences. --json/--ndjson output never
// routes through here.
const JSON_TOKEN_COLORS = { k: 36, s: 32, n: 33, b: 35, z: 90 };
const JSON_NUM_CHARS = '0123456789eE+.-';
function escapeControlChars(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    out += ((c < 0x20 && ch !== '\n' && ch !== '\t') || c === 0x7f)
      ? '\\u' + c.toString(16).padStart(4, '0')
      : ch;
  }
  return out;
}
function colorJson(text) {
  text = escapeControlChars(text);
  if (process.env.NO_COLOR || !process.stdout.isTTY) return text;
  let out = '', i = 0, plain = '';
  const flush = () => { if (plain) { out += plain; plain = ''; } };
  const paint = (t, s) => { out += `\x1b[${JSON_TOKEN_COLORS[t]}m${s}\x1b[0m`; };
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      i = Math.min(i + 1, text.length);
      let j = i;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
      flush();
      paint(text[j] === ':' ? 'k' : 's', text.slice(start, i));
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const start = i;
      i++;
      while (i < text.length && JSON_NUM_CHARS.includes(text[i])) i++;
      flush();
      paint('n', text.slice(start, i));
      continue;
    }
    if (text.startsWith('true', i)) { flush(); paint('b', 'true'); i += 4; continue; }
    if (text.startsWith('false', i)) { flush(); paint('b', 'false'); i += 5; continue; }
    if (text.startsWith('null', i)) { flush(); paint('z', 'null'); i += 4; continue; }
    plain += c; i++;
  }
  flush();
  return out;
}

function formatRow(e, opts) {
  const truncN = opts.full ? Infinity : (opts.truncate || (opts.json ? 2000 : 200));
  if (opts.json) {
    return JSON.stringify(e) + '\n';
  }
  // Envelope fields are interpolated raw into the terminal line -- escape
  // control bytes here too, or a crafted event ("[..." in ts/sub/event/
  // sess) injects terminal sequences around the color() calls.
  const t = escapeControlChars(e.ts ? e.ts.slice(0, 19).replace('T', ' ') : '?'.padEnd(19));
  const sub = escapeControlChars((e._sub || '?').padEnd(16).slice(0, 16));
  const ev = escapeControlChars((e.event || '?').padEnd(28).slice(0, 28));
  const subC = SUB_COLORS[e._sub] || 0;
  const realSess = e.sess && e.sess !== '(no-session)' ? e.sess : '';
  const cwdTag = !realSess && e.cwd ? '~' + e.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop().slice(0, 7) : '';
  const sessShort = escapeControlChars((realSess ? realSess.slice(0, 8) : (cwdTag || '--------')).padEnd(8).slice(0, 8));
  const payload = { ...e };
  // Underscore-prefixed keys are internal attribution metadata (_sub, _day,
  // _fp, _src from the watcher.log fallback tailer, ...) -- all stripped from
  // the human body uniformly; --json mode above keeps every field.
  for (const k of Object.keys(payload)) if (k.startsWith('_')) delete payload[k];
  delete payload.ts; delete payload.event; delete payload.sub; delete payload.pid; delete payload.sess; delete payload.cwd;
  let body = JSON.stringify(payload);
  if (body === '{}') body = '';
  if (body.length > truncN) body = body.slice(0, truncN) + '...';
  const evC = e.event && e.event.startsWith('deviation.') ? 31 : (e.event && e.event.endsWith('.error') ? 31 : 0);
  return `${t}  ${color(sub, subC)}  ${color(ev, evC)}  ${sessShort}  ${colorJson(body)}\n`;
}

function applyContext(matchedIdxs, all, ctx) {
  if (!ctx) return matchedIdxs.map(i => all[i]);
  const keep = new Set();
  for (const i of matchedIdxs) {
    for (let j = Math.max(0, i - ctx); j <= Math.min(all.length - 1, i + ctx); j++) keep.add(j);
  }
  return [...keep].sort((a, b) => a - b).map(i => all[i]);
}

function sortRows(rows, key, reverse) {
  const get = {
    ts: e => e.ts || '',
    sub: e => e._sub || '',
    event: e => e.event || '',
    sess: e => e.sess || '',
    pid: e => e.pid || 0,
  }[key] || (e => e.ts || '');
  rows.sort((a, b) => { const x = get(a), y = get(b); return x < y ? -1 : x > y ? 1 : 0; });
  if (reverse) rows.reverse();
  return rows;
}

function readWatcherStatus(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cwd, '.gm', 'exec-spool', '.status.json'), 'utf-8'));
    if (!j || !j.pid) return null;
    let alive = false;
    try { process.kill(j.pid, 0); alive = true; } catch (_) {}
    const age = j.ts ? Date.now() - j.ts : null;
    return { pid: j.pid, version: j.version, wrapper_sha: j.wrapper_sha || null, idle_limit_ms: j.idle_limit_ms || null, alive, age_ms: age };
  } catch (_) { return null; }
}

function readPrdMutablesState(cwd) {
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

function paperConformance(cwds) {
  const rows = [];
  const canon = (p) => p && path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const seen = new Set();
  for (const cwd of cwds) {
    const k = canon(cwd);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const st = readWatcherStatus(cwd);
    if (!st || !st.version) continue;
    const ps = readPrdMutablesState(cwd);
    rows.push({ cwd, ...st, ...ps });
  }
  rows.sort((a, b) => (b.alive ? 1 : 0) - (a.alive ? 1 : 0) || a.prd_pending - b.prd_pending);
  process.stdout.write(`STATE   VERSION    ε(mut) PRD-pend  PROJECT\n`);
  for (const r of rows) {
    const state = r.alive ? color('ALIVE ', 32) : color('dead  ', 31);
    const eps = r.mut_unknown > 0 ? color(String(r.mut_unknown).padStart(6), 33) : '     0';
    const prd = r.prd_pending > 0 ? color(String(r.prd_pending).padStart(8), 33) : '       0';
    const proj = path.basename(r.cwd);
    process.stdout.write(`${state}  v${(r.version || '?').padEnd(8)} ${eps} ${prd}  ${proj}\n`);
  }
  process.stderr.write(`# ${rows.length} projects - unresolved-mutables=eps, PRD-pend=open items\n`);
}

function collectAllCwds(all) {
  const cwds = new Set();
  for (const e of all) {
    if (e._sub === 'plugkit' && e.event === 'watcher.boot' && e.spool_dir) {
      cwds.add(path.dirname(path.dirname(e.spool_dir)));
    } else if (e.cwd) {
      cwds.add(e.cwd);
    }
  }
  return [...cwds];
}

// Atomic write: temp file in same dir + rename, so a crash mid-write never leaves a half-written
// prd.yml/mutables.yml (both are read by the live watcher and other CLI/GUI clients).
function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

// Splits a `- id: <x>\n  field: val\n...` YAML-ish list (same convention readPrdMutablesState
// relies on) into { header (before first row), rows: [{id, raw}] } so a single row can be
// rewritten in place without a full YAML parser dependency.
function splitYamlRows(text) {
  const idx = text.search(/^- id:/m);
  if (idx === -1) return { header: text, rows: [] };
  const header = text.slice(0, idx);
  const body = text.slice(idx);
  const parts = body.split(/(?=^- id:)/m).filter(Boolean);
  const rows = parts.map(raw => {
    const m = raw.match(/^- id:\s*(.+)\r?\n/);
    const id = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
    return { id, raw };
  });
  return { header, rows };
}

function yamlScalar(v) {
  const s = String(v);
  if (/[:'"#\n]|^\s|\s$/.test(s) || s === '') return `'${s.replace(/'/g, "''")}'`;
  return s;
}

// Rewrites (or appends, if absent) a `  field: value` line within one row's raw text block.
function setYamlField(raw, field, value) {
  const re = new RegExp(`^(  ${field}:).*$`, 'm');
  const line = `  ${field}: ${yamlScalar(value)}`;
  if (re.test(raw)) return raw.replace(re, line);
  // insert after the `- id:` line
  return raw.replace(/^(- id:.*\r?\n)/, `$1${line}\n`);
}

function editYamlRow(filePath, id, fields) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const { header, rows } = splitYamlRows(text);
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error(`id not found: ${id}`);
  let raw = row.raw;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    raw = setYamlField(raw, k, v);
  }
  row.raw = raw;
  const out = header + rows.map(r => r.raw).join('');
  atomicWriteFileSync(filePath, out);
  return raw;
}

function prdEdit(cwd, id, opts) {
  const filePath = path.join(cwd, '.gm', 'prd.yml');
  const fields = { status: opts.status };
  if (opts.text !== undefined) {
    // rows use whichever of text/note/subject/body already exists as the free-text field;
    // reuse it rather than bolting on a duplicate `text:` line. text is the dominant/current
    // convention; body is a superseded historical field kept last so legacy body-only rows
    // still get edited in place instead of gaining a spurious second field.
    const text = fs.readFileSync(filePath, 'utf-8');
    const { rows } = splitYamlRows(text);
    const row = rows.find(r => r.id === id);
    const existingField = row && /^  text:/m.test(row.raw) ? 'text'
      : row && /^  note:/m.test(row.raw) ? 'note'
      : row && /^  subject:/m.test(row.raw) ? 'subject'
      : row && /^  body:/m.test(row.raw) ? 'body'
      : 'subject';
    fields[existingField] = opts.text;
  }
  const raw = editYamlRow(filePath, id, fields);
  process.stdout.write(`# updated ${filePath} id=${id}\n${raw}`);
}

function mutableEdit(cwd, id, opts) {
  const filePath = path.join(cwd, '.gm', 'mutables.yml');
  const raw = editYamlRow(filePath, id, { status: opts.status, witness: opts.witness });
  process.stdout.write(`# updated ${filePath} id=${id}\n${raw}`);
}

function dispatchVerb(cwd, verb, jsonPayload) {
  if (!/^[a-zA-Z0-9-]+$/.test(verb)) {
    process.stderr.write(`--dispatch: verb must be alphanumeric+dash only, got: ${verb}\n`);
    process.exit(2);
  }
  let payload = '{}';
  if (jsonPayload) {
    JSON.parse(jsonPayload); // validate
    payload = jsonPayload;
  }
  const dir = path.join(cwd, '.gm', 'exec-spool', 'in', verb);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.txt`);
  fs.writeFileSync(file, payload, 'utf-8');
  process.stdout.write(`# dispatched verb=${verb} -> ${file}\n${colorJson(payload)}\n`);
}

function listSessions(all) {
  const m = new Map();
  for (const e of all) {
    let k = e.sess;
    if (!k) k = e.cwd ? `(cwd:${path.basename(e.cwd)})` : '(no-session)';
    let s = m.get(k);
    if (!s) {
      s = { sess: k, first: e.ts, last: e.ts, events: 0, phases: new Set(), dispatches: 0, deviations: 0, mut_res: 0, prd_add: 0, prd_res: 0, cwds: new Set() };
      m.set(k, s);
    }
    s.events++;
    if (e.ts) { if (e.ts < s.first) s.first = e.ts; if (e.ts > s.last) s.last = e.ts; }
    if (e.cwd) s.cwds.add(e.cwd);
    if (e._sub === 'plugkit') {
      if (e.event === 'phase.transitioned' && e.phase) s.phases.add(e.phase);
      if (e.event === 'instruction.served' && e.phase) s.phases.add(e.phase);
      if (e.event === 'dispatch.end') s.dispatches++;
      if (e.event === 'mutable.resolved') s.mut_res++;
      if (e.event === 'prd.added') s.prd_add++;
      if (e.event === 'prd.resolved') s.prd_res++;
    }
    if (typeof e.event === 'string' && e.event.startsWith('deviation.')) s.deviations++;
  }
  const rows = [...m.values()].sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  for (const s of rows) {
    const walk = PHASES.map(p => s.phases.has(p) ? color('#', 32) : color('.', 90)).join('');
    const dev = s.deviations ? color(String(s.deviations).padStart(3), 31) : '   ';
    const sessShort = s.sess.slice(0, 24).padEnd(24);
    const cwdsArr = [...s.cwds];
    const proj = cwdsArr.map(c => path.basename(c)).join(',').slice(0, 18).padEnd(18);
    let watcher = '             ';
    if (cwdsArr.length === 1) {
      const st = readWatcherStatus(cwdsArr[0]);
      if (st) {
        const tag = st.alive ? color(`v${st.version} ALIVE`, 32) : color(`v${st.version} dead `, 31);
        watcher = ` ${tag}`;
      }
    }
    process.stdout.write(`${(s.last || '').slice(0, 19)}  ${walk}  ev:${String(s.events).padStart(5)}  disp:${String(s.dispatches).padStart(4)}  prd:${s.prd_add}/${s.prd_res}  mut:${s.mut_res}  dev:${dev}  ${proj}  ${sessShort} ${watcher}\n`);
  }
  process.stderr.write(`# ${rows.length} sessions - phase walk: P E E V C - watcher: ALIVE/dead per project cwd\n`);
}

// Per-deviation-kind metadata: severity governs attention, recover names the verb the chain
// expects next (every gate denial names its recovery verb — surface it so a reader does not have
// to remember the mapping).
const DEVIATION_META = {
  'deviation.mid-chain-stall': { sev: 'warn', recover: 'instruction' },
  'deviation.long-gap-no-instruction': { sev: 'warn', recover: 'instruction' },
  'deviation.long-gap-retry-without-instruction': { sev: 'warn', recover: 'instruction' },
  'deviation.residual-premature': { sev: 'warn', recover: 'prd-resolve|prd-add' },
  'deviation.prd-anti-shape': { sev: 'warn', recover: 'prd-add (split into |F|=1 rows)' },
  'deviation.gate-deny': { sev: 'info', recover: '(named in reason)' },
  'deviation.prd-resolve-unknown-id': { sev: 'warn', recover: 'prd-add (correct id)' },
  'deviation.client-edit-no-witness': { sev: 'critical', recover: 'browser' },
  'deviation.browser-witness-missing': { sev: 'critical', recover: 'browser' },
  'deviation.browser-witness-hash-mismatch': { sev: 'critical', recover: 'browser' },
  'deviation.complete-without-ci-validation': { sev: 'critical', recover: 'git_status + CI-wait' },
  'deviation.consolidate-without-residual-scan': { sev: 'critical', recover: 'residual-scan' },
  'deviation.complete-without-residual-scan': { sev: 'critical', recover: 'residual-scan' },
  'deviation.push-dirty': { sev: 'critical', recover: 'git_status + commit' },
  'deviation.complete-chain-poll': { sev: 'info', recover: 'stop (chain terminal)' },
  'deviation.bash-git-bypass': { sev: 'warn', recover: 'git verbs' },
};
const SEV_COLOR = { critical: 31, warn: 33, info: 36 };
// A foreign session is tagged cwd-<hash> by the hook layer; an own session carries a real
// session id matching the configured GMSNIFF_OWN_SESSION prefix. Foreign deviations are
// gate-positives (predictability-regardless-of-agent); own deviations are real defects to correct.
function devOrigin(e) {
  const sess = String(e.sess || e.cwd || '');
  const own = process.env.GMSNIFF_OWN_SESSION;
  if (own && sess.startsWith(own)) return 'own';
  if (/^cwd-/.test(sess)) return 'foreign';
  return 'foreign';
}
function devMeta(ev) { return DEVIATION_META[ev] || { sev: 'warn', recover: '?' }; }

function listDeviations(all, opts = {}) {
  let filt = all.filter(e => typeof e.event === 'string' && e.event.startsWith('deviation.'));
  if (opts['own-only']) filt = filt.filter(e => devOrigin(e) === 'own');
  if (opts['foreign-only']) filt = filt.filter(e => devOrigin(e) === 'foreign');
  const byKind = new Map();
  let own = 0, foreign = 0;
  const bySev = new Map();
  for (const e of filt) {
    byKind.set(e.event, (byKind.get(e.event) || 0) + 1);
    const o = devOrigin(e); if (o === 'own') own++; else foreign++;
    const sev = devMeta(e.event).sev; bySev.set(sev, (bySev.get(sev) || 0) + 1);
  }
  const span = filt.length > 1 ? (Date.parse(filt[filt.length - 1].ts || 0) - Date.parse(filt[0].ts || 0)) : 0;
  const perHr = span > 0 ? (filt.length / (span / 3600000)).toFixed(1) : String(filt.length);
  process.stdout.write(`# total deviations: ${filt.length}  (own:${color(String(own), own ? 31 : 32)} foreign:${foreign})  rate: ${perHr}/hr\n`);
  process.stdout.write(`# by severity: ${['critical', 'warn', 'info'].map(s => `${color(s, SEV_COLOR[s])}:${bySev.get(s) || 0}`).join('  ')}\n`);
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    const m = devMeta(k);
    process.stdout.write(`  ${String(n).padStart(5)}  ${color(k, SEV_COLOR[m.sev] || 31)}  ${color(`[${m.sev}]`, SEV_COLOR[m.sev])}  recover:${m.recover}\n`);
  }
  process.stdout.write('\n# recent (last 20):\n');
  for (const e of filt.slice(-20).reverse()) {
    const o = devOrigin(e);
    const tag = o === 'own' ? color('OWN', 31) : color('foreign', 90);
    process.stdout.write(`${tag} ${formatRow(e, { truncate: 300 })}`);
  }
  if (own > 0) process.stderr.write(`# ${own} OWN-session deviation(s) — these are real defects to correct, not foreign gate-positives\n`);
}

function listEvents(all, sub) {
  const filt = sub ? all.filter(e => e._sub === sub) : all;
  const m = new Map();
  for (const e of filt) m.set(e.event || '?', (m.get(e.event || '?') || 0) + 1);
  for (const [k, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`${String(n).padStart(7)}  ${k}\n`);
  }
  process.stderr.write(`# ${m.size} distinct events${sub ? ` in sub=${sub}` : ''}\n`);
}

function stats(rows) {
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const bySub = new Map(), byEv = new Map(), bySess = new Map(), byDay = new Map();
  for (const e of rows) {
    bump(bySub, e._sub || '?');
    bump(byEv, e.event || '?');
    bump(bySess, (e.sess || '(none)').slice(0, 16));
    bump(byDay, e._day || '?');
  }
  const dump = (label, m, top = 15) => {
    process.stdout.write(`\n# ${label}\n`);
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).forEach(([k, v]) => process.stdout.write(`  ${String(v).padStart(7)}  ${k}\n`));
  };
  process.stdout.write(`# total: ${rows.length}\n`);
  dump('by sub', bySub);
  dump('by event', byEv, 20);
  dump('by sess (top 15)', bySess);
  dump('by day', byDay);
}

function watchers(all, opts = {}) {
  const cwds = new Set();
  const canon = (p) => p && path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const norm = new Map();
  const addCwd = (p) => { if (!p) return; const k = canon(p); if (!k) return; if (!norm.has(k)) { norm.set(k, p); cwds.add(p); } };
  for (const e of all) {
    if (e._sub === 'plugkit' && e.event === 'watcher.boot' && e.spool_dir) {
      addCwd(path.dirname(path.dirname(e.spool_dir)));
    } else if (e.cwd) {
      addCwd(e.cwd);
    }
  }
  const includeDead = !!opts.all;
  const rows = [];
  for (const cwd of cwds) {
    const status = readWatcherStatus(cwd);
    if (!status) continue;
    if (!status.version) continue;
    if (!includeDead && !status.alive) continue;
    const updateInfo = readUpdateAvailable(cwd);
    rows.push({ cwd, update: updateInfo, ...status });
  }
  rows.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return (a.age_ms || 0) - (b.age_ms || 0);
  });
  const aliveCount = rows.filter(r => r.alive).length;
  const deadShown = rows.length - aliveCount;
  const drifted = rows.filter(r => r.update && r.update.latest && r.update.latest !== r.version).length;
  process.stdout.write(`# ${rows.length} watchers ${includeDead ? '(alive + dead)' : '(alive only -- pass --all for dead)'}${drifted ? ` - ${drifted} drifted` : ''}\n`);
  const wrapperShas = new Set(rows.filter(r => r.wrapper_sha).map(r => r.wrapper_sha));
  const wrapperDivergent = wrapperShas.size > 1;
  process.stdout.write(`STATE   VERSION    WRAPPER  PID    AGE       PROJECT                 UPDATE\n`);
  for (const r of rows) {
    const state = r.alive ? color('ALIVE ', 32) : color('dead  ', 31);
    const age = r.age_ms !== null ? fmtAge(r.age_ms) : '?';
    const proj = path.basename(r.cwd);
    let update = '';
    if (r.update && r.update.latest && r.update.latest !== r.version) {
      update = color(`-> v${r.update.latest}`, 33);
    }
    const wsha = r.wrapper_sha ? (wrapperDivergent ? color(r.wrapper_sha, 33) : r.wrapper_sha) : '       ';
    process.stdout.write(`${state}  v${(r.version || '?').padEnd(8)} ${wsha} ${String(r.pid).padStart(6)} ${age.padEnd(9)} ${proj.padEnd(20)}  ${update}\n`);
  }
  process.stderr.write(`# ${aliveCount} alive${includeDead ? ` - ${deadShown} dead shown` : ''}${drifted ? ` - ${drifted} need bootstrap+respawn` : ''}\n`);
}

function readUpdateAvailable(cwd) {
  try {
    const p = path.join(cwd, '.gm', 'exec-spool', '.update-available.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return j && j.latest ? j : null;
  } catch (_) { return null; }
}

function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function parseRel(s) {
  const m = String(s).match(/^(\d+)([smhdw])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  return n * { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
}

function resolveCurrentSession(all) {
  const here = process.cwd();
  const canon = (p) => p && path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const target = canon(here);
  let best = null;
  for (const e of all) {
    if (!e.sess) continue;
    if (canon(e.cwd) !== target) continue;
    if (!best || (e.ts || '') > (best.ts || '')) best = { ts: e.ts, sess: e.sess };
  }
  return best ? best.sess : null;
}

function tree(all, sess, opts = {}) {
  if (sess === 'current' || sess === '.' || sess === '@') {
    const resolved = resolveCurrentSession(all);
    if (!resolved) { process.stderr.write(`--tree current: no events found for cwd ${process.cwd()}\n`); process.exit(2); }
    process.stderr.write(`# --tree current -> ${resolved}\n`);
    sess = resolved;
  }
  if (!sess) { process.stderr.write('--tree requires a session id (or "current" to auto-resolve from cwd)\n'); process.exit(2); }
  const wantEmpty = sess === '(no-session)' || sess === '' || sess === '-';
  const evs = all.filter(e => wantEmpty ? !e.sess : (e.sess === sess || (e.sess || '').startsWith(sess))).sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  let currentPhase = '?';
  let firstInstructionSeen = false;
  const gaps = [];
  const showAllDispatch = !!opts.allDispatch;
  for (const e of evs) {
    if (e._sub !== 'plugkit' && !(typeof e.event === 'string' && e.event.startsWith('deviation.'))) continue;
    if (!showAllDispatch && e.event === 'dispatch.start') continue;
    if (e.event === 'instruction.served') firstInstructionSeen = true;
    if (e.event === 'phase.transitioned' && e.phase) currentPhase = e.phase;
    if (e.event === 'instruction.served' && e.phase) currentPhase = e.phase;
    const t = (e.ts || '').slice(11, 19);
    const isPhase = e.event === 'phase.transitioned' || e.event === 'instruction.served';
    const isDev = typeof e.event === 'string' && e.event.startsWith('deviation.');
    const indent = isPhase ? '' : '  ';
    const evC = isDev ? 31 : (isPhase ? 36 : 0);
    let extra = '';
    if (e.id) extra += ` id=${e.id}`;
    if (e.phase) extra += ` phase=${e.phase}`;
    if (e.reason) extra += ` reason=${e.reason}`;
    if (Array.isArray(e.residuals)) extra += ` residuals=[${e.residuals.length}]`;
    if (e.verb) extra += ` verb=${e.verb}`;
    if (e.event === 'dispatch.end' && typeof e.ms === 'number') extra += ` ms=${e.ms}`;
    if (e.key) extra += ` key=${String(e.key).slice(0, 32)}`;
    process.stdout.write(`${indent}${t}  ${color(e.event, evC)}${extra}\n`);
  }
  if (!firstInstructionSeen && evs.length > 0) gaps.push('no instruction.served event — agent did not enter the loop');
  for (const e of evs) if (typeof e.event === 'string' && e.event.startsWith('deviation.')) gaps.push(`${e.event} at ${e.ts}`);
  if (gaps.length) {
    process.stdout.write('\n' + color('# gaps:', 31) + '\n');
    for (const g of gaps) process.stdout.write(`  ${color('!', 31)} ${g}\n`);
  }
  process.stderr.write(`# ${evs.length} events for session ${sess} - final phase: ${currentPhase}\n`);
}

function efficiency(all, sess) {
  if (!sess) { process.stderr.write('--efficiency requires a session id\n'); process.exit(2); }
  const wantEmpty = sess === '(no-session)' || sess === '' || sess === '-';
  const evs = all.filter(e => wantEmpty ? !e.sess : (e.sess === sess || (e.sess || '').startsWith(sess))).sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  if (!evs.length) { process.stderr.write(`# no events for session ${sess}\n`); process.exit(0); }
  let dispatches = 0, transitions = 0, instructions = 0, devs = 0, mutRes = 0;
  const verbs = new Map();
  const phasesSeen = new Set();
  let completeAt = null;
  for (const e of evs) {
    if (e._sub === 'plugkit') {
      if (e.event === 'dispatch.end') { dispatches++; if (e.verb) verbs.set(e.verb, (verbs.get(e.verb) || 0) + 1); }
      if (e.event === 'phase.transitioned') {
        transitions++;
        if (e.phase) phasesSeen.add(e.phase);
        if (e.phase === 'COMPLETE') completeAt = e.ts;
      }
      if (e.event === 'instruction.served') {
        instructions++;
        if (e.phase) phasesSeen.add(e.phase);
      }
      if (e.event === 'mutable.resolved') mutRes++;
    }
    if (typeof e.event === 'string' && e.event.startsWith('deviation.')) devs++;
  }
  const first = evs[0].ts;
  const last = evs[evs.length - 1].ts;
  const durMs = Date.parse(last) - Date.parse(first);
  process.stdout.write(`session:           ${sess}\n`);
  process.stdout.write(`events:            ${evs.length}\n`);
  process.stdout.write(`duration:          ${Math.round(durMs / 1000)}s  (${first} -> ${last})\n`);
  process.stdout.write(`dispatches:        ${dispatches}\n`);
  process.stdout.write(`instructions:      ${instructions}\n`);
  process.stdout.write(`transitions:       ${transitions}\n`);
  process.stdout.write(`mutables resolved: ${mutRes}\n`);
  process.stdout.write(`deviations:        ${devs}\n`);
  process.stdout.write(`phases reached:    ${[...phasesSeen].join(', ') || '(none)'}\n`);
  process.stdout.write(`completed:         ${completeAt || color('no', 31)}\n`);
  process.stdout.write(`disp/trans ratio:  ${transitions ? (dispatches / transitions).toFixed(1) : 'n/a'}\n`);
  process.stdout.write('\n# verbs by frequency:\n');
  for (const [v, n] of [...verbs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    process.stdout.write(`  ${String(n).padStart(4)}  ${v}\n`);
  }
}

function findUpdateMarkers() {
  const roots = [];
  for (const env of ['DEV_ROOT', 'GM_DEV_ROOT']) {
    if (process.env[env]) roots.push(process.env[env]);
  }
  roots.push(process.cwd());
  if (process.platform === 'win32') roots.push('C:/dev'); else roots.push(path.join(os.homedir(), 'dev'));
  const seen = new Set();
  const markers = [];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const proj = path.join(root, d.name);
        if (seen.has(proj)) continue;
        seen.add(proj);
        const marker = path.join(proj, '.gm', 'exec-spool', '.update-available.json');
        try {
          if (fs.existsSync(marker)) {
            const content = JSON.parse(fs.readFileSync(marker, 'utf8'));
            const status = path.join(proj, '.gm', 'exec-spool', '.status.json');
            let runningVersion = null;
            try { runningVersion = JSON.parse(fs.readFileSync(status, 'utf8')).version; } catch (_) {}
            markers.push({ project: path.basename(proj), path: proj, ...content, running: runningVersion });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  return markers;
}

function updates(all, opts) {
  const markers = findUpdateMarkers();
  if (opts.json) {
    process.stdout.write(JSON.stringify({ live: markers, history: all.filter(e => typeof e.event === 'string' && e.event.startsWith('update.')) }, null, 2) + '\n');
    return;
  }
  process.stdout.write('# live drift state:\n');
  if (!markers.length) {
    process.stdout.write('  (none — every project is current)\n');
  } else {
    for (const m of markers) {
      const ageMin = m.checked_at_ms ? Math.round((Date.now() - m.checked_at_ms) / 60_000) : null;
      const ageStr = ageMin === null ? '?' : `${ageMin}m ago`;
      process.stdout.write(`  ${color('!', 31)} ${m.project.padEnd(18)} installed=${m.installed} latest=${color(m.latest, 33)} running=${m.running || '?'} checked=${ageStr}\n`);
      process.stdout.write(`    ${m.update_url || ''}\n`);
    }
  }
  const events = all.filter(e => typeof e.event === 'string' && e.event.startsWith('update.'));
  process.stdout.write(`\n# update.* event history (${events.length}):\n`);
  for (const e of events.slice(-20).reverse()) {
    process.stdout.write(formatRow(e, { truncate: 300 }));
  }
  if (markers.length) {
    process.stdout.write('\n' + color('# to update: bun x gm-plugkit@latest  (or npx -y gm-plugkit@latest)', 36) + '\n');
  }
}

function readWatcherLogEmbedFails(cwd, sinceMs, untilMs) {
  try {
    const txt = fs.readFileSync(path.join(cwd, '.gm', 'exec-spool', '.watcher.log'), 'utf-8');
    const failRe = /embed::embed_text step '([^']+)' failed/;
    const tsRe = /"ts":(\d{13})/;
    const raw = [];
    const pending = [];
    let lastTs = 0;
    for (const line of txt.split('\n')) {
      const tm = line.match(tsRe);
      if (tm) {
        lastTs = parseInt(tm[1], 10);
        for (const p of pending) p.ts = lastTs;
        pending.length = 0;
      }
      const fm = line.match(failRe);
      if (!fm) continue;
      const entry = { step: fm[1], _src: 'watcher.log', cwd, ts: lastTs || 0 };
      raw.push(entry);
      if (!lastTs) pending.push(entry);
    }
    const out = [];
    for (const e of raw) {
      if (sinceMs && (!e.ts || e.ts < sinceMs)) continue;
      if (untilMs && e.ts && e.ts > untilMs) continue;
      e._day = e.ts ? new Date(e.ts).toISOString().slice(0, 10) : undefined;
      out.push(e);
    }
    return out;
  } catch (_) { return []; }
}

function embedFailures(all, opts) {
  const structured = all.filter(e => e.event === 'embed_fail' || (e._sub === 'rs_learn' && e.event === 'embed_fail'));
  let fallback = [];
  if (!structured.length) {
    const sinceMs = parseTime(opts.since || opts.after);
    const untilMs = parseTime(opts.until || opts.before);
    const cwds = new Set();
    for (const e of all) if (e.cwd) cwds.add(e.cwd);
    for (const c of cwds) fallback.push(...readWatcherLogEmbedFails(c, sinceMs, untilMs));
  }
  const evs = [...structured, ...fallback];
  if (opts.stats) {
    const byStep = new Map(), byDay = new Map(), byProj = new Map();
    for (const e of evs) {
      const step = e.step || '?';
      byStep.set(step, (byStep.get(step) || 0) + 1);
      if (e._day) byDay.set(e._day, (byDay.get(e._day) || 0) + 1);
      const proj = e.cwd ? path.basename(e.cwd) : '?';
      byProj.set(proj, (byProj.get(proj) || 0) + 1);
    }
    process.stdout.write(`# embed failures: ${evs.length} (${structured.length} structured, ${fallback.length} watcher.log)\n`);
    const dump = (label, m) => { process.stdout.write(`\n# ${label}\n`); [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([k,v]) => process.stdout.write(`  ${String(v).padStart(6)}  ${k}\n`)); };
    dump('by step', byStep); dump('by day', byDay); dump('by project', byProj);
    return;
  }
  const byStep = new Map();
  for (const e of evs) {
    const step = e.step || '?';
    let s = byStep.get(step);
    if (!s) { s = { step, count: 0, last_ts: 0 }; byStep.set(step, s); }
    s.count++;
    const tsNum = typeof e.ts === 'number' ? e.ts : (e.ts ? Date.parse(e.ts) : 0);
    if (tsNum && tsNum > s.last_ts) s.last_ts = tsNum;
  }
  process.stdout.write(`# embed failures: ${evs.length} (${structured.length} structured, ${fallback.length} watcher.log fallback)\n`);
  process.stdout.write(`COUNT   LAST                 STEP\n`);
  for (const s of [...byStep.values()].sort((a,b)=>b.count-a.count).slice(0,20)) {
    const lastStr = s.last_ts ? new Date(s.last_ts).toISOString() : '';
    process.stdout.write(`${String(s.count).padStart(5)}   ${lastStr.slice(0,19).padEnd(19)}  ${s.step}\n`);
  }
}

function recallMisses(all, opts) {
  const evs = all.filter(e => e.event === 'recall' && e.hit === false);
  if (evs.length === 0) { process.stdout.write('# recall misses: 0 events matching event=recall && hit=false\n'); return; }
  const byQuery = new Map();
  for (const e of evs) {
    const q = e.query || '?';
    let s = byQuery.get(q);
    if (!s) { s = { query: q, count: 0, last_ts: '' }; byQuery.set(q, s); }
    s.count++;
    if (e.ts && e.ts > s.last_ts) s.last_ts = e.ts;
  }
  const top = opts.top || 20;
  process.stdout.write(`# recall misses: ${evs.length} events - ${byQuery.size} distinct queries\n`);
  process.stdout.write(`COUNT   LAST                 QUERY\n`);
  for (const s of [...byQuery.values()].sort((a,b)=>b.count-a.count).slice(0, top)) {
    process.stdout.write(`${String(s.count).padStart(5)}   ${(s.last_ts||'').slice(0,19).padEnd(19)}  ${s.query}\n`);
  }
}

function recallScores(all, opts) {
  const evs = all.filter(e => e.event === 'recall');
  if (evs.length === 0) { process.stdout.write('# recall scores: 0 events matching event=recall\n'); return; }
  const bucket = parseFloat(opts.bucket) || 0.1;
  const buckets = new Map();
  let noScore = 0;
  for (const e of evs) {
    let score = e.top_score;
    if (score === undefined && Array.isArray(e.hits) && e.hits[0] && typeof e.hits[0].score === 'number') score = e.hits[0].score;
    if (typeof score !== 'number') { noScore++; continue; }
    const b = Math.floor(score / bucket) * bucket;
    const key = b.toFixed(2);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  process.stdout.write(`# recall score histogram: ${evs.length} events, bucket=${bucket}, no-score=${noScore}\n`);
  const keys = [...buckets.keys()].sort((a,b)=>parseFloat(a)-parseFloat(b));
  const max = Math.max(1, ...buckets.values());
  for (const k of keys) {
    const n = buckets.get(k);
    const bar = '#'.repeat(Math.ceil(40 * n / max));
    process.stdout.write(`  ${k.padStart(5)}  ${String(n).padStart(6)}  ${bar}\n`);
  }
}

function classifierRejects(all, opts) {
  const evs = all.filter(e => e.event === 'memorize_reject');
  if (evs.length === 0) { process.stdout.write('# memorize rejects: 0 events matching event=memorize_reject -- confirm this build emits memorize_reject before reading this as "no rejects".\n'); return; }
  const byReason = new Map();
  for (const e of evs) {
    const r = e.reason || '?';
    byReason.set(r, (byReason.get(r) || 0) + 1);
  }
  const top = opts.top || 20;
  process.stdout.write(`# memorize rejects: ${evs.length}\n`);
  process.stdout.write(`\n# by reason\n`);
  for (const [k, v] of [...byReason.entries()].sort((a,b)=>b[1]-a[1]).slice(0, top)) {
    process.stdout.write(`  ${String(v).padStart(6)}  ${k}\n`);
  }
  process.stdout.write(`\n# recent 10\n`);
  for (const e of evs.slice(-10).reverse()) {
    const tp = e.text_prefix || e.text || '';
    process.stdout.write(`  ${(e.ts||'').slice(0,19)}  reason=${e.reason||'?'}  ${String(tp).slice(0,80)}\n`);
  }
}

function memoryLeverage(all, opts) {
  const days = parseInt(opts.days, 10) || 7;
  const cutoff = Date.now() - days * 86400000;
  const filt = (e) => { const t = e.ts ? Date.parse(e.ts) : 0; return t >= cutoff && (!opts.sess || (e.sess && e.sess.startsWith(opts.sess))); };
  const evs = all.filter(filt);
  const bySess = new Map();
  for (const e of evs) {
    const k = e.sess || '(no-session)';
    let s = bySess.get(k);
    if (!s) { s = { sess: k, memorized: 0, memorized_keys: new Set(), recalled_back: 0 }; bySess.set(k, s); }
    if (e.event === 'memorize_fired' || e.event === 'memorize.fired') {
      s.memorized++;
      if (e.key) s.memorized_keys.add(String(e.key));
    }
  }
  for (const e of evs) {
    if (e._sub !== 'rs_learn' || e.event !== 'recall') continue;
    const k = e.sess || '(no-session)';
    const s = bySess.get(k);
    if (!s) continue;
    const hitKeys = [];
    if (Array.isArray(e.hits)) for (const h of e.hits) if (h && h.key) hitKeys.push(String(h.key));
    if (e.key) hitKeys.push(String(e.key));
    for (const hk of hitKeys) if (s.memorized_keys.has(hk)) { s.recalled_back++; break; }
  }
  process.stdout.write(`# memory leverage (last ${days}d${opts.sess ? `, sess=${opts.sess}` : ''})\n`);
  process.stdout.write(`SESS                      MEMORIZED  RECALLED_BACK  LEVERAGE%\n`);
  for (const s of [...bySess.values()].sort((a,b)=>b.memorized-a.memorized)) {
    if (!s.memorized && !s.recalled_back) continue;
    const lev = s.memorized ? ((s.recalled_back / s.memorized) * 100).toFixed(1) : '0.0';
    process.stdout.write(`${s.sess.slice(0,24).padEnd(24)}  ${String(s.memorized).padStart(9)}  ${String(s.recalled_back).padStart(13)}  ${lev.padStart(8)}\n`);
  }
}

function recallModes(all, opts) {
  const evs = all.filter(e => e.event === 'recall');
  if (evs.length === 0) { process.stdout.write('# recall modes: 0 events matching event=recall\n'); return; }
  const byMode = new Map();
  for (const e of evs) {
    const m = e.mode || '(none)';
    byMode.set(m, (byMode.get(m) || 0) + 1);
  }
  process.stdout.write(`# recall modes: ${evs.length} events\n`);
  const total = evs.length || 1;
  for (const [k, v] of [...byMode.entries()].sort((a,b)=>b[1]-a[1])) {
    const pct = ((v / total) * 100).toFixed(1);
    process.stdout.write(`  ${String(v).padStart(6)}  ${pct.padStart(5)}%  ${k}\n`);
  }
  if (opts.stats) {
    const byDay = new Map();
    for (const e of evs) {
      const k = `${e._day || '?'}|${e.mode || '(none)'}`;
      byDay.set(k, (byDay.get(k) || 0) + 1);
    }
    process.stdout.write(`\n# by day|mode\n`);
    for (const [k, v] of [...byDay.entries()].sort()) process.stdout.write(`  ${String(v).padStart(6)}  ${k}\n`);
  }
}

function tableDrops(all) {
  const evs = all.filter(e => e.event === 'table_dropped');
  if (evs.length === 0) {
    process.stdout.write('# table drops: 0 events matching event=table_dropped -- not observed emitted by any sampled gm-log build; a 0 here is NOT a confirmed-healthy zero, it may mean this build never emits table_dropped at all.\n');
    return;
  }
  process.stdout.write(`# table drops: ${evs.length}\n`);
  process.stdout.write(`TS                   TABLE                 OLD_DIM  NEW_DIM\n`);
  for (const e of evs) {
    process.stdout.write(`${(e.ts||'').slice(0,19)}  ${(e.table||'?').padEnd(20)}  ${String(e.old_dim||'?').padStart(7)}  ${String(e.new_dim||'?').padStart(7)}\n`);
  }
}

function disciplineSigilIgnored(all) {
  const evs = all.filter(e => e.event === 'discipline_sigil_ignored');
  if (evs.length === 0) { process.stdout.write('# discipline_sigil_ignored: 0 events matching event=discipline_sigil_ignored -- confirm this build emits the event before reading this as "no ignored sigils".\n'); return; }
  process.stdout.write(`# discipline_sigil_ignored: ${evs.length} (doc-vs-code drift)\n`);
  for (const e of evs.slice(-50).reverse()) {
    process.stdout.write(formatRow(e, { truncate: 300 }));
  }
}

async function rollup(out, all, filter) {
  const filtered = all.filter(filter);
  const body = filtered.map(e => JSON.stringify(e)).join('\n') + (filtered.length ? '\n' : '');
  fs.writeFileSync(out, body);
  process.stderr.write(`# rolled up ${filtered.length} events -> ${out}\n`);
}

// Live tail fans out across every discovered gm-plugkit project concurrently (one
// ProjectLogTailer per project's .gm/exec-spool/.watcher.log via MultiProjectWatcher),
// same coverage as the GUI server's Store.startLive -- plus the central ~/.gm/gm-log tree
// watcher for the case where that log aggregates events directly. New projects appearing
// on disk after the CLI started are picked up by the fanout's periodic rediscovery with no
// restart; --spool <path> narrows to one explicit project dir (or .watcher.log path), same
// semantics as the replay path's --spool, bypassing rediscovery for a pinned single target.
async function liveTail(filter, opts) {
  const watcher = new GmLogWatcher(DEFAULT_LOG_DIR);
  watcher.on('event', e => { if (filter(e)) process.stdout.write(formatRow(e, opts)); });
  watcher.on('error', err => process.stderr.write(`# error: ${err?.message || err}\n`));
  watcher.start();

  const fanout = new MultiProjectWatcher({ explicit: opts.spool });
  fanout.on('event', e => { if (filter(e)) process.stdout.write(formatRow(e, opts)); });
  fanout.on('error', err => process.stderr.write(`# error (${err?.cwd || '?'}): ${err?.message || err}\n`));
  fanout.on('project.added', p => process.stderr.write(`# watching: ${p.cwd}\n`));
  fanout.on('project.removed', p => process.stderr.write(`# stopped watching (log gone): ${p.cwd}\n`));
  fanout.start();

  const projectCount = fanout.projects().length;
  process.stdout.write(`# tailing... ${projectCount} project(s) + central log (Ctrl-C to exit)\n`);
  process.stdin.resume();
  // await both stop()s (each drains libuv's async fs.watch-handle close, see index.js) before
  // exiting -- an immediate process.exit() right after a synchronous close on Windows can
  // race libuv's own handle-close bookkeeping and crash with a UV_HANDLE_CLOSING assertion,
  // reproduced against this exact watcher+fanout shape during VERIFY.
  process.on('SIGINT', () => {
    Promise.all([watcher.stop(), fanout.stop()]).finally(() => process.exit(0));
  });
}

async function launchGui(args) {
  const { createServer } = await import('./server.js');
  let port = 0, open = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = parseInt(args[++i], 10) || 0;
    else if (args[i] === '--open') open = true;
  }
  const { url } = await createServer({ logDir: DEFAULT_LOG_DIR, port });
  process.stdout.write(`gmsniff gui - ${url}\n`);
  if (open) {
    try {
      const { execSync } = await import('child_process');
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      execSync(cmd, { shell: true });
    } catch {}
  }
  process.stdin.resume();
}

const argv = process.argv.slice(2);
if (argv[0] === 'gui') {
  await launchGui(argv.slice(1));
} else if (argv[0] === '--schema') {
  printSchema();
  process.exit(0);
} else if (argv[0] === '--prd-edit' || argv[0] === '--mutable-edit' || argv[0] === '--dispatch') {
  const verb = argv[0];
  const cwd = argv[1];
  const idOrVerb = argv[2];
  if (!cwd || !idOrVerb) {
    process.stderr.write(`${verb} requires <cwd> <${verb === '--dispatch' ? 'verb' : 'id'}>\n`);
    process.exit(2);
  }
  // Manual mini-parse (not the shared parseArgs/FLAGS.bool table): --json's value here is
  // always a raw JSON string payload, never the global boolean ndjson-alias flag.
  const rest = {};
  const tail = argv.slice(3);
  for (let i = 0; i < tail.length; i++) {
    if (tail[i].startsWith('--')) { rest[tail[i].slice(2)] = tail[++i]; }
  }
  if (verb === '--prd-edit') prdEdit(cwd, idOrVerb, rest);
  else if (verb === '--mutable-edit') mutableEdit(cwd, idOrVerb, rest);
  else dispatchVerb(cwd, idOrVerb, rest.json);
  process.exit(0);
} else {
  const opts = parseArgs(argv);
  if (opts.help || argv.length === 0) { printHelp(); process.exit(0); }
  if (opts.schema) { printSchema(); process.exit(0); }
  if (opts['no-color']) process.env.NO_COLOR = '1';

  const filter = buildFilter(opts);

  if (opts.tail) {
    await liveTail(filter, opts);
  } else {
    const all = replayAll(DEFAULT_LOG_DIR, { spool: opts.spool });

    if (opts['list-sessions']) { listSessions(all.filter(filter)); process.exit(0); }
    if (opts['list-deviations']) { listDeviations(all.filter(filter), opts); process.exit(0); }
    if (opts['list-events']) { listEvents(all.filter(filter), opts.sub); process.exit(0); }
    if (opts.updates) { updates(all, opts); process.exit(0); }
    if (opts.tree) { tree(all, opts.tree, { allDispatch: opts['all-dispatch'] }); process.exit(0); }
    if (opts.watchers) { watchers(all, opts); process.exit(0); }
    if (opts.conformance || opts.projects) {
      paperConformance(collectAllCwds(all));
      process.exit(0);
    }
    if (opts['embed-failures']) { embedFailures(all.filter(filter), opts); process.exit(0); }
    if (opts['recall-misses']) { recallMisses(all.filter(filter), opts); process.exit(0); }
    if (opts['recall-scores']) { recallScores(all.filter(filter), opts); process.exit(0); }
    if (opts['classifier-rejects']) { classifierRejects(all.filter(filter), opts); process.exit(0); }
    if (opts['memory-leverage']) { memoryLeverage(all.filter(filter), opts); process.exit(0); }
    if (opts['recall-modes']) { recallModes(all.filter(filter), opts); process.exit(0); }
    if (opts['table-drops']) { tableDrops(all.filter(filter)); process.exit(0); }
    if (opts['discipline-sigil-ignored']) { disciplineSigilIgnored(all.filter(filter)); process.exit(0); }
    if (opts.efficiency) { efficiency(all, opts.efficiency); process.exit(0); }
    if (opts.rollup) { await rollup(opts.rollup, all, filter); process.exit(0); }

    const matched = all.filter(filter);
    const ctx = applyContext(matched.map((_, i) => i).filter(i => filter(matched[i])), matched, opts.ctx || 0);
    let rows = ctx.length === matched.length ? matched : ctx;
    rows = sortRows(rows, opts.sort || 'ts', opts.reverse);
    if (opts['tail-n']) rows = rows.slice(-opts['tail-n']);
    const limit = opts.limit || opts.head || 0;
    if (limit) rows = rows.slice(0, limit);

    if (opts.stats) { stats(rows); process.exit(0); }
    if (opts.count) { process.stdout.write(`${rows.length}\n`); process.exit(0); }
    for (const e of rows) process.stdout.write(formatRow(e, opts));
    process.stderr.write(`# ${all.length} total - ${rows.length} matched\n`);
  }
}
