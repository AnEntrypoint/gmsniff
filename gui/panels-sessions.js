// Session-shaped panels: deviations grouped by kind and session, the session
// detail dialog, the session list, and the process-tree hierarchy.
import { PHASE_FALLBACK } from './shared.js';
import * as webjsx from 'webjsx';
import { BarRow, DevRow, PhaseWalk, SessionRow } from 'ds/components/data-density.js';
import { api, fmtTs, toast } from './data.js';
import { Btn } from 'ds/components/shell.js';
import { Dialog, TreeItem, TreeView } from 'ds/components/editor-primitives.js';
import { Empty, Failed, TOP_ROWS_SHOWN, Toolbar, h } from './panels-internals.js';
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
    // Re-diff the panel container in place, preserving the shell-owned heading:
    // this module has no access to NAV/ui, so it reads the live h1 text rather
    // than duplicating the label lookup and drifting from it.
    const headingText = container.querySelector('#panel-body-heading')?.textContent || 'tree';
    import('webjsx').then(webjsx => {
      webjsx.applyDiff(container, h('section', {
        id: 'panel-body', class: 'gm-panel-body',
        'aria-labelledby': 'panel-body-heading', tabindex: '-1',
      },
        h('h1', { id: 'panel-body-heading', class: 'gm-panel-heading' }, headingText),
        build()));
    });
  }
  doRerender = renderTreePanelInPlace;

  return build();
}

