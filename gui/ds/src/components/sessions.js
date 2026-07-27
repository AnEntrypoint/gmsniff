// Session surfaces — a persistent conversation list (left-rail "Chats") and a
// live multi-session dashboard. Pure factories: props in, webjsx vnode out, all
// interaction via host callbacks. Styling lives in chat.css (.ds-session*,
// .ds-dash*) using kit tokens; no transport, no decorative glyphs.

import * as webjsx from '../../vendor/webjsx/index.js';
import { Btn, Icon } from './shell.js';
import { Select, SearchInput } from './content.js';
import { PhaseWalk } from './data-density.js';
import { formatDateTime, formatNumber } from '../locale.js';
const h = webjsx.createElement;

// ONE duration format for every surface (live cards, running panel, session
// meta, context pane): <60s -> 'Ns', <1h -> 'Nm Ss', else 'Nh Nm'. Durations
// roll s -> m -> h instead of an hour-long run reading '3712s'.
// ONE absolute-time / relative-time formatter for every surface that shows a
// timestamp (freddie pages, chat transcripts). fmtTime -> localized
// date+time string; fmtAgo -> coarse relative ('Ns/Nm/Nh/Nd ago').
export function fmtTime(t) {
  try { return formatDateTime(t); } catch { return String(t || ''); }
}
export function fmtAgo(t) {
  if (!t) return '';
  const s = Math.floor((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

export function fmtDuration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const hrs = Math.floor(m / 60);
  return hrs + 'h ' + (m % 60) + 'm';
}

/**
 * The Claude-Desktop "Chats" column. Sessions grouped by a caller-supplied
 * group label, each row showing title/project, relative time, agent badge,
 * and a running/new-event indicator. Selecting a row switches the active
 * conversation.
 *
 * @param {Object} [props]
 * @param {Array<{sid:*, title?:string, project?:string, agent?:string, time?:string, running?:boolean, unread?:boolean, rail?:string}>} [props.sessions=[]]
 * @param {*} [props.selected] - the active sid.
 * @param {Array<{label:string, sids:Array<*>}>} [props.groups] - OPTIONAL buckets for the rows; else one flat list.
 * @param {{value:string, onInput:Function, placeholder?:string}} [props.search] - inline filter (optional).
 * @param {Function} [props.onSelect] - onSelect(session).
 * @param {Function} [props.onNew] - onNew().
 * @param {string} [props.emptyText='No conversations yet']
 * @param {boolean} [props.loading=false]
 * @param {*} [props.error=null]
 * @returns {*} webjsx vnode
 */
export function ConversationList({ sessions = [], selected, groups, search, caption,
                                   onSelect, onNew, newLabel = 'New chat',
                                   emptyText = 'No conversations yet', loading = false, error = null,
                                   loadingText = 'Loading conversations…',
                                   // hasMore/onLoadMore: the rail's host truncates the underlying
                                   // session list at some limit (a 200+ conversation user would
                                   // otherwise never reach older sessions) - mirrors the History
                                   // tab's existing "load N older" EventList pattern.
                                   hasMore = false, onLoadMore, loadMoreLabel = 'load more conversations',
                                   // resultCount: forwarded straight through to the inner SearchInput's
                                   // aria-live region, so a real "N results" string (computed by the
                                   // host from its filtered session list) reaches AT users instead of
                                   // the region sitting permanently empty.
                                   resultCount } = {}) {
  const rowFor = (s, i) => h('div', {
    // Stable key: prefer sid, else position - a missing/duplicate sid would make
    // key undefined and crash webjsx applyDiff ("reading 'key'" of undefined).
    key: 'cs-' + (s.sid != null ? s.sid : 'i' + i),
    role: 'option',
    tabindex: s.sid === selected ? '0' : '-1',
    class: 'ds-session-row' + (s.sid === selected ? ' active' : '') + (s.rail ? ' rail-' + s.rail : ''),
    'aria-selected': s.sid === selected ? 'true' : 'false',
    onclick: () => onSelect && onSelect(s),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect && onSelect(s); } },
  },
    // Positional children must NOT mix keyed VElements with null/strings (webjsx
    // applyDiff crashes "reading 'key'"). Keep these unkeyed and filter nulls so
    // each h() call gets a clean, consistent child list.
    h('span', { class: 'ds-session-main' }, [
      // Two-sided truncation: the CSS ellipsis is paired with a title= carrying
      // the full string, so a long title/project is recoverable on hover.
      h('span', { class: 'ds-session-title', title: s.title || s.project || s.sid || null }, s.title || s.project || s.sid || ''),
      (s.project || s.time) ? h('span', { class: 'ds-session-sub', title: s.project || null },
        [s.project, s.time].filter(Boolean).join(' · ')) : null,
    ].filter(Boolean)),
    h('span', { class: 'ds-session-meta' }, [
      s.agent ? h('span', { class: 'ds-session-agent' }, s.agent) : null,
      // Optional richer status ('error'|'stale'|'running'|'stopping') mirrors the
      // SessionCard STATUS_DISC mapping used on the Live dashboard, so a session
      // pinned to a "Running" rail group reads the same stuck-vs-busy signal it
      // does there rather than only a boolean live dot. Falls back to the plain
      // running dot when no status is supplied (existing callers unaffected).
      s.status
        ? h('span', { class: 'status-dot-disc ' + (STATUS_DISC[s.status] || 'status-dot-live'), 'aria-label': STATUS_WORD[s.status] || s.status, role: 'img' })
        : s.running
        ? h('span', { class: 'status-dot-disc status-dot-live', 'aria-label': 'running', role: 'img' })
        : (s.unread ? h('span', { class: 'ds-session-unread', 'aria-label': 'new activity', role: 'img' }) : null),
    ].filter(Boolean)));

  // The body is ALWAYS a single keyed wrapper element of the same tag, so webjsx
  // diffs its children across state transitions (loading -> empty -> populated)
  // instead of swapping the container type - the swap is what triggered the
  // applyDiff "reading 'key'" crash on the first populated mount. Row children
  // are uniformly keyed; non-row states render a single unkeyed status line.
  let inner;
  if (loading && !sessions.length) {
    // Shape-matched skeleton rows during the cold ccsniff index walk (the rail
    // showed a bare line before) - Claude-Desktop skeletons its sidebar on load.
    inner = [
      h('div', { key: 'st', class: 'ds-session-state', role: 'status', 'aria-live': 'polite' }, loadingText),
      ...Array.from({ length: 5 }, (_, i) => h('div', { key: 'sk' + i, class: 'ds-session-row-skeleton', 'aria-hidden': 'true' },
        h('div', { class: 'ds-skel ds-skel-title' }), h('div', { class: 'ds-skel ds-skel-meta' }))),
    ];
  } else if (error) {
    inner = [h('div', { key: 'st', class: 'ds-session-state ds-session-state-error', role: 'status' }, String(error))];
  } else if (!sessions.length) {
    inner = [h('div', { key: 'st', class: 'ds-session-state', role: 'status' }, emptyText)];
  } else if (groups && groups.length) {
    const bySid = new Map(sessions.map((s) => [s.sid, s]));
    inner = groups.map((g) => h('div', { key: 'g-' + g.label, class: 'ds-session-group', role: 'group', 'aria-label': g.label },
      h('div', { key: 'gl', class: 'ds-session-group-label' }, g.label),
      h('div', { key: 'gr', class: 'ds-session-group-rows', role: 'listbox', 'aria-label': g.label }, ...g.sids.map((sid) => bySid.get(sid)).filter(Boolean).map(rowFor))));
  } else {
    inner = sessions.map(rowFor);
  }
  // The load-more row sits INSIDE the scrollable list body (not the outer
  // .ds-sessions shell) so it scrolls with the rows it extends, matching
  // where a user's eye already is after scrolling to the bottom of the rail.
  const loadMoreRow = (hasMore && onLoadMore && sessions.length)
    ? h('button', { key: 'loadmore', type: 'button', class: 'ds-session-loadmore', onclick: onLoadMore }, loadMoreLabel)
    : null;
  const body = h('div', { key: 'body', class: 'ds-session-list', role: 'listbox', 'aria-label': caption || 'Conversations' },
    ...inner, loadMoreRow);

  return h('div', { class: 'ds-sessions' },
    h('div', { key: 'head', class: 'ds-session-head' },
      onNew ? h('button', { key: 'new', type: 'button', class: 'ds-session-new', onclick: onNew, 'aria-label': newLabel },
        Icon('pencil'), h('span', { key: 'l' }, newLabel)) : null,
      search ? SearchInput({
        key: 'search', value: search.value || '',
        label: search.placeholder || 'Search conversations',
        placeholder: search.placeholder || 'Search conversations',
        onInput: (v) => search.onInput && search.onInput(v),
        resultCount,
      }) : null),
    // Per-tab caption telling the user what selecting a row does on this surface
    // (chat = resume the conversation, history = browse its events) so visually
    // identical rows are disambiguated.
    caption ? h('div', { key: 'cap', class: 'ds-session-caption' }, caption) : null,
    body);
}

// SessionMeta — a middot-separated metadata strip for a session detail surface.
//   items : [{ label, value, title, onCopy }]
// Each item is a span (label dimmed, value mono) with an optional per-item copy
// button; the strip flex-wraps at narrow widths. Class is .ds-session-meta-strip
// (the bare .ds-session-meta is already taken by ConversationList row meta).
export function SessionMeta({ items = [] } = {}) {
  if (!items.length) return null;
  return h('div', { class: 'ds-session-meta-strip', role: 'group', 'aria-label': 'session metadata' },
    ...items.map((it, i) => h('span', {
      key: 'sm-' + (it.label != null ? it.label : i),
      class: 'ds-session-meta-item',
      title: it.title || null,
    },
      [
        it.label != null ? h('span', { key: 'l', class: 'ds-session-meta-label' }, it.label) : null,
        h('span', { key: 'v', class: 'ds-session-meta-value' }, it.value != null ? String(it.value) : ''),
        it.onCopy ? h('button', {
          key: 'c', type: 'button', class: 'ds-session-meta-copy',
          'aria-label': 'copy ' + (it.title || it.label || 'value'),
          onclick: () => it.onCopy(it.value),
        }, 'copy') : null,
        // Generic secondary action (e.g. a directory row's "use as chat cwd")
        // - kept distinct from onCopy since a fact can want a non-copy action,
        // or (rare) both.
        it.onAction ? h('button', {
          key: 'a', type: 'button', class: 'ds-session-meta-action',
          onclick: () => it.onAction(it.value),
        }, it.actionLabel || 'use') : null,
      ].filter(Boolean))));
}

// AgentListSkeleton — placeholder shimmer rows shown while the agent picker's
// list is loading, so it doesn't flash from a bare spinner to a full list
// (same predictable-perceived-perf pattern as FileSkeleton). `rows` controls
// how many ghost rows render; each mimics a Row's icon+title+meta footprint.
export function AgentListSkeleton({ rows = 5 } = {}) {
  return h('div', { class: 'ds-agent-list-skeleton', 'aria-hidden': 'true' },
    ...Array.from({ length: Math.max(1, rows) }, (_, i) => h('div', { key: 'ags' + i, class: 'ds-agent-row-skeleton' },
      h('span', { class: 'ds-skel ds-skel-icon' }),
      h('span', { class: 'ds-skel ds-skel-title' }),
      h('span', { class: 'ds-skel ds-skel-meta' }))),
    h('span', { key: 'st', class: 'ds-agent-list-skeleton-status', role: 'status', 'aria-live': 'polite' }, 'loading agents…'));
}

// SessionCard — one running session in the live dashboard. Status dot, agent /
// model / cwd, elapsed, live counter, last activity, and per-session controls
// that each act on this session's id independently.
//
//   session : { sid, agent, model, cwd, elapsed, counter, lastActivity, currentTool, status }
//   actions : { onStop, onOpen, onResume, onView } (any subset)
// `counter` carries the live activity tally (e.g. "12 ev · 3 tools"); `lastActivity`
// the relative time of the most-recent event ("4s ago"); `currentTool` the tool
// name a still-running turn is executing - together they distinguish a busy
// session from a stuck one (a frozen elapsed alone reads identically for both).
// `status` is one of: 'error' | 'stale' | 'running'. A 'stale' session is one
// the host has determined is alive but not making progress (no recent activity,
// no current tool) — it reads as `idle` with a NON-pulsing disc so a stuck agent
// is visually distinct from a busy one (a frozen elapsed alone reads identically
// for both, which is the high-severity oversight gap this closes).
// `session.stopping` is the in-flight cancel state: the stop button disables
// with label 'stopping…' and the status word flips to 'stopping', so the click
// visibly took and cannot re-fire while the host waits for the active poll.
// `session.external` marks a session we observe (ccsniff stream) but do not own
// (no process to kill): the stop button is suppressed, an 'external' tag renders
// in the head, and the host wires onView to open it in history instead.
// `session.title` is the SAME string the conversation rails use, rendered as
// the card heading so the rail row and its dashboard card share one identity.
// `session.elapsedMs` (raw ms) is formatted internally via fmtDuration; the
// pre-formatted `elapsed` string remains as a legacy fallback.
// `session.phase` + `session.phases` drive an OPTIONAL inline PhaseWalk strip
// for hosts whose agents advance through a named lifecycle (a gm walk's
// PLAN -> ... -> COMPLETE). `phases` is the ordered phase-name list and `phase`
// the one currently occupied. Pass `session.phasesSeen` (every phase visited so
// far) whenever the lifecycle allows revisits — gm's re-plan edges send
// EXECUTE/EMIT/VERIFY back to PLAN, and without it a re-planned session reads as
// having lost the progress it actually made. Without `phasesSeen` the strip
// falls back to "everything up to the current index", which is correct only for
// a strictly linear walk. A host that supplies no `phases` gets the exact card
// it got before — the strip is additive, not a shape requirement.
// `session.phaseGaps` marks known-bad phases.
const STATUS_WORD = { error: 'error', stale: 'idle', running: 'running', stopping: 'stopping' };
const STATUS_DISC = { error: 'status-dot-error', stale: 'status-dot-stale', running: 'status-dot-live', stopping: 'status-dot-connecting' };

export function SessionCard({ session = {}, onStop, onOpen, onView, active = false,
                             selectable = false, selected = false, onToggleSelect } = {}) {
  const s = session;
  const st = s.stopping ? 'stopping' : (s.status === 'error' ? 'error' : (s.status === 'stale' ? 'stale' : 'running'));
  // The stat line composes elapsed + live counter; the activity line carries the
  // last-activity time and the current tool so a card shows MOTION, not just a
  // start offset. Both are middot-joined (kept product separator).
  const elapsedText = s.elapsedMs != null ? fmtDuration(s.elapsedMs) : (s.elapsed != null ? s.elapsed : null);
  // At-a-glance cost/usage (the prompt's named command-center signal). Null-safe:
  // sessions with no cost source (external tally rows) simply omit the segment.
  const tokText = s.tokens != null ? (typeof s.tokens === 'number' ? formatNumber(s.tokens) : s.tokens) + ' tok' : null;
  const costText = s.cost != null ? (typeof s.cost === 'number' ? '$' + s.cost.toFixed(4) : String(s.cost)) : null;
  // Cost is rendered as its own emphasized segment (not buried in the mono run)
  // so the command-center cost-at-a-glance signal is scannable.
  const statBits = [elapsedText, s.counter != null ? s.counter : null, tokText].filter((x) => x != null && x !== '');
  const activityBits = [
    s.currentTool ? 'running: ' + s.currentTool : null,
    s.lastActivity ? 'last ' + s.lastActivity : null,
  ].filter(Boolean);
  const cls = 'ds-dash-card is-' + st + (active ? ' is-active' : '') + (selected ? ' is-selected' : '') + (s.external ? ' is-external' : '') + (s.isNew ? ' is-new' : '');
  // EVERY children array is filter(Boolean)'d: webjsx applyDiff crashes
  // (reading 'key') on a bare null among VElement siblings, so a null cwd /
  // model / external flag must never reach a positional child slot.
  const head = h('div', { class: 'ds-dash-card-head' }, ...[
    selectable ? h('button', {
      type: 'button', class: 'ds-dash-select', role: 'checkbox',
      'aria-checked': selected ? 'true' : 'false',
      'aria-label': (selected ? 'deselect' : 'select') + ' session ' + (s.title || s.agent || s.sid),
      onclick: () => onToggleSelect && onToggleSelect(s),
    }, h('span', { class: 'ds-check-box', 'aria-hidden': 'true' })) : null,
    h('span', { class: 'status-dot-disc ' + STATUS_DISC[st], 'aria-hidden': 'true' }),
    h('span', { class: 'ds-dash-status is-' + st }, STATUS_WORD[st]),
    s.external ? h('span', { class: 'ds-dash-external' }, 'external') : null,
    h('span', { class: 'ds-dash-agent', title: s.agent || null }, s.agent || 'agent'),
    s.model ? h('span', { class: 'ds-dash-model', title: s.model }, s.model) : null,
  ].filter(Boolean));
  // Ordered-lifecycle strip. A lifecycle is NOT necessarily a linear walk: gm
  // has legal gate-free re-plan edges (EXECUTE/EMIT/VERIFY -> PLAN), so a
  // session sitting in PLAN for the second time has still genuinely reached
  // EXECUTE. Deriving reached[] from the current phase's index alone would
  // erase that history and render a re-plan as a regression. So `phasesSeen`
  // (every phase actually visited) is authoritative when the host tracks it,
  // and the index fallback applies only to hosts that supply just `phase`.
  const phaseNames = Array.isArray(s.phases) && s.phases.length ? s.phases : null;
  const seen = Array.isArray(s.phasesSeen) ? new Set(s.phasesSeen) : null;
  const phaseIdx = phaseNames && s.phase ? phaseNames.indexOf(s.phase) : -1;
  const phaseStrip = phaseNames
    ? PhaseWalk({
        phases: phaseNames,
        reached: phaseNames.map((p, i) => (seen ? seen.has(p) : i <= phaseIdx)),
        gapKinds: s.phaseGaps || [],
      })
    : null;
  const meta = h('div', { class: 'ds-dash-meta' }, ...[
    s.cwd ? h('span', { class: 'ds-dash-cwd', title: s.cwd }, s.cwd) : null,
    phaseStrip ? h('span', { class: 'ds-dash-phase' },
      ...[phaseStrip, s.phase ? h('span', { class: 'ds-dash-phase-name' }, s.phase) : null].filter(Boolean)) : null,
    (statBits.length || costText) ? h('span', { class: 'ds-dash-stat' },
      ...[
        statBits.length ? statBits.join(' · ') : null,
        (statBits.length && costText) ? ' · ' : null,
        costText ? h('span', { class: 'ds-dash-stat-cost' }, costText) : null,
      ].filter(Boolean)
    ) : null,
    activityBits.length ? h('span', { class: 'ds-dash-activity' }, activityBits.join(' · ')) : null,
  ].filter(Boolean));
  const actions = h('div', { class: 'ds-dash-actions', role: 'group', 'aria-label': 'session actions' }, ...[
    onOpen ? Btn({ key: 'open', variant: 'primary', 'aria-label': 'open session', onClick: () => onOpen(s),
      children: [Icon('external-link', { size: 14 }), h('span', {}, 'open')] }) : null,
    onView ? Btn({ key: 'view', 'aria-label': s.external ? 'open in history' : 'view events', onClick: () => onView(s),
      children: [Icon('file-text', { size: 14 }), h('span', {}, s.external ? 'history' : 'events')] }) : null,
    (onStop && !s.external) ? Btn({ key: 'stop', variant: 'danger', disabled: !!s.stopping, 'aria-label': 'stop session',
      onClick: () => !s.stopping && onStop(s),
      children: [Icon('square', { size: 14 }), h('span', {}, s.stopping ? 'stopping…' : 'stop')] }) : null,
  ].filter(Boolean));
  return h('div', { class: cls, role: 'group', 'aria-label': 'session ' + (s.title || s.agent || s.sid), 'aria-current': active ? 'true' : null },
    ...[
      s.title ? h('div', { class: 'ds-dash-title', title: s.title }, s.title) : null,
      head, meta, actions,
    ].filter(Boolean));
}

// SessionDashboard — grid of SessionCards for ALL live sessions, managed at once.
//   sessions : [{ sid, agent, model, cwd, elapsed, counter, lastActivity, currentTool, status }]
//   actions  : { onStop, onOpen, onResume, onView } passed to each card
//   onStopAll : OPTIONAL bulk control - stop every running session at once
//   emptyText, offline : explicit states
// The bulk header is the "manage many at once" affordance: a live count plus a
// stop-all button, so a user running several agents does not have to hunt each
// card's stop. Rendered only when there are sessions AND onStopAll is wired.
// Streamstate words: the live-stream health signal so "connected, zero running"
// still tells the user the dashboard is listening (vs a dropped stream).
// One connection vocabulary across the crumb, settings chip, and the dashboard
// stream line: connected / connecting / offline ('lost' kept as a legacy alias).
const STREAM_WORD = {
  connected: 'listening for activity',
  connecting: 'connecting to live stream…',
  offline: 'live stream offline — retrying…',
  lost: 'live stream offline — retrying…',
};

/**
 * The live multi-session command center ("Live" dashboard).
 *
 * The stop-all / stop-selected danger buttons are two-step (host-driven, the
 * kit is stateless): the first click fires onArmStop* so the host flips
 * confirming* true and re-renders; the armed button reads 'stop N sessions -
 * press again' and only THAT click fires the real onStopAll/onStopSelected.
 * Hosts that wire no onArmStop* keep the old single-click behavior.
 *
 * @param {Object} [props]
 * @param {Array<Object>} [props.sessions=[]] - session shape: `{ sid, realSid, title, agent, model, cwd, elapsedMs, counter, lastActivity, currentTool, status, stopping, external, isNew, cost, tokens }`.
 * @param {Function} [props.onStop] - onStop(session).
 * @param {Function} [props.onOpen] - onOpen(session).
 * @param {Function} [props.onView] - onView(session).
 * @param {Function} [props.onStopAll]
 * @param {Function} [props.onStopSelected]
 * @param {boolean} [props.confirmingStopAll=false]
 * @param {boolean} [props.confirmingStopSelected=false]
 * @param {'connected'|'connecting'|'lost'|'offline'} [props.streamState]
 * @returns {*} webjsx vnode
 */
export function SessionDashboard({ sessions = [], onStop, onOpen, onView, onStopAll, onStopSelected,
                                   confirmingStopAll = false, confirmingStopSelected = false,
                                   onArmStopAll, onArmStopSelected,
                                   sort, filter, errorsOnly = false, onErrorsOnly,
                                   selectable = false, selected, onToggleSelect, onSelectAll, onClearSelection,
                                   activeSid, streamState,
                                   emptyText = 'No live sessions', emptyAction, offline = false } = {}) {
  if (offline) {
    return h('div', { class: 'ds-dash-state ds-dash-state-error', role: 'status' }, 'Backend offline — live sessions unavailable');
  }
  const selSet = selected instanceof Set ? selected : new Set(selected || []);
  const selCount = selSet.size;
  // While any session is mid-cancel the bulk control reads disabled
  // 'stopping N…' so a bulk stop visibly takes instead of staying re-firable.
  const stoppingCount = sessions.filter((s) => s.stopping).length;
  // The stream-state line always renders (even with zero sessions) so a
  // connected-but-idle dashboard reads differently from an offline one.
  // The stream line leads with a status disc so a connected dashboard visibly
  // PULSES that it is listening (the command-center heartbeat), connecting/offline
  // show a static disc. The disc is aria-hidden; the word carries the state.
  const streamDisc = streamState
    ? 'status-dot-disc ' + (streamState === 'connected' ? 'status-dot-live'
        : streamState === 'connecting' ? 'status-dot-connecting' : 'status-dot-error')
    : null;
  const streamLine = streamState
    ? h('span', { key: 'stream', class: 'ds-dash-stream-disc' },
        h('span', { class: streamDisc, 'aria-hidden': 'true' }),
        h('span', { class: 'ds-dash-stream is-' + streamState, role: 'status', 'aria-live': 'polite' }, STREAM_WORD[streamState] || streamState))
    : null;
  // At-a-glance status breakdown for the command-center header.
  const counts = sessions.reduce((a, s) => {
    const k = s.status === 'error' ? 'error' : (s.status === 'stale' ? 'idle' : 'running');
    a[k] = (a[k] || 0) + 1; return a;
  }, {});
  const breakdownSegs = [
    counts.running ? { k: 'running', t: counts.running + ' running' } : null,
    counts.idle ? { k: 'idle', t: counts.idle + ' idle' } : null,
    counts.error ? { k: 'error', t: counts.error + ' error' + (counts.error === 1 ? '' : 's') } : null,
  ].filter(Boolean);
  const breakdown = breakdownSegs.length
    ? h('span', { key: 'bd', class: 'ds-dash-breakdown', role: 'status', 'aria-live': 'polite' },
        ...breakdownSegs.flatMap((seg, i) => [
          i ? h('span', { key: 'bsep' + i, class: 'ds-dash-breakdown-sep', 'aria-hidden': 'true' }, ' · ') : null,
          h('span', { key: 'bseg' + i, class: 'seg is-' + seg.k }, seg.t),
        ].filter(Boolean)))
    : null;
  const toolbar = (sort || filter || onErrorsOnly)
    ? h('div', { key: 'tb', class: 'ds-dash-toolbar', role: 'group', 'aria-label': 'sort and filter sessions' },
        filter ? SearchInput({
          key: 'filt', value: filter.value || '', label: filter.placeholder || 'Filter sessions', placeholder: filter.placeholder || 'Filter sessions',
          onInput: (v) => filter.onInput && filter.onInput(v),
          // `sessions` here is already the filtered/errors-only list, so its
          // length IS the live result count - forward it to SearchInput's
          // aria-live region whenever a filter is actually active, matching
          // the same wiring ConversationList/history search already has.
          resultCount: filter.value ? (sessions.length + ' result' + (sessions.length === 1 ? '' : 's')) : undefined,
        }) : null,
        sort ? Select({ key: 'sort', value: sort.value || 'status', title: 'Sort sessions',
          options: [
            { value: 'status', label: 'sort: status' },
            { value: 'elapsed', label: 'sort: elapsed' },
            { value: 'activity', label: 'sort: last activity' },
            { value: 'errors', label: 'sort: errors first' },
          ], onChange: (v) => sort.onChange && sort.onChange(v) }) : null,
        onErrorsOnly ? h('button', { key: 'eo', type: 'button', class: 'ds-dash-errors-toggle' + (errorsOnly ? ' active' : ''),
          'aria-pressed': errorsOnly ? 'true' : 'false', onclick: () => onErrorsOnly(!errorsOnly) }, 'errors only') : null)
    : null;
  // NOTE: no separate empty-branch return. The empty state renders as a KEYED
  // child of the same stable body wrapper the populated states use - swapping
  // an unkeyed .ds-dash-state for keyed group children used to crash webjsx
  // applyDiff (reading 'key') the moment the first session appeared, leaving a
  // half-applied DOM ('1 running' header over 'No live sessions' body).
  // Tri-state select-all over the selectable (non-external) sessions.
  const selectableSids = sessions.filter((s) => !s.external).map((s) => s.sid);
  const selOfVisible = selectableSids.filter((sid) => selSet.has(sid)).length;
  const allState = selOfVisible === 0 ? 'false' : (selOfVisible === selectableSids.length ? 'true' : 'mixed');
  const selectAllCtl = (selectable && onSelectAll && selectableSids.length)
    ? h('button', { key: 'selall', type: 'button', class: 'ds-dash-selectall', role: 'checkbox',
        'aria-checked': allState, 'aria-label': allState === 'true' ? 'clear selection' : 'select all sessions',
        onclick: () => (allState === 'true' && onClearSelection) ? onClearSelection() : onSelectAll(selectableSids) },
        h('span', { class: 'ds-check-box', 'aria-hidden': 'true' }),
        h('span', {}, 'all'))
    : null;
  const clearCtl = (selectable && selCount && onClearSelection)
    ? h('button', { key: 'selclr', type: 'button', class: 'ds-dash-clear', onclick: () => onClearSelection() }, 'clear')
    : null;
  const stopBtn = stoppingCount > 0 && (onStopSelected || onStopAll)
      ? Btn({ key: 'stopbusy', variant: 'danger', disabled: true, children: 'stopping ' + stoppingCount + '…' })
      : (selectable && selCount && onStopSelected
      ? (onArmStopSelected && !confirmingStopSelected
          ? Btn({ key: 'stopsel', variant: 'danger', onClick: () => onArmStopSelected([...selSet]), children: 'stop selected' })
          : Btn({ key: 'stopsel', variant: 'danger', class: confirmingStopSelected ? 'is-armed' : null, onClick: () => onStopSelected([...selSet]),
                  children: confirmingStopSelected ? 'stop ' + selCount + ' sessions - press again' : 'stop selected' }))
      : (onStopAll
          ? (onArmStopAll && !confirmingStopAll
              ? Btn({ key: 'stopall', variant: 'danger', onClick: () => onArmStopAll(sessions), children: 'stop all' })
              : Btn({ key: 'stopall', variant: 'danger', class: confirmingStopAll ? 'is-armed' : null, onClick: () => onStopAll(sessions),
                      children: confirmingStopAll ? 'stop ' + sessions.length + ' sessions - press again' : 'stop all' }))
          : null));
  // Build header children as a filtered array: webjsx applyDiff crashes
  // (reading 'key') when a bare null sits among keyed siblings, so never pass
  // a conditional child positionally - filter it out first.
  const headerKids = [
    selectable && selCount
      ? h('span', { key: 'cnt', class: 'ds-dash-count', role: 'status', 'aria-live': 'polite' }, selCount + ' selected')
      : (breakdown || h('span', { key: 'cnt', class: 'ds-dash-count', role: 'status', 'aria-live': 'polite' },
          sessions.length ? sessions.length + ' running' : '0 running')),
    selectAllCtl, clearCtl, streamLine,
    h('span', { key: 'spread', class: 'spread' }),
    // No stop control without a session to stop; the empty dashboard keeps
    // only the count, heartbeat, and (when wired) filter/sort chrome.
    sessions.length ? stopBtn : null,
    toolbar,
  ].filter(Boolean);
  const header = h('div', { class: 'ds-dash-header', role: 'group', 'aria-label': 'live session controls' }, ...headerKids);
  // Status-bucketed command center: when sorting by status (the default), the
  // grid renders labelled sections (Errored / Running / Idle / External) so a
  // pile of sessions reads as scannable groups. Other sorts collapse to one
  // flat grid (the sort already orders them).
  const grouped = !sort || !sort.value || sort.value === 'status';
  const cardOf = (s) => h('div', { key: s.sid, role: 'listitem' },
    SessionCard({ session: s, onStop, onOpen, onView, active: s.sid === activeSid,
                  selectable, selected: selSet.has(s.sid), onToggleSelect }));
  // ONE stable body wrapper across every state (empty / grouped / flat), with
  // KEYED children - the ConversationList stable-keyed-body rule. Diffing
  // happens on the children, never by swapping the container's shape.
  let bodyKids;
  if (!sessions.length) {
    bodyKids = [h('div', { key: 'empty', class: 'ds-dash-state', role: 'status' },
      ...[
        h('span', { key: 'et' }, emptyText),
        (emptyAction && emptyAction.onClick)
          ? Btn({ key: 'ea', onClick: emptyAction.onClick, children: emptyAction.label || 'start a chat' })
          : null,
      ].filter(Boolean))];
  } else if (grouped) {
    const buckets = [
      { key: 'error', label: 'Errored', rows: sessions.filter((s) => !s.external && s.status === 'error') },
      { key: 'running', label: 'Running', rows: sessions.filter((s) => !s.external && s.status !== 'error' && s.status !== 'stale') },
      { key: 'idle', label: 'Idle', rows: sessions.filter((s) => !s.external && s.status === 'stale') },
      { key: 'external', label: 'External', rows: sessions.filter((s) => s.external) },
    ].filter((b) => b.rows.length);
    bodyKids = buckets.map((b) => h('div', { key: 'grp' + b.key, class: 'ds-dash-group', role: 'group', 'aria-label': b.label + ' sessions' },
      h('div', { key: 'gl', class: 'ds-dash-group-label' }, b.label + ' · ' + b.rows.length),
      h('div', { key: 'gg', class: 'ds-dash-grid', role: 'list', 'aria-label': b.label + ' sessions' }, ...b.rows.map(cardOf))));
  } else {
    bodyKids = [h('div', { key: 'flat', class: 'ds-dash-grid', role: 'list', 'aria-label': 'live sessions' }, ...sessions.map(cardOf))];
  }
  const body = h('div', { key: 'body', class: 'ds-dash-groups' }, ...bodyKids);
  return h('div', { class: 'ds-dash' }, header, body);
}
