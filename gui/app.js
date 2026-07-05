import * as webjsx from 'webjsx';
import { AppShell, Topbar, Side, Status, Chip } from 'ds/components/shell.js';
import { ThemeToggle } from 'ds/components/theme-toggle.js';
import { CommandPalette } from 'ds/components/overlay-primitives.js';
import { state, loadProjects, api, toast } from './data.js';
import {
  Dashboard, ByDay, LiveStream, pushLiveEntry, AllEvents, Search, SubsystemPanel,
  Deviations, Sessions, ProcessTree, QueryPanel, RecallStats, ExecStats, HookStats,
  PrdEditor, MutablesEditor, LifecycleControl, RsTools, Codesearch, GmCallConsole,
  BrowserSessions, ConversationHistory, CodeInsightPanel, MemoryGraphPanel, stopMemoryGraphLayout, SUB_LIST,
  lifecycleAct, runCodesearch, dispatchConsole,
} from './panels.js';

const h = webjsx.createElement;
const root = document.getElementById('root');

const NAV = {
  overview: 'Dashboard', days: 'By Day', live: 'Live Stream', events: 'All Events', 'search-panel': 'Search',
  deviations: 'Deviations', sessions: 'Sessions', tree: 'Process Tree', query: 'Query',
  'recall-panel': 'Recall Stats', 'exec-panel': 'Exec Stats', 'hooks-panel': 'Hook Stats',
  prd: 'PRD Editor', mutables: 'Mutables Editor', lifecycle: 'Lifecycle Control',
  'rs-tools': 'RS Tools', codesearch: 'Codesearch', console: 'GM Call Console',
  'browser-sessions': 'Browser Sessions', conversations: 'Conversations',
  codeinsight: 'CodeInsight', 'memory-graph': 'Memory Graph',
};

const ui = {
  panel: 'overview',
  connState: 'connecting',
  devTotal: 0,
  treeSess: '',
  convSess: '',
  sessListCache: [],
  bodyNode: null,
  health: [],
  paletteOpen: false,
};

// Health-banner thresholds: named constants so amber/red logic is auditable and
// adjustable, never magic numbers inline in the render path.
const HEALTH_DEV_RATE_AMBER_PER_MIN = 1; // deviations/min at or above this = amber
const HEALTH_WATCHER_DEAD_MIN = 5; // watcher considered dead-for-N-min at this age
const HEALTH_STALE_FULL_SEC = 5 * 60; // no events for this long = fully stale

function navItem(id, label, extra) {
  return { label, href: '#' + id, active: ui.panel === id, onClick: (e) => { e.preventDefault(); go(id); }, count: extra };
}

// ---------------------------------------------------------------------------
// CTRL+K COMMAND PALETTE -- a combined registry of every sidebar nav target
// plus every lifecycle/dispatch verb the panels already expose (Lifecycle
// Control's dispatch buttons, Search/Codesearch's search trigger, GM Call
// Console's dispatch). Selecting an entry invokes the exact same handler
// function the panel's own control calls (never a simulated click) and
// reports success/failure via the shared toast() helper.
// ---------------------------------------------------------------------------
function navPaletteEntries() {
  return Object.entries(NAV).map(([id, label]) => ({
    label, group: 'Navigate',
    action: () => go(id),
  }));
}

function lifecyclePaletteEntries() {
  return [
    { label: 'Lifecycle: Transition', group: 'Lifecycle', action: () => lifecycleAct('transition', {}) },
    { label: 'Lifecycle: Instruction', group: 'Lifecycle', action: () => lifecycleAct('instruction', {}) },
    { label: 'Lifecycle: Residual Scan', group: 'Lifecycle', action: () => lifecycleAct('residual-scan', {}) },
  ];
}

function editorPaletteEntries() {
  // PRD/Mutables edits are per-row/per-field inline inputs in their panels
  // (commitField), so the palette's role is fast navigation to the editor
  // itself -- the actual field commit still goes through the identical
  // /api/prd/edit and /api/mutables/edit path once the row is in view.
  return [
    { label: 'PRD Editor: open', group: 'Edit', action: () => go('prd') },
    { label: 'Mutables Editor: open', group: 'Edit', action: () => go('mutables') },
  ];
}

function codesearchPaletteEntry() {
  return [{
    label: 'Codesearch: run current query', group: 'Search',
    action: async () => { await go('codesearch'); await runCodesearch((f) => renderBody(f)); },
  }];
}

function consolePaletteEntry() {
  return [{
    label: 'GM Call Console: dispatch', group: 'Console',
    action: async () => { await go('console'); await dispatchConsole((f) => renderBody(f)); },
  }];
}

function buildCommandRegistry() {
  return [
    ...navPaletteEntries(),
    ...lifecyclePaletteEntries(),
    ...editorPaletteEntries(),
    ...codesearchPaletteEntry(),
    ...consolePaletteEntry(),
  ];
}

async function runPaletteAction(entry) {
  ui.paletteOpen = false;
  renderShell();
  try {
    await entry.action();
    toast(`${entry.label}: done`);
  } catch (e) {
    toast(`${entry.label} failed: ${e && e.message || e}`, true);
  }
}

function openPalette() { ui.paletteOpen = true; renderShell(); }
function closePalette() { ui.paletteOpen = false; renderShell(); }

document.addEventListener('keydown', (e) => {
  const isK = e.key === 'k' || e.key === 'K';
  if (isK && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (ui.paletteOpen) closePalette(); else openPalette();
  } else if (e.key === 'Escape' && ui.paletteOpen) {
    closePalette();
  }
});

// Reuses the same project-switch mechanism as the topbar <select> (state.cwd + renderBody).
function switchToProject(cwd) {
  state.cwd = cwd || null;
  renderBody();
}

// Classifies a health row against the configured thresholds. Returns 'ok' | 'amber' | 'red'.
function healthRowSeverity(row) {
  const fullyStale = row.staleSeconds == null || row.staleSeconds >= HEALTH_STALE_FULL_SEC;
  // "watcher dead for N min": not alive AND stale long enough to rule out a brief restart blip.
  const watcherDeadForNMin = !row.watcherAlive && (row.staleSeconds == null || row.staleSeconds >= HEALTH_WATCHER_DEAD_MIN * 60);
  const highDeviationRate = (row.deviationRate || 0) >= HEALTH_DEV_RATE_AMBER_PER_MIN;
  const breaches = (highDeviationRate ? 1 : 0) + (watcherDeadForNMin ? 1 : 0) + (fullyStale ? 1 : 0);
  if (fullyStale && watcherDeadForNMin) return 'red';
  if (breaches >= 2) return 'red';
  if (breaches === 1) return 'amber';
  return 'ok';
}

function HealthBanner() {
  const rows = ui.health || [];
  const offending = rows.map(r => ({ ...r, severity: healthRowSeverity(r) })).filter(r => r.severity !== 'ok');
  if (!offending.length) return null;
  const tone = offending.some(r => r.severity === 'red') ? 'red' : 'amber';
  return h('div', { class: 'gm-health-banner gm-health-' + tone, role: 'alert' },
    h('span', { class: 'gm-health-label' }, tone === 'red' ? 'Health: critical' : 'Health: degraded'),
    h('span', { class: 'gm-health-list' }, ...offending.map((r, i) => h('button', {
      type: 'button',
      key: 'health-' + r.cwd,
      class: 'gm-health-item gm-health-item-' + r.severity,
      title: r.cwd,
      onclick: () => switchToProject(r.cwd),
    }, r.name + (i < offending.length - 1 ? ', ' : '')))));
}

function renderShell() {
  const side = Side({
    sections: [
      { group: 'Overview', items: [navItem('overview', 'Dashboard'), navItem('days', 'By Day'), navItem('live', 'Live Stream'), navItem('events', 'All Events'), navItem('search-panel', 'Search')] },
      { group: 'Process', items: [navItem('deviations', 'Deviations', ui.devTotal || null), navItem('sessions', 'Sessions'), navItem('tree', 'Process Tree'), navItem('conversations', 'Conversations'), navItem('query', 'Query')] },
      { group: 'Subsystems', items: SUB_LIST.map(s => navItem('sub-' + s, s)) },
      { group: 'Analytics', items: [navItem('recall-panel', 'Recall Stats'), navItem('exec-panel', 'Exec Stats'), navItem('hooks-panel', 'Hook Stats'), navItem('rs-tools', 'RS Tools'), navItem('codeinsight', 'CodeInsight'), navItem('memory-graph', 'Memory Graph')] },
      { group: 'Control', items: [navItem('prd', 'PRD Editor'), navItem('mutables', 'Mutables Editor'), navItem('lifecycle', 'Lifecycle Control'), navItem('codesearch', 'Codesearch'), navItem('console', 'GM Call Console'), navItem('browser-sessions', 'Browser Sessions')] },
    ],
  });

  const projectSelect = h('select', {
    'aria-label': 'project switcher', style: 'margin-left:10px',
    onchange: (e) => { state.cwd = e.target.value || null; renderBody(); },
  },
    h('option', { value: '' }, 'default (own root)'),
    ...state.projects.map(p => h('option', { value: p.cwd, selected: p.cwd === state.cwd ? true : null }, p.cwd)));

  const topbar = Topbar({ brand: 'gmsniff', leaf: 'observability', items: [] });

  const bodyContainer = h('main', { id: 'panel-body', class: 'gm-panel-body' }, ui.bodyNode || h('p', { class: 'gm-empty' }, 'Loading...'));

  const app = AppShell({
    topbar: h('div', { style: 'display:flex;align-items:center;width:100%' }, topbar, projectSelect,
      h('span', { style: 'margin-left:auto;display:flex;align-items:center;gap:10px' },
        Chip({ tone: ui.connState === 'live' ? 'positive' : (ui.connState === 'reconnecting' ? 'warn' : 'neutral'), children: ui.connState }),
        ThemeToggle({ compact: true }))),
    side,
    // Persistent health banner sits above the panel router (bodyContainer) inside main,
    // so it is visible regardless of which panel is active, and hidden entirely (null) when
    // every discovered project is healthy.
    main: [HealthBanner(), bodyContainer],
    status: Status({ left: ['gmsniff'], right: [state.cwd || '(own root)'] }),
  });
  webjsx.applyDiff(root, app);

  const paletteHost = document.getElementById('command-palette-host') || (() => {
    const el = document.createElement('div');
    el.id = 'command-palette-host';
    document.body.appendChild(el);
    return el;
  })();
  webjsx.applyDiff(paletteHost, CommandPalette({
    open: ui.paletteOpen,
    items: buildCommandRegistry(),
    onSelect: runPaletteAction,
    onClose: closePalette,
  }));
}

async function renderBody(force) {
  ui.bodyNode = await computeBody(force);
  renderShell();
}

async function computeBody(force) {
  const p = ui.panel;
  const setBody = (f) => renderBody(f);
  if (p !== 'memory-graph') stopMemoryGraphLayout();
  if (p === 'overview') return Dashboard();
  if (p === 'days') return ByDay();
  if (p === 'live') return LiveStream({ connState: ui.connState });
  if (p === 'events') return AllEvents(setBody);
  if (p === 'search-panel') return Search(setBody);
  if (p.startsWith('sub-')) return SubsystemPanel(p.slice(4), setBody);
  if (p === 'deviations') return Deviations(setBody);
  if (p === 'sessions') return Sessions((sess) => { ui.treeSess = sess; ui.panel = 'tree'; renderBody(); }, setBody);
  if (p === 'tree') {
    if (!ui.sessListCache.length || force) { const r = await api('/api/sessions?limit=200'); ui.sessListCache = r.rows || []; }
    return ProcessTree(ui.treeSess, ui.sessListCache, (sess) => { ui.treeSess = sess; renderBody(); },
      (sess) => { ui.convSess = sess; ui.panel = 'conversations'; renderBody(); },
      () => renderBody(true)); // refresh: force=true re-fetches sessListCache + process-tree via this same computeBody path
  }
  if (p === 'conversations') {
    if (!ui.sessListCache.length || force) { const r = await api('/api/sessions?limit=200'); ui.sessListCache = r.rows || []; }
    return ConversationHistory(ui.convSess, ui.sessListCache, (sess) => { ui.convSess = sess; renderBody(); });
  }
  if (p === 'query') return QueryPanel(setBody);
  if (p === 'recall-panel') return RecallStats();
  if (p === 'exec-panel') return ExecStats();
  if (p === 'hooks-panel') return HookStats();
  if (p === 'prd') return PrdEditor(setBody);
  if (p === 'mutables') return MutablesEditor(setBody);
  if (p === 'lifecycle') return LifecycleControl(setBody);
  if (p === 'rs-tools') return RsTools();
  if (p === 'codesearch') return Codesearch(setBody);
  if (p === 'console') return GmCallConsole(setBody);
  if (p === 'browser-sessions') return BrowserSessions();
  if (p === 'codeinsight') return CodeInsightPanel(setBody);
  if (p === 'memory-graph') return MemoryGraphPanel();
  return h('p', { class: 'gm-empty' }, 'Unknown panel: ' + p);
}

async function go(id) {
  ui.panel = id;
  await renderBody(true);
}

// Single shared poller for both the deviation-count badge and the cross-project health
// banner -- intentionally not a second setInterval, both piggyback on the same 10s timer.
async function refreshDeviationBadge() {
  const [devR, healthR] = await Promise.all([
    api('/api/deviations?limit=1'),
    api('/api/health-summary'),
  ]);
  ui.devTotal = devR.total || 0;
  ui.health = Array.isArray(healthR) ? healthR : (healthR.rows || []);
  renderShell();
}

let sse = null;
let reconnectDelay = 1000;
function connectSSE() {
  sse = new EventSource('/api/stream');
  sse.addEventListener('hello', () => { ui.connState = 'live'; reconnectDelay = 1000; renderShell(); if (ui.panel === 'live') renderBody(); });
  sse.addEventListener('event', (e) => {
    try {
      const ev = JSON.parse(e.data);
      pushLiveEntry(ev);
      if (ui.panel === 'live') renderBody();
      if (ui.panel === 'overview') renderBody();
      if (typeof ev.event === 'string' && ev.event.startsWith('deviation.')) refreshDeviationBadge();
      if (ui.panel === 'deviations' && typeof ev.event === 'string' && ev.event.startsWith('deviation.')) renderBody();
      if (ui.panel === 'sessions') renderBody();
    } catch (_) {}
  });
  sse.onerror = () => {
    ui.connState = 'reconnecting'; renderShell();
    try { sse.close(); } catch (_) {}
    setTimeout(connectSSE, Math.min(reconnectDelay, 15000));
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

async function boot() {
  await loadProjects();
  renderShell();
  await renderBody();
  refreshDeviationBadge();
  setInterval(refreshDeviationBadge, 10000);
  connectSSE();
  window.gmsniff = { state, ui, go, renderBody, renderShell, openPalette, closePalette, buildCommandRegistry };
}

boot();
