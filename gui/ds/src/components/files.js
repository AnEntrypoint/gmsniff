// File primitives — matches upstream signatures.

import * as webjsx from '../../vendor/webjsx/index.js';
import { Btn, Icon } from './shell.js';
const h = webjsx.createElement;

const FILE_TYPES = ['dir', 'image', 'video', 'audio', 'code', 'text', 'archive', 'document', 'symlink', 'other'];
const TYPE_ICON = {
    dir: 'folder', image: 'file-image', video: 'file-video', audio: 'file-audio', code: 'file-code',
    text: 'file-text', archive: 'file-zip', document: 'file-text', symlink: 'link', other: 'file'
};

const TYPE_LABELS = {
    dir: 'folder',
    image: 'image file',
    video: 'video file',
    audio: 'audio file',
    code: 'code file',
    text: 'text file',
    archive: 'archive file',
    document: 'document file',
    symlink: 'symbolic link',
    other: 'file'
};

export function fileGlyph(type) {
    return TYPE_ICON[type] || TYPE_ICON.other;
}

// The canonical kit byte formatter (chat.js re-exports it as fmtBytes). One
// format everywhere: '0 B' for zero; the em-dash means unknown/null/invalid
// (NaN, a negative count, or anything non-numeric never reaches the divide
// loop — previously NaN fell through to the loop unchanged and rendered the
// literal string "NaN B").
export function fmtFileSize(bytes) {
    if (bytes == null) return '—';
    if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) return '—';
    if (bytes === 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

export function FileIcon({ type = 'other' } = {}) {
    return h('span', { class: 'ds-file-icon', 'data-file-type': type, 'aria-label': TYPE_LABELS[type] || 'file', role: 'img' }, Icon(fileGlyph(type)));
}

// Default action set for FileRow. A host without mutation endpoints passes a
// narrower `actions` list (e.g. ['download']) so the row renders no dead controls.
const FILE_ROW_ACTIONS = ['download', 'rename', 'move', 'delete'];

export function FileRow({ name, type = 'other', size, modified, code, onOpen, onAction, active, key, permissions, locked,
                          actions = FILE_ROW_ACTIONS, busy = false, selectable = false, selected = false, onToggleSelect } = {}) {
    // permissions: ['read','write'] | ['read'] | 'EACCES'. A no-access entry can
    // be listed (the dir stat saw it) but not opened — show an ASCII tag and
    // disable the open button so the row reads honestly instead of silently
    // failing on click.
    const noAccess = locked || permissions === 'EACCES' || (Array.isArray(permissions) && permissions.length === 0);
    const readOnly = !noAccess && Array.isArray(permissions) && permissions.indexOf('write') === -1 && permissions.indexOf('read') !== -1;
    const permTag = noAccess ? 'no access' : (readOnly ? 'read-only' : null);
    // permTag is rendered as its own chip (a SHAPE channel, not folded into the
    // muted meta text) - so drop it from the meta join, but keep it in the
    // accessible label so AT still announces the restriction.
    const meta = [type === 'dir' ? null : fmtFileSize(size), modified || null].filter(Boolean).join(' · ');
    const typeLabel = TYPE_LABELS[type] || 'file';
    const accessibleLabel = `${typeLabel}: ${name}${meta ? ` (${meta})` : ''}${permTag ? ', ' + permTag : ''}`;
    const canOpen = onOpen && !noAccess && !busy;
    // Mutation actions on a read-only/no-access row render disabled (with a
    // 'read-only' title) instead of vanishing, so the affordance reads honestly.
    // `busy` (in-flight mutation) disables every control on the row.
    const mutateDisabled = busy || readOnly || noAccess;
    const actBtn = (act, title, ariaLabel, icon, warn) => h('button', {
        key: 'act-' + act,
        type: 'button',
        class: 'ds-file-act' + (warn ? ' ds-file-act-warn' : ''),
        title: mutateDisabled && act !== 'download' ? 'read-only' : title,
        'aria-label': ariaLabel,
        disabled: (act === 'download' ? busy : mutateDisabled) ? true : null,
        'aria-disabled': (act === 'download' ? busy : mutateDisabled) ? 'true' : null,
        onclick: () => onAction(act),
    }, Icon(icon));
    const actionBtns = onAction ? [
        actions.indexOf('download') !== -1 && type !== 'dir'
            ? actBtn('download', 'download', `download ${name}`, 'arrow-down', false) : null,
        actions.indexOf('rename') !== -1
            ? actBtn('rename', 'rename', `rename ${name}`, 'pencil', false) : null,
        // Single-file move used to require checkbox-select + BulkBar - a
        // per-row affordance matches fsbrowse and the kit rename/delete rows
        // already on this row (no reason move alone needed a select detour).
        actions.indexOf('move') !== -1
            ? actBtn('move', 'move', `move ${name}`, 'arrow-right', false) : null,
        actions.indexOf('delete') !== -1
            ? actBtn('delete', 'delete', `delete ${name}`, 'x', true) : null,
    ].filter(Boolean) : [];
    // Multi-select checkbox — a sibling control before the open button so the
    // row stays valid HTML (no interactive nesting). A no-access entry cannot
    // be marked (bulk mutations would fail on it anyway).
    const checkCtl = selectable ? h('button', {
        key: 'mark',
        type: 'button',
        class: 'ds-file-check' + (selected ? ' is-marked' : ''),
        role: 'checkbox',
        'aria-checked': selected ? 'true' : 'false',
        'aria-label': (selected ? 'unselect ' : 'select ') + name,
        disabled: (noAccess || busy) ? true : null,
        onclick: onToggleSelect ? (e) => onToggleSelect({ range: !!e.shiftKey }) : null,
    }, h('span', { class: 'ds-check-box', 'aria-hidden': 'true' })) : null;
    // A role=button row containing real <button> action controls is invalid
    // HTML (interactive nesting). Instead the row is a plain container and the
    // primary "open" affordance is itself a real <button> (native keyboard +
    // semantics); the per-file action buttons sit alongside it as siblings.
    const rowKids = [
        checkCtl,
        h('button', {
            key: 'open',
            type: 'button',
            class: 'ds-file-open',
            onclick: canOpen ? onOpen : null,
            'aria-label': accessibleLabel + (noAccess ? ' (no access)' : ''),
            'aria-pressed': active ? 'true' : 'false',
            disabled: canOpen ? null : true,
        },
            ...[
                code != null ? h('span', { class: 'code', 'aria-label': `code: ${code}` }, code) : null,
                FileIcon({ type }),
                h('span', { class: 'title' }, name),
                h('span', { class: 'ds-file-meta meta', 'aria-label': meta ? `metadata: ${meta}` : null }, meta || '—'),
                permTag ? h('span', { class: 'ds-file-perm-tag' + (noAccess ? ' is-noaccess' : ''), 'aria-hidden': 'true' }, permTag) : null,
            ].filter(Boolean)
        ),
        actionBtns.length ? h('span', { key: 'acts', class: 'ds-file-actions', role: 'group', 'aria-label': `actions for ${name}` },
            ...actionBtns
        ) : null,
    ].filter(Boolean);
    return h('div', {
        key,
        class: 'ds-file-row row' + (active ? ' active' : '') + (noAccess ? ' is-locked' : '')
            + (readOnly ? ' is-restricted' : '')
            + (selected ? ' is-marked' : '') + (selectable ? ' is-selectable' : ''),
        'data-file-type': type,
        'aria-busy': busy ? 'true' : null,
    }, ...rowKids);
}

// FileSkeleton — placeholder shimmer rows shown while a directory loads, so the
// grid does not flash from a bare spinner to a full list (predictable perceived
// perf, the file-manager feel). `rows` controls how many ghost rows render.
export function FileSkeleton({ rows = 12 } = {}) {
    return h('div', { class: 'ds-file-grid ds-file-skeleton', role: 'status', 'aria-busy': 'true', 'aria-label': 'loading files' },
        ...Array.from({ length: Math.max(1, rows) }, (_, i) => h('div', { key: 'sk' + i, class: 'ds-file-row ds-file-row-skeleton', 'aria-hidden': 'true' },
            h('span', { class: 'ds-skel ds-skel-icon' }),
            h('span', { class: 'ds-skel ds-skel-title' }),
            h('span', { class: 'ds-skel ds-skel-meta' })))
    );
}

// Sort a file list by a key (name/size/modified/type), dirs-first always so the
// hierarchy reads top-down regardless of sort. `dir` is 'asc'|'desc'.
// `modifiedTs` (epoch ms) is used for the modified sort when present, since the
// `modified` field is a pre-formatted relative string the host passes for display.
export function sortFiles(files = [], sort = 'name', dir = 'asc') {
    const mul = dir === 'desc' ? -1 : 1;
    const cmp = (a, b) => {
        // Directories always cluster before files; within a cluster, apply the sort.
        const ad = a.type === 'dir' ? 0 : 1, bd = b.type === 'dir' ? 0 : 1;
        if (ad !== bd) return ad - bd;
        let r = 0;
        if (sort === 'size') r = (a.size || 0) - (b.size || 0);
        else if (sort === 'modified') r = (a.modifiedTs || 0) - (b.modifiedTs || 0);
        else if (sort === 'type') r = String(a.type || '').localeCompare(String(b.type || ''));
        else r = String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
        return r * mul || String(a.name || '').localeCompare(String(b.name || ''));
    };
    return files.slice().sort(cmp);
}

// FileGrid — the directory listing. Optional in-grid sort + filter make it a
// real file manager rather than a static dump:
//   sort   : { key, dir, onSort(key) }  - clickable column headers (name/size/modified)
//   filter : { value, onInput, placeholder } - a quick in-dir name filter
//   onOpen(f) opens a row; onAction(act,f) wires the per-row download/rename/delete.
// Keyboard nav: the grid is a focusable listbox - ArrowUp/Down move the active
// row, Enter opens it, Backspace asks the host to go up (onUp). The host keeps no
// focus state; the grid tracks it on the DOM via roving tabindex.
// How many rows to render before the "show more" cap kicks in. A node_modules-
// scale directory would otherwise flood the DOM with thousands of rows (and make
// the roving-tabindex querySelectorAll scan O(n) per keypress). Render the first
// CAP and a "show N more" row, mirroring the History tab's "load N older".
const FILE_GRID_CAP = 200;

export function FileGrid({ files = [], onOpen, onAction, onUp, emptyText = 'No files here yet', emptyAction,
                          sort, filter, loading = false,
                          shown, onShowMore, actions, busy,
                          // Canonical multi-select contract (shared with
                          // SessionDashboard): selected/onToggleSelect.
                          // marked/onMark are accepted FileGrid aliases.
                          selectable = false, selected, onToggleSelect,
                          marked = selected, onMark = onToggleSelect,
                          onSelectAll, onClearSelection,
                          density = 'list', onDensity, thumbUrl } = {}) {
    // Skeleton ONLY for a cold load. A refresh of a populated grid (rename /
    // delete / upload round-trip) keeps the rows on screen and dims them -
    // flashing the whole directory to shimmer rows on every mutation reads as
    // data loss.
    if (loading && !files.length) return FileSkeleton({ rows: 12 });
    // A filtered miss is NOT an empty directory: when the in-grid filter narrows
    // to zero matches, the host still passes an empty `files` array - but we must
    // keep the controls toolbar (the filter input that caused the miss) mounted so
    // the user can clear/edit it to recover. Only a genuinely-empty directory (no
    // active filter) gets the bare cold EmptyState early-return.
    const hasFilter = !!(filter && (filter.value || '').length > 0);
    if (!files.length && !hasFilter) return EmptyState({ text: emptyText, glyph: Icon('folder-open', { size: 28 }), action: emptyAction });
    const refreshing = loading && files.length > 0;
    // Cap the rendered rows. `shown` (host-controlled) overrides the default cap
    // so "show more" can grow it; otherwise default to FILE_GRID_CAP.
    const limit = shown != null ? shown : FILE_GRID_CAP;
    const capped = files.length > limit;
    const visible = capped ? files.slice(0, limit) : files;
    const isThumb = density === 'thumb';
    // NOTE: the old `columns`-driven data-columns card-mode was removed - it placed
    // flex list-rows into a 2-4 col grid (squashed rows, mis-sized actions) and was
    // a half-wired third layout never exposed by the density radiogroup (list/
    // compact/thumb). Thumb density is the canonical multi-column grid.
    const gridAttrs = {};
    // Multi-select bookkeeping. Entries are keyed by path (fallback name); a
    // locked/EACCES entry is never selectable — bulk mutations would fail on it.
    const entryKeyOf = (f) => f.path || f.name;
    const isLockedEntry = (f) => f.locked || f.permissions === 'EACCES'
        || (Array.isArray(f.permissions) && f.permissions.length === 0);
    const selSet = marked instanceof Set ? marked : new Set(marked || []);
    const selectableKeys = selectable ? visible.filter((f) => !isLockedEntry(f)).map(entryKeyOf) : [];
    // Keyboard: roving focus over the open buttons inside the grid (rows and
    // thumbnail cells share the pattern). Ctrl/Cmd+A selects all SHOWN rows.
    const onKeyDown = (e) => {
        const grid = e.currentTarget;
        const opens = Array.from(grid.querySelectorAll('.ds-file-open:not([disabled]), .ds-file-cell-open:not([disabled])'));
        const cur = opens.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); opens[Math.min(opens.length - 1, cur + 1)]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (cur <= 0 ? opens[0] : opens[cur - 1])?.focus(); }
        else if (e.key === 'Home') { e.preventDefault(); opens[0]?.focus(); }
        else if (e.key === 'End') { e.preventDefault(); opens[opens.length - 1]?.focus(); }
        else if (e.key === 'Backspace') { e.preventDefault(); onUp && onUp(); }
        else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)
                 && selectable && onSelectAll && selectableKeys.length) {
            e.preventDefault(); onSelectAll(selectableKeys);
        }
    };
    const head = sort ? FileSortHeader(sort) : null;
    // Tri-state select-all over the selectable SHOWN rows (the cap label below
    // already tells the user more rows exist beyond the window).
    const selOfVisible = selectableKeys.filter((k) => selSet.has(k)).length;
    const allState = selOfVisible === 0 ? 'false' : (selOfVisible === selectableKeys.length ? 'true' : 'mixed');
    const selectAllCtl = (selectable && onSelectAll && selectableKeys.length)
        ? h('button', { key: 'selall', type: 'button', class: 'ds-file-selectall', role: 'checkbox',
            'aria-checked': allState,
            'aria-label': allState === 'true' ? 'clear selection' : 'select all ' + selectableKeys.length + ' shown files',
            onclick: () => (allState === 'true' && onClearSelection) ? onClearSelection() : onSelectAll(selectableKeys) },
            h('span', { class: 'ds-check-box', 'aria-hidden': 'true' }),
            h('span', {}, 'all'))
        : null;
    // Density picker — list / compact / thumbnails. A radiogroup, not tabs:
    // it switches presentation of the same content, not panels.
    const densityCtl = onDensity
        ? h('div', { key: 'density', class: 'ds-density', role: 'radiogroup', 'aria-label': 'view density' },
            ...DENSITIES.map(([k, label], idx) => h('button', {
                key: 'd-' + k, type: 'button', role: 'radio',
                class: 'ds-density-btn' + (density === k ? ' active' : ''),
                'aria-checked': density === k ? 'true' : 'false',
                // Icon-led, but the density name stays the accessible name
                // (aria-label) + the native tooltip (title) so the control reads
                // dense without losing its label.
                'aria-label': label, title: label,
                // Single tab stop: the checked radio is tabbable, the rest are
                // roved. Arrow/Home/End move + select (selection follows focus).
                tabindex: density === k ? '0' : '-1',
                onkeydown: (e) => rovingRadio(e, idx, DENSITIES, (tk) => { if (density !== tk) onDensity(tk); }),
                onclick: () => { if (density !== k) onDensity(k); },
            }, Icon(DENSITY_ICONS[k], { size: 15 }))))
        : null;
    // One toolbar baseline: filter + select-all + sort sit left, density is
    // pushed right by the spread. The filter used to be a separate right-aligned
    // strip ABOVE controls, giving two strips with conflicting alignment.
    const filterCtl = filter ? h('span', { key: 'filterwrap', class: 'ds-file-filter-wrap' },
        h('input', {
            key: 'filter',
            class: 'ds-file-filter-input', type: 'search',
            value: filter.value || '', placeholder: filter.placeholder || 'Filter files',
            'aria-label': filter.placeholder || 'Filter files in this directory',
            oninput: (e) => filter.onInput && filter.onInput(e.target.value),
            onkeydown: (e) => {
                if (e.key === 'Escape' && filter.value) { e.preventDefault(); e.stopPropagation(); filter.onInput && filter.onInput(''); }
            },
        }),
        // Announces the filtered count as the filter narrows the list, so a
        // screen-reader user gets the same feedback a sighted user reads off
        // the grid without having to re-scan it after every keystroke. `files`
        // here is already the host's filter-applied set (see hasFilter above) -
        // there is no separate pre-filter total available inside this component.
        h('span', { key: 'filtercount', class: 'sr-only', role: 'status', 'aria-live': 'polite' },
            hasFilter ? files.length + (files.length === 1 ? ' file' : ' files') + ' shown' : '')
    ) : null;
    const leftKids = [filterCtl, selectAllCtl, head].filter(Boolean);
    const controlsKids = [
        ...leftKids,
        (leftKids.length && densityCtl) ? h('span', { key: 'spread', class: 'spread' }) : null,
        densityCtl].filter(Boolean);
    const controls = controlsKids.length
        ? h('div', { class: 'ds-file-controls' }, ...controlsKids)
        : null;
    // A filtered miss (zero rows but an active filter) renders the EmptyState
    // INSIDE the listing, below the controls toolbar, so the filter input stays
    // mounted and editable - the user can clear/edit it to recover instead of
    // being stranded with no toolbar (the early-return only fires for a genuinely
    // empty directory). The host passes filter-aware copy via emptyText.
    const filteredEmpty = !files.length && hasFilter;
    // role=group not listbox: the rows contain real <button> action controls, so
    // listbox/option semantics are invalid (an option can't host interactive
    // children). Keyboard nav still works via roving focus over the open buttons.
    const grid = filteredEmpty ? EmptyState({ text: emptyText, glyph: Icon('folder-open', { size: 28 }) }) : h('div', {
        class: 'ds-file-grid' + (isThumb ? ' ds-file-grid-thumb' : '') + (refreshing ? ' is-refreshing' : ''),
        role: 'group', 'aria-label': 'files', tabindex: '0',
        'aria-busy': refreshing ? 'true' : 'false',
        // Always concrete (webjsx's attribute diff can leave a null-valued
        // attribute unset when toggling away from the default).
        'data-density': density || 'list',
        onkeydown: onKeyDown, ...gridAttrs },
        ...visible.map((f, i) => isThumb
            ? FileCell({
                key: f.path || f.name + i, f,
                selectable, selected: selSet.has(entryKeyOf(f)),
                onToggleSelect: onMark ? (opts) => onMark(f, opts) : null,
                onOpen,
                thumb: (thumbUrl && f.type === 'image') ? thumbUrl(f) : null,
            })
            : FileRow({
                key: f.path || f.name + i,
                name: f.name, type: f.type, size: f.size, modified: f.modified, code: f.code, active: f.active,
                permissions: f.permissions, locked: f.locked,
                actions: actions != null ? actions : undefined,
                busy: busy != null ? !!busy : !!f.busy,
                selectable, selected: selSet.has(entryKeyOf(f)),
                onToggleSelect: onMark ? (opts) => onMark(f, opts) : null,
                onOpen: onOpen ? () => onOpen(f) : null,
                onAction: onAction ? (act) => onAction(act, f) : null
            }))
    );
    // A count + "show more" affordance so a capped large dir reads as "more
    // exist", not "this is everything". aria-live announces the shown/total.
    const more = capped
        ? h('div', { class: 'ds-file-more' },
            h('span', { class: 'ds-file-more-count', role: 'status', 'aria-live': 'polite' },
                'showing ' + visible.length + ' of ' + files.length),
            onShowMore ? h('button', { type: 'button', class: 'ds-file-more-btn',
                onclick: () => onShowMore(Math.min(files.length, limit + FILE_GRID_CAP)) },
                'show ' + Math.min(FILE_GRID_CAP, files.length - limit) + ' more') : null)
        : null;
    return (controls || more)
        ? h('div', { class: 'ds-file-listing' }, controls, grid, more)
        : grid;
}

const DENSITIES = [['list', 'list'], ['compact', 'compact'], ['thumb', 'thumbnails']];
const DENSITY_ICONS = { list: 'rows', compact: 'rows-tight', thumb: 'grid' };

// Roving-radiogroup keyboard helper (the WAI-ARIA radio pattern): a radiogroup
// is a SINGLE tab stop where Arrow/Home/End move AND select among options, with
// selection following focus. `items` is the ordered [[key, ...], ...] list;
// `onSelect(targetKey)` is the same handler the onclick fires. Mouse path is
// unchanged - this only adds keyboard navigation.
function rovingRadio(e, idx, items, onSelect) {
    let target = -1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = (idx - 1 + items.length) % items.length;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = (idx + 1) % items.length;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = items.length - 1;
    else return;
    e.preventDefault();
    onSelect(items[target][0]);
    const sib = e.currentTarget.parentNode && e.currentTarget.parentNode.children[target];
    sib && sib.focus();
}

// FileCell — the thumbnail-density tile. Image entries show a real (lazy)
// thumbnail through the host's confined thumbUrl; everything else keeps its
// type icon. Same open/mark semantics as FileRow, same no-nesting rule.
function FileCell({ key, f = {}, selectable = false, selected = false, onToggleSelect, onOpen, thumb } = {}) {
    const noAccess = f.locked || f.permissions === 'EACCES'
        || (Array.isArray(f.permissions) && f.permissions.length === 0);
    const canOpen = onOpen && !noAccess;
    const typeLabel = TYPE_LABELS[f.type] || 'file';
    const kids = [
        selectable ? h('button', {
            key: 'mark', type: 'button',
            class: 'ds-file-check ds-file-cell-check' + (selected ? ' is-marked' : ''),
            role: 'checkbox', 'aria-checked': selected ? 'true' : 'false',
            'aria-label': (selected ? 'unselect ' : 'select ') + f.name,
            disabled: noAccess ? true : null,
            onclick: onToggleSelect ? (e) => onToggleSelect({ range: !!e.shiftKey }) : null,
        }, h('span', { class: 'ds-check-box', 'aria-hidden': 'true' })) : null,
        h('button', {
            key: 'open', type: 'button', class: 'ds-file-cell-open',
            onclick: canOpen ? () => onOpen(f) : null,
            disabled: canOpen ? null : true,
            'aria-label': typeLabel + ': ' + f.name + (noAccess ? ' (no access)' : ''),
        },
            h('span', { class: 'ds-file-cell-media' },
                thumb
                    ? h('img', { class: 'ds-file-cell-thumb', src: thumb, alt: '', loading: 'lazy' })
                    : FileIcon({ type: f.type })),
            h('span', { class: 'ds-file-cell-name', title: f.name }, f.name),
            h('span', { class: 'ds-file-cell-meta' }, f.type === 'dir' ? 'folder' : fmtFileSize(f.size))),
    ].filter(Boolean);
    return h('div', {
        key,
        class: 'ds-file-cell' + (selected ? ' is-marked' : '') + (f.active ? ' active' : '') + (noAccess ? ' is-locked' : ''),
        'data-file-type': f.type,
    }, ...kids);
}

// BulkBar — the act-on-selection strip shown while a multi-select is active.
// Host renders it above the grid; `actions` are [{ label, onClick, danger,
// disabled }]; `busy` disables everything while a bulk operation is in flight.
export function BulkBar({ count = 0, noun = 'file', nounPlural, actions = [], onClear, busy = false } = {}) {
    if (!count) return null;
    // 'entry' pluralizes to 'entries', not 'entrys' - handle the -y noun class
    // unless the host passes an explicit plural.
    const plural = nounPlural || (/[^aeiou]y$/.test(noun) ? noun.slice(0, -1) + 'ies' : noun + 's');
    const kids = [
        h('span', { key: 'count', class: 'ds-bulkbar-count', role: 'status', 'aria-live': 'polite' },
            count + ' ' + (count === 1 ? noun : plural) + ' selected'),
        ...actions.map((a, i) => Btn({
            key: 'bba' + i, danger: !!a.danger, disabled: busy || a.disabled,
            onClick: a.onClick, children: a.label,
        })),
        onClear ? Btn({ key: 'bbclear', disabled: busy, onClick: onClear, children: 'clear selection' }) : null,
    ].filter(Boolean);
    return h('div', { class: 'ds-bulkbar', role: 'toolbar', 'aria-label': 'bulk file actions', 'aria-busy': busy ? 'true' : null }, ...kids);
}

// Clickable column headers for FileGrid sort. Active column shows its direction
// as an ASCII caret word (asc/desc) - never a glyph arrow.
function FileSortHeader({ key: active = 'name', dir = 'asc', onSort } = {}) {
    const cols = [['name', 'name'], ['size', 'size'], ['modified', 'modified']];
    return h('div', { class: 'ds-file-sort', role: 'group', 'aria-label': 'sort files' },
        ...cols.map(([k, label]) => h('button', {
            key: k, type: 'button',
            class: 'ds-file-sort-btn' + (active === k ? ' active' : ''),
            'aria-pressed': active === k ? 'true' : 'false',
            'aria-label': 'sort by ' + label + (active === k ? ' (' + (dir === 'asc' ? 'ascending' : 'descending') + ')' : ''),
            onclick: () => onSort && onSort(k),
        }, label + (active === k ? ' ' + (dir === 'asc' ? 'asc' : 'desc') : ''))));
}

export function FileToolbar({ left = [], right = [] } = {}) {
    return h('div', { class: 'ds-file-toolbar' },
        h('div', { class: 'ds-file-toolbar-left' }, ...left),
        h('div', { class: 'ds-file-toolbar-right' }, ...right)
    );
}

// RootsPicker — a segmented control for choosing among multiple allowed FS roots
// (so the app stops borrowing the history-tab .pill markup). Each root is
// { id, label }; `selected` is the active id. role=tablist for AT navigation.
export function RootsPicker({ roots = [], selected, onSelect, label = 'roots' } = {}) {
    if (!roots.length) return null;
    return h('div', { class: 'ds-roots-picker', role: 'tablist', 'aria-label': label },
        ...roots.map((r) => h('button', {
            key: 'root-' + (r.id != null ? r.id : r.label),
            type: 'button', role: 'tab',
            class: 'ds-roots-tab' + ((r.id != null ? r.id : r.label) === selected ? ' active' : ''),
            'aria-selected': (r.id != null ? r.id : r.label) === selected ? 'true' : 'false',
            onclick: () => onSelect && onSelect(r.id != null ? r.id : r.label),
        }, r.label || r.id)));
}

export function DropZone({ children, dragover, onDrop, onDragOver, onDragLeave, label = 'drop files here', onPick } = {}) {
    // With children the zone is a passive WRAPPER: content renders normally and
    // the dashed affordance appears only while a drag is over it (real file
    // managers never burn a permanent band on a maybe-drop). Without children
    // it keeps the explicit picker-block look.
    const kids = Array.isArray(children) ? children : children ? [children] : [];
    return h('div', {
        class: 'ds-dropzone' + (kids.length ? ' ds-dropzone--wrap' : '') + (dragover ? ' dragover' : ''),
        ondragover: (e) => { e.preventDefault(); onDragOver && onDragOver(e); },
        ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) { onDragLeave && onDragLeave(e); } },
        ondrop: (e) => { e.preventDefault(); onDrop && onDrop(e.dataTransfer.files); }
    },
        h('div', { class: 'ds-dropzone-inner' },
            h('span', { class: 'ds-dropzone-glyph', role: 'img', 'aria-label': 'upload' }, Icon('arrow-up')),
            h('span', { class: 'ds-dropzone-label' }, label),
            onPick ? Btn({ onClick: onPick, children: 'pick files' }) : null
        ),
        ...kids
    );
}

// UploadProgress — per-file upload rows. Error rows are recoverable, not dead
// ends: each item may carry `actions` ([{ label, onClick }], e.g. 'replace' on
// a 409 collision) and the host may wire `onDismiss(item, index)` so error rows
// can be cleared without waiting for the next successful batch.
export function UploadProgress({ items = [], onDismiss } = {}) {
    if (!items.length) return null;
    return h('div', { class: 'ds-upload-progress' },
        ...items.map((it, i) => {
            const indeterminate = !it.error && !it.done && !it.pct && it.indeterminate;
            const status = it.error ? 'error' : (it.done ? 'complete' : (indeterminate ? 'uploading' : `uploading ${it.pct || 0}%`));
            const rowActions = [
                ...((it.actions || []).map((a, ai) => h('button', {
                    key: 'ua' + ai, type: 'button', class: 'ds-upload-act',
                    'aria-label': `${a.label} ${it.name}`,
                    onclick: () => a.onClick && a.onClick(it, i),
                }, a.label))),
                (it.error && onDismiss) ? h('button', {
                    key: 'ud', type: 'button', class: 'ds-upload-act',
                    'aria-label': `dismiss ${it.name}`,
                    onclick: () => onDismiss(it, i),
                }, 'dismiss') : null,
            ].filter(Boolean);
            return h('div', {
                key: it.name + i,
                class: 'ds-upload-item' + (it.done ? ' done' : '') + (it.error ? ' error' : ''),
                role: 'status',
                'aria-label': `${it.name}: ${status}`,
                'aria-live': 'polite'
            },
                h('span', { class: 'ds-upload-name' }, it.name),
                h('span', { class: 'ds-upload-bar' + (indeterminate ? ' indeterminate' : '') },
                    h('span', { class: 'ds-upload-fill', 'data-pct': String(Math.max(0, Math.min(100, it.pct || 0))), 'aria-hidden': 'true' })
                ),
                h('span', { class: 'ds-upload-pct', 'aria-hidden': 'true' }, (it.error ? 'err' : (it.done ? 'ok' : (indeterminate ? '...' : (it.pct || 0) + '%')))),
                rowActions.length ? h('span', { class: 'ds-upload-actions', role: 'group', 'aria-label': `actions for ${it.name}` }, ...rowActions) : null
            );
        })
    );
}

export function EmptyState({ text = 'nothing here', glyph = Icon('circle'), action } = {}) {
    // action: { onClick, label } - an optional CTA (e.g. 'go up' / 'upload a
    // file'), mirroring the SessionDashboard emptyAction contract so an empty
    // directory is not a dead end. Children are built as an array + filtered so
    // the keyed Btn never sits beside an unkeyed span (webjsx applyDiff 'key'
    // crash on mixed keyed/unkeyed siblings).
    return h('div', { class: 'ds-file-empty', role: 'status' },
        ...[
            h('span', { key: 'glyph', class: 'ds-file-empty-glyph', 'aria-hidden': 'true' }, glyph),
            h('span', { key: 'text', class: 'ds-file-empty-text' }, text),
            (action && action.onClick)
                ? Btn({ key: 'ea', onClick: action.onClick, children: action.label || 'go up' })
                : null,
        ].filter(Boolean)
    );
}

export function BreadcrumbPath({ segments = [], onNav, root = 'root' } = {}) {
    const parts = [h('button', { key: 'root', class: 'ds-crumb-seg', onclick: () => onNav && onNav(0) }, root)];
    segments.forEach((seg, i) => {
        parts.push(h('span', { key: 'sep' + i, class: 'ds-crumb-sep', 'aria-hidden': 'true' }, Icon('chevron-right', { size: 13 })));
        parts.push(h('button', {
            key: 'seg' + i,
            class: 'ds-crumb-seg' + (i === segments.length - 1 ? ' leaf' : ''),
            onclick: () => onNav && onNav(i + 1)
        }, seg));
    });
    return h('div', { class: 'ds-crumb-path' }, ...parts);
}
