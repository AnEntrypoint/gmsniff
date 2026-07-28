#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GmLogWatcher, MultiProjectWatcher, replayAll, DEFAULT_LOG_DIR, correlationOf, correlationKey, correlationCoverage, sourceStaleness } from './index.js';
import { readWatcherStatus, readProjectLiveness, readInstalledVersions, readTurnState, readTurnSummary, readLivePhaseState, VERB_ALLOWLIST, isUsableVerb, isRetiredVerb, isKnownVerb } from './registry.js';
import { parseLine, readTail, DEFAULT_REPLAY_BYTES } from './watcher-log.js';

const GM_TOOLS_DIR = process.env.GM_TOOLS_DIR || path.join(os.homedir(), '.gm-tools');
const AGENTPLUG_DIR = process.env.AGENTPLUG_DIR || path.join(os.homedir(), '.agentplug');

const PHASES = ['PLAN', 'EXECUTE', 'EMIT', 'VERIFY', 'CONSOLIDATE', 'COMPLETE'];

const EXIT_CODES = { 0: 'success (includes zero-match queries)', 2: 'usage error (bad/missing argument, malformed value)' };

// Single source of truth for parseArgs, printHelp and --schema alike: parseArgs recognizes
// nothing this table does not describe, so help text cannot drift from behavior.
const FLAG_DEFS = [
  { name: 'help', alias: 'h', type: 'bool', desc: 'print human-readable help and exit 0' },
  { name: 'schema', type: 'bool', desc: 'print machine-readable JSON description of every flag + output shape, then exit 0' },
  { name: 'spool', type: 'string', desc: 'force one project dir (or .watcher.log path) as the event source' },
  { name: 'since', alias: 'after', type: 'string', desc: 'ISO date, epoch ms, or relative Ns/Nm/Nh/Nd/Nw; alias --after' },
  { name: 'until', alias: 'before', type: 'string', desc: 'ISO date, epoch ms, or relative Ns/Nm/Nh/Nd/Nw; alias --before' },
  { name: 'sub', type: 'multi', desc: 'filter by subsystem (plugkit, hook, bootstrap, memory, ...); repeat = OR' },
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
  { name: 'tail-n', type: 'number', desc: 'keep only the last N rows after sort' },
  { name: 'ctx', type: 'number', default: 0, desc: 'N events of context before+after each match' },
  { name: 'truncate', type: 'number', default: 200, desc: 'max chars per row body; default 200 human / 2000 --json; --full disables' },
  { name: 'top', type: 'number', default: 20, desc: 'top-N cutoff for --recall-misses/--classifier-rejects' },
  { name: 'json', alias: 'ndjson', type: 'bool', desc: 'emit ndjson rows (one JSON event per line) instead of human-formatted text' },
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
  { name: 'all', type: 'bool', desc: 'with --watchers: include dead watchers too' },
  { name: 'all-dispatch', type: 'bool', desc: 'with --tree: show dispatch.start events too (dropped by default)' },
  { name: 'no-color', type: 'bool', desc: 'disable ANSI color in output' },
  { name: 'embed-failures', type: 'bool', desc: 'embed_fail/embed_query_failed/memorize_embed_failed events' },
  { name: 'recall-misses', type: 'bool', desc: 'recall events with hit=false grouped by query' },
  { name: 'recall-scores', type: 'bool', desc: 'histogram of top-hit recall scores' },
  { name: 'classifier-rejects', type: 'bool', desc: 'memorize_reject events grouped by reason' },
  { name: 'memory-leverage', type: 'bool', desc: 'recall hit-rate + memorize reject/dedup/embed-fail counts, per project' },
  { name: 'recall-modes', type: 'bool', desc: 'distribution of recall.mode (vector_top_k|fallback_like|kv_query)' },
  { name: 'table-drops', type: 'bool', desc: 'catastrophic table_dropped events with dim deltas' },
  { name: 'discipline-sigil-ignored', type: 'bool', desc: 'discipline_sigil_ignored events (doc-vs-code drift)' },
  { name: 'agents', alias: 'live', type: 'bool', desc: 'live manager view: every gm agent\'s phase, instruction, elapsed-in-phase, PRD/mutable counts, recent output; add -f to refresh' },
  { name: 'agent', type: 'string', desc: 'with --agents: drill into one project by cwd or basename (full instruction text + longer output feed)' },
  { name: 'interval', type: 'number', default: 2000, desc: 'with --agents -f: refresh period in ms (min 250)' },
  { name: 'output-lines', type: 'number', default: 6, desc: 'with --agents: recent output lines per project (drilldown uses 4x)' },
  { name: 'idle', type: 'bool', desc: 'with --agents: include idle/COMPLETE agents too (default: working agents first, idle summarized)' },
];

const FLAG_ALIASES = new Map(FLAG_DEFS.filter(f => f.alias && f.alias.length > 1).map(f => [f.alias, f.name]));

const FLAGS = {
  string: FLAG_DEFS.filter(f => f.type === 'string').map(f => f.name),
  multi: FLAG_DEFS.filter(f => f.type === 'multi').map(f => f.name),
  number: FLAG_DEFS.filter(f => f.type === 'number').map(f => f.name),
  bool: FLAG_DEFS.filter(f => f.type === 'bool').map(f => f.name),
};
const KNOWN_FLAG_NAMES = new Set([...FLAG_DEFS.map(f => f.name), ...FLAG_ALIASES.keys()]);

function schemaObject() {
  return {
    exitCodes: EXIT_CODES,
    flags: FLAG_DEFS.map(f => ({ flag: `--${f.name}`, alias: f.alias ? `--${f.alias}` : undefined, type: f.type, default: f.default, description: f.desc })),
    subcommands: [
      { name: '--agents', tier: 'quick-start', usage: 'gmsniff --agents [-f] [--agent <cwd|name>] [--idle] [--interval N] [--output-lines N]', desc: 'live manager view: per gm agent phase, served instruction, elapsed-in-phase, PRD/mutable pending, recent output; -f refreshes in place' },
      { name: 'gui', tier: 'daily', usage: 'gmsniff gui [--port N] [--open]', desc: 'launch the browser GUI server' },
      { name: '--prd-edit', tier: 'agent', usage: 'gmsniff --prd-edit <cwd> <id> [--status <s>] [--text <t>]', desc: 'rewrite a PRD row\'s status/text in <cwd>/.gm/prd.yml, atomic write' },
      { name: '--mutable-edit', tier: 'agent', usage: 'gmsniff --mutable-edit <cwd> <id> [--status <s>] [--witness <w>]', desc: 'rewrite a mutable row\'s status/witness in <cwd>/.gm/mutables.yml, atomic write' },
      { name: '--dispatch', tier: 'agent', usage: 'gmsniff --dispatch <cwd> <verb> [--json <payload>]', desc: 'write payload (default {}) to <cwd>/.gm/exec-spool/in/<verb>/<ts>.txt' },
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
    const raw = a.slice(2);
    const key = FLAG_ALIASES.get(raw) || raw;
    if (!KNOWN_FLAG_NAMES.has(raw)) {
      process.stderr.write(`unknown flag: --${raw}\nrun 'gmsniff --help' for the flag list, or 'gmsniff --schema' for machine-readable flag descriptions\n`);
      process.exit(2);
    }
    if (FLAGS.bool.includes(key)) { opts[key] = true; continue; }
    const val = argv[++i];
    if (FLAGS.multi.includes(key)) { opts._multi[key].push(val); continue; }
    if (FLAGS.number.includes(key)) {
      const n = parseInt(val, 10);
      if (val === undefined || Number.isNaN(n)) {
        process.stderr.write(`--${raw} requires an integer value, got: ${val === undefined ? '(missing)' : JSON.stringify(val)}\n`);
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

QUICK START (daily)
  gmsniff --agents -f                   LIVE MANAGER VIEW: every running gm agent's phase,
                                        served instruction, elapsed-in-phase, PRD/mutable
                                        pending counts, and streaming recent output
  gmsniff --agents --agent <name>       full instruction text + longer output feed for one project
  gmsniff gui --open                    browser dashboard: project health, phases, deviations at a glance
  gmsniff -f                            live tail, fanned out across every discovered project
  gmsniff --list-deviations             what went wrong recently, grouped by kind
  gmsniff --watchers                    which daemons are alive + the running runtime version

DAILY
  gmsniff --agents                      one-shot manager snapshot (no refresh)
  gmsniff --agents --idle               include idle/COMPLETE agents (default: working phases only)
  gmsniff --agents -f --interval 5000   refresh every 5s instead of the 2s default
  gmsniff [filters] [output]            dump matching events (requires >=1 flag)
  gmsniff -f [filters]                  live tail, fanned out across every discovered project
  gmsniff --list-sessions [filters]     per-session summary with phase walk
  gmsniff --list-deviations             recent deviations grouped by kind, with own/foreign split,
                                        severity, recovery verb, and per-hour rate
  gmsniff --list-deviations --own-only  only deviations from THIS project's cwd (real defects to correct)
  gmsniff --list-deviations --foreign-only  only deviations from other projects (gate-positives elsewhere)
                                        own/foreign is decided by cwd -- live events carry no
                                        session id. Override with GMSNIFF_OWN_CWD=<path>.
  gmsniff --stats [filters]             breakdown by sub / event / sess / day
  gmsniff --tree <sess>                 chronological process tree for one session
  gmsniff --tree <sess> [--all-dispatch] drops dispatch.start unless --all-dispatch
  gmsniff gui [--port N] [--open]       launch browser GUI

INVESTIGATION
  gmsniff --list-events [--sub <s>]     event-type histogram
  gmsniff --efficiency <sess>           turn count, dispatch ratio, time-to-COMPLETE
  gmsniff --rollup <out.ndjson>         dump filtered events to file
  gmsniff --updates                     runtime version + real drift (stale markers suppressed)
  gmsniff --watchers                    one-line liveness per project cwd + machine-global runtime version
  gmsniff --conformance                 paper §14 metrics: ε (unresolved mutables) + PRD-pending per project
  gmsniff --projects                    alias for --conformance: alive/dead, version, PRD-pending, mutable-unknown per discovered project

DIAGNOSTICS (rare: memory/learning forensics)
  gmsniff --embed-failures [--stats]    embed_fail/embed_query_failed/memorize_embed_failed events
                                        (structured + .watcher.log text fallback)
  gmsniff --recall-misses [--top N]     recall events with hit=false grouped by query
  gmsniff --recall-scores [--bucket B]  histogram of top-hit recall scores (B default 0.1)
  gmsniff --classifier-rejects [--top N] memorize_reject grouped by reason
  gmsniff --memory-leverage [--days N]  recall hit-rate + memorize reject/dedup/embed-fail per project
  gmsniff --recall-modes [--stats]      distribution of recall.mode (vector_top_k|fallback_like|kv_query)
  gmsniff --table-drops                 catastrophic table_dropped events with dim deltas
  gmsniff --discipline-sigil-ignored    discipline_sigil_ignored events (doc-vs-code drift)

AGENT-FACING (machine callers and gm state edits)
  gmsniff --schema                      machine-readable JSON: every flag, type, default, exit codes,
                                        output-mode contract -- for agentic/programmatic callers
  gmsniff --prd-edit <cwd> <id> [--status <s>] [--text <t>]      rewrite a PRD row's status/text in <cwd>/.gm/prd.yml, atomic write
  gmsniff --mutable-edit <cwd> <id> [--status <s>] [--witness <w>]  rewrite a mutable row's status/witness in <cwd>/.gm/mutables.yml, atomic write
  gmsniff --dispatch <cwd> <verb> [--json <payload>]  write payload (default {}) to <cwd>/.gm/exec-spool/in/<verb>/<ts>.txt

EXIT CODES
  0                      success (includes zero-match/empty-result queries -- absence of
                         data is not a failure)
  2                      usage error: bad/missing argument, unresolvable session id, or a
                         numeric flag value that failed to parse as an integer
  (other)                uncaught exception (Node default); never silently mapped to 0

SOURCES
  primary                per-project <project>/.gm/exec-spool/.watcher.log -- "evt: {json}"
                         lines, the live stream every current-generation agentplug daemon
                         writes. Discovery seeds from ~/.agentplug/daemon-registry.txt (the
                         daemon's own authoritative served-cwd list, worktrees included) plus
                         a scan of GM_SPOOL_DIRS, DEV_ROOT, GM_DEV_ROOT, cwd, C:/dev or ~/dev.
  archive (opt-in)       ~/.claude/gm-log day/subsystem jsonl files -- 1,131,698 events across
                         72 day-dirs, deliberately NOT merged into the default replay: it would
                         swamp live spool data with history. Reachable only by setting GM_LOG_DIR
                         explicitly. The daemon no longer writes here, so a query restricted to
                         it can read empty even while agents are actively running.
  live state             --agents reads neither: it reads .gm/turn-state.json, .gm/next-step.md,
                         .gm/exec-spool/.turn-summary.json, .gm/last-prompt.txt and
                         .gm/exec-spool/.last-gate-fired.json directly, per project.
  runtime version        ~/.gm-tools/{plugkit,gm-plugkit}.version + .update-check-cache.json --
                         machine-global under the shared daemon; .status.json no longer carries
                         a per-project version/wrapper_sha at all.
  --spool <path>         force one project dir (or .watcher.log path) as the source
  -f / --tail            live: both sources run concurrently -- the central log watcher plus
                         a per-project .watcher.log tailer for every discovered project,
                         merged into one stream with cwd attribution preserved; rediscovers
                         new/removed projects every GM_FANOUT_REDISCOVER_MS (default 30000)
                         without restart. --spool with -f pins the fanout to one project.
                         With --agents, -f instead repaints the manager board every --interval ms.

LIVE MANAGER (--agents)
  --agents               per-agent phase, instruction heading, elapsed-in-phase, PRD/mutable
                         pending, and recent output. Alias: --live
  -f                     repaint in place instead of printing one snapshot
  --interval <ms>        repaint period (default 2000, min 250)
  --agent <cwd|name>     drill into one project: full served instruction + longer output feed
  --output-lines <N>     recent output lines per project (default 6; drilldown uses 4x)
  --idle                 include idle/COMPLETE agents (default: working phases only)

TIME
  --since <t>            ISO date, epoch ms, or relative Ns/Nm/Nh/Nd/Nw
  --until <t>            (alias: --after, --before)

FILTERS (repeat = OR within a flag, AND across flags)
  --grep <re>            text regex; repeat = AND
  --igrep <re>           exclude if regex matches
  --invert               invert the filter result
  --sub <name>           subsystem (plugkit, hook, bootstrap, memory, ...)
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
  gmsniff --agents -f
  gmsniff --agents --agent spoint
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
  plugkit: 31, hook: 35, memory: 32, bootstrap: 36,
};
function color(s, code) {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

// Every escape emitted here is self-terminated, so a payload truncated mid-string cannot leak an
// unclosed color state into the terminal. Control bytes in event data are escaped on BOTH the
// color and no-color paths, or hostile log content injects terminal sequences.
const JSON_TOKEN_COLORS = { key: 36, string: 32, number: 33, bool: 35, nullish: 90 };
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
      paint(text[j] === ':' ? 'key' : 'string', text.slice(start, i));
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const start = i;
      i++;
      while (i < text.length && JSON_NUM_CHARS.includes(text[i])) i++;
      flush();
      paint('number', text.slice(start, i));
      continue;
    }
    if (text.startsWith('true', i)) { flush(); paint('bool', 'true'); i += 4; continue; }
    if (text.startsWith('false', i)) { flush(); paint('bool', 'false'); i += 5; continue; }
    if (text.startsWith('null', i)) { flush(); paint('nullish', 'null'); i += 4; continue; }
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
  // Envelope fields are interpolated raw into the terminal line, so a crafted ESC sequence in
  // ts/sub/event/sess would inject terminal control around the color() calls.
  const t = escapeControlChars(e.ts ? e.ts.slice(0, 19).replace('T', ' ') : '?'.padEnd(19));
  const sub = escapeControlChars((e._sub || '?').padEnd(16).slice(0, 16));
  const ev = escapeControlChars((e.event || '?').padEnd(28).slice(0, 28));
  const subC = SUB_COLORS[e._sub] || 0;
  const realSess = e.sess && e.sess !== '(no-session)' ? e.sess : '';
  const cwdTag = !realSess && e.cwd ? '~' + e.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop().slice(0, 7) : '';
  const sessShort = escapeControlChars((realSess ? realSess.slice(0, 8) : (cwdTag || '--------')).padEnd(8).slice(0, 8));
  const payload = { ...e };
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
    if (!st) continue;
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
    const verLabel = r.version ? `v${r.version}` : (r.runtime === 'agentplug' ? 'agentplug' : '?');
    process.stdout.write(`${state}  ${verLabel.padEnd(9)} ${eps} ${prd}  ${proj}\n`);
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

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

// -> { header (everything before the first row), rows: [{id, raw}] }, so one row can be rewritten
// in place without a YAML parser dependency.
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

function setYamlField(raw, field, value) {
  const existingFieldLine = new RegExp(`^(  ${field}:).*$`, 'm');
  const line = `  ${field}: ${yamlScalar(value)}`;
  if (existingFieldLine.test(raw)) return raw.replace(existingFieldLine, line);
  const rowIdLine = /^(- id:.*\r?\n)/;
  return raw.replace(rowIdLine, `$1${line}\n`);
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
    const text = fs.readFileSync(filePath, 'utf-8');
    const { rows } = splitYamlRows(text);
    const row = rows.find(r => r.id === id);
    // Reusing whichever free-text field the row already has keeps a legacy body-only row edited
    // in place instead of gaining a spurious second field. `text` is the current convention and
    // `body` the superseded one, hence the ordering.
    const existingFreeTextField = row && /^  text:/m.test(row.raw) ? 'text'
      : row && /^  note:/m.test(row.raw) ? 'note'
      : row && /^  subject:/m.test(row.raw) ? 'subject'
      : row && /^  body:/m.test(row.raw) ? 'body'
      : 'subject';
    fields[existingFreeTextField] = opts.text;
  }
  const raw = editYamlRow(filePath, id, fields);
  process.stdout.write(`# updated ${filePath} id=${id}\n${raw}`);
}

function mutableEdit(cwd, id, opts) {
  const filePath = path.join(cwd, '.gm', 'mutables.yml');
  const raw = editYamlRow(filePath, id, { status: opts.status, witness: opts.witness });
  process.stdout.write(`# updated ${filePath} id=${id}\n${raw}`);
}

// A shape-only check was tried and rejected: it let a typo'd verb write a spool file the daemon
// could only ever answer with "unknown verb". The CLI and the HTTP /api/lifecycle route now
// refuse identically, both against registry.js's VERB_ALLOWLIST.
function dispatchVerb(cwd, verb, jsonPayload) {
  if (!isUsableVerb(verb)) {
    const shapeOk = /^[a-zA-Z0-9_-]+$/.test(verb);
    process.stderr.write(!shapeOk
      ? `--dispatch: verb must be alphanumeric, dash, or underscore only, got: ${verb}\n`
      : isRetiredVerb(verb)
        ? `--dispatch: retired verb: ${verb} -- recognized by the daemon but its handler always errors\n`
        : `--dispatch: unknown verb: ${verb}\nknown verbs: ${[...VERB_ALLOWLIST].filter(v => !isRetiredVerb(v)).sort().join(' ')}\n`);
    process.exit(2);
  }
  let payload = '{}';
  if (jsonPayload) {
    JSON.parse(jsonPayload);
    payload = jsonPayload;
  }
  const dir = path.join(cwd, '.gm', 'exec-spool', 'in', verb);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.txt`);
  fs.writeFileSync(file, payload, 'utf-8');
  process.stdout.write(`# dispatched verb=${verb} -> ${file}\n${colorJson(payload)}\n`);
}

const LIST_SESSIONS_MIN_EVENTS = 5;

function listSessions(all, opts = {}) {
  const m = new Map();
  // correlationKey preserves the 3,134 real sess-carrying events in the corpus where they exist
  // and degrades to the daemon-run boundary where they do not, rather than collapsing everything
  // into one '(no-session)' bucket.
  for (const e of all) {
    const k = correlationKey(e);
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
  const allRows = [...m.values()].sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  // The daemon respawns constantly, so cwd#run fragments into 14,475 singleton groups of 18,467
  // total (measured), burying the real chains.
  const rows = opts.all ? allRows : allRows.filter(s => s.events >= LIST_SESSIONS_MIN_EVENTS);
  const hiddenTrivial = allRows.length - rows.length;
  for (const s of rows) {
    const walk = PHASES.map(p => s.phases.has(p) ? color('#', 32) : color('.', 90)).join('');
    const dev = s.deviations ? color(String(s.deviations).padStart(3), 31) : '   ';
    const sessShort = truncateSessionKeyKeepingItsDistinguishingTail(s.sess).padEnd(SESSION_KEY_COLUMN_WIDTH);
    const cwdsArr = [...s.cwds];
    const proj = cwdsArr.map(c => path.basename(c)).join(',').slice(0, 18).padEnd(18);
    let watcher = '             ';
    if (cwdsArr.length === 1) {
      const st = readWatcherStatus(cwdsArr[0]);
      if (st) {
        const verLabel = st.version ? `v${st.version}` : (st.runtime === 'agentplug' ? 'agentplug' : 'v?');
        const tag = st.alive ? color(`${verLabel} ALIVE`, 32) : color(`${verLabel} dead `, 31);
        watcher = ` ${tag}`;
      }
    }
    process.stdout.write(`${(s.last || '').slice(0, 19)}  ${walk}  ev:${String(s.events).padStart(5)}  disp:${String(s.dispatches).padStart(4)}  prd:${s.prd_add}/${s.prd_res}  mut:${s.mut_res}  dev:${dev}  ${proj}  ${sessShort} ${watcher}\n`);
  }
  const cov = correlationCoverage(all);
  process.stderr.write(`# ${rows.length} groups shown of ${allRows.length} - phase walk: P E E V C - watcher: ALIVE/dead per project cwd\n`);
  if (hiddenTrivial) process.stderr.write(`# ${hiddenTrivial} trivial group(s) hidden (<${LIST_SESSIONS_MIN_EVENTS} events): the daemon respawns constantly, so cwd#run fragments into thousands of 1-event groups. Pass --all to show them.\n`);
  process.stderr.write(cov.has_true_session
    ? `# correlation: ${cov.counts.sess} sess real agent sessions; ${cov.counts.run} grouped by daemon run, ${cov.counts.cwd} by cwd only\n`
    : `# correlation: NO real agent-session ids in this data -- rows are grouped by daemon run (${cov.counts.run}) / cwd (${cov.counts.cwd}), not by agent session\n`);
}

// `legacy: true` marks a kind no current ../gm source path still emits -- it survives only in
// replayed history, and a reader seeing one must not chase a live regression that no longer
// exists.
//
// Derived from the real emitters in ../gm (verify by path -- codesearch does not index it):
//   rs-plugkit/crates/plugkit-core/src/gates.rs         log_deviation(): await-result-violation,
//     bash-git-bypass, long-gap-retry-without-instruction, long-gap-no-instruction, gate-deny,
//     stuck-loop-escalation, unsolicited-doc-created, prd-anti-shape
//   .../src/wasm_dispatch/verbs.rs  deviation_push(): push-non-main-branch, push-dirty,
//     push-rebase-conflict, push-remote-outpaces
//   .../src/orchestrator/prd.rs                       : prd-add-no-id
//   .../src/orchestrator/instructions/mod.rs  idev()  : complete-chain-poll
//   .../src/lib.rs   signal_platform_search_drift()   : platform-search-drift
//   .../src/poll_detect.rs                            : spool-poll
//   .../src/orchestrator/fsm.rs                       : client-edit-no-witness
// NOTE the prd.rs/residual.rs `deviation_kind` JSON fields (prd-resolve-no-witness,
// prd-resolve-duplicate-witness, prd-resolve-unknown-id, residual-premature,
// residual-dirty-tree) are refusal-BODY payload fields, not `deviation.*` event names -- they
// never appear as an event and so must not be keyed here.
const DEVIATION_META = {
  'deviation.long-gap-no-instruction': { sev: 'warn', recover: 'instruction (chain idle past long_gap_threshold_ms with no re-served prose)' },
  'deviation.long-gap-retry-without-instruction': { sev: 'warn', recover: 'instruction (stop bare-retrying the same verb across the gap)' },
  'deviation.gate-deny': { sev: 'info', recover: '(residuals named in the denial reason -- clear each, then re-transition)' },
  'deviation.stuck-loop-escalation': { sev: 'critical', recover: 'prd-add (name the stuck state) then wfgy-method, never bare-retry the same transition' },
  'deviation.await-result-violation': { sev: 'critical', recover: 'memorize-continue (pipeline suspended, only this verb advances state)' },
  'deviation.bash-git-bypass': { sev: 'warn', recover: 'git_* verbs (raw git in a bash body carries no separable witness)' },
  'deviation.unsolicited-doc-created': { sev: 'warn', recover: '(fs_write to an unlisted top-level doc path -- confirm intentional)' },
  'deviation.prd-anti-shape': { sev: 'warn', recover: 'prd-resolve with witness_evidence (row closed without evidence)' },
  'deviation.prd-add-no-id': { sev: 'warn', recover: 'prd-add (pass id, or a slugifiable subject/title/description)' },
  'deviation.platform-search-drift': { sev: 'warn', recover: 'codesearch|recall (not raw Grep/Glob mid-chain)' },
  'deviation.spool-poll': { sev: 'warn', recover: 'instruction (spool polling detected -- use plugkit verbs, never sleep+cat loops)' },
  'deviation.complete-chain-poll': { sev: 'info', recover: 'stop (chain terminal -- a new user prompt reopens it)' },
  'deviation.client-edit-no-witness': { sev: 'warn', recover: 'browser (page.evaluate the invariant each client-side edit establishes)' },
  'deviation.push-dirty': { sev: 'critical', recover: 'git_status + git_commit before git_push' },
  'deviation.push-non-main-branch': { sev: 'warn', recover: 'git_branch (consolidate to main per CLAUDE.md invariant)' },
  'deviation.push-rebase-conflict': { sev: 'critical', recover: 'resolving-merge-conflicts then git_push' },
  'deviation.push-remote-outpaces': { sev: 'warn', recover: 'git_fetch + re-resolve before git_push' },
  // Superseded by the unified consolidate/complete gate: current gm reports these residuals via
  // deviation.gate-deny ("consolidate-gate residuals=N" / "stop-gate residuals=N") instead of a
  // dedicated event per missing gate. Still present in replayed history.
  'deviation.consolidate-without-residual-scan': { sev: 'warn', legacy: true, recover: 'residual-scan before CONSOLIDATE (now surfaced as gate-deny)' },
  'deviation.complete-without-residual-scan': { sev: 'warn', legacy: true, recover: 'residual-scan before COMPLETE (now surfaced as gate-deny)' },
  'deviation.complete-without-ci-validation': { sev: 'warn', legacy: true, recover: 'CI validation before COMPLETE (now surfaced as gate-deny)' },
};
const SEV_COLOR = { critical: 31, warn: 33, info: 36 };

// A session-prefix-only test was tried and rejected: most live evt lines carry no `sess` field,
// so it classified every deviation as foreign and --own-only always printed nothing. `sess` is
// not universally absent either -- 3,134 events in the real corpus carry it (measured via
// correlationCoverage over a full replay) -- so it is honoured first, then cwd.
const OWN_CWD = canonPath(process.env.GMSNIFF_OWN_CWD || process.cwd());
function canonPath(p) {
  if (!p) return null;
  try { return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); } catch (_) { return null; }
}
function devOrigin(e) {
  const own = process.env.GMSNIFF_OWN_SESSION;
  if (own) {
    const c = correlationOf(e);
    if (c.kind === 'sess' && String(c.key).startsWith(own)) return 'own';
  }
  if (OWN_CWD && e.cwd && canonPath(e.cwd) === OWN_CWD) return 'own';
  return 'foreign';
}
function devMeta(ev) { return DEVIATION_META[ev] || { sev: 'warn', recover: '(unmapped -- re-derive DEVIATION_META from ../gm source)', unknown: true }; }

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
  process.stdout.write(`# own = cwd ${OWN_CWD || '(unresolved)'}  (override with GMSNIFF_OWN_CWD)\n`);
  process.stdout.write(`# by severity: ${['critical', 'warn', 'info'].map(s => `${color(s, SEV_COLOR[s])}:${bySev.get(s) || 0}`).join('  ')}\n`);
  let unknownKinds = 0;
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    const m = devMeta(k);
    if (m.unknown) unknownKinds++;
    const tag = m.legacy ? color(' [legacy]', 90) : (m.unknown ? color(' [unmapped]', 90) : '');
    process.stdout.write(`  ${String(n).padStart(5)}  ${color(k, SEV_COLOR[m.sev] || 31)}  ${color(`[${m.sev}]`, SEV_COLOR[m.sev])}${tag}  recover:${m.recover}\n`);
  }
  if (unknownKinds) process.stderr.write(`# ${unknownKinds} kind(s) unmapped -- DEVIATION_META has drifted behind ../gm's real emitters; re-derive from ../gm source\n`);
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
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    ranked.slice(0, top).forEach(([k, v]) => process.stdout.write(`  ${String(v).padStart(7)}  ${k}\n`));
    writeOmittedRowsNote(ranked.length - Math.min(top, ranked.length), top, 'group', 'groups');
  };
  process.stdout.write(`# total: ${rows.length}\n`);
  dump('by sub', bySub);
  dump('by event', byEv, 20);
  // The label said "top 15" while the cap was a parameter, so a changed cap
  // would have left the heading asserting a number the code no longer used.
  dump('by sess', bySess);
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
    const live = readProjectLiveness(cwd);
    if (!includeDead && !live.active) continue;
    rows.push({ cwd, update: readUpdateAvailable(cwd), live, ...status });
  }
  rows.sort((a, b) => {
    if (a.live.active !== b.live.active) return a.live.active ? -1 : 1;
    return (a.live.last_activity_age_ms ?? Infinity) - (b.live.last_activity_age_ms ?? Infinity);
  });
  const aliveCount = rows.filter(r => r.live.active).length;
  const deadShown = rows.length - aliveCount;
  const gt = readGmToolsVersions();
  const runningVersion = gt.plugkit;
  const daemonUpPerAnyRespondingProjectPid = (() => {
    for (const r of rows) {
      if (!r.pid) continue;
      try { process.kill(r.pid, 0); return true; } catch (_) {}
    }
    return false;
  })();
  const globalDrift = versionIsNewer(gt.latest, runningVersion);
  const driftedRows = rows.filter(r => r.update && versionIsNewer(r.update.latest, runningVersion));
  process.stdout.write(`# ${rows.length} watchers ${includeDead ? '(active + idle)' : '(ACTIVE only -- pass --all for idle)'}\n`);
  process.stdout.write(`# runtime: plugkit v${runningVersion || '?'}  gm-plugkit v${gt.gm_plugkit || '?'}  registry-latest v${gt.latest || '?'}${gt.checked_at_ms ? ` (checked ${fmtAge(Date.now() - gt.checked_at_ms)} ago)` : ''}${globalDrift ? color('  DRIFTED', 33) : ''}\n`);
  process.stdout.write(`STATE   SERVED     PID    LAST-ACT  QUEUE  PROJECT               NOTE\n`);
  for (const r of rows) {
    const live = r.live;
    const state = live.active ? color('ACTIVE', 32) : color('idle  ', 90);
    const age = live.last_activity_age_ms !== null ? fmtAge(live.last_activity_age_ms) : '?';
    const proj = path.basename(r.cwd);
    let note = '';
    if (r.update && versionIsNewer(r.update.latest, runningVersion)) {
      note = color(`-> v${r.update.latest}`, 33);
    } else if (!daemonUpPerAnyRespondingProjectPid) {
      note = color('daemon down', 31);
    }
    const served = readServedVersion(r.cwd);
    const verLabel = served ? `v${served}` : '?';
    const q = live.queue_depth ? color(String(live.queue_depth).padStart(5), 33) : '    0';
    process.stdout.write(`${state}  ${verLabel.padEnd(9)} ${String(r.pid).padStart(6)} ${age.padEnd(9)} ${q}  ${proj.padEnd(20)}  ${note}\n`);
  }
  process.stderr.write(`# ${aliveCount} active${includeDead ? ` - ${deadShown} idle shown` : ''}${globalDrift ? ` - runtime drifted (v${runningVersion} -> v${gt.latest}): bun x gm-plugkit@latest` : ''}${driftedRows.length ? ` - ${driftedRows.length} project marker(s) newer than runtime` : ''}\n`);
}

// The agentplug shared daemon dropped version/wrapper_sha/idle_limit_ms from .status.json
// entirely, so readWatcherStatus's `version` is null on every current-generation project and
// comparing an .update-available.json `latest` against that null reported EVERY marked project
// as drifted. The real running-version signal is machine-wide, here.
function readGmToolsVersions() {
  const installed = readInstalledVersions();
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(path.join(GM_TOOLS_DIR, '.update-check-cache.json'), 'utf-8')); } catch (_) {}
  return {
    plugkit: installed.plugkit,
    gm_plugkit: installed.gm_plugkit,
    latest: cache && cache.latest ? String(cache.latest) : null,
    checked_at_ms: cache && Number.isFinite(cache.ts) ? cache.ts : null,
  };
}

// The watcher.log banner (3,917 real occurrences) is the only place the per-project served
// version still appears, now that .status.json has dropped `version`. It is written only at
// daemon-boot, so on a busy project it sits far back in the file and a small tail window
// silently reports "no version" -- hence the backwards chunked scan. The byte cap exists because
// --watchers calls this once per discovered project (54 real, some multi-MB) and an unbounded
// full read there was slow enough to look like a hang.
const SERVED_VERSION_MAX_BYTES = 4 * 1024 * 1024;
const SERVED_VERSION_RE = /plugkit\s+v(\d+\.\d+\.\d+)\s*\(wasm\)/g;
const _servedVersionCache = new Map();
function readServedVersion(cwd) {
  const fp = path.join(cwd, '.gm', 'exec-spool', '.watcher.log');
  let stat;
  try { stat = fs.statSync(fp); } catch (_) { return null; }
  const hit = _servedVersionCache.get(cwd);
  if (hit && hit.mtime === stat.mtimeMs) return hit.version;

  let version = null;
  let fd = null;
  try {
    fd = fs.openSync(fp, 'r');
    const chunk = 512 * 1024;
    const limit = Math.min(stat.size, SERVED_VERSION_MAX_BYTES);
    for (let read = 0; read < limit && version === null; read += chunk) {
      const want = Math.min(chunk, limit - read);
      const pos = stat.size - read - want;
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, pos);
      const text = buf.toString('utf8');
      SERVED_VERSION_RE.lastIndex = 0;
      let m;
      while ((m = SERVED_VERSION_RE.exec(text)) !== null) version = m[1];
    }
  } catch (_) {}
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
  _servedVersionCache.set(cwd, { mtime: stat.mtimeMs, version });
  return version;
}

// An absent side is never "drifted": an unknown running version is exactly the state the old
// code silently read as "behind".
function versionIsNewer(latest, running) {
  if (!latest || !running) return false;
  const a = String(latest).split('.').map(n => parseInt(n, 10));
  const b = String(running).split('.').map(n => parseInt(n, 10));
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return latest !== running;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
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

// Keyed on correlationKey rather than raw `sess` so it still resolves on the majority of
// projects, whose events carry no session id -- there it returns the cwd#run daemon-run key,
// which --tree/--efficiency filter on identically.
function resolveCurrentSession(all) {
  const target = canonPath(process.cwd());
  let best = null;
  for (const e of all) {
    if (canonPath(e.cwd) !== target) continue;
    if (!best || (e.ts || '') > (best.ts || '')) best = { ts: e.ts, key: correlationKey(e) };
  }
  return best ? best.key : null;
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
  // Matching on the raw `sess` field was tried and rejected: --tree then only ever worked for
  // the 1.5% of events carrying one. The correlation key resolves a raw agent sess id, a cwd#run
  // daemon-run key and a bare cwd alike.
  const evs = all.filter(e => { if (wantEmpty) return !e.sess; const k = correlationKey(e); return k === sess || k.startsWith(sess); }).sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
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
  const evs = all.filter(e => { if (wantEmpty) return !e.sess; const k = correlationKey(e); return k === sess || k.startsWith(sess); }).sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
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
  const rankedVerbs = [...verbs.entries()].sort((a, b) => b[1] - a[1]);
  for (const [v, n] of rankedVerbs.slice(0, VERBS_BY_FREQUENCY_SHOWN)) {
    process.stdout.write(`  ${String(n).padStart(4)}  ${v}\n`);
  }
  writeOmittedRowsNote(rankedVerbs.length - Math.min(VERBS_BY_FREQUENCY_SHOWN, rankedVerbs.length), VERBS_BY_FREQUENCY_SHOWN, 'verb', 'verbs');
}

function readDaemonRegistry() {
  try {
    return fs.readFileSync(path.join(AGENTPLUG_DIR, 'daemon-registry.txt'), 'utf-8')
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}

function discoverProjectCwds() {
  const out = [];
  const seen = new Set();
  const add = (p) => { const k = canonPath(p); if (!k || seen.has(k)) return; seen.add(k); out.push(p); };
  for (const cwd of readDaemonRegistry()) add(cwd);
  const roots = [];
  for (const env of ['DEV_ROOT', 'GM_DEV_ROOT']) if (process.env[env]) roots.push(process.env[env]);
  roots.push(process.cwd());
  roots.push(process.platform === 'win32' ? 'C:/dev' : path.join(os.homedir(), 'dev'));
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const proj = path.join(root, d.name);
        if (fs.existsSync(path.join(proj, '.gm', 'exec-spool'))) add(proj);
      }
    } catch (_) {}
  }
  return out.filter(p => { try { return fs.existsSync(path.join(p, '.gm')); } catch (_) { return false; } });
}

function findUpdateMarkers() {
  const markers = [];
  for (const proj of discoverProjectCwds()) {
    const marker = path.join(proj, '.gm', 'exec-spool', '.update-available.json');
    try {
      if (!fs.existsSync(marker)) continue;
      const content = JSON.parse(fs.readFileSync(marker, 'utf8'));
      markers.push({ project: path.basename(proj), path: proj, ...content, running: readGmToolsVersions().plugkit });
    } catch (_) {}
  }
  return markers;
}

function updates(all, opts) {
  const gt = readGmToolsVersions();
  const allMarkers = findUpdateMarkers();
  // The shared daemon updates machine-wide and never rewrites each project's marker, so a marker
  // no newer than the running runtime is a stale leftover, not drift.
  const markers = allMarkers.filter(m => versionIsNewer(m.latest, gt.plugkit));
  if (opts.json) {
    process.stdout.write(JSON.stringify({ runtime: gt, live: markers, stale_markers: allMarkers.length - markers.length, history: all.filter(e => typeof e.event === 'string' && e.event.startsWith('update.')) }, null, 2) + '\n');
    return;
  }
  process.stdout.write(`# runtime: plugkit v${gt.plugkit || '?'}  gm-plugkit v${gt.gm_plugkit || '?'}  registry-latest v${gt.latest || '?'}${gt.checked_at_ms ? ` (checked ${fmtAge(Date.now() - gt.checked_at_ms)} ago)` : ''}\n`);
  if (versionIsNewer(gt.latest, gt.plugkit)) {
    process.stdout.write(`  ${color('!', 31)} runtime drifted: v${gt.plugkit} -> ${color('v' + gt.latest, 33)}\n`);
  }
  process.stdout.write('# live drift state:\n');
  if (!markers.length) {
    const stale = allMarkers.length - markers.length;
    process.stdout.write(`  (none — every project is current${stale ? `; ${stale} stale marker(s) already superseded by the running runtime` : ''})\n`);
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

// Filtering on _sub==='rs_learn' was tried and rejected: that crate is retired, and current
// embed_fail/embed_query_failed/memorize_embed_failed events either carry no sub tag (defaulting
// to 'plugkit') or are tagged 'memory' by recall.rs, so it matched nothing on a real log. A
// free-text `embed::embed_text step '<x>' failed` scraper was also removed -- that pattern has
// zero occurrences across every registered project's watcher.log (verified by direct scan).
function embedFailures(all, opts) {
  const evs = all.filter(e => e.event === 'embed_fail' || e.event === 'embed_query_failed' || e.event === 'memorize_embed_failed');
  if (opts.stats) {
    const byStep = new Map(), byDay = new Map(), byProj = new Map();
    for (const e of evs) {
      const step = e.step || '?';
      byStep.set(step, (byStep.get(step) || 0) + 1);
      if (e._day) byDay.set(e._day, (byDay.get(e._day) || 0) + 1);
      const proj = e.cwd ? path.basename(e.cwd) : '?';
      byProj.set(proj, (byProj.get(proj) || 0) + 1);
    }
    process.stdout.write(`# embed failures: ${evs.length} (structured events)\n`);
    const dump = (label, m) => {
      process.stdout.write(`\n# ${label}\n`);
      const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
      ranked.slice(0, EMBED_FAILURE_ROWS_SHOWN).forEach(([k, v]) => process.stdout.write(`  ${String(v).padStart(6)}  ${k}\n`));
      writeOmittedRowsNote(ranked.length - Math.min(EMBED_FAILURE_ROWS_SHOWN, ranked.length), EMBED_FAILURE_ROWS_SHOWN, 'row', 'rows');
    };
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
  process.stdout.write(`# embed failures: ${evs.length} (structured events)\n`);
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
  const rankedQueries = [...byQuery.values()].sort((a, b) => b.count - a.count);
  for (const s of rankedQueries.slice(0, top)) {
    process.stdout.write(`${String(s.count).padStart(5)}   ${(s.last_ts||'').slice(0,19).padEnd(19)}  ${s.query}\n`);
  }
  writeOmittedRowsNote(rankedQueries.length - Math.min(top, rankedQueries.length), top, 'query', 'queries');
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
  const rankedReasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of rankedReasons.slice(0, top)) {
    process.stdout.write(`  ${String(v).padStart(6)}  ${k}\n`);
  }
  writeOmittedRowsNote(rankedReasons.length - Math.min(top, rankedReasons.length), top, 'reason', 'reasons');
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
  // Verified against the real emitters in ../gm:
  //   * There is NO memorize-success event. `memorized` in code_index.rs is a RESPONSE field,
  //     not an event name, and the old memorize_fired/memorize.fired filter matched 0 events in
  //     every sampled project's real log. The observable surface is the failure/no-op side.
  //   * recall's real payload (orchestrator/recall.rs emit_recall) is
  //     {sub, query, hit, mode, n_hits, namespace, top_score} -- no hits[] array and no key, so
  //     a memorized-key <-> recalled-key join was structurally impossible and only ever printed
  //     0. Hit-rate is the leverage signal this data can actually support.
  const byKey = new Map();
  const keyOf = (e) => correlationKey(e);
  const bump = (e, field) => {
    const k = keyOf(e);
    let s = byKey.get(k);
    if (!s) { s = { key: k, recalls: 0, hits: 0, rejects: 0, deduped: 0, embed_failed: 0 }; byKey.set(k, s); }
    s[field]++;
    return s;
  };
  for (const e of evs) {
    if (e.event === 'recall') { const s = bump(e, 'recalls'); if (e.hit === true || (Number.isFinite(e.n_hits) && e.n_hits > 0)) s.hits++; }
    else if (e.event === 'memorize_reject') bump(e, 'rejects');
    else if (e.event === 'memorize_deduped') bump(e, 'deduped');
    else if (e.event === 'memorize_embed_failed') bump(e, 'embed_failed');
  }
  const rows = [...byKey.values()].filter(s => s.recalls || s.rejects || s.deduped || s.embed_failed);
  process.stdout.write(`# memory leverage (last ${days}d${opts.sess ? `, sess=${opts.sess}` : ''})\n`);
  if (!rows.length) {
    process.stdout.write('# no recall/memorize events in window\n');
    return;
  }
  process.stdout.write(`# recall hit-rate + memorize no-op rate. Current gm emits no memorize-success\n`);
  process.stdout.write(`# event and no per-hit keys, so a memorized-key -> recalled-key join is not derivable.\n`);
  process.stdout.write(`PROJECT/SESS              RECALLS   HITS  HIT%   REJECT  DEDUP  EMBED_FAIL\n`);
  for (const s of rows.sort((a, b) => b.recalls - a.recalls)) {
    const pct = s.recalls ? ((s.hits / s.recalls) * 100).toFixed(1) : '-';
    process.stdout.write(`${s.key.slice(0, 24).padEnd(24)}  ${String(s.recalls).padStart(7)}  ${String(s.hits).padStart(5)}  ${pct.padStart(5)}  ${String(s.rejects).padStart(6)}  ${String(s.deduped).padStart(5)}  ${String(s.embed_failed).padStart(10)}\n`);
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

// Live manager view (--agents): CLI parity with the GUI's Skill Layout panel. Reads the real
// files the daemon writes, never replayed gm-log history, which is a different laggier surface.

const WORKING_PHASES = new Set(['PLAN', 'EXECUTE', 'EMIT', 'VERIFY', 'CONSOLIDATE']);

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}

// Routed through the shared src/watcher-log.js parser so this view sees the SAME event universe
// as replay. An evt-only scan was tried and rejected: it missed every line carrying no upstream
// `evt:` record, which is exactly the in-flight-verb signal this view most needs -- 57,537 paired
// dispatch.starts plus 6,638 malformed-verb ones, synthesized from "[dispatch] -> verb=..." in
// BOTH the ASCII and Unicode-arrow generations (7 projects emit the Unicode form exclusively, so
// matching only "->" made their entire dispatch stream invisible).
function tailWatcherEvents(cwd, n, { bytes = 256 * 1024 } = {}) {
  const fp = path.join(cwd, '.gm', 'exec-spool', '.watcher.log');
  try {
    const { text } = readTail(fp, bytes);
    const ctx = { epoch: null, epoch_ts: null, lastTs: '', version: null, spawns: [], versions: [] };
    const out = [];
    for (const line of text.split('\n')) {
      const ev = parseLine(line, { cwd, fp, ctx });
      if (ev) out.push(ev);
    }
    return n ? out.slice(-n) : out;
  } catch (_) { return []; }
}

// Bounded because pairing is only as complete as the tail window: a dispatch.start whose
// matching end fell outside the bytes read looks permanently open. Unbounded, that reported
// rs-plugkit as "RUNNING codesearch for 217h" -- a parse artifact, not a live verb.
const IN_FLIGHT_MAX_MS = 15 * 60 * 1000;

function inFlightVerbs(events, { now = Date.now(), maxAgeMs = IN_FLIGHT_MAX_MS } = {}) {
  const open = [];
  for (const e of events) {
    if (e.event === 'dispatch.start') open.push(e);
    else if (e.event === 'dispatch.end') {
      const i = open.findIndex(o => o.verb === e.verb && (!e.task || !o.task || o.task === e.task));
      if (i >= 0) open.splice(i, 1);
      else if (open.length) open.shift();
    }
  }
  return open.filter(o => {
    const t = o.ts ? Date.parse(o.ts) : NaN;
    return Number.isFinite(t) && now - t <= maxAgeMs;
  });
}

function readAgentState(cwd) {
  const turnState = readTurnState(cwd) || {};
  const summary = readTurnSummary(cwd) || {};
  const gate = readJsonFile(path.join(cwd, '.gm', 'exec-spool', '.last-gate-fired.json'));
  const status = readWatcherStatus(cwd);
  const liveness = readProjectLiveness(cwd);

  // Shared with the GUI rather than re-scanned here: this file carried its own
  // first-heading scan, which reported the constant ORCHESTRATOR preamble as the
  // instruction for every project, and fixing that in one copy would have left
  // the two surfaces disagreeing about the same file.
  const phaseState = readLivePhaseState(cwd);
  const heading = phaseState.instruction_heading;
  const instruction = phaseState.instruction_excerpt || '';
  const updatedTs = phaseState.updated_ts;

  let prompt = '';
  try { prompt = fs.readFileSync(path.join(cwd, '.gm', 'last-prompt.txt'), 'utf-8').trim(); } catch (_) {}

  // The three state files each lag differently and routinely DISAGREE -- measured live: gmsniff
  // turn-state=EXECUTE@11:30 while next-step.md=PLAN@10:07 and summary=PLAN; spoint
  // turn-state=PLAN@11:28 while next-step.md/summary=EXECUTE. turn-state.json is written on every
  // transition and is freshest, so it wins here; the heading is reported separately with its own
  // age rather than conflated into the phase.
  const phase = turnState.phase || summary.phase || null;
  const phaseSince = Number.isFinite(turnState.updated_at_ms) ? turnState.updated_at_ms : updatedTs;
  const threshold = Number.isFinite(summary.long_gap_threshold_ms) ? summary.long_gap_threshold_ms : 300000;

  const idleMs = liveness.last_activity_age_ms;
  const instructionAgeMs = updatedTs ? Date.now() - updatedTs : null;

  const recent = tailWatcherEvents(cwd, 400);
  const inFlight = inFlightVerbs(recent);

  return {
    cwd,
    name: path.basename(cwd),
    phase,
    instruction_phase: heading && heading !== phase ? heading : null,
    skill: turnState.last_skill || null,
    heading,
    instruction,
    instruction_age_ms: instructionAgeMs,
    prompt,
    phase_since_ms: phaseSince,
    phase_elapsed_ms: phaseSince ? Date.now() - phaseSince : null,
    idle_ms: idleMs,
    stalled: idleMs !== null && idleMs > threshold,
    prd_pending: Number.isFinite(summary.prd_pending_count) ? summary.prd_pending_count : null,
    mut_pending: Number.isFinite(summary.mutables_pending_count) ? summary.mutables_pending_count : null,
    last_gate: gate && gate.key ? gate.key : null,
    last_gate_ts: gate && Number.isFinite(gate.ts) ? gate.ts : null,
    recent,
    in_flight: inFlight,
    queue_depth: liveness.queue_depth,
    daemon_alive: liveness.daemon_alive,
    alive: liveness.active,
    pid: status ? status.pid : null,
    // Phase alone is not enough: 22 projects sit in a working phase but most last emitted an
    // event days ago -- abandoned mid-phase, not running. An in-flight verb counts regardless of
    // phase age, since a long-running verb is exactly when every state file goes quiet while the
    // agent is in fact busy.
    working: (WORKING_PHASES.has(phase) && idleMs !== null && idleMs <= threshold) || inFlight.length > 0,
  };
}

function collectAgents() {
  const rows = [];
  for (const cwd of discoverProjectCwds()) {
    try {
      if (!fs.existsSync(path.join(cwd, '.gm', 'turn-state.json'))) continue;
      rows.push(readAgentState(cwd));
    } catch (_) {}
  }
  rows.sort((a, b) => (b.working ? 1 : 0) - (a.working ? 1 : 0)
    || (a.idle_ms === null ? 1 : b.idle_ms === null ? -1 : a.idle_ms - b.idle_ms));
  return rows;
}

const PHASE_COLOR = { PLAN: 36, EXECUTE: 32, EMIT: 32, VERIFY: 33, CONSOLIDATE: 33, COMPLETE: 90 };

const EVENT_DETAIL_MAX_CHARS = 90;
const MS_PER_SEC = 1000;
const SEC_PER_MINUTE = 60;

// fmtAge floors to whole seconds, which renders the median 560ms dispatch as
// "0s" and erases the entire sub-second range most dispatches occupy.
function fmtDispatchMs(ms) {
  if (ms < MS_PER_SEC) return `${Math.round(ms)}ms`;
  const s = ms / MS_PER_SEC;
  if (s < SEC_PER_MINUTE) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / SEC_PER_MINUTE)}m${String(Math.round(s % SEC_PER_MINUTE)).padStart(2, '0')}s`;
}

// Measured over 32919 real evt records across four projects: a prose-only chain
// (detail|reason|verb|phase|id|key|query) left 50.3% of lines with an EMPTY
// detail -- 7805 embed.query_cache_hit, 2004 git.commit carrying an unused
// {summary, sha}, 1151 embed_init_ok, 575 codeinsight_index_partial carrying the
// deferred_files count a reboot-loop diagnosis depends on. `error` was absent
// from the chain entirely, so embed_init_fail printed its name and nothing else
// while its full explanation sat in that field.
const EVENT_DETAIL_KEYS = ['detail', 'reason', 'error', 'summary', 'note', 'verb', 'phase', 'id', 'key', 'query', 'path', 'model', 'sha', 'version'];

// Keys worth showing as name=value once no prose field exists. Ordered so the
// operator-relevant counts lead; cwd/sess are excluded because the row already
// names the project and a session id crowds out the measurement.
// `swept`/`holder_pid`/`age_ms` come from the structured-text lines
// src/watcher-log.js synthesizes, not from `evt:` JSON. A coverage measurement
// that scans only evt records will report these as fully covered while
// retention.swept, plugkit.version and lock.stale-takeover render bare.
const EVENT_DETAIL_NUMERIC_KEYS = ['ms', 'deferred_files', 'files_indexed', 'embedded', 'deferred', 'skipped', 'upserted', 'rekeyed', 'embed_ms', 'chunks', 'n_hits', 'top_score', 'query_len', 'seq_len', 'total_ms', 'migrated_count', 'safetensors_bytes', 'host_delegated', 'swept', 'holder_pid', 'age_ms', 'parent_pid'];

function truncateOnWordBoundary(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

function eventDetailText(e) {
  // dispatch.end is the only record carrying a duration, and it is the most
  // actionable number in the feed: measured over 400 real records, 100% carry
  // `ms`, median 560ms, max 339670ms -- a 5.7-minute dispatch that rendered as a
  // bare verb name with nothing to distinguish it from an instant one.
  if (typeof e.ms === 'number' && e.verb) return `${e.verb} ${fmtDispatchMs(e.ms)}`;
  for (const k of EVENT_DETAIL_KEYS) {
    if (e[k] !== undefined && e[k] !== null && e[k] !== '') return String(e[k]);
  }
  const pairs = [];
  for (const k of EVENT_DETAIL_NUMERIC_KEYS) {
    if (e[k] !== undefined && e[k] !== null && e[k] !== '') pairs.push(`${k}=${e[k]}`);
  }
  return pairs.join(' ');
}

const VERBS_BY_FREQUENCY_SHOWN = 15;
const EMBED_FAILURE_ROWS_SHOWN = 20;
const SESSION_KEY_COLUMN_WIDTH = 24;

// A cwd#run key is distinguished by its TRAILING timestamp, so cutting the tail
// collapsed different runs into one displayed string: measured 1047 of 1054 keys
// truncated at the column width and 1054 rows rendering as 99 distinct values,
// with "c:/dev/rs-plugkit#2026-0" alone standing for 144 separate sessions. That
// value is also what --tree takes as input, so it could not identify the session
// it named. The cwd is already in the adjacent project column; the tail is not.
function truncateSessionKeyKeepingItsDistinguishingTail(sess) {
  const key = String(sess);
  if (key.length <= SESSION_KEY_COLUMN_WIDTH) return key;
  return ELLIPSIS_PREFIX + key.slice(key.length - (SESSION_KEY_COLUMN_WIDTH - ELLIPSIS_PREFIX.length));
}
const ELLIPSIS_PREFIX = '...';

// A ranked list that stops at N and says nothing reads as complete: --stats
// printed 4 "by sub" rows against 231696 events with no hint more existed, and
// the verb list capped at 15 while spoint exercises 20 distinct verbs. Prints
// the cap actually applied, and nothing at all when the list fits, so an
// exactly-at-the-boundary list never renders a bare "+0 more".
// The plural is passed rather than derived: appending "s" rendered "querys".
function writeOmittedRowsNote(omitted, cap, singular, plural) {
  if (omitted <= 0) return;
  const noun = omitted === 1 ? singular : plural;
  process.stdout.write(color(`  +${omitted} more ${noun} not shown (list caps at ${cap})\n`, 90));
}

function fmtEventLine(e) {
  const ts = typeof e.ts === 'number' ? new Date(e.ts).toISOString().slice(11, 19)
    : (typeof e.ts === 'string' ? e.ts.slice(11, 19) : '--:--:--');
  const detail = eventDetailText(e);
  const evC = String(e.event).startsWith('deviation.') ? 31 : 0;
  const flat = escapeControlChars(String(detail)).replace(/\s+/g, ' ');
  return `${color(ts, 90)} ${color(escapeControlChars(String(e.event)), evC)} ${truncateOnWordBoundary(flat, EVENT_DETAIL_MAX_CHARS)}`;
}

function renderAgentDrilldown(a, outputLines) {
  process.stdout.write(`${color('='.repeat(78), 90)}\n`);
  process.stdout.write(`${color(a.name, 1)}  ${a.cwd}\n`);
  // turn-state.json calls the field `last_skill`, but measured across four live projects it holds
  // the skill for the phase the agent moves to NEXT, not the one it is in: EXECUTE/gm-emit,
  // VERIFY/gm-consolidate, COMPLETE/update-docs. Labelling it "skill:" beside the current phase
  // read as though the agent were running it now.
  process.stdout.write(`phase:      ${color(a.phase || '?', PHASE_COLOR[a.phase] || 0)}  for ${a.phase_elapsed_ms !== null ? fmtAge(a.phase_elapsed_ms) : '?'}  (next skill: ${a.skill || '?'})\n`);
  process.stdout.write(`instruction:${a.heading || '(none)'} served ${a.instruction_age_ms !== null ? fmtAge(a.instruction_age_ms) : '?'} ago${a.instruction_phase ? color(`  [next-step.md still on ${a.instruction_phase}, turn-state has moved to ${a.phase}]`, 33) : ''}\n`);
  process.stdout.write(`daemon:     ${a.alive ? color('ALIVE', 32) : color('dead', 31)} pid=${a.pid || '?'}   last event: ${a.idle_ms !== null ? fmtAge(a.idle_ms) : '?'} ago${a.stalled ? color('  IDLE', 31) : ''}\n`);
  process.stdout.write(`pending:    prd=${a.prd_pending ?? '?'}  mutables=${a.mut_pending ?? '?'}\n`);
  if (a.last_gate) process.stdout.write(`last gate:  ${a.last_gate}${a.last_gate_ts ? ` (${fmtAge(Date.now() - a.last_gate_ts)} ago)` : ''}\n`);
  if (a.prompt) process.stdout.write(`\n${color('# prompt that opened this chain', 90)}\n${escapeControlChars(a.prompt)}\n`);
  process.stdout.write(`\n${color('# served instruction', 36)}\n`);
  process.stdout.write(a.instruction ? escapeControlChars(a.instruction).replace(/\n{3,}/g, '\n\n') + '\n' : '(none)\n');
  process.stdout.write(`\n${color('# recent output', 36)}\n`);
  for (const f of a.in_flight) {
    const since = f.ts ? fmtAge(Date.now() - Date.parse(f.ts)) : '?';
    process.stdout.write(`  ${color('>> RUNNING', 32)} ${color(f.verb || '?', 1)} for ${since}${f.task ? ` task=${f.task}` : ''}\n`);
  }
  const evs = a.recent.slice(-outputLines);
  if (!evs.length) process.stdout.write('  (no recent events)\n');
  for (const e of evs) process.stdout.write(`  ${fmtEventLine(e)}\n`);
}

function renderAgents(rows, opts) {
  const outputLines = opts['output-lines'] ?? 6;
  const showIdle = !!opts.idle;
  const shown = showIdle ? rows : rows.filter(a => a.working);
  const hidden = rows.length - shown.length;

  // "discovered" alone was ambiguous across surfaces: this walk and the server's
  // discoverProjectsCached scan different roots, so the CLI said 70 while
  // /api/projects said 173 and neither named which population it meant.
  process.stdout.write(`${color('AGENTS', 1)}  ${new Date().toISOString().slice(11, 19)}  -  ${shown.length} working / ${rows.length} with gm state on disk\n\n`);
  if (!shown.length) {
    process.stdout.write(`  (no agent actively working${hidden ? `; ${hidden} idle/COMPLETE -- pass --idle to show` : ''})\n`);
  }
  process.stdout.write(`${color('  S NAME             PHASE       IN-PHASE  LAST-EVT  PENDING           INSTRUCTION', 90)}\n`);
  for (const a of shown) {
    const phase = (a.phase || '?').padEnd(11);
    const elapsed = (a.phase_elapsed_ms !== null ? fmtAge(a.phase_elapsed_ms) : '?').padStart(8);
    const lastEvt = (a.idle_ms !== null ? fmtAge(a.idle_ms) : '?').padStart(8);
    const state = a.alive ? color('*', 32) : color('x', 31);
    const stall = a.stalled ? color(' IDLE', 31) : '';
    const counts = `prd:${String(a.prd_pending ?? '?').padStart(3)} mut:${String(a.mut_pending ?? '?').padStart(2)}`;
    const instr = a.heading ? (a.instruction_phase ? `${a.heading} (served ${a.instruction_age_ms !== null ? fmtAge(a.instruction_age_ms) : '?'} ago)` : a.heading) : '(no instruction)';
    process.stdout.write(`${state} ${color(a.name.padEnd(16).slice(0, 16), 1)} ${color(phase, PHASE_COLOR[a.phase] || 0)} ${elapsed}  ${lastEvt}  ${counts}  ${color(instr, 36)}${stall}\n`);
    for (const f of a.in_flight) {
      const since = f.ts ? fmtAge(Date.now() - Date.parse(f.ts)) : '?';
      process.stdout.write(`      ${color('>> RUNNING', 32)} ${color(f.verb || '?', 1)} for ${since}${f.task ? ` task=${f.task}` : ''}\n`);
    }
    if (a.queue_depth) process.stdout.write(`      ${color(`queued: ${a.queue_depth} spool request(s)`, 33)}\n`);
    for (const e of a.recent.slice(-outputLines)) process.stdout.write(`      ${fmtEventLine(e)}\n`);
    process.stdout.write('\n');
  }
  if (hidden) process.stdout.write(`${color(`  + ${hidden} idle/abandoned/COMPLETE agent(s) hidden -- pass --idle to show`, 90)}\n`);
  process.stdout.write(`${color('  IN-PHASE = since turn-state.json phase change; LAST-EVT = since the last real .watcher.log event', 90)}\n`);
  process.stdout.write(`${color('  --agent <name> for the full instruction text of one project', 90)}\n`);
}

async function liveAgents(opts) {
  const one = opts.agent;
  const outputLines = opts['output-lines'] ?? 6;

  const render = () => {
    const rows = collectAgents();
    if (one) {
      const target = canonPath(one);
      const a = rows.find(r => canonPath(r.cwd) === target) || rows.find(r => r.name.toLowerCase() === String(one).toLowerCase());
      if (!a) {
        process.stderr.write(`--agent: no discovered gm project matching ${JSON.stringify(one)}\nknown: ${rows.map(r => r.name).join(' ')}\n`);
        process.exit(2);
      }
      renderAgentDrilldown(a, outputLines * 4);
      return;
    }
    renderAgents(rows, opts);
  };

  if (!opts.tail) { render(); return; }

  const interval = Math.max(250, opts.interval || 2000);
  const CLEAR_SCREEN_AND_HOME = '\x1b[2J\x1b[H';
  const paint = () => { process.stdout.write(CLEAR_SCREEN_AND_HOME); render(); process.stdout.write(color(`\n(refreshing every ${interval}ms -- Ctrl-C to exit)\n`, 90)); };
  paint();
  const timer = setInterval(paint, interval);
  process.on('SIGINT', () => { clearInterval(timer); process.stdout.write('\n'); process.exit(0); });
  process.stdin.resume();
}

async function rollup(out, all, filter) {
  const filtered = all.filter(filter);
  const body = filtered.map(e => JSON.stringify(e)).join('\n') + (filtered.length ? '\n' : '');
  fs.writeFileSync(out, body);
  process.stderr.write(`# rolled up ${filtered.length} events -> ${out}\n`);
}

// Both sources run concurrently -- the central gm-log tree watcher plus a per-project fanout --
// so a project is observed the moment either carries its events. Same coverage as the GUI
// server's Store.startLive.
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
  // Both stop()s must be awaited (each drains libuv's async fs.watch-handle close, see
  // index.js). An immediate process.exit() after a synchronous close races libuv's own
  // handle-close bookkeeping on Windows and crashes with a UV_HANDLE_CLOSING assertion,
  // reproduced against this exact watcher+fanout shape.
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
  const { url } = await createServer({ port });
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
  // Deliberately NOT the shared parseArgs/FLAGS.bool table: --json's value in this subcommand is
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

  // Short-circuits ahead of both the tail and replay paths: --agents reads live .gm state
  // directly and never needs the multi-second, multi-100k-event gm-log replay.
  if (opts.agents) {
    await liveAgents(opts);
    if (!opts.tail) process.exit(0);
  } else if (opts.tail) {
    await liveTail(filter, opts);
  } else {
    const all = replayAll(DEFAULT_LOG_DIR, { spool: opts.spool });
    // A silently stale source makes every count, rate and "0 matches" below look like a healthy
    // finding when it actually means the CLI is reading a dead log.
    const staleness = sourceStaleness(all);
    if (staleness.stale) {
      process.stderr.write(color(`# WARNING: source is STALE (${staleness.reason}) -- results below describe historical data, not live state. Run 'gmsniff --agents' for live per-project state.\n`, 33));
    }

    if (opts['list-sessions']) { listSessions(all.filter(filter), opts); process.exit(0); }
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

    // Indexing --ctx into the already-filtered array was tried and rejected: it could only ever
    // re-select rows that had already passed, making the flag a silent no-op. Indices are
    // collected against `all` so the neighbours are real ones from the source stream.
    const ctxN = opts.ctx || 0;
    const matchedIdxs = [];
    for (let i = 0; i < all.length; i++) if (filter(all[i])) matchedIdxs.push(i);
    const matched = matchedIdxs.map(i => all[i]);
    let rows = ctxN ? applyContext(matchedIdxs, all, ctxN) : matched;
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
