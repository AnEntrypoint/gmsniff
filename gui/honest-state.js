// HONEST EMPTY AND DEGRADED STATES.
//
// The failure this replaces: a dead filter, a stale source, an unscoped panel
// and a genuinely quiet agent all rendered as the same silent `Empty('No X.')`
// -- indistinguishable, so a reader could not tell "nothing happened" from
// "nothing loaded". Every zero now states WHICH zero it is, and every panel
// routes its empty path through this one component so the distinction cannot
// be skipped by writing a bare string.
//
// Built on ds/components/files.js EmptyState (real signature: {text, glyph,
// action}) with a gmsniff-owned kind/hint wrapper -- the kind drives the tone,
// the hint says why the zero is what it is.

import * as webjsx from 'webjsx';
import { EmptyState } from 'ds/components/files.js';
import { Spinner } from 'ds/components/content.js';
import { Skeleton } from 'ds/components/content.js';

const h = webjsx.createElement;

// Each kind has a fixed meaning; adding a case is how a new distinction gets
// made, and the default is deliberately NOT 'empty' -- an unrecognized kind is
// itself a bug worth showing rather than silently reading as "no data".
const KIND_CLASS = {
  loading: 'is-loading',
  empty: 'is-empty',
  filtered: 'is-filtered',
  unscoped: 'is-unscoped',
  error: 'is-error',
  stale: 'is-stale',
  gone: 'is-gone',
  unsupported: 'is-unsupported',
};

const KIND_GLYPH = {
  loading: '...', empty: '-', filtered: '=', unscoped: '@',
  error: '!', stale: '~', gone: 'x', unsupported: '?',
};

/**
 * @param {'loading'|'empty'|'filtered'|'unscoped'|'error'|'stale'|'gone'|'unsupported'} kind
 * @param {string} text  - the headline: what IS the case.
 * @param {string} [hint] - why it is the case / what would change it.
 * @param {{label:string,onClick:Function}} [action]
 */
export function HonestState({ kind = 'empty', text, hint, action } = {}) {
  if (kind === 'loading') {
    return h('div', { class: 'gm-state gm-state-loading', role: 'status', 'aria-live': 'polite' },
      Spinner({ label: text || 'loading' }),
      hint ? h('p', { key: 'hint', class: 'gm-state-hint' }, hint) : null);
  }
  return h('div', { class: 'gm-state ' + (KIND_CLASS[kind] || 'is-unsupported'), role: 'status' },
    EmptyState({
      text: text || 'nothing here',
      glyph: KIND_GLYPH[kind] || '?',
      action: action && action.onClick ? action : undefined,
    }),
    hint ? h('p', { key: 'hint', class: 'gm-state-hint' }, hint) : null);
}

/**
 * The scoped-panel guidance eight panels were missing: a panel that can only
 * show data for a selected project must SAY that when nothing is selected,
 * rather than rendering a bare "no rows" that reads as "this project has none".
 */
export function ScopedPanelState({ panel, cwd, onPick } = {}) {
  if (!cwd) {
    return HonestState({
      kind: 'unscoped',
      text: `${panel} needs a project selected.`,
      hint: 'Pick one from the project switcher in the topbar, or open an agent from Live Agents and use its "all events" action.',
      action: onPick ? { label: 'Go to Live Agents', onClick: onPick } : undefined,
    });
  }
  return null;
}

/**
 * Skeleton rows for a list whose shape is known before its data arrives -- a
 * loading list reads as loading, not as an empty list that happens to be short.
 */
export function ListSkeleton({ rows = 5 } = {}) {
  return h('div', { class: 'gm-skeleton-list', role: 'status', 'aria-label': 'loading' },
    ...Array.from({ length: rows }, (_, i) => h('div', { key: i, class: 'gm-skeleton-row' },
      Skeleton({ height: '12px', width: '38%' }),
      Skeleton({ height: '10px', width: '72%' }))));
}
