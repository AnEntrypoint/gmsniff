// MEASURED: live evt lines carry NO `sess` field -- zero occurrences across every discovered
// project's real watcher.log (13,688 evt lines in C:/dev/gmsniff alone). `sess` was a
// gm-log-era field, so a consumer keyed on e.sess groups 100% of live events under '(no-session)'.
//
// REJECTED: minting a synthetic per-event session id. A fabricated key makes the session panels
// look populated while the grouping carries no meaning, which is strictly worse than an honest
// empty.
//
// REJECTED: a `session_id` tier. It matched exactly ZERO of 233,443 replayed events, and the
// reason is structural rather than a coverage gap: `session_id` is a field of .gm/turn-state.json
// (PROJECT state), and gm never copies it onto an emitted event. rs-plugkit's emit_event
// (wasm_dispatch/events.rs) inserts exactly `event`, `sess` and `ts`; the hand-rolled json!
// emitters (gates.rs, lib.rs, instructions/mod.rs) carry `event`/`sub`/`detail`/`ts`/`source`.
// Project-level session identity remains available from readTurnState(cwd).session_id -- it is
// simply not an event correlation key.

// Ranked strongest identity first. Rank order is load-bearing: correlationOf tries them in this
// order, and correlationCoverage reads counts[STRONGEST_FIRST[0]] as the best identity present.
export const CORRELATION_KINDS = ['sess', 'run', 'cwd'];
const STRONGEST_FIRST = CORRELATION_KINDS;

function canonCwd(cwd) {
  return cwd ? String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
}

const NO_IDENTITY = { key: '(none)', kind: 'cwd', cwd: null, run: null };

// Returns { key, kind, cwd, run } so a caller can both group AND know what the grouping is worth.
// `run` is the watcher-spawn epoch: watcher.log carries "--- watcher spawn <iso> supervisor=<pid>
// reason=<r>" banners and every event after a banner belongs to that daemon run, so a run-keyed
// group is a DAEMON RUN, not an agent session, and a UI must be able to say so.
export function correlationOf(ev) {
  if (!ev) return { ...NO_IDENTITY };
  const cwd = ev.cwd || null;
  const run = ev._run || null;
  const agentSessionId = ev.sess;
  if (agentSessionId) return { key: agentSessionId, kind: 'sess', cwd, run };
  if (cwd && run) return { key: `${canonCwd(cwd)}#${run}`, kind: 'run', cwd, run };
  if (cwd) return { key: canonCwd(cwd), kind: 'cwd', cwd, run: null };
  return { ...NO_IDENTITY };
}

export function correlationKey(ev) {
  return correlationOf(ev).key;
}

export function correlationCoverage(events) {
  const counts = { sess: 0, run: 0, cwd: 0 };
  for (const e of events || []) counts[correlationOf(e).kind]++;
  const total = (events || []).length;
  const strongestKindPresentAnywhere = STRONGEST_FIRST.find(k => counts[k] > 0) || null;
  let mostCommonKind = null, mostCommonCount = -1;
  for (const k of STRONGEST_FIRST) if (counts[k] > mostCommonCount) { mostCommonCount = counts[k]; mostCommonKind = k; }
  return {
    total, counts,
    best_kind: strongestKindPresentAnywhere,
    dominant_kind: total ? mostCommonKind : null,
    dominant_ratio: total ? Number((mostCommonCount / total).toFixed(4)) : null,
    has_true_session: counts.sess > 0,
  };
}
