// Editor primitives — generic chrome for in-engine editors, inspectors,
// IDEs, debug HUDs. Pure factories, h-based, theme-token driven. All
// visuals route through CSS classes defined in editor-primitives.css;
// no hex/rgba literals appear in this file. Theme switching happens
// via the kit's data-theme attribute on the .ds-247420 scope root.

import * as webjsx from '../../vendor/webjsx/index.js';
import { Icon } from './shell.js';
const h = webjsx.createElement;

function kids(c) { return c == null ? [] : (Array.isArray(c) ? c : [c]); }

export function Toolbar({ leading = [], trailing = [], dense = false, children } = {}) {
    const cls = 'ds-ep-toolbar' + (dense ? ' dense' : '');
    return h('div', { class: cls, role: 'toolbar' },
        h('div', { class: 'ds-ep-toolbar-leading' }, ...kids(leading)),
        children != null ? h('div', { class: 'ds-ep-toolbar-center' }, ...kids(children)) : null,
        h('div', { class: 'ds-ep-toolbar-trailing' }, ...kids(trailing))
    );
}

// ---------------------------------------------------------------------------
// ToolbarRow — a flat, wrapping row of arbitrary action nodes (buttons,
// inputs, chips) with no leading/center/trailing slot structure. Toolbar's
// three-slot split is the wrong shape when a caller just wants "this row of
// controls, left to right, wrapping on narrow viewports" — the exact shape
// gmsniff's panels.js hand-rolled as a bare '.gm-toolbar' div because Toolbar
// didn't cover it. Accepts children as varargs or a single array.
// ---------------------------------------------------------------------------
export function ToolbarRow(...actions) {
    const flat = actions.length === 1 && Array.isArray(actions[0]) ? actions[0] : actions;
    return h('div', { class: 'ds-ep-toolbar-row', role: 'toolbar' }, ...kids(flat));
}

export function Tabs({ items = [], active, onChange, children, 'aria-label': ariaLabel } = {}) {
    // Roving tabindex + arrow nav per WAI-ARIA tabs pattern.
    // Only the active tab is in the tab order; arrows move focus + activate.
    const activeIdx = Math.max(0, items.findIndex(it => it.id === active));
    const onTabKeyDown = (e, idx) => {
        let next = null;
        if (e.key === 'ArrowRight') next = (idx + 1) % items.length;
        else if (e.key === 'ArrowLeft') next = (idx - 1 + items.length) % items.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        if (next == null) return;
        e.preventDefault();
        const nextId = items[next]?.id;
        if (nextId && onChange) onChange(nextId);
        // Move focus on next paint (so the newly rendered active button gets focus)
        queueMicrotask(() => {
            const head = e.currentTarget?.parentElement;
            const btn = head?.querySelectorAll('[role="tab"]')[next];
            if (btn) btn.focus();
        });
    };
    return h('div', { class: 'ds-ep-tabs' },
        h('div', { class: 'ds-ep-tabs-head', role: 'tablist', 'aria-label': ariaLabel || 'tabs' },
            ...items.map((it, idx) => h('button', {
                key: it.id,
                type: 'button',
                class: 'ds-ep-tab' + (it.id === active ? ' active' : ''),
                role: 'tab',
                id: 'tab-' + it.id,
                'aria-selected': it.id === active ? 'true' : 'false',
                'aria-controls': 'tabpanel-' + it.id,
                'aria-label': typeof it.label === 'string' ? it.label : ('tab ' + (idx + 1)),
                tabindex: idx === activeIdx ? '0' : '-1',
                onclick: () => onChange && onChange(it.id),
                onkeydown: (e) => onTabKeyDown(e, idx)
            }, it.label))
        ),
        h('div', {
            class: 'ds-ep-tabs-body',
            role: 'tabpanel',
            id: active ? 'tabpanel-' + active : undefined,
            'aria-labelledby': active ? 'tab-' + active : undefined,
            tabindex: '0'
        }, ...kids(children))
    );
}

export function TreeView({ children } = {}) {
    return h('div', { class: 'ds-ep-tree', role: 'tree' }, ...kids(children));
}

export function TreeItem({ label, glyph, tag, depth = 0, selected = false, expanded = false, onSelect, onToggle, children, hasChildren } = {}) {
    // Support legacy 'hasChildren' prop for future; infer from children param
    const hasKids = hasChildren != null ? hasChildren : (children != null);
    // Tree keyboard model (WAI-ARIA): Up/Down move between visible rows, Right expands/enters,
    // Left collapses/moves to parent, Enter/Space activate, Home/End jump to first/last visible.
    const onRowKeyDown = (e) => {
        const row = e.currentTarget;
        const tree = row.closest('[role="tree"]');
        if (!tree) return;
        const rows = Array.from(tree.querySelectorAll('.ds-ep-tree-row'));
        const idx = rows.indexOf(row);
        if (idx < 0) return;
        const move = (i) => {
            const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
            if (r) r.focus();
        };
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); move(idx + 1); break;
            case 'ArrowUp':   e.preventDefault(); move(idx - 1); break;
            case 'Home':      e.preventDefault(); move(0); break;
            case 'End':       e.preventDefault(); move(rows.length - 1); break;
            case 'ArrowRight':
                if (hasKids && !expanded && onToggle) { e.preventDefault(); onToggle(); }
                else if (hasKids && expanded) { e.preventDefault(); move(idx + 1); }
                break;
            case 'ArrowLeft':
                if (hasKids && expanded && onToggle) { e.preventDefault(); onToggle(); }
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                if (onSelect) onSelect();
                break;
        }
    };
    return h('div', {
        class: 'ds-ep-tree-item' + (selected ? ' selected' : ''),
        role: 'treeitem',
        'aria-selected': selected ? 'true' : 'false',
        'aria-expanded': hasKids ? String(!!expanded) : null,
        'aria-level': depth + 1
    },
        h('div', {
            class: 'ds-ep-tree-row',
            style: 'padding-left:calc(' + depth + ' * var(--tree-indent,12px) + var(--tree-base-indent,6px))',
            tabindex: selected ? '0' : '-1',
            onclick: () => onSelect && onSelect(),
            onkeydown: onRowKeyDown
        },
            h('span', {
                class: 'ds-ep-tree-twist' + (expanded ? ' open' : ''),
                'aria-hidden': 'true',
                onclick: (e) => { e.stopPropagation(); if (hasKids && onToggle) onToggle(); }
            }, hasKids ? Icon('chevron-right') : ''),
            glyph != null ? h('span', { class: 'ds-ep-tree-glyph', 'aria-hidden': 'true' }, glyph) : null,
            h('span', { class: 'ds-ep-tree-label' }, label),
            tag != null ? h('span', { class: 'ds-ep-tree-tag' }, tag) : null
        ),
        hasKids && expanded ? h('div', { class: 'ds-ep-tree-children', role: 'group' }, ...kids(children)) : null
    );
}

export function PropertyGrid({ children } = {}) {
    return h('div', { class: 'ds-ep-propgrid', role: 'group' }, ...kids(children));
}

export function PropertyField({ label, hint, inline = false, children } = {}) {
    return h('label', { class: 'ds-ep-propfield' + (inline ? ' inline' : '') },
        h('span', { class: 'ds-ep-propfield-label' }, label),
        h('span', { class: 'ds-ep-propfield-value' }, ...kids(children)),
        hint != null ? h('span', { class: 'ds-ep-propfield-hint' }, hint) : null
    );
}

// ---------------------------------------------------------------------------
// PropertyGridRow — a PropertyGrid row wrapper with a bottom-border divider
// (last-child border suppressed), for editors that need a stronger per-row
// visual separation than the default PropertyGrid gap gives (e.g. a list of
// independently-editable records like PRD/mutable rows). Generalizes
// gmsniff's gm-propgrid-row.
// ---------------------------------------------------------------------------
export function PropertyGridRow({ children, key } = {}) {
    return h('div', { key, class: 'ds-ep-propgrid-row' }, ...kids(children));
}

// ---------------------------------------------------------------------------
// InlineEditableField — a borderless-until-focus text input that inherits
// surrounding font (no boxed input chrome), with an explicit error state
// (aria-invalid + danger-token border) for live per-field validation.
// Generalizes gmsniff's gm-inline-input / gm-field-error pair. Renders a
// <textarea> when multiline is set (for longer free-text edits), else a
// single-line <input>.
// ---------------------------------------------------------------------------
export function InlineEditableField({ value = '', placeholder, onInput, onChange, error, multiline = false, rows = 3, ariaLabel, disabled = false } = {}) {
    const cls = 'ds-ep-inline-input' + (error ? ' has-error' : '');
    const common = {
        class: cls,
        value,
        placeholder,
        disabled: disabled ? 'disabled' : null,
        'aria-label': ariaLabel,
        'aria-invalid': error ? 'true' : null,
        oninput: onInput ? (e) => onInput(e.target.value, e) : null,
        onchange: onChange ? (e) => onChange(e.target.value, e) : null,
    };
    return multiline
        ? h('textarea', { ...common, rows })
        : h('input', { ...common, type: 'text' });
}

export function Dock({ top, left, right, bottom, center } = {}) {
    return h('div', { class: 'ds-ep-dock' },
        top    != null ? h('div', { class: 'ds-ep-dock-top' },    ...kids(top))    : null,
        left   != null ? h('div', { class: 'ds-ep-dock-left' },   ...kids(left))   : null,
        h('div', { class: 'ds-ep-dock-center' }, ...kids(center)),
        right  != null ? h('div', { class: 'ds-ep-dock-right' },  ...kids(right))  : null,
        bottom != null ? h('div', { class: 'ds-ep-dock-bottom' }, ...kids(bottom)) : null
    );
}

// ---------------------------------------------------------------------------
// Breakpoints + useMediaQuery
// ---------------------------------------------------------------------------
export const BP_SM = 480;
export const BP_MD = 768;
export const BP_LG = 1024;
export const BP_XL = 1440;

export function useMediaQuery(query) {
    if (typeof window === 'undefined' || !window.matchMedia) {
        return { matches: false, addListener: () => {}, removeListener: () => {} };
    }
    const mql = window.matchMedia(query);
    return {
        get matches() { return mql.matches; },
        addListener(fn) { mql.addEventListener ? mql.addEventListener('change', fn) : mql.addListener(fn); },
        removeListener(fn) { mql.removeEventListener ? mql.removeEventListener('change', fn) : mql.removeListener(fn); },
    };
}

// ---------------------------------------------------------------------------
// FocusTrap — wraps subtree, traps Tab/Shift+Tab. Mount/unmount lifecycle is
// managed via DOM-level keydown listener attached when first focused.
// ---------------------------------------------------------------------------
const FOCUSABLE_SEL = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function trapTabKey(rootEl, e) {
    if (e.key !== 'Tab') return;
    const nodes = rootEl.querySelectorAll(FOCUSABLE_SEL);
    if (!nodes.length) { e.preventDefault(); return; }
    const first = nodes[0], last = nodes[nodes.length - 1];
    const active = (rootEl.getRootNode && rootEl.getRootNode().activeElement) || document.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

export function FocusTrap({ children } = {}) {
    return h('div', {
        class: 'ds-ep-focustrap',
        tabindex: '-1',
        ref: (el) => {
            if (!el || el._dsTrap) return;
            el._dsTrap = true;
            el.addEventListener('keydown', (e) => trapTabKey(el, e));
            // Auto-focus first focusable
            queueMicrotask(() => {
                const first = el.querySelector(FOCUSABLE_SEL);
                if (first) first.focus();
                else el.focus();
            });
        }
    }, ...kids(children));
}

// ---------------------------------------------------------------------------
// ResizeHandle — splitter, axis = 'horizontal' (vertical bar, horiz drag)
// or 'vertical' (horizontal bar, vertical drag). onResize(delta:px).
// ---------------------------------------------------------------------------
export function ResizeHandle({ axis = 'horizontal', onResize, ariaLabel } = {}) {
    const isH = axis === 'horizontal';
    let dragOrigin = null;
    const step = 8;
    const emit = (dx, dy) => { if (onResize) onResize(isH ? dx : dy); };
    const onPointerDown = (e) => {
        e.preventDefault();
        dragOrigin = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e) => {
        if (!dragOrigin) return;
        const dx = e.clientX - dragOrigin.x;
        const dy = e.clientY - dragOrigin.y;
        dragOrigin = { x: e.clientX, y: e.clientY };
        emit(dx, dy);
    };
    const onPointerUp = (e) => {
        dragOrigin = null;
        try { e.currentTarget.releasePointerCapture && e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    };
    const onKeyDown = (e) => {
        const k = e.key;
        if (isH) {
            if (k === 'ArrowLeft') { e.preventDefault(); emit(-step, 0); }
            else if (k === 'ArrowRight') { e.preventDefault(); emit(step, 0); }
            else if (k === 'Home') { e.preventDefault(); emit(-1e6, 0); }
            else if (k === 'End') { e.preventDefault(); emit(1e6, 0); }
        } else {
            if (k === 'ArrowUp') { e.preventDefault(); emit(0, -step); }
            else if (k === 'ArrowDown') { e.preventDefault(); emit(0, step); }
            else if (k === 'Home') { e.preventDefault(); emit(0, -1e6); }
            else if (k === 'End') { e.preventDefault(); emit(0, 1e6); }
        }
    };
    return h('div', {
        class: 'ds-ep-resize ' + (isH ? 'axis-h' : 'axis-v'),
        role: 'separator',
        tabindex: '0',
        'aria-orientation': isH ? 'vertical' : 'horizontal',
        'aria-label': ariaLabel || 'Resize',
        onpointerdown: onPointerDown,
        onpointermove: onPointerMove,
        onpointerup: onPointerUp,
        onpointercancel: onPointerUp,
        onkeydown: onKeyDown,
    });
}

// ---------------------------------------------------------------------------
// SplitPanel — two children separated by a ResizeHandle. Stateful via DOM.
// ---------------------------------------------------------------------------
export function SplitPanel({ orientation = 'horizontal', initial = '50%', min = 80, max = Infinity, children } = {}) {
    const isH = orientation === 'horizontal';
    const ks = kids(children);
    const first = ks[0] || null;
    const second = ks[1] || null;
    const sizeProp = isH ? 'width' : 'height';
    const initStyle = typeof initial === 'number' ? initial + 'px' : initial;
    let rootEl = null;
    // The dragged size is persisted here so a re-render (applyDiff reconciling
    // the pane's style back to the initial value) does NOT reset the user's
    // resize. onResize records it; the pane's ref re-applies it after each diff.
    let draggedSize = null;
    const applySize = (a) => {
        if (!a) return;
        if (draggedSize != null) { a.style[sizeProp] = draggedSize + 'px'; a.style.flex = '0 0 auto'; }
    };
    const onResize = (delta) => {
        if (!rootEl) return;
        const a = rootEl.firstChild;
        if (!a) return;
        const rect = a.getBoundingClientRect();
        const curr = isH ? rect.width : rect.height;
        const total = isH ? rootEl.getBoundingClientRect().width : rootEl.getBoundingClientRect().height;
        const next = Math.max(min, Math.min(max === Infinity ? total - min : max, curr + delta));
        draggedSize = next;
        a.style[sizeProp] = next + 'px';
        a.style.flex = '0 0 auto';
    };
    return h('div', {
        class: 'ds-ep-split ' + (isH ? 'horiz' : 'vert'),
        ref: (el) => { rootEl = el; }
    },
        h('div', { class: 'ds-ep-split-pane', style: '--split-size:' + initStyle + ';flex:0 0 auto', ref: applySize }, first),
        ResizeHandle({ axis: isH ? 'horizontal' : 'vertical', onResize }),
        h('div', { class: 'ds-ep-split-pane grow', style: 'flex:1 1 0;min-' + sizeProp + ':0' }, second)
    );
}

// ---------------------------------------------------------------------------
// ContextMenu — items, anchor {x,y}, onClose. Viewport-clamped. Keyboard nav.
// ---------------------------------------------------------------------------
export function ContextMenu({ items = [], anchor = { x: 0, y: 0 }, onClose } = {}) {
    let rootEl = null;
    const close = () => { if (onClose) onClose(); };
    const select = (it) => {
        if (it.disabled || it.separator) return;
        if (it.onSelect) it.onSelect();
        close();
    };
    const onKey = (e) => {
        const btns = rootEl ? [...rootEl.querySelectorAll('button[data-ix]')] : [];
        const active = document.activeElement;
        const idx = btns.indexOf(active);
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); (btns[(idx + 1) % btns.length] || btns[0])?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (btns[(idx - 1 + btns.length) % btns.length] || btns[0])?.focus(); }
        else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); btns[idx].click(); }
    };
    return h('div', {
        class: 'ds-ep-ctxmenu-backdrop',
        onmousedown: (e) => { if (e.target === e.currentTarget) close(); },
        oncontextmenu: (e) => { e.preventDefault(); close(); },
    },
        h('div', {
            class: 'ds-ep-ctxmenu',
            role: 'menu',
            tabindex: '-1',
            onkeydown: onKey,
            ref: (el) => {
                if (!el) {
                    // Unmount: unhook the resize re-clamp bound on mount.
                    if (rootEl && rootEl._dsCtxClampOff) { rootEl._dsCtxClampOff(); }
                    rootEl = null;
                    return;
                }
                rootEl = el;
                // Position at the anchor immediately, then clamp once layout has
                // settled — measuring synchronously in ref reads a zero-size box
                // (children not yet painted), so the clamp must run post-layout.
                const ax = anchor.x || 0, ay = anchor.y || 0;
                el.style.left = ax + 'px';
                el.style.top = ay + 'px';
                const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
                const clamp = () => {
                    const vw = window.innerWidth, vh = window.innerHeight;
                    const r = el.getBoundingClientRect();
                    let x = ax, y = ay;
                    // Touch: keep the menu clear of the lifting finger — nudge
                    // below the touch point, or open above when it fits and the
                    // anchor sits in the lower half (lift-off would otherwise
                    // activate the first item).
                    if (coarse) {
                        y = ay + 10;
                        if (ay > vh / 2 && ay - r.height >= 4) y = ay - r.height;
                    }
                    if (x + r.width > vw) x = Math.max(4, vw - r.width - 4);
                    if (y + r.height > vh) y = Math.max(4, vh - r.height - 4);
                    el.style.left = x + 'px';
                    el.style.top = y + 'px';
                };
                requestAnimationFrame(clamp);
                // Re-clamp on resize/orientation change for the menu's lifetime.
                window.addEventListener('resize', clamp);
                el._dsCtxClampOff = () => { window.removeEventListener('resize', clamp); el._dsCtxClampOff = null; };
                queueMicrotask(() => { el.querySelector('button[data-ix]')?.focus(); });
            }
        },
            ...items.map((it, i) => it.separator
                ? h('div', { key: 'sep' + i, class: 'ds-ep-ctxmenu-sep', role: 'separator' })
                : h('button', {
                    key: i, type: 'button', role: 'menuitem',
                    'data-ix': String(i),
                    class: 'ds-ep-ctxmenu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''),
                    disabled: it.disabled ? 'disabled' : null,
                    onclick: () => select(it),
                },
                    it.icon != null ? h('span', { class: 'ds-ep-ctxmenu-icon' }, it.icon) : null,
                    h('span', { class: 'ds-ep-ctxmenu-label' }, it.label)
                ))
        )
    );
}

// Helper: wires right-click + long-press to a target ref. Caller manages state.
export function useContextMenu(targetEl, items, openCb) {
    if (!targetEl) return () => {};
    let touchTimer = null, lastOpen = 0;
    // Android fires the native contextmenu event on long-press AND our 500ms
    // touch timer — dedupe so the menu opens once, not twice (open/flicker).
    const open = (x, y) => {
        if (Date.now() - lastOpen < 700) return;
        lastOpen = Date.now();
        if (openCb) openCb({ x, y, items });
    };
    const onCtx = (e) => { e.preventDefault(); open(e.clientX, e.clientY); };
    const onTouchStart = (e) => {
        const t = e.touches && e.touches[0]; if (!t) return;
        touchTimer = setTimeout(() => { touchTimer = null; open(t.clientX, t.clientY); }, 500);
    };
    const cancel = () => { if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; } };
    targetEl.addEventListener('contextmenu', onCtx);
    targetEl.addEventListener('touchstart', onTouchStart, { passive: true });
    targetEl.addEventListener('touchmove', cancel, { passive: true });
    targetEl.addEventListener('touchend', cancel);
    targetEl.addEventListener('touchcancel', cancel);
    return () => {
        targetEl.removeEventListener('contextmenu', onCtx);
        targetEl.removeEventListener('touchstart', onTouchStart);
        targetEl.removeEventListener('touchmove', cancel);
        targetEl.removeEventListener('touchend', cancel);
        targetEl.removeEventListener('touchcancel', cancel);
        cancel();
    };
}

// ---------------------------------------------------------------------------
// Drawer — slide-in from side. side='left'|'right'|'bottom'.
// ---------------------------------------------------------------------------
export function Drawer({ side = 'left', open = false, onClose, children, ariaLabel } = {}) {
    if (!open) return null;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose && onClose(); } };
    return h('div', {
        class: 'ds-ep-drawer-backdrop',
        onmousedown: (e) => { if (e.target === e.currentTarget) onClose && onClose(); },
    },
        h('div', {
            class: 'ds-ep-drawer side-' + side,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': ariaLabel || 'Drawer',
            tabindex: '-1',
            onkeydown: onKey,
            ref: (el) => {
                if (!el || el._dsTrap) return;
                el._dsTrap = true;
                el.addEventListener('keydown', (e) => trapTabKey(el, e));
                queueMicrotask(() => {
                    const f = el.querySelector(FOCUSABLE_SEL);
                    (f || el).focus();
                });
            },
        }, ...kids(children))
    );
}

// ---------------------------------------------------------------------------
// Dialog — modal. actions = [{label, onClick, kind?}], dismissible (backdrop).
// ---------------------------------------------------------------------------
export function Dialog({ title, open = false, onClose, children, actions = [], dismissible = false, ariaLabel } = {}) {
    if (!open) return null;
    const opener = (typeof document !== 'undefined') ? document.activeElement : null;
    const close = () => {
        if (onClose) onClose();
        if (opener && opener.focus) queueMicrotask(() => opener.focus());
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    return h('div', {
        class: 'ds-ep-dialog-backdrop',
        onmousedown: (e) => { if (dismissible && e.target === e.currentTarget) close(); },
    },
        h('div', {
            class: 'ds-ep-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': ariaLabel || title || 'Dialog',
            tabindex: '-1',
            onkeydown: onKey,
            ref: (el) => {
                if (!el || el._dsTrap) return;
                el._dsTrap = true;
                el.addEventListener('keydown', (e) => trapTabKey(el, e));
                queueMicrotask(() => {
                    const f = el.querySelector(FOCUSABLE_SEL);
                    (f || el).focus();
                });
            },
        },
            title != null ? h('div', { class: 'ds-ep-dialog-head' }, h('h2', { class: 'ds-ep-dialog-title' }, title)) : null,
            h('div', { class: 'ds-ep-dialog-body' }, ...kids(children)),
            actions && actions.length ? h('div', { class: 'ds-ep-dialog-actions' },
                ...actions.map((a, i) => h('button', {
                    key: i, type: 'button',
                    class: 'ds-ep-dialog-btn' + (a.kind ? (' kind-' + a.kind) : ''),
                    onclick: (e) => { if (a.onClick) a.onClick(e); if (a.close !== false) close(); }
                }, a.label))
            ) : null
        )
    );
}

// ---------------------------------------------------------------------------
// Toast — Toast({message,kind,duration}) component + imperative toast(opts).
// ---------------------------------------------------------------------------
export function Toast({ message, kind = 'info', duration = 3000, onClose } = {}) {
    return h('div', {
        class: 'ds-ep-toast kind-' + kind,
        role: 'status',
        'aria-live': 'polite',
        ref: (el) => {
            if (!el || el._dsToast) return;
            el._dsToast = true;
            if (duration > 0) setTimeout(() => { onClose && onClose(); el.classList.add('leaving'); }, duration);
        }
    }, message);
}

let _toastHostEl = null;
function ensureToastHost() {
    if (typeof document === 'undefined') return null;
    if (_toastHostEl && document.body.contains(_toastHostEl)) return _toastHostEl;
    _toastHostEl = document.createElement('div');
    _toastHostEl.className = 'ds-ep-toast-host';
    document.body.appendChild(_toastHostEl);
    return _toastHostEl;
}

export function toast({ message, kind = 'info', duration = 3000 } = {}) {
    const host = ensureToastHost();
    if (!host) return () => {};
    const el = document.createElement('div');
    el.className = 'ds-ep-toast kind-' + kind;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.textContent = message;
    host.appendChild(el);
    const dismiss = () => {
        if (!el.parentNode) return;
        el.classList.add('leaving');
        setTimeout(() => { el.parentNode && el.parentNode.removeChild(el); }, 200);
    };
    if (duration > 0) setTimeout(dismiss, duration);
    return dismiss;
}

// ---------------------------------------------------------------------------
// Pager — prev/next paginator with a page label. Generalizes gmsniff's
// gm-pager. page is 1-indexed; pageCount<=1 disables both buttons (no
// divide-by-zero, no dead-end enabled control). total (optional) renders an
// item-count suffix ("42 items") alongside the page label.
// ---------------------------------------------------------------------------
export function Pager({ page = 1, pageCount = 1, onPage, total, itemLabel = 'items' } = {}) {
    const safeCount = Math.max(1, pageCount || 1);
    const safePage = Math.min(Math.max(1, page || 1), safeCount);
    const atStart = safePage <= 1;
    const atEnd = safePage >= safeCount;
    return h('div', { class: 'ds-ep-pager', role: 'group', 'aria-label': 'pagination' },
        h('button', {
            type: 'button', class: 'ds-ep-pager-btn', disabled: atStart ? 'disabled' : null,
            'aria-label': 'previous page',
            onclick: () => { if (!atStart && onPage) onPage(safePage - 1); },
        }, '<-'),
        h('span', { class: 'ds-ep-pager-label' },
            'page ' + safePage + ' / ' + safeCount + (total != null ? ' (' + total + ' ' + itemLabel + ')' : '')),
        h('button', {
            type: 'button', class: 'ds-ep-pager-btn', disabled: atEnd ? 'disabled' : null,
            'aria-label': 'next page',
            onclick: () => { if (!atEnd && onPage) onPage(safePage + 1); },
        }, '->')
    );
}

// ---------------------------------------------------------------------------
// JsonViewer — monospace data preview (max-height + scroll), generalizing
// gmsniff's gm-json. Accepts a pre-stringified string OR any value
// (objects/arrays get JSON.stringify(v, null, 2); null/undefined render the
// empty-state text rather than the literal string "undefined"/"null").
//
// mode selects rendering; 'plain' is the historical contract (children[0] is
// the raw text string, verbatim for string input) and stays the default so
// every existing consumer is untouched:
//   'plain'     — flat <pre>, raw text.
//   'highlight' — flat <pre>, text tokenized into ds-ep-json-* spans
//                 (key/string/number/boolean/null). A string that does not
//                 parse as JSON falls back to plain text — arbitrary prose is
//                 never falsely tokenized.
//   'tree'      — collapsible <details> tree per nested object/array, open
//                 above treeDepth (default 2), each summary carrying a
//                 child-count tag. Scalars/unparseable input fall back to
//                 'highlight'/plain respectively.
// copyable=true wraps the viewer with a copy-to-clipboard button (transient
// copied/failed feedback, no dependencies).
// ---------------------------------------------------------------------------
const JSON_NUM_CHARS = '0123456789eE+.-';

// Linear single-pass scan — no regex, no backtracking, safe on truncated
// input (an unterminated string just consumes to end-of-text).
function tokenizeJson(text) {
    const toks = [];
    let i = 0, plain = '';
    const flush = () => { if (plain) { toks.push(['', plain]); plain = ''; } };
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            const start = i;
            i++;
            while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
            i = Math.min(i + 1, text.length);
            let j = i;
            while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j++;
            flush();
            toks.push([text[j] === ':' ? 'k' : 's', text.slice(start, i)]);
            continue;
        }
        if (c === '-' || (c >= '0' && c <= '9')) {
            const start = i;
            i++;
            while (i < text.length && JSON_NUM_CHARS.includes(text[i])) i++;
            flush();
            toks.push(['n', text.slice(start, i)]);
            continue;
        }
        if (text.startsWith('true', i)) { flush(); toks.push(['b', 'true']); i += 4; continue; }
        if (text.startsWith('false', i)) { flush(); toks.push(['b', 'false']); i += 5; continue; }
        if (text.startsWith('null', i)) { flush(); toks.push(['z', 'null']); i += 4; continue; }
        plain += c; i++;
    }
    flush();
    return toks;
}

function highlightJsonSpans(text) {
    return tokenizeJson(text).map(([t, s]) => t ? h('span', { class: 'ds-ep-json-' + t }, s) : s);
}

function jsonTreeNode(key, val, depth, treeDepth) {
    const keyParts = key != null ? [h('span', { class: 'ds-ep-json-k' }, JSON.stringify(key)), ': '] : [];
    if (val !== null && typeof val === 'object') {
        const isArr = Array.isArray(val);
        const entries = isArr ? val.map((v) => [null, v]) : Object.entries(val);
        if (!entries.length) return h('div', { class: 'ds-ep-json-leaf' }, ...keyParts, isArr ? '[]' : '{}');
        const tag = isArr ? '[' + entries.length + ']' : '{' + entries.length + '}';
        return h('details', { class: 'ds-ep-json-node', open: depth < treeDepth ? true : null },
            h('summary', { class: 'ds-ep-json-sum' }, ...keyParts, h('span', { class: 'ds-ep-json-tag' }, tag)),
            h('div', { class: 'ds-ep-json-kids' }, ...entries.map(([k, v]) => jsonTreeNode(k, v, depth + 1, treeDepth))));
    }
    const t = typeof val === 'string' ? 's' : typeof val === 'number' ? 'n' : typeof val === 'boolean' ? 'b' : 'z';
    return h('div', { class: 'ds-ep-json-leaf' }, ...keyParts, h('span', { class: 'ds-ep-json-' + t }, JSON.stringify(val) ?? String(val)));
}

function jsonCopyButton(text) {
    return h('button', {
        type: 'button', class: 'ds-ep-json-copy', title: 'copy JSON', 'aria-label': 'copy JSON',
        onclick: (e) => {
            const btn = e.currentTarget;
            const show = (label, ok) => {
                btn.textContent = label;
                btn.classList.toggle('copied', ok);
                setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1200);
            };
            try {
                navigator.clipboard.writeText(text).then(() => show('copied', true), () => show('failed', false));
            } catch {
                show('failed', false);
            }
        },
    }, 'copy');
}

export function JsonViewer({ value, emptyText = 'no data', maxHeight, mode = 'plain', copyable = false, treeDepth = 2 } = {}) {
    let text, parsed;
    let knownJson = false;
    if (value == null) text = null;
    else if (typeof value === 'string') text = value;
    else { try { text = JSON.stringify(value, null, 2); knownJson = text != null; parsed = value; } catch { text = String(value); } }
    if (!text) return h('div', { class: 'ds-ep-json ds-ep-json-empty' }, emptyText);
    const style = maxHeight ? ('max-height:' + maxHeight) : null;
    if (!knownJson && (mode === 'highlight' || mode === 'tree')) {
        try { parsed = JSON.parse(text); knownJson = true; } catch { /* not JSON — render plain */ }
    }
    let body;
    if (mode === 'tree' && knownJson && parsed !== null && typeof parsed === 'object') {
        body = h('div', { class: 'ds-ep-json ds-ep-json-tree', style }, jsonTreeNode(null, parsed, 0, treeDepth));
    } else if ((mode === 'highlight' || mode === 'tree') && knownJson) {
        body = h('pre', { class: 'ds-ep-json ds-ep-json-hl', style }, ...highlightJsonSpans(text));
    } else {
        body = h('pre', { class: 'ds-ep-json', style }, text);
    }
    if (!copyable) return body;
    return h('div', { class: 'ds-ep-json-wrap' }, jsonCopyButton(text), body);
}

export function IconButtonGroup({ items = [], value, onChange, dense = false } = {}) {
    return h('div', { class: 'ds-ep-btngrp' + (dense ? ' dense' : ''), role: 'group' },
        ...items.map((it) => h('button', {
            key: it.id,
            type: 'button',
            class: 'ds-ep-btngrp-btn' + (it.id === value ? ' active' : ''),
            title: it.title || it.label || it.id,
            'aria-pressed': it.id === value ? 'true' : 'false',
            disabled: it.disabled ? 'disabled' : null,
            onclick: () => { if (!it.disabled && onChange) onChange(it.id); }
        }, it.glyph != null ? it.glyph : it.label))
    );
}
