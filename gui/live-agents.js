import * as webjsx from 'webjsx';
import { Btn, Chip, Pill } from 'ds/components/shell.js';
import { Dialog, SplitPanel } from 'ds/components/editor-primitives.js';
import { SessionDashboard, fmtAgo, fmtDuration } from 'ds/components/sessions.js';
import { Toggle } from 'ds/components/form-primitives.js';
import { api, apiPost, fmtTs, state, toast } from './data.js';
import {
  basename, verbAllowlist, phaseUniverse, liveness, LIVENESS_LABEL, ageMs,
  currentDispatch, resolveInflight, verbDurations, prdBurndown, deviationTrend,
  attentionScore, agentAges, phaseDivergence, authoritativePhase,
  REASON_DISPATCHING_NOW,
} from './shared.js';
import { renderMarkdown } from './markdown.js';
import { HonestState } from './honest-state.js';

const h = webjsx.createElement;

// An agent is (cwd, run-epoch), never cwd alone: `sess` does not exist in live
// data (0 of 26,836 real records) and turn-state's session_id is null on every
// actively-running project, so cwd plus the daemon-boot epoch the log carries as
// `_run` is the only real correlation available. Keying on it means an agent
// that restarts mid-observation becomes a NEW card rather than merging two runs
// into one apparent session.
export function agentKey(row) {
  return String(row.cwd || '') + '|' + String(row.run_epoch || row.recent_sess || '');
}

// The server returns one row per cwd today; if it grows an `agents: []` array
// per project row, this fans it out and nothing else changes, because every
// surface below already keys on agentKey.
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

// Each agent's output feed is a client-held ring the SSE stream appends to,
// seeded once and never re-seeded while the agent is live. Re-fetching the whole
// live-state on every frame (the earlier behavior) threw away the reader's
// scroll position and cost a multi-project disk walk per event.
const FEED_NEWEST_ROWS_RETAINED = 400;
const feedsByAgentKey = new Map();

function feedFor(key) {
  let f = feedsByAgentKey.get(key);
  if (!f) { f = { rows: [], seeded: false, seq: 0, dropped: 0 }; feedsByAgentKey.set(key, f); }
  return f;
}

function pushFeedRow(f, row) {
  f.rows.push({ ...row, _k: f.seq++ });
  if (f.rows.length > FEED_NEWEST_ROWS_RETAINED) { f.rows.shift(); f.dropped++; }
}

export function seedFeed(row) {
  const f = feedFor(agentKey(row));
  if (f.seeded) return f;
  const oldestFirst = Array.isArray(row.recent_events) ? [...row.recent_events].reverse() : [];
  for (const n of oldestFirst) pushFeedRow(f, n);
  f.seeded = true;
  return f;
}

// A fallback that is now dormant, not dead: /api/projects/live-state populates
// recent_events for every project it returns (measured 6 of 6), so seedFeed
// fills the feed first and this returns early on the f.rows.length guard. It
// still earns its place for a project live-state returns with no events at all,
// where /api/events carries the same real events per cwd. The comment previously
// claimed "only 1 of 63 projects" -- true for an earlier fleet, inverted now.
const backfilledAgentKeys = new Set();

export async function backfillFeed(row, setBody) {
  const key = agentKey(row);
  if (backfilledAgentKeys.has(key)) return false;
  backfilledAgentKeys.add(key);
  const f = feedFor(key);
  if (f.rows.length) return false;
  // `q` is matched against the raw event text, so a full Windows cwd matches
  // nothing -- measured: q=C:\dev\spoint returned 0 rows while q=spoint returned
  // 1066. Querying by basename and filtering client-side to the exact cwd keeps
  // a basename shared by two paths from cross-contaminating the feed.
  const r = await api('/api/events?limit=120&q=' + encodeURIComponent(basename(row.cwd)));
  if (!r || r.error || !Array.isArray(r.rows)) return false;
  const mineOldestFirst = r.rows.filter(e => e.cwd === row.cwd).reverse();
  let added = 0;
  for (const e of mineOldestFirst) {
    const node = normalizeStreamEvent(e);
    if (node) { pushFeedRow(f, node); added++; }
  }
  if (added && setBody) setBody();
  return added > 0;
}

// A project whose directory vanished mid-watch (9 of 12 registry paths are
// already gone) frees its buffer instead of leaking one ring per dead project.
export function pruneFeeds(liveKeys) {
  const keep = new Set(liveKeys);
  for (const k of [...feedsByAgentKey.keys()]) if (!keep.has(k)) feedsByAgentKey.delete(k);
}

// Returns the agentKey the frame landed on, or null when it belongs to no
// tracked agent -- the caller uses that to decide whether to re-render at all.
export function appendLiveEvent(ev, rows) {
  if (!ev || !ev.cwd) return null;
  const match = (rows || []).find(r => r.cwd === ev.cwd);
  if (!match) return null;
  const key = agentKey(match);
  const f = feedsByAgentKey.get(key);
  if (!f || !f.seeded) return null;
  const node = normalizeStreamEvent(ev);
  if (!node) return null;
  pushFeedRow(f, node);
  return key;
}

// A server-sent `agent.output` batch already carries the normalized node shape
// seedFeed uses, so its nodes are pushed as-is: normalizeStreamEvent maps RAW
// gm-log events, and re-mapping an already-normalized node would drop every
// field it does not know. Bounding the batch by the feed's own newest ts is what
// stops a Last-Event-ID replay from double-appending frames already held.
export function appendOutputBatch(batch, rows) {
  if (!batch || !batch.cwd || !Array.isArray(batch.nodes) || !batch.nodes.length) return null;
  const match = (rows || []).find(r => r.cwd === batch.cwd);
  if (!match) return null;
  const key = agentKey(match);
  const f = feedsByAgentKey.get(key);
  if (!f || !f.seeded) return null;
  const newestAlreadyHeld = lastEventTs(f);
  let added = 0;
  for (const node of batch.nodes) {
    if (!node) continue;
    if (newestAlreadyHeld && node.ts && node.ts <= newestAlreadyHeld) continue;
    pushFeedRow(f, node);
    added++;
  }
  return added ? key : null;
}

const DEVIATION_EVENT_PREFIX = 'deviation.';

// Maps a raw gm-log event onto the same node shape the server's process-tree
// emits, so a streamed row and a seeded row render through one formatter.
//
// Field names are the MEASURED ones: dispatch.start carries `body_bytes` (not
// body_size), and its `ts` is the empty string in real data, which is why `task`
// is the only usable correlation key.
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
      if (typeof e.event === 'string' && e.event.startsWith(DEVIATION_EVENT_PREFIX)) {
        return {
          ...base, kind: 'deviation',
          deviation: e.event.slice(DEVIATION_EVENT_PREFIX.length),
          detail: e.detail ?? null, source: e.source ?? null,
        };
      }
      // An event with no live-manager meaning is dropped rather than filling the
      // feed with subsystem noise.
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

// Dispatches against the card's OWN cwd, never the topbar's globally-selected
// project, so acting on the row in front of you cannot hit a different agent.
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

const KIND_TONE = {
  deviation: 'var(--flame, #f85149)', transition: 'var(--purple, #bc8cff)',
  dispatch: 'var(--sky, #79c0ff)', instruction: 'var(--accent, #58a6ff)',
};

const INTERNAL_FIELD_PREFIX = '_';
const AT_BOTTOM_SLACK_PX = 24;

function withoutInternalFields(n) {
  const out = {};
  for (const [k, v] of Object.entries(n)) if (!k.startsWith(INTERNAL_FIELD_PREFIX) && v != null) out[k] = v;
  return out;
}

function feedRow(n, expanded, onToggle) {
  const isOpen = expanded.has(n._k);
  const tone = KIND_TONE[n.kind] || null;
  const detailChips = [
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
      ...detailChips),
    isOpen ? h('pre', { key: 'pay', class: 'gm-feed-payload' }, JSON.stringify(withoutInternalFields(n), null, 2)) : null);
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
      ? h('div', { key: 'more', class: 'gm-feed-more' }, `${f.dropped} older event${f.dropped === 1 ? '' : 's'} scrolled out of the buffer (holds newest ${FEED_NEWEST_ROWS_RETAINED})`)
      : null,
    h('div', {
      key: 'scroll', class: 'gm-feed-scroll', id: 'gm-feed-scroll',
      onscroll: (e) => {
        const el = e.target;
        const readerIsAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK_PX;
        // Scrolling away from the bottom suspends follow, so reading history is
        // never yanked back down by an incoming event.
        liveState.autoscroll = readerIsAtBottom;
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

// A FAILING gate is not the same thing as a BLOCKING one: on this machine every
// working agent reports gates_failing:["prd-all-closed"] with
// gates_blocked:false, because an open PRD is the normal condition of an agent
// mid-run. Rendering those as blockers would put a red "blocked" chip on every
// healthy agent.
//
// Both published row shapes are real and both are handled; liveState.gates is
// the older-server side-channel fallback.
export function gatesFor(row) {
  if (!row) return null;
  const fullShape = row.gates && typeof row.gates === 'object' && Array.isArray(row.gates.blockers);
  if (fullShape) return row.gates;
  const lightListShape = Array.isArray(row.gates_failing) || typeof row.gates_blocked === 'boolean';
  if (lightListShape) {
    return {
      blocked: !!row.gates_blocked,
      blockers: (row.gates_failing || []).map(g => ({ gate: g, detail: null })),
      blocked_edges: row.gates_blocked_edges || null,
    };
  }
  return liveState.gates.get(row.cwd) || null;
}

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
          : Chip({ tone: 'warn', children: `${blockers.length} gate${blockers.length === 1 ? '' : 's'} not yet satisfied (not blocking)` }),
      gateInfo.last_gate_fired
        ? h('span', { class: 'gm-feed-muted gm-ml-6' }, `last fired: ${gateInfo.last_gate_fired.key}${gateInfo.last_gate_fired.ts ? ' ' + fmtAgo(gateInfo.last_gate_fired.ts) : ''}`)
        : null),
    ...blockers.map(b => h('div', { key: b.gate, class: 'gm-gate-row' },
      h('strong', { key: 'g', class: gateInfo.blocked ? 'gm-text-danger' : '' }, b.gate),
      h('span', { key: 'd', class: 'gm-ml-6' }, b.detail || ''),
      repeats[b.gate] ? h('span', { key: 'r', class: 'gm-pill gm-ml-6 gm-text-danger' }, `repeated x${repeats[b.gate]}`) : null)));
}

const SLOWEST_VERBS_SHOWN = 8;

// Real derived signal, but secondary to "what is it doing now", so it sits
// behind a disclosure rather than above the instruction.
function MetricsDisclosure(f) {
  const allDurs = verbDurations(f.rows);
  const durs = allDurs.slice(0, SLOWEST_VERBS_SHOWN);
  const versOmitted = allDurs.length - durs.length;
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
        : null,
      // Measured live: spoint exercises 20 distinct verbs, gm 19, gmsniff 16 --
      // all well over the cap, so this table showed 8 and read as complete.
      versOmitted > 0
        ? h('div', { key: 'vdo', class: 'gm-feed-muted gm-mt-8' },
            `+${versOmitted} slower verb${versOmitted === 1 ? '' : 's'} not shown (table caps at ${SLOWEST_VERBS_SHOWN})`)
        : null));
}

// Instruction tier plus vendored settings: real, but not what an observer opens
// this panel to learn, so it is demoted below the instruction itself.
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

// The list payload is treated as a SUMMARY shape: nothing in the list view
// depends on instruction_excerpt being present, so the route can drop the ~412KB
// of duplicated instruction prose from the list response without breaking this
// client. When the list row does carry the body (as it does today), it is used
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
    // The dedicated per-cwd route, NOT a second live-state refetch: live-state
    // walks every one of the 678 discovered projects (measured 10.9s in the real
    // browser) to answer a question about exactly one of them.
    if (!row.instruction_excerpt && row.present) {
      drilldownAux.fullLoading = true;
      api('/api/projects/instruction?cwd=' + encodeURIComponent(row.cwd)).then((r) => {
        if (drilldownAux.fullFor !== row.cwd) return;
        drilldownAux.full = r && !r.error && r.instruction_excerpt ? r.instruction_excerpt : null;
        // This route carries the untruncated driving prompt (8KB) where the list
        // row carries only a 400-char slice.
        if (r && !r.error && typeof r.last_prompt === 'string' && r.last_prompt) {
          liveState.prompts.set(row.cwd, r.last_prompt);
        }
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

const DISPATCH_SLOW_MULTIPLE_OF_MEDIAN = 3;

function AgentDrilldown(setBody) {
  if (!liveState.open) return null;
  // Resolved by key from the freshest rows of THIS render, never from an object
  // captured at open time -- the one panel you open to watch an agent must be
  // the one that updates most, and a captured snapshot froze it instead.
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
  const gateInfo = gatesFor(p);
  // The drilldown fetch stores the FULL 8KB prompt in the map, so it wins over
  // the list row's 400-char slice once it has been populated.
  const prompt = liveState.prompts.get(p.cwd) ?? p.last_prompt ?? null;
  const phases = phaseUniverse(p);
  const phasesVisited = new Set(phasesSeenFrom(f, p) || []);
  const phase = authoritativePhase(p);
  const currentPhaseIndex = phases.indexOf(phase);
  const live = liveness(p);
  const ages = agentAges(p, lastEventTs(f));
  const divergence = phaseDivergence(p);
  const durs = verbDurations(f.rows);
  const medianMsForRunningVerb = running ? (durs.find(d => d.verb === running.verb) || {}).median : null;
  // The multiple itself, never a "(slow)" verdict derived from it: 1.2x and 40x
  // both read as "slow" once collapsed, and the reader needs the difference.
  const runningVsMedian = medianMsForRunningVerb && running.ageMs
    ? running.ageMs / medianMsForRunningVerb
    : null;

  const header = h('div', { class: 'gm-agent-head' },
    Pill({ key: 'ph', children: phase || 'no phase' }),
    p.skill ? Pill({ key: 'sk', children: p.skill }) : null,
    Chip({
      key: 'lv',
      tone: live === 'active' ? 'positive' : (live === 'idle' ? 'warn' : 'neutral'),
      children: LIVENESS_LABEL[live],
    }),
    running
      ? Chip({ key: 'run', tone: 'warn', children: [
          `running ${running.verb}`,
          running.ageMs != null ? ` for ${fmtDuration(running.ageMs)}` : '',
          runningVsMedian ? ` (${runningVsMedian.toFixed(1)}x median ${fmtDuration(medianMsForRunningVerb)})` : '',
        ].join('') })
      : null,
    abandoned.length
      ? Chip({ key: 'ab', tone: 'danger', children: `${abandoned.length} dispatch${abandoned.length === 1 ? '' : 'es'} never completed` })
      : null,
    h('span', { key: 'age', class: 'gm-feed-muted gm-ml-6' },
      [ages.sinceEnteringPhase != null ? `in ${phase || '?'} ${fmtDuration(ages.sinceEnteringPhase)}` : null,
       ages.sinceLastEvent != null ? `last event ${fmtDuration(ages.sinceLastEvent)} ago` : 'no events observed'].filter(Boolean).join(' · ')));

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
      ages.sinceInstructionServed != null ? h('span', { class: 'gm-feed-muted gm-ml-6' }, `served ${fmtDuration(ages.sinceInstructionServed)} ago`) : null),
    h('div', { key: 'pw' }, PhaseStrip(phases, phasesVisited, currentPhaseIndex)),
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
    children: h('div', {}, header, controls,
      h('div', { class: 'gm-split-pane gm-mt-10' },
        SplitPanel({ orientation: 'horizontal', initial: '50%', min: 240, children: [instructionPane, feedPane] }))),
  });
}

// Four genuinely different reasons there might be no instruction on screen, each
// stated as itself rather than as one shared blank.
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
  // The list route sends `instruction_preview` (240 chars) and the full body
  // only via the drilldown fetch. Rendering the preview as if it were the
  // instruction would silently truncate a 5.6KB prose body with nothing saying
  // so, hence the explicit "Preview" label until the full body lands.
  const fullBody = drilldownAux.full || p.instruction_excerpt || null;
  const preview = p.instruction_preview || null;
  const body = fullBody || preview;
  if (!body) {
    return drilldownAux.fullLoading
      ? HonestState({ key: 'md', kind: 'loading', text: 'Loading served instruction...' })
      : HonestState({
          key: 'md', kind: 'empty',
          text: 'The served instruction body is empty.',
          hint: 'next-step.md exists but carries no instruction text below its header.',
        });
  }
  const showingPreviewOnly = !fullBody && p.instruction_truncated;
  return h('div', { key: 'md', class: 'gm-instruction-body' },
    showingPreviewOnly
      ? h('div', { key: 'pv', class: 'gm-feed-muted gm-mb-4' },
          `Preview -- first ${preview.length} of ${p.instruction_length} characters${drilldownAux.fullLoading ? ', loading the full body...' : ''}`)
      : null,
    renderMarkdown(body));
}

// gm's re-plan edges (EXECUTE|EMIT|VERIFY -> PLAN) are legal and gate-free, so a
// session sitting in PLAN for the second time HAS genuinely reached EXECUTE.
// Index math would erase that and render a legal revisit as a regression, which
// is why the visited SET wins whenever transition history supplies one; index
// math survives only as the fallback for an agent with no recorded transitions.
function PhaseStrip(phases, phasesVisited, currentPhaseIndex) {
  return h('div', { class: 'gm-phase-strip' },
    ...phases.map((ph, i) => {
      const reached = phasesVisited.size
        ? phasesVisited.has(ph)
        : (currentPhaseIndex >= 0 && i <= currentPhaseIndex);
      const isCurrent = i === currentPhaseIndex;
      return h('span', {
        key: ph,
        class: 'gm-phase-step' + (reached ? ' is-reached' : '') + (isCurrent ? ' is-current' : ''),
        title: reached ? `${ph} -- visited` : `${ph} -- not yet reached`,
      }, ph);
    }));
}

// Projects a live-state row onto the ds SessionCard shape and attaches the
// derived attention signal used for default ordering.
function toAgent(p) {
  const f = seedFeed(p);
  const running = currentDispatch(f.rows);
  const abandoned = resolveInflight(f.rows).find(o => o.abandoned) || null;
  const durs = verbDurations(f.rows);
  const medianMsForRunningVerb = running ? (durs.find(d => d.verb === running.verb) || {}).median : null;
  const multipleOfMedian = running && medianMsForRunningVerb && running.ageMs
    ? running.ageMs / medianMsForRunningVerb
    : null;
  const agent = {
    row: p,
    feed: f,
    gates: gatesFor(p),
    burndown: prdBurndown(f.rows),
    devTrend: deviationTrend(f.rows),
    inflight: running || abandoned,
    slowDispatch: multipleOfMedian && multipleOfMedian > DISPATCH_SLOW_MULTIPLE_OF_MEDIAN ? multipleOfMedian : null,
  };
  agent.attention = attentionScore(agent, Date.now());
  return agent;
}

// live-state does not carry PRD/mutable pressure, but /api/projects (already
// fetched at boot into state.projects) does for every project.
function pendingLabel(p) {
  const proj = (state.projects || []).find(r => r.cwd === p.cwd);
  if (!proj || proj.prd_pending == null) return null;
  return `prd ${proj.prd_pending}/${proj.prd_total} · mut ${proj.mut_unknown}`;
}

// gm's next-step.md leads with a constant ORCHESTRATOR preamble before the
// phase section, so this heading read "ORCHESTRATOR" on every project until
// registry.js started taking the LAST top-level heading. It is instruction
// provenance, not a phase, and says so.
function servedSectionLabel(p, divergence) {
  const served = p.instruction_heading || p.instruction_key;
  if (!served) return null;
  // With the phase now in the badge, an agreeing served section rendered the
  // same word three times on one card (EMIT / serving EMIT / EMIT). The served
  // heading only carries information when it DISAGREES with turn-state.json --
  // that lag is the thing worth showing.
  if (!divergence && served === authoritativePhase(p)) return null;
  return divergence ? `serving ${served} (phase moved on)` : `serving ${served}`;
}

function toCard(a) {
  const p = a.row;
  const f = a.feed;
  const live = a.attention.liveness;
  const ages = agentAges(p, lastEventTs(f));
  const blocked = a.gates && a.gates.blocked;
  const somethingIsGenuinelyWrong = blocked || p.unparseable || (a.inflight && a.inflight.abandoned);
  return {
    sid: agentKey(p),
    title: basename(p.cwd),
    // The ds card renders `agent` as a badge. p.skill is 'gm' on every project
    // on the machine, so the badge carried nothing; the phase is what actually
    // distinguishes one card from another at a glance.
    agent: authoritativePhase(p) || p.skill || 'gm',
    // The ds card renders this slot as a bare word beside the phase. It must say
    // what the word IS, because the served prose legitimately lags
    // turn-state.json -- measured live, casey served PLAN while its phase was
    // COMPLETE -- so an unlabelled "PLAN" beside "COMPLETE" reads as two
    // contradictory phases rather than as provenance plus authoritative state.
    model: servedSectionLabel(p, phaseDivergence(p)),
    cwd: p.cwd,
    phase: authoritativePhase(p),
    phases: phaseUniverse(p),
    phasesSeen: phasesSeenFrom(f, p),
    elapsedMs: ages.sinceEnteringPhase,
    counter: pendingLabel(p) || (f.rows.length ? f.rows.length + ' events' : null),
    // ds SessionCard prefixes this with "last " itself (ds sessions.js:261), so
    // the value must NOT repeat the word -- witnessed in the real DOM rendering
    // as "last last event 30s ago" when it did.
    lastActivity: ages.sinceLastEvent != null
      ? `event ${fmtDuration(ages.sinceLastEvent)} ago`
      : (live === 'none' ? 'gm state: none' : 'event: none observed'),
    currentTool: a.inflight
      ? (a.inflight.abandoned ? `${a.inflight.verb} never completed` : `${a.inflight.verb}${a.inflight.ageMs != null ? ' ' + fmtDuration(a.inflight.ageMs) : ''}`)
      : (blocked ? 'blocked: ' + a.gates.blockers[0].gate : null),
    // 'error' is reserved for something genuinely wrong, never for a merely-idle
    // agent -- 'stale' is what an idle or finished agent gets.
    status: somethingIsGenuinelyWrong ? 'error' : (live === 'active' ? 'running' : 'stale'),
    _agent: a,
  };
}

const WORKING_LIVENESS = ['active', 'idle'];
const AGENTS_BACKFILLED_PER_RENDER = 12;
const ATTENTION_REASONS_SHOWN = 3;

const isWorking = (a) => WORKING_LIVENESS.includes(a.attention.liveness);

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

  // Discovery finds 63 directories on this machine and only a handful are
  // actually working, so the idle/abandoned/not-an-agent majority folds away by
  // default. A plain cap would not do this job: a cap hides an ARBITRARY
  // majority, this hides a classified one and says how many and why.
  const q = liveState.filter.trim().toLowerCase();
  const working = agents.filter(isWorking);
  const foldedAway = agents.filter(a => !isWorking(a));

  // A filter always searches EVERY discovered project, folded or not, so a
  // search can reach a project the default view hides.
  let visible = q
    ? agents.filter(a => [a.row.cwd, a.row.phase, a.row.skill, a.row.instruction_key, a.row.instruction_heading]
        .some(v => String(v || '').toLowerCase().includes(q)))
    : (liveState.aliveOnly ? working : agents);
  // The toggle keeps only agents that have at least one stated reason, rather
  // than those clearing an invented score cutoff. A score threshold made the
  // criterion unnameable -- an agent at 25 ("idle mid-chain") vanished while one
  // at 30 stayed, and nothing on screen said 25 was the reason. "Has a reason"
  // is a criterion the strip can print, and the hidden count rides with it.
  const withoutStatedReason = liveState.errorsOnly
    ? visible.filter(a => a.attention.reasons.length === 0).length
    : 0;
  if (liveState.errorsOnly) visible = visible.filter(a => a.attention.reasons.length > 0);

  // At 63 rows this ordering, not any cap, decides what an observer ever
  // actually sees, so it answers "where do I look first" rather than sorting
  // alphabetically or by plain liveness.
  visible = [...visible].sort((a, b) => b.attention.score - a.attention.score);

  const cards = visible.map(toCard);
  const notAgents = foldedAway.filter(a => a.attention.liveness === 'none').length;
  const finished = foldedAway.length - notAgents;

  // Only the agents actually on screen pull their own history, so a 63-project
  // machine never issues 63 backfill requests for rows nobody is looking at.
  for (const a of visible.slice(0, AGENTS_BACKFILLED_PER_RENDER)) backfillFeed(a.row, () => setBody());

  const emptyText = agents.length === 0
    ? 'No gm projects discovered on this machine yet.'
    : q ? `No project matches "${liveState.filter}" (searched all ${agents.length}).`
      : liveState.errorsOnly ? `No agent has a stated reason right now (${agents.length} reported by live-state). Untick "needs attention" to see them all.`
        : 'No agent is working right now. Turn off "working only" to see finished and idle projects.';

  // "dispatching now" is the healthy state, so a strip headed "Needs attention"
  // listing it told the reader an agent needed attention for working normally --
  // measured live with 2 of 3 entries reading exactly that. Anomalous reasons
  // only; the ranking itself still counts dispatching, and every agent remains
  // visible in the cards regardless.
  const anomalousReasonOf = (a) => a.attention.reasons.find(r => r !== REASON_DISPATCHING_NOW);
  const topReasons = visible.slice(0, ATTENTION_REASONS_SHOWN)
    .map(a => ({ a, reason: anomalousReasonOf(a) }))
    .filter(x => x.reason);

  return h('div', {},
    h('div', { key: 'tb', class: 'gm-toolbar' },
      Toggle({
        checked: liveState.aliveOnly, label: 'working only',
        onChange: (v) => { liveState.aliveOnly = v; setBody(); },
      }),
      // Three surfaces on this machine report three different totals for
      // "projects" (CLI 66, data layer 174, this route 63), so a bare number is
      // ambiguous and every count names WHICH source produced it.
      h('span', { class: 'gm-feed-muted' },
        q
          ? `${visible.length} of ${agents.length} match (searched every project live-state reports)`
          : `${visible.length} shown / ${agents.length} reported by live-state`),
      withoutStatedReason > 0
        ? h('span', { class: 'gm-feed-muted' },
            `+${withoutStatedReason} hidden by "needs attention" (no stated reason) -- untick to show`)
        : null,
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
          ...topReasons.map(({ a, reason }) => h('button', {
            key: a.row.cwd, type: 'button', class: 'gm-attention-item',
            onclick: () => openDrilldown(a.row, setBody),
          }, `${basename(a.row.cwd)} -- ${reason}`)))
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

// Gates and driving prompts once needed a side-channel `/api/agent-context`
// route that was never implemented, so the probe fired a guaranteed 404 on every
// boot (witnessed in the real browser as `HTTP 404 /api/agent-context?cwd=...`
// on every page load). live-state now carries both inline on every row, so this
// remains only because app.js's boot sequence still calls it.
export async function loadAgentContext() {}
