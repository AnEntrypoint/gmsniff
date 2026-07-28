#!/usr/bin/env node
// Applies the anentrypoint-design SDK's own lint rules to gmsniff's gui/ tree.
//
// The SDK ships fourteen linters (../design/scripts/lint-*.mjs) but each one
// hardcodes the SDK's own repo root and its own COMPONENT_SHEETS list, so none
// of them can be pointed at gui/ from here. This file re-derives the rules that
// apply to a consumer of the design system and runs them against gui/, skipping
// gui/ds/ (vendored -- fixed upstream in ../design, then `npm run sync:ds`).
//
// Measured before this landed: 17 physical left/right properties, 16 raw colour
// literals, 3 var() refs to tokens declared nowhere (--border/--text/--muted,
// confirmed resolving to NULL by getComputedStyle in a live browser), and 2
// !important. All nine rule classes read zero now.
//
// The rules deliberately mirror ../design/scripts; when that repo changes a
// rule, this copy keeps the old one silently. That duplication-that-must-sync
// is the same liability AGENTS.md names for SUBSYSTEMS/SUB_LIST, and it is why
// SDK_RULE_SOURCES below names the exact upstream files to diff against.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const GUI = path.join(REPO, 'gui');
const DS = path.join(GUI, 'ds');

// The upstream rule files this copy was derived from, pinned by content hash.
// A comment saying "keep these in sync" is not a guard: it cannot fire. When
// ../design changes one of these rules, the hash stops matching and
// checkSdkRuleDrift() reports it by name, so the divergence surfaces as a
// failing check instead of as gui/ silently passing an outdated rule.
//
// A mismatch is NOT automatically a bug -- it means: read the upstream diff and
// decide whether the rule change applies to a consumer of the design system.
// Re-pin the hash in the same commit that carries that decision.
export const SDK_RULE_SOURCES = {
  'scripts/lint-tokens.mjs': 'e592fe6c2957f781',
  'scripts/lint-rtl-physical-properties.mjs': '33d650e25ec9d5a1',
  'scripts/lint-inline-styles.mjs': '9f5f7a7c91c1db96',
  'scripts/lint-duplicate-selectors.mjs': 'a2c781dc24e09692',
  'scripts/lint-glyphs.mjs': '4f934a0200d73bee',
};

// Returns {checked, drifted:[{file, expected, actual}], missing:[file]}.
// `sourceRoot` defaults to the same sibling checkout sync-ds.mjs vendors from;
// when that checkout is absent (an installed copy of gmsniff, an air-gapped
// machine) there is nothing to compare against and `checked` is 0 -- an absent
// source is not drift.
export function checkSdkRuleDrift(sourceRoot = path.resolve(REPO, '..', 'design')) {
  const drifted = [], missing = [];
  let checked = 0;
  for (const [rel, pinned] of Object.entries(SDK_RULE_SOURCES)) {
    const abs = path.join(sourceRoot, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    checked++;
    const actual = createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
    if (actual !== pinned) drifted.push({ file: rel, expected: pinned, actual });
  }
  return { checked, drifted, missing, sourceRoot };
}

// gui/ds is vendored from ../design and must never be hand-edited, so it is
// scanned only as a source of DECLARED tokens, never for violations.
const SKIP_DIRS = new Set(['ds', 'vendor', 'node_modules']);

function walk(dir, extSet, out = [], skip = SKIP_DIRS) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, extSet, out, skip);
    else if (extSet.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const relTo = (p) => path.relative(REPO, p).split(path.sep).join('/');
const lineAt = (src, i) => src.slice(0, i).split('\n').length;

// Blanking comments (rather than skipping lines that START with /* or *) is
// load-bearing: a per-line test misses continuation lines inside a block
// comment, and reported four phantom literals from gui-extra.css's own header
// prose explaining which hexes were removed.
const blankComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const COLOR_RE = /(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\()/g;
const PHYSICAL_RE = /(^|[\s;{])(padding-left|padding-right|margin-left|margin-right|border-left|border-right|border-left-width|border-right-width|border-left-color|border-right-color|left|right)\s*:/gm;
const TEXT_ALIGN_RE = /text-align\s*:\s*(left|right)\b/g;
const LAYOUT_RE = /grid-template|display:\s*grid|display:\s*flex|width:|height:|padding:|margin:|font-size:/;
const STYLE_ATTR_RE = /style\s*[=:]\s*("([^"]*)"|'([^']*)')/g;
const INLINE_WHITELIST = [/^--[\w-]+:/, /^background:\s*var\(/, /^background-color:\s*var\(/, /^transform:/, /^color:\s*var\(/];
// Decorative unicode is banned in SDK source (lint-glyphs.mjs); the middle dot
// and the Mac Command symbol are the documented exemptions.
const GLYPH_RE = /[←-⇿∀-⋿─-╿▀-▟■-◿☀-➿⬀-⯿️\u{1F300}-\u{1FAFF}]/gu;
const GLYPH_EXEMPT = new Set(['·', '⌘']);

function declaredTokens() {
  const declared = new Set();
  for (const f of walk(DS, new Set(['.css']), [], new Set(['node_modules']))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/gi)) declared.add(m[1]);
  }
  return declared;
}

// Returns {ruleName: [violation strings]}. Pure: no exit, no logging.
export function findGuiViolations() {
  const cssFiles = walk(GUI, new Set(['.css']));
  const jsFiles = walk(GUI, new Set(['.js', '.mjs', '.html']));
  const f = {
    raw_color_literals: [], rtl_physical: [], inline_styles: [], duplicate_selectors: [],
    glyphs: [], important: [], undeclared_vars: [], nonsemantic_click: [], button_no_name: [],
  };

  for (const file of cssFiles) {
    const raw = fs.readFileSync(file, 'utf8');
    const src = blankComments(raw);
    const lines = src.split(/\r?\n/);
    for (const m of src.matchAll(COLOR_RE)) {
      f.raw_color_literals.push(`${relTo(file)}:${lineAt(src, m.index)}: ${(lines[lineAt(src, m.index) - 1] || '').trim().slice(0, 110)}`);
    }
    for (const m of src.matchAll(PHYSICAL_RE)) f.rtl_physical.push(`${relTo(file)}:${lineAt(src, m.index)}: ${m[2]}`);
    for (const m of src.matchAll(TEXT_ALIGN_RE)) f.rtl_physical.push(`${relTo(file)}:${lineAt(src, m.index)}: text-align:${m[1]}`);
    for (const m of src.matchAll(/!important/g)) {
      f.important.push(`${relTo(file)}:${lineAt(src, m.index)}: ${(lines[lineAt(src, m.index) - 1] || '').trim().slice(0, 110)}`);
    }
    const seen = new Map();
    for (const m of src.matchAll(/(^|})\s*([^{}@]+?)\s*\{/g)) {
      const sel = m[2].trim().replace(/\s+/g, ' ');
      if (!sel || sel.startsWith('@')) continue;
      const ln = lineAt(src, m.index);
      if (seen.has(sel)) f.duplicate_selectors.push(`${relTo(file)}: "${sel}" at ${seen.get(sel)} and ${ln}`);
      else seen.set(sel, ln);
    }
  }

  const declOk = (v) => v.split(';').map((d) => d.trim()).filter(Boolean).every((d) => INLINE_WHITELIST.some((re) => re.test(d)));
  for (const file of jsFiles) {
    const src = fs.readFileSync(file, 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(STYLE_ATTR_RE)) {
        const v = m[2] ?? m[3] ?? '';
        if (LAYOUT_RE.test(v) && !declOk(v)) f.inline_styles.push(`${relTo(file)}:${i + 1}: ${line.trim().slice(0, 110)}`);
      }
    });
    // A div/span carrying onclick needs role + tabindex + a key handler, or it
    // is unreachable by keyboard and invisible to assistive tech.
    for (const m of src.matchAll(/h\(\s*['"](div|span|li|td|tr)['"]\s*,\s*\{([\s\S]{0,400}?)\}/g)) {
      if (!/onclick/.test(m[2])) continue;
      const ok = /role\s*:/.test(m[2]) && /tabindex/.test(m[2]) && /onkeydown|onkeyup|onkeypress/.test(m[2]);
      if (!ok) f.nonsemantic_click.push(`${relTo(file)}:${lineAt(src, m.index)}: <${m[1]}> onclick without role+tabindex+keyhandler`);
    }
    // A button is named by aria-label/aria-labelledby/title OR by its children,
    // so the children must be scanned too: a props-only test reported all three
    // of this repo's buttons as unnamed when each carries real text.
    for (const m of src.matchAll(/h\(\s*['"]button['"]\s*,\s*\{([\s\S]{0,400}?)\}([\s\S]{0,200}?)\)/g)) {
      const named = /aria-label|aria-labelledby|title\s*:/.test(m[1]);
      const childText = /['"`][^'"`]*\w[^'"`]*['"`]|Icon\(|\$\{/.test(m[2] || '');
      if (!named && !childText) f.button_no_name.push(`${relTo(file)}:${lineAt(src, m.index)}`);
    }
  }

  for (const file of [...cssFiles, ...jsFiles]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(GLYPH_RE)) {
      if (GLYPH_EXEMPT.has(m[0])) continue;
      f.glyphs.push(`${relTo(file)}:${lineAt(src, m.index)}: U+${m[0].codePointAt(0).toString(16).toUpperCase()}`);
    }
  }

  const declared = declaredTokens();
  const localDecl = new Set();
  for (const file of [...cssFiles, ...jsFiles]) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/gi)) localDecl.add(m[1]);
  }
  const seenVar = new Set();
  for (const file of [...cssFiles, ...jsFiles]) {
    const src = blankComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      if (declared.has(m[1]) || localDecl.has(m[1]) || seenVar.has(m[1])) continue;
      seenVar.add(m[1]);
      f.undeclared_vars.push(`${m[1]} used at ${relTo(file)}:${lineAt(src, m.index)} (declared nowhere in gui/ or gui/ds/)`);
    }
  }

  return f;
}

export function guiViolationCounts() {
  return Object.fromEntries(Object.entries(findGuiViolations()).map(([k, v]) => [k, v.length]));
}

if (process.argv[1] && process.argv[1].endsWith('lint-gui-ds.mjs')) {
  const f = findGuiViolations();
  const total = Object.values(f).reduce((a, v) => a + v.length, 0);
  for (const [rule, list] of Object.entries(f)) {
    if (!list.length) continue;
    console.log(`\n${rule} (${list.length}):`);
    for (const v of list) console.log('  ' + v);
  }
  console.log(total ? `\n${total} violation(s) across ${Object.values(f).filter((v) => v.length).length} rule(s)` : 'gui/ clean across all 9 SDK rule classes');
  const drift = checkSdkRuleDrift();
  if (drift.checked === 0) {
    console.log(`(no design-system checkout at ${drift.sourceRoot} -- upstream rule drift not checked)`);
  } else if (drift.drifted.length) {
    console.log(`\n${drift.drifted.length} upstream rule(s) changed since these copies were pinned:`);
    for (const d of drift.drifted) console.log(`  ${d.file}: pinned ${d.expected}, now ${d.actual}`);
    console.log('Read the upstream diff, decide whether it applies here, then re-pin in the same commit.');
  } else {
    console.log(`upstream rules unchanged (${drift.checked} pinned)`);
  }
  process.exit(total || drift.drifted.length ? 1 : 0);
}
