// Event-stream panels: the fleet dashboard, per-day rollup, the live stream
// buffer, and the paged/sortable event tables every subsystem view reuses.
import { JsonViewer, Pager } from 'ds/components/editor-primitives.js';
import { api, fmtTs, state } from './data.js';
import { basename, mergeObservedSubsystems, subsystemList } from './shared.js';
import { BarRow, LiveLog, StatsGrid } from 'ds/components/data-density.js';
import { Badge, Btn, Chip } from 'ds/components/shell.js';
import { ELLIPSIS, Empty, Failed, TOP_ROWS_SHOWN, Toolbar, asKeyValueLine, colorFor, h } from './panels-internals.js';
export async function Dashboard({ onNav, devTotal, health } = {}) {
  const snap = await api('/api/snapshot');
  if (snap.error) return Empty('Failed to load snapshot: ' + snap.error);
  if (Array.isArray(snap.observedSubsystems) && snap.observedSubsystems.length) {
    mergeObservedSubsystems(snap.observedSubsystems);
  }
  const healthByCwd = new Map((health || []).map(r => [r.cwd, r]));
  // "Projects now" used to be a second live roster here, ordered by discovery and
  // keyed on /api/projects' `alive`. That flag is the SHARED DAEMON's liveness --
  // one agentplug-runner serving every project -- so it read near-uniformly true
  // and said nothing about whether any individual project was working. Live Agents
  // judges per-project activity, ranks by what needs attention and states the
  // reason, so this panel now points at it rather than competing with a weaker
  // answer to the same question. The PRD/mutable pressure that was this table's
  // own contribution stays, as a whole-fleet total nothing else on this page gives.
  const projectsWithPendingPrd = state.projects.filter(p => p.prd_pending > 0);
  const fleetPrdPending = state.projects.reduce((n, p) => n + (p.prd_pending || 0), 0);
  const fleetMutUnknown = state.projects.reduce((n, p) => n + (p.mut_unknown || 0), 0);
  const fleetDeviationRate = (health || []).reduce((n, r) => n + (r.deviationRate || 0), 0);
  const projPanel = h('div', { class: 'ds-panel' }, h('h2', {}, 'Fleet totals'),
    state.projects.length
      ? h('div', {},
          StatsGrid({ items: [
            { val: state.projects.length, lbl: 'projects discovered' },
            { val: projectsWithPendingPrd.length, lbl: 'with PRD rows pending' },
            { val: fleetPrdPending, lbl: 'PRD rows pending (all projects)' },
            { val: fleetMutUnknown, lbl: 'mutables unknown', cls: fleetMutUnknown ? 'err-rate' : '' },
            { val: fleetDeviationRate.toFixed(2) + '/min', lbl: 'deviation rate (health-reported)' },
          ] }),
          h('p', { class: 'gm-muted-11 gm-mt-8' },
            'Per-agent phase, served instruction and elapsed-in-phase live in Live Agents, which judges activity per project rather than from the shared daemon flag.'),
          Toolbar(Btn({ children: 'Open Live Agents', onClick: () => onNav && onNav('agents') })))
      : Empty('No projects discovered yet.'));
  const quickLinks = Toolbar(
    Btn({ children: 'Live Stream', onClick: () => onNav && onNav('live') }),
    Btn({ children: devTotal ? `Deviations (${devTotal})` : 'Deviations', onClick: () => onNav && onNav('deviations') }),
    Btn({ children: 'Sessions', onClick: () => onNav && onNav('sessions') }),
  );
  const stats = StatsGrid({
    items: [
      { val: snap.total ?? 0, lbl: 'total events' },
      { val: snap.pids ?? 0, lbl: 'sessions' },
      { val: snap.errors ?? 0, lbl: 'errors', cls: snap.errors ? 'err-rate' : '' },
      { val: Object.keys(snap.byDay || {}).length, lbl: 'days' },
    ],
  });
  const bySub = snap.bySub || {};
  const subRows = subsystemList().map(s => {
    const n = bySub[s] || 0;
    const pct = snap.total ? Math.round(n / snap.total * 100) : 0;
    return BarRow({ label: s, value: String(n), pct, tone: colorFor(s) });
  });
  const evRanked = Object.entries(snap.byEvent || {}).sort((a, b) => b[1] - a[1]);
  const evSorted = evRanked.slice(0, TOP_ROWS_SHOWN);
  const evOmitted = evRanked.length - evSorted.length;
  const evRows = evSorted.length
    ? [
      ...evSorted.map(([ev, n]) => BarRow({ label: ev || '?', value: String(n), pct: snap.total ? Math.round(n / snap.total * 100) : 0 })),
      ...(evOmitted > 0 ? [h('div', { class: 'gm-muted-11' }, `+${evOmitted} more event type${evOmitted === 1 ? '' : 's'} not shown (list caps at ${TOP_ROWS_SHOWN})`)] : []),
    ]
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
    h('div', { class: 'gm-mb-12' }, quickLinks),
    h('div', { class: 'gm-mb-12' }, projPanel),
    h('div', { class: 'gm-mb-12' }, stats),
    h('div', { class: 'gm-flex-row' },
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Subsystems'), ...(snap.total ? subRows : [Empty('No data.')])),
      h('div', { class: 'ds-panel' }, h('h2', {}, 'Top Events'), ...evRows)));
}

export async function ByDay() {
  const days = await api('/api/days');
  if (!Array.isArray(days) || !days.length) return Empty('No day-bucketed data yet.');
  // scope="col" on every header and a caption naming the table: without them a
  // screen reader reads 8 rows of bare numbers with no way to associate a cell
  // with its column (measured live: 7 headers, 0 scoped, no caption, no label).
  return h('div', { class: 'ds-panel' }, h('h2', { id: 'by-day-heading' }, 'Events by Day'),
    h('table', { class: 'gm-table', 'aria-labelledby': 'by-day-heading' },
      h('thead', {},
        h('tr', {}, h('th', { scope: 'col' }, 'Day'), h('th', { scope: 'col' }, 'Total'),
          ...subsystemList().map(s => h('th', { scope: 'col', class: 'gm-sub-color', style: `--sub-color:${colorFor(s)}` }, s)))),
      h('tbody', {},
        ...days.map(d => h('tr', { key: d.day }, h('th', { scope: 'row' }, d.day), h('td', {}, String(d.total)),
          ...subsystemList().map(s => h('td', {}, String(d.bySub[s] || ''))))))));
}

const LIVE_BUFFER_MAX_ENTRIES = 2000;
const LIVE_VISIBLE_MAX_ROWS = 500;
let liveEntries = [];
let liveAutoscrollPaused = false;
let liveEntriesArrivedWhilePaused = 0;
let liveProjectFilter = null;
// Measured under a real 2000+ event backlog: keying rows by `liveEntries.length` froze the key
// at the buffer cap once shifting began, collapsing thousands of pushes onto a handful of keyed
// DOM nodes that webjsx then re-diffed in place -- LiveStream ran at ~1fps. A never-reused
// counter is what removes the collision.
let liveEntryKeySeq = 0;

export function liveStreamDebugSnapshot() {
  return {
    liveEntriesLength: liveEntries.length,
    liveEntrySeq: liveEntryKeySeq,
    liveProjectFilter,
    livePaused: liveAutoscrollPaused,
    liveNewCount: liveEntriesArrivedWhilePaused,
    lastEntries: liveEntries.slice(-5),
  };
}
export function pushLiveEntry(ev) {
  const payload = { ...ev };
  delete payload._sub; delete payload._day; delete payload._fp;
  liveEntries.push({ key: liveEntryKeySeq++, ts: fmtTs(ev.ts), sub: ev._sub, tone: colorFor(ev._sub || ''), event: ev.event || '?', preview: asKeyValueLine(payload, 200), cwd: ev.cwd || null });
  if (liveEntries.length > LIVE_BUFFER_MAX_ENTRIES) liveEntries.shift();
  if (liveAutoscrollPaused) liveEntriesArrivedWhilePaused++;
}
export function LiveStream({ connState = 'connecting' } = {}, setBody) {
  const toneMap = { live: 'positive', reconnecting: 'warn', connecting: 'neutral', closed: 'danger' };
  const pauseBtn = Btn({
    children: liveAutoscrollPaused ? `Resume${liveEntriesArrivedWhilePaused ? ` (${liveEntriesArrivedWhilePaused} new)` : ''}` : 'Pause',
    variant: liveAutoscrollPaused ? 'primary' : 'ghost',
    onClick: () => {
      liveAutoscrollPaused = !liveAutoscrollPaused;
      if (!liveAutoscrollPaused) liveEntriesArrivedWhilePaused = 0;
      if (setBody) setBody();
    },
  });
  const cwds = [...new Set(liveEntries.map(e => e.cwd).filter(Boolean))].sort((a, b) => basename(a).localeCompare(basename(b)));
  const projectSelect = h('select', {
    value: liveProjectFilter || '',
    onchange: (e) => { liveProjectFilter = e.target.value || null; if (setBody) setBody(); },
  },
    h('option', { value: '' }, `all projects (${cwds.length})`),
    ...cwds.map(cwd => h('option', { key: cwd, value: cwd }, basename(cwd))));
  const filtered = liveProjectFilter ? liveEntries.filter(e => e.cwd === liveProjectFilter) : liveEntries;
  const tagged = filtered.slice(-LIVE_VISIBLE_MAX_ROWS).map(e => ({ ...e, sub: e.cwd ? `${basename(e.cwd)}/${e.sub}` : e.sub }));
  return h('div', { class: 'ds-panel gm-p-8' },
    h('div', { class: 'gm-row-between' },
      h('h2', { class: 'gm-m-0' }, 'Live Stream'),
      h('div', { class: 'gm-row-gap-8' },
        Chip({ tone: toneMap[connState] || 'neutral', children: connState }),
        projectSelect,
        Toolbar(pauseBtn))),
    tagged.length ? LiveLog({ entries: tagged, autoScroll: !liveAutoscrollPaused }) : Empty(liveProjectFilter ? 'No live events yet for this project.' : 'No live events received yet.'));
}

const SUBSYSTEM_BADGE_COLUMN_KEY = 'sub';
const LEADING_COLUMNS = ['ts', 'event', 'pid'];
const INTERNAL_FIELD_PREFIX = '_';
const MAX_INLINE_OBJECT_CHARS = 80;
const COLLAPSED_SUMMARY_CHARS = 40;
const MAX_CELL_CHARS = 120;
const isInternalField = (key) => key.startsWith(INTERNAL_FIELD_PREFIX);
const sortStateByTableId = new Map();

function sortRows(rows, sortSpec) {
  if (!sortSpec || !sortSpec.key) return rows;
  const { key, dir } = sortSpec;
  const mul = dir === 'asc' ? 1 : -1;
  const valueOf = (r) => (key === SUBSYSTEM_BADGE_COLUMN_KEY ? (r._sub || '') : r[key]);
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
  for (const r of rows) Object.keys(r).forEach(k => { if (!isInternalField(k)) cols.add(k); });
  const keys = [...cols];
  const display = [...LEADING_COLUMNS, ...keys.filter(k => !LEADING_COLUMNS.includes(k) && !isInternalField(k))];
  const sortable = !!(tableId && setBody);
  const sortSpec = sortable ? sortStateByTableId.get(tableId) : null;
  const sortedRows = sortable ? sortRows(rows, sortSpec) : rows;
  // scope="col" on every header: this table renders up to 38 columns against
  // 100 rows, and without the association a screen reader reads each cell as a
  // bare value with no column name (measured live: 38 headers, 0 scoped).
  const headerCell = (colKey, label) => {
    if (!sortable) return h('th', { scope: 'col' }, label);
    const active = sortSpec && sortSpec.key === colKey;
    const dir = active ? sortSpec.dir : null;
    const indicator = active ? (dir === 'asc' ? ' ^' : ' v') : '';
    return h('th', {
      scope: 'col',
      class: 'gm-th-sortable' + (active ? ' gm-th-sorted' : ''),
      role: 'button', tabindex: '0',
      'aria-sort': active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none',
      title: `sort by ${label}`,
      onclick: () => { toggleEventTableSort(tableId, colKey); setBody(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEventTableSort(tableId, colKey); setBody(); } },
    }, label + indicator);
  };
  return h('table', { class: 'gm-table', 'aria-label': `${sortedRows.length} event row(s), ${display.length + 1} columns` },
    h('thead', {},
      h('tr', {}, headerCell(SUBSYSTEM_BADGE_COLUMN_KEY, SUBSYSTEM_BADGE_COLUMN_KEY), ...display.map(k => headerCell(k, k)))),
    h('tbody', {},
    ...sortedRows.map((r, i) => h('tr', { key: i },
      h('td', {}, Badge({ children: r._sub || '?', tone: 'neutral' })),
      ...display.map(k => {
        const v = r[k];
        if (v === undefined || v === null) return h('td', {});
        if (k === 'ts') return h('td', { class: 'ts' }, fmtTs(v));
        if (k === 'event') return h('td', {}, h('strong', {}, String(v)));
        if (typeof v === 'boolean') return h('td', {}, v ? Badge({ children: '[x]', tone: 'positive' }) : Badge({ children: '[ ]', tone: 'danger' }));
        if (typeof v === 'object') {
          const inlineFits = JSON.stringify(v).length <= MAX_INLINE_OBJECT_CHARS;
          return h('td', {}, inlineFits
            ? asKeyValueLine(v, MAX_INLINE_OBJECT_CHARS)
            : h('details', {}, h('summary', {}, asKeyValueLine(v, COLLAPSED_SUMMARY_CHARS) + ELLIPSIS), JsonViewer({ value: v, mode: 'highlight', maxHeight: '260px' })));
        }
        const sv = String(v);
        const overflows = sv.length > MAX_CELL_CHARS;
        return h('td', { title: overflows ? sv : null }, overflows ? sv.slice(0, MAX_INLINE_OBJECT_CHARS) + ELLIPSIS : sv);
      })))));
}
function toggleEventTableSort(tableId, colKey) {
  const cur = sortStateByTableId.get(tableId);
  const flipped = cur && cur.key === colKey && cur.dir === 'asc' ? 'desc' : 'asc';
  sortStateByTableId.set(tableId, { key: colKey, dir: flipped });
}

// Measured (playwright-driven timing against a real ~55k-event backlog): re-fetching these two
// dropdown sources alongside every page of rows cost each pagination/sort/filter-text re-render
// 60-120ms, almost entirely 3 concurrent round-trips where only the page of rows varied.
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

const PAGE_SIZE = 100;
const pagedEventStateByPanel = new Map();

function pageStateForPanel(stateKey, subsystemFixedByRoute) {
  let st = pagedEventStateByPanel.get(stateKey);
  if (!st) { st = { offset: 0, limit: PAGE_SIZE, filters: {}, current: subsystemFixedByRoute ?? null }; pagedEventStateByPanel.set(stateKey, st); }
  const reusedForADifferentSubsystem = subsystemFixedByRoute != null && st.current !== subsystemFixedByRoute;
  if (reusedForADifferentSubsystem) { st.current = subsystemFixedByRoute; st.offset = 0; st.filters = {}; }
  return st;
}

// ds Pager is 1-based page-numbered while this state is an offset/limit window.
// The two are exactly interconvertible because `limit` is fixed for the life of
// a page state and every offset it ever writes is a multiple of it, so
// offset = (page - 1) * limit round-trips without loss. Numbered mode is what
// the offset model could not offer: jumping straight to a page of a 55k-row
// table instead of stepping one window at a time.
function PagerStrip(st, total, setBody) {
  const pageCount = Math.max(1, Math.ceil(total / st.limit));
  return Pager({
    page: Math.floor(st.offset / st.limit) + 1,
    pageCount,
    total,
    itemLabel: 'events',
    numbered: true,
    onPage: (page) => { st.offset = Math.max(0, (page - 1) * st.limit); setBody(); },
  });
}

async function PagedEventTable({ endpoint, stateKey, tableId, subsystemFixedByRoute = null, heading = null }, setBody) {
  const st = pageStateForPanel(stateKey, subsystemFixedByRoute);
  const params = new URLSearchParams({ limit: st.limit, offset: st.offset });
  if (subsystemFixedByRoute != null) params.set('sub', subsystemFixedByRoute);
  for (const [k, v] of Object.entries(st.filters)) if (v) params.set(k, v);

  const [data, { evTypes, days }] = await Promise.all([
    api(endpoint + '?' + params, { scoped: false }),
    fetchEvTypesAndDays(subsystemFixedByRoute ?? undefined),
  ]);
  if (data.error) return Failed(heading || 'events', data.error);

  const setFilter = (key, value) => { st.filters[key] = value; st.offset = 0; setBody(); };
  const filterSelect = (key, label, opts) => h('select', {
    onchange: (e) => setFilter(key, e.target.value),
  }, h('option', { value: '' }, label),
    ...opts.map(o => h('option', { value: o, selected: o === st.filters[key] ? true : null }, o)));

  const total = data.total || 0;
  const rows = data.rows || [];
  const someFilterIsActive = Object.values(st.filters).some(Boolean);

  return h('div', { class: 'ds-panel' },
    heading ? h('h2', {}, heading) : null,
    Toolbar(
      h('input', {
        placeholder: 'filter...', value: st.filters.q || '',
        oninput: (e) => setFilter('q', e.target.value),
      }),
      subsystemFixedByRoute == null ? filterSelect('sub', 'all subsystems', subsystemList()) : null,
      filterSelect('event', 'all events', (evTypes || []).map(e => e.event)),
      filterSelect('day', 'all days', (days || []).map(d => d.day))),
    rows.length
      ? renderEventTable(rows, tableId, setBody)
      : Empty(
          someFilterIsActive ? 'No events match this filter.' : 'No events recorded.',
          someFilterIsActive ? 'filtered' : 'empty',
          someFilterIsActive ? `${total} row(s) matched the current filter across the whole source.` : undefined),
    PagerStrip(st, total, setBody));
}

export async function AllEvents(setBody) {
  return PagedEventTable({
    endpoint: '/api/events', stateKey: 'all-events', tableId: 'all-events',
  }, setBody);
}

export async function SubsystemPanel(sub, setBody) {
  return PagedEventTable({
    endpoint: '/api/subsystem', stateKey: 'subsystem', tableId: 'subsystem-' + sub,
    subsystemFixedByRoute: sub, heading: sub,
  }, setBody);
}


