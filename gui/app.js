import * as webjsx from 'webjsx';
import { AppShell, Topbar, Side, Status, Chip, Btn } from 'ds/components/shell.js';
import { Alert, Spinner } from 'ds/components/content.js';
import { ThemeToggle } from 'ds/components/theme-toggle.js';
import { CommandPalette } from 'ds/components/overlay-primitives.js';
import { Toggle } from 'ds/components/form-primitives.js';
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
import { loadCapabilities, subsystemList, basename, longestSilentFirst } from './shared.js';

const h = webjsx.createElement;
const root = document.getElementById('root');

// Panels that no longer exist, kept only so an existing bookmark or shared deep
// link lands on the panel that replaced it instead of dead-ending: skill-layout
// was renamed to agents, search-panel was a second UI over the same rows as
// events, and conversations was a strict 6-of-27-kind subset of tree.
const REMOVED_PANEL_REDIRECTS = {
  'skill-layout': 'agents',
  'search-panel': 'events',
  conversations: 'tree',
};

// Subsystem panels are generated per observed tag rather than listed in NAV, so
// their ids are the only ones carrying a prefix instead of a NAV entry.
const SUBSYSTEM_PANEL_PREFIX = 'sub-';

const NAV = {
  agents: 'Live Agents',
  overview: 'Dashboard', days: 'By Day', live: 'Live Stream', events: 'All Events',
  deviations: 'Deviations', sessions: 'Sessions', tree: 'Process Tree',
  prd: 'PRD Editor', mutables: 'Mutables Editor', lifecycle: 'Lifecycle Control',
  codesearch: 'Codesearch', console: 'GM Call Console',
  'browser-sessions': 'Browser Sessions',
  codeinsight: 'CodeInsight', 'memory-graph': 'Memory Graph',
};

const DEFAULT_PANEL = 'agents';

const ui = {
  panel: DEFAULT_PANEL,
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

// The URL is a derived VIEW of ui.*, never the source of truth: ui.* stays
// authoritative in memory, and the hash is read on boot, written on every
// navigation, and re-read on popstate so back/forward restores the exact prior
// panel and sub-state without a page reload. Query-string-in-hash keeps it a
// single flat segment; this app's depth never warranted a nested router.
function parseHash(hash) {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  let panel = params.get('panel');
  if (panel && REMOVED_PANEL_REDIRECTS[panel]) panel = REMOVED_PANEL_REDIRECTS[panel];
  const isKnownPanel = panel && NAV[panel] !== undefined;
  const isSubsystemPanel = panel && panel.startsWith(SUBSYSTEM_PANEL_PREFIX);
  return {
    panel: isKnownPanel ? panel : (isSubsystemPanel ? panel : null),
    treeSess: params.get('tree') || '',
    // Which agent's drilldown is open and what the list is filtered to, so
    // "look at this agent right now" is a shareable link.
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

// Pushing only when the target state actually differs keeps a periodic refresh
// from stacking duplicate history entries, which would make a single Back press
// feel like it does nothing.
function syncHash() {
  const next = hashForState();
  if (location.hash !== next) history.pushState(null, '', next);
}

// Deliberately does NOT push history: the popstate handler calls this, and
// pushing there would generate a new forward entry and break Back.
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

function navItem(id, label, extra) {
  return { label, href: '#panel=' + id, active: ui.panel === id, onClick: (e) => { e.preventDefault(); go(id); }, count: extra };
}

// Every palette entry invokes the exact same handler function the panel's own
// control calls, never a simulated click on a rendered element.
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

// PRD/Mutables edits are per-row inline inputs inside their panels, so the
// palette's role is navigation to the editor; the field commit itself still
// goes through the identical /api/prd/edit path once the row is in view.
function editorPaletteEntries() {
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

function switchToProject(cwd) {
  state.cwd = cwd || null;
  renderBody();
}

// Every working agent appears, so a condition no threshold anticipated is
// visible rather than merely unranked. Ordering is longest-silent first because
// that is the measurement most likely to be the reason someone opened the page,
// and the list caps only for space, always naming the count it omitted.
const HEALTH_BANNER_PROJECTS_SHOWN = 6;
const SEC_PER_MIN = 60;

// The three measurements the health route actually reports, each rendered as its
// own number with its own age. No sum, no score, no label standing in for them:
// "watcher not running" plus "silent 198m" is what the reader needs, and
// collapsing that pair into the word "stalled" throws away both halves.
function healthMeasurements(r) {
  const silence = r.staleSeconds == null
    ? 'no events ever recorded'
    : `silent ${Math.round(r.staleSeconds / SEC_PER_MIN)}m`;
  return [
    `watcher ${r.watcherAlive ? 'running' : 'not running'}`,
    silence,
    `${(r.deviationRate || 0).toFixed(1)} deviations/min`,
  ].join(', ');
}

// A stopped watcher on a project that FINISHED or was abandoned months ago is
// not a health incident -- it is the normal resting state of 674 of the 678
// directories discovery finds on this machine. Measured in the real browser, the
// unscoped banner rendered "Health: critical (676 of 678 projects)" above the
// live view on every page: a severity with no cause, computed over dead history.
// Health is therefore judged only over the agents live-state reports as working.
//
// Before live-state lands this scopes to NOTHING rather than to everything: an
// unscoped banner is precisely the false alarm being removed here, and it would
// otherwise flash during exactly the slow-boot window.
function healthScopedToWorkingAgents() {
  const workingCwds = new Set((liveState.rows || []).map(r => r.cwd));
  return {
    rows: (ui.health || []).filter(r => workingCwds.has(r.cwd)),
    total: workingCwds.size,
  };
}

function HealthBanner() {
  const { rows, total } = healthScopedToWorkingAgents();
  if (!rows.length) return null;
  const longestSilent = [...rows].sort(longestSilentFirst);
  const shown = longestSilent.slice(0, HEALTH_BANNER_PROJECTS_SHOWN);
  const omitted = longestSilent.length - shown.length;
  return h('div', { class: 'gm-health-banner', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'gm-health-label' },
      `${total} working agent${total === 1 ? '' : 's'}, longest-silent first`),
    h('span', { class: 'gm-health-list' }, ...shown.map(r => h('button', {
      type: 'button',
      key: 'health-' + r.cwd,
      class: 'gm-health-item',
      title: `${r.cwd} -- ${healthMeasurements(r)}`,
      onclick: () => switchToProject(r.cwd),
    }, `${r.name} (${healthMeasurements(r)})`))),
    omitted > 0
      ? h('span', { class: 'gm-health-omitted' },
          `+${omitted} more working agent${omitted === 1 ? '' : 's'} not shown (list caps at ${HEALTH_BANNER_PROJECTS_SHOWN}) -- open Live Agents for all`)
      : null);
}

// A dropped stream or a failing watcher previously produced no visible reaction
// at all: the UI simply stopped updating and looked idle. Stating the
// transport's condition is what keeps a quiet screen from reading as a quiet
// system.
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

const NAV_ADVANCED_STORAGE_KEY = 'gmsniff.nav.advanced';
const NAV_ADVANCED_OPEN = 'open';
const NAV_ADVANCED_COLLAPSED = 'collapsed';
const ADVANCED_PANEL_IDS = new Set(['codeinsight', 'memory-graph',
  'prd', 'mutables', 'lifecycle', 'codesearch', 'console', 'browser-sessions']);

// Whitelist-validated rather than truthy-checked, so a corrupt stored value or
// an unavailable localStorage both land on collapsed rather than on open.
let navAdvanced = (() => {
  try { return localStorage.getItem(NAV_ADVANCED_STORAGE_KEY) === NAV_ADVANCED_OPEN; } catch (_) { return false; }
})();

function isAdvancedPanel(id) {
  return ADVANCED_PANEL_IDS.has(id) || (typeof id === 'string' && id.startsWith(SUBSYSTEM_PANEL_PREFIX));
}

// Session-only and never persisted, so a shared deep link into a demoted panel
// cannot overwrite the observer's own stored collapsed preference.
function expandAdvancedFor(id) { if (isAdvancedPanel(id)) navAdvanced = true; }

function toggleAdvanced(e) {
  e.preventDefault();
  navAdvanced = !navAdvanced;
  try {
    localStorage.setItem(NAV_ADVANCED_STORAGE_KEY, navAdvanced ? NAV_ADVANCED_OPEN : NAV_ADVANCED_COLLAPSED);
  } catch (_) {}
  renderShell();
}

// Reads only from state.projects, fetched once at boot, so the status bar adds
// no polling surface of its own.
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
  const advancedSections = [
    { group: 'Subsystems', items: subsystemList().map(s => navItem(SUBSYSTEM_PANEL_PREFIX + s, s)) },
    { group: 'Analytics', items: [navItem('codeinsight', 'CodeInsight'), navItem('memory-graph', 'Memory Graph')] },
    { group: 'Control', items: [navItem('prd', 'PRD Editor'), navItem('mutables', 'Mutables Editor'), navItem('lifecycle', 'Lifecycle Control'), navItem('codesearch', 'Codesearch'), navItem('console', 'GM Call Console'), navItem('browser-sessions', 'Browser Sessions')] },
  ];
  const advancedPanelCount = advancedSections.reduce((n, s) => n + s.items.length, 0);
  // Exactly ONE live view leads: Live Agents is the manager surface and
  // everything else is a forensic tool you reach for after it tells you where to
  // look, so Investigate collapses alongside the other secondary groups rather
  // than competing with the lead view for first attention.
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
      { group: 'Advanced', items: [{ label: navAdvanced ? 'Hide advanced' : 'Show advanced', href: '#', onClick: toggleAdvanced, count: navAdvanced ? null : advancedPanelCount }] },
      ...(navAdvanced ? advancedSections : []),
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
    main: [StateChangeSignal(), HealthBanner(), StreamNote(), bodyContainer],
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

// An ambient data update only needs the panel container re-diffed, not the whole
// shell. renderShell() stays the path for anything that actually changes the
// shell -- nav counts, the connection chip, the health banner.
function renderPanelOnly() {
  const container = document.getElementById('panel-body');
  if (!container) { renderShell(); return; }
  webjsx.applyDiff(container, h('main', { id: 'panel-body', class: 'gm-panel-body' }, ui.bodyNode));
  applyAutoscroll();
}

// SSE frames arrive in bursts -- a single agent turn emits dispatch.start,
// several prd.*, instruction.served and dispatch.end within a few ms -- and
// rendering each synchronously cost a full refetch plus a full shell re-diff per
// frame. Coalescing into one animation frame collapses a burst into one render.
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
      return;
    }
    // The panel's own client-held state already changed (a feed append), so the
    // panel re-renders from that state alone.
    try {
      ui.bodyNode = await computeBody(false);
      renderPanelOnly();
    } catch (_) { await renderBody(); }
  });
}

// isPanelSwitchOrExplicitRefresh gates the spinner. A panel switch or an
// explicit refresh is the one moment the previous panel's stale content would
// otherwise linger with no affordance that a switch is in flight; ambient
// SSE-driven re-renders resolve near-instantly against already-fetched data and
// must stay flicker-free, so they pass it false.
async function renderBody(isPanelSwitchOrExplicitRefresh) {
  if (isPanelSwitchOrExplicitRefresh) {
    ui.bodyNode = h('div', { class: 'ds-panel gm-panel-loading' }, Spinner({ label: 'loading ' + (NAV[ui.panel] || ui.panel) }));
    renderShell();
  }
  try {
    ui.bodyNode = await computeBody(isPanelSwitchOrExplicitRefresh);
  } catch (err) {
    // A thrown exception inside a panel's own render logic -- as opposed to a
    // failed api() fetch, which each panel already surfaces itself -- previously
    // left this rejection unhandled and the panel body froze on its
    // last-rendered content with no visible recovery.
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

async function computeBody(isPanelSwitchOrExplicitRefresh) {
  const p = ui.panel;
  const setBody = (f) => renderBody(f);
  if (p !== 'memory-graph') stopMemoryGraphLayout();
  if (p === 'agents') return LiveAgents({ connState: ui.connState, onNav: go }, setBody);
  if (p === 'overview') return Dashboard({ onNav: go, devTotal: ui.devTotal, health: ui.health });
  if (p === 'days') return ByDay();
  if (p === 'live') return LiveStream({ connState: ui.connState }, setBody);
  if (p === 'events') return AllEvents(setBody);
  if (p.startsWith(SUBSYSTEM_PANEL_PREFIX)) return SubsystemPanel(p.slice(SUBSYSTEM_PANEL_PREFIX.length), setBody);
  if (p === 'deviations') return Deviations(setBody);
  if (p === 'sessions') return Sessions((sess) => { ui.treeSess = sess; ui.panel = 'tree'; syncHash(); renderBody(true).then(focusMain); }, setBody);
  if (p === 'tree') {
    if (!ui.sessListCache.length || isPanelSwitchOrExplicitRefresh) {
      const r = await api('/api/sessions?limit=200');
      ui.sessListCache = r.rows || [];
    }
    const onSelectSession = (sess) => { ui.treeSess = sess; syncHash(); renderBody(); };
    const onRefresh = () => renderBody(true);
    return ProcessTree(ui.treeSess, ui.sessListCache, onSelectSession, null, onRefresh);
  }
  if (p === 'prd') return PrdEditor(setBody);
  if (p === 'mutables') return MutablesEditor(setBody);
  if (p === 'lifecycle') return LifecycleControl(setBody);
  if (p === 'codesearch') return Codesearch(setBody);
  if (p === 'console') return GmCallConsole(setBody);
  if (p === 'browser-sessions') return BrowserSessions();
  if (p === 'codeinsight') return CodeInsightPanel(setBody);
  if (p === 'memory-graph') return MemoryGraphPanel();
  // Any panel id REMOVED_PANEL_REDIRECTS does not name (a stale bookmark, a
  // hand-edited hash) degrades to the default landing panel, never a dead end.
  ui.panel = DEFAULT_PANEL;
  syncHash();
  return LiveAgents({ connState: ui.connState, onNav: go }, setBody);
}

// webjsx reuses the sidebar <a> DOM node across the re-diff (same key, same
// position), so without an explicit move the browser keeps native focus parked
// on the link just activated: the new panel renders but focus never enters it,
// silently, for AT users. #app-main already carries tabindex="-1" for the
// skip-link, so it doubles as the landing target.
//
// Called only on a panel-IDENTITY change, never on a same-panel refresh -- an
// SSE push stealing focus mid-panel has no navigational reason to.
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

// Deliberately one poller for both the deviation badge and the cross-project
// health banner, not a second setInterval alongside it.
async function refreshDeviationBadge() {
  const [devR, healthR] = await Promise.all([
    api('/api/deviations?limit=1'),
    api('/api/health-summary'),
  ]);
  ui.devTotal = devR.total || 0;
  ui.health = Array.isArray(healthR) ? healthR : (healthR.rows || []);
  renderShell();
}

const DEVIATION_EVENT_PREFIX = 'deviation.';
const PLUGKIT_SUBSYSTEM = 'plugkit';

const RERENDER_FROM_CLIENT_STATE = 'append';
const REFETCH_FROM_SERVER = 'refetch';
const IGNORE_FRAME = false;

function isDeviation(ev) {
  return typeof ev.event === 'string' && ev.event.startsWith(DEVIATION_EVENT_PREFIX);
}

const refetchOnNewPlugkitFrame = (ev) => (ev._sub === PLUGKIT_SUBSYSTEM ? REFETCH_FROM_SERVER : IGNORE_FRAME);

// Panels declare which frame families they care about here rather than app.js
// carrying an if-ladder on ui.panel, so a panel added later subscribes instead
// of editing the dispatch path. A frame matching no subscription costs nothing.
const SSE_SUBSCRIPTIONS = [
  {
    panel: 'agents',
    wants: (ev) => {
      // Landing the frame directly in the matching agent's feed means no
      // live-state refetch and no lost scroll position.
      const landedInAFeed = appendLiveEvent(ev, liveState.rows);
      if (landedInAFeed) return RERENDER_FROM_CLIENT_STATE;
      // A plugkit frame for a project not tracked yet is a genuinely new agent,
      // which does require pulling the roster.
      return refetchOnNewPlugkitFrame(ev);
    },
  },
  { panel: 'live', wants: () => RERENDER_FROM_CLIENT_STATE },
  { panel: 'overview', wants: refetchOnNewPlugkitFrame },
  { panel: 'sessions', wants: refetchOnNewPlugkitFrame },
  { panel: 'deviations', wants: (ev) => (isDeviation(ev) ? REFETCH_FROM_SERVER : IGNORE_FRAME) },
];

// An observer cannot watch a screen continuously, so the three state changes
// worth interrupting for -- a phase transition, a deviation, a gate denial --
// raise a title-bar count and a pulse on the panel. Opt-in and persisted like
// the nav's advanced toggle, because an unattended signal the reader never
// asked for is noise.
//
// Deliberately NOT the Notification API: it demands an OS permission prompt,
// and a local observability tool that asks for one on first paint reads as
// hostile. The title bar is already visible in the tab strip.
const NOTIFY_STORAGE_KEY = 'gmsniff.notify.stateChanges';
const NOTIFY_ON = 'on';
const NOTIFY_OFF = 'off';

// Whitelist-validated exactly like NAV_ADVANCED: a corrupt stored value or an
// unavailable localStorage both land on OFF rather than silently opting the
// reader in.
let notifyStateChanges = (() => {
  try { return localStorage.getItem(NOTIFY_STORAGE_KEY) === NOTIFY_ON; } catch (_) { return false; }
})();

function setNotifyStateChanges(on) {
  notifyStateChanges = !!on;
  try { localStorage.setItem(NOTIFY_STORAGE_KEY, notifyStateChanges ? NOTIFY_ON : NOTIFY_OFF); } catch (_) {}
  if (!notifyStateChanges) clearStateChangeSignal();
  renderShell();
}

const GATE_DENY_DEVIATION = 'gate-deny';
const DEVIATION_EVENT_PREFIX_LEN = DEVIATION_EVENT_PREFIX.length;

// The measurement, never a verdict: "spoint EXECUTE->VERIFY" and
// "casey deviation.gate-deny" say what happened and to whom. No severity word,
// no ranking, no "critical" -- the reader judges.
export function describeStateChange(ev) {
  if (!ev || typeof ev.event !== 'string') return null;
  const who = basename(ev.cwd);
  if (ev.event === 'phase.transitioned') {
    const from = ev.from || '?';
    const to = ev.phase || '?';
    return `${who} ${from}->${to}`;
  }
  if (ev.event.startsWith(DEVIATION_EVENT_PREFIX)) {
    const kind = ev.event.slice(DEVIATION_EVENT_PREFIX_LEN);
    // A gate denial is called out as itself rather than folded into the generic
    // deviation line, because it is the one an observer most often waits on.
    if (kind === GATE_DENY_DEVIATION) return `${who} deviation.gate-deny`;
    return `${who} deviation.${kind}`;
  }
  return null;
}

const STATE_CHANGE_LOG_RETAINED = 20;
const PULSE_CLEAR_MS = 4000;

const stateChangeSignal = { count: 0, recent: [], pulse: false };
let pulseTimer = null;
const BASE_TITLE = document.title;

function clearStateChangeSignal() {
  stateChangeSignal.count = 0;
  stateChangeSignal.recent = [];
  stateChangeSignal.pulse = false;
  document.title = BASE_TITLE;
}

// Counts EVERY notable frame, not only those arriving while the tab is hidden:
// a reader looking at a different panel is just as unable to see a transition
// on the agents list as one on another tab.
function noteStateChange(ev) {
  if (!notifyStateChanges) return;
  const described = describeStateChange(ev);
  if (!described) return;
  stateChangeSignal.count++;
  stateChangeSignal.recent.unshift(described);
  if (stateChangeSignal.recent.length > STATE_CHANGE_LOG_RETAINED) stateChangeSignal.recent.pop();
  document.title = `(${stateChangeSignal.count}) ${BASE_TITLE}`;
  stateChangeSignal.pulse = true;
  if (pulseTimer) clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => { stateChangeSignal.pulse = false; renderShell(); }, PULSE_CLEAR_MS);
  renderShell();
}

// Returning to the tab is the acknowledgement: the count exists to tell a reader
// what they missed while away, so it resets once they are back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stateChangeSignal.count) clearStateChangeSignal();
});

// Names the three frame families it counts, so a reader enabling it knows
// exactly what will interrupt them, and states the newest measurement inline
// rather than only in the tab title.
function StateChangeSignal() {
  const newest = stateChangeSignal.recent[0] || null;
  return h('div', {
    class: 'gm-notify' + (stateChangeSignal.pulse ? ' is-pulsing' : ''),
    'data-gm-notify': notifyStateChanges ? NOTIFY_ON : NOTIFY_OFF,
  },
    Toggle({
      checked: notifyStateChanges,
      label: 'signal state changes',
      ariaLabel: 'signal phase transitions, deviations and gate denials',
      onChange: setNotifyStateChanges,
    }),
    h('span', { class: 'gm-notify-scope' }, 'phase transitions · deviations · gate denials'),
    notifyStateChanges && stateChangeSignal.count
      ? h('span', {
          class: 'gm-notify-count', role: 'status', 'aria-live': 'polite',
          title: stateChangeSignal.recent.join('\n'),
        }, `${stateChangeSignal.count} since you last looked${newest ? ' -- newest: ' + newest : ''}`)
      : null);
}

const RECONNECT_DELAY_INITIAL_MS = 1000;
const RECONNECT_DELAY_MAX_MS = 15000;
const DEVIATION_BADGE_POLL_MS = 10000;
const ELAPSED_TIME_REFRESH_MS = 15000;

let sse = null;
let reconnectDelay = RECONNECT_DELAY_INITIAL_MS;

function handleFrame(ev) {
  pushLiveEntry(ev);
  noteStateChange(ev);
  if (isDeviation(ev)) refreshDeviationBadge();
  let mode = IGNORE_FRAME;
  for (const sub of SSE_SUBSCRIPTIONS) {
    if (sub.panel !== ui.panel) continue;
    const want = sub.wants(ev);
    if (want === REFETCH_FROM_SERVER) { mode = REFETCH_FROM_SERVER; break; }
    if (want === RERENDER_FROM_CLIENT_STATE) mode = mode || RERENDER_FROM_CLIENT_STATE;
  }
  if (mode) scheduleRender({ refetch: mode === REFETCH_FROM_SERVER });
}

function connectSSE() {
  // Last-Event-ID replay: EventSource sends the header automatically from the
  // `id:` field the server already emits, so a reconnect after a backoff gap
  // resumes rather than silently dropping whatever arrived while disconnected.
  sse = new EventSource('/api/stream');

  sse.addEventListener('hello', () => {
    ui.connState = 'live';
    reconnectDelay = RECONNECT_DELAY_INITIAL_MS;
    ui.streamNote = ui.missedFrames ? `resumed -- ${ui.missedFrames} frame(s) may have been missed while disconnected` : null;
    renderShell();
    if (ui.panel === 'live' || ui.panel === 'agents') scheduleRender({ refetch: true });
  });

  sse.addEventListener('event', (e) => {
    if (e.lastEventId) ui.lastEventId = e.lastEventId;
    try { handleFrame(JSON.parse(e.data)); } catch (_) {}
  });

  // A server-sent `error` FRAME means a watcher failed, and is distinct from the
  // transport-level sse.onerror below, which fires with no data at all. Both
  // were previously ignored entirely: a watcher dying produced no UI reaction.
  sse.addEventListener('error', (e) => {
    const isTransportErrorNotAWatcherFrame = !e || !e.data;
    if (isTransportErrorNotAWatcherFrame) return;
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
    // Dropping it from the roster is what makes an open drilldown degrade to its
    // "no longer present" state rather than render a row backed by nothing.
    if (cwd) liveState.rows = liveState.rows.filter(r => r.cwd !== cwd);
    loadProjects();
    scheduleRender({ refetch: true });
  });

  sse.addEventListener('project.phase-changed', () => {
    if (ui.panel === 'agents' || ui.panel === 'overview') scheduleRender({ refetch: true });
  });

  // Without this listener the server emits the frame and nothing receives it, so
  // the panel falls back to refetching the whole live-state payload on every raw
  // event -- the exact cost this frame exists to avoid.
  sse.addEventListener('agent.output', (e) => {
    if (e.lastEventId) ui.lastEventId = e.lastEventId;
    let batch = null;
    try { batch = JSON.parse(e.data); } catch (_) { return; }
    const landedInAFeed = appendOutputBatch(batch, liveState.rows);
    if (landedInAFeed && ui.panel === 'agents') scheduleRender({ refetch: false });
  });

  sse.onerror = () => {
    ui.connState = 'reconnecting';
    ui.missedFrames++;
    ui.streamNote = 'live stream disconnected -- reconnecting, events during the gap will be replayed';
    renderShell();
    try { sse.close(); } catch (_) {}
    setTimeout(connectSSE, Math.min(reconnectDelay, RECONNECT_DELAY_MAX_MS));
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_DELAY_MAX_MS);
  };
}

async function boot() {
  applyHashState(parseHash(location.hash));
  expandAdvancedFor(ui.panel);
  // Canonicalizing the hash covers a bare load with no hash (establishing
  // #panel=agents) and a hash naming an unknown panel (writing back the default
  // applyHashState already fell to). replaceState, not pushState, so boot never
  // leaves an extra entry a single Back press would have to skip past.
  history.replaceState(null, '', hashForState());

  // Exposed BEFORE the awaits below, never after: this is the debug surface, and
  // hanging it off the end of boot left it undefined for exactly the slow-boot
  // window in which someone would want to inspect a slow boot.
  window.gmsniff = {
    state, ui, go, renderBody, renderShell, openPalette, closePalette, buildCommandRegistry,
    parseHash, hashForState, syncHash, liveStreamDebugSnapshot, isAdvancedPanel,
    getNavAdvanced: () => navAdvanced, statusGlance,
    liveState, agentKey, openDrilldown, closeDrilldown, scheduleRender,
    describeStateChange, noteStateChange, stateChangeSignal,
    getNotifyStateChanges: () => notifyStateChanges, setNotifyStateChanges,
  };

  // BOOT PAINTS BEFORE IT FETCHES. Measured in real Chrome against this
  // machine's 678 discovered projects: /api/capabilities 3.7s, live-state 10.9s,
  // /api/projects 17.0s. Awaiting those in series ahead of the first paint left
  // the panel reading a bare "Loading..." for ~30s with no affordance -- the
  // single worst first-contact defect in this UI. Shell first, then the panel
  // with its own honest loading state, then the slow loads in parallel.
  renderShell();
  const panelPaint = renderBody(true);

  // Refinements, not preconditions: the verb allowlist has a seed fallback and
  // pendingLabel() degrades to an event count, so neither of these blocks first
  // paint and neither gates the other.
  const capabilitiesLoad = loadCapabilities().then(() => renderShell());
  const projectRosterLoad = loadProjects().then(() => { renderShell(); scheduleRender({ refetch: false }); });

  await panelPaint;
  refreshDeviationBadge();
  setInterval(refreshDeviationBadge, DEVIATION_BADGE_POLL_MS);
  // Elapsed times ("in EXECUTE for 4m") are derived from wall-clock, so they go
  // stale on a silent stream. This tick re-renders the lead view from
  // already-held state: no fetch, no flicker.
  setInterval(() => {
    if (ui.panel === 'agents' && !liveState.open) scheduleRender({ refetch: false });
  }, ELAPSED_TIME_REFRESH_MS);
  connectSSE();
  // live-state now carries `gates` and `last_prompt` on every row directly
  // (measured against the real route), so this is a no-op kept only as the
  // fallback for an older server, and is deliberately neither awaited nor
  // relied upon.
  loadAgentContext(liveState.rows.map(r => r.cwd), () => scheduleRender({ refetch: false }));
  await Promise.allSettled([capabilitiesLoad, projectRosterLoad]);
}

boot();
