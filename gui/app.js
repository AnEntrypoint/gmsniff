import * as webjsx from 'webjsx';
import { AppShell, Topbar, Side, Status, Chip, Btn } from 'ds/components/shell.js';
import { Alert, Spinner } from 'ds/components/content.js';
import { ThemeToggle } from 'ds/components/theme-toggle.js';
import { CommandPalette } from 'ds/components/overlay-primitives.js';
import { state, loadProjects, api, toast } from './data.js';
import {
  Dashboard, ByDay, LiveStream, pushLiveEntry, AllEvents, Search, SubsystemPanel,
  Deviations, Sessions, ProcessTree, QueryPanel, RecallStats, ExecStats, HookStats,
  PrdEditor, MutablesEditor, LifecycleControl, RsTools, Codesearch, GmCallConsole,
  BrowserSessions, ConversationHistory, CodeInsightPanel, MemoryGraphPanel, stopMemoryGraphLayout, SUB_LIST,
  lifecycleAct, runCodesearch, dispatchConsole, liveStreamDebugSnapshot, SkillLayout,
} from './panels.js';

const h = webjsx.createElement;
const root = document.getElementById('root');

const NAV = {
  'skill-layout': 'Skill Layout',
  overview: 'Dashboard', days: 'By Day', live: 'Live Stream', events: 'All Events', 'search-panel': 'Search',
  deviations: 'Deviations', sessions: 'Sessions', tree: 'Process Tree', query: 'Query',
  'recall-panel': 'Recall Stats', 'exec-panel': 'Exec Stats', 'hooks-panel': 'Hook Stats',
  prd: 'PRD Editor', mutables: 'Mutables Editor', lifecycle: 'Lifecycle Control',
  'rs-tools': 'RS Tools', codesearch: 'Codesearch', console: 'GM Call Console',
  'browser-sessions': 'Browser Sessions', conversations: 'Conversations',
  codeinsight: 'CodeInsight', 'memory-graph': 'Memory Graph',
};

const ui = {
  panel: 'skill-layout',
  connState: 'connecting',
  devTotal: 0,
  treeSess: '',
  convSess: '',
  sessListCache: [],
  bodyNode: null,
  health: [],
  paletteOpen: false,
};

// ---------------------------------------------------------------------------
// HASH ROUTING -- the URL is a derived view of {panel, treeSess, convSess},
// never the source of truth (ui.* stays authoritative in memory); read on
// boot, written on every navigation, re-read on popstate/hashchange so browser
// back/forward restores the exact prior panel+sub-state without a page reload.
// Shape: #panel=<id>[&tree=<sess>][&conv=<sess>] -- query-string-in-hash so it
// stays a single flat segment, no nested router needed for this app's depth.
// ---------------------------------------------------------------------------
function parseHash(hash) {
  const raw = (hash || '').replace(/^#/, '');
  const params = new URLSearchParams(raw);
  const panel = params.get('panel');
  return {
    panel: panel && NAV[panel] !== undefined ? panel : (panel && panel.startsWith('sub-') ? panel : null),
    treeSess: params.get('tree') || '',
    convSess: params.get('conv') || '',
  };
}

function hashForState() {
  const params = new URLSearchParams();
  params.set('panel', ui.panel);
  if (ui.panel === 'tree' && ui.treeSess) params.set('tree', ui.treeSess);
  if (ui.panel === 'conversations' && ui.convSess) params.set('conv', ui.convSess);
  return '#' + params.toString();
}

// Pushes a new history entry only when the target state actually differs from
// the current hash -- prevents duplicate history entries on re-renders that
// don't change panel/sub-state (e.g. periodic refreshes), which would
// otherwise make a single Back press feel like it does nothing.
function syncHash() {
  const next = hashForState();
  if (location.hash !== next) history.pushState(null, '', next);
}

// Applies a parsed hash to ui.* without re-pushing history -- used by the
// popstate/hashchange handler so navigating back/forward doesn't itself
// generate a new forward-history entry (that would break Back).
function applyHashState(parsed) {
  if (parsed.panel) ui.panel = parsed.panel;
  ui.treeSess = parsed.treeSess;
  ui.convSess = parsed.convSess;
}

window.addEventListener('popstate', () => {
  applyHashState(parseHash(location.hash));
  expandAdvancedFor(ui.panel);
  renderBody(true).then(focusMain);
});

// Health-banner thresholds: named constants so amber/red logic is auditable and
// adjustable, never magic numbers inline in the render path.
const HEALTH_DEV_RATE_AMBER_PER_MIN = 1; // deviations/min at or above this = amber
const HEALTH_WATCHER_DEAD_MIN = 5; // watcher considered dead-for-N-min at this age
const HEALTH_STALE_FULL_SEC = 5 * 60; // no events for this long = fully stale

function navItem(id, label, extra) {
  return { label, href: '#panel=' + id, active: ui.panel === id, onClick: (e) => { e.preventDefault(); go(id); }, count: extra };
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

// ---------------------------------------------------------------------------
// NAV TIERING -- daily-first sidebar. Daily/Investigate groups always render;
// Subsystems/Analytics/Control sit behind a collapsed-by-default Advanced
// toggle so the observer's first contact is the handful of panels that answer
// "what is happening right now". Demoted panels stay reachable three ways:
// the toggle, the Ctrl+K palette (built from NAV, not from rendered sections),
// and #panel= deep links (navigation auto-expands the group, session-only).
// Persisted value is whitelist-validated: anything but the literal 'open'
// (corrupt value, unavailable storage) falls back to collapsed.
// ---------------------------------------------------------------------------
const NAV_ADV_KEY = 'gmsniff.nav.advanced';
const ADV_PANEL_IDS = new Set(['recall-panel', 'exec-panel', 'hooks-panel', 'rs-tools', 'codeinsight', 'memory-graph',
  'prd', 'mutables', 'lifecycle', 'codesearch', 'console', 'browser-sessions']);
let navAdvanced = (() => { try { return localStorage.getItem(NAV_ADV_KEY) === 'open'; } catch (_) { return false; } })();

function isAdvancedPanel(id) { return ADV_PANEL_IDS.has(id) || (typeof id === 'string' && id.startsWith('sub-')); }

// One-shot: navigating to a demoted panel (deep link, palette, back/forward)
// expands the group for this session without persisting -- a shared deep link
// never overwrites the observer's stored collapsed preference.
function expandAdvancedFor(id) { if (isAdvancedPanel(id)) navAdvanced = true; }

function toggleAdvanced(e) {
  e.preventDefault();
  navAdvanced = !navAdvanced;
  try { localStorage.setItem(NAV_ADV_KEY, navAdvanced ? 'open' : 'collapsed'); } catch (_) {}
  renderShell();
}

// Status-bar glance: PRD/mutable pressure for the scoped project, or a
// watcher-liveness aggregate when unscoped -- all read from state.projects
// (fetched once at boot), zero additional polling surface.
function statusGlance() {
  if (state.cwd) {
    const p = state.projects.find(r => r.cwd === state.cwd);
    return p ? `prd ${p.prd_pending}/${p.prd_total} pending, mut unknown ${p.mut_unknown}` : '';
  }
  if (!state.projects.length) return '';
  const alive = state.projects.filter(r => r.alive).length;
  return `${alive}/${state.projects.length} watchers alive`;
}

function renderShell() {
  const advSections = [
    { group: 'Subsystems', items: SUB_LIST.map(s => navItem('sub-' + s, s)) },
    { group: 'Analytics', items: [navItem('recall-panel', 'Recall Stats'), navItem('exec-panel', 'Exec Stats'), navItem('hooks-panel', 'Hook Stats'), navItem('rs-tools', 'RS Tools'), navItem('codeinsight', 'CodeInsight'), navItem('memory-graph', 'Memory Graph')] },
    { group: 'Control', items: [navItem('prd', 'PRD Editor'), navItem('mutables', 'Mutables Editor'), navItem('lifecycle', 'Lifecycle Control'), navItem('codesearch', 'Codesearch'), navItem('console', 'GM Call Console'), navItem('browser-sessions', 'Browser Sessions')] },
  ];
  const advCount = advSections.reduce((n, s) => n + s.items.length, 0);
  const side = Side({
    sections: [
      { group: 'Daily', items: [navItem('skill-layout', 'Skill Layout'), navItem('overview', 'Dashboard'), navItem('live', 'Live Stream'), navItem('deviations', 'Deviations', ui.devTotal || null), navItem('sessions', 'Sessions')] },
      { group: 'Investigate', items: [navItem('days', 'By Day'), navItem('events', 'All Events'), navItem('search-panel', 'Search'), navItem('tree', 'Process Tree'), navItem('conversations', 'Conversations'), navItem('query', 'Query')] },
      { group: 'Advanced', items: [{ label: navAdvanced ? 'Hide advanced' : 'Show advanced', href: '#', onClick: toggleAdvanced, count: navAdvanced ? null : advCount }] },
      ...(navAdvanced ? advSections : []),
    ],
  });

  const projectSelect = h('select', {
    'aria-label': 'project switcher', class: 'gm-ml-10',
    onchange: (e) => { state.cwd = e.target.value || null; renderBody(); },
  },
    h('option', { value: '' }, 'default (own root)'),
    ...state.projects.map(p => h('option', { value: p.cwd, selected: p.cwd === state.cwd ? true : null }, p.cwd)));

  const topbar = Topbar({ brand: 'gmsniff', leaf: 'observability', items: [] });

  const bodyContainer = h('main', { id: 'panel-body', class: 'gm-panel-body' }, ui.bodyNode || h('p', { class: 'gm-empty' }, 'Loading...'));

  const app = AppShell({
    topbar: h('div', { class: 'gm-row-full' }, topbar, projectSelect,
      h('span', { class: 'gm-row-auto-gap-10' },
        Chip({ tone: ui.connState === 'live' ? 'positive' : (ui.connState === 'reconnecting' ? 'warn' : 'neutral'), children: ui.connState }),
        ThemeToggle({ compact: true }))),
    side,
    // Persistent health banner sits above the panel router (bodyContainer) inside main,
    // so it is visible regardless of which panel is active, and hidden entirely (null) when
    // every discovered project is healthy.
    main: [HealthBanner(), bodyContainer],
    status: Status({ left: ['gmsniff'], right: [state.cwd || '(own root)', statusGlance()].filter(Boolean) }),
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

// force=true means an actual panel switch or explicit refresh (go(), the
// "refresh" affordance in ProcessTree, project-select onchange) -- those are
// the moments the PRD names ("between panel-switch and data arrival") where
// the previous panel's stale content would otherwise linger with zero
// affordance a switch is in flight. force=false/undefined covers ambient
// SSE-driven re-renders (live tick, deviation badge, session-list poll)
// which resolve near-instantly against already-fetched/cached data and must
// stay flicker-free -- gating the spinner on `force` keeps those silent.
async function renderBody(force) {
  if (force) {
    ui.bodyNode = h('div', { class: 'ds-panel gm-panel-loading' }, Spinner({ label: 'loading ' + (NAV[ui.panel] || ui.panel) }));
    renderShell();
  }
  try {
    ui.bodyNode = await computeBody(force);
  } catch (err) {
    // A thrown exception inside a panel's render logic (as opposed to a
    // failed api() fetch, which each panel already surfaces via Empty(...))
    // previously left computeBody's rejection unhandled -- the panel body
    // froze on its last-rendered content with no visible recovery. Surface
    // it as a real error panel (message + stack, one-click back to Dashboard)
    // instead of a silent blank/frozen app.
    const message = err && err.message ? err.message : String(err);
    ui.bodyNode = h('div', { class: 'ds-panel' },
      Alert({
        kind: 'error',
        title: `Panel "${ui.panel}" failed to render`,
        children: [
          h('p', {}, message),
          err && err.stack ? h('pre', { class: 'gm-json' }, err.stack) : null,
          h('div', { class: 'gm-mt-8' }, Btn({ children: 'Back to Dashboard', onClick: () => go('overview') })),
        ],
      }));
  }
  renderShell();
}

async function computeBody(force) {
  const p = ui.panel;
  const setBody = (f) => renderBody(f);
  if (p !== 'memory-graph') stopMemoryGraphLayout();
  if (p === 'skill-layout') return SkillLayout(setBody);
  if (p === 'overview') return Dashboard({ onNav: go, devTotal: ui.devTotal, health: ui.health });
  if (p === 'days') return ByDay();
  if (p === 'live') return LiveStream({ connState: ui.connState }, setBody);
  if (p === 'events') return AllEvents(setBody);
  if (p === 'search-panel') return Search(setBody);
  if (p.startsWith('sub-')) return SubsystemPanel(p.slice(4), setBody);
  if (p === 'deviations') return Deviations(setBody);
  if (p === 'sessions') return Sessions((sess) => { ui.treeSess = sess; ui.panel = 'tree'; syncHash(); renderBody(true).then(focusMain); }, setBody);
  if (p === 'tree') {
    if (!ui.sessListCache.length || force) { const r = await api('/api/sessions?limit=200'); ui.sessListCache = r.rows || []; }
    return ProcessTree(ui.treeSess, ui.sessListCache, (sess) => { ui.treeSess = sess; syncHash(); renderBody(); },
      (sess) => { ui.convSess = sess; ui.panel = 'conversations'; syncHash(); renderBody(true).then(focusMain); },
      () => renderBody(true)); // refresh: force=true re-fetches sessListCache + process-tree via this same computeBody path
  }
  if (p === 'conversations') {
    if (!ui.sessListCache.length || force) { const r = await api('/api/sessions?limit=200'); ui.sessListCache = r.rows || []; }
    return ConversationHistory(ui.convSess, ui.sessListCache, (sess) => { ui.convSess = sess; syncHash(); renderBody(); });
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

// Keyboard-only nav: webjsx reuses the sidebar <a> DOM node across the
// re-diff (same key/position), so without this the browser keeps native
// focus parked on the sidebar link the user just activated -- the new
// panel renders but focus never moves into it, silent for AT users.
// #app-main already carries tabindex="-1" for the skip-link (shell.js);
// reuse it as the programmatic landing target on every panel-identity
// change (nav click, palette nav, browser back/forward), but never on a
// same-panel refresh (SSE push, poll) -- that would steal focus from
// whatever the user is doing mid-panel for no navigational reason.
function focusMain() {
  const main = document.getElementById('app-main');
  if (main) main.focus();
}

async function go(id) {
  ui.panel = id;
  expandAdvancedFor(id);
  syncHash();
  await renderBody(true);
  focusMain();
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
      // Skill Layout's instruction+output feed only changes on plugkit dispatch/phase events
      // (not every raw log line -- e.g. hook/exec noise from an unrelated subsystem would
      // otherwise force a full projects/live-state re-fetch on every tick), so gate the
      // re-render to the same event family project.phase-changed already uses.
      if (ui.panel === 'skill-layout' && ev._sub === 'plugkit') renderBody();
    } catch (_) {}
  });
  sse.addEventListener('project.phase-changed', () => { if (ui.panel === 'skill-layout') renderBody(); });
  sse.onerror = () => {
    ui.connState = 'reconnecting'; renderShell();
    try { sse.close(); } catch (_) {}
    setTimeout(connectSSE, Math.min(reconnectDelay, 15000));
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

async function boot() {
  applyHashState(parseHash(location.hash));
  expandAdvancedFor(ui.panel);
  // Canonicalize the hash immediately (covers both a bare load with no hash,
  // where this establishes #panel=overview, and a hash naming an unknown
  // panel, where applyHashState already fell back to the default and this
  // writes that corrected value back) -- replaceState so boot never adds an
  // extra history entry a single Back press would need to skip past.
  history.replaceState(null, '', hashForState());
  await loadProjects();
  renderShell();
  await renderBody();
  refreshDeviationBadge();
  setInterval(refreshDeviationBadge, 10000);
  connectSSE();
  window.gmsniff = { state, ui, go, renderBody, renderShell, openPalette, closePalette, buildCommandRegistry, parseHash, hashForState, syncHash, liveStreamDebugSnapshot, isAdvancedPanel, getNavAdvanced: () => navAdvanced, statusGlance };
}

boot();
