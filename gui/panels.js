// All gmsniff panels, built from anentrypoint-design's webjsx factories
// (shell.js primitives + data-density.js dense widgets) plus small local
// gm-* CSS classes (gui-extra.css) for table/toolbar/query chrome the design
// system doesn't ship. Every panel returns a vnode tree; app.js re-renders
// the active panel's container on data load / SSE events / interval ticks.

import * as webjsx from 'webjsx';
import { Chip, Badge, Pill, Btn, Glyph } from 'ds/components/shell.js';
import { PhaseWalk, TreeNode, BarRow, StatTile, StatsGrid, SubGrid, SessionRow, DevRow, LiveLog } from 'ds/components/data-density.js';
import { TreeView, TreeItem, PropertyGrid, PropertyField, Dialog, JsonViewer } from 'ds/components/editor-primitives.js';
import { api, apiPost, esc, fmtTs, state, toast } from './data.js';
import { runForceLayout } from './forcegraph.js';

const h = webjsx.createElement;

// ---------------------------------------------------------------------------
// TOOLBAR primitive -- gmsniff has no dedicated ds Toolbar component; this
// is the same inline `.gm-toolbar` row already used by AllEvents/Search/
// SubsystemPanel/QueryPanel/Codesearch/GmCallConsole, factored into a small
// helper so panels that had NO toolbar (Sessions, Process Tree, Deviations,
// Live Stream) can add one with the same visual/behavioral shape.
// `actions` is an array of vnodes (buttons/inputs/chips) rendered left-to-right.
function Toolbar(...actions) {
  return h('div', { class: 'gm-toolbar' }, ...actions);
}

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

// Human-readable single-line sugar for an event payload: key=value pairs
// instead of raw JSON punctuation. Used for table-cell summaries and the
// live-stream preview (LiveLogEntry renders preview as plain text); expanded
// views render full highlighted JSON via the ds JsonViewer.
function kvPreview(obj, maxLen = 200) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    let sv;
    if (v == null) sv = String(v);
    else if (typeof v === 'object') { try { sv = JSON.stringify(v); } catch { sv = String(v); } }
    else sv = String(v);
    if (sv.length > 60) sv = sv.slice(0, 57) + '...';
    parts.push(k + '=' + sv);
    if (parts.join('  ').length >= maxLen) break;
  }
  const s = parts.join('  ');
  return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
}

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
  const exportBtn = Btn({
    children: 'Export',
    variant: 'ghost',
    onClick: () => {
      window.location.href = '/api/export?cwd=' + encodeURIComponent(state.cwd || '');
    },
  });
  return h('div', {},
    h('div', { class: 'gm-row-end' }, Toolbar(exportBtn)),
    h('div', { class: 'gm-mb-12' }, stats),
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
      h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Total'), ...SUB_LIST.map(s => h('th', { class: 'gm-sub-color', style: `--sub-color:${colorFor(s)}` }, s))),
      ...days.map(d => h('tr', { key: d.day }, h('td', {}, d.day), h('td', {}, String(d.total)),
        ...SUB_LIST.map(s => h('td', {}, String(d.bySub[s] || '')))))));
}

// ---------------------------------------------------------------------------
// LIVE STREAM
// ---------------------------------------------------------------------------
let liveEntries = [];
// Pause gates only the autoscroll-on-new-event behavior: paused events still
// append to liveEntries (so nothing is lost / the buffer stays complete),
// they just don't yank the view to the bottom, and liveNewCount tracks how
// many arrived while paused so the toolbar can show an "N new" indicator.
let livePaused = false;
let liveNewCount = 0;
// Multi-project filter: null = show every discovered project's events (the
// whole point of the system-wide fanout); a cwd string narrows to just that
// project, same set /api/projects returns so the dropdown always matches
// reality instead of a hand-maintained project list.
let liveProjectFilter = null;
// Monotonic, never-reused row key. `liveEntries.length` was used as the key previously, but
// that value freezes at 2000 the instant the buffer starts shifting (push then immediate shift
// nets a constant post-push length) -- every entry pushed after the first 2000 collided on the
// same key (2000), and webjsx's keyed applyDiff reconciles same-key nodes as in-place updates
// to ONE DOM node rather than distinct rows. Measured live under a real 2000+ event backlog:
// the log rendered only a handful of distinct rows (colliding keys collapsing thousands of
// pushes onto a few keyed nodes) while burning heavy diff/reflow cost repeatedly updating those
// same collided nodes in place -- the dominant real cause of observed LiveStream jank (fps~1)
// under load, distinct from and larger than the server-side discoverProjects/healthSummary
// costs fixed alongside this. A module-level counter that only ever increments removes the
// collision regardless of how many entries are ever pushed or shifted.
let liveEntrySeq = 0;
function projectBasename(cwd) {
  if (!cwd) return '(unknown)';
  return String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
}
// Debug accessor -- the module-level liveEntries/liveProjectFilter/liveEntrySeq state had no
// window.* exposure, so diagnosing a live-panel rendering anomaly required guessing from DOM
// snapshots alone. Read-only snapshot (never returns the live array/mutable references) so a
// caller can inspect but not corrupt push/shift ordering from the console.
export function liveStreamDebugSnapshot() {
  return {
    liveEntriesLength: liveEntries.length,
    liveEntrySeq,
    liveProjectFilter,
    livePaused,
    liveNewCount,
    lastEntries: liveEntries.slice(-5),
  };
}
export function pushLiveEntry(ev) {
  const payload = { ...ev };
  delete payload._sub; delete payload._day; delete payload._fp;
  liveEntries.push({ key: liveEntrySeq++, ts: fmtTs(ev.ts), sub: ev._sub, tone: colorFor(ev._sub || ''), event: ev.event || '?', preview: kvPreview(payload, 200), cwd: ev.cwd || null });
  if (liveEntries.length > 2000) liveEntries.shift();
  if (livePaused) liveNewCount++;
}
export function LiveStream({ connState = 'connecting' } = {}, setBody) {
  const toneMap = { live: 'positive', reconnecting: 'warn', connecting: 'neutral', closed: 'danger' };
  const pauseBtn = Btn({
    children: livePaused ? `Resume${liveNewCount ? ` (${liveNewCount} new)` : ''}` : 'Pause',
    variant: livePaused ? 'primary' : 'ghost',
    onClick: () => {
      livePaused = !livePaused;
      if (!livePaused) liveNewCount = 0; // resume snaps to bottom (autoScroll) and clears the indicator
      if (setBody) setBody();
    },
  });
  const cwds = [...new Set(liveEntries.map(e => e.cwd).filter(Boolean))].sort((a, b) => projectBasename(a).localeCompare(projectBasename(b)));
  const projectSelect = h('select', {
    value: liveProjectFilter || '',
    onchange: (e) => { liveProjectFilter = e.target.value || null; if (setBody) setBody(); },
  },
    h('option', { value: '' }, `all projects (${cwds.length})`),
    ...cwds.map(cwd => h('option', { key: cwd, value: cwd }, projectBasename(cwd))));
  const filtered = liveProjectFilter ? liveEntries.filter(e => e.cwd === liveProjectFilter) : liveEntries;
  const tagged = filtered.slice(-500).map(e => ({ ...e, sub: e.cwd ? `${projectBasename(e.cwd)}/${e.sub}` : e.sub }));
  return h('div', { class: 'ds-panel gm-p-8' },
    h('div', { class: 'gm-row-between' },
      h('h2', { class: 'gm-m-0' }, 'Live Stream'),
      h('div', { class: 'gm-row-gap-8' },
        Chip({ tone: toneMap[connState] || 'neutral', children: connState }),
        projectSelect,
        Toolbar(pauseBtn))),
    tagged.length ? LiveLog({ entries: tagged, autoScroll: !livePaused }) : Empty(liveProjectFilter ? 'No live events yet for this project.' : 'No live events received yet.'));
}

// ---------------------------------------------------------------------------
// ALL EVENTS / SEARCH / SUBSYSTEM (shared table renderer)
// ---------------------------------------------------------------------------
// Per-table-instance sort state, keyed by the caller-supplied tableId so
// AllEvents/SubsystemPanel/SessionDetailDialog/etc each remember their own
// current sort column/direction independently. Column key 'sub' addresses
// the synthetic leading badge column (r._sub), any other key addresses r[key].
const eventTableSortState = new Map();
function sortRows(rows, sortSpec) {
  if (!sortSpec || !sortSpec.key) return rows;
  const { key, dir } = sortSpec;
  const mul = dir === 'asc' ? 1 : -1;
  const valueOf = (r) => (key === 'sub' ? (r._sub || '') : r[key]);
  return [...rows].sort((a, b) => {
    const av = valueOf(a), bv = valueOf(b);
    if (av === undefined || av === null) return bv === undefined || bv === null ? 0 : mul;
    if (bv === undefined || bv === null) return -mul;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
}
export function renderEventTable(rows, tableId, setBody) {
  if (!rows || !rows.length) return Empty('No events.');
  const cols = new Set();
  for (const r of rows) Object.keys(r).forEach(k => { if (!k.startsWith('_')) cols.add(k); });
  const keys = [...cols];
  const display = ['ts', 'event', 'pid', ...keys.filter(k => !['ts', 'event', 'pid', '_sub', '_day', '_fp'].includes(k))];
  const sortable = !!(tableId && setBody);
  const sortSpec = sortable ? eventTableSortState.get(tableId) : null;
  const sortedRows = sortable ? sortRows(rows, sortSpec) : rows;
  const headerCell = (colKey, label) => {
    if (!sortable) return h('th', {}, label);
    const active = sortSpec && sortSpec.key === colKey;
    const dir = active ? sortSpec.dir : null;
    const indicator = active ? (dir === 'asc' ? ' ^' : ' v') : '';
    return h('th', {
      class: 'gm-th-sortable' + (active ? ' gm-th-sorted' : ''),
      role: 'button', tabindex: '0',
      'aria-sort': active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none',
      title: `sort by ${label}`,
      onclick: () => { toggleEventTableSort(tableId, colKey); setBody(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEventTableSort(tableId, colKey); setBody(); } },
    }, label + indicator);
  };
  return h('table', { class: 'gm-table' },
    h('tr', {}, headerCell('sub', 'sub'), ...display.map(k => headerCell(k, k))),
    ...sortedRows.map((r, i) => h('tr', { key: i },
      h('td', {}, Badge({ children: r._sub || '?', tone: 'neutral' })),
      ...display.map(k => {
        const v = r[k];
        if (v === undefined || v === null) return h('td', {});
        if (k === 'ts') return h('td', { class: 'ts' }, fmtTs(v));
        if (k === 'event') return h('td', {}, h('strong', {}, String(v)));
        if (typeof v === 'boolean') return h('td', {}, v ? Badge({ children: '[x]', tone: 'positive' }) : Badge({ children: '[ ]', tone: 'danger' }));
        if (typeof v === 'object') {
          const full = JSON.stringify(v);
          return h('td', {}, full.length > 80
            ? h('details', {}, h('summary', {}, kvPreview(v, 40) + '...'), JsonViewer({ value: v, mode: 'highlight', maxHeight: '260px' }))
            : kvPreview(v, 80));
        }
        const sv = String(v);
        return h('td', { title: sv.length > 120 ? sv : null }, sv.length > 120 ? sv.slice(0, 80) + '...' : sv);
      }))));
}
function toggleEventTableSort(tableId, colKey) {
  const cur = eventTableSortState.get(tableId);
  if (cur && cur.key === colKey) {
    eventTableSortState.set(tableId, { key: colKey, dir: cur.dir === 'asc' ? 'desc' : 'asc' });
  } else {
    eventTableSortState.set(tableId, { key: colKey, dir: 'asc' });
  }
}

// evTypes/days back the two dropdown filter selects; they change only when a
// new event-type or a new calendar day first appears in the log, never on a
// pagination click, a sort-header click, or a filter-text keystroke -- yet
// every one of those re-renders used to re-fetch both in full via Promise.all
// alongside the actual page data. Measured (playwright-driven timing against
// a real ~55k-event backlog): each AllEvents/SubsystemPanel re-render cost
// 60-120ms, almost entirely 3 concurrent round-trips where only 1 (the page
// of rows) actually needed to vary per-render. Caching the other two behind a
// short TTL cuts every pagination/sort/filter-text render down to the single
// real dependency, only re-fetching metadata occasionally in the background.
const META_CACHE_MS = 15000;
const evTypesDaysCache = { evTypes: null, days: null, fetchedAt: 0, sub: undefined };
async function fetchEvTypesAndDays(sub) {
  const c = evTypesDaysCache;
  const fresh = c.evTypes && c.days && c.sub === sub && (Date.now() - c.fetchedAt) < META_CACHE_MS;
  if (fresh) return { evTypes: c.evTypes, days: c.days };
  const [evTypes, days] = await Promise.all([
    api('/api/event-types' + (sub ? '?sub=' + encodeURIComponent(sub) : '')),
    api('/api/days'),
  ]);
  c.evTypes = evTypes; c.days = days; c.fetchedAt = Date.now(); c.sub = sub;
  return { evTypes, days };
}

const evPageState = { offset: 0, limit: 100, filters: {} };
export async function AllEvents(setBody) {
  const params = new URLSearchParams({ limit: evPageState.limit, offset: evPageState.offset });
  for (const [k, v] of Object.entries(evPageState.filters)) if (v) params.set(k, v);
  const [data, { evTypes, days }] = await Promise.all([
    api('/api/events?' + params, { scoped: false }),
    fetchEvTypesAndDays(),
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
    renderEventTable(data.rows, 'all-events', setBody),
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
    searchState.results.length ? renderEventTable(searchState.results, 'search-results', setBody) : Empty('No search performed yet.'));
}
async function runSearch(setBody) {
  const params = new URLSearchParams({ q: searchState.q });
  if (searchState.sub) params.set('sub', searchState.sub);
  const data = await api('/api/search?' + params);
  if (data.error) { toast(`Search failed: ${data.error}`, true); searchState.results = []; setBody(); return; }
  searchState.results = data.results || [];
  if (!searchState.results.length) toast(`No results for "${searchState.q}"`);
  else toast(`${searchState.results.length} result${searchState.results.length === 1 ? '' : 's'}`);
  setBody();
}

const subPageState = { current: null, offset: 0, limit: 100, filters: {} };
export async function SubsystemPanel(sub, setBody) {
  if (subPageState.current !== sub) { subPageState.current = sub; subPageState.offset = 0; subPageState.filters = {}; }
  const params = new URLSearchParams({ sub, limit: subPageState.limit, offset: subPageState.offset });
  for (const [k, v] of Object.entries(subPageState.filters)) if (v) params.set(k, v);
  const [data, { evTypes, days }] = await Promise.all([
    api('/api/subsystem?' + params),
    fetchEvTypesAndDays(sub),
  ]);
  const total = data.total || 0;
  return h('div', { class: 'ds-panel' }, h('h2', {}, sub),
    h('div', { class: 'gm-toolbar' },
      h('input', { placeholder: 'filter...', value: subPageState.filters.q || '', oninput: (e) => { subPageState.filters.q = e.target.value; subPageState.offset = 0; setBody(); } }),
      h('select', { onchange: (e) => { subPageState.filters.event = e.target.value; subPageState.offset = 0; setBody(); } },
        h('option', { value: '' }, 'all events'), ...(evTypes || []).map(e => h('option', { value: e.event }, e.event))),
      h('select', { onchange: (e) => { subPageState.filters.day = e.target.value; subPageState.offset = 0; setBody(); } },
        h('option', { value: '' }, 'all days'), ...(days || []).map(d => h('option', { value: d.day }, d.day)))),
    renderEventTable(data.rows, 'subsystem-' + sub, setBody),
    h('div', { class: 'gm-pager' },
      h('button', { disabled: subPageState.offset === 0 ? true : null, onclick: () => { subPageState.offset = Math.max(0, subPageState.offset - subPageState.limit); setBody(); } }, '<- prev'),
      h('span', {}, total ? `${subPageState.offset + 1}-${Math.min(subPageState.offset + subPageState.limit, total)} of ${total}` : '0 of 0'),
      h('button', { disabled: subPageState.offset + subPageState.limit >= total ? true : null, onclick: () => { subPageState.offset += subPageState.limit; setBody(); } }, 'next ->')));
}

// ---------------------------------------------------------------------------
// DEVIATIONS
// ---------------------------------------------------------------------------
const deviationsFilterState = { sessQuery: '' };
export async function Deviations(setBody) {
  const r = await api('/api/deviations?limit=200');
  if (r.error) return Empty('Failed to load deviations: ' + r.error);
  const q = (deviationsFilterState.sessQuery || '').trim().toLowerCase();
  // Client-side only: no new API call, filters the already-fetched arrays by
  // session-id substring match before rendering.
  const recentAll = r.recent || [];
  const recent = q ? recentAll.filter(e => String(e.sess || '').toLowerCase().includes(q)) : recentAll;
  const bySessionEntries = Object.entries(r.bySession || {});
  const bySessionFiltered = q ? bySessionEntries.filter(([s]) => s.toLowerCase().includes(q)) : bySessionEntries;
  const kindRows = Object.entries(r.byKind || {}).sort((a, b) => b[1] - a[1]);
  const sessRows = bySessionFiltered.sort((a, b) => b[1] - a[1]).slice(0, 15);
  const toolbar = Toolbar(
    h('input', {
      placeholder: 'filter by session id...', value: deviationsFilterState.sessQuery,
      oninput: (e) => { deviationsFilterState.sessQuery = e.target.value; if (setBody) setBody(); },
    }),
    q ? Btn({ children: 'Clear', variant: 'ghost', onClick: () => { deviationsFilterState.sessQuery = ''; if (setBody) setBody(); } }) : null,
  );
  return h('div', {},
    h('div', { class: 'ds-panel' }, toolbar),
    h('div', { class: 'gm-flex-row' },
      h('div', { class: 'ds-panel' }, h('h2', {}, 'By Deviation Kind'),
        ...(kindRows.length ? kindRows.map(([k, n]) => BarRow({ label: k, value: String(n), tone: 'var(--flame, #f85149)' })) : [Empty('No deviations recorded yet.')])),
      h('div', { class: 'ds-panel' }, h('h2', {}, 'By Session'),
        ...(sessRows.length ? sessRows.map(([s, n]) => BarRow({ label: s.slice(0, 60), value: String(n) })) : [Empty(q ? 'No sessions match filter.' : '-')]))),
    h('div', { class: 'ds-panel' }, h('h2', {}, `Recent Deviations (${recent.length}${q ? ` of ${r.total}` : ` / ${r.total}`})`),
      ...(recent.length ? recent.map((e, i) => DevRow({
        ts: fmtTs(e.ts), event: e.event, sess: (e.sess || '-').slice(0, 20), operation: e.operation,
        residuals: Array.isArray(e.residuals) ? e.residuals : (e.reason ? [e.reason] : []),
      })) : [Empty(q ? 'No deviations match filter.' : 'No deviations recorded -- agents are following the process.')])));
}

// ---------------------------------------------------------------------------
// SESSIONS / PROCESS TREE
// ---------------------------------------------------------------------------
const PHASES = ['PLAN', 'EXECUTE', 'EMIT', 'VERIFY', 'CONSOLIDATE', 'COMPLETE'];

// Session detail Dialog: focus-trapped modal (ds Dialog primitive) opened by
// clicking a SessionRow. Fetches the phase walk + full event list scoped to
// that session (GET /api/process-tree?sessionId=) and the deviations scoped
// to the same session (GET /api/deviations?sessionId=) -- both server-side
// filtered, not client-side slicing of the whole-project payload.
const sessionDetailState = { open: false, sess: null, loading: false, tree: null, deviations: null, error: null };

async function openSessionDetail(sess, setBody) {
  sessionDetailState.open = true;
  sessionDetailState.sess = sess;
  sessionDetailState.loading = true;
  sessionDetailState.tree = null;
  sessionDetailState.deviations = null;
  sessionDetailState.error = null;
  setBody();
  try {
    const [tree, deviations] = await Promise.all([
      api('/api/process-tree?sessionId=' + encodeURIComponent(sess)),
      api('/api/deviations?sessionId=' + encodeURIComponent(sess) + '&limit=200'),
    ]);
    if (tree.error || deviations.error) {
      sessionDetailState.error = tree.error || deviations.error;
      toast(`Failed to load session detail: ${sessionDetailState.error}`, true);
    } else {
      sessionDetailState.tree = tree;
      sessionDetailState.deviations = deviations;
    }
  } catch (e) {
    sessionDetailState.error = String(e && e.message || e);
    toast(`Failed to load session detail: ${sessionDetailState.error}`, true);
  }
  sessionDetailState.loading = false;
  setBody();
}

function closeSessionDetail(setBody) {
  sessionDetailState.open = false;
  sessionDetailState.sess = null;
  sessionDetailState.tree = null;
  sessionDetailState.deviations = null;
  sessionDetailState.error = null;
  setBody();
}

export function SessionDetailDialog(setBody) {
  const s = sessionDetailState;
  if (!s.open) return null;
  const devRows = (s.deviations && s.deviations.recent) || [];
  const body = s.loading
    ? Empty('Loading session detail...')
    : s.error
      ? h('p', { class: 'gm-text-danger' }, s.error)
      : h('div', {},
          PhaseWalk({ reached: s.tree && s.tree.phase_reached, gapKinds: ((s.tree && s.tree.gaps) || []).map(g => g.kind) }),
          h('h2', { class: 'gm-mt-10' }, `Events (${((s.tree && s.tree.nodes) || []).length})`),
          ((s.tree && s.tree.nodes) || []).length
            ? renderEventTable(s.tree.nodes, 'session-detail-' + (s.sess || ''), setBody)
            : Empty('No process events for this session.'),
          h('h2', { class: 'gm-mt-10' }, `Deviations (${(s.deviations && s.deviations.total) || 0})`),
          devRows.length
            ? h('div', {}, ...devRows.map((e, i) => DevRow({
                ts: fmtTs(e.ts), event: e.event, sess: (e.sess || '-').slice(0, 20), operation: e.operation,
                residuals: Array.isArray(e.residuals) ? e.residuals : (e.reason ? [e.reason] : []),
              })))
            : Empty('No deviations recorded for this session.'));
  return Dialog({
    title: `Session ${s.sess ? String(s.sess).slice(0, 40) : ''}`,
    open: true,
    dismissible: true,
    ariaLabel: 'Session detail',
    onClose: () => closeSessionDetail(setBody),
    actions: [{ label: 'Close', onClick: () => closeSessionDetail(setBody) }],
    children: body,
  });
}

export async function Sessions(onOpen, setBody) {
  // Refresh action re-invokes this exact same fetch (api('/api/sessions...'))
  // via the caller's setBody, then re-renders through the panel's existing
  // render path -- no new fetch abstraction, same convention every other
  // panel's toolbar Refresh already uses.
  const refreshToolbar = setBody ? Toolbar(Btn({ children: 'Refresh', variant: 'ghost', onClick: () => setBody(true) })) : null;
  const r = await api('/api/sessions?limit=200');
  if (r.error) return h('div', {}, refreshToolbar, Empty('Failed to load sessions: ' + r.error));
  if (!r.rows || !r.rows.length) return h('div', {}, refreshToolbar, Empty('No sessions recorded yet.'));
  return h('div', {}, h('div', { class: 'ds-panel' }, h('h2', {}, `Sessions (${r.total})`),
    refreshToolbar,
    ...r.rows.map(s => {
      const gaps = [];
      for (let i = 0; i < PHASES.length - 1; i++) if (s.phases_reached[i + 1] && !s.phases_reached[i]) gaps.push(PHASES[i]);
      return SessionRow({
        sessId: s.sess, events: s.events, verbs: s.dispatches, prd: `${s.prd_adds}/${s.prd_resolves}`,
        muts: `${s.mutable_adds}/${s.mutable_resolves}`, resid: `${s.residual_fires}f/${s.residual_skips}s`,
        deviations: s.deviations, firstTs: fmtTs(s.first_ts), lastTs: fmtTs(s.last_ts),
        phaseWalkProps: { reached: s.phases_reached, gapKinds: gaps },
        onClick: () => openSessionDetail(s.sess, () => setBody && setBody(true)),
      });
    })),
    SessionDetailDialog(() => setBody && setBody(true)));
}

// Hierarchical grouping: sess (root) -> phase (group) -> individual node rows.
// Every node carries `phase` (its parent-linking field on process-tree events);
// group id shape is stable across renders so the expanded-Set survives re-fetch.
function buildProcessTreeHierarchy(sess, nodes) {
  const groups = new Map(); // phase -> nodes[]
  for (const n of nodes) {
    const phase = n.phase || '(no phase)';
    if (!groups.has(phase)) groups.set(phase, []);
    groups.get(phase).push(n);
  }
  const PHASE_ORDER = ['PLAN', 'EXECUTE', 'EMIT', 'VERIFY', 'CONSOLIDATE', 'COMPLETE', '(no phase)'];
  const phaseKeys = [...groups.keys()].sort((a, b) => {
    const ia = PHASE_ORDER.indexOf(a), ib = PHASE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return {
    id: 'root:' + sess,
    label: sess,
    children: phaseKeys.map(phase => ({
      id: 'phase:' + sess + ':' + phase,
      label: phase,
      tag: `${groups.get(phase).length} events`,
      children: groups.get(phase).map((n, i) => ({
        id: 'node:' + sess + ':' + phase + ':' + i,
        label: n.kind + (n.id ? ' ' + n.id : '') + (n.deviation ? ' ' + n.deviation : ''),
        tag: fmtTs(n.ts),
        node: n,
        children: null,
      })),
    })),
  };
}

// Flatten to the currently-visible rows (root + expanded descendants only),
// depth-first, for roving-focus index math (Up/Down/Right/Left navigation).
function visibleTreeRows(root, expanded, depth = 0, out = []) {
  out.push({ item: root, depth });
  if (root.children && root.children.length && expanded.has(root.id)) {
    for (const c of root.children) visibleTreeRows(c, expanded, depth + 1, out);
  }
  return out;
}

const treeUiState = { expanded: new Set(), focusId: null };
export async function ProcessTree(sess, sessList, onSelect, onOpenSession, onRefresh) {
  const selector = h('select', {
    value: sess || '',
    onchange: (e) => onSelect(e.target.value),
  }, h('option', { value: '' }, 'select session...'),
    ...(sessList || []).map(s => h('option', { value: s.sess, selected: s.sess === sess ? true : null }, `${s.sess.slice(0, 40)} -- ${fmtTs(s.last_ts)} -- ${s.events}ev${s.deviations ? ' !' + s.deviations : ''}`)));
  // Refresh re-invokes the same api('/api/process-tree...') fetch below (via
  // the caller's onRefresh, which forces app.js's existing fetch-and-rerender
  // path) -- no new fetch abstraction.
  const refreshBtn = onRefresh ? Btn({ children: 'Refresh', variant: 'ghost', onClick: () => onRefresh(sess) }) : null;
  if (!sess) return h('div', { class: 'ds-panel' }, h('div', { class: 'gm-toolbar' }, selector, refreshBtn), Empty('Select a session.'));
  const r = await api('/api/process-tree?sess=' + encodeURIComponent(sess));
  const gapsBlock = (r.gaps && r.gaps.length)
    ? h('div', { class: 'ds-panel gm-panel-danger' }, h('h2', { class: 'gm-text-danger' }, 'Gaps detected'),
      ...r.gaps.map((g, i) => DevRow({ ts: fmtTs(g.ts), event: g.kind, operation: g.from ? `${g.from} -> ${g.to}` : (g.deviation || ''), residuals: g.detail ? [`first non-instruction event: ${g.detail.event} verb=${g.detail.verb || ''}`] : [] })))
    : null;

  const root = buildProcessTreeHierarchy(sess, r.nodes || []);
  // Collapsed by default below depth 1: root (depth 0) starts expanded so its
  // phase groups (depth 1) show; phase groups themselves start collapsed.
  if (!treeUiState.expanded.has(root.id) && !r._seeded) treeUiState.expanded.add(root.id);

  const rerender = () => { /* re-render is driven by caller's setBody via onSelect(sess) re-invoke path below */ renderTreePanelInPlace(); };
  // A local re-render hook: the caller (app.js) re-computes the whole body on
  // most actions, but expand/collapse must not require a network refetch --
  // stash a rerender callback the row handlers can call synchronously.
  let doRerender = () => {};

  function openSession(targetSess) {
    if (onOpenSession) onOpenSession(targetSess);
    else if (onSelect) onSelect(targetSess);
  }

  function renderNode(item, depth, visRows) {
    const hasKids = !!(item.children && item.children.length);
    const expanded = treeUiState.expanded.has(item.id);
    const isFocused = treeUiState.focusId === item.id;
    return TreeItem({
      label: item.label,
      tag: item.tag || null,
      depth,
      selected: isFocused,
      expanded,
      hasChildren: hasKids,
      onToggle: () => { if (expanded) treeUiState.expanded.delete(item.id); else treeUiState.expanded.add(item.id); treeUiState.focusId = item.id; doRerender(); },
      onSelect: () => {
        treeUiState.focusId = item.id;
        if (item.node && item.node.id) openSession(sess);
        else if (!hasKids && item.node) openSession(sess);
        else if (hasKids) { if (!expanded) treeUiState.expanded.add(item.id); else treeUiState.expanded.delete(item.id); }
        doRerender();
      },
      children: hasKids ? item.children.map(c => renderNode(c, depth + 1, visRows)) : null,
    });
  }

  function build() {
    if (!treeUiState.focusId) treeUiState.focusId = root.id;
    return h('div', { class: 'ds-panel' },
      h('div', { class: 'gm-toolbar' }, selector, refreshBtn),
      h('h2', {}, sess), PhaseWalk({ reached: r.phase_reached, gapKinds: [] }),
      gapsBlock,
      h('h2', { class: 'gm-mt-10' }, `Process Tree (${(r.nodes || []).length} events)`),
      (r.nodes || []).length
        ? TreeView({ children: [renderNode(root, 0, [])] })
        : Empty('No process events for this session.'));
  }

  // Re-render only this panel's container in place (no network refetch) so
  // expand/collapse and roving focus feel instant; falls back to full
  // computeBody() flow on next navigation since ui.bodyNode is recomputed there.
  function renderTreePanelInPlace() {
    const container = document.getElementById('panel-body');
    if (!container) return;
    import('webjsx').then(webjsx => {
      webjsx.applyDiff(container, h('main', { id: 'panel-body', class: 'gm-panel-body' }, build()));
    });
  }
  doRerender = renderTreePanelInPlace;

  return build();
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
    h('p', { class: 'gm-hint-text' },
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
  if (r.error) { queryState.result = h('p', { class: 'gm-text-danger' }, `${r.error}: ${r.detail || ''}`); setBody(); return; }
  if (r.groups) {
    const total = r.groups.reduce((s, g) => s + g.count, 0);
    queryState.result = h('div', {},
      h('p', { class: 'gm-hint-text' }, `grouped by ${r.groupBy.join(', ')} -- ${r.groups.length} groups -- ${total} rows (total: ${r.total})`),
      h('table', { class: 'gm-table' }, h('tr', {}, h('th', {}, 'group'), h('th', {}, 'count'), h('th', {}, 'sample')),
        ...r.groups.map((g, i) => h('tr', { key: i }, h('td', {}, h('strong', {}, g.key)), h('td', {}, String(g.count)), h('td', {}, JsonViewer({ value: g.sample[0] || {}, mode: 'highlight', maxHeight: '180px' }))))));
  } else {
    const rows = r.rows || [];
    queryState.result = rows.length ? h('div', {},
      h('p', { class: 'gm-hint-text' }, `${r.returned} of ${r.total} matching rows`),
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
      h('div', { class: 'gm-center-mt-14' },
        h('div', { class: 'ds-stat-val' + (hitPct < 50 ? ' err-rate' : '') }, hitPct + '%'),
        h('div', { class: 'gm-muted-12' }, 'hit rate'))),
    h('div', { class: 'ds-panel gm-flex-2' }, h('h2', {}, 'Recent Recalls'),
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
      h('h2', { class: 'gm-mt-12' }, 'By Runtime'),
      ...runtimes.map(([rt, n]) => BarRow({ label: rt, value: String(n), pct: r.total ? Math.round(n / r.total * 100) : 0 }))),
    h('div', { class: 'ds-panel gm-flex-2' }, h('h2', {}, 'Recent Spawns'),
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
      h('h2', { class: 'gm-mt-12' }, 'By Event'),
      ...evs.map(([ev, n]) => BarRow({ label: ev, value: String(n), pct: r.total ? Math.round(n / r.total * 100) : 0, tone: 'var(--purple,#bc8cff)' }))),
    h('div', { class: 'ds-panel gm-flex-2' }, h('h2', {}, 'Recent Hooks'),
      h('table', { class: 'gm-table' }, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Event'), h('th', {}, 'Phase'), h('th', {}, 'PID'), h('th', {}, 'ms')),
        ...(r.recent || []).map((e, i) => h('tr', { key: i }, h('td', {}, fmtTs(e.ts)), h('td', {}, Badge({ children: e.event || '?', tone: 'neutral' })), h('td', {}, e.phase || ''), h('td', {}, String(e.pid || '')), h('td', {}, String(e.dur_ms || '')))))));
}

// ---------------------------------------------------------------------------
// PRD EDITOR / MUTABLES EDITOR
// ---------------------------------------------------------------------------
const PRD_STATUSES = ['pending', 'in_progress', 'resolved', 'blocked'];
const MUTABLE_STATUSES = ['unknown', 'resolved'];
const fieldErrState = {}; // rowId:field -> error message, cleared per-field on successful commit

async function editRow(kind, id, since, fields, setBody, errKey) {
  const path = kind === 'prd' ? '/api/prd/edit' : '/api/mutables/edit';
  const r = await apiPost(path, { id, since, ...fields }, { scoped: true });
  if (r.status === 409) { toast(`Conflict: ${id} was modified since read (mtime ${r.mtimeMs}). Reloading.`, true); setBody(true); return; }
  if (r.status !== 200) { toast(`Edit failed: ${r.error || r.status}`, true); return; }
  if (errKey) delete fieldErrState[errKey];
  toast(`Saved ${id}`); setBody(true);
}

// Validates a field value before firing the network commit; returns an error
// string (shown via PropertyField's hint slot) or null when the value is valid.
export function validatePrdField(field, value) {
  if (field === 'text' && !String(value || '').trim()) return 'text is required';
  if (field === 'status' && !PRD_STATUSES.includes(value)) return `status must be one of: ${PRD_STATUSES.join(', ')}`;
  return null;
}
export function validateMutableField(field, value) {
  if (field === 'status' && !MUTABLE_STATUSES.includes(value)) return `status must be one of: ${MUTABLE_STATUSES.join(', ')}`;
  if (field === 'witness' && value != null && String(value).trim() === '' && value !== '') return 'witness evidence cannot be blank once started';
  return null;
}

// Exported so the Ctrl+K command palette can commit a PRD/mutable field edit
// through the identical validate-then-POST /api/{prd,mutables}/edit path the
// PRD/Mutables Editor panels' inline inputs use.
export function commitField(kind, row, field, value, since, setBody, validate) {
  const errKey = `${kind}:${row.id}:${field}`;
  const err = validate(field, value);
  if (err) { fieldErrState[errKey] = err; setBody(); return; }
  delete fieldErrState[errKey];
  editRow(kind, row.id, since, { [field]: value }, setBody, errKey);
}

// severity is a real but minority field in gm's own live prd.yml (~0.5% of rows) --
// no fixed vocabulary is enforced upstream (free-text scalar), so tone mapping only
// special-cases the values actually witnessed (critical/high/medium/low) and falls
// back to neutral for anything else rather than guessing at unseen spellings.
const SEVERITY_TONE = { critical: 'danger', high: 'danger', medium: 'neutral', low: 'positive' };

export async function PrdEditor(setBody) {
  const r = await api('/api/prd', { scoped: true });
  if (r.error) return Empty('Failed to load PRD: ' + r.error);
  if (!r.rows || !r.rows.length) return Empty('No PRD rows for this project.');
  const since = r.mtimeMs;
  return h('div', { class: 'ds-panel' }, h('h2', {}, `PRD (${r.rows.length} rows)`),
    ...r.rows.map(row => {
      const statusErr = fieldErrState[`prd:${row.id}:status`];
      const textErr = fieldErrState[`prd:${row.id}:text`];
      return h('div', { key: row.id, class: 'gm-propgrid-row' },
        PropertyGrid({ children: [
          PropertyField({ label: 'id', inline: true, children: h('span', { class: 'gm-inline-input gm-opacity-70' }, row.id) }),
          PropertyField({ label: 'status', hint: statusErr || null, children: h('select', {
            value: row.status,
            class: statusErr ? 'gm-field-error' : '',
            onchange: (e) => commitField('prd', row, 'status', e.target.value, since, setBody, validatePrdField),
          }, ...PRD_STATUSES.map(s => h('option', { value: s, selected: s === row.status ? true : null }, s))) }),
          PropertyField({ label: 'text', hint: textErr || null, children: h('input', {
            class: 'gm-inline-input' + (textErr ? ' gm-field-error' : ''), value: row.text,
            onchange: (e) => commitField('prd', row, 'text', e.target.value, since, setBody, validatePrdField),
          }) }),
          ...(row.severity ? [PropertyField({ label: 'severity', inline: true, children: Badge({ children: row.severity, tone: SEVERITY_TONE[row.severity] || 'neutral' }) })] : []),
          ...(row.tags && row.tags.length ? [PropertyField({ label: 'tags', inline: true, children: h('span', {}, ...row.tags.map(t => Pill({ key: t, tone: 'accent', children: t }))) })] : []),
        ] }));
    }));
}

export async function MutablesEditor(setBody) {
  const r = await api('/api/mutables', { scoped: true });
  if (r.error) return Empty('Failed to load mutables: ' + r.error);
  if (!r.rows || !r.rows.length) return Empty('No mutable rows for this project.');
  const since = r.mtimeMs;
  return h('div', { class: 'ds-panel' }, h('h2', {}, `Mutables (${r.rows.length} rows)`),
    ...r.rows.map(row => {
      const statusErr = fieldErrState[`mutables:${row.id}:status`];
      const witnessErr = fieldErrState[`mutables:${row.id}:witness`];
      return h('div', {
        key: row.id, class: 'gm-propgrid-row' + (row.status === 'unknown' ? ' gm-row-danger-tint' : ''),
      },
        PropertyGrid({ children: [
          PropertyField({ label: 'id', inline: true, children: h('span', { class: 'gm-inline-input gm-opacity-70' }, row.id) }),
          PropertyField({ label: 'status', hint: statusErr || null, children: h('span', {}, Badge({ children: row.status, tone: row.status === 'unknown' ? 'danger' : (row.status === 'resolved' ? 'positive' : 'neutral') })) }),
          PropertyField({ label: 'witness', hint: witnessErr || null, children: h('input', {
            class: 'gm-inline-input' + (witnessErr ? ' gm-field-error' : ''), value: row.witness_evidence || '', placeholder: 'witness evidence...',
            onchange: (e) => commitField('mutables', row, 'witness', e.target.value, since, setBody, validateMutableField),
          }) }),
        ] }));
    }));
}

// ---------------------------------------------------------------------------
// LIFECYCLE CONTROL
// ---------------------------------------------------------------------------
// Exported so the Ctrl+K command palette (app.js) can invoke the exact same
// dispatch the Lifecycle Control panel's buttons call -- one handler, two
// entry points, no click-simulation.
export async function lifecycleAct(verb, payload) {
  const r = await apiPost('/api/lifecycle', { verb, payload }, { scoped: true });
  toast(r.status === 200 ? `Dispatched ${verb}` : `Dispatch failed: ${r.error || r.status}`, r.status !== 200);
  return r;
}

export async function LifecycleControl(setBody) {
  const [prd, mutables] = await Promise.all([api('/api/prd', { scoped: true }), api('/api/mutables', { scoped: true })]);
  if (prd.error || mutables.error) return Empty('Failed to load lifecycle state: ' + (prd.error || mutables.error));
  const pending = (prd.rows || []).filter(r => r.status !== 'resolved').length;
  const unknown = (mutables.rows || []).filter(r => r.status === 'unknown').length;
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Lifecycle Control'),
    StatsGrid({ items: [{ val: pending, lbl: 'PRD pending' }, { val: unknown, lbl: 'mutables unknown', cls: unknown ? 'err-rate' : '' }] }),
    h('div', { class: 'gm-toolbar gm-mt-12' },
      Btn({ children: 'Transition', onClick: () => lifecycleAct('transition', {}) }),
      Btn({ children: 'Instruction', onClick: () => lifecycleAct('instruction', {}) }),
      Btn({ children: 'Residual Scan', onClick: () => lifecycleAct('residual-scan', {}) })));
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
    h('div', { class: 'gm-flex-row gm-mt-12' },
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Recall Score Histogram'),
        ...(rs.histogram.length ? rs.histogram.map(b => BarRow({ label: b.bucket, value: String(b.count), pct: rs.total ? Math.round(b.count / rs.total * 100) : 0 })) : [Empty('no scored recalls')])),
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Recall Modes'),
        ...(modes.modes.length ? modes.modes.map(m => BarRow({ label: m.mode, value: `${m.count} (${m.pct}%)`, pct: m.pct })) : [Empty('no recall-mode events')]))),
    h('div', { class: 'gm-flex-row gm-mt-12' },
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Recall Misses by Query'),
        ...(rm.byQuery.length ? rm.byQuery.slice(0, 10).map(q => BarRow({ label: q.query.slice(0, 40), value: String(q.count) })) : [Empty('no misses')])),
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Classifier Rejects'),
        ...(rejects.byReason.length ? rejects.byReason.map(rr => BarRow({ label: rr.reason, value: String(rr.count) })) : [Empty('no rejects')]))),
    h('div', { class: 'ds-panel gm-mt-12' }, h('h2', {}, 'Memory Leverage (7d)'),
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
    codesearchState.error ? h('p', { class: 'gm-text-danger' }, codesearchState.error) : null,
    codesearchState.hits === null ? Empty('Enter a query and search.') :
      (!codesearchState.hits.length ? Empty('No hits.') :
        h('div', {}, ...codesearchState.hits.map((hit, i) => h('details', { key: i, class: 'ds-panel gm-my-4' },
          h('summary', { class: 'gm-cursor-pointer' }, `${hit.file || '?'}:${hit.line || '?'}:${hit.name || ''} (score ${hit.score != null ? hit.score.toFixed?.(3) ?? hit.score : '?'})`),
          hit.snippet ? h('pre', { class: 'gm-json' }, hit.snippet) : JsonViewer({ value: hit, mode: 'highlight', maxHeight: '260px' })))))
  );
}
// Exported so the Ctrl+K command palette can trigger the exact same search
// path as the Search panel's "Search" button, reusing codesearchState/setBody.
export async function runCodesearch(setBody) {
  if (!codesearchState.q) return;
  codesearchState.loading = true; codesearchState.error = null; setBody();
  const r = await apiPost('/api/codesearch', { query: codesearchState.q }, { scoped: true });
  codesearchState.loading = false;
  if (r.status !== 200) {
    codesearchState.error = r.error || `HTTP ${r.status}`;
    toast(`Codesearch failed: ${codesearchState.error}`, true);
    setBody();
    return;
  }
  codesearchState.hits = r.hits || [];
  if (!codesearchState.hits.length) toast(`No hits for "${codesearchState.q}"`);
  else toast(`${codesearchState.hits.length} hit${codesearchState.hits.length === 1 ? '' : 's'}`);
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
    h('textarea', { class: 'gm-textarea gm-h-80', oninput: (e) => { consoleState.payload = e.target.value; } }, consoleState.payload),
    consoleState.dispatched ? h('p', { class: 'gm-muted-11' }, `Dispatched: ${consoleState.dispatched.verb} -> ${consoleState.dispatched.file || ''} ${consoleState.polling ? '(polling for response...)' : ''}`) : null,
    consoleState.result ? JsonViewer({ value: consoleState.result, mode: 'tree', copyable: true, maxHeight: '420px' }) : Empty('No dispatch yet.'));
}
// Exported so the Ctrl+K command palette can fire the exact same dispatch
// as the GM Call Console's "Dispatch" button (same consoleState, same poll).
export async function dispatchConsole(setBody) {
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
    ...(entries.length ? entries.map((n, i) => h('div', { key: i, class: 'gm-list-row' },
      h('span', { class: 'ts gm-mr-8' }, fmtTs(n.ts)),
      h('strong', {}, n.kind), n.phase ? h('span', { class: 'gm-pill gm-ml-6' }, n.phase) : null,
      n.id ? h('span', { class: 'gm-pill' }, n.id) : null))
      : [Empty('No dispatch events recorded for this session.')]));
}

// ---------------------------------------------------------------------------
// CODEINSIGHT VISUAL -- squarified treemap of per-file size/complexity
// ---------------------------------------------------------------------------

// Squarified treemap layout: recursively slices the remaining rect, always
// placing the next run of items along whichever axis keeps aspect ratios
// closest to square. Pure function, no DOM/state -- items: [{name,size,
// complexity,...}], returns [{name,complexity,x,y,w,h}].
function treemap(items, x, y, w, h) {
  const out = [];
  const worstRatio = (row, len) => {
    if (!row.length) return Infinity;
    let sum = 0, max = -Infinity, min = Infinity;
    for (const it of row) { sum += it._sz; if (it._sz > max) max = it._sz; if (it._sz < min) min = it._sz; }
    const sideSq = (len * len) / (sum * sum);
    return Math.max(sideSq * max, min > 0 ? 1 / (sideSq * min) : Infinity);
  };
  const layoutRow = (row, rx, ry, rw, rh, vertical) => {
    const areaSum = row.reduce((s, it) => s + it._sz, 0);
    if (areaSum <= 0 || !row.length) return { rx, ry, rw, rh };
    if (vertical) {
      const bandW = rh > 0 ? areaSum / rh : 0;
      let cy = ry;
      for (const it of row) {
        const itH = bandW > 0 ? it._sz / bandW : 0;
        out.push({ name: it.name, complexity: it.complexity, x: rx, y: cy, w: bandW, h: itH });
        cy += itH;
      }
      return { rx: rx + bandW, ry, rw: rw - bandW, rh };
    } else {
      const bandH = rw > 0 ? areaSum / rw : 0;
      let cx = rx;
      for (const it of row) {
        const itW = bandH > 0 ? it._sz / bandH : 0;
        out.push({ name: it.name, complexity: it.complexity, x: cx, y: ry, w: itW, h: bandH });
        cx += itW;
      }
      return { rx, ry: ry + bandH, rw, rh: rh - bandH };
    }
  };
  const squarify = (queue, rx, ry, rw, rh) => {
    if (!queue.length || rw <= 0 || rh <= 0) return;
    const short = Math.min(rw, rh);
    let row = [];
    let i = 0;
    while (i < queue.length) {
      const candidate = [...row, queue[i]];
      if (row.length === 0 || worstRatio(candidate, short) <= worstRatio(row, short)) {
        row = candidate; i++;
      } else break;
    }
    const remaining = queue.slice(i);
    const vertical = rw >= rh;
    const rest = layoutRow(row, rx, ry, rw, rh, vertical);
    squarify(remaining, rest.rx, rest.ry, rest.rw, rest.rh);
  };
  const total = items.reduce((s, it) => s + Math.max(it.size || 0, 0.0001), 0);
  const scaled = items.map(it => ({ ...it, _sz: total > 0 ? (Math.max(it.size || 0, 0.0001) / total) * (w * h) : 0 }));
  squarify(scaled, x, y, w, h);
  return out;
}

// Green (low complexity) -> red (high complexity), linear-interpolated over
// the observed [min,max] range of this project's items (falls back to a
// fixed mid-scale point when every item has identical complexity).
function complexityColor(val, min, max) {
  const span = max - min;
  const t = span > 0 ? Math.max(0, Math.min(1, (val - min) / span)) : 0.3;
  const r = Math.round(60 + t * (210 - 60));
  const g = Math.round(180 - t * (180 - 50));
  const b = 60;
  return `rgb(${r},${g},${b})`;
}

const codeInsightUi = { selected: null };

export async function CodeInsightPanel(setBody) {
  const r = await api('/api/codeinsight', { scoped: true });
  if (r.error) return Empty('No .codeinsight file found for this project (codeinsight has not run yet).');
  const summary = r.summary || {};
  const items = r.items || [];
  const complexities = items.map(it => it.complexity || 0);
  const minC = complexities.length ? Math.min(...complexities) : 0;
  const maxC = complexities.length ? Math.max(...complexities) : 1;
  const W = 900, H = 420;
  const rects = items.length ? treemap(items, 0, 0, W, H) : [];
  const byName = new Map(items.map(it => [it.name, it]));
  const selected = codeInsightUi.selected ? byName.get(codeInsightUi.selected) : null;

  const select = (name) => { codeInsightUi.selected = codeInsightUi.selected === name ? null : name; if (setBody) setBody(); };

  return h('div', {},
    StatsGrid({ items: [
      { val: summary.files ?? '?', lbl: 'files' }, { val: summary.lines ?? '?', lbl: 'lines' },
      { val: summary.functions ?? '?', lbl: 'functions' }, { val: summary.classes ?? '?', lbl: 'classes' },
      { val: summary.avgComplexity ?? '?', lbl: 'avg complexity' },
    ] }),
    h('div', { class: 'ds-panel gm-mt-12' },
      h('h2', {}, `File-size treemap (${items.length} file${items.length === 1 ? '' : 's'})`),
      !items.length ? Empty('No per-file size/complexity data extracted from .codeinsight.') :
      h('div', { class: 'gm-treemap-container', style: `--tm-w:${W}px;--tm-h:${H}px` },
        ...rects.map((rect, i) => {
          const fits = rect.w > 28 && rect.h > 16;
          const isSel = codeInsightUi.selected === rect.name;
          return h('div', {
            key: i,
            class: 'gm-treemap-rect',
            title: `${rect.name} -- complexity ${rect.complexity}`,
            onclick: () => select(rect.name),
            style: `--rx:${rect.x}px;--ry:${rect.y}px;--rw:${Math.max(rect.w - 1, 0)}px;--rh:${Math.max(rect.h - 1, 0)}px;` +
              `--rect-bg:${complexityColor(rect.complexity, minC, maxC)};--rect-border:${isSel ? 'var(--accent, #58a6ff)' : 'rgba(0,0,0,0.25)'};`,
          }, fits ? (rect.name.length > Math.floor(rect.w / 6) ? rect.name.slice(0, Math.max(1, Math.floor(rect.w / 6) - 1)) + '...' : rect.name) : null);
        }))),
    selected ? h('div', { class: 'ds-panel gm-mt-12' },
      h('h2', {}, `Detail: ${selected.name}`),
      JsonViewer({ value: selected, mode: 'highlight', copyable: true }))
      : null,
    h('div', { class: 'gm-mt-12' },
      ...((r.entries || []).length ? r.entries.map((entry, i) => h('details', { key: i, class: 'ds-panel gm-my-4' },
        h('summary', { class: 'gm-cursor-pointer' }, entry.section), h('pre', { class: 'gm-json' }, entry.content)))
        : [Empty('No sectioned codeinsight data.')])));
}

// ---------------------------------------------------------------------------
// MEMORY GRAPH VISUAL -- force-directed SVG (no new deps; runForceLayout in
// forcegraph.js drives node.x/node.y each rAF tick, this module only paints).
// ---------------------------------------------------------------------------
const NODE_R_MIN = 6, NODE_R_MAX = 10;
const graphUiState = { handle: null, selectedId: null };

export function stopMemoryGraphLayout() {
  if (graphUiState.handle) { graphUiState.handle.stop(); graphUiState.handle = null; }
}

// API payload is {nodes:[{key,text,namespace,mtime}], edges:[{id,src,dst,relation,weight,created_at}]}
// (never changed here) -- normalize to the id/source/target shape runForceLayout expects.
function toGraphModel(r) {
  const nodes = (r.nodes || []).slice(0, 150).map(n => ({
    id: n.key, label: `${n.namespace}/${n.key}`.slice(0, 28), namespace: n.namespace, text: n.text,
  }));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = (r.edges || []).filter(e => nodeIds.has(e.src) && nodeIds.has(e.dst))
    .map(e => ({ source: e.src, target: e.dst, relation: e.relation }));
  return { nodes, edges };
}

function neighborSet(edges, id) {
  const s = new Set([id]);
  for (const e of edges) {
    if (e.source === id) s.add(e.target);
    if (e.target === id) s.add(e.source);
  }
  return s;
}

export async function MemoryGraphPanel() {
  stopMemoryGraphLayout();
  const r = await api('/api/memory-graph', { scoped: true });
  if (r.error) return Empty('Failed to load memory graph: ' + r.error);
  if (!r.nodes || !r.nodes.length) return Empty(r.note || 'No memory nodes found for this project.');

  const { nodes, edges } = toGraphModel(r);
  const width = 900, height = 520;
  graphUiState.selectedId = null;

  const container = h('div', { class: 'ds-panel' },
    r.note ? h('p', { class: 'gm-hint-text' }, r.note) : null,
    h('h2', {}, `Memory Graph -- ${nodes.length} nodes, ${edges.length} edges`),
    h('svg', {
      class: 'gm-force-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet',
      id: 'memory-graph-svg',
    }));

  // Defer the live simulation + SVG paint to right after mount: app.js's
  // renderShell() does one synchronous applyDiff, so schedule on next tick
  // once the <svg id="memory-graph-svg"> node actually exists in the DOM.
  setTimeout(() => mountForceGraph(nodes, edges, width, height), 0);

  return container;
}

function mountForceGraph(nodes, edges, width, height) {
  const svg = document.getElementById('memory-graph-svg');
  if (!svg) return; // panel navigated away before mount fired

  let dragging = null; // {node, offsetX, offsetY}

  function paint() {
    if (!document.getElementById('memory-graph-svg')) { stopMemoryGraphLayout(); return; }
    const sel = graphUiState.selectedId;
    const neighbors = sel ? neighborSet(edges, sel) : null;

    const svgNS = 'http://www.w3.org/2000/svg';
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const edgeGroup = document.createElementNS(svgNS, 'g');
    for (const e of edges) {
      const a = nodes.find(n => n.id === e.source), b = nodes.find(n => n.id === e.target);
      if (!a || !b) continue;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      let cls = 'gm-force-edge';
      if (sel) cls += (neighbors.has(a.id) && neighbors.has(b.id)) ? ' hi' : ' dim';
      line.setAttribute('class', cls);
      edgeGroup.appendChild(line);
    }
    svg.appendChild(edgeGroup);

    const nodeGroup = document.createElementNS(svgNS, 'g');
    for (const n of nodes) {
      const g = document.createElementNS(svgNS, 'g');
      let cls = 'gm-force-node';
      if (sel) cls += (n.id === sel) ? ' hi' : (neighbors.has(n.id) ? '' : ' dim');
      if (dragging && dragging.node === n) cls += ' dragging';
      g.setAttribute('class', cls);

      const r = NODE_R_MIN + Math.min(4, (n.label.length % 5));
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', n.x); circle.setAttribute('cy', n.y); circle.setAttribute('r', r);
      circle.setAttribute('fill', colorFor(n.namespace || 'default'));
      circle.setAttribute('title', n.text || n.label);

      circle.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        n.pinned = true; n.vx = 0; n.vy = 0;
        const pt = svgPoint(svg, ev);
        dragging = { node: n, offsetX: pt.x - n.x, offsetY: pt.y - n.y };
        try { circle.setPointerCapture(ev.pointerId); } catch (_) {}
      });
      circle.addEventListener('pointermove', (ev) => {
        if (!dragging || dragging.node !== n) return;
        const pt = svgPoint(svg, ev);
        n.x = pt.x - dragging.offsetX; n.y = pt.y - dragging.offsetY;
        paint();
      });
      const endDrag = () => {
        if (dragging && dragging.node === n) { n.pinned = false; dragging = null; paint(); }
      };
      circle.addEventListener('pointerup', endDrag);
      circle.addEventListener('pointercancel', endDrag);
      circle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        graphUiState.selectedId = (graphUiState.selectedId === n.id) ? null : n.id;
        paint();
      });

      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', n.x + r + 3); text.setAttribute('y', n.y + 3);
      text.textContent = n.label;

      g.appendChild(circle); g.appendChild(text);
      nodeGroup.appendChild(g);
    }
    svg.appendChild(nodeGroup);
  }

  svg.addEventListener('click', () => { if (graphUiState.selectedId) { graphUiState.selectedId = null; paint(); } });

  graphUiState.handle = runForceLayout(nodes, edges, { width, height, onTick: paint });
  paint();
}

function svgPoint(svg, ev) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const scaleX = vb.width / rect.width, scaleY = vb.height / rect.height;
  return { x: (ev.clientX - rect.left) * scaleX, y: (ev.clientY - rect.top) * scaleY };
}
