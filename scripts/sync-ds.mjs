#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DS_ROOT = path.join(REPO_ROOT, 'gui', 'ds');

const USAGE = `sync-ds -- copy gui/ds/ from a sibling design-system checkout

  node scripts/sync-ds.mjs [--source <path>] [--check]

  --source <path>  read from this checkout instead of ../design
  --check          report drift and exit non-zero without writing anything

Never hand-edit gui/ds/: this script overwrites it byte-for-byte from the source
checkout. Fix the file upstream, sync, then --check for zero drift.
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const checkOnly = args.includes('--check');
const sourceFlagIdx = args.indexOf('--source');
// ../design, not ../anentrypoint-design: both are checkouts of AnEntrypoint/
// Design, but they diverged. ../anentrypoint-design's "pi-web GUI port" commit
// overwrote the ink tokens with that project's GitHub-dark values (--accent
// #58a6ff, --ink #0d1117, and --ink equal to --bg), so vendoring from it served
// gmsniff a palette a different project had mutated -- witnessed live as the
// GUI computing #0d1117/#58a6ff instead of the Acid Editorial #0E0E12/#B6FF1B.
// ../design carries the canonical token layer (656 lines against 597).
const SOURCE_ROOT = sourceFlagIdx !== -1 && args[sourceFlagIdx + 1]
  ? path.resolve(args[sourceFlagIdx + 1])
  : path.resolve(REPO_ROOT, '..', 'design');

const VENDORED_PATHS_RELATIVE_TO_BOTH_ROOTS = [
  'src/components/content.js',
  'src/components/data-density.js',
  'src/components/editor-primitives.js',
  'src/components/overlay-primitives.js',
  'src/components/shell.js',
  'src/components/theme-toggle.js',
  'src/components/sessions.js',
  'src/components/context-pane.js',
  'src/components/files.js',
  'src/components/form-primitives.js',
  'src/components/interaction-primitives.js',
  'src/virtual-scroll.js',
  'src/locale.js',
  'src/i18n.js',
  'src/debug.js',
  'src/theme.js',
  // app-shell.css is an @import manifest with no rules of its own: vendoring it
  // without every src/css/app-shell/ part it names leaves those rules 404 and
  // silently inert, with no console error -- which is exactly what happened,
  // and PhaseWalk/StatTile/LiveLog rendered unstyled for the life of the vendoring.
  'app-shell.css',
  'colors_and_type.css',
  'editor-primitives.css',
  'chat.css',
  'src/css/app-shell/base.css',
  'src/css/app-shell/topbar.css',
  'src/css/app-shell/primitives.css',
  'src/css/app-shell/panel-row.css',
  'src/css/app-shell/hero-content.css',
  'src/css/app-shell/responsive.css',
  'src/css/app-shell/chat-basic.css',
  'src/css/app-shell/files.css',
  'src/css/app-shell/catalog-theme.css',
  'src/css/app-shell/chat-polish.css',
  'src/css/app-shell/sidebar-misc.css',
  'src/css/app-shell/states-interactions.css',
  'src/css/app-shell/loading-alerts.css',
  'src/css/app-shell/responsive2-workspace.css',
  'src/css/app-shell/row-print.css',
  'src/css/app-shell/data-density.css',
  'src/css/app-shell/kits-appended.css',
  'vendor/webjsx/applyDiff.js',
  'vendor/webjsx/attributes.js',
  'vendor/webjsx/constants.js',
  'vendor/webjsx/createDOMElement.js',
  'vendor/webjsx/createElement.js',
  'vendor/webjsx/elementTags.js',
  'vendor/webjsx/factory.js',
  'vendor/webjsx/index.js',
  'vendor/webjsx/jsx.js',
  'vendor/webjsx/jsx-dev-runtime.js',
  'vendor/webjsx/jsx-runtime.js',
  'vendor/webjsx/package.json',
  'vendor/webjsx/renderSuspension.js',
  'vendor/webjsx/types.js',
  'vendor/webjsx/utils.js',
];

// Vendoring a file means vendoring its whole import closure. The list above is
// a SEED, not the final set: the upstream repo splits components into
// subdirectories over time (src/components/shell.js became a four-module
// shell/ directory), and a hand-maintained list silently vendors only the
// top-level shim. That is not a styling glitch -- every import in the chain
// 404s, so the app renders an empty <div id="root"> with no console error the
// server can see. Witnessed exactly that: 14 elements on the page, readyState
// complete, nothing mounted.
//
// So the closure is resolved from the source files themselves: relative JS
// imports/exports and CSS @import targets are followed transitively. A new
// upstream split is picked up by the next sync instead of breaking the GUI.
const JS_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;

function closureOf(seedPaths) {
  const resolved = new Set();
  const queue = [...seedPaths];
  while (queue.length) {
    const rel = queue.shift().split(path.sep).join('/');
    if (resolved.has(rel)) continue;
    resolved.add(rel);
    const abs = path.join(SOURCE_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const ext = path.extname(rel);
    if (ext !== '.js' && ext !== '.mjs' && ext !== '.css') continue;
    const src = fs.readFileSync(abs, 'utf8');
    const re = ext === '.css' ? CSS_IMPORT_RE : JS_IMPORT_RE;
    re.lastIndex = 0;
    for (let m; (m = re.exec(src)) !== null;) {
      const spec = m[1] || m[2];
      // Only relative specifiers are files in this repo; bare ones ("webjsx")
      // resolve through the page's importmap to something already vendored.
      if (!spec || !spec.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec.split('?')[0]));
      if (target.startsWith('..')) continue;
      if (!resolved.has(target)) queue.push(target);
    }
  }
  return [...resolved].sort();
}

function main() {
  if (!fs.existsSync(SOURCE_ROOT)) {
    process.stderr.write(`sync-ds: source repo not found at ${SOURCE_ROOT}\n`);
    process.stderr.write(`Clone/checkout the design system as a sibling of gmsniff (${SOURCE_ROOT}), or pass --source <path>.\n`);
    process.exit(2);
  }

  const allPaths = closureOf(VENDORED_PATHS_RELATIVE_TO_BOTH_ROOTS);
  const pulledIn = allPaths.filter((p) => !VENDORED_PATHS_RELATIVE_TO_BOTH_ROOTS.includes(p));
  if (pulledIn.length) {
    process.stdout.write(`sync-ds: import closure adds ${pulledIn.length} file(s) beyond the seed list\n`);
  }

  let drifted = 0, missing = 0, copied = 0;
  for (const relPath of allPaths) {
    const srcPath = path.join(SOURCE_ROOT, relPath);
    const destPath = path.join(DS_ROOT, relPath);
    if (!fs.existsSync(srcPath)) {
      process.stderr.write(`sync-ds: MISSING source file ${relPath}\n`);
      missing++;
      continue;
    }
    const srcBuf = fs.readFileSync(srcPath);
    const destBuf = fs.existsSync(destPath) ? fs.readFileSync(destPath) : null;
    const alreadyByteIdentical = destBuf && Buffer.compare(srcBuf, destBuf) === 0;
    if (alreadyByteIdentical) continue;

    if (checkOnly) {
      process.stdout.write(`${destBuf ? 'DRIFT ' : 'NEW   '} ${relPath}\n`);
      drifted++;
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, srcBuf);
    process.stdout.write(`synced ${relPath}\n`);
    copied++;
  }

  if (checkOnly) {
    if (missing > 0) {
      process.stderr.write(`sync-ds --check: ${missing} source file(s) missing, ${drifted} drifted\n`);
      process.exit(2);
    }
    if (drifted > 0) {
      process.stderr.write(`sync-ds --check: ${drifted} file(s) out of sync with ${SOURCE_ROOT}\n`);
      process.stderr.write('Run `npm run sync:ds` to update, then commit the result.\n');
      process.exit(1);
    }
    process.stdout.write(`sync-ds --check: gui/ds/ matches ${SOURCE_ROOT}\n`);
    process.exit(0);
  }

  if (missing > 0) {
    process.stderr.write(`sync-ds: ${missing} source file(s) missing -- gui/ds left partially updated\n`);
    process.exit(2);
  }
  process.stdout.write(copied > 0 ? `sync-ds: ${copied} file(s) updated from ${SOURCE_ROOT}\n` : 'sync-ds: already up to date\n');
}

main();
