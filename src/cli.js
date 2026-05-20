#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GmLogWatcher, replayAll } from './index.js';

const DEFAULT_LOG_DIR = process.env.GM_LOG_DIR || path.join(os.homedir(), '.claude', 'gm-log');
const PHASES = ['PLAN', 'EXECUTE', 'EMIT', 'VERIFY', 'COMPLETE'];

const FLAGS = {
  string: ['since', 'until', 'before', 'after', 'sub', 'event', 'sess', 'day', 'cwd', 'pid', 'sort', 'rollup', 'format', 'efficiency', 'xref', 'tree'],
  multi: ['grep', 'igrep', 'sub', 'event', 'sess', 'pid'],
  number: ['limit', 'head', 'tail-n', 'ctx', 'truncate'],
  bool: ['json', 'ndjson', 'tail', 'f', 'full', 'reverse', 'invert', 'count', 'stats', 'list-sessions', 'list-deviations', 'list-events', 'updates', 'no-color', 'help', 'h'],
};

function parseArgs(argv) {
  const opts = { _multi: {} };
  for (const k of FLAGS.multi) opts._multi[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (a === '-f') { opts.tail = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (FLAGS.bool.includes(key)) { opts[key] = true; continue; }
    const val = argv[++i];
    if (FLAGS.multi.includes(key)) opts._multi[key].push(val);
    else if (FLAGS.number.includes(key)) opts[key] = parseInt(val, 10) || 0;
    else opts[key] = val;
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`gmsniff — query, search, and tail gm-log events

USAGE
  gmsniff [filters] [output]            dump matching events (requires ≥1 flag)
  gmsniff -f [filters]                  live tail
  gmsniff --list-sessions [filters]     per-session summary with phase walk
  gmsniff --list-deviations             recent deviation events grouped by kind
  gmsniff --list-events [--sub <s>]     event-type histogram
  gmsniff --stats [filters]             breakdown by sub / event / sess / day
  gmsniff --tree <sess>                 chronological process tree for one session
  gmsniff --efficiency <sess>           turn count, dispatch ratio, time-to-COMPLETE
  gmsniff --xref <sess>                 join with ccsniff transcript on sid
  gmsniff --rollup <out.ndjson>         dump filtered events to file
  gmsniff --updates                     live drift state + update.* event history
  gmsniff gui [--port N] [--open]       launch browser GUI

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
  -f, --tail             live tail after replay
  --no-color             disable ANSI color

EXAMPLES
  gmsniff --since 1h --sub plugkit --event dispatch.end --limit 20
  gmsniff --sub hook --grep "deviation\\." --stats
  gmsniff --list-sessions --since 24h
  gmsniff --tree <sess-id>
  gmsniff --efficiency <sess-id>
  gmsniff --xref <sess-id> --grep "rs-plugkit"
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

function formatRow(e, opts) {
  const truncN = opts.full ? Infinity : (opts.truncate || (opts.json ? 2000 : 200));
  if (opts.json) {
    return JSON.stringify(e) + '\n';
  }
  const t = e.ts ? e.ts.slice(0, 19).replace('T', ' ') : '?'.padEnd(19);
  const sub = (e._sub || '?').padEnd(16).slice(0, 16);
  const ev = (e.event || '?').padEnd(28).slice(0, 28);
  const subC = SUB_COLORS[e._sub] || 0;
  const sessShort = e.sess ? e.sess.slice(0, 8) : '--------';
  const payload = { ...e };
  delete payload._sub; delete payload._day; delete payload._fp;
  delete payload.ts; delete payload.event; delete payload.sub; delete payload.pid; delete payload.sess; delete payload.cwd;
  let body = JSON.stringify(payload);
  if (body === '{}') body = '';
  if (body.length > truncN) body = body.slice(0, truncN) + '…';
  const evC = e.event && e.event.startsWith('deviation.') ? 31 : (e.event && e.event.endsWith('.error') ? 31 : 0);
  return `${t}  ${color(sub, subC)}  ${color(ev, evC)}  ${sessShort}  ${body}\n`;
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
    return { pid: j.pid, version: j.version, alive, age_ms: age };
  } catch (_) { return null; }
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
    const walk = PHASES.map(p => s.phases.has(p) ? color('█', 32) : color('░', 90)).join('');
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
  process.stderr.write(`# ${rows.length} sessions · phase walk: P E E V C · watcher: ALIVE/dead per project cwd\n`);
}

function listDeviations(all) {
  const filt = all.filter(e => typeof e.event === 'string' && e.event.startsWith('deviation.'));
  const byKind = new Map();
  for (const e of filt) byKind.set(e.event, (byKind.get(e.event) || 0) + 1);
  process.stdout.write(`# total deviations: ${filt.length}\n`);
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${String(n).padStart(5)}  ${color(k, 31)}\n`);
  }
  process.stdout.write('\n# recent (last 20):\n');
  for (const e of filt.slice(-20).reverse()) {
    process.stdout.write(formatRow(e, { truncate: 300 }));
  }
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

function tree(all, sess) {
  if (!sess) { process.stderr.write('--tree requires a session id\n'); process.exit(2); }
  const wantEmpty = sess === '(no-session)' || sess === '' || sess === '-';
  const evs = all.filter(e => wantEmpty ? !e.sess : (e.sess === sess || (e.sess || '').startsWith(sess))).sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  let currentPhase = '?';
  let firstInstructionSeen = false;
  const gaps = [];
  for (const e of evs) {
    if (e._sub !== 'plugkit' && !(typeof e.event === 'string' && e.event.startsWith('deviation.'))) continue;
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
    if (e.key) extra += ` key=${String(e.key).slice(0, 32)}`;
    process.stdout.write(`${indent}${t}  ${color(e.event, evC)}${extra}\n`);
  }
  if (!firstInstructionSeen && evs.length > 0) gaps.push('no instruction.served event — agent did not enter the loop');
  for (const e of evs) if (typeof e.event === 'string' && e.event.startsWith('deviation.')) gaps.push(`${e.event} at ${e.ts}`);
  if (gaps.length) {
    process.stdout.write('\n' + color('# gaps:', 31) + '\n');
    for (const g of gaps) process.stdout.write(`  ${color('!', 31)} ${g}\n`);
  }
  process.stderr.write(`# ${evs.length} events for session ${sess} · final phase: ${currentPhase}\n`);
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
  process.stdout.write(`duration:          ${Math.round(durMs / 1000)}s  (${first} → ${last})\n`);
  process.stdout.write(`dispatches:        ${dispatches}\n`);
  process.stdout.write(`instructions:      ${instructions}\n`);
  process.stdout.write(`transitions:       ${transitions}\n`);
  process.stdout.write(`mutables resolved: ${mutRes}\n`);
  process.stdout.write(`deviations:        ${devs}${devs ? color('  ← burn check', 31) : ''}\n`);
  process.stdout.write(`phases reached:    ${[...phasesSeen].join(', ') || '(none)'}\n`);
  process.stdout.write(`completed:         ${completeAt || color('no', 31)}\n`);
  process.stdout.write(`disp/trans ratio:  ${transitions ? (dispatches / transitions).toFixed(1) : 'n/a'}\n`);
  process.stdout.write('\n# verbs by frequency:\n');
  for (const [v, n] of [...verbs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    process.stdout.write(`  ${String(n).padStart(4)}  ${v}\n`);
  }
}

async function xref(all, sess, opts) {
  if (!sess) { process.stderr.write('--xref requires a session id\n'); process.exit(2); }
  const gmEvs = all.filter(e => e.sess === sess).map(e => ({ _src: 'gm', ts: e.ts ? Date.parse(e.ts) : 0, label: e.event || '?', detail: e, _sub: e._sub }));
  let ccEvs = [];
  try {
    const cc = await import('ccsniff');
    const r = new cc.JsonlReplayer();
    const collected = [];
    r.on('streaming_progress', ev => { if (ev.conversation && ev.conversation.id && ev.conversation.id.startsWith(sess)) collected.push(ev); });
    r.replay({});
    ccEvs = collected.map(ev => ({ _src: 'cc', ts: ev.timestamp || 0, label: `${ev.role || '?'}/${ev.block?.type || '?'}${ev.block?.name ? ':' + ev.block.name : ''}`, detail: ev }));
  } catch (e) {
    process.stderr.write(`# ccsniff not available (${e.message}) — gm events only\n`);
  }
  const merged = [...gmEvs, ...ccEvs].sort((a, b) => a.ts - b.ts);
  const greps = (opts._multi.grep || []).map(r => new RegExp(r, 'i'));
  for (const e of merged) {
    if (greps.length) {
      const s = JSON.stringify(e.detail);
      if (!greps.every(r => r.test(s))) continue;
    }
    const ts = e._src === 'gm' ? new Date(e.ts).toISOString().slice(11, 19) : new Date(e.ts).toISOString().slice(11, 19);
    const srcTag = e._src === 'gm' ? color('[gm]', 31) : color('[cc]', 34);
    process.stdout.write(`${ts}  ${srcTag}  ${e.label}\n`);
  }
  process.stderr.write(`# ${gmEvs.length} gm-events + ${ccEvs.length} cc-events for session ${sess}\n`);
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

async function rollup(out, all, filter) {
  const filtered = all.filter(filter);
  const body = filtered.map(e => JSON.stringify(e)).join('\n') + (filtered.length ? '\n' : '');
  fs.writeFileSync(out, body);
  process.stderr.write(`# rolled up ${filtered.length} events → ${out}\n`);
}

async function liveTail(filter, opts) {
  const watcher = new GmLogWatcher(DEFAULT_LOG_DIR);
  watcher.on('event', e => { if (filter(e)) process.stdout.write(formatRow(e, opts)); });
  watcher.on('error', err => process.stderr.write(`# error: ${err?.message || err}\n`));
  watcher.start();
  process.stdout.write('# tailing... (Ctrl-C to exit)\n');
  process.stdin.resume();
}

async function launchGui(args) {
  const { createServer } = await import('./server.js');
  let port = 0, open = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = parseInt(args[++i], 10) || 0;
    else if (args[i] === '--open') open = true;
  }
  const { url } = await createServer({ logDir: DEFAULT_LOG_DIR, port });
  process.stdout.write(`gmsniff gui · ${url}\n`);
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
} else {
  const opts = parseArgs(argv);
  if (opts.help || argv.length === 0) { printHelp(); process.exit(0); }
  if (opts['no-color']) process.env.NO_COLOR = '1';

  const filter = buildFilter(opts);

  if (opts.tail) {
    await liveTail(filter, opts);
  } else {
    const all = replayAll(DEFAULT_LOG_DIR);

    if (opts['list-sessions']) { listSessions(all.filter(filter)); process.exit(0); }
    if (opts['list-deviations']) { listDeviations(all.filter(filter)); process.exit(0); }
    if (opts['list-events']) { listEvents(all.filter(filter), opts.sub); process.exit(0); }
    if (opts.updates) { updates(all, opts); process.exit(0); }
    if (opts.tree) { tree(all, opts.tree); process.exit(0); }
    if (opts.efficiency) { efficiency(all, opts.efficiency); process.exit(0); }
    if (opts.xref) { await xref(all, opts.xref, opts); process.exit(0); }
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
    process.stderr.write(`# ${all.length} total · ${rows.length} matched\n`);
  }
}
