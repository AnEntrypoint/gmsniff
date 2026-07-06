# gui/ds/ — vendored design SDK slice

This directory is a **vendored, synced copy** of a subset of
[anentrypoint-design](https://github.com/AnEntrypoint/Design) (published as
`anentrypoint-design` on npm), gmsniff's canonical design SDK. Per project
policy, all of gmsniff's GUI lives on this design system rather than
bespoke styling.

## Why vendored instead of a live import or an npm dependency

gmsniff serves `gui/` as static files (`serveStatic()` in `src/server.js`)
directly to the browser -- there is no bundler and no `node_modules`
resolution at request time. gmsniff itself is also published as an
installable package (`bin: gmsniff`, `files: ["src/","gui/"]`) that must run
standalone via `npx gmsniff` or a global install, with no guarantee the
`anentrypoint-design` sibling checkout exists on the machine running it. A
live filesystem import from `../anentrypoint-design` would break exactly
that distribution path.

A plain npm dependency doesn't fit either: anentrypoint-design's published
`exports` map exposes `./dist/247420.js` (a single-file bundle with all CSS
classes scoped under `.ds-247420`) and a handful of named kit subpaths, but
not the raw `src/components/*.js` / `src/theme.js` files this directory
uses, nor the unprefixed root `*.css` files gmsniff's markup expects
(`ds-panel`, `ds-stat`, etc. with no `.ds-247420` ancestor wrapper).

## The sync step

`scripts/sync-ds.mjs` (repo root) is the single, repeatable, documented way
this directory is updated. It copies an explicit, named file list from a
sibling `anentrypoint-design` checkout (default path `../anentrypoint-design`
relative to this repo; override with `--source <path>`):

```
npm run sync:ds          # copy latest source into gui/ds/, then git diff + commit
npm run sync:ds:check    # dry run: report drift without writing, exit 1 if stale
```

Run `sync:ds` whenever anentrypoint-design's canonical source changes and
gui/ds needs to pick up the update (there is no automatic trigger -- this is
a manual, known point in the workflow, analogous to a vendored-dependency
bump). Review the diff like any other source change, then commit it.
`sync:ds` is intentionally not wired into `npm install`/`prepare`: that would
make installing gmsniff itself depend on a sibling checkout being present.

## Vendored file set

- `src/components/data-density.js`, `editor-primitives.js`,
  `overlay-primitives.js`, `shell.js`, `theme-toggle.js`, `src/theme.js` --
  raw (unbundled, unprefixed) component/theme sources.
- `app-shell.css`, `colors_and_type.css`, `editor-primitives.css` -- raw
  hand-authored stylesheets from the design SDK's repo root (the same files
  anentrypoint-design's own `scripts/build.mjs` concatenates and
  `.ds-247420`-scopes into its published `dist/247420.css`; gmsniff consumes
  them unscoped instead).
- `vendor/webjsx/*` -- the webjsx runtime anentrypoint-design itself vendors;
  copied through unchanged.

Keep this list (in `scripts/sync-ds.mjs`'s `FILES` array) in sync with
whichever files this directory actually uses -- if gmsniff's GUI starts
importing another anentrypoint-design component, add it to `FILES` in the
same change.
