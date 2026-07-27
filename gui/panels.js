import * as webjsx from 'webjsx';
import { Chip, Badge, Pill, Btn } from 'ds/components/shell.js';
import { PhaseWalk, BarRow, StatsGrid, SessionRow, DevRow, LiveLog } from 'ds/components/data-density.js';
import { TreeView, TreeItem, PropertyGrid, PropertyField, Dialog, JsonViewer, ToolbarRow, Pager } from 'ds/components/editor-primitives.js';
import { api, apiPost, fmtTs, state, toast } from './data.js';
import { runForceLayout } from './forcegraph.js';
import { basename, subsystemList, mergeObservedSubsystems, verbAllowlist, PHASE_FALLBACK } from './shared.js';
import { HonestState, ScopedPanelState } from './honest-state.js';

const h = webjsx.createElement;

const Toolbar = ToolbarRow;

export const SUB_COLORS = {
  hook: 'var(--purple, #bc8cff)', plugkit: 'var(--flame, #ff7b72)',
  bootstrap: 'var(--sky, #79c0ff)', memory: 'var(--green, #3fb950)',
};

function colorFor(sub) {
  if (SUB_COLORS[sub]) return SUB_COLORS[sub];
  let hue = 0;
  for (let i = 0; i < sub.length; i++) hue = (hue * 31 + sub.charCodeAt(i)) >>> 0;
  return `hsl(${hue % 360}, 60%, 65%)`;
}

function Empty(text, kind = 'empty', hint) { return HonestState({ kind, text, hint }); }
function Failed(what, error) {
  return HonestState({ kind: 'error', text: `Could not load ${what}.`, hint: String(error) });
}

const ELLIPSIS = '...';
const MAX_VALUE_CHARS = 60;

function truncateWithEllipsis(s, maxLen) {
  return s.length > maxLen ? s.slice(0, maxLen - ELLIPSIS.length) + ELLIPSIS : s;
}

function asKeyValueLine(obj, maxLen = 200) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    let sv;
    if (v == null) sv = String(v);
    else if (typeof v === 'object') { try { sv = JSON.stringify(v); } catch { sv = String(v); } }
    else sv = String(v);
    parts.push(k + '=' + truncateWithEllipsis(sv, MAX_VALUE_CHARS));
    if (parts.join('  ').length >= maxLen) break;
  }
  return truncateWithEllipsis(parts.join('  '), maxLen);
}

const TOP_ROWS_SHOWN = 15;

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
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Events by Day'),
    h('table', { class: 'gm-table' },
      h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Total'), ...subsystemList().map(s => h('th', { class: 'gm-sub-color', style: `--sub-color:${colorFor(s)}` }, s))),
      ...days.map(d => h('tr', { key: d.day }, h('td', {}, d.day), h('td', {}, String(d.total)),
        ...subsystemList().map(s => h('td', {}, String(d.bySub[s] || '')))))));
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
    h('tr', {}, headerCell(SUBSYSTEM_BADGE_COLUMN_KEY, SUBSYSTEM_BADGE_COLUMN_KEY), ...display.map(k => headerCell(k, k))),
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
      }))));
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

const SESS_ID_DISPLAY_CHARS = 20;

// gm writes a deviation's cause as either a `residuals` array or a single
// `reason` scalar, and both shapes are live; DevRow takes one array.
function toDevRow(e) {
  return DevRow({
    ts: fmtTs(e.ts), event: e.event, sess: (e.sess || '-').slice(0, SESS_ID_DISPLAY_CHARS),
    operation: e.operation,
    residuals: Array.isArray(e.residuals) ? e.residuals : (e.reason ? [e.reason] : []),
  });
}

const deviationsFilterState = { sessQuery: '' };
export async function Deviations(setBody) {
  const r = await api('/api/deviations?limit=200');
  if (r.error) return Empty('Failed to load deviations: ' + r.error);
  const q = (deviationsFilterState.sessQuery || '').trim().toLowerCase();
  const recentAll = r.recent || [];
  const recent = q ? recentAll.filter(e => String(e.sess || '').toLowerCase().includes(q)) : recentAll;
  const bySessionEntries = Object.entries(r.bySession || {});
  const bySessionFiltered = q ? bySessionEntries.filter(([s]) => s.toLowerCase().includes(q)) : bySessionEntries;
  const kindRows = Object.entries(r.byKind || {}).sort((a, b) => b[1] - a[1]);
  const bySessionRanked = bySessionFiltered.sort((a, b) => b[1] - a[1]);
  const sessRows = bySessionRanked.slice(0, TOP_ROWS_SHOWN);
  const sessRowsOmitted = bySessionRanked.length - sessRows.length;
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
        ...(sessRows.length ? sessRows.map(([s, n]) => BarRow({ label: s.slice(0, 60), value: String(n) })) : [Empty(q ? 'No sessions match filter.' : '-')]),
        ...(sessRowsOmitted > 0 ? [h('div', { class: 'gm-muted-11' }, `+${sessRowsOmitted} more session${sessRowsOmitted === 1 ? '' : 's'} not shown (list caps at ${TOP_ROWS_SHOWN})`)] : []))),
    h('div', { class: 'ds-panel' }, h('h2', {}, `Recent Deviations (${recent.length}${q ? ` of ${r.total}` : ` / ${r.total}`})`),
      ...(recent.length ? recent.map(toDevRow) : [Empty(q ? 'No deviations match filter.' : 'No deviations recorded -- agents are following the process.')])));
}

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
      api('/api/process-tree?sess=' + encodeURIComponent(sess)),
      api('/api/deviations?sess=' + encodeURIComponent(sess) + '&limit=200'),
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
            ? h('div', {}, ...devRows.map(toDevRow))
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

function phasesSkippedInReachedOrder(phasesReached) {
  const skipped = [];
  for (let i = 0; i < PHASE_FALLBACK.length - 1; i++) {
    if (phasesReached[i + 1] && !phasesReached[i]) skipped.push(PHASE_FALLBACK[i]);
  }
  return skipped;
}

// `unusedOnOpen`: app.js passes a navigate-to-tree callback here, but a session row opens the
// detail Dialog instead and never calls it. Dropping the parameter would silently re-bind
// app.js's argument to setBody, so it stays named until app.js is changed to match.
export async function Sessions(unusedOnOpen, setBody) {
  const refreshToolbar = setBody ? Toolbar(Btn({ children: 'Refresh', variant: 'ghost', onClick: () => setBody(true) })) : null;
  const r = await api('/api/sessions?limit=200');
  if (r.error) return h('div', {}, refreshToolbar, Empty('Failed to load sessions: ' + r.error));
  if (!r.rows || !r.rows.length) return h('div', {}, refreshToolbar, Empty('No sessions recorded yet.'));
  return h('div', {}, h('div', { class: 'ds-panel' }, h('h2', {}, `Sessions (${r.total})`),
    refreshToolbar,
    ...r.rows.map(s => {
      const gaps = phasesSkippedInReachedOrder(s.phases_reached);
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

const NO_PHASE_GROUP_LABEL = '(no phase)';
const UNRANKED_PHASE_SORTS_LAST = 99;

function buildProcessTreeHierarchy(sess, nodes) {
  const nodesByPhase = new Map();
  for (const n of nodes) {
    const phase = n.phase || NO_PHASE_GROUP_LABEL;
    if (!nodesByPhase.has(phase)) nodesByPhase.set(phase, []);
    nodesByPhase.get(phase).push(n);
  }

  const PHASE_ORDER = [...PHASE_FALLBACK, NO_PHASE_GROUP_LABEL];
  const phaseKeys = [...nodesByPhase.keys()].sort((a, b) => {
    const ia = PHASE_ORDER.indexOf(a), ib = PHASE_ORDER.indexOf(b);
    return (ia === -1 ? UNRANKED_PHASE_SORTS_LAST : ia) - (ib === -1 ? UNRANKED_PHASE_SORTS_LAST : ib);
  });
  return {
    id: 'root:' + sess,
    label: sess,
    children: phaseKeys.map(phase => ({
      id: 'phase:' + sess + ':' + phase,
      label: phase,
      tag: `${nodesByPhase.get(phase).length} events`,
      children: nodesByPhase.get(phase).map((n, i) => ({
        id: 'node:' + sess + ':' + phase + ':' + i,
        label: n.kind + (n.id ? ' ' + n.id : '') + (n.deviation ? ' ' + n.deviation : ''),
        tag: fmtTs(n.ts),
        node: n,
        children: null,
      })),
    })),
  };
}

const treeUiState = { expanded: new Set(), focusId: null };
export async function ProcessTree(sess, sessList, onSelect, onOpenSession, onRefresh) {
  const selector = h('select', {
    value: sess || '',
    onchange: (e) => onSelect(e.target.value),
  }, h('option', { value: '' }, 'select session...'),
    ...(sessList || []).map(s => h('option', { value: s.sess, selected: s.sess === sess ? true : null }, `${s.sess.slice(0, 40)} -- ${fmtTs(s.last_ts)} -- ${s.events}ev${s.deviations ? ' !' + s.deviations : ''}`)));
  const refreshBtn = onRefresh ? Btn({ children: 'Refresh', variant: 'ghost', onClick: () => onRefresh(sess) }) : null;
  if (!sess) return h('div', { class: 'ds-panel' }, Toolbar( selector, refreshBtn), Empty('Select a session.'));
  const r = await api('/api/process-tree?sess=' + encodeURIComponent(sess));
  const gapsBlock = (r.gaps && r.gaps.length)
    ? h('div', { class: 'ds-panel gm-panel-danger' }, h('h2', { class: 'gm-text-danger' }, 'Gaps detected'),
      ...r.gaps.map((g, i) => DevRow({ ts: fmtTs(g.ts), event: g.kind, operation: g.from ? `${g.from} -> ${g.to}` : (g.deviation || ''), residuals: g.detail ? [`first non-instruction event: ${g.detail.event} verb=${g.detail.verb || ''}`] : [] })))
    : null;

  const root = buildProcessTreeHierarchy(sess, r.nodes || []);
  const rootStartsExpandedSoItsPhaseGroupsShow = !treeUiState.expanded.has(root.id);
  if (rootStartsExpandedSoItsPhaseGroupsShow) treeUiState.expanded.add(root.id);
  let doRerender = () => {};

  function openSession(targetSess) {
    if (onOpenSession) onOpenSession(targetSess);
    else if (onSelect) onSelect(targetSess);
  }

  function renderNode(item, depth) {
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
        if (item.node) openSession(sess);
        else if (hasKids) { if (!expanded) treeUiState.expanded.add(item.id); else treeUiState.expanded.delete(item.id); }
        doRerender();
      },
      children: hasKids ? item.children.map(c => renderNode(c, depth + 1)) : null,
    });
  }

  function build() {
    if (!treeUiState.focusId) treeUiState.focusId = root.id;
    return h('div', { class: 'ds-panel' },
      Toolbar( selector, refreshBtn),
      h('h2', {}, sess), PhaseWalk({ reached: r.phase_reached, gapKinds: [] }),
      gapsBlock,
      h('h2', { class: 'gm-mt-10' }, `Process Tree (${(r.nodes || []).length} events)`),
      (r.nodes || []).length
        ? TreeView({ children: [renderNode(root, 0)] })
        : Empty('No process events for this session.'));
  }

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

const PRD_STATUSES = ['pending', 'in_progress', 'resolved', 'blocked'];
const MUTABLE_STATUSES = ['unknown', 'resolved'];
const errorByRowIdAndField = {};

async function editRow(kind, id, since, fields, setBody, errKey) {
  const path = kind === 'prd' ? '/api/prd/edit' : '/api/mutables/edit';
  const r = await apiPost(path, { id, since, ...fields }, { scoped: true });
  if (r.status === 409) { toast(`Conflict: ${id} was modified since read (mtime ${r.mtimeMs}). Reloading.`, true); setBody(true); return; }
  if (r.status !== 200) { toast(`Edit failed: ${r.error || r.status}`, true); return; }
  if (errKey) delete errorByRowIdAndField[errKey];
  toast(`Saved ${id}`); setBody(true);
}

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

export function commitField(kind, row, field, value, since, setBody, validate) {
  const errKey = `${kind}:${row.id}:${field}`;
  const err = validate(field, value);
  if (err) { errorByRowIdAndField[errKey] = err; setBody(); return; }
  delete errorByRowIdAndField[errKey];
  editRow(kind, row.id, since, { [field]: value }, setBody, errKey);
}

// Measured against gm's own live prd.yml: severity is real but appears on only ~0.5% of rows,
// and upstream enforces no vocabulary (free-text scalar). Only the values actually witnessed
// are mapped; anything else falls back to neutral rather than guessing at unseen spellings.
const SEVERITY_TONE = { critical: 'danger', high: 'danger', medium: 'neutral', low: 'positive' };

// The two YAML editors share their whole frame -- scope gate, fetch, the three
// zero-states, the `since` mtime guard and the per-row PropertyGrid with its
// read-only id field -- and differ only in which editable fields a row carries.
// `fields(row, fieldError)` supplies exactly that difference; `fieldError` is
// the per-row error lookup already keyed by kind.
async function YamlRowEditor({ kind, panel, endpoint, heading, rowClass, fields }, setBody) {
  const unscoped = ScopedPanelState({ panel, cwd: state.cwd });
  if (unscoped) return unscoped;
  const r = await api(endpoint, { scoped: true });
  if (r.error) return Empty(`Failed to load ${heading}: ` + r.error);
  if (!r.rows || !r.rows.length) return Empty(`No ${heading} rows for this project.`);
  const since = r.mtimeMs;
  return h('div', { class: 'ds-panel' }, h('h2', {}, `${heading} (${r.rows.length} rows)`),
    ...r.rows.map(row => {
      const fieldError = (field) => errorByRowIdAndField[`${kind}:${row.id}:${field}`];
      return h('div', { key: row.id, class: 'gm-propgrid-row' + (rowClass ? rowClass(row) : '') },
        PropertyGrid({ children: [
          PropertyField({ label: 'id', inline: true, children: h('span', { class: 'gm-inline-input gm-opacity-70' }, row.id) }),
          ...fields(row, fieldError, since, setBody),
        ] }));
    }));
}

export async function PrdEditor(setBody) {
  return YamlRowEditor({
    kind: 'prd', panel: 'PRD Editor', endpoint: '/api/prd', heading: 'PRD',
    fields: (row, fieldError, since, setBody) => {
      const statusErr = fieldError('status');
      const textErr = fieldError('text');
      return [
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
      ];
    },
  }, setBody);
}

export async function MutablesEditor(setBody) {
  return YamlRowEditor({
    kind: 'mutables', panel: 'Mutables Editor', endpoint: '/api/mutables', heading: 'Mutables',
    rowClass: (row) => (row.status === 'unknown' ? ' gm-row-danger-tint' : ''),
    fields: (row, fieldError, since, setBody) => {
      const statusErr = fieldError('status');
      const witnessErr = fieldError('witness');
      return [
        PropertyField({ label: 'status', hint: statusErr || null, children: h('span', {}, Badge({ children: row.status, tone: row.status === 'unknown' ? 'danger' : (row.status === 'resolved' ? 'positive' : 'neutral') })) }),
        PropertyField({ label: 'witness', hint: witnessErr || null, children: h('input', {
          class: 'gm-inline-input' + (witnessErr ? ' gm-field-error' : ''), value: row.witness_evidence || '', placeholder: 'witness evidence...',
          onchange: (e) => commitField('mutables', row, 'witness', e.target.value, since, setBody, validateMutableField),
        }) }),
      ];
    },
  }, setBody);
}

export async function lifecycleAct(verb, payload) {
  const r = await apiPost('/api/lifecycle', { verb, payload }, { scoped: true });
  toast(r.status === 200 ? `Dispatched ${verb}` : `Dispatch failed: ${r.error || r.status}`, r.status !== 200);
  return r;
}

export async function LifecycleControl(setBody) {
  const unscoped = ScopedPanelState({ panel: "Lifecycle Control", cwd: state.cwd });
  if (unscoped) return unscoped;
  const [prd, mutables] = await Promise.all([api('/api/prd', { scoped: true }), api('/api/mutables', { scoped: true })]);
  if (prd.error || mutables.error) return Empty('Failed to load lifecycle state: ' + (prd.error || mutables.error));
  // /api/prd and /api/mutables page their rows, so counting the returned page reports a number
  // capped at the page size: on a real 820-row PRD the page held 250 rows of which 0 were
  // pending, so this panel displayed "0 PRD pending" for a project with 314 actually pending.
  // /api/projects computes both counts over the whole file and is the only honest source here.
  const project = (state.projects || []).find(r => r.cwd === state.cwd);
  const prdPending = project ? project.prd_pending : null;
  const mutUnknown = project ? project.mut_unknown : null;
  const countsUnavailable = prdPending == null;
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Lifecycle Control'),
    StatsGrid({ items: [
      { val: countsUnavailable ? '--' : prdPending, lbl: countsUnavailable ? 'PRD pending (not reported for this project)' : `PRD pending of ${project.prd_total}` },
      { val: countsUnavailable ? '--' : mutUnknown, lbl: 'mutables unknown', cls: mutUnknown ? 'err-rate' : '' },
    ] }),
    h('div', { class: 'gm-mt-12' }, Toolbar(
      Btn({ children: 'Transition', onClick: () => lifecycleAct('transition', {}) }),
      Btn({ children: 'Instruction', onClick: () => lifecycleAct('instruction', {}) }),
      Btn({ children: 'Residual Scan', onClick: () => lifecycleAct('residual-scan', {}) }))));
}

const codesearchState = { q: '', hits: null, loading: false, error: null };
export function Codesearch(setBody) {
  const unscoped = ScopedPanelState({ panel: 'Codesearch', cwd: state.cwd });
  if (unscoped) return unscoped;
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Codesearch'),
    Toolbar(
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

// Measured: /api/capabilities publishes 92 verbs. A 27-verb literal previously lived here, so
// two thirds of what the server would accept was unreachable from this console.
const DISPATCH_RESPONSE_TIMEOUT_MS = 10000;
const DISPATCH_RESPONSE_POLL_MS = 500;
const consoleState = { verb: null, payload: '{}', dispatched: null, polling: false, result: null };
export function GmCallConsole(setBody) {
  // The only scoped panel here that WRITES: an unscoped dispatch would not merely
  // display the server's own launch directory, it would fire a real verb into it.
  const unscoped = ScopedPanelState({ panel: 'GM Call Console', cwd: state.cwd });
  if (unscoped) return unscoped;
  const verbs = verbAllowlist();
  const selectionNoLongerPublished = !consoleState.verb || !verbs.includes(consoleState.verb);
  if (selectionNoLongerPublished) consoleState.verb = verbs[0];
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Localized GM Call Console'),
    Toolbar(
      h('select', { value: consoleState.verb, onchange: (e) => { consoleState.verb = e.target.value; } },
        ...verbs.map(v => h('option', { value: v, selected: v === consoleState.verb ? true : null }, v))),
      Btn({ children: 'Dispatch', onClick: () => dispatchConsole(setBody) })),
    h('p', { class: 'gm-muted-11' }, `${verbs.length} verb(s) published by /api/capabilities.`),
    h('textarea', { class: 'gm-textarea gm-h-80', oninput: (e) => { consoleState.payload = e.target.value; } }, consoleState.payload),
    consoleState.dispatched ? h('p', { class: 'gm-muted-11' }, `Dispatched: ${consoleState.dispatched.verb} -> ${consoleState.dispatched.file || ''} ${consoleState.polling ? '(polling for response...)' : ''}`) : null,
    consoleState.result ? JsonViewer({ value: consoleState.result, mode: 'tree', copyable: true, maxHeight: '420px' }) : Empty('No dispatch yet.'));
}
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
  const deadline = Date.now() + DISPATCH_RESPONSE_TIMEOUT_MS;
  const poll = async () => {
    const resp = await api(`/api/lifecycle/response?verb=${encodeURIComponent(consoleState.verb)}&file=${encodeURIComponent(file)}`, { scoped: true });
    if (resp.ok) { consoleState.polling = false; consoleState.result = resp.response; setBody(); return; }
    if (Date.now() >= deadline) { consoleState.polling = false; consoleState.result = { error: 'timed out waiting for response', tried: file }; setBody(); return; }
    setTimeout(poll, DISPATCH_RESPONSE_POLL_MS);
  };
  poll();
}

export async function BrowserSessions() {
  const unscoped = ScopedPanelState({ panel: "Browser Sessions", cwd: state.cwd });
  if (unscoped) return unscoped;
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

function squarifiedTreemap(items, x, y, w, h) {
  const out = [];
  const worstAspectRatio = (row, len) => {
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
      if (row.length === 0 || worstAspectRatio(candidate, short) <= worstAspectRatio(row, short)) {
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

const LOW_COMPLEXITY_GREEN = { r: 60, g: 180, b: 60 };
const HIGH_COMPLEXITY_RED = { r: 210, g: 50, b: 60 };
const UNIFORM_COMPLEXITY_SCALE_POINT = 0.3;

function complexityColor(val, min, max) {
  const span = max - min;
  const everyItemHasIdenticalComplexity = span <= 0;
  const t = everyItemHasIdenticalComplexity
    ? UNIFORM_COMPLEXITY_SCALE_POINT
    : Math.max(0, Math.min(1, (val - min) / span));
  const lerp = (from, to) => Math.round(from + t * (to - from));
  return `rgb(${lerp(LOW_COMPLEXITY_GREEN.r, HIGH_COMPLEXITY_RED.r)},`
    + `${lerp(LOW_COMPLEXITY_GREEN.g, HIGH_COMPLEXITY_RED.g)},`
    + `${lerp(LOW_COMPLEXITY_GREEN.b, HIGH_COMPLEXITY_RED.b)})`;
}

const codeInsightUi = { selected: null };

export async function CodeInsightPanel(setBody) {
  const unscoped = ScopedPanelState({ panel: "CodeInsight", cwd: state.cwd });
  if (unscoped) return unscoped;
  const r = await api('/api/codeinsight', { scoped: true });
  if (r.error) return Empty('No .codeinsight file found for this project (codeinsight has not run yet).');
  const summary = r.summary || {};
  const items = r.items || [];
  const complexities = items.map(it => it.complexity || 0);
  const minC = complexities.length ? Math.min(...complexities) : 0;
  const maxC = complexities.length ? Math.max(...complexities) : 1;
  const W = 900, H = 420;
  const rects = items.length ? squarifiedTreemap(items, 0, 0, W, H) : [];
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

const NODE_R_MIN = 6, NODE_R_MAX = 10;
const graphUiState = { handle: null, selectedId: null };

export function stopMemoryGraphLayout() {
  if (graphUiState.handle) { graphUiState.handle.stop(); graphUiState.handle = null; }
}

const GRAPH_MAX_NODES = 150;
const GRAPH_LABEL_MAX_CHARS = 28;

function toShapeRunForceLayoutExpects(r) {
  const nodes = (r.nodes || []).slice(0, GRAPH_MAX_NODES).map(n => ({
    id: n.key, label: `${n.namespace}/${n.key}`.slice(0, GRAPH_LABEL_MAX_CHARS), namespace: n.namespace, text: n.text,
  }));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edgesBetweenRenderedNodes = (r.edges || []).filter(e => nodeIds.has(e.src) && nodeIds.has(e.dst))
    .map(e => ({ source: e.src, target: e.dst, relation: e.relation }));
  return { nodes, edges: edgesBetweenRenderedNodes };
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
  const unscoped = ScopedPanelState({ panel: "Memory Graph", cwd: state.cwd });
  if (unscoped) return unscoped;
  stopMemoryGraphLayout();
  const r = await api('/api/memory-graph', { scoped: true });
  if (r.error) return Empty('Failed to load memory graph: ' + r.error);
  if (!r.nodes || !r.nodes.length) return Empty(r.note || 'No memory nodes found for this project.');

  const { nodes, edges } = toShapeRunForceLayoutExpects(r);
  const width = 900, height = 520;
  graphUiState.selectedId = null;

  const container = h('div', { class: 'ds-panel' },
    r.note ? h('p', { class: 'gm-hint-text' }, r.note) : null,
    h('h2', {}, `Memory Graph -- ${nodes.length} nodes, ${edges.length} edges`),
    h('svg', {
      class: 'gm-force-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet',
      id: 'memory-graph-svg',
    }));

  const afterCallerAppliesThisVnodeToTheDom = 0;
  setTimeout(() => mountForceGraph(nodes, edges, width, height), afterCallerAppliesThisVnodeToTheDom);

  return container;
}

function mountForceGraph(nodes, edges, width, height) {
  const svg = document.getElementById('memory-graph-svg');
  const panelNavigatedAwayBeforeMountFired = !svg;
  if (panelNavigatedAwayBeforeMountFired) return;

  let dragging = null;

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

      const r = NODE_R_MIN + Math.min(NODE_R_MAX - NODE_R_MIN, (n.label.length % 5));
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
