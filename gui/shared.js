// Cross-panel helpers that were previously computed four different ways in
// panels.js/app.js, plus the live-manager's derived vocabulary (liveness,
// attention, phase universe). Everything here is derived from what the server
// really publishes -- measured against live gm-log data, never assumed.

import { api } from './data.js';

// ---------------------------------------------------------------------------
// BASENAME -- was computed four separate ways (two regex variants in panels.js,
// one in app.js's HealthBanner path, one inline in Dashboard). One helper now.
// ---------------------------------------------------------------------------
export function basename(cwd) {
  if (!cwd) return '(unknown)';
  return String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || String(cwd);
}

// ---------------------------------------------------------------------------
// SERVER-PUBLISHED VOCABULARY -- /api/capabilities is authoritative for the
// verb allowlist and the subsystem universe. Both were hardcoded client-side
// (27 verbs in panels.js, a 4-entry SUB_LIST seed); both drift. The seeds stay
// only as the pre-fetch fallback so the first paint is never empty.
// ---------------------------------------------------------------------------
const SEED_VERBS = ['instruction', 'transition', 'residual-scan', 'phase-status'];
const SEED_SUBS = ['plugkit', 'hook', 'bootstrap', 'memory'];

const caps = { verbs: null, subs: null, loaded: false };

export function verbAllowlist() { return caps.verbs || SEED_VERBS; }
export function subsystemList() { return caps.subs || SEED_SUBS; }
export function capabilitiesLoaded() { return caps.loaded; }

// Fetched once at boot, before the first panel renders, so no panel ever paints
// a hardcoded list when the real one is a fetch away.
export async function loadCapabilities() {
  const r = await api('/api/capabilities');
  if (r && !r.error) {
    if (Array.isArray(r.verbAllowlist) && r.verbAllowlist.length) caps.verbs = r.verbAllowlist;
    if (Array.isArray(r.subsystems) && r.subsystems.length) caps.subs = r.subsystems;
    caps.loaded = true;
  }
  return caps;
}

// Runtime growth: a subsystem tag observed in real data that capabilities did
// not list still becomes selectable, rather than being silently unfilterable.
export function mergeObservedSubsystems(observed) {
  if (!Array.isArray(observed) || !observed.length) return subsystemList();
  caps.subs = [...new Set([...(caps.subs || SEED_SUBS), ...observed])];
  return caps.subs;
}

// ---------------------------------------------------------------------------
// PHASE UNIVERSE -- .gm/instructions/fsm/graph.json can redefine the states
// wholesale, and one is live on this machine today, so a hardcoded six-phase
// walk is already wrong for a real project. Take the list from whatever the row
// carries; the literal is only the last-resort fallback for a row that carries
// nothing at all.
// ---------------------------------------------------------------------------
export const PHASE_FALLBACK = ['PLAN', 'EXECUTE', 'EMIT', 'VERIFY', 'CONSOLIDATE', 'COMPLETE'];

export function phaseUniverse(row) {
  if (!row) return PHASE_FALLBACK;
  if (Array.isArray(row.phases) && row.phases.length) return row.phases;
  if (Array.isArray(row.fsm_states) && row.fsm_states.length) {
    return row.fsm_states.map(s => (typeof s === 'string' ? s : s.key)).filter(Boolean);
  }
  // A row whose current phase is outside the fallback proves the fallback wrong
  // for this project -- append rather than render the phase as nonexistent.
  if (row.phase && !PHASE_FALLBACK.includes(row.phase)) return [...PHASE_FALLBACK, row.phase];
  return PHASE_FALLBACK;
}

// ---------------------------------------------------------------------------
// LIVENESS -- the shared daemon pid reports every project identically, so
// `alive` alone cannot separate "dispatching right now" from "abandoned two
// days ago". Age since the last dispatch is what actually separates them.
// Measured live: gmsniff 0s / spoint 0s (active), casey 8_016s (idle ~2h),
// gm 173_718s (abandoned ~2d) -- three genuinely different states the old UI
// rendered identically.
// ---------------------------------------------------------------------------
export const ACTIVE_MAX_MS = 10 * 60 * 1000;   // dispatched within 10 min = working
export const IDLE_MAX_MS = 6 * 60 * 60 * 1000; // within 6h = idle, likely resumable

// Clock skew guard: a marker written by another machine (or a corrected clock)
// can be in the future. Never return a negative age, and never let a caller
// render "-3m ago".
export function ageMs(ts, now = Date.now()) {
  if (ts == null) return null;
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const d = now - t;
  return d < 0 ? 0 : d;
}

// A discovered DIRECTORY is not the same thing as a live agent. Discovery walks
// the machine and finds 63 of them; 7 carry no phase at all and 4 have no
// next-step.md (esp-idf-link, test, ai-data-extraction, codex measured live) --
// gm state absent or unreadable. Those must render as "not a gm agent", never
// as an agent in an unknown phase, or breadth itself becomes the noise.
export function isAgent(row) {
  return !!(row && row.present && row.phase);
}

// Returns 'active' | 'idle' | 'dead' | 'unknown' | 'none'.
//
// `alive` is deliberately NOT consulted: the shared daemon pid reports all 63
// projects identically (19 "alive" including 2-day-idle ones), so it cannot
// separate working from abandoned. Age since last dispatch can -- measured ages
// span 143s to 173,718s across the same rows `alive` calls identical.
//
// last_dispatch_ts is the precise signal but is not in the payload yet (0 of 63
// rows carry it today), so updated_ts is the fallback until it lands.
export function liveness(row, now = Date.now()) {
  if (!isAgent(row)) return 'none';
  const age = ageMs(row && (row.last_dispatch_ts ?? row.updated_ts), now);
  if (age == null) return 'unknown';
  if (age <= ACTIVE_MAX_MS) return 'active';
  if (age <= IDLE_MAX_MS) return 'idle';
  return 'dead';
}

export const LIVENESS_LABEL = {
  active: 'working', idle: 'idle', dead: 'abandoned',
  unknown: 'not observed', none: 'not a gm agent',
};

// Two ages that answer two different questions and must never be collapsed into
// one "age" -- the CLI's IN-PHASE and LAST-EVT:
//   inPhase : since turn-state.json's phase last changed -> "stuck in EXECUTE how long"
//   lastEvt : since the last real .watcher.log event     -> "is it still emitting anything"
// An agent can be 44m in-phase but 1m since its last event (working steadily), or
// 8m in-phase and 3h since its last event (wedged). One number hides that.
export function agentAges(row, feedTs, now = Date.now()) {
  return {
    inPhase: ageMs(row && (row.phase_changed_ts ?? row.updated_ts), now),
    lastEvt: ageMs(feedTs ?? (row && row.last_event_ts), now),
    served: ageMs(row && (row.instruction_served_ts ?? row.updated_ts), now),
  };
}

// The served prose on disk can lag the actual FSM state: next-step.md still says
// PLAN while turn-state.json has already moved to EXECUTE (observed live on
// spoint). That is a real, reportable condition -- show BOTH sources and flag the
// divergence rather than silently picking one and presenting it as the truth.
export function phaseDivergence(row) {
  const served = row && (row.instruction_phase ?? row.next_step_phase ?? null);
  const actual = row && (row.turn_state_phase ?? row.phase ?? null);
  if (!served || !actual || served === actual) return null;
  return { served, actual };
}

// ---------------------------------------------------------------------------
// IN-FLIGHT DISPATCH -- a dispatch.start with no matching dispatch.end.
//
// Measured against the real log: 45 dispatch.start vs 2721 dispatch.end, and
// dispatch.start's `ts` is the EMPTY STRING while its correlation key is `task`
// (with `body_bytes`, not body_size). So starts are logged for only a fraction
// of dispatches, and a naive unmatched-start scan reports dozens of agents as
// perpetually "running" forever. Two guards make that structurally impossible:
// pair strictly on `task`, and age out any start older than ABANDON_MS as
// abandoned rather than running.
// ---------------------------------------------------------------------------
export const ABANDON_MS = 5 * 60 * 1000;

export function resolveInflight(rows, now = Date.now()) {
  const ends = new Set();
  for (const r of rows || []) {
    if (r.kind === 'dispatch' && !r.inflight && r.task != null) ends.add(String(r.task));
  }
  const open = [];
  for (const r of rows || []) {
    if (r.kind !== 'dispatch' || !r.inflight) continue;
    if (r.task != null && ends.has(String(r.task))) continue;
    // A start whose ts the source left blank cannot be aged, so it is reported
    // as unknown-duration rather than assumed to be running now.
    const age = ageMs(r.ts, now);
    open.push({ verb: r.verb, task: r.task, ts: r.ts, ageMs: age, abandoned: age != null && age > ABANDON_MS });
  }
  return open;
}

// The verb to show as "running now": the newest still-open, non-abandoned start.
export function currentDispatch(rows, now = Date.now()) {
  const open = resolveInflight(rows, now).filter(o => !o.abandoned);
  return open.length ? open[open.length - 1] : null;
}

// ---------------------------------------------------------------------------
// VERB DURATION DISTRIBUTION -- dispatch.end carries real `ms`. A median per
// verb is what makes "this dispatch is running unusually long" a measurement
// rather than a guess.
// ---------------------------------------------------------------------------
export function verbDurations(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (r.kind !== 'dispatch' || r.ms == null || !r.verb) continue;
    if (!by.has(r.verb)) by.set(r.verb, []);
    by.get(r.verb).push(r.ms);
  }
  const out = [];
  for (const [verb, list] of by) {
    const sorted = [...list].sort((a, b) => a - b);
    out.push({
      verb, count: sorted.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      max: sorted[sorted.length - 1],
    });
  }
  return out.sort((a, b) => b.median - a.median);
}

// ---------------------------------------------------------------------------
// PRD BURNDOWN -- instruction.served carries prd_pending_count over time.
// Converging vs accumulating is the real predictor of whether a run will land.
// ---------------------------------------------------------------------------
export function prdBurndown(rows) {
  const pts = (rows || [])
    .filter(r => r.kind === 'instruction' && r.prd_pending != null && r.ts)
    .map(r => ({ ts: r.ts, pending: r.prd_pending }));
  if (pts.length < 2) return { points: pts, trend: 'unknown', delta: 0 };
  const delta = pts[pts.length - 1].pending - pts[0].pending;
  return { points: pts, trend: delta < 0 ? 'converging' : (delta > 0 ? 'accumulating' : 'flat'), delta };
}

// ---------------------------------------------------------------------------
// DEVIATION RATE TREND -- a rising rate WITHIN a run is actionable; a flat
// lifetime count is not. Compares the newest half of the window to the oldest.
// ---------------------------------------------------------------------------
export function deviationTrend(rows, now = Date.now()) {
  const devs = (rows || []).filter(r => r.kind === 'deviation' && r.ts).map(r => Date.parse(r.ts)).filter(Number.isFinite);
  if (devs.length < 2) return { count: devs.length, trend: 'flat', recent: devs.length };
  const oldest = Math.min(...devs);
  const mid = oldest + (now - oldest) / 2;
  const older = devs.filter(t => t < mid).length;
  const newer = devs.filter(t => t >= mid).length;
  return { count: devs.length, recent: newer, trend: newer > older ? 'rising' : (newer < older ? 'falling' : 'flat') };
}

// ---------------------------------------------------------------------------
// ATTENTION RANKING -- default ordering answers "where do I look first", not
// "what is alphabetically first". Higher score = needs a human sooner. Every
// contribution is a real measured signal, and the reasons ride along so the UI
// can SAY why a row is at the top instead of just placing it there.
// ---------------------------------------------------------------------------
export function attentionScore(agent, now = Date.now()) {
  const reasons = [];
  let score = 0;
  const live = liveness(agent.row, now);

  // A discovered directory with no gm state is not an agent and can never need
  // attention -- it sorts below everything rather than competing for the top of
  // a 63-row list.
  if (live === 'none') return { score: -1, reasons: [], liveness: live };

  if (agent.gates && agent.gates.blocked) {
    const n = agent.gates.blockers.length;
    score += 50 + n * 5;
    reasons.push(`blocked by ${agent.gates.blockers.map(b => b.gate).join(', ')}`);
  }
  if (agent.inflight && agent.inflight.abandoned) {
    score += 45;
    reasons.push(`dispatch ${agent.inflight.verb} never completed`);
  }
  if (agent.devTrend && agent.devTrend.trend === 'rising') {
    score += 35;
    reasons.push(`deviation rate rising (${agent.devTrend.recent} recent)`);
  }
  if (agent.slowDispatch) {
    score += 30;
    reasons.push(`${agent.inflight.verb} running ${Math.round(agent.slowDispatch)}x its median`);
  }
  if (agent.burndown && agent.burndown.trend === 'accumulating') {
    score += 20;
    reasons.push(`PRD backlog growing (+${agent.burndown.delta})`);
  }
  // Idle mid-chain is a real stall; idle at COMPLETE is just a finished run.
  const terminal = agent.row && (agent.row.phase === 'COMPLETE');
  if (live === 'idle' && !terminal) { score += 25; reasons.push('idle mid-chain'); }
  if (live === 'active') { score += 10; reasons.push('dispatching now'); }
  if (agent.row && agent.row.unparseable) { score += 40; reasons.push('next-step.md unparseable'); }

  return { score, reasons, liveness: live };
}

// ---------------------------------------------------------------------------
// LOAD STATE -- the through-line of this rework. A panel must distinguish
// not-yet-loaded from genuinely-empty from source-is-broken, because rendering
// all three as a silent zero is the core failure being corrected. Every panel
// builds one of these instead of a bare Empty().
// ---------------------------------------------------------------------------
export function loadState({ loading, error, total, shown, filtered, scoped }) {
  if (loading) return { kind: 'loading' };
  if (error) return { kind: 'error', detail: String(error) };
  if (scoped === false) return { kind: 'unscoped' };
  if (total === 0) return { kind: 'empty' };
  if (shown === 0 && filtered) return { kind: 'filtered', total };
  return { kind: 'ready' };
}
