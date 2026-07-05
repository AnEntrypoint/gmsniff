import * as webjsx from 'webjsx';
import { AppShell, Topbar, Side, Status, Chip } from 'ds/components/shell.js';
import { ThemeToggle } from 'ds/components/theme-toggle.js';
import { state, loadProjects, api } from './data.js';
import {
  Dashboard, ByDay, LiveStream, pushLiveEntry, AllEvents, Search, SubsystemPanel,
  Deviations, Sessions, ProcessTree, QueryPanel, RecallStats, ExecStats, HookStats,
  PrdEditor, MutablesEditor, LifecycleControl, RsTools, Codesearch, GmCallConsole,
  BrowserSessions, ConversationHistory, CodeInsightPanel, MemoryGraphPanel, SUB_LIST,
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
};

function navItem(id, label, extra) {
  return { label, href: '#' + id, active: ui.panel === id, onClick: (e) => { e.preventDefault(); go(id); }, count: extra };
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
    main: [bodyContainer],
    status: Status({ left: ['gmsniff'], right: [state.cwd || '(own root)'] }),
  });
  webjsx.applyDiff(root, app);
}

async function renderBody(force) {
  ui.bodyNode = await computeBody(force);
  renderShell();
}

async function computeBody(force) {
  const p = ui.panel;
  const setBody = (f) => renderBody(f);
  if (p === 'overview') return Dashboard();
  if (p === 'days') return ByDay();
  if (p === 'live') return LiveStream({ connState: ui.connState });
  if (p === 'events') return AllEvents(setBody);
  if (p === 'search-panel') return Search(setBody);
  if (p.startsWith('sub-')) return SubsystemPanel(p.slice(4), setBody);
  if (p === 'deviations') return Deviations();
  if (p === 'sessions') return Sessions((sess) => { ui.treeSess = sess; ui.panel = 'tree'; renderBody(); });
  if (p === 'tree') {
    if (!ui.sessListCache.length || force) { const r = await api('/api/sessions?limit=200'); ui.sessListCache = r.rows || []; }
    return ProcessTree(ui.treeSess, ui.sessListCache, (sess) => { ui.treeSess = sess; renderBody(); });
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
  if (p === 'codeinsight') return CodeInsightPanel();
  if (p === 'memory-graph') return MemoryGraphPanel();
  return h('p', { class: 'gm-empty' }, 'Unknown panel: ' + p);
}

async function go(id) {
  ui.panel = id;
  await renderBody(true);
}

async function refreshDeviationBadge() {
  const r = await api('/api/deviations?limit=1');
  ui.devTotal = r.total || 0;
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
  window.gmsniff = { state, ui, go, renderBody, renderShell };
}

boot();
