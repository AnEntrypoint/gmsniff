#!/usr/bin/env node
// Catches a template literal that interpolates an API-row field the route does
// not actually return -- which renders the literal text "undefined" to the user.
//
// Found live: gui/panels-sessions.js built `${s.residual_fires}f/${s.residual_skips}s`
// while GET /api/sessions returns 21 fields per row and neither of those is among
// them (nothing under src/ computes them either). Every one of 198 session rows
// displayed "undefinedf/undefineds resid". A grep for "undefined" cannot find
// this -- the string never appears in source, only in output -- so the check has
// to compare each interpolated field against a REAL route response.
//
// Requires a running server (the point is to check against live route shapes,
// not against a fixture that could drift from them). Skips cleanly when the
// server is down so it never fails a run for the wrong reason.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const GUI = path.join(REPO, 'gui');

// panel file -> the route whose rows it renders, and how to reach a sample row.
export const PANEL_ROUTES = [
  ['panels-sessions.js', '/api/sessions?limit=3', (j) => j.rows || j.sessions || (Array.isArray(j) ? j : [])],
  ['panels-events.js', '/api/events?limit=3', (j) => j.rows || (Array.isArray(j) ? j : [])],
];

// `${x.field}` where x is a short binder -- the row-ish shape. A longer name is
// usually a module-level object (state, liveState) rather than an API row.
const INTERP_RE = /\$\{\s*([a-z]\w{0,3})\.(\w+)\s*\}/g;

export async function findUndefinedRenders(base) {
  const findings = [];
  for (const [file, route, pick] of PANEL_ROUTES) {
    const p = path.join(GUI, file);
    if (!fs.existsSync(p)) continue;
    let body;
    try {
      const r = await fetch(base + route);
      if (!r.ok) { findings.push({ file, route, skipped: `route ${r.status}` }); continue; }
      body = await r.json();
    } catch (e) {
      findings.push({ file, route, skipped: 'server unreachable' });
      continue;
    }
    const rows = pick(body);
    const sample = Array.isArray(rows) ? rows[0] : rows;
    if (!sample || typeof sample !== 'object') { findings.push({ file, route, skipped: 'no sample row' }); continue; }
    const keys = new Set(Object.keys(sample));
    const src = fs.readFileSync(p, 'utf8');

    const byBinder = new Map();
    for (const m of src.matchAll(INTERP_RE)) {
      const [, binder, field] = m;
      if (!byBinder.has(binder)) byBinder.set(binder, []);
      byBinder.get(binder).push({ field, line: src.slice(0, m.index).split('\n').length });
    }
    const lines = src.split(/\r?\n/);
    for (const [binder, list] of byBinder) {
      // Only judge a binder that plausibly IS this route's row: at least one of
      // its interpolated fields must exist on the sample. Otherwise it is some
      // unrelated local object and its fields are not this route's business.
      if (!list.some((h) => keys.has(h.field))) continue;
      for (const h of list) {
        if (keys.has(h.field)) continue;
        // A field the route omits is FINE when the code already guards it --
        // that is exactly the correct fix, and flagging it would make this
        // check fail forever on code that is right. Look for a null/undefined
        // test naming the same field in the few lines above the interpolation.
        const window = lines.slice(Math.max(0, h.line - 8), h.line).join('\n');
        const guarded = new RegExp(
          `${binder}\\.${h.field}\\s*(!=|!==|===|==)\\s*(null|undefined)`
          + `|typeof\\s+${binder}\\.${h.field}`
          + `|${binder}\\.${h.field}\\s*\\?\\?`
          + `|${binder}\\.${h.field}\\s*&&`
        ).test(window);
        if (guarded) continue;
        findings.push({ file, route, binder, field: h.field, line: h.line });
      }
    }
  }
  return findings;
}

if (process.argv[1] && process.argv[1].endsWith('lint-undefined-renders.mjs')) {
  const base = process.argv[2] || 'http://127.0.0.1:7799';
  const findings = await findUndefinedRenders(base);
  const real = findings.filter((f) => !f.skipped);
  const skipped = findings.filter((f) => f.skipped);
  for (const f of real) {
    console.log(`${f.file}:${f.line}: \${${f.binder}.${f.field}} -- ${f.route} row has no "${f.field}" field, renders "undefined"`);
  }
  for (const s of skipped) console.log(`(skipped ${s.file} against ${s.route}: ${s.skipped})`);
  console.log(real.length ? `\n${real.length} interpolation(s) of a field the route does not return` : 'no undefined-rendering interpolations found');
  process.exit(real.length ? 1 : 0);
}
