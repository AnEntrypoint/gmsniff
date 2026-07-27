import { toast as dsToast } from 'ds/components/editor-primitives.js';

export const SERVER_DEFAULT_OWN_ROOT = null;

export const state = {
  cwd: SERVER_DEFAULT_OWN_ROOT,
  projects: [],
};

export function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function fmtTs(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }); }
  catch { return String(ts); }
}

function withCwd(path) {
  if (!state.cwd) return path;
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + 'cwd=' + encodeURIComponent(state.cwd);
}

export async function api(path, { scoped = false } = {}) {
  try {
    const url = scoped ? withCwd(path) : path;
    const r = await fetch(url);
    return await r.json();
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

export async function apiPost(path, body, { scoped = false } = {}) {
  try {
    const payload = scoped ? { ...body, cwd: state.cwd || undefined } : body;
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, ...json };
  } catch (e) {
    return { status: 0, error: String(e && e.message || e) };
  }
}

// liveness=0 because no panel reads that sub-object -- it was 110KB of the
// route's measured 163KB across 173 rows, fetched on every roster refresh.
export async function loadProjects() {
  const r = await api('/api/projects?liveness=0');
  state.projects = Array.isArray(r.projects) ? r.projects : [];
  return state.projects;
}

// Routed through the ds toast host because the previous local implementation
// rendered every gm-toast at the same fixed bottom-right coordinate, so
// concurrent toasts clobbered each other instead of stacking.
export function toast(msg, isErr) {
  return dsToast({ message: msg, kind: isErr ? 'error' : 'info', duration: 4000 });
}
