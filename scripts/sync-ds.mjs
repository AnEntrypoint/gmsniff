#!/usr/bin/env node
// Repeatable, documented sync of gui/ds/ from the canonical anentrypoint-design
// design SDK (sibling checkout). gmsniff ships gui/ds as static files served
// verbatim by src/server.js's serveStatic() to the browser -- there is no
// bundler and no npm dependency resolution at runtime, and gmsniff itself is
// published as an installable package (bin: gmsniff, files: ["src/","gui/"])
// that must run standalone via `npx gmsniff` with no sibling repo on disk.
// A live filesystem import from ../anentrypoint-design is therefore not
// viable in the shipped artifact -- this script is the sync step instead:
// run it whenever anentrypoint-design's source changes and gui/ds needs to
// pick up the update, then commit the copied files like any other source
// change. It is intentionally NOT wired into `npm install`/`prepare` (that
// would make installing gmsniff depend on a sibling checkout existing).
//
// Source file set mirrors exactly what gui/ds/ historically vendored:
// anentrypoint-design's raw (unprefixed, unbundled) component/theme sources
// and the vendor/webjsx runtime -- NOT dist/247420.js (single-file bundle,
// classes scoped under .ds-247420, incompatible with gmsniff's unprefixed
// ds- class usage) and NOT the package's `exports` map (it does not expose
// these src/ subpaths for import).
//
// Usage: node scripts/sync-ds.mjs [--source <path-to-anentrypoint-design>] [--check]
//   --source   override sibling repo path (default: ../anentrypoint-design
//              resolved relative to this repo's root)
//   --check    dry run: report drift (files differing from source) and exit
//              non-zero if any are found, without writing anything

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DS_ROOT = path.join(REPO_ROOT, 'gui', 'ds');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const sourceFlagIdx = args.indexOf('--source');
const SOURCE_ROOT = sourceFlagIdx !== -1 && args[sourceFlagIdx + 1]
  ? path.resolve(args[sourceFlagIdx + 1])
  : path.resolve(REPO_ROOT, '..', 'anentrypoint-design');

// [sourceRelPath, destRelPath] -- destRelPath relative to gui/ds/
const FILES = [
  ['src/components/data-density.js', 'src/components/data-density.js'],
  ['src/components/editor-primitives.js', 'src/components/editor-primitives.js'],
  ['src/components/overlay-primitives.js', 'src/components/overlay-primitives.js'],
  ['src/components/shell.js', 'src/components/shell.js'],
  ['src/components/theme-toggle.js', 'src/components/theme-toggle.js'],
  ['src/theme.js', 'src/theme.js'],
  ['app-shell.css', 'app-shell.css'],
  ['colors_and_type.css', 'colors_and_type.css'],
  ['editor-primitives.css', 'editor-primitives.css'],
  ['vendor/webjsx/applyDiff.js', 'vendor/webjsx/applyDiff.js'],
  ['vendor/webjsx/attributes.js', 'vendor/webjsx/attributes.js'],
  ['vendor/webjsx/constants.js', 'vendor/webjsx/constants.js'],
  ['vendor/webjsx/createDOMElement.js', 'vendor/webjsx/createDOMElement.js'],
  ['vendor/webjsx/createElement.js', 'vendor/webjsx/createElement.js'],
  ['vendor/webjsx/elementTags.js', 'vendor/webjsx/elementTags.js'],
  ['vendor/webjsx/factory.js', 'vendor/webjsx/factory.js'],
  ['vendor/webjsx/index.js', 'vendor/webjsx/index.js'],
  ['vendor/webjsx/jsx.js', 'vendor/webjsx/jsx.js'],
  ['vendor/webjsx/jsx-dev-runtime.js', 'vendor/webjsx/jsx-dev-runtime.js'],
  ['vendor/webjsx/jsx-runtime.js', 'vendor/webjsx/jsx-runtime.js'],
  ['vendor/webjsx/package.json', 'vendor/webjsx/package.json'],
  ['vendor/webjsx/renderSuspension.js', 'vendor/webjsx/renderSuspension.js'],
  ['vendor/webjsx/types.js', 'vendor/webjsx/types.js'],
  ['vendor/webjsx/utils.js', 'vendor/webjsx/utils.js'],
];

function main() {
  if (!fs.existsSync(SOURCE_ROOT)) {
    process.stderr.write(`sync-ds: source repo not found at ${SOURCE_ROOT}\n`);
    process.stderr.write('Clone/checkout anentrypoint-design as a sibling of gmsniff, or pass --source <path>.\n');
    process.exit(2);
  }

  let drifted = 0, missing = 0, copied = 0;
  for (const [srcRel, destRel] of FILES) {
    const srcPath = path.join(SOURCE_ROOT, srcRel);
    const destPath = path.join(DS_ROOT, destRel);
    if (!fs.existsSync(srcPath)) {
      process.stderr.write(`sync-ds: MISSING source file ${srcRel}\n`);
      missing++;
      continue;
    }
    const srcBuf = fs.readFileSync(srcPath);
    const destBuf = fs.existsSync(destPath) ? fs.readFileSync(destPath) : null;
    const same = destBuf && Buffer.compare(srcBuf, destBuf) === 0;
    if (same) continue;

    if (checkOnly) {
      process.stdout.write(`${destBuf ? 'DRIFT ' : 'NEW   '} ${destRel}\n`);
      drifted++;
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, srcBuf);
    process.stdout.write(`synced ${destRel}\n`);
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
