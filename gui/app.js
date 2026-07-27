import * as webjsx from 'webjsx';
import { AppShell, Topbar, Side, Status, Chip, Btn } from 'ds/components/shell.js';
import { Alert, Spinner } from 'ds/components/content.js';
import { ThemeToggle } from 'ds/components/theme-toggle.js';
import { CommandPalette } from 'ds/components/overlay-primitives.js';
import { state, loadProjects, api, toast } from './data.js';
import {
  Dashboard, ByDay, LiveStream, pushLiveEntry, AllEvents, SubsystemPanel,
  Deviations, Sessions, ProcessTree,
  PrdEditor, MutablesEditor, LifecycleControl, Codesearch, GmCallConsole,
  BrowserSessions, CodeInsightPanel, MemoryGraphPanel, stopMemoryGraphLayout,
  lifecycleAct, runCodesearch, dispatchConsole, liveStreamDebugSnapshot,
} from './panels.js';
import {
  LiveAgents, liveState, appendLiveEvent, appendOutputBatch, applyAutoscroll, loadAgentContext,
  openDrilldown, closeDrilldown, agentKey,
} from './live-agents.js';
import { loadCapabilities, subsystemList, basename } from './shared.js';

const h = webjsx.createElement;
const root = document.getElementById('root');

// Panels removed in this rework, kept ONLY as redirect targets so an existing
// bookmark or shared deep link lands somewhere sensible instead of dead-ending:
//   skill-layout  -> agents      (renamed; this IS the same view, rebuilt)
//   search-panel  -> events      (Search was a second UI over the same rows)
//   conversations -> tree        (a strict 6-of-27-kind subset of Process Tree)
const PANEL_ALIASES = {
  'skill-layout': 'agents',
  'search-panel': 'events',
  conversations: 'tree',
};

const NAV = {
  agents: 'Live Agents',
  overview: 'Dashboard', days: 'By Day', live: 'Live Stream', events: 'All Events',
  deviations: 'Deviations', sessions: 'Sessions', tree: 'Process Tree',
  prd: 'PRD Editor', mutables: 'Mutables Editor', lifecycle: 'Lifecycle Control',
  codesearch: 'Codesearch', console: 'GM Call Console',
  'browser-sessions': 'Browser Sessions',
  codeinsight: 'CodeInsight', 'memory-graph': 'Memory Graph',
};

const ui = {
  panel: 'agents',
  connState: 'connecting',
  devTotal: 0,
  treeSess: '',
  bodyNode: null,
  health: [],
  paletteOpen: false,
  sessListCache: [],
  lastEventId: null,
  missedFrames: 0,
  streamNote: null,
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
  let panel = params.get('panel');
  if (panel && PANEL_ALIASES[panel]) panel = PANEL_ALIASES[panel];
  return {
    panel: panel && NAV[panel] !== undefined ? panel : (panel && panel.startsWith('sub-') ? panel : null),
    treeSess: params.get('tree') || '',
    // Live Agents sub-state: which agent's drilldown is open and what the list
    // is filtered to, so "look at this agent right now" is a shareable link.
    agent: params.get('agent') || '',
    filter: params.get('q') || '',
  };
}

function hashForState() {
  const params = new URLSearchParams();
  params.set('panel', ui.panel);
  if (ui.panel === 'tree' && ui.treeSess) params.set('tree', ui.treeSess);
  if (ui.panel === 'agents') {
    if (liveState.open) params.set('agent', liveState.open);
    if (liveState.filter) params.set('q', liveState.filter);
  }
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
  liveState.open = parsed.agent || null;
  liveState.filter = parsed.filter || '';
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

// Says WHY each named project is unhealthy. A bare "Health: critical" followed
// by 140 comma-separated names states a severity without a cause and buries the
// live agents under the machine's entire abandoned backlog -- so the banner now
// carries the reason per project, caps the list, and says how many it omitted.
const HEALTH_BANNER_MAX = 6;

function healthReason(r) {
  const bits = [];
  if (!r.watcherAlive) bits.push('watcher not running');
  if (r.staleSeconds == null) bits.push('no events ever');
  else if (r.staleSeconds >= HEALTH_STALE_FULL_SEC) bits.push(`silent ${Math.round(r.staleSeconds / 60)}m`);
  if ((r.deviationRate || 0) >= HEALTH_DEV_RATE_AMBER_PER_MIN) bits.push(`${r.deviationRate.toFixed(1)} deviations/min`);
  return bits.join(', ') || 'degraded';
}

// A stopped watcher on a project that FINISHED or was abandoned months ago is
// not a health incident -- it is the normal resting state of 674 of the 678
// directories discovery finds on this machine. Measured in the real browser, the
// unscoped banner rendered "Health: critical (676 of 678 projects)" above the
// live view on every page: a severity with no cause, computed over dead history.
//
// Health is therefore judged ONLY over the population the live view is actually
// managing -- the agents live-state reports as working. A project nobody is
// running cannot be unhealthy, so it is excluded rather than counted and capped.
function healthScope() {
  const working = new Set((liveState.rows || []).map(r => r.cwd));
  const rows = ui.health || [];
  // Before live-state has landed, scope to nothing rather than to everything:
  // an unscoped banner is precisely the false alarm being removed, and it would
  // flash during exactly the slow-boot window.
  return { rows: rows.filter(r => working.has(r.cwd)), total: working.size };
}

function HealthBanner() {
  const { rows, total } = healthScope();
  const offending = rows.map(r => ({ ...r, severity: healthRowSeverity(r) })).filter(r => r.severity !== 'ok');
  if (!offending.length) return null;
  const tone = offending.some(r => r.severity === 'red') ? 'red' : 'amber';
  const ranked = [...offending].sort((a, b) => (b.deviationRate || 0) - (a.deviationRate || 0));
  const shown = ranked.slice(0, HEALTH_BANNER_MAX);
  const omitted = ranked.length - shown.length;
  return h('div', { class: 'gm-health-banner gm-health-' + tone, role: 'alert' },
    // Names WHAT is wrong and over WHICH population, and every listed project is
    // a button that scopes to it -- a severity you can act on, not a bare word.
    h('span', { class: 'gm-health-label' },
      `${offending.length} of ${total} working agent${total === 1 ? '' : 's'} ${tone === 'red' ? 'stalled' : 'degraded'}`),
    h('span', { class: 'gm-health-list' }, ...shown.map(r => h('button', {
      type: 'button',
      key: 'health-' + r.cwd,
      class: 'gm-health-item gm-health-item-' + r.severity,
      title: `${r.cwd} -- ${healthReason(r)}`,
      onclick: () => switchToProject(r.cwd),
    }, `${r.name} (${healthReason(r)})`))),
    omitted > 0 ? h('span', { class: 'gm-health-omitted' }, `and ${omitted} more`) : null);
}

// A dropped/resumed stream, or a watcher failing, previously produced no visible
// reaction at all -- the UI simply stopped updating and looked idle. This states
// the transport's condition so a quiet screen is never mistaken for a quiet system.
function StreamNote() {
  if (!ui.streamNote) return null;
  return h('div', {
    class: 'gm-stream-note', role: 'status', 'aria-live': 'polite',
  },
    h('span', {}, ui.streamNote),
    h('button', {
      type: 'button', class: 'gm-stream-note-x',
      onclick: () => { ui.streamNote = null; renderShell(); },
      'aria-label': 'dismiss',
    }, 'x'));
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
const ADV_PANEL_IDS = new Set(['codeinsight', 'memory-graph',
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
    { group: 'Subsystems', items: subsystemList().map(s => navItem('sub-' + s, s)) },
    { group: 'Analytics', items: [navItem('codeinsight', 'CodeInsight'), navItem('memory-graph', 'Memory Graph')] },
    { group: 'Control', items: [navItem('prd', 'PRD Editor'), navItem('mutables', 'Mutables Editor'), navItem('lifecycle', 'Lifecycle Control'), navItem('codesearch', 'Codesearch'), navItem('console', 'GM Call Console'), navItem('browser-sessions', 'Browser Sessions')] },
  ];
  const advCount = advSections.reduce((n, s) => n + s.items.length, 0);
  // Exactly ONE live view leads. Live Agents is the manager surface; everything
  // else is a forensic tool you reach for after it tells you where to look, so
  // Investigate is collapsed alongside the other secondary groups rather than
  // competing with the lead view for first attention.
  const side = Side({
    sections: [
      { group: 'Live', items: [navItem('agents', 'Live Agents')] },
      { group: 'Investigate', items: [
        navItem('deviations', 'Deviations', ui.devTotal || null),
        navItem('live', 'Live Stream'),
        navItem('events', 'All Events'),
        navItem('sessions', 'Sessions'),
        navItem('tree', 'Process Tree'),
        navItem('overview', 'Dashboard'),
        navItem('days', 'By Day'),
      ] },
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
    main: [HealthBanner(), StreamNote(), bodyContainer],
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
// Scoped re-render: an ambient data update only needs the panel container
// re-diffed, not the whole shell (sidebar, topbar, status bar, palette host).
// renderShell() stays the path for anything that actually changes the shell
// (nav counts, connection chip, health banner) -- everything else lands here.
function renderPanelOnly() {
  const container = document.getElementById('panel-body');
  if (!container) { renderShell(); return; }
  webjsx.applyDiff(container, h('main', { id: 'panel-body', class: 'gm-panel-body' }, ui.bodyNode));
  applyAutoscroll();
}

// SSE frames arrive in bursts (a single agent turn emits dispatch.start,
// several prd.*, instruction.served and dispatch.end within a few ms). Rendering
// each one synchronously meant a full refetch + full shell re-diff per frame.
// Coalescing into one animation frame collapses a burst into a single render.
let renderQueued = false;
let renderWantsFetch = false;
function scheduleRender({ refetch = false } = {}) {
  renderWantsFetch = renderWantsFetch || refetch;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(async () => {
    renderQueued = false;
    const wantFetch = renderWantsFetch;
    renderWantsFetch = false;
    if (wantFetch) {
      await renderBody();
    } else {
      // No refetch: the panel's own client-held state already changed (a feed
      // append), so re-render the panel from that state alone.
      try {
        ui.bodyNode = await computeBody(false);
        renderPanelOnly();
      } catch (_) { await renderBody(); }
    }
  });
}

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
  applyAutoscroll();
}

async function computeBody(force) {
  const p = ui.panel;
  const setBody = (f) => renderBody(f);
  if (p !== 'memory-graph') stopMemoryGraphLayout();
  if (p === 'agents') return LiveAgents({ connState: ui.connState, onNav: go }, setBody);
  if (p === 'overview') return Dashboard({ onNav: go, devTotal: ui.devTotal, health: ui.health });
  if (p === 'days') return ByDay();
  if (p === 'live') return LiveStream({ connState: ui.connState }, setBody);
  if (p === 'events') return AllEvents(setBody);
  if (p.startsWith('sub-')) return SubsystemPanel(p.slice(4), setBody);
  if (p === 'deviations') return Deviations(setBody);
  if (p === 'sessions') return Sessions((sess) => { ui.treeSess = sess; ui.panel = 'tree'; syncHash(); renderBody(true).then(focusMain); }, setBody);
  if (p === 'tree') {
    if (!ui.sessListCache.length || force) { const r = await api('/api/sessions?limit=200'); ui.sessListCache = r.rows || []; }
    return ProcessTree(ui.treeSess, ui.sessListCache, (sess) => { ui.treeSess = sess; syncHash(); renderBody(); },
      null,
      () => renderBody(true)); // refresh: force=true re-fetches sessListCache + process-tree via this same computeBody path
  }
  if (p === 'prd') return PrdEditor(setBody);
  if (p === 'mutables') return MutablesEditor(setBody);
  if (p === 'lifecycle') return LifecycleControl(setBody);
  if (p === 'codesearch') return Codesearch(setBody);
  if (p === 'console') return GmCallConsole(setBody);
  if (p === 'browser-sessions') return BrowserSessions();
  if (p === 'codeinsight') return CodeInsightPanel(setBody);
  if (p === 'memory-graph') return MemoryGraphPanel();
  // Unknown panel id (removed panel, stale bookmark/deep link) -- degrade to the
  // default landing panel rather than a dead end. PANEL_ALIASES already redirects
  // the ids this rework retired; this catches anything else.
  ui.panel = 'agents';
  syncHash();
  return LiveAgents({ connState: ui.connState, onNav: go }, setBody);
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

// ---------------------------------------------------------------------------
// SSE SUBSCRIPTION REGISTRY -- panels declare which frame families they care
// about instead of app.js carrying a hardcoded if-ladder on ui.panel. A frame
// that matches no subscription costs nothing; a panel added later subscribes
// here rather than editing the dispatch path.
//
// `wants` returns 'append' (the panel updated its own client-held state, so
// re-render from that without a refetch) or 'refetch' (the panel's server data
// genuinely changed) or false.
// ---------------------------------------------------------------------------
const SSE_SUBSCRIPTIONS = [
  {
    panel: 'agents',
    wants: (ev) => {
      // Incremental append: the frame lands directly in the matching agent's
      // feed and the panel re-renders from client state -- no live-state
      // refetch, no lost scroll position.
      const key = appendLiveEvent(ev, liveState.rows);
      if (key) return 'append';
      // A plugkit frame for a project we are NOT tracking yet is a genuinely new
      // agent, which does require pulling the roster.
      return ev._sub === 'plugkit' ? 'refetch' : false;
    },
  },
  { panel: 'live', wants: () => 'append' },
  { panel: 'overview', wants: (ev) => (ev._sub === 'plugkit' ? 'refetch' : false) },
  { panel: 'sessions', wants: (ev) => (ev._sub === 'plugkit' ? 'refetch' : false) },
  { panel: 'deviations', wants: (ev) => (isDeviation(ev) ? 'refetch' : false) },
];

function isDeviation(ev) {
  return typeof ev.event === 'string' && ev.event.startsWith('deviation.');
}

// Notify-on-state-change: transitions, deviations and gate denials bump a
// title-bar counter while the tab is hidden, so gmsniff is useful unattended.
let unseenCount = 0;
const BASE_TITLE = document.title;
function noteStateChange(ev) {
  const notable = isDeviation(ev) || ev.event === 'phase.transitioned';
  if (!notable) return;
  if (document.visibilityState === 'hidden') {
    unseenCount++;
    document.title = `(${unseenCount}) ${BASE_TITLE}`;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { unseenCount = 0; document.title = BASE_TITLE; }
});

let sse = null;
let reconnectDelay = 1000;

function handleFrame(ev) {
  pushLiveEntry(ev);
  noteStateChange(ev);
  if (isDeviation(ev)) refreshDeviationBadge();
  let mode = false;
  for (const sub of SSE_SUBSCRIPTIONS) {
    if (sub.panel !== ui.panel) continue;
    const want = sub.wants(ev);
    if (want === 'refetch') { mode = 'refetch'; break; }
    if (want === 'append') mode = mode || 'append';
  }
  if (mode) scheduleRender({ refetch: mode === 'refetch' });
}

function connectSSE() {
  // Last-Event-ID replay: EventSource sends the header automatically from the
  // `id:` field the server already emits, so a reconnect after a backoff gap
  // resumes rather than silently dropping whatever arrived while disconnected.
  sse = new EventSource('/api/stream');

  sse.addEventListener('hello', () => {
    ui.connState = 'live';
    reconnectDelay = 1000;
    ui.streamNote = ui.missedFrames ? `resumed -- ${ui.missedFrames} frame(s) may have been missed while disconnected` : null;
    renderShell();
    if (ui.panel === 'live' || ui.panel === 'agents') scheduleRender({ refetch: true });
  });

  sse.addEventListener('event', (e) => {
    if (e.lastEventId) ui.lastEventId = e.lastEventId;
    try { handleFrame(JSON.parse(e.data)); } catch (_) {}
  });

  // Previously ignored entirely: a watcher dying or a new agent starting
  // produced NO UI reaction at all. Each now updates the roster and says so.
  sse.addEventListener('error', (e) => {
    // A server-sent `error` FRAME (a watcher failed) -- distinct from the
    // transport-level onerror below, which fires with no data.
    if (!e || !e.data) return;
    try {
      const payload = JSON.parse(e.data);
      toast(`Watcher error${payload.cwd ? ' in ' + basename(payload.cwd) : ''}: ${payload.error || payload.message || 'unknown'}`, true);
      ui.streamNote = `watcher error: ${payload.error || payload.message || 'unknown'}`;
      renderShell();
    } catch (_) {}
  });

  sse.addEventListener('project.added', (e) => {
    let cwd = null;
    try { cwd = JSON.parse(e.data).cwd; } catch (_) {}
    toast(`New agent started${cwd ? ': ' + basename(cwd) : ''}`);
    loadProjects();
    scheduleRender({ refetch: true });
  });

  sse.addEventListener('project.removed', (e) => {
    let cwd = null;
    try { cwd = JSON.parse(e.data).cwd; } catch (_) {}
    toast(`Agent stopped${cwd ? ': ' + basename(cwd) : ''}`);
    // A project can vanish mid-watch (a removed worktree). Drop it from the
    // roster so the open drilldown degrades to its "no longer present" state
    // instead of rendering a row backed by nothing.
    if (cwd) liveState.rows = liveState.rows.filter(r => r.cwd !== cwd);
    loadProjects();
    scheduleRender({ refetch: true });
  });

  sse.addEventListener('project.phase-changed', () => {
    if (ui.panel === 'agents' || ui.panel === 'overview') scheduleRender({ refetch: true });
  });

  // The incremental output frame: pre-normalized nodes for one agent, appended
  // straight into its feed. Without this listener the server emits the frame and
  // nothing receives it, so the panel falls back to refetching the whole
  // live-state payload on every raw event -- the exact cost this frame exists to
  // avoid.
  sse.addEventListener('agent.output', (e) => {
    if (e.lastEventId) ui.lastEventId = e.lastEventId;
    let batch = null;
    try { batch = JSON.parse(e.data); } catch (_) { return; }
    const key = appendOutputBatch(batch, liveState.rows);
    if (key && ui.panel === 'agents') scheduleRender({ refetch: false });
  });

  sse.onerror = () => {
    ui.connState = 'reconnecting';
    ui.missedFrames++;
    ui.streamNote = 'live stream disconnected -- reconnecting, events during the gap will be replayed';
    renderShell();
    try { sse.close(); } catch (_) {}
    setTimeout(connectSSE, Math.min(reconnectDelay, 15000));
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

async function boot() {
  applyHashState(parseHash(location.hash));
  expandAdvancedFor(ui.panel);
  // Capabilities before the first paint: the verb allowlist and subsystem
  // universe are server-published, and painting a hardcoded copy of either
  // first is exactly the drift this replaces.
  // Canonicalize the hash immediately (covers both a bare load with no hash,
  // where this establishes #panel=agents, and a hash naming an unknown
  // panel, where applyHashState already fell back to the default and this
  // writes that corrected value back) -- replaceState so boot never adds an
  // extra history entry a single Back press would need to skip past.
  history.replaceState(null, '', hashForState());

  // BOOT MUST PAINT BEFORE IT FETCHES. Measured in real Chrome against this
  // machine's 678 discovered projects: /api/capabilities 3.7s, live-state 10.9s,
  // /api/projects 17.0s. Awaiting them in series before the first paint left the
  // panel reading a bare "Loading..." for ~30s with no affordance -- the exact
  // "empty vs loading vs broken must never render identically" failure this
  // rework exists to remove, and the single worst first-contact defect in the UI.
  //
  // Order is now: shell -> panel (with its own honest loading state) -> the slow
  // roster/capability loads in parallel, each re-rendering when it lands.
  // Exposed BEFORE the awaits, not after: this is the debug/inspection surface,
  // and hanging it off the end of boot meant it was undefined for exactly the
  // ~30s window in which someone would want to inspect a slow boot.
  window.gmsniff = {
    state, ui, go, renderBody, renderShell, openPalette, closePalette, buildCommandRegistry,
    parseHash, hashForState, syncHash, liveStreamDebugSnapshot, isAdvancedPanel,
    getNavAdvanced: () => navAdvanced, statusGlance,
    liveState, agentKey, openDrilldown, closeDrilldown, scheduleRender,
  };

  renderShell();
  const panelPaint = renderBody(true);

  // Capabilities and the project roster are both refinements, not preconditions:
  // the verb allowlist has a seed fallback and pendingLabel() degrades to an
  // event count, so neither blocks first paint. They run concurrently and each
  // repaints on arrival rather than gating the other.
  const caps = loadCapabilities().then(() => renderShell());
  const projects = loadProjects().then(() => { renderShell(); scheduleRender({ refetch: false }); });

  await panelPaint;
  refreshDeviationBadge();
  setInterval(refreshDeviationBadge, 10000);
  // Elapsed times ("in EXECUTE for 4m", "last output 30s ago") are derived from
  // wall-clock, so they go stale on a silent stream. A slow tick re-renders the
  // lead view from already-held state -- no fetch, no flicker.
  setInterval(() => { if (ui.panel === 'agents' && !liveState.open) scheduleRender({ refetch: false }); }, 15000);
  connectSSE();
  // Gates and driving prompts used to need a side-channel route. The live-state
  // payload now carries `gates` and `last_prompt` on every row directly (measured
  // against the real route), so this is a no-op fallback for an older server and
  // is deliberately NOT awaited or relied upon.
  loadAgentContext(liveState.rows.map(r => r.cwd), () => scheduleRender({ refetch: false }));
  await Promise.allSettled([caps, projects]);
}

boot();
