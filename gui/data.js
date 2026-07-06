// Fetch/state helpers shared by every panel. Single source of the "current
// project cwd" the switcher controls; every API call routes through here so
// changing project re-scopes every panel uniformly.

import { toast as dsToast } from 'ds/components/editor-primitives.js';

export const state = {
  cwd: null,           // null = server default (own root)
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

export async function loadProjects() {
  const r = await api('/api/projects');
  state.projects = Array.isArray(r.projects) ? r.projects : [];
  return state.projects;
}

// Thin adapter over the design SDK's toast() (ds/components/editor-primitives.js):
// callers here keep the existing toast(msg, isErr) shape (17 call sites across
// panels.js/app.js), but the actual DOM/lifecycle work -- a single fixed-position
// flex-column host (.ds-ep-toast-host) that concurrent toasts append into and
// leave from independently -- comes from the SDK, so multiple concurrent toasts
// stack visibly instead of every gm-toast rendering at the same fixed
// bottom-right coordinate and clobbering each other. isErr maps to kind:'error'
// (SDK also distinguishes 'warn'/'success'/'info', unused via this legacy shape).
export function toast(msg, isErr) {
  return dsToast({ message: msg, kind: isErr ? 'error' : 'info', duration: 4000 });
}
