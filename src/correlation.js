// Correlation identity for live watcher.log events.
//
// THE FACT: live evt lines carry NO `sess` field -- zero occurrences across every discovered
// project's real watcher.log (13,688 evt lines in C:/dev/gmsniff alone). The `sess` key was a
// gm-log-era field. Every consumer keyed on e.sess therefore groups 100% of live events under
// '(no-session)'.
//
// THE DECISION: do not mint a synthetic per-event session id. A fabricated key would make the
// session panels *look* populated while the grouping carried no real meaning, which is strictly
// worse than an honest empty. Instead expose the correlation identities that genuinely exist in
// the data, ranked, so a consumer picks the strongest one available per event:
//
//   1. sess          -- gm's own per-event session key. Written by rs-plugkit's emit_event, which
//                       reads .gm/exec-spool/.session-current and attaches it as `sess` when that
//                       file is non-empty. Real, and the ONLY true session identity on an event.
//   2. cwd + run     -- ALWAYS available. `run` is the watcher-spawn epoch: watcher.log carries
//                       "--- watcher spawn <iso> supervisor=<pid> reason=<r>" banners, and every
//                       event after a banner belongs to that daemon run. This is a real boundary
//                       present in the file, not an invented one -- it is the coarsest honest
//                       grouping and the only one that covers all live events.
//
// A `session_id` TIER WAS REMOVED HERE, and its removal is the honest fix rather than a
// simplification. It ranked second and matched exactly ZERO events out of 233,443 replayed. The
// reason is structural, not a coverage gap: `session_id` is a field of .gm/turn-state.json --
// PROJECT state -- and gm never copies it onto an emitted event. rs-plugkit's emit_event
// (wasm_dispatch/events.rs) inserts exactly three intrinsic keys, `event`, `sess` and `ts`, and
// the hand-rolled json! emitters (gates.rs, lib.rs, instructions/mod.rs) carry `event`/`sub`/
// `detail`/`ts`/`source`. There is no code path on which `ev.session_id` can ever be defined, so
// the tier could never fire for any input -- it was reporting a coverage dimension that does not
// exist. Project-level session identity is still available, from readTurnState(cwd).session_id;
// it is simply not an event correlation key, and pretending otherwise made the ranked list look
// like it had a fallback it did not have.
//
// correlationOf returns { key, kind, cwd, run } so a caller can both group AND know how much the
// grouping is worth. kind is one of 'sess' | 'run' | 'cwd'; a UI must be able to say "grouped by
// daemon run, not by agent session" rather than implying session fidelity the data lacks.

export const CORRELATION_KINDS = ['sess', 'run', 'cwd'];

function canonCwd(cwd) {
  return cwd ? String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
}

export function correlationOf(ev) {
  if (!ev) return { key: '(none)', kind: 'cwd', cwd: null, run: null };
  const cwd = ev.cwd || null;
  const run = ev._run || null;
  if (ev.sess) return { key: ev.sess, kind: 'sess', cwd, run };
  if (cwd && run) return { key: `${canonCwd(cwd)}#${run}`, kind: 'run', cwd, run };
  if (cwd) return { key: canonCwd(cwd), kind: 'cwd', cwd, run: null };
  return { key: '(none)', kind: 'cwd', cwd: null, run: null };
}

export function correlationKey(ev) {
  return correlationOf(ev).key;
}

// Summarizes which correlation kinds a set of events actually resolved to, so a caller can
// report the real fidelity of its own grouping instead of asserting session-level accuracy.
export function correlationCoverage(events) {
  const counts = { sess: 0, run: 0, cwd: 0 };
  for (const e of events || []) counts[correlationOf(e).kind]++;
  const total = (events || []).length;
  const best = CORRELATION_KINDS.find(k => counts[k] > 0) || null;
  // `best_kind` is the strongest identity present ANYWHERE in the set, which is not the identity
  // most events actually resolved to -- a handful of sess-carrying events makes best_kind 'sess'
  // while 99% of the set is run-keyed. dominant_kind reports what the grouping is really worth,
  // so a caller does not read a rare strong identity as characterizing the whole set.
  let dominant = null, max = -1;
  for (const k of CORRELATION_KINDS) if (counts[k] > max) { max = counts[k]; dominant = k; }
  return {
    total, counts,
    best_kind: best,
    dominant_kind: total ? dominant : null,
    dominant_ratio: total ? Number((max / total).toFixed(4)) : null,
    has_true_session: counts.sess > 0,
  };
}
