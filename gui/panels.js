// All gmsniff panels, built from anentrypoint-design's webjsx factories
// (shell.js primitives + data-density.js dense widgets) plus small local
// gm-* CSS classes (gui-extra.css) for table/toolbar/query chrome the design
// system doesn't ship. Every panel returns a vnode tree; app.js re-renders
// the active panel's container on data load / SSE events / interval ticks.

import * as webjsx from 'webjsx';
import { Chip, Badge, Btn, Glyph } from 'ds/components/shell.js';
import { PhaseWalk, TreeNode, BarRow, StatTile, StatsGrid, SubGrid, SessionRow, DevRow, LiveLog } from 'ds/components/data-density.js';
import { api, apiPost, esc, fmtTs, state, toast } from './data.js';

const h = webjsx.createElement;

export const SUB_COLORS = {
  hook: 'var(--purple, #bc8cff)', exec: 'var(--accent, #58a6ff)', rs_learn: 'var(--green, #3fb950)',
  rs_codeinsight: 'var(--orange, #ffa657)', rs_search: 'var(--yellow, #d29922)', plugkit: 'var(--flame, #ff7b72)',
  plugkit_wrapper: 'var(--teal, #39d353)', bootstrap: 'var(--sky, #79c0ff)', 'acp-launcher': '#ff9ddb',
  learning: 'var(--green, #3fb950)', git: 'var(--orange, #ffa657)',
};
export let SUB_LIST = ['plugkit', 'exec', 'hook', 'rs_learn', 'rs_codeinsight', 'rs_search', 'bootstrap', 'plugkit_wrapper', 'acp-launcher', 'learning', 'git'];

function colorFor(sub) {
  if (SUB_COLORS[sub]) return SUB_COLORS[sub];
  let hue = 0;
  for (let i = 0; i < sub.length; i++) hue = (hue * 31 + sub.charCodeAt(i)) >>> 0;
  return `hsl(${hue % 360}, 60%, 65%)`;
}

function Empty(msg) { return h('p', { class: 'gm-empty' }, msg); }

// ---------------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------------
export async function Dashboard() {
  const snap = await api('/api/snapshot');
  if (snap.error) return Empty('Failed to load snapshot: ' + snap.error);
  if (Array.isArray(snap.observedSubsystems) && snap.observedSubsystems.length) {
    SUB_LIST = [...new Set([...SUB_LIST, ...snap.observedSubsystems])];
  }
  const stats = StatsGrid({
    items: [
      { val: snap.total ?? 0, lbl: 'total events' },
      { val: snap.pids ?? 0, lbl: 'sessions' },
      { val: snap.errors ?? 0, lbl: 'errors', cls: snap.errors ? 'err-rate' : '' },
      { val: Object.keys(snap.byDay || {}).length, lbl: 'days' },
    ],
  });
  const bySub = snap.bySub || {};
  const subRows = SUB_LIST.map(s => {
    const n = bySub[s] || 0;
    const pct = snap.total ? Math.round(n / snap.total * 100) : 0;
    return BarRow({ label: s, value: String(n), pct, tone: colorFor(s) });
  });
  const evSorted = Object.entries(snap.byEvent || {}).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const evRows = evSorted.length
    ? evSorted.map(([ev, n]) => BarRow({ label: ev || '?', value: String(n), pct: snap.total ? Math.round(n / snap.total * 100) : 0 }))
    : [Empty('No events observed yet.')];
  return h('div', {},
    h('div', { style: 'margin-bottom:12px' }, stats),
    h('div', { class: 'gm-flex-row' },
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Subsystems'), ...(snap.total ? subRows : [Empty('No data.')])),
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Top Events'), ...evRows)));
}

// ---------------------------------------------------------------------------
// BY DAY
// ---------------------------------------------------------------------------
export async function ByDay() {
  const days = await api('/api/days');
  if (!Array.isArray(days) || !days.length) return Empty('No day-bucketed data yet.');
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Events by Day'),
    h('table', { class: 'gm-table' },
      h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Total'), ...SUB_LIST.map(s => h('th', { style: `color:${colorFor(s)}` }, s))),
      ...days.map(d => h('tr', { key: d.day }, h('td', {}, d.day), h('td', {}, String(d.total)),
        ...SUB_LIST.map(s => h('td', {}, String(d.bySub[s] || '')))))));
}

// ---------------------------------------------------------------------------
// LIVE STREAM
// ---------------------------------------------------------------------------
let liveEntries = [];
export function pushLiveEntry(ev) {
  const payload = { ...ev };
  delete payload._sub; delete payload._day; delete payload._fp;
  liveEntries.push({ key: liveEntries.length, ts: fmtTs(ev.ts), sub: ev._sub, tone: colorFor(ev._sub || ''), event: ev.event || '?', preview: JSON.stringify(payload).slice(0, 200) });
  if (liveEntries.length > 2000) liveEntries.shift();
}
export function LiveStream({ connState = 'connecting' } = {}) {
  const toneMap = { live: 'positive', reconnecting: 'warn', connecting: 'neutral', closed: 'danger' };
  return h('div', { class: 'ds-panel', style: 'padding:8px' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' },
      h('h2', { style: 'margin:0' }, 'Live Stream'),
      Chip({ tone: toneMap[connState] || 'neutral', children: connState })),
    liveEntries.length ? LiveLog({ entries: liveEntries.slice(-500), autoScroll: true }) : Empty('No live events received yet.'));
}

// ---------------------------------------------------------------------------
// ALL EVENTS / SEARCH / SUBSYSTEM (shared table renderer)
// ---------------------------------------------------------------------------
export function renderEventTable(rows) {
  if (!rows || !rows.length) return Empty('No events.');
  const cols = new Set();
  for (const r of rows) Object.keys(r).forEach(k => { if (!k.startsWith('_')) cols.add(k); });
  const keys = [...cols];
  const display = ['ts', 'event', 'pid', ...keys.filter(k => !['ts', 'event', 'pid', '_sub', '_day', '_fp'].includes(k))];
  return h('table', { class: 'gm-table' },
    h('tr', {}, h('th', {}, 'sub'), ...display.map(k => h('th', {}, k))),
    ...rows.map((r, i) => h('tr', { key: i },
      h('td', {}, Badge({ children: r._sub || '?', tone: 'neutral' })),
      ...display.map(k => {
        const v = r[k];
        if (v === undefined || v === null) return h('td', {});
        if (k === 'ts') return h('td', { class: 'ts' }, fmtTs(v));
        if (k === 'event') return h('td', {}, h('strong', {}, String(v)));
        if (typeof v === 'boolean') return h('td', {}, v ? Badge({ children: '[x]', tone: 'positive' }) : Badge({ children: '[ ]', tone: 'danger' }));
        if (typeof v === 'object') {
          const s = JSON.stringify(v);
          return h('td', {}, s.length > 80
            ? h('details', {}, h('summary', {}, s.slice(0, 40) + '...'), h('pre', { class: 'gm-json' }, s))
            : s);
        }
        const sv = String(v);
        return h('td', { title: sv.length > 120 ? sv : null }, sv.length > 120 ? sv.slice(0, 80) + '...' : sv);
      }))));
}

const evPageState = { offset: 0, limit: 100, filters: {} };
export async function AllEvents(setBody) {
  const params = new URLSearchParams({ limit: evPageState.limit, offset: evPageState.offset });
  for (const [k, v] of Object.entries(evPageState.filters)) if (v) params.set(k, v);
  const [data, evTypes, days] = await Promise.all([
    api('/api/events?' + params, { scoped: false }),
    api('/api/event-types'),
    api('/api/days'),
  ]);
  const filterSelect = (id, label, opts, val) => h('select', {
    onchange: (e) => { evPageState.filters[id] = e.target.value; evPageState.offset = 0; setBody(); },
  }, h('option', { value: '' }, label), ...opts.map(o => h('option', { value: o, selected: o === val ? true : null }, o)));
  const total = data.total || 0;
  return h('div', { class: 'ds-panel' },
    h('div', { class: 'gm-toolbar' },
      h('input', { placeholder: 'filter...', value: evPageState.filters.q || '', oninput: (e) => { evPageState.filters.q = e.target.value; evPageState.offset = 0; setBody(); } }),
      filterSelect('sub', 'all subsystems', SUB_LIST, evPageState.filters.sub),
      filterSelect('event', 'all events', (evTypes || []).map(e => e.event), evPageState.filters.event),
      filterSelect('day', 'all days', (days || []).map(d => d.day), evPageState.filters.day)),
    renderEventTable(data.rows),
    h('div', { class: 'gm-pager' },
      h('button', { disabled: evPageState.offset === 0 ? true : null, onclick: () => { evPageState.offset = Math.max(0, evPageState.offset - evPageState.limit); setBody(); } }, '<- prev'),
      h('span', {}, total ? `${evPageState.offset + 1}-${Math.min(evPageState.offset + evPageState.limit, total)} of ${total}` : '0 of 0'),
      h('button', { disabled: evPageState.offset + evPageState.limit >= total ? true : null, onclick: () => { evPageState.offset += evPageState.limit; setBody(); } }, 'next ->')));
}

const searchState = { q: '', sub: '', results: [] };
export function Search(setBody) {
  return h('div', { class: 'ds-panel' },
    h('div', { class: 'gm-toolbar' },
      h('input', {
        placeholder: 'search all events...', value: searchState.q,
        onkeydown: (e) => { if (e.key === 'Enter') runSearch(setBody); },
        oninput: (e) => { searchState.q = e.target.value; },
      }),
      h('select', { onchange: (e) => { searchState.sub = e.target.value; } },
        h('option', { value: '' }, 'all subsystems'), ...SUB_LIST.map(s => h('option', { value: s }, s))),
      Btn({ children: 'Search', onClick: () => runSearch(setBody) })),
    searchState.results.length ? renderEventTable(searchState.results) : Empty('No search performed yet.'));
}
async function runSearch(setBody) {
  const params = new URLSearchParams({ q: searchState.q });
  if (searchState.sub) params.set('sub', searchState.sub);
  const data = await api('/api/search?' + params);
  searchState.results = data.results || [];
  setBody();
}

const subPageState = { current: null, offset: 0, limit: 100, filters: {} };
export async function SubsystemPanel(sub, setBody) {
  if (subPageState.current !== sub) { subPageState.current = sub; subPageState.offset = 0; subPageState.filters = {}; }
  const params = new URLSearchParams({ sub, limit: subPageState.limit, offset: subPageState.offset });
  for (const [k, v] of Object.entries(subPageState.filters)) if (v) params.set(k, v);
  const [data, evTypes, days] = await Promise.all([
    api('/api/subsystem?' + params), api('/api/event-types?sub=' + sub), api('/api/days'),
  ]);
  const total = data.total || 0;
  return h('div', { class: 'ds-panel' }, h('h2', {}, sub),
    h('div', { class: 'gm-toolbar' },
      h('input', { placeholder: 'filter...', value: subPageState.filters.q || '', oninput: (e) => { subPageState.filters.q = e.target.value; subPageState.offset = 0; setBody(); } }),
      h('select', { onchange: (e) => { subPageState.filters.event = e.target.value; subPageState.offset = 0; setBody(); } },
        h('option', { value: '' }, 'all events'), ...(evTypes || []).map(e => h('option', { value: e.event }, e.event))),
      h('select', { onchange: (e) => { subPageState.filters.day = e.target.value; subPageState.offset = 0; setBody(); } },
        h('option', { value: '' }, 'all days'), ...(days || []).map(d => h('option', { value: d.day }, d.day)))),
    renderEventTable(data.rows),
    h('div', { class: 'gm-pager' },
      h('button', { disabled: subPageState.offset === 0 ? true : null, onclick: () => { subPageState.offset = Math.max(0, subPageState.offset - subPageState.limit); setBody(); } }, '<- prev'),
      h('span', {}, total ? `${subPageState.offset + 1}-${Math.min(subPageState.offset + subPageState.limit, total)} of ${total}` : '0 of 0'),
      h('button', { disabled: subPageState.offset + subPageState.limit >= total ? true : null, onclick: () => { subPageState.offset += subPageState.limit; setBody(); } }, 'next ->')));
}

// ---------------------------------------------------------------------------
// DEVIATIONS
// ---------------------------------------------------------------------------
export async function Deviations() {
  const r = await api('/api/deviations?limit=200');
  if (r.error) return Empty('Failed to load deviations: ' + r.error);
  const kindRows = Object.entries(r.byKind || {}).sort((a, b) => b[1] - a[1]);
  const sessRows = Object.entries(r.bySession || {}).sort((a, b) => b[1] - a[1]).slice(0, 15);
  return h('div', {},
    h('div', { class: 'gm-flex-row' },
      h('div', { class: 'ds-panel' }, h('h2', {}, 'By Deviation Kind'),
        ...(kindRows.length ? kindRows.map(([k, n]) => BarRow({ label: k, value: String(n), tone: 'var(--flame, #f85149)' })) : [Empty('No deviations recorded yet.')])),
      h('div', { class: 'ds-panel' }, h('h2', {}, 'By Session'),
        ...(sessRows.length ? sessRows.map(([s, n]) => BarRow({ label: s.slice(0, 60), value: String(n) })) : [Empty('-')]))),
    h('div', { class: 'ds-panel' }, h('h2', {}, `Recent Deviations (${r.total})`),
      ...((r.recent || []).length ? r.recent.map((e, i) => DevRow({
        ts: fmtTs(e.ts), event: e.event, sess: (e.sess || '-').slice(0, 20), operation: e.operation,
        residuals: Array.isArray(e.residuals) ? e.residuals : (e.reason ? [e.reason] : []),
      })) : [Empty('No deviations recorded -- agents are following the process.')])));
}

// ---------------------------------------------------------------------------
// SESSIONS / PROCESS TREE
// ---------------------------------------------------------------------------
const PHASES = ['PLAN', 'EXECUTE', 'EMIT', 'VERIFY', 'COMPLETE'];
export async function Sessions(onOpen) {
  const r = await api('/api/sessions?limit=200');
  if (r.error) return Empty('Failed to load sessions: ' + r.error);
  if (!r.rows || !r.rows.length) return Empty('No sessions recorded yet.');
  return h('div', { class: 'ds-panel' }, h('h2', {}, `Sessions (${r.total})`),
    ...r.rows.map(s => {
      const gaps = [];
      for (let i = 0; i < PHASES.length - 1; i++) if (s.phases_reached[i + 1] && !s.phases_reached[i]) gaps.push(PHASES[i]);
      return SessionRow({
        sessId: s.sess, events: s.events, verbs: s.dispatches, prd: `${s.prd_adds}/${s.prd_resolves}`,
        muts: `${s.mutable_adds}/${s.mutable_resolves}`, resid: `${s.residual_fires}f/${s.residual_skips}s`,
        deviations: s.deviations, firstTs: fmtTs(s.first_ts), lastTs: fmtTs(s.last_ts),
        phaseWalkProps: { reached: s.phases_reached, gapKinds: gaps },
        onClick: () => onOpen(s.sess),
      });
    }));
}

export async function ProcessTree(sess, sessList, onSelect) {
  const selector = h('select', {
    value: sess || '',
    onchange: (e) => onSelect(e.target.value),
  }, h('option', { value: '' }, 'select session...'),
    ...(sessList || []).map(s => h('option', { value: s.sess, selected: s.sess === sess ? true : null }, `${s.sess.slice(0, 40)} -- ${fmtTs(s.last_ts)} -- ${s.events}ev${s.deviations ? ' !' + s.deviations : ''}`)));
  if (!sess) return h('div', { class: 'ds-panel' }, h('div', { class: 'gm-toolbar' }, selector), Empty('Select a session.'));
  const r = await api('/api/process-tree?sess=' + encodeURIComponent(sess));
  const gapsBlock = (r.gaps && r.gaps.length)
    ? h('div', { class: 'ds-panel', style: 'border-color:var(--flame,#f85149)' }, h('h2', { style: 'color:var(--flame,#f85149)' }, 'Gaps detected'),
      ...r.gaps.map((g, i) => DevRow({ ts: fmtTs(g.ts), event: g.kind, operation: g.from ? `${g.from} -> ${g.to}` : (g.deviation || ''), residuals: g.detail ? [`first non-instruction event: ${g.detail.event} verb=${g.detail.verb || ''}`] : [] })))
    : null;
  const nodes = (r.nodes || []).map((n, i) => {
    const variant = (n.kind === 'transition' || n.kind === 'instruction') ? 'phase' : (n.kind === 'deviation' ? 'deviation' : n.kind === 'mutable-resolve' ? 'mutable-resolve' : n.kind === 'prd-add' ? 'prd-add' : '');
    return TreeNode({
      ts: fmtTs(n.ts), kind: n.kind, variant, phase: n.phase, id: n.id,
      keyLabel: n.key ? 'key:' + String(n.key).slice(0, 30) : null,
      reason: n.reason || (n.kind === 'instruction' ? `prd:${n.prd_pending || 0} muts:${n.mutables_pending || 0}` : null),
      deviationLabel: n.deviation, residuals: Array.isArray(n.residuals) ? n.residuals : null,
    });
  });
  return h('div', { class: 'ds-panel' },
    h('div', { class: 'gm-toolbar' }, selector),
    h('h2', {}, sess), PhaseWalk({ reached: r.phase_reached, gapKinds: [] }),
    gapsBlock,
    h('h2', { style: 'margin-top:10px' }, `Timeline (${(r.nodes || []).length})`),
    ...(nodes.length ? nodes : [Empty('No process events for this session.')]));
}

// ---------------------------------------------------------------------------
// QUERY
// ---------------------------------------------------------------------------
const QUERY_TEMPLATES = {
  'slow-dispatches': { filter: { event: 'dispatch.end', dur_ms: { gt: 1000 } }, projection: ['ts', 'verb', 'dur_ms', 'cwd', 'sess'], sort: [['dur_ms', 'desc']], limit: 50 },
  'all-deviations': { filter: { event: { regex: '^deviation\\.' } }, groupBy: ['event'], sort: [['ts', 'desc']], limit: 200 },
  'phase-transitions': { filter: { event: 'phase.transitioned' }, projection: ['ts', 'phase', 'next_skill', 'sess', 'cwd'], sort: [['ts', 'desc']], limit: 100 },
  'dispatch-errors': { filter: { event: 'dispatch.error' }, projection: ['ts', 'verb', 'error', 'sess', 'cwd'], sort: [['ts', 'desc']], limit: 100 },
  'instruction-served': { filter: { event: 'instruction.served', prd_pending: { gt: 0 } }, projection: ['ts', 'phase', 'prd_pending', 'mutables_pending', 'sess', 'cwd'], sort: [['ts', 'desc']], limit: 50 },
  'recent-by-cwd': { filter: {}, groupBy: ['cwd'], sort: [['ts', 'desc']], limit: 500 },
};
const queryState = { spec: { filter: {}, sort: [['ts', 'desc']], limit: 50 }, result: null };
export function QueryPanel(setBody) {
  const specText = JSON.stringify(queryState.spec, null, 2);
  return h('div', { class: 'ds-panel' },
    h('h2', {}, 'Query -- compose your own analysis'),
    h('p', { style: 'color:var(--muted);font-size:11px;margin-bottom:8px' },
      'JSON shape: {filter:{sub, event:{regex}, dur_ms:{gt}}, groupBy, projection, sort, limit}. Operators: eq/ne/in/nin/gt/gte/lt/lte/regex/contains/exists/and/or/not.'),
    h('div', { class: 'gm-toolbar' },
      Btn({ children: 'Run', onClick: () => runQuery(setBody) }),
      Btn({ children: 'Reset', variant: 'ghost', onClick: () => { queryState.spec = { filter: {}, sort: [['ts', 'desc']], limit: 50 }; queryState.result = null; setBody(); } }),
      h('select', {
        onchange: (e) => { if (QUERY_TEMPLATES[e.target.value]) { queryState.spec = QUERY_TEMPLATES[e.target.value]; runQuery(setBody); } },
      }, h('option', { value: '' }, 'load template...'), ...Object.keys(QUERY_TEMPLATES).map(k => h('option', { value: k }, k)))),
    h('textarea', {
      class: 'gm-textarea', spellcheck: 'false',
      oninput: (e) => { try { queryState.spec = JSON.parse(e.target.value); } catch (_) {} },
    }, specText),
    queryState.result || h('p', { class: 'gm-empty' }, 'Run a query to see results.'));
}
async function runQuery(setBody) {
  const r = await apiPost('/api/query', queryState.spec);
  if (r.error) { queryState.result = h('p', { style: 'color:var(--flame,#f85149)' }, `${r.error}: ${r.detail || ''}`); setBody(); return; }
  if (r.groups) {
    const total = r.groups.reduce((s, g) => s + g.count, 0);
    queryState.result = h('div', {},
      h('p', { style: 'color:var(--muted);font-size:11px;margin-bottom:8px' }, `grouped by ${r.groupBy.join(', ')} -- ${r.groups.length} groups -- ${total} rows (total: ${r.total})`),
      h('table', { class: 'gm-table' }, h('tr', {}, h('th', {}, 'group'), h('th', {}, 'count'), h('th', {}, 'sample')),
        ...r.groups.map((g, i) => h('tr', { key: i }, h('td', {}, h('strong', {}, g.key)), h('td', {}, String(g.count)), h('td', {}, h('pre', { class: 'gm-json' }, JSON.stringify(g.sample[0] || {}, null, 2).slice(0, 400)))))));
  } else {
    const rows = r.rows || [];
    queryState.result = rows.length ? h('div', {},
      h('p', { style: 'color:var(--muted);font-size:11px;margin-bottom:8px' }, `${r.returned} of ${r.total} matching rows`),
      renderEventTable(rows)) : Empty(`no matches (scanned ${r.total || 0} events)`);
  }
  setBody();
}

// ---------------------------------------------------------------------------
// RECALL / EXEC / HOOKS STATS
// ---------------------------------------------------------------------------
export async function RecallStats() {
  const r = await api('/api/recall');
  if (r.error) return Empty('Failed to load recall stats: ' + r.error);
  if (!r.total) return Empty('No recall events recorded yet.');
  const hitPct = Math.round((r.hits / r.total) * 100);
  return h('div', { class: 'gm-flex-row' },
    h('div', { class: 'ds-panel' }, h('h2', {}, 'Recall Stats'),
      StatsGrid({ items: [{ val: r.total, lbl: 'total recalls' }, { val: r.hits, lbl: 'hits' }, { val: r.misses, lbl: 'misses' }, { val: r.avgDur + 'ms', lbl: 'avg duration' }] }),
      h('div', { style: 'margin-top:14px;text-align:center' },
        h('div', { class: 'ds-stat-val' + (hitPct < 50 ? ' err-rate' : '') }, hitPct + '%'),
        h('div', { style: 'color:var(--muted);font-size:12px' }, 'hit rate'))),
    h('div', { class: 'ds-panel', style: 'flex:2' }, h('h2', {}, 'Recent Recalls'),
      h('table', { class: 'gm-table' }, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Query'), h('th', {}, 'Hit'), h('th', {}, 'ms')),
        ...(r.recent || []).map((e, i) => h('tr', { key: i }, h('td', {}, fmtTs(e.ts)), h('td', {}, e.query || ''), h('td', {}, e.hit ? Badge({ children: 'hit', tone: 'positive' }) : Badge({ children: 'miss', tone: 'danger' })), h('td', {}, String(e.dur_ms || '')))))));
}

export async function ExecStats() {
  const r = await api('/api/exec');
  if (r.error) return Empty('Failed to load exec stats: ' + r.error);
  if (!r.total) return Empty('No exec spawns recorded yet.');
  const runtimes = Object.entries(r.byRuntime || {}).sort((a, b) => b[1] - a[1]);
  return h('div', { class: 'gm-flex-row' },
    h('div', { class: 'ds-panel' }, h('h2', {}, 'Exec Stats'),
      StatsGrid({ items: [{ val: r.total, lbl: 'total spawns' }, { val: r.errors, lbl: 'errors' }] }),
      h('h2', { style: 'margin-top:12px' }, 'By Runtime'),
      ...runtimes.map(([rt, n]) => BarRow({ label: rt, value: String(n), pct: r.total ? Math.round(n / r.total * 100) : 0 }))),
    h('div', { class: 'ds-panel', style: 'flex:2' }, h('h2', {}, 'Recent Spawns'),
      h('table', { class: 'gm-table' }, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Runtime'), h('th', {}, 'OK'), h('th', {}, 'PID'), h('th', {}, 'CWD'), h('th', {}, 'Code')),
        ...(r.recent || []).map((e, i) => h('tr', { key: i }, h('td', {}, fmtTs(e.ts)), h('td', {}, Badge({ children: e.runtime || '?', tone: 'neutral' })), h('td', {}, e.ok === false ? Badge({ children: 'err', tone: 'danger' }) : Badge({ children: 'ok', tone: 'positive' })), h('td', {}, String(e.pid || '')), h('td', { title: e.cwd || '' }, (e.cwd || '').slice(0, 40)), h('td', {}, String(e.code_len || '')))))));
}

export async function HookStats() {
  const r = await api('/api/hooks');
  if (r.error) return Empty('Failed to load hook stats: ' + r.error);
  if (!r.total) return Empty('No hook events recorded yet.');
  const evs = Object.entries(r.byEvent || {}).sort((a, b) => b[1] - a[1]);
  return h('div', { class: 'gm-flex-row' },
    h('div', { class: 'ds-panel' }, h('h2', {}, 'Hook Stats'), StatsGrid({ items: [{ val: r.total, lbl: 'total hooks' }] }),
      h('h2', { style: 'margin-top:12px' }, 'By Event'),
      ...evs.map(([ev, n]) => BarRow({ label: ev, value: String(n), pct: r.total ? Math.round(n / r.total * 100) : 0, tone: 'var(--purple,#bc8cff)' }))),
    h('div', { class: 'ds-panel', style: 'flex:2' }, h('h2', {}, 'Recent Hooks'),
      h('table', { class: 'gm-table' }, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Event'), h('th', {}, 'Phase'), h('th', {}, 'PID'), h('th', {}, 'ms')),
        ...(r.recent || []).map((e, i) => h('tr', { key: i }, h('td', {}, fmtTs(e.ts)), h('td', {}, Badge({ children: e.event || '?', tone: 'neutral' })), h('td', {}, e.phase || ''), h('td', {}, String(e.pid || '')), h('td', {}, String(e.dur_ms || '')))))));
}

// ---------------------------------------------------------------------------
// PRD EDITOR / MUTABLES EDITOR
// ---------------------------------------------------------------------------
async function editRow(kind, id, since, fields, setBody) {
  const path = kind === 'prd' ? '/api/prd/edit' : '/api/mutables/edit';
  const r = await apiPost(path, { id, since, ...fields }, { scoped: true });
  if (r.status === 409) { toast(`Conflict: ${id} was modified since read (mtime ${r.mtimeMs}). Reloading.`, true); setBody(true); return; }
  if (r.status !== 200) { toast(`Edit failed: ${r.error || r.status}`, true); return; }
  toast(`Saved ${id}`); setBody(true);
}

export async function PrdEditor(setBody) {
  const r = await api('/api/prd', { scoped: true });
  if (r.error) return Empty('Failed to load PRD: ' + r.error);
  if (!r.rows || !r.rows.length) return Empty('No PRD rows for this project.');
  const since = r.mtimeMs;
  return h('div', { class: 'ds-panel' }, h('h2', {}, `PRD (${r.rows.length} rows)`),
    h('table', { class: 'gm-table' }, h('tr', {}, h('th', {}, 'id'), h('th', {}, 'status'), h('th', {}, 'text')),
      ...r.rows.map((row, i) => h('tr', { key: row.id },
        h('td', {}, row.id),
        h('td', {}, h('select', {
          value: row.status,
          onchange: (e) => editRow('prd', row.id, since, { status: e.target.value }, setBody),
        }, ...['pending', 'in_progress', 'resolved', 'blocked'].map(s => h('option', { value: s, selected: s === row.status ? true : null }, s)))),
        h('td', {}, h('input', {
          class: 'gm-inline-input', value: row.text,
          onchange: (e) => editRow('prd', row.id, since, { text: e.target.value }, setBody),
        }))))));
}

export async function MutablesEditor(setBody) {
  const r = await api('/api/mutables', { scoped: true });
  if (r.error) return Empty('Failed to load mutables: ' + r.error);
  if (!r.rows || !r.rows.length) return Empty('No mutable rows for this project.');
  const since = r.mtimeMs;
  return h('div', { class: 'ds-panel' }, h('h2', {}, `Mutables (${r.rows.length} rows)`),
    h('table', { class: 'gm-table' }, h('tr', {}, h('th', {}, 'id'), h('th', {}, 'status'), h('th', {}, 'witness')),
      ...r.rows.map(row => h('tr', { key: row.id, style: row.status === 'unknown' ? 'background:color-mix(in oklab, var(--flame,#f85149) 12%, transparent)' : null },
        h('td', {}, row.id),
        h('td', {}, Badge({ children: row.status, tone: row.status === 'unknown' ? 'danger' : (row.status === 'resolved' ? 'positive' : 'neutral') })),
        h('td', {}, h('input', {
          class: 'gm-inline-input', value: row.witness_evidence || '', placeholder: 'witness evidence...',
          onchange: (e) => editRow('mutables', row.id, since, { witness: e.target.value }, setBody),
        }))))));
}

// ---------------------------------------------------------------------------
// LIFECYCLE CONTROL
// ---------------------------------------------------------------------------
export async function LifecycleControl(setBody) {
  const [prd, mutables] = await Promise.all([api('/api/prd', { scoped: true }), api('/api/mutables', { scoped: true })]);
  const pending = (prd.rows || []).filter(r => r.status !== 'resolved').length;
  const unknown = (mutables.rows || []).filter(r => r.status === 'unknown').length;
  const act = async (verb, payload) => {
    const r = await apiPost('/api/lifecycle', { verb, payload }, { scoped: true });
    toast(r.status === 200 ? `Dispatched ${verb}` : `Dispatch failed: ${r.error || r.status}`, r.status !== 200);
  };
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Lifecycle Control'),
    StatsGrid({ items: [{ val: pending, lbl: 'PRD pending' }, { val: unknown, lbl: 'mutables unknown', cls: unknown ? 'err-rate' : '' }] }),
    h('div', { class: 'gm-toolbar', style: 'margin-top:12px' },
      Btn({ children: 'Transition', onClick: () => act('transition', {}) }),
      Btn({ children: 'Instruction', onClick: () => act('instruction', {}) }),
      Btn({ children: 'Residual Scan', onClick: () => act('residual-scan', {}) })));
}

// ---------------------------------------------------------------------------
// RS TOOLS
// ---------------------------------------------------------------------------
export async function RsTools() {
  const r = await api('/api/rs-tools', { scoped: true });
  if (r.error) return Empty('Failed to load rs-tools: ' + r.error);
  const rm = r.recallMisses || { total: 0, byQuery: [] };
  const rs = r.recallScores || { total: 0, histogram: [] };
  const modes = r.recallModes || { total: 0, modes: [] };
  const embed = r.embedFailures || { total: 0, byStep: [] };
  const rejects = r.classifierRejects || { total: 0, byReason: [] };
  const leverage = r.memoryLeverage || { rows: [] };
  const noData = !r.eventCount;
  if (noData) return Empty('No rs-learn events recorded for this project cwd yet.');
  return h('div', {},
    StatsGrid({ items: [
      { val: r.eventCount, lbl: 'events (this cwd)' },
      { val: rm.total, lbl: 'recall misses' },
      { val: rs.total, lbl: 'recall scores' },
      { val: embed.total, lbl: 'embed failures' },
      { val: rejects.total, lbl: 'classifier rejects' },
    ] }),
    h('div', { class: 'gm-flex-row', style: 'margin-top:12px' },
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Recall Score Histogram'),
        ...(rs.histogram.length ? rs.histogram.map(b => BarRow({ label: b.bucket, value: String(b.count), pct: rs.total ? Math.round(b.count / rs.total * 100) : 0 })) : [Empty('no scored recalls')])),
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Recall Modes'),
        ...(modes.modes.length ? modes.modes.map(m => BarRow({ label: m.mode, value: `${m.count} (${m.pct}%)`, pct: m.pct })) : [Empty('no recall-mode events')]))),
    h('div', { class: 'gm-flex-row', style: 'margin-top:12px' },
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Recall Misses by Query'),
        ...(rm.byQuery.length ? rm.byQuery.slice(0, 10).map(q => BarRow({ label: q.query.slice(0, 40), value: String(q.count) })) : [Empty('no misses')])),
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Classifier Rejects'),
        ...(rejects.byReason.length ? rejects.byReason.map(rr => BarRow({ label: rr.reason, value: String(rr.count) })) : [Empty('no rejects')]))),
    h('div', { class: 'ds-panel', style: 'margin-top:12px' }, h('h2', {}, 'Memory Leverage (7d)'),
      leverage.rows.length ? h('table', { class: 'gm-table' },
        h('tr', {}, h('th', {}, 'session'), h('th', {}, 'memorized'), h('th', {}, 'recalled back'), h('th', {}, 'leverage %')),
        ...leverage.rows.map((row, i) => h('tr', { key: i }, h('td', {}, row.sess), h('td', {}, String(row.memorized)), h('td', {}, String(row.recalled_back)), h('td', {}, row.leveragePct + '%'))))
        : Empty('no memorize/recall activity in the last 7 days')));
}

// ---------------------------------------------------------------------------
// CODESEARCH
// ---------------------------------------------------------------------------
const codesearchState = { q: '', hits: null, loading: false, error: null };
export function Codesearch(setBody) {
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Codesearch'),
    h('div', { class: 'gm-toolbar' },
      h('input', { placeholder: 'search code/symbols...', value: codesearchState.q, oninput: (e) => { codesearchState.q = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') runCodesearch(setBody); } }),
      Btn({ children: codesearchState.loading ? 'Searching...' : 'Search', disabled: codesearchState.loading, onClick: () => runCodesearch(setBody) })),
    codesearchState.error ? h('p', { style: 'color:var(--flame,#f85149)' }, codesearchState.error) : null,
    codesearchState.hits === null ? Empty('Enter a query and search.') :
      (!codesearchState.hits.length ? Empty('No hits.') :
        h('div', {}, ...codesearchState.hits.map((hit, i) => h('details', { key: i, class: 'ds-panel', style: 'margin:4px 0' },
          h('summary', { style: 'cursor:pointer' }, `${hit.file || '?'}:${hit.line || '?'}:${hit.name || ''} (score ${hit.score != null ? hit.score.toFixed?.(3) ?? hit.score : '?'})`),
          h('pre', { class: 'gm-json' }, hit.snippet || JSON.stringify(hit, null, 2))))))
  );
}
async function runCodesearch(setBody) {
  if (!codesearchState.q) return;
  codesearchState.loading = true; codesearchState.error = null; setBody();
  const r = await apiPost('/api/codesearch', { query: codesearchState.q }, { scoped: true });
  codesearchState.loading = false;
  if (r.status !== 200) { codesearchState.error = r.error || `HTTP ${r.status}`; setBody(); return; }
  codesearchState.hits = r.hits || [];
  setBody();
}

// ---------------------------------------------------------------------------
// LOCALIZED GM CALL CONSOLE
// ---------------------------------------------------------------------------
const KNOWN_VERBS = ['instruction', 'transition', 'prd-add', 'prd-resolve', 'mutable-add', 'mutable-resolve',
  'residual-scan', 'codesearch', 'recall', 'browser', 'exec_js', 'phase-status',
  'git_status', 'git_log', 'git_diff', 'git_show', 'git_branch', 'git_add', 'git_commit',
  'git_finalize', 'git_push', 'git_checkout', 'git_fetch', 'git_rm', 'git_revert', 'git_reset',
  'memorize-fire', 'memorize-prune'];
const consoleState = { verb: KNOWN_VERBS[0], payload: '{}', dispatched: null, polling: false, result: null };
export function GmCallConsole(setBody) {
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Localized GM Call Console'),
    h('div', { class: 'gm-toolbar' },
      h('select', { value: consoleState.verb, onchange: (e) => { consoleState.verb = e.target.value; } },
        ...KNOWN_VERBS.map(v => h('option', { value: v, selected: v === consoleState.verb ? true : null }, v))),
      Btn({ children: 'Dispatch', onClick: () => dispatchConsole(setBody) })),
    h('textarea', { class: 'gm-textarea', style: 'height:80px', oninput: (e) => { consoleState.payload = e.target.value; } }, consoleState.payload),
    consoleState.dispatched ? h('p', { style: 'color:var(--muted);font-size:11px' }, `Dispatched: ${consoleState.dispatched.verb} -> ${consoleState.dispatched.file || ''} ${consoleState.polling ? '(polling for response...)' : ''}`) : null,
    consoleState.result ? h('pre', { class: 'gm-json' }, JSON.stringify(consoleState.result, null, 2)) : Empty('No dispatch yet.'));
}
async function dispatchConsole(setBody) {
  let payload;
  try { payload = JSON.parse(consoleState.payload || '{}'); }
  catch (e) { toast('Invalid JSON payload: ' + e.message, true); return; }
  const r = await apiPost('/api/lifecycle', { verb: consoleState.verb, payload }, { scoped: true });
  if (r.status !== 200) { toast(`Dispatch failed: ${r.error || r.status}`, true); return; }
  consoleState.dispatched = r;
  consoleState.polling = true;
  consoleState.result = null;
  setBody();
  const file = (r.file || '').split(/[\\/]/).pop();
  const deadline = Date.now() + 10000;
  const poll = async () => {
    const resp = await api(`/api/lifecycle/response?verb=${encodeURIComponent(consoleState.verb)}&file=${encodeURIComponent(file)}`, { scoped: true });
    if (resp.ok) { consoleState.polling = false; consoleState.result = resp.response; setBody(); return; }
    if (Date.now() >= deadline) { consoleState.polling = false; consoleState.result = { error: 'timed out waiting for response', tried: file }; setBody(); return; }
    setTimeout(poll, 500);
  };
  poll();
}

// ---------------------------------------------------------------------------
// BROWSER SESSIONS
// ---------------------------------------------------------------------------
export async function BrowserSessions() {
  const r = await api('/api/browser-sessions', { scoped: true });
  if (r.error) return Empty('Failed to load browser sessions: ' + r.error);
  const sessions = Array.isArray(r.sessions) ? r.sessions : Object.entries(r.sessions || {}).map(([id, v]) => ({ id, ...(v || {}) }));
  const ports = Array.isArray(r.ports) ? r.ports : Object.entries(r.ports || {}).map(([id, v]) => ({ id, ...(v || {}) }));
  if (!r.sessionsFileFound && !r.portsFileFound) return Empty('No browser-sessions.json or browser-ports.json found for this project -- no browser verb has run yet.');
  return h('div', { class: 'gm-flex-row' },
    h('div', { class: 'ds-panel' }, h('h2', {}, `Sessions (${sessions.length})`),
      sessions.length ? h('table', { class: 'gm-table' },
        h('tr', {}, h('th', {}, 'id'), h('th', {}, 'alive'), h('th', {}, 'url'), h('th', {}, 'port')),
        ...sessions.map((s, i) => h('tr', { key: i }, h('td', {}, s.id || s.session_id || '?'), h('td', {}, s.alive ? Badge({ children: 'alive', tone: 'positive' }) : Badge({ children: 'dead', tone: 'neutral' })), h('td', {}, s.url || s.target_url || ''), h('td', {}, String(s.port || '')))))
        : Empty('No open browser sessions.')),
    h('div', { class: 'ds-panel' }, h('h2', {}, `Ports (${ports.length})`),
      ports.length ? h('table', { class: 'gm-table' },
        h('tr', {}, h('th', {}, 'id'), h('th', {}, 'port')),
        ...ports.map((p, i) => h('tr', { key: i }, h('td', {}, p.id), h('td', {}, String(p.port || '')))))
        : Empty('No registered browser ports.')));
}

// ---------------------------------------------------------------------------
// CONVERSATION HISTORY
// ---------------------------------------------------------------------------
export async function ConversationHistory(sess, sessList, onSelect) {
  const selector = h('select', { value: sess || '', onchange: (e) => onSelect(e.target.value) },
    h('option', { value: '' }, 'select session...'),
    ...(sessList || []).map(s => h('option', { value: s.sess, selected: s.sess === sess ? true : null }, `${s.sess.slice(0, 40)} -- ${fmtTs(s.last_ts)}`)));
  if (!sess) return h('div', { class: 'ds-panel' }, h('div', { class: 'gm-toolbar' }, selector), Empty('Select a session to view its dispatch timeline.'));
  const r = await api('/api/process-tree?sess=' + encodeURIComponent(sess));
  const entries = (r.nodes || []).filter(n => n.kind === 'instruction' || n.kind === 'transition' || n.kind === 'prd-add' || n.kind === 'prd-resolve' || n.kind === 'mutable-add' || n.kind === 'mutable-resolve');
  return h('div', { class: 'ds-panel' }, h('div', { class: 'gm-toolbar' }, selector), h('h2', {}, `Conversation timeline: ${sess}`),
    ...(entries.length ? entries.map((n, i) => h('div', { key: i, style: 'padding:6px 0;border-bottom:1px solid var(--border)' },
      h('span', { class: 'ts', style: 'margin-right:8px' }, fmtTs(n.ts)),
      h('strong', {}, n.kind), n.phase ? h('span', { class: 'gm-pill', style: 'margin-left:6px' }, n.phase) : null,
      n.id ? h('span', { class: 'gm-pill' }, n.id) : null))
      : [Empty('No dispatch events recorded for this session.')]));
}

// ---------------------------------------------------------------------------
// CODEINSIGHT VISUAL
// ---------------------------------------------------------------------------
export async function CodeInsightPanel() {
  const r = await api('/api/codeinsight', { scoped: true });
  if (r.error) return Empty('No .codeinsight file found for this project (codeinsight has not run yet).');
  const summary = r.summary || {};
  return h('div', {},
    StatsGrid({ items: [
      { val: summary.files ?? '?', lbl: 'files' }, { val: summary.lines ?? '?', lbl: 'lines' },
      { val: summary.functions ?? '?', lbl: 'functions' }, { val: summary.classes ?? '?', lbl: 'classes' },
      { val: summary.avgComplexity ?? '?', lbl: 'avg complexity' },
    ] }),
    h('div', { style: 'margin-top:12px' },
      ...((r.entries || []).length ? r.entries.map((entry, i) => h('details', { key: i, class: 'ds-panel', style: 'margin:4px 0' },
        h('summary', { style: 'cursor:pointer' }, entry.section), h('pre', { class: 'gm-json' }, entry.content)))
        : [Empty('No sectioned codeinsight data.')])));
}

// ---------------------------------------------------------------------------
// MEMORY GRAPH VISUAL
// ---------------------------------------------------------------------------
export async function MemoryGraphPanel() {
  const r = await api('/api/memory-graph', { scoped: true });
  if (r.error) return Empty('Failed to load memory graph: ' + r.error);
  if (!r.nodes || !r.nodes.length) return Empty(r.note || 'No memory nodes found for this project.');
  return h('div', {},
    r.note ? h('p', { style: 'color:var(--muted);font-size:11px;margin-bottom:8px' }, r.note) : null,
    h('div', { class: 'ds-panel' }, h('h2', {}, `Nodes (${r.nodes.length})`),
      h('div', {}, ...r.nodes.slice(0, 100).map((n, i) => h('span', {
        key: i, class: 'gm-graph-node', title: n.text,
      }, `${n.namespace}/${n.key.slice(0, 20)}`)))),
    h('div', { class: 'ds-panel', style: 'margin-top:12px' }, h('h2', {}, `Edges (${(r.edges || []).length})`),
      (r.edges || []).length ? h('table', { class: 'gm-table' },
        h('tr', {}, h('th', {}, 'src'), h('th', {}, 'relation'), h('th', {}, 'dst')),
        ...r.edges.slice(0, 100).map((e, i) => h('tr', { key: i }, h('td', {}, e.src), h('td', {}, e.relation), h('td', {}, e.dst))))
        : Empty('No graph edges available.')));
}
