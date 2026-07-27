// LIVE AGENTS -- the single lead live view: a manager surface for every gm
// agent running on this machine. One card per agent, carrying the instruction
// it is executing right now, the raw prompt driving it, which gate is blocking
// it, and an append-only output feed fed by the SSE stream rather than a full
// refetch on every frame.
//
// Every field is read defensively against what the server really publishes
// today (measured, not assumed); fields the data layer has not landed yet
// render as an honest absence rather than throwing or faking a value.

import * as webjsx from 'webjsx';
import { Btn, Chip, Pill } from 'ds/components/shell.js';
import { Dialog } from 'ds/components/editor-primitives.js';
import { SessionDashboard, fmtAgo, fmtDuration } from 'ds/components/sessions.js';
import { Toggle } from 'ds/components/form-primitives.js';
import { api, apiPost, esc, fmtTs, state, toast } from './data.js';
import {
  basename, verbAllowlist, phaseUniverse, liveness, LIVENESS_LABEL, ageMs,
  currentDispatch, resolveInflight, verbDurations, prdBurndown, deviationTrend,
  attentionScore, agentAges, phaseDivergence, authoritativePhase,
} from './shared.js';
import { renderMarkdown } from './markdown.js';
import { HonestState } from './honest-state.js';

const h = webjsx.createElement;

// ---------------------------------------------------------------------------
// AGENT IDENTITY -- an agent is (cwd, run-epoch), never cwd alone.
//
// `sess` does not exist in live data (0 of 26,836 real records) and
// turn-state's session_id is null on every actively-running project, so the
// only real correlation is cwd plus the daemon-boot epoch the log carries as
// `_run`. Keying on that means an agent that restarts mid-observation becomes a
// NEW card rather than merging two runs into one apparent session.
// ---------------------------------------------------------------------------
export function agentKey(row) {
  return String(row.cwd || '') + '|' + String(row.run_epoch || row.recent_sess || '');
}

// The server returns one row per cwd today. If it grows to one row per agent
// (an `agents: []` array on the project row), fan out here -- everything below
// already keys on agentKey, so no other change is needed to show two agents in
// one project as two cards.
export function expandAgents(projects) {
  const out = [];
  for (const p of projects || []) {
    if (Array.isArray(p.agents) && p.agents.length) {
      for (const a of p.agents) out.push({ ...p, ...a, cwd: p.cwd });
    } else {
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OUTPUT FEED -- append-only per agent. Re-fetching the whole live-state on
// every SSE frame (the old behavior) threw away scroll position and cost a
// multi-project disk walk per event. The feed is a client-held ring the stream
// appends to, seeded once and never re-seeded while the agent is live.
// ---------------------------------------------------------------------------
const FEED_CAP = 400;
const feeds = new Map(); // agentKey -> {rows, seeded, seq, dropped}

function feedFor(key) {
  let f = feeds.get(key);
  if (!f) { f = { rows: [], seeded: false, seq: 0, dropped: 0 }; feeds.set(key, f); }
  return f;
}

function pushFeedRow(f, row) {
  f.rows.push({ ...row, _k: f.seq++ });
  if (f.rows.length > FEED_CAP) { f.rows.shift(); f.dropped++; }
}

export function seedFeed(row) {
  const key = agentKey(row);
  const f = feedFor(key);
  if (f.seeded) return f;
  const recent = Array.isArray(row.recent_events) ? [...row.recent_events].reverse() : [];
  for (const n of recent) pushFeedRow(f, n);
  f.seeded = true;
  return f;
}

// Backfill: /api/projects/live-state currently returns recent_events for only 1
// of 63 projects, so most feeds would seed empty and every card would read "no
// events observed" even for an agent that dispatched seconds ago. /api/events
// carries the same real events per cwd, so a feed with nothing in it pulls its
// own history from there. Runs once per agent; when the live-state route starts
// populating recent_events this simply finds the feed already seeded and
// becomes a no-op, no client change required.
const backfilled = new Set();

export async function backfillFeed(row, setBody) {
  const key = agentKey(row);
  if (backfilled.has(key)) return false;
  backfilled.add(key);
  const f = feedFor(key);
  if (f.rows.length) return false;
  // q is matched against the raw event text, so a full Windows cwd (with
  // backslashes) matches nothing -- measured: q=C:\dev\spoint returns 0 rows
  // while q=spoint returns 1066. Query by basename, then filter to the exact
  // cwd client-side so a basename shared by two paths cannot cross-contaminate.
  const r = await api('/api/events?limit=120&q=' + encodeURIComponent(basename(row.cwd)));
  if (!r || r.error || !Array.isArray(r.rows)) return false;
  // /api/events is newest-first; the feed is newest-last.
  const mine = r.rows.filter(e => e.cwd === row.cwd).reverse();
  let added = 0;
  for (const e of mine) {
    const node = normalizeStreamEvent(e);
    if (node) { pushFeedRow(f, node); added++; }
  }
  if (added && setBody) setBody();
  return added > 0;
}

// Drops feeds for agents the server no longer reports, so a project whose
// directory vanished mid-watch (9 of 12 registry paths are already gone) frees
// its buffer instead of leaking one ring per dead project forever.
export function pruneFeeds(liveKeys) {
  const keep = new Set(liveKeys);
  for (const k of [...feeds.keys()]) if (!keep.has(k)) feeds.delete(k);
}

// Appends one live SSE event to the matching agent's feed. Returns the agentKey
// it landed on, or null when the frame belongs to no tracked agent -- the
// caller uses that to decide whether a re-render is warranted at all.
export function appendLiveEvent(ev, rows) {
  if (!ev || !ev.cwd) return null;
  const match = (rows || []).find(r => r.cwd === ev.cwd);
  if (!match) return null;
  const key = agentKey(match);
  const f = feeds.get(key);
  if (!f || !f.seeded) return null;
  const node = normalizeStreamEvent(ev);
  if (!node) return null;
  pushFeedRow(f, node);
  return key;
}

// Maps a raw gm-log event onto the same node shape the server's process-tree
// emits, so a streamed row and a seeded row render through one formatter.
//
// Field names are the MEASURED ones: dispatch.start carries `body_bytes` (not
// body_size) and `task` (its `ts` is the empty string in real data, so `task`
// is the only usable correlation key). Events with no live-manager meaning
// return null rather than filling the feed with subsystem noise.
export function normalizeStreamEvent(e) {
  const base = { ts: e.ts || null, phase: e.phase ?? null, run: e._run ?? null };
  switch (e.event) {
    case 'dispatch.start':
      return { ...base, kind: 'dispatch', verb: e.verb ?? null, task: e.task ?? null, body_bytes: e.body_bytes ?? null, inflight: true };
    case 'dispatch.end':
      return { ...base, kind: 'dispatch', verb: e.verb ?? null, task: e.task ?? null, ms: e.ms ?? e.dur_ms ?? null };
    case 'instruction.served':
      return { ...base, kind: 'instruction', prd_pending: e.prd_pending_count ?? null, mut_pending: e.mutables_pending_count ?? null };
    case 'phase.transitioned':
      return { ...base, kind: 'transition', from: e.from ?? null, phase: e.phase ?? base.phase };
    case 'prd.added': return { ...base, kind: 'prd-add', id: e.id ?? null, rescoped: e.rescoped ?? null };
    case 'prd.resolved': return { ...base, kind: 'prd-resolve', id: e.id ?? null };
    case 'mutable.added': return { ...base, kind: 'mutable-add', id: e.id ?? null };
    case 'mutable.resolved': return { ...base, kind: 'mutable-resolve', id: e.id ?? null };
    default:
      if (typeof e.event === 'string' && e.event.startsWith('deviation.')) {
        return { ...base, kind: 'deviation', deviation: e.event.slice(10), detail: e.detail ?? null, source: e.source ?? null };
      }
      return null;
  }
}

export function lastEventTs(f) {
  if (!f || !f.rows.length) return null;
  for (let i = f.rows.length - 1; i >= 0; i--) if (f.rows[i].ts) return f.rows[i].ts;
  return null;
}

// phasesSeen is an authoritative VISITED SET built from real transition history,
// never from current-phase index math. gm's legal gate-free re-plan edges
// (EXECUTE/EMIT/VERIFY -> PLAN) mean a session sitting in PLAN for the second
// time HAS genuinely reached EXECUTE; index math would erase that and render a
// legal revisit as a regression.
export function phasesSeenFrom(f, row) {
  const seen = new Set();
  for (const r of (f ? f.rows : [])) {
    if (r.kind === 'transition') { if (r.from) seen.add(r.from); if (r.phase) seen.add(r.phase); }
    else if (r.phase) seen.add(r.phase);
  }
  if (row && row.phase) seen.add(row.phase);
  return seen.size ? [...seen] : null;
}

// ---------------------------------------------------------------------------
// PANEL STATE -- one object rather than twenty module globals, so the panel is
// resettable and, later, instantiable more than once.
// ---------------------------------------------------------------------------
export const liveState = {
  filter: '',
  errorsOnly: false,
  aliveOnly: true,
  open: null,
  autoscroll: true,
  expanded: new Set(),
  showProvenance: false,
  showMetrics: false,
  rows: [],
  gates: new Map(),
  prompts: new Map(),
  busy: new Set(),
  loadError: null,
  loaded: false,
};

export function resetLiveState() {
  liveState.expanded.clear();
  liveState.busy.clear();
  feeds.clear();
}

// ---------------------------------------------------------------------------
// PER-AGENT CONTROLS -- each card dispatches against ITS OWN cwd, never the
// topbar's globally-selected project, so acting on the row in front of you
// cannot hit a different agent.
// ---------------------------------------------------------------------------
export async function dispatchFor(cwd, verb, setBody) {
  if (!verbAllowlist().includes(verb)) { toast(`Verb "${verb}" is not in the server allowlist`, true); return; }
  liveState.busy.add(cwd);
  if (setBody) setBody();
  const r = await apiPost('/api/lifecycle', { cwd, verb, payload: {} });
  liveState.busy.delete(cwd);
  toast(r.status === 200 ? `${basename(cwd)}: dispatched ${verb}` : `${basename(cwd)}: ${verb} failed -- ${r.error || r.status}`, r.status !== 200);
  if (setBody) setBody();
  return r;
}

// ---------------------------------------------------------------------------
// FEED RENDERING
// ---------------------------------------------------------------------------
const KIND_TONE = {
  deviation: 'var(--flame, #f85149)', transition: 'var(--purple, #bc8cff)',
  dispatch: 'var(--sky, #79c0ff)', instruction: 'var(--accent, #58a6ff)',
};

function stripInternal(n) {
  const out = {};
  for (const [k, v] of Object.entries(n)) if (!k.startsWith('_') && v != null) out[k] = v;
  return out;
}

function feedRow(n, expanded, onToggle) {
  const isOpen = expanded.has(n._k);
  const tone = KIND_TONE[n.kind] || null;
  const bits = [
    n.verb ? h('span', { key: 'v', class: 'gm-pill gm-ml-6' }, n.verb) : null,
    n.ms != null ? h('span', { key: 'd', class: 'gm-feed-dur gm-ml-6' }, fmtDuration(n.ms)) : null,
    n.inflight ? h('span', { key: 'r', class: 'gm-feed-inflight gm-ml-6' }, 'running') : null,
    n.from ? h('span', { key: 'f', class: 'gm-feed-muted gm-ml-6' }, n.from + ' -> ' + (n.phase || '?')) : (n.phase ? h('span', { key: 'p', class: 'gm-pill gm-ml-6' }, n.phase) : null),
    n.id ? h('span', { key: 'i', class: 'gm-pill gm-ml-6' }, n.id) : null,
    n.deviation ? h('span', { key: 'x', class: 'gm-pill gm-ml-6 gm-text-danger' }, n.deviation) : null,
    n.prd_pending != null ? h('span', { key: 'q', class: 'gm-feed-muted gm-ml-6' }, `prd ${n.prd_pending}`) : null,
  ].filter(Boolean);
  return h('div', {
    key: n._k, class: 'gm-feed-row' + (isOpen ? ' is-open' : ''), role: 'button', tabindex: '0',
    onclick: () => onToggle(n._k),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(n._k); } },
  },
    h('div', { key: 'head', class: 'gm-feed-head' },
      h('span', { key: 'ts', class: 'ts gm-mr-8' }, n.ts ? fmtTs(n.ts) : '--:--:--'),
      h('strong', { key: 'k', class: 'gm-feed-kind', style: tone ? `--kind-tone:${tone}` : null }, n.kind),
      ...bits),
    isOpen ? h('pre', { key: 'pay', class: 'gm-feed-payload' }, JSON.stringify(stripInternal(n), null, 2)) : null);
}

function OutputFeed(f, setBody) {
  if (!f || !f.rows.length) {
    return HonestState({
      kind: 'empty',
      text: 'No output recorded for this agent yet.',
      hint: 'The feed fills from the live stream; a quiet agent is genuinely quiet, not a failed load.',
    });
  }
  const onToggle = (k) => {
    if (liveState.expanded.has(k)) liveState.expanded.delete(k); else liveState.expanded.add(k);
    setBody();
  };
  return h('div', {},
    f.dropped
      ? h('div', { key: 'more', class: 'gm-feed-more' }, `${f.dropped} older event${f.dropped === 1 ? '' : 's'} scrolled out of the buffer (holds newest ${FEED_CAP})`)
      : null,
    h('div', {
      key: 'scroll', class: 'gm-feed-scroll', id: 'gm-feed-scroll',
      // Autoscroll auto-suspends when the reader scrolls away from the bottom,
      // so reading history is never yanked back down by an incoming event.
      onscroll: (e) => {
        const el = e.target;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        liveState.autoscroll = atBottom;
      },
    }, ...f.rows.map(n => feedRow(n, liveState.expanded, onToggle))));
}

// Applied after the diff, never during render, so a re-render cannot fight the
// reader's own scroll position.
export function applyAutoscroll() {
  if (!liveState.autoscroll) return;
  const el = document.getElementById('gm-feed-scroll');
  if (el) el.scrollTop = el.scrollHeight;
}

// Gate state now rides on the live-state row itself. Two published shapes are
// both real and both handled: the light list form (`gates_blocked` plus
// `gates_failing: [name]`) and the full form (`gates: {blocked, blockers:[{gate,
// detail}]}`). The side-channel map is kept last as the older-server fallback.
//
// A FAILING gate is not the same thing as a BLOCKING one: on this machine every
// working agent reports gates_failing:["prd-all-closed"] with gates_blocked:false,
// because an open PRD is the normal condition of an agent mid-run. Rendering
// those as blockers would put a red "blocked" chip on every healthy agent.
export function gatesFor(row) {
  if (!row) return null;
  if (row.gates && typeof row.gates === 'object' && Array.isArray(row.gates.blockers)) return row.gates;
  if (Array.isArray(row.gates_failing) || typeof row.gates_blocked === 'boolean') {
    return {
      blocked: !!row.gates_blocked,
      blockers: (row.gates_failing || []).map(g => ({ gate: g, detail: null })),
      blocked_edges: row.gates_blocked_edges || null,
    };
  }
  return liveState.gates.get(row.cwd) || null;
}

// ---------------------------------------------------------------------------
// GATE BLOCKERS -- which gate denied, and how many times it repeated.
// ---------------------------------------------------------------------------
function GateBlockers(gateInfo) {
  if (!gateInfo) return null;
  const blockers = gateInfo.blockers || [];
  const repeats = gateInfo.gate_deviation_repeats || {};
  if (!blockers.length && !gateInfo.last_gate_fired) return null;
  return h('div', { class: 'gm-gates' },
    h('div', { key: 'gh', class: 'gm-gates-head' },
      !blockers.length
        ? Chip({ tone: 'positive', children: 'no failing gates' })
        : gateInfo.blocked
          ? Chip({ tone: 'danger', children: `blocked by ${blockers.length} gate${blockers.length === 1 ? '' : 's'}` })
          // Open gates that are not currently denying a transition -- the normal
          // condition of an agent mid-run, stated as such rather than as a block.
          : Chip({ tone: 'warn', children: `${blockers.length} gate${blockers.length === 1 ? '' : 's'} not yet satisfied (not blocking)` }),
      gateInfo.last_gate_fired
        ? h('span', { class: 'gm-feed-muted gm-ml-6' }, `last fired: ${gateInfo.last_gate_fired.key}${gateInfo.last_gate_fired.ts ? ' ' + fmtAgo(gateInfo.last_gate_fired.ts) : ''}`)
        : null),
    ...blockers.map(b => h('div', { key: b.gate, class: 'gm-gate-row' },
      h('strong', { key: 'g', class: 'gm-text-danger' }, b.gate),
      h('span', { key: 'd', class: 'gm-ml-6' }, b.detail || ''),
      repeats[b.gate] ? h('span', { key: 'r', class: 'gm-pill gm-ml-6 gm-text-danger' }, `repeated x${repeats[b.gate]}`) : null)));
}

// ---------------------------------------------------------------------------
// PER-AGENT METRICS -- verb durations, PRD burndown, deviation trend. Real
// derived signal, but secondary to "what is it doing now", so it sits behind a
// disclosure rather than above the instruction.
// ---------------------------------------------------------------------------
function MetricsDisclosure(f) {
  const durs = verbDurations(f.rows).slice(0, 8);
  const burn = prdBurndown(f.rows);
  const dev = deviationTrend(f.rows);
  if (!durs.length && burn.trend === 'unknown' && !dev.count) return null;
  return h('details', {
    class: 'gm-metrics', open: liveState.showMetrics ? true : null,
    ontoggle: (e) => { liveState.showMetrics = !!e.target.open; },
  },
    h('summary', { key: 's' }, 'Run metrics'),
    h('div', { key: 'b', class: 'gm-metrics-body' },
      h('div', { key: 'burn', class: 'gm-metric-line' },
        h('strong', {}, 'PRD burndown: '),
        burn.trend === 'unknown'
          ? h('span', { class: 'gm-feed-muted' }, 'not enough instruction.served points yet')
          : h('span', { class: burn.trend === 'accumulating' ? 'gm-text-danger' : '' },
              `${burn.trend} (${burn.delta > 0 ? '+' : ''}${burn.delta} over ${burn.points.length} points)`)),
      h('div', { key: 'dev', class: 'gm-metric-line' },
        h('strong', {}, 'Deviations: '),
        h('span', { class: dev.trend === 'rising' ? 'gm-text-danger' : '' }, `${dev.count} total, trend ${dev.trend}`)),
      durs.length
        ? h('table', { key: 'vd', class: 'gm-table gm-mt-8' },
            h('tr', { key: 'h' }, h('th', {}, 'verb'), h('th', {}, 'n'), h('th', {}, 'median'), h('th', {}, 'p95'), h('th', {}, 'max')),
            ...durs.map(d => h('tr', { key: d.verb },
              h('td', {}, d.verb), h('td', {}, String(d.count)),
              h('td', {}, fmtDuration(d.median)), h('td', {}, fmtDuration(d.p95)), h('td', {}, fmtDuration(d.max)))))
        : null));
}

// ---------------------------------------------------------------------------
// PROVENANCE -- instruction tier + vendored settings. Real, but not what an
// observer opens this panel to learn, so it is demoted below the instruction.
// ---------------------------------------------------------------------------
const TIER_LABEL = {
  vendored: 'vendored override', 'source-synced': 'source-synced',
  default: 'compiled default', 'auto-provisioned': 'auto-provisioned (unedited)',
};

export function effectiveTierKey(p) {
  return (p.instruction_tier === 'default' && p.instruction_auto_provisioned) ? 'auto-provisioned' : p.instruction_tier;
}

function ProvenanceDisclosure(p, vendored) {
  const tierKey = effectiveTierKey(p);
  return h('details', {
    class: 'gm-provenance', open: liveState.showProvenance ? true : null,
    ontoggle: (e) => { liveState.showProvenance = !!e.target.open; },
  },
    h('summary', { key: 's' }, `Instruction provenance -- ${TIER_LABEL[tierKey] || tierKey || 'unknown'}`),
    p.instruction_source_file ? h('div', { key: 'f', class: 'gm-mono-sm gm-mt-4' }, p.instruction_source_file) : null,
    p.instruction_source_repo ? h('div', { key: 'r', class: 'gm-mt-4' }, 'synced from: ' + p.instruction_source_repo) : null,
    vendored && vendored.vendored
      ? h('div', { key: 'v', class: 'gm-mt-8' },
          h('strong', { key: 'h' }, `Vendored settings (${vendored.file_count} file${vendored.file_count === 1 ? '' : 's'})`),
          vendored.has_custom_graph ? h('span', { key: 'g', class: 'gm-pill gm-ml-6 gm-tone-warn' }, 'custom FSM graph') : null,
          h('div', { key: 'l', class: 'gm-vendored-list' },
            ...(vendored.entries || []).map(e => h('div', { key: e.label, class: 'gm-list-row gm-mono-sm' },
              h('span', { key: 'a', class: 'gm-pill gm-mr-6' }, e.label),
              h('span', { key: 'b' }, e.path),
              e.size != null ? h('span', { key: 'c', class: 'gm-feed-muted gm-ml-6' }, `${e.size}B`) : null))))
      : null);
}

// ---------------------------------------------------------------------------
// DRILLDOWN -- re-resolved from the LATEST rows on every render (never a
// captured snapshot), so the one panel you open to watch an agent is the one
// that updates most.
// ---------------------------------------------------------------------------
// The list payload is treated as a SUMMARY shape: nothing in the list view
// depends on instruction_excerpt being present. The full instruction body is
// fetched only when a drilldown opens, so the route can drop the ~412KB of
// duplicated instruction prose from the list response without breaking this
// client. If the list row does carry the body (as it does today), that is used
// directly and no extra request is made.
const drilldownAux = { vendored: null, vendoredFor: null, full: null, fullFor: null, fullLoading: false };

export function openDrilldown(row, setBody) {
  liveState.open = agentKey(row);
  liveState.autoscroll = true;

  if (drilldownAux.vendoredFor !== row.cwd) {
    drilldownAux.vendored = null;
    drilldownAux.vendoredFor = row.cwd;
    api('/api/vendored-settings?cwd=' + encodeURIComponent(row.cwd)).then((r) => {
      if (drilldownAux.vendoredFor !== row.cwd) return;
      drilldownAux.vendored = r && !r.error ? r : null;
      if (setBody) setBody();
    });
  }

  if (drilldownAux.fullFor !== row.cwd) {
    drilldownAux.full = null;
    drilldownAux.fullFor = row.cwd;
    if (!row.instruction_excerpt && row.present) {
      drilldownAux.fullLoading = true;
      api('/api/projects/live-state?cwd=' + encodeURIComponent(row.cwd)).then((r) => {
        if (drilldownAux.fullFor !== row.cwd) return;
        const one = r && !r.error && Array.isArray(r.projects) ? r.projects.find(x => x.cwd === row.cwd) : null;
        drilldownAux.full = one && one.instruction_excerpt ? one.instruction_excerpt : null;
        drilldownAux.fullLoading = false;
        if (setBody) setBody();
      });
    }
  }
  if (setBody) setBody();
}

export function closeDrilldown(setBody) {
  liveState.open = null;
  drilldownAux.vendored = null;
  drilldownAux.vendoredFor = null;
  drilldownAux.full = null;
  drilldownAux.fullFor = null;
  drilldownAux.fullLoading = false;
  if (setBody) setBody();
}

function AgentDrilldown(setBody) {
  if (!liveState.open) return null;
  // THE fix for the stale-drilldown defect: resolve by key from the freshest
  // rows of THIS render, never from an object captured at open time.
  const p = liveState.rows.find(r => agentKey(r) === liveState.open);
  if (!p) {
    return Dialog({
      title: 'Agent no longer present', open: true, dismissible: true, size: 'wide',
      ariaLabel: 'Agent no longer present',
      onClose: () => closeDrilldown(setBody),
      actions: [{ label: 'Close', onClick: () => closeDrilldown(setBody) }],
      children: HonestState({
        kind: 'gone',
        text: 'This agent is no longer reported by the server.',
        hint: 'Its watcher stopped, or the project directory was removed while being watched.',
      }),
    });
  }
  const f = seedFeed(p);
  const running = currentDispatch(f.rows);
  const abandoned = resolveInflight(f.rows).filter(o => o.abandoned);
  const gateInfo = liveState.gates.get(p.cwd);
  const prompt = liveState.prompts.get(p.cwd) ?? p.last_prompt ?? null;
  const phases = phaseUniverse(p);
  const seenList = phasesSeenFrom(f, p);
  const seen = new Set(seenList || []);
  const idx = phases.indexOf(p.phase);
  const live = liveness(p);
  const ages = agentAges(p, lastEventTs(f));
  const divergence = phaseDivergence(p);
  const durs = verbDurations(f.rows);
  const median = running ? (durs.find(d => d.verb === running.verb) || {}).median : null;

  const header = h('div', { class: 'gm-agent-head' },
    Pill({ key: 'ph', children: p.phase || 'no phase' }),
    p.skill ? Pill({ key: 'sk', children: p.skill }) : null,
    Chip({
      key: 'lv',
      tone: live === 'active' ? 'positive' : (live === 'idle' ? 'warn' : 'neutral'),
      children: LIVENESS_LABEL[live],
    }),
    running
      ? Chip({ key: 'run', tone: 'warn', children: `running ${running.verb}${running.ageMs != null ? ' for ' + fmtDuration(running.ageMs) : ''}${median && running.ageMs > median * 3 ? ' (slow)' : ''}` })
      : null,
    abandoned.length
      ? Chip({ key: 'ab', tone: 'danger', children: `${abandoned.length} dispatch${abandoned.length === 1 ? '' : 'es'} never completed` })
      : null,
    // Two ages, never collapsed: how long stuck in this phase, and how long
    // since it emitted anything at all.
    h('span', { key: 'age', class: 'gm-feed-muted gm-ml-6' },
      [ages.inPhase != null ? `in ${p.phase || '?'} ${fmtDuration(ages.inPhase)}` : null,
       ages.lastEvt != null ? `last event ${fmtDuration(ages.lastEvt)} ago` : 'no events observed'].filter(Boolean).join(' · ')));

  // next-step.md (the served prose) can lag turn-state.json (the real FSM
  // state). Show both and flag it rather than silently picking one.
  const divergenceNote = divergence
    ? HonestState({
        kind: 'stale',
        text: `Served instruction is behind the FSM state.`,
        hint: `next-step.md is still on ${divergence.served}, while turn-state.json has moved to ${divergence.actual}. The prose below is the ${divergence.served} instruction.`,
      })
    : null;

  const controls = h('div', { class: 'gm-agent-controls', role: 'group', 'aria-label': 'agent controls' },
    ...['instruction', 'transition', 'residual-scan', 'phase-status']
      .filter(v => verbAllowlist().includes(v))
      .map(v => Btn({
        key: v, children: v, variant: v === 'instruction' ? 'primary' : 'ghost',
        disabled: liveState.busy.has(p.cwd) ? true : null,
        onClick: () => dispatchFor(p.cwd, v, setBody),
      })),
    Btn({
      key: 'events', variant: 'ghost', children: 'all events',
      onClick: () => { state.cwd = p.cwd; toast(`Scoped to ${basename(p.cwd)}`); },
    }));

  const instructionPane = h('div', { class: 'gm-split-col' },
    h('div', { key: 'ih', class: 'gm-pane-head' },
      h('h2', { class: 'gm-m-0' }, p.instruction_heading || p.instruction_key || 'Served instruction'),
      p.instruction_key && p.instruction_heading ? h('span', { class: 'gm-pill gm-ml-6' }, p.instruction_key) : null,
      // Provenance and staleness together, the CLI's "PLAN (served 2h6m ago)".
      ages.served != null ? h('span', { class: 'gm-feed-muted gm-ml-6' }, `served ${fmtDuration(ages.served)} ago`) : null),
    h('div', { key: 'pw' }, PhaseStrip(phases, seen, idx)),
    divergenceNote,
    prompt
      ? h('details', { key: 'pr', class: 'gm-prompt', open: true },
          h('summary', { key: 's' }, 'Driving prompt (.gm/last-prompt.txt)'),
          h('pre', { key: 'b', class: 'gm-prompt-body' }, prompt))
      : h('div', { key: 'pr', class: 'gm-feed-muted gm-mt-4' }, 'No driving prompt recorded for this agent.'),
    GateBlockers(gateInfo),
    instructionBody(p),
    MetricsDisclosure(f),
    ProvenanceDisclosure(p, drilldownAux.vendored));

  const feedPane = h('div', { class: 'gm-split-col' },
    h('div', { key: 'fh', class: 'gm-pane-head' },
      h('h2', { class: 'gm-m-0' }, `Output feed (${f.rows.length})`),
      Toggle({
        checked: liveState.autoscroll, label: 'follow',
        onChange: (v) => { liveState.autoscroll = v; setBody(); },
      })),
    OutputFeed(f, setBody));

  return Dialog({
    title: basename(p.cwd), open: true, dismissible: true, size: 'wide',
    ariaLabel: 'Live agent detail',
    onClose: () => closeDrilldown(setBody),
    actions: [{ label: 'Close', onClick: () => closeDrilldown(setBody) }],
    children: h('div', {}, header, controls, h('div', { class: 'gm-split-pane gm-mt-10' }, instructionPane, feedPane)),
  });
}

// Four genuinely different reasons there might be no instruction on screen, each
// stated as itself: the file is malformed, this directory is not a gm project at
// all, the body is still being fetched, or the fetch came back with nothing.
function instructionBody(p) {
  if (p.unparseable) {
    return HonestState({
      key: 'md', kind: 'error',
      text: 'next-step.md is present but could not be parsed.',
      hint: 'Likely a partial write or malformed content -- the file exists, the parse failed.',
    });
  }
  if (!p.present) {
    return HonestState({
      key: 'md', kind: 'unsupported',
      text: 'This directory is not a running gm agent.',
      hint: 'Discovery found it, but it has no .gm/next-step.md, so no instruction is being served.',
    });
  }
  const body = p.instruction_excerpt || drilldownAux.full;
  if (!body) {
    return drilldownAux.fullLoading
      ? HonestState({ key: 'md', kind: 'loading', text: 'Loading served instruction...' })
      : HonestState({
          key: 'md', kind: 'empty',
          text: 'The served instruction body is empty.',
          hint: 'next-step.md exists but carries no instruction text below its header.',
        });
  }
  return h('div', { key: 'md', class: 'gm-instruction-body' }, renderMarkdown(body));
}

// A phase strip that renders a revisit as a revisit. Uses the visited SET when
// transition history supplies one, and falls back to index math only for an
// agent with no recorded transitions at all.
function PhaseStrip(phases, seen, idx) {
  return h('div', { class: 'gm-phase-strip' },
    ...phases.map((ph, i) => {
      const reached = seen.size ? seen.has(ph) : (idx >= 0 && i <= idx);
      const current = i === idx;
      return h('span', {
        key: ph,
        class: 'gm-phase-step' + (reached ? ' is-reached' : '') + (current ? ' is-current' : ''),
        title: reached ? `${ph} -- visited` : `${ph} -- not yet reached`,
      }, ph);
    }));
}

// ---------------------------------------------------------------------------
// CARD MAPPING -- projects a live-state row onto the ds SessionCard shape and
// attaches the derived attention signal used for default ordering.
// ---------------------------------------------------------------------------
function toAgent(p) {
  const f = seedFeed(p);
  const running = currentDispatch(f.rows);
  const inflightAll = resolveInflight(f.rows);
  const abandoned = inflightAll.find(o => o.abandoned) || null;
  const gates = liveState.gates.get(p.cwd) || null;
  const burndown = prdBurndown(f.rows);
  const devTrend = deviationTrend(f.rows);
  const durs = verbDurations(f.rows);
  const median = running ? (durs.find(d => d.verb === running.verb) || {}).median : null;
  const slowDispatch = running && median && running.ageMs ? running.ageMs / median : null;
  const agent = {
    row: p, feed: f, gates, burndown, devTrend,
    inflight: running || abandoned,
    slowDispatch: slowDispatch && slowDispatch > 3 ? slowDispatch : null,
  };
  const attention = attentionScore(agent, Date.now());
  agent.attention = attention;
  return agent;
}

// PRD/mutable pressure. live-state does not carry these, but /api/projects
// (already fetched at boot into state.projects) does for every project.
function pendingLabel(p) {
  const proj = (state.projects || []).find(r => r.cwd === p.cwd);
  if (!proj || proj.prd_pending == null) return null;
  return `prd ${proj.prd_pending}/${proj.prd_total} · mut ${proj.mut_unknown}`;
}

function toCard(a) {
  const p = a.row;
  const f = a.feed;
  const live = a.attention.liveness;
  const ages = agentAges(p, lastEventTs(f));
  const blocked = a.gates && a.gates.blocked;
  // 'error' is reserved for something genuinely wrong (blocked gate, abandoned
  // dispatch, unparseable instruction) -- never for a merely-idle agent.
  const status = (blocked || p.unparseable || (a.inflight && a.inflight.abandoned)) ? 'error'
    : (live === 'active' ? 'running' : 'stale');
  return {
    sid: agentKey(p),
    title: basename(p.cwd),
    agent: p.skill || 'gm',
    model: p.instruction_heading || p.instruction_key || null,
    cwd: p.cwd,
    phase: p.phase || null,
    phases: phaseUniverse(p),
    phasesSeen: phasesSeenFrom(f, p),
    // elapsedMs is IN-PHASE; lastActivity is LAST-EVT. Two different questions,
    // both on the card, never merged into a single "age".
    elapsedMs: ages.inPhase,
    // Pending pressure, the CLI's "prd:441 mut:0" column. state.projects carries
    // it for every discovered project even when live-state does not.
    counter: pendingLabel(p) || (f.rows.length ? f.rows.length + ' events' : null),
    // SessionCard renders this as "last <value>" itself (ds sessions.js:261), so
    // the value must NOT repeat the word -- witnessed in the real DOM as
    // "last last event 30s ago".
    lastActivity: ages.lastEvt != null
      ? `event ${fmtDuration(ages.lastEvt)} ago`
      : (live === 'none' ? 'gm state: none' : 'event: none observed'),
    currentTool: a.inflight
      ? (a.inflight.abandoned ? `${a.inflight.verb} never completed` : `${a.inflight.verb}${a.inflight.ageMs != null ? ' ' + fmtDuration(a.inflight.ageMs) : ''}`)
      : (blocked ? 'blocked: ' + a.gates.blockers[0].gate : null),
    status,
    _agent: a,
  };
}

// ---------------------------------------------------------------------------
// PANEL
// ---------------------------------------------------------------------------
export async function LiveAgents({ connState = 'connecting', onNav } = {}, setBody) {
  const r = await api('/api/projects/live-state');
  liveState.loaded = true;
  if (r.error) {
    liveState.loadError = r.error;
    return HonestState({
      kind: 'error',
      text: 'Could not load live agent state.',
      hint: String(r.error),
      action: { label: 'Retry', onClick: () => setBody(true) },
    });
  }
  liveState.loadError = null;
  const rows = expandAgents(r.projects || []);
  liveState.rows = rows;
  const agents = rows.map(toAgent);
  pruneFeeds(rows.map(agentKey));

  // Discovery finds 63 directories on this machine; only a handful are actually
  // working. The idle/abandoned/not-an-agent majority is folded away by default
  // -- foregrounding the working minority IS what "no noise" means at this
  // scale, and a cap alone would not do it (a cap hides an arbitrary majority,
  // this hides a CLASSIFIED one and says exactly how many and why).
  const q = liveState.filter.trim().toLowerCase();
  const working = agents.filter(a => ['active', 'idle'].includes(a.attention.liveness));
  const backlog = agents.filter(a => !['active', 'idle'].includes(a.attention.liveness));

  let visible;
  if (q) {
    // A filter always searches EVERY discovered project, folded or not, so a
    // search can reach a project the default view hides.
    visible = agents.filter(a => [a.row.cwd, a.row.phase, a.row.skill, a.row.instruction_key, a.row.instruction_heading]
      .some(v => String(v || '').toLowerCase().includes(q)));
  } else {
    visible = liveState.aliveOnly ? working : agents;
  }
  if (liveState.errorsOnly) visible = visible.filter(a => a.attention.score >= 30);

  // Default ordering answers "where do I look first" -- attention score, not
  // alphabetical and not plain liveness. At 63 rows this ordering, not the cap,
  // decides what an observer ever actually sees.
  visible = [...visible].sort((a, b) => b.attention.score - a.attention.score);

  const cards = visible.map(toCard);
  const notAgents = backlog.filter(a => a.attention.liveness === 'none').length;
  const finished = backlog.length - notAgents;

  // Only the agents actually on screen pull their own history, so a 63-project
  // machine never issues 63 backfill requests for rows nobody is looking at.
  for (const a of visible.slice(0, 12)) backfillFeed(a.row, () => setBody());

  // Honest states: an empty result distinguishes "nothing discovered" from
  // "everything filtered out" from "everything is finished".
  const emptyText = agents.length === 0
    ? 'No gm projects discovered on this machine yet.'
    : q ? `No project matches "${liveState.filter}" (searched all ${agents.length}).`
      : liveState.errorsOnly ? 'No agent currently needs attention.'
        : 'No agent is working right now. Turn off "working only" to see finished and idle projects.';

  const topReasons = visible.slice(0, 3).filter(a => a.attention.reasons.length);

  return h('div', {},
    h('div', { key: 'tb', class: 'gm-toolbar' },
      Toggle({
        checked: liveState.aliveOnly, label: 'working only',
        onChange: (v) => { liveState.aliveOnly = v; setBody(); },
      }),
      // Every count is labelled with WHAT it counts. Three surfaces on this
      // machine report three different totals for "projects" (CLI 66,
      // data layer 174, this route 63), so a bare number is ambiguous -- this
      // one is explicitly "reported by /api/projects/live-state".
      h('span', { class: 'gm-feed-muted' },
        q
          ? `${visible.length} of ${agents.length} match (searched every project live-state reports)`
          : `${visible.length} shown / ${agents.length} reported by live-state`),
      !q && (finished || notAgents)
        ? h('button', {
            type: 'button', class: 'gm-reveal',
            onclick: () => { liveState.aliveOnly = !liveState.aliveOnly; setBody(); },
          }, liveState.aliveOnly
              ? `+ ${finished + notAgents} hidden (${finished} finished/abandoned, ${notAgents} not gm agents) -- show`
              : 'hide finished, abandoned and non-agent projects')
        : null,
      !connState || connState !== 'live'
        ? Chip({ tone: 'warn', children: `stream ${connState} -- counts may lag` })
        : null),
    topReasons.length
      ? h('div', { key: 'att', class: 'gm-attention' },
          h('strong', { key: 'h' }, 'Needs attention: '),
          ...topReasons.map(a => h('button', {
            key: a.row.cwd, type: 'button', class: 'gm-attention-item',
            onclick: () => openDrilldown(a.row, setBody),
          }, `${basename(a.row.cwd)} -- ${a.attention.reasons[0]}`)))
      : null,
    h('div', { key: 'dash' }, SessionDashboard({
      sessions: cards,
      streamState: connState === 'live' ? 'connected' : (connState === 'reconnecting' ? 'connecting' : 'offline'),
      filter: {
        value: liveState.filter, placeholder: 'Filter agents by project / phase / skill',
        onInput: (v) => { liveState.filter = v; setBody(); },
      },
      errorsOnly: liveState.errorsOnly,
      onErrorsOnly: (v) => { liveState.errorsOnly = v; setBody(); },
      activeSid: liveState.open,
      onOpen: (c) => openDrilldown(c._agent.row, setBody),
      onView: (c) => { state.cwd = c.cwd; if (onNav) onNav('events'); },
      onStop: (c) => dispatchFor(c.cwd, 'transition', setBody),
      emptyText,
    })),
    AgentDrilldown(setBody));
}

// ---------------------------------------------------------------------------
// SIDE-CHANNEL LOADS -- gates and driving prompts. Both routes are OPTIONAL:
// the server does not publish them yet (readFsmGates and last_prompt exist in
// src/ but are not wired to any route), so a 404 leaves the maps empty and
// every consumer above renders the absence honestly instead of faking a value.
// ---------------------------------------------------------------------------
// The route is probed ONCE against a single cwd. A server that does not serve it
// yet answers 404 exactly one time and the feature switches itself off -- firing
// one doomed request per project would put a wall of 404s in the console and
// blame the client for a route that simply has not landed.
let agentContextAvailable = null; // null = unprobed, false = route absent

export async function loadAgentContext(cwds, setBody) {
  if (agentContextAvailable === false) return;
  const wanted = (cwds || []).filter(c => c && !liveState.gates.has(c));
  if (!wanted.length) return;

  if (agentContextAvailable === null) {
    const probe = await fetch('/api/agent-context?cwd=' + encodeURIComponent(wanted[0])).catch(() => null);
    agentContextAvailable = !!(probe && probe.ok);
    if (!agentContextAvailable) return;
  }

  let changed = false;
  await Promise.all(wanted.slice(0, 12).map(async (cwd) => {
    const g = await api('/api/agent-context?cwd=' + encodeURIComponent(cwd));
    if (!g || g.error) return;
    if (Array.isArray(g.gates)) { liveState.gates.set(cwd, g); changed = true; }
    if (typeof g.last_prompt === 'string') { liveState.prompts.set(cwd, g.last_prompt); changed = true; }
  }));
  if (changed && setBody) setBody();
}
