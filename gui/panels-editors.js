// Write surfaces and consoles: the PRD and mutables row editors, lifecycle
// control, codesearch, the gm call console, and the browser-session view.
import { api, apiPost, state, toast } from './data.js';
import { ScopedPanelState } from './honest-state.js';
import { JsonViewer, PropertyField, PropertyGrid } from 'ds/components/editor-primitives.js';
import { Badge, Btn, Pill } from 'ds/components/shell.js';
import { StatsGrid } from 'ds/components/data-density.js';
import { verbAllowlist } from './shared.js';
import { Empty, Failed, Toolbar, h } from './panels-internals.js';
const PRD_STATUSES = ['pending', 'in_progress', 'resolved', 'blocked'];
const MUTABLE_STATUSES = ['unknown', 'resolved'];
const errorByRowIdAndField = {};

async function editRow(kind, id, since, fields, setBody, errKey) {
  const path = kind === 'prd' ? '/api/prd/edit' : '/api/mutables/edit';
  const r = await apiPost(path, { id, since, ...fields }, { scoped: true });
  if (r.status === 409) { toast(`Conflict: ${id} was modified since read (mtime ${r.mtimeMs}). Reloading.`, true); setBody(true); return; }
  if (r.status !== 200) { toast(`Edit failed: ${r.error || r.status}`, true); return; }
  if (errKey) delete errorByRowIdAndField[errKey];
  toast(`Saved ${id}`); setBody(true);
}

export function validatePrdField(field, value) {
  if (field === 'text' && !String(value || '').trim()) return 'text is required';
  if (field === 'status' && !PRD_STATUSES.includes(value)) return `status must be one of: ${PRD_STATUSES.join(', ')}`;
  return null;
}
export function validateMutableField(field, value) {
  if (field === 'status' && !MUTABLE_STATUSES.includes(value)) return `status must be one of: ${MUTABLE_STATUSES.join(', ')}`;
  if (field === 'witness' && value != null && String(value).trim() === '' && value !== '') return 'witness evidence cannot be blank once started';
  return null;
}

export function commitField(kind, row, field, value, since, setBody, validate) {
  const errKey = `${kind}:${row.id}:${field}`;
  const err = validate(field, value);
  if (err) { errorByRowIdAndField[errKey] = err; setBody(); return; }
  delete errorByRowIdAndField[errKey];
  editRow(kind, row.id, since, { [field]: value }, setBody, errKey);
}

// Measured against gm's own live prd.yml: severity is real but appears on only ~0.5% of rows,
// and upstream enforces no vocabulary (free-text scalar). Only the values actually witnessed
// are mapped; anything else falls back to neutral rather than guessing at unseen spellings.
const SEVERITY_TONE = { critical: 'danger', high: 'danger', medium: 'neutral', low: 'positive' };

// The two YAML editors share their whole frame -- scope gate, fetch, the three
// zero-states, the `since` mtime guard and the per-row PropertyGrid with its
// read-only id field -- and differ only in which editable fields a row carries.
// `fields(row, fieldError)` supplies exactly that difference; `fieldError` is
// the per-row error lookup already keyed by kind.
async function YamlRowEditor({ kind, panel, endpoint, heading, rowClass, fields }, setBody) {
  const unscoped = ScopedPanelState({ panel, cwd: state.cwd });
  if (unscoped) return unscoped;
  const r = await api(endpoint, { scoped: true });
  if (r.error) return Empty(`Failed to load ${heading}: ` + r.error);
  if (!r.rows || !r.rows.length) return Empty(`No ${heading} rows for this project.`);
  const since = r.mtimeMs;
  return h('div', { class: 'ds-panel' }, h('h2', {}, `${heading} (${r.rows.length} rows)`),
    ...r.rows.map(row => {
      const fieldError = (field) => errorByRowIdAndField[`${kind}:${row.id}:${field}`];
      return h('div', { key: row.id, class: 'gm-propgrid-row' + (rowClass ? rowClass(row) : '') },
        PropertyGrid({ children: [
          PropertyField({ label: 'id', inline: true, children: h('span', { class: 'gm-inline-input gm-opacity-70' }, row.id) }),
          ...fields(row, fieldError, since, setBody),
        ] }));
    }));
}

export async function PrdEditor(setBody) {
  return YamlRowEditor({
    kind: 'prd', panel: 'PRD Editor', endpoint: '/api/prd', heading: 'PRD',
    fields: (row, fieldError, since, setBody) => {
      const statusErr = fieldError('status');
      const textErr = fieldError('text');
      return [
        PropertyField({ label: 'status', hint: statusErr || null, children: h('select', {
          value: row.status,
          class: statusErr ? 'gm-field-error' : '',
          onchange: (e) => commitField('prd', row, 'status', e.target.value, since, setBody, validatePrdField),
        }, ...PRD_STATUSES.map(s => h('option', { value: s, selected: s === row.status ? true : null }, s))) }),
        PropertyField({ label: 'text', hint: textErr || null, children: h('input', {
          class: 'gm-inline-input' + (textErr ? ' gm-field-error' : ''), value: row.text,
          onchange: (e) => commitField('prd', row, 'text', e.target.value, since, setBody, validatePrdField),
        }) }),
        ...(row.severity ? [PropertyField({ label: 'severity', inline: true, children: Badge({ children: row.severity, tone: SEVERITY_TONE[row.severity] || 'neutral' }) })] : []),
        ...(row.tags && row.tags.length ? [PropertyField({ label: 'tags', inline: true, children: h('span', {}, ...row.tags.map(t => Pill({ key: t, tone: 'accent', children: t }))) })] : []),
      ];
    },
  }, setBody);
}

export async function MutablesEditor(setBody) {
  return YamlRowEditor({
    kind: 'mutables', panel: 'Mutables Editor', endpoint: '/api/mutables', heading: 'Mutables',
    rowClass: (row) => (row.status === 'unknown' ? ' gm-row-danger-tint' : ''),
    fields: (row, fieldError, since, setBody) => {
      const statusErr = fieldError('status');
      const witnessErr = fieldError('witness');
      return [
        PropertyField({ label: 'status', hint: statusErr || null, children: h('span', {}, Badge({ children: row.status, tone: row.status === 'unknown' ? 'danger' : (row.status === 'resolved' ? 'positive' : 'neutral') })) }),
        PropertyField({ label: 'witness', hint: witnessErr || null, children: h('input', {
          class: 'gm-inline-input' + (witnessErr ? ' gm-field-error' : ''), value: row.witness_evidence || '', placeholder: 'witness evidence...',
          onchange: (e) => commitField('mutables', row, 'witness', e.target.value, since, setBody, validateMutableField),
        }) }),
      ];
    },
  }, setBody);
}

export async function lifecycleAct(verb, payload) {
  const r = await apiPost('/api/lifecycle', { verb, payload }, { scoped: true });
  toast(r.status === 200 ? `Dispatched ${verb}` : `Dispatch failed: ${r.error || r.status}`, r.status !== 200);
  return r;
}

export async function LifecycleControl(setBody) {
  const unscoped = ScopedPanelState({ panel: "Lifecycle Control", cwd: state.cwd });
  if (unscoped) return unscoped;
  const [prd, mutables] = await Promise.all([api('/api/prd', { scoped: true }), api('/api/mutables', { scoped: true })]);
  if (prd.error || mutables.error) return Empty('Failed to load lifecycle state: ' + (prd.error || mutables.error));
  // /api/prd and /api/mutables page their rows, so counting the returned page reports a number
  // capped at the page size: on a real 820-row PRD the page held 250 rows of which 0 were
  // pending, so this panel displayed "0 PRD pending" for a project with 314 actually pending.
  // /api/projects computes both counts over the whole file and is the only honest source here.
  const project = (state.projects || []).find(r => r.cwd === state.cwd);
  const prdPending = project ? project.prd_pending : null;
  const mutUnknown = project ? project.mut_unknown : null;
  const countsUnavailable = prdPending == null;
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Lifecycle Control'),
    StatsGrid({ items: [
      { val: countsUnavailable ? '--' : prdPending, lbl: countsUnavailable ? 'PRD pending (not reported for this project)' : `PRD pending of ${project.prd_total}` },
      { val: countsUnavailable ? '--' : mutUnknown, lbl: 'mutables unknown', cls: mutUnknown ? 'err-rate' : '' },
    ] }),
    h('div', { class: 'gm-mt-12' }, Toolbar(
      Btn({ children: 'Transition', onClick: () => lifecycleAct('transition', {}) }),
      Btn({ children: 'Instruction', onClick: () => lifecycleAct('instruction', {}) }),
      Btn({ children: 'Residual Scan', onClick: () => lifecycleAct('residual-scan', {}) }))));
}

const codesearchState = { q: '', hits: null, loading: false, error: null };
export function Codesearch(setBody) {
  const unscoped = ScopedPanelState({ panel: 'Codesearch', cwd: state.cwd });
  if (unscoped) return unscoped;
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Codesearch'),
    Toolbar(
      h('input', { placeholder: 'search code/symbols...', value: codesearchState.q, oninput: (e) => { codesearchState.q = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') runCodesearch(setBody); } }),
      Btn({ children: codesearchState.loading ? 'Searching...' : 'Search', disabled: codesearchState.loading, onClick: () => runCodesearch(setBody) })),
    codesearchState.error ? h('p', { class: 'gm-text-danger' }, codesearchState.error) : null,
    codesearchState.hits === null ? Empty('Enter a query and search.') :
      (!codesearchState.hits.length ? Empty('No hits.') :
        h('div', {}, ...codesearchState.hits.map((hit, i) => h('details', { key: i, class: 'ds-panel gm-my-4' },
          h('summary', { class: 'gm-cursor-pointer' }, `${hit.file || '?'}:${hit.line || '?'}:${hit.name || ''} (score ${hit.score != null ? hit.score.toFixed?.(3) ?? hit.score : '?'})`),
          hit.snippet ? h('pre', { class: 'gm-json' }, hit.snippet) : JsonViewer({ value: hit, mode: 'highlight', maxHeight: '260px' })))))
  );
}
export async function runCodesearch(setBody) {
  if (!codesearchState.q) return;
  codesearchState.loading = true; codesearchState.error = null; setBody();
  const r = await apiPost('/api/codesearch', { query: codesearchState.q }, { scoped: true });
  codesearchState.loading = false;
  if (r.status !== 200) {
    codesearchState.error = r.error || `HTTP ${r.status}`;
    toast(`Codesearch failed: ${codesearchState.error}`, true);
    setBody();
    return;
  }
  codesearchState.hits = r.hits || [];
  if (!codesearchState.hits.length) toast(`No hits for "${codesearchState.q}"`);
  else toast(`${codesearchState.hits.length} hit${codesearchState.hits.length === 1 ? '' : 's'}`);
  setBody();
}

// Measured: /api/capabilities publishes 92 verbs. A 27-verb literal previously lived here, so
// two thirds of what the server would accept was unreachable from this console.
const DISPATCH_RESPONSE_TIMEOUT_MS = 10000;
const DISPATCH_RESPONSE_POLL_MS = 500;
const consoleState = { verb: null, payload: '{}', dispatched: null, polling: false, result: null };
export function GmCallConsole(setBody) {
  // The only scoped panel here that WRITES: an unscoped dispatch would not merely
  // display the server's own launch directory, it would fire a real verb into it.
  const unscoped = ScopedPanelState({ panel: 'GM Call Console', cwd: state.cwd });
  if (unscoped) return unscoped;
  const verbs = verbAllowlist();
  const selectionNoLongerPublished = !consoleState.verb || !verbs.includes(consoleState.verb);
  if (selectionNoLongerPublished) consoleState.verb = verbs[0];
  return h('div', { class: 'ds-panel' }, h('h2', {}, 'Localized GM Call Console'),
    Toolbar(
      h('select', { value: consoleState.verb, onchange: (e) => { consoleState.verb = e.target.value; } },
        ...verbs.map(v => h('option', { value: v, selected: v === consoleState.verb ? true : null }, v))),
      Btn({ children: 'Dispatch', onClick: () => dispatchConsole(setBody) })),
    h('p', { class: 'gm-muted-11' }, `${verbs.length} verb(s) published by /api/capabilities.`),
    h('textarea', { class: 'gm-textarea gm-h-80', oninput: (e) => { consoleState.payload = e.target.value; } }, consoleState.payload),
    consoleState.dispatched ? h('p', { class: 'gm-muted-11' }, `Dispatched: ${consoleState.dispatched.verb} -> ${consoleState.dispatched.file || ''} ${consoleState.polling ? '(polling for response...)' : ''}`) : null,
    consoleState.result ? JsonViewer({ value: consoleState.result, mode: 'tree', copyable: true, maxHeight: '420px' }) : Empty('No dispatch yet.'));
}
export async function dispatchConsole(setBody) {
  let payload;
  try { payload = JSON.parse(consoleState.payload || '{}'); }
  catch (e) { toast('Invalid JSON payload: ' + e.message, true); return; }
  const r = await apiPost('/api/lifecycle', { verb: consoleState.verb, payload }, { scoped: true });
  if (r.status !== 200) { toast(`Dispatch failed: ${r.error || r.status}`, true); return; }
  consoleState.dispatched = r;
  consoleState.polling = true;
  consoleState.result = null;
  setBody();
  const file = (r.file || '').split(/[\\/]/).pop();
  const deadline = Date.now() + DISPATCH_RESPONSE_TIMEOUT_MS;
  const poll = async () => {
    const resp = await api(`/api/lifecycle/response?verb=${encodeURIComponent(consoleState.verb)}&file=${encodeURIComponent(file)}`, { scoped: true });
    if (resp.ok) { consoleState.polling = false; consoleState.result = resp.response; setBody(); return; }
    if (Date.now() >= deadline) { consoleState.polling = false; consoleState.result = { error: 'timed out waiting for response', tried: file }; setBody(); return; }
    setTimeout(poll, DISPATCH_RESPONSE_POLL_MS);
  };
  poll();
}

export async function BrowserSessions() {
  const unscoped = ScopedPanelState({ panel: "Browser Sessions", cwd: state.cwd });
  if (unscoped) return unscoped;
  const r = await api('/api/browser-sessions', { scoped: true });
  if (r.error) return Empty('Failed to load browser sessions: ' + r.error);
  const sessions = Array.isArray(r.sessions) ? r.sessions : Object.entries(r.sessions || {}).map(([id, v]) => ({ id, ...(v || {}) }));
  const ports = Array.isArray(r.ports) ? r.ports : Object.entries(r.ports || {}).map(([id, v]) => ({ id, ...(v || {}) }));
  if (!r.sessionsFileFound && !r.portsFileFound) return Empty('No browser-sessions.json or browser-ports.json found for this project -- no browser verb has run yet.');
  return h('div', { class: 'gm-flex-row' },
    h('div', { class: 'ds-panel' }, h('h2', { id: 'browser-sessions-heading' }, `Sessions (${sessions.length})`),
      sessions.length ? h('table', { class: 'gm-table', 'aria-labelledby': 'browser-sessions-heading' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'id'), h('th', { scope: 'col' }, 'alive'), h('th', { scope: 'col' }, 'url'), h('th', { scope: 'col' }, 'port'))),
        h('tbody', {}, ...sessions.map((s, i) => h('tr', { key: i },
          h('th', { scope: 'row' }, s.id || s.session_id || '?'),
          h('td', {}, s.alive
            ? Badge({ children: 'alive', tone: 'positive' })
            : Badge({ children: 'dead', tone: 'neutral' })),
          h('td', {}, s.url || s.target_url || ''),
          h('td', {}, String(s.port || ''))))))
        : Empty('No open browser sessions.')),
    h('div', { class: 'ds-panel' }, h('h2', { id: 'browser-ports-heading' }, `Ports (${ports.length})`),
      ports.length ? h('table', { class: 'gm-table', 'aria-labelledby': 'browser-ports-heading' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'id'), h('th', { scope: 'col' }, 'port'))),
        h('tbody', {}, ...ports.map((p, i) => h('tr', { key: i }, h('th', { scope: 'row' }, p.id), h('td', {}, String(p.port || ''))))))
        : Empty('No registered browser ports.')));
}

