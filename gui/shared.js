// ./data.js is imported lazily, inside the one function that fetches, rather
// than at module scope. Everything else exported here is a pure function over a
// row, and a static import would drag in data.js's `ds/` bare specifier -- a
// browser-importmap alias Node cannot resolve -- making this module
// unloadable outside a browser and its pure functions untestable. That is
// exactly how a ten-term attention score and a row-dropping filter reached the
// client with no test covering either.
export function basename(cwd) {
  if (!cwd) return '(unknown)';
  return String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || String(cwd);
}

// /api/capabilities is authoritative for both lists; these literals exist only
// so the first paint before that fetch lands is never an empty list.
const SEED_VERBS_UNTIL_CAPABILITIES_LAND = ['instruction', 'transition', 'residual-scan', 'phase-status'];
const SEED_SUBS_UNTIL_CAPABILITIES_LAND = ['plugkit', 'hook', 'bootstrap', 'memory'];

const caps = { verbs: null, subs: null, loaded: false };

export function verbAllowlist() { return caps.verbs || SEED_VERBS_UNTIL_CAPABILITIES_LAND; }
export function subsystemList() { return caps.subs || SEED_SUBS_UNTIL_CAPABILITIES_LAND; }

export async function loadCapabilities() {
  const { api } = await import('./data.js');
  const r = await api('/api/capabilities');
  if (r && !r.error) {
    if (Array.isArray(r.verbAllowlist) && r.verbAllowlist.length) caps.verbs = r.verbAllowlist;
    if (Array.isArray(r.subsystems) && r.subsystems.length) caps.subs = r.subsystems;
    caps.loaded = true;
  }
  return caps;
}

// A subsystem tag seen in real data that capabilities did not list still becomes
// selectable, rather than being silently unfilterable.
export function mergeObservedSubsystems(observed) {
  if (!Array.isArray(observed) || !observed.length) return subsystemList();
  caps.subs = [...new Set([...(caps.subs || SEED_SUBS_UNTIL_CAPABILITIES_LAND), ...observed])];
  return caps.subs;
}

// A project's .gm/instructions/fsm/graph.json can redefine the states wholesale,
// and one is live on this machine today -- so a hardcoded six-phase walk is
// already wrong for a real project and this literal is only the last resort for
// a row that carries no phase list of its own.
export const PHASE_FALLBACK = ['PLAN', 'EXECUTE', 'EMIT', 'VERIFY', 'CONSOLIDATE', 'COMPLETE'];

export function phaseUniverse(row) {
  if (!row) return PHASE_FALLBACK;
  if (Array.isArray(row.phases) && row.phases.length) return row.phases;
  if (Array.isArray(row.fsm_states) && row.fsm_states.length) {
    return row.fsm_states.map(s => (typeof s === 'string' ? s : s.key)).filter(Boolean);
  }
  const currentPhaseProvesFallbackIncomplete = row.phase && !PHASE_FALLBACK.includes(row.phase);
  if (currentPhaseProvesFallbackIncomplete) return [...PHASE_FALLBACK, row.phase];
  return PHASE_FALLBACK;
}

// Measured live: gmsniff 0s / spoint 0s (working), casey 8_016s (idle ~2h),
// gm 173_718s (abandoned ~2d) -- three genuinely different states the daemon's
// shared `alive` flag rendered identically.
export const ACTIVE_MAX_MS = 10 * 60 * 1000;
export const IDLE_MAX_MS = 6 * 60 * 60 * 1000;

// A marker written by another machine, or by a since-corrected clock, can carry
// a future timestamp; clamping at zero keeps a caller from rendering "-3m ago".
export function ageMs(ts, now = Date.now()) {
  if (ts == null) return null;
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const ageSinceTs = now - t;
  return ageSinceTs < 0 ? 0 : ageSinceTs;
}

// A nullable measurement inverts its own meaning under default numeric
// coercion: `staleSeconds == null` means "no events EVER recorded", and letting
// it coerce to 0 sorted the most-suspicious project last, exactly where a
// reader stops looking. Absent is Infinity here -- the most silent -- and that
// decision is made explicitly rather than left to the comparator.
//
// Lives here rather than in app.js because app.js imports `webjsx` and the
// `ds/` importmap alias and touches `document` at module scope, so it is
// structurally unloadable outside a browser and nothing in it can be asserted.
export function longestSilentFirst(a, b) {
  const silenceOf = (r) => (r.staleSeconds == null ? Infinity : r.staleSeconds);
  return (silenceOf(b) - silenceOf(a)) || ((b.deviationRate || 0) - (a.deviationRate || 0));
}

// Discovery walks the machine and finds 63 directories; 7 carry no phase at all
// and 4 have no next-step.md (esp-idf-link, test, ai-data-extraction, codex,
// measured live). Rendering those as agents in an unknown phase would make
// discovery's own breadth the dominant noise source.
export function isAgent(row) {
  return !!(row && row.present && row.phase);
}

// The server publishes `activity`, classified from last_activity_age_ms over the
// real watcher-log tail (measured on this machine: dispatching 3, idle 1,
// abandoned 138, unknown 536). It is authoritative because the same
// classification is what the route filters on, so client and server cannot
// disagree about which agents are working.
//
// The shared-daemon `alive` flag is deliberately NOT consulted: it reported all
// 63 projects identically (19 "alive", including 2-day-idle ones) while the ages
// behind those same rows spanned 143s to 173,718s.
const ACTIVITY_TO_LIVENESS = {
  dispatching: 'active', active: 'active', idle: 'idle',
  abandoned: 'dead', dead: 'dead', unknown: 'unknown',
};

export function liveness(row, now = Date.now()) {
  if (!isAgent(row)) return 'none';
  if (row && typeof row.activity === 'string' && ACTIVITY_TO_LIVENESS[row.activity]) {
    return ACTIVITY_TO_LIVENESS[row.activity];
  }
  const ageForOlderServerWithoutActivity = (typeof row.last_event_ms === 'number' && Number.isFinite(row.last_event_ms))
    ? Math.max(0, row.last_event_ms)
    : ageMs(row && (row.last_dispatch_ts ?? row.updated_ts), now);
  if (ageForOlderServerWithoutActivity == null) return 'unknown';
  if (ageForOlderServerWithoutActivity <= ACTIVE_MAX_MS) return 'active';
  if (ageForOlderServerWithoutActivity <= IDLE_MAX_MS) return 'idle';
  return 'dead';
}

export const LIVENESS_LABEL = {
  active: 'working', idle: 'idle', dead: 'abandoned',
  unknown: 'not observed', none: 'not a gm agent',
};

function nonNegative(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : null;
}

// Two ages that answer two different questions and must never collapse into one
// "age": an agent can be 44m in-phase but 1m since its last event (working
// steadily), or 8m in-phase and 3h since its last event (wedged).
//
// The server pre-computes all three as durations because only it can read
// turn-state.json's mtime and the watcher-log tail; the timestamp forms below
// are the fallback for an older server.
export function agentAges(row, feedTs, now = Date.now()) {
  const feedAge = ageMs(feedTs, now);
  const turnStateAge = nonNegative(row && row.in_phase_ms) == null && row && row.turn_state && row.turn_state.updated_at_ms
    ? ageMs(row.turn_state.updated_at_ms, now)
    : null;
  const snapshotEventAge = nonNegative(row && row.last_event_ms) ?? ageMs(row && row.last_event_ts, now);
  return {
    sinceEnteringPhase: nonNegative(row && row.in_phase_ms)
      ?? turnStateAge
      ?? ageMs(row && (row.phase_changed_ts ?? row.updated_ts), now),
    // Whichever is FRESHER wins: a live SSE append can be newer than the
    // snapshot the list was built from, and a snapshot can be newer than a feed
    // that never seeded.
    sinceLastEvent: feedAge == null ? snapshotEventAge
      : snapshotEventAge == null ? feedAge
        : Math.min(feedAge, snapshotEventAge),
    sinceInstructionServed: nonNegative(row && row.instruction_served_ms)
      ?? ageMs(row && (row.instruction_served_ts ?? row.updated_ts), now),
  };
}

// The served prose on disk can lag the actual FSM state: next-step.md still said
// PLAN while turn-state.json had already moved to EXECUTE (observed live on
// spoint). The server publishes both sides of one comparison so the flag and the
// two phases it names can never come from separately-derived fields.
// The one reason describing a HEALTHY agent. It still contributes to the
// ranking -- a dispatching agent is what an observer most wants at the top --
// but a "Needs attention" strip listing it says an agent needs attention for
// working normally, which is why that strip filters on this constant rather
// than on an invented severity for the other seven reasons.
export const REASON_DISPATCHING_NOW = 'dispatching now';

export function phaseDivergence(row) {
  if (!row) return null;
  const served = row.phase_served ?? row.instruction_phase ?? row.next_step_phase ?? null;
  const actual = row.phase_authoritative
    ?? (row.turn_state && row.turn_state.phase)
    ?? row.turn_state_phase ?? row.phase ?? null;
  if (!served || !actual || served === actual) return null;
  return { served, actual };
}

// The phase to LEAD with. turn-state.json is the authoritative FSM state;
// next-step.md's header is instruction provenance that legitimately lags it
// (witnessed live: the gmsniff card read PLAN from the served prose while
// turn-state had already moved to EXECUTE). The lag is surfaced by
// phaseDivergence rather than silently resolved here.
export function authoritativePhase(row) {
  if (!row) return null;
  return row.phase_authoritative
    ?? (row.turn_state && row.turn_state.phase)
    ?? row.phase
    ?? row.phase_served
    ?? null;
}

// Measured against the real log: 45 dispatch.start against 2721 dispatch.end,
// and dispatch.start's `ts` is the EMPTY STRING while its correlation key is
// `task`. So starts are logged for only a fraction of dispatches, and a naive
// unmatched-start scan reports dozens of agents as perpetually running forever.
// Pairing strictly on `task` and ageing a start out past this bound are the two
// guards that make that structurally impossible.
export const ABANDON_MS = 5 * 60 * 1000;

export function resolveInflight(rows, now = Date.now()) {
  const completedTasks = new Set();
  for (const r of rows || []) {
    if (r.kind === 'dispatch' && !r.inflight && r.task != null) completedTasks.add(String(r.task));
  }
  const stillOpen = [];
  for (const r of rows || []) {
    if (r.kind !== 'dispatch' || !r.inflight) continue;
    if (r.task != null && completedTasks.has(String(r.task))) continue;
    // A start whose ts the source left blank cannot be aged, so it reports as
    // unknown-duration rather than as assumed-running-now.
    const age = ageMs(r.ts, now);
    stillOpen.push({ verb: r.verb, task: r.task, ts: r.ts, ageMs: age, abandoned: age != null && age > ABANDON_MS });
  }
  return stillOpen;
}

export function currentDispatch(rows, now = Date.now()) {
  const newestFirstStillRunning = resolveInflight(rows, now).filter(o => !o.abandoned);
  return newestFirstStillRunning.length ? newestFirstStillRunning[newestFirstStillRunning.length - 1] : null;
}

// dispatch.end carries a real `ms`, so a per-verb median is what turns "this
// dispatch is running unusually long" into a measurement rather than a guess.
export function verbDurations(rows) {
  const msByVerb = new Map();
  for (const r of rows || []) {
    if (r.kind !== 'dispatch' || r.ms == null || !r.verb) continue;
    if (!msByVerb.has(r.verb)) msByVerb.set(r.verb, []);
    msByVerb.get(r.verb).push(r.ms);
  }
  const out = [];
  for (const [verb, list] of msByVerb) {
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

// instruction.served carries prd_pending_count over time, and converging vs
// accumulating is the real predictor of whether a run will land.
export function prdBurndown(rows) {
  const points = (rows || [])
    .filter(r => r.kind === 'instruction' && r.prd_pending != null && r.ts)
    .map(r => ({ ts: r.ts, pending: r.prd_pending }));
  if (points.length < 2) return { points, trend: 'unknown', delta: 0 };
  const delta = points[points.length - 1].pending - points[0].pending;
  return { points, trend: delta < 0 ? 'converging' : (delta > 0 ? 'accumulating' : 'flat'), delta };
}

// A rate rising WITHIN a run is actionable where a flat lifetime count is not,
// so this compares the newest half of the observed window against the oldest.
export function deviationTrend(rows, now = Date.now()) {
  const devTimes = (rows || []).filter(r => r.kind === 'deviation' && r.ts).map(r => Date.parse(r.ts)).filter(Number.isFinite);
  if (devTimes.length < 2) return { count: devTimes.length, trend: 'flat', recent: devTimes.length };
  const oldest = Math.min(...devTimes);
  const windowMidpoint = oldest + (now - oldest) / 2;
  const inOlderHalf = devTimes.filter(t => t < windowMidpoint).length;
  const inNewerHalf = devTimes.filter(t => t >= windowMidpoint).length;
  return {
    count: devTimes.length, recent: inNewerHalf,
    trend: inNewerHalf > inOlderHalf ? 'rising' : (inNewerHalf < inOlderHalf ? 'falling' : 'flat'),
  };
}

// Default ordering answers "where do I look first", not "what is alphabetically
// first". Higher score = needs a human sooner, and every contribution rides
// along as a reason so the UI can SAY why a row is at the top rather than only
// placing it there.
const SCORE_GATE_BLOCKED = 50;
const SCORE_PER_ADDITIONAL_BLOCKER = 5;
const SCORE_DISPATCH_NEVER_COMPLETED = 45;
const SCORE_UNPARSEABLE_INSTRUCTION = 40;
const SCORE_DEVIATION_RATE_RISING = 35;
const SCORE_DISPATCH_RUNNING_SLOW = 30;
const SCORE_IDLE_MID_CHAIN = 25;
const SCORE_PRD_BACKLOG_GROWING = 20;
const SCORE_DISPATCHING_NOW = 10;
const SCORE_NOT_A_GM_AGENT = -1;

export function attentionScore(agent, now = Date.now()) {
  const reasons = [];
  let score = 0;
  const live = liveness(agent.row, now);

  // A discovered directory with no gm state can never need attention, so it
  // sorts below everything rather than competing for the top of a 63-row list.
  if (live === 'none') return { score: SCORE_NOT_A_GM_AGENT, reasons: [], liveness: live };

  if (agent.gates && agent.gates.blocked) {
    score += SCORE_GATE_BLOCKED + agent.gates.blockers.length * SCORE_PER_ADDITIONAL_BLOCKER;
    reasons.push(`blocked by ${agent.gates.blockers.map(b => b.gate).join(', ')}`);
  }
  if (agent.inflight && agent.inflight.abandoned) {
    score += SCORE_DISPATCH_NEVER_COMPLETED;
    reasons.push(`dispatch ${agent.inflight.verb} never completed`);
  }
  if (agent.devTrend && agent.devTrend.trend === 'rising') {
    score += SCORE_DEVIATION_RATE_RISING;
    reasons.push(`deviation rate rising (${agent.devTrend.recent} recent)`);
  }
  if (agent.slowDispatch) {
    score += SCORE_DISPATCH_RUNNING_SLOW;
    reasons.push(`${agent.inflight.verb} running ${Math.round(agent.slowDispatch)}x its median`);
  }
  if (agent.burndown && agent.burndown.trend === 'accumulating') {
    score += SCORE_PRD_BACKLOG_GROWING;
    reasons.push(`PRD backlog growing (+${agent.burndown.delta})`);
  }
  const idleAtTerminalPhase = agent.row && agent.row.phase === 'COMPLETE';
  if (live === 'idle' && !idleAtTerminalPhase) { score += SCORE_IDLE_MID_CHAIN; reasons.push('idle mid-chain'); }
  if (live === 'active') { score += SCORE_DISPATCHING_NOW; reasons.push(REASON_DISPATCHING_NOW); }
  if (agent.row && agent.row.unparseable) { score += SCORE_UNPARSEABLE_INSTRUCTION; reasons.push('next-step.md unparseable'); }

  return { score, reasons, liveness: live };
}

