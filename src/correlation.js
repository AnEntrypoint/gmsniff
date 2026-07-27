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
//   1. sess          -- only on legacy gm-log events. Real when present, absent live.
//   2. session_id    -- .gm/turn-state.json's own field. Real and stable when the project sets
//                       it (C:/dev/gm carries "claude-loop-iter17"), but null on most projects.
//   3. cwd + run     -- ALWAYS available. `run` is the watcher-spawn epoch: watcher.log carries
//                       "--- watcher spawn <iso> supervisor=<pid> reason=<r>" banners, and every
//                       event after a banner belongs to that daemon run. This is a real boundary
//                       present in the file, not an invented one -- it is the coarsest honest
//                       grouping and the only one that covers all live events.
//
// correlationOf returns { key, kind, cwd, run } so a caller can both group AND know how much the
// grouping is worth. kind is one of 'sess' | 'session_id' | 'run' | 'cwd'; a UI must be able to
// say "grouped by daemon run, not by agent session" rather than implying session fidelity that
// the data does not have.

export const CORRELATION_KINDS = ['sess', 'session_id', 'run', 'cwd'];

function canonCwd(cwd) {
  return cwd ? String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
}

export function correlationOf(ev) {
  if (!ev) return { key: '(none)', kind: 'cwd', cwd: null, run: null };
  const cwd = ev.cwd || null;
  const run = ev._run || null;
  if (ev.sess) return { key: ev.sess, kind: 'sess', cwd, run };
  if (ev.session_id) return { key: ev.session_id, kind: 'session_id', cwd, run };
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
  const counts = { sess: 0, session_id: 0, run: 0, cwd: 0 };
  for (const e of events || []) counts[correlationOf(e).kind]++;
  const total = (events || []).length;
  const best = CORRELATION_KINDS.find(k => counts[k] > 0) || null;
  return { total, counts, best_kind: best, has_true_session: counts.sess > 0 || counts.session_id > 0 };
}
