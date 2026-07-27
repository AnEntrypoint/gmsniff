#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DS_ROOT = path.join(REPO_ROOT, 'gui', 'ds');

const USAGE = `sync-ds -- copy gui/ds/ from a sibling anentrypoint-design checkout

  node scripts/sync-ds.mjs [--source <path>] [--check]

  --source <path>  read from this checkout instead of ../anentrypoint-design
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
const SOURCE_ROOT = sourceFlagIdx !== -1 && args[sourceFlagIdx + 1]
  ? path.resolve(args[sourceFlagIdx + 1])
  : path.resolve(REPO_ROOT, '..', 'anentrypoint-design');

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

function main() {
  if (!fs.existsSync(SOURCE_ROOT)) {
    process.stderr.write(`sync-ds: source repo not found at ${SOURCE_ROOT}\n`);
    process.stderr.write('Clone/checkout anentrypoint-design as a sibling of gmsniff, or pass --source <path>.\n');
    process.exit(2);
  }

  let drifted = 0, missing = 0, copied = 0;
  for (const relPath of VENDORED_PATHS_RELATIVE_TO_BOTH_ROOTS) {
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
