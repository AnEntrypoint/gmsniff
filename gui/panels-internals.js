// Shared internals for the gui/panels-*.js modules.
//
// gui/panels.js was a single 1164-line file holding 27 exported panels. It was
// not one oversized responsibility -- it was a registry -- but everything in it
// reached for the same dozen helpers, so those live here and each domain module
// imports what it needs. gui/panels.js re-exports the whole surface, so
// gui/app.js's router is unchanged.

import * as webjsx from 'webjsx';
import { Chip, Badge, Pill, Btn } from 'ds/components/shell.js';
import { PhaseWalk, BarRow, StatsGrid, SessionRow, DevRow, LiveLog } from 'ds/components/data-density.js';
import { TreeView, TreeItem, PropertyGrid, PropertyField, Dialog, JsonViewer, ToolbarRow, Pager } from 'ds/components/editor-primitives.js';
import { api, apiPost, fmtTs, state, toast } from './data.js';
import { runForceLayout } from './forcegraph.js';
import { basename, subsystemList, mergeObservedSubsystems, verbAllowlist, PHASE_FALLBACK } from './shared.js';
import { HonestState, ScopedPanelState } from './honest-state.js';

export const h = webjsx.createElement;

export const Toolbar = ToolbarRow;

export const SUB_COLORS = {
  hook: 'var(--purple, #bc8cff)', plugkit: 'var(--flame, #ff7b72)',
  bootstrap: 'var(--sky, #79c0ff)', memory: 'var(--green, #3fb950)',
  rs_learn: 'var(--amber, #d29922)',
};

export function colorFor(sub) {
  if (SUB_COLORS[sub]) return SUB_COLORS[sub];
  let hue = 0;
  for (let i = 0; i < sub.length; i++) hue = (hue * 31 + sub.charCodeAt(i)) >>> 0;
  return `hsl(${hue % 360}, 60%, 65%)`;
}

export function Empty(text, kind = 'empty', hint) { return HonestState({ kind, text, hint }); }
export function Failed(what, error) {
  return HonestState({ kind: 'error', text: `Could not load ${what}.`, hint: String(error) });
}

export const ELLIPSIS = '...';
export const MAX_VALUE_CHARS = 60;

export function truncateWithEllipsis(s, maxLen) {
  return s.length > maxLen ? s.slice(0, maxLen - ELLIPSIS.length) + ELLIPSIS : s;
}

export function asKeyValueLine(obj, maxLen = 200) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    let sv;
    if (v == null) sv = String(v);
    else if (typeof v === 'object') { try { sv = JSON.stringify(v); } catch { sv = String(v); } }
    else sv = String(v);
    parts.push(k + '=' + truncateWithEllipsis(sv, MAX_VALUE_CHARS));
    if (parts.join('  ').length >= maxLen) break;
  }
  return truncateWithEllipsis(parts.join('  '), maxLen);
}

export const TOP_ROWS_SHOWN = 15;

