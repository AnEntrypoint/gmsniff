// Overlay primitives — Tooltip, Popover, Dropdown + useLongPress, useFloating.
// Shared positioning (auto-flip + viewport clamp) in useFloating; consumed by
// all three. No inline styles except runtime left/top. CSS classes scoped to
// .ds-247420 (see editor-primitives.css).

import * as webjsx from '../../vendor/webjsx/index.js';
import { Icon } from './shell.js';
const h = webjsx.createElement;
const kids = (c) => c == null ? [] : (Array.isArray(c) ? c : [c]);
const FOCUSABLE_SEL = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Shared viewport-clamp margins (px). Previously scattered as bare 8/4/6
// literals across useFloating + _clampToViewport. CLAMP_MARGIN is the gap a
// fixed box keeps from the viewport edge; FLOAT_EDGE is the useFloating edge
// gap; FLOAT_OFFSET_* are anchor-to-content offsets per overlay kind.
const CLAMP_MARGIN = 8;
const FLOAT_EDGE = 4;
const FLOAT_OFFSET_TOOLTIP = 6;
const FLOAT_OFFSET_POPOVER = 6;
const FLOAT_OFFSET_DROPDOWN = 4;

// useFloating — compute left/top + auto-flip; re-runs on resize/scroll.
export function useFloating(anchorEl, contentEl, { placement = 'bottom-start', offset = 8 } = {}) {
    if (!anchorEl || !contentEl) return { update() {}, dispose() {}, finalPlacement: placement };
    let finalPlacement = placement;
    const compute = () => {
        const a = anchorEl.getBoundingClientRect(), c = contentEl.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const [side, align = 'start'] = placement.split('-');
        let s = side;
        if (s === 'bottom' && a.bottom + offset + c.height > vh && a.top - offset - c.height >= 0) s = 'top';
        else if (s === 'top' && a.top - offset - c.height < 0 && a.bottom + offset + c.height <= vh) s = 'bottom';
        else if (s === 'right' && a.right + offset + c.width > vw && a.left - offset - c.width >= 0) s = 'left';
        else if (s === 'left' && a.left - offset - c.width < 0 && a.right + offset + c.width <= vw) s = 'right';
        let x = 0, y = 0;
        if (s === 'bottom' || s === 'top') {
            y = s === 'bottom' ? a.bottom + offset : a.top - offset - c.height;
            x = align === 'start' ? a.left : align === 'end' ? a.right - c.width : a.left + (a.width - c.width) / 2;
        } else {
            x = s === 'right' ? a.right + offset : a.left - offset - c.width;
            y = align === 'start' ? a.top : align === 'end' ? a.bottom - c.height : a.top + (a.height - c.height) / 2;
        }
        x = Math.max(FLOAT_EDGE, Math.min(vw - c.width - FLOAT_EDGE, x));
        y = Math.max(FLOAT_EDGE, Math.min(vh - c.height - FLOAT_EDGE, y));
        contentEl.style.left = x + 'px';
        contentEl.style.top = y + 'px';
        finalPlacement = s + '-' + align;
    };
    compute();
    const cb = () => compute();
    window.addEventListener('resize', cb);
    window.addEventListener('scroll', cb, true);
    // Reposition when the content box itself resizes (async-loaded content
    // grows the popover after initial positioning, pushing it off-viewport).
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(cb) : null;
    if (ro) ro.observe(contentEl);
    return {
        update: compute,
        dispose() { window.removeEventListener('resize', cb); window.removeEventListener('scroll', cb, true); if (ro) ro.disconnect(); },
        get finalPlacement() { return finalPlacement; }
    };
}

// useLongPress — fire callback after ms held without movement.
export function useLongPress(targetEl, callback, { ms = 500 } = {}) {
    if (!targetEl) return () => {};
    let timer = null, sx = 0, sy = 0;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const onDown = (e) => { sx = e.clientX || 0; sy = e.clientY || 0; cancel(); timer = setTimeout(() => { timer = null; callback(e); }, ms); };
    const onMove = (e) => { if (!timer) return; const dx = (e.clientX || 0) - sx, dy = (e.clientY || 0) - sy; if (dx * dx + dy * dy > 64) cancel(); };
    const evts = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', cancel], ['pointerleave', cancel], ['pointercancel', cancel]];
    evts.forEach(([k, fn]) => targetEl.addEventListener(k, fn));
    return () => { cancel(); evts.forEach(([k, fn]) => targetEl.removeEventListener(k, fn)); };
}

// withBusy — run an async action with its triggering button disabled +
// busy-labelled, so a double-click/double-tap can't fire it twice and the
// user sees progress. Restores the button (label, disabled state,
// aria-busy) when the action settles, including on throw. Re-entry while
// already busy is dropped silently rather than queued. Mirrors docstudio's
// dom-busy.js withButtonBusy — agentgui's app.js has no equivalent anywhere,
// so every async-click handler (share/delete/retry/approve-deny) is
// currently unguarded against rapid repeat clicks firing the same mutating
// request twice.
export async function withBusy(btn, fn, busyLabel = '...') {
    if (!btn) return fn();
    if (btn.disabled) return;                 // already in flight -> drop the repeat
    const prevHtml = btn.innerHTML;
    const prevDisabled = btn.disabled;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (busyLabel != null) btn.textContent = busyLabel;
    try {
        return await fn();
    } finally {
        btn.disabled = prevDisabled;
        btn.removeAttribute('aria-busy');
        btn.innerHTML = prevHtml;
    }
}

// Tooltip — single shared bubble appended to <body>.
let _tipEl = null, _tipFloat = null, _tipTimer = null, _tipId = 0;
function _hideTip() {
    if (_tipTimer) { clearTimeout(_tipTimer); _tipTimer = null; }
    if (_tipFloat) { _tipFloat.dispose(); _tipFloat = null; }
    if (_tipEl) { _tipEl.hidden = true; _tipEl.className = 'ds-tooltip'; }
}
// One module-scope scroll listener hides the shared bubble on any scroll —
// registered once, never per-trigger (per-trigger leaked a listener per element).
if (typeof window !== 'undefined' && !window.__dsTipScrollBound) {
    window.__dsTipScrollBound = true;
    window.addEventListener('scroll', _hideTip, true);
}
function _showTip(trigger, label, placement, kind) {
    if (typeof document === 'undefined') return;
    if (!_tipEl || !document.body.contains(_tipEl)) {
        _tipEl = document.createElement('div');
        _tipEl.className = 'ds-tooltip';
        _tipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(_tipEl);
    }
    _tipEl.textContent = label;
    _tipEl.className = 'ds-tooltip kind-' + (kind || 'default');
    _tipEl.hidden = false;
    _tipEl.id = 'ds-tip-' + (++_tipId);
    trigger.setAttribute('aria-describedby', _tipEl.id);
    if (_tipFloat) _tipFloat.dispose();
    _tipFloat = useFloating(trigger, _tipEl, { placement, offset: FLOAT_OFFSET_TOOLTIP });
}

export function Tooltip({ children, label, placement = 'top', delay = 350, kind = 'default' } = {}) {
    const child = kids(children)[0];
    if (!child || !label) return child || null;
    const refFn = (el) => {
        if (!el || el._dsTip) return;
        el._dsTip = true;
        const schedule = () => { if (_tipTimer) clearTimeout(_tipTimer); _tipTimer = setTimeout(() => _showTip(el, label, placement, kind), delay); };
        const show = () => _showTip(el, label, placement, kind);
        el.addEventListener('pointerenter', schedule);
        el.addEventListener('pointerleave', _hideTip);
        el.addEventListener('focus', show);
        el.addEventListener('blur', _hideTip);
        el.addEventListener('keydown', (e) => { if (e.key === 'Escape') _hideTip(); });
        useLongPress(el, show, { ms: 500 });
    };
    const prevRef = child.props && child.props.ref;
    const wrap = (el) => { refFn(el); if (typeof prevRef === 'function') prevRef(el); };
    return webjsx.createElement(child.type, { ...(child.props || {}), ref: wrap }, ...(child.children || []));
}

// Popover — controlled, portaled to <body>.
const _popovers = new WeakMap();
export function Popover({ open, anchorEl, onClose, placement = 'bottom-start', children, ariaLabel } = {}) {
    if (typeof document === 'undefined') return null;
    const existing = anchorEl ? _popovers.get(anchorEl) : null;
    if (!open) {
        if (existing) { existing.dispose(); _popovers.delete(anchorEl); if (anchorEl && anchorEl.focus) anchorEl.focus(); }
        return null;
    }
    if (existing || !anchorEl) return null;
    const el = document.createElement('div');
    el.className = 'ds-popover';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
    el.tabIndex = -1;
    document.body.appendChild(el);
    webjsx.applyDiff(el, h('div', { class: 'ds-popover-inner' }, ...kids(children)));
    const floating = useFloating(anchorEl, el, { placement, offset: FLOAT_OFFSET_POPOVER });
    const close = () => onClose && onClose();
    const onDown = (e) => { if (el.contains(e.target) || anchorEl.contains(e.target)) return; close(); };
    const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key !== 'Tab') return;
        const nodes = el.querySelectorAll(FOCUSABLE_SEL); if (!nodes.length) { e.preventDefault(); return; }
        const first = nodes[0], last = nodes[nodes.length - 1], a = document.activeElement;
        if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    queueMicrotask(() => { const f = el.querySelector(FOCUSABLE_SEL); (f || el).focus(); });
    _popovers.set(anchorEl, { dispose() {
        document.removeEventListener('mousedown', onDown, true);
        floating.dispose();
        if (el.parentNode) el.parentNode.removeChild(el);
    }});
    return null;
}

// Dropdown — button trigger + portaled menu.
export function Dropdown({ trigger, items = [], onSelect, placement = 'bottom-start', ariaLabel } = {}) {
    let triggerEl = null, open = false, menuEl = null, floating = null, typeBuf = '', typeTimer = null;
    const liveBtns = () => menuEl ? [...menuEl.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')] : [];
    const focusItem = (idx) => { const b = liveBtns(); if (!b.length) return; b[((idx % b.length) + b.length) % b.length].focus(); };
    const onDown = (e) => { if (menuEl && menuEl.contains(e.target)) return; if (triggerEl && triggerEl.contains(e.target)) return; close(false); };
    const close = (restore = true) => {
        if (!open) return; open = false;
        if (floating) { floating.dispose(); floating = null; }
        if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
        menuEl = null;
        document.removeEventListener('mousedown', onDown, true);
        if (triggerEl) triggerEl.setAttribute('aria-expanded', 'false');
        if (restore && triggerEl) triggerEl.focus();
    };
    const select = (it) => { if (it.disabled || it.separator) return; if (onSelect) onSelect(it.id, it); close(); };
    const onMenuKey = (e) => {
        const b = liveBtns(), idx = b.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(idx + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(idx - 1); }
        else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
        else if (e.key === 'End') { e.preventDefault(); focusItem(b.length - 1); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (idx >= 0) b[idx].click(); }
        else if (e.key.length === 1 && /\S/.test(e.key)) {
            typeBuf += e.key.toLowerCase();
            if (typeTimer) clearTimeout(typeTimer);
            typeTimer = setTimeout(() => { typeBuf = ''; }, 600);
            const m = items.findIndex(it => !it.separator && !it.disabled && (it.label || '').toLowerCase().startsWith(typeBuf));
            if (m >= 0) focusItem(items.slice(0, m).filter(it => !it.separator && !it.disabled).length);
        }
    };
    const openMenu = (focusFirst = true) => {
        if (open || !triggerEl) return;
        open = true;
        menuEl = document.createElement('div');
        menuEl.className = 'ds-popover ds-dropdown-menu';
        menuEl.setAttribute('role', 'menu');
        if (ariaLabel) menuEl.setAttribute('aria-label', ariaLabel);
        menuEl.tabIndex = -1;
        const tree = h('div', { class: 'ds-dropdown-list' },
            ...items.map((it, i) => it.separator
                ? h('div', { key: 'sep' + i, class: 'ds-dropdown-separator', role: 'separator' })
                : h('button', {
                    key: it.id || i, type: 'button', role: 'menuitem',
                    class: 'ds-dropdown-item' + (it.danger ? ' is-danger' : ''),
                    'aria-disabled': it.disabled ? 'true' : 'false',
                    tabindex: '-1', onclick: () => select(it),
                },
                    it.glyph != null ? h('span', { class: 'ds-dropdown-glyph', 'aria-hidden': 'true' }, it.glyph) : null,
                    h('span', { class: 'ds-dropdown-label' }, it.label)
                )));
        webjsx.applyDiff(menuEl, tree);
        document.body.appendChild(menuEl);
        menuEl.addEventListener('keydown', onMenuKey);
        floating = useFloating(triggerEl, menuEl, { placement, offset: FLOAT_OFFSET_DROPDOWN });
        document.addEventListener('mousedown', onDown, true);
        triggerEl.setAttribute('aria-expanded', 'true');
        if (focusFirst) queueMicrotask(() => focusItem(0));
    };
    const onTrigClick = () => { if (open) close(false); else openMenu(true); };
    const onTrigKey = (e) => { if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!open) openMenu(true); else focusItem(0); } };
    const refFn = (el) => {
        if (!el || el._dsDropdown) return;
        el._dsDropdown = true; triggerEl = el;
        el.addEventListener('click', onTrigClick);
        el.addEventListener('keydown', onTrigKey);
        el.setAttribute('aria-haspopup', 'menu');
        el.setAttribute('aria-expanded', 'false');
    };
    const child = (typeof trigger === 'function') ? trigger() : trigger;
    return (child && child.type)
        ? webjsx.createElement(child.type, { ...(child.props || {}), ref: refFn }, ...(child.children || []))
        : h('button', { type: 'button', class: 'ds-dropdown-trigger', ref: refFn }, child || 'Menu');
}

// PermissionMenu — a role=menu of role=menuitemcheckbox rows, one per
// category, with roving tabindex + Arrow-up/down/Home/End navigation and
// Escape-closes-and-restores-focus, plus "Approve all"/"Revoke all" actions.
// Mirrors Dropdown's own open/close + outside-click wiring (a portaled menu
// element, a document-level mousedown listener, focus restored to the
// trigger on close) rather than reimplementing that plumbing.
export function PermissionMenu({ trigger, categories = [], approved = [], onToggle, onToggleAll, placement = 'bottom-start', ariaLabel = 'Permissions' } = {}) {
    let triggerEl = null, open = false, menuEl = null, floating = null;
    const isApproved = (id) => approved.indexOf(id) !== -1;
    const liveItems = () => menuEl ? [...menuEl.querySelectorAll('[role="menuitemcheckbox"]')] : [];
    const focusItem = (idx) => { const items = liveItems(); if (!items.length) return; items[((idx % items.length) + items.length) % items.length].focus(); };
    const onDown = (e) => { if (menuEl && menuEl.contains(e.target)) return; if (triggerEl && triggerEl.contains(e.target)) return; close(false); };
    const close = (restore = true) => {
        if (!open) return; open = false;
        if (floating) { floating.dispose(); floating = null; }
        if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
        menuEl = null;
        document.removeEventListener('mousedown', onDown, true);
        if (triggerEl) triggerEl.setAttribute('aria-expanded', 'false');
        if (restore && triggerEl) triggerEl.focus();
    };
    const toggle = (cat) => { if (onToggle) onToggle(cat.id, !isApproved(cat.id)); };
    const onMenuKey = (e) => {
        const items = liveItems(), idx = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(idx + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(idx - 1); }
        else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
        else if (e.key === 'End') { e.preventDefault(); focusItem(items.length - 1); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (idx >= 0) items[idx].click(); }
    };
    const renderMenu = () => {
        const rows = categories.map((cat, i) => h('button', {
            key: cat.id || i, type: 'button', role: 'menuitemcheckbox',
            'aria-checked': isApproved(cat.id) ? 'true' : 'false',
            class: 'ov-perm-item' + (isApproved(cat.id) ? ' is-approved' : ''),
            tabindex: '-1',
            onclick: () => toggle(cat),
        }, h('span', { class: 'ov-perm-label' }, cat.label || cat.id)));
        const actionsRow = h('div', { class: 'ov-perm-actions' },
            h('button', { type: 'button', class: 'ov-perm-action', onclick: () => onToggleAll && onToggleAll(true) }, 'Approve all'),
            h('button', { type: 'button', class: 'ov-perm-action', onclick: () => onToggleAll && onToggleAll(false) }, 'Revoke all'));
        return h('div', { class: 'ov-perm-list' }, ...rows, actionsRow);
    };
    const openMenu = (focusFirst = true) => {
        if (open || !triggerEl) return;
        open = true;
        menuEl = document.createElement('div');
        menuEl.className = 'ds-popover ov-perm-menu';
        menuEl.setAttribute('role', 'menu');
        menuEl.setAttribute('aria-label', ariaLabel);
        menuEl.tabIndex = -1;
        webjsx.applyDiff(menuEl, renderMenu());
        document.body.appendChild(menuEl);
        menuEl.addEventListener('keydown', onMenuKey);
        floating = useFloating(triggerEl, menuEl, { placement, offset: FLOAT_OFFSET_DROPDOWN });
        document.addEventListener('mousedown', onDown, true);
        triggerEl.setAttribute('aria-expanded', 'true');
        if (focusFirst) queueMicrotask(() => focusItem(0));
    };
    const onTrigClick = () => { if (open) close(false); else openMenu(true); };
    const onTrigKey = (e) => { if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!open) openMenu(true); else focusItem(0); } };
    const refFn = (el) => {
        if (!el || el._dsPermMenu) return;
        el._dsPermMenu = true; triggerEl = el;
        el.addEventListener('click', onTrigClick);
        el.addEventListener('keydown', onTrigKey);
        el.setAttribute('aria-haspopup', 'menu');
        el.setAttribute('aria-expanded', 'false');
    };
    const child = (typeof trigger === 'function') ? trigger() : trigger;
    return (child && child.type)
        ? webjsx.createElement(child.type, { ...(child.props || {}), ref: refFn }, ...(child.children || []))
        : h('button', { type: 'button', class: 'ov-perm-trigger', ref: refFn }, child || 'Permissions');
}

// ApprovalPrompt — an inline, in-thread tool-permission card (as opposed to
// PermissionMenu's settings-style dropdown): shows the tool name + an
// optional args preview, an optional free-text note the user can attach to
// their decision (auto-focused, since the note is usually the primary
// reason to open this card at all), and up to four resolution actions
// (once/session/all/deny). Mirrors docstudio's chat-approval-prompts.js
// buildApprovalPrompt shape. The note textarea is entirely optional -
// omitting `onDecision`'s use of the note arg keeps existing simpler
// once/deny-only call sites unaffected.
export function ApprovalPrompt({ toolName, categoryLabel, argsPreview, onDecision, autoFocusNote = true } = {}) {
    let noteEl = null;
    const noteRef = (el) => {
        if (!el || noteEl === el) return;
        noteEl = el;
        if (autoFocusNote) queueMicrotask(() => noteEl && noteEl.focus());
    };
    const decide = (kind) => { if (onDecision) onDecision(kind, (noteEl && noteEl.value || '').trim()); };
    return h('div', { class: 'ov-approval', role: 'group', 'aria-label': toolName ? `Permission requested: ${toolName}` : 'Permission requested' },
        h('div', { class: 'ov-approval-head' },
            h('span', { class: 'ov-approval-icon' }, Icon('lock', { size: 16 })),
            h('strong', { class: 'ov-approval-tool' }, toolName || ''),
            categoryLabel ? h('span', { class: 'ov-approval-cat' }, '- ' + categoryLabel) : null),
        argsPreview ? h('pre', { class: 'ov-approval-args' }, argsPreview) : null,
        h('textarea', {
            class: 'ov-approval-note', ref: noteRef,
            placeholder: 'Add instructions for the assistant (optional)...',
        }),
        h('div', { class: 'ov-approval-actions' },
            h('button', { type: 'button', class: 'ov-approval-btn ov-approval-btn-primary', onclick: () => decide('once') }, 'Allow once'),
            h('button', { type: 'button', class: 'ov-approval-btn ov-approval-btn-soft', onclick: () => decide('session') }, 'Allow for session'),
            h('button', { type: 'button', class: 'ov-approval-btn', onclick: () => decide('all') }, 'Allow all'),
            h('button', { type: 'button', class: 'ov-approval-btn ov-approval-btn-deny', onclick: () => decide('deny') }, 'Deny')));
}

// Clamp a fixed-position box to the viewport given desired top-left coords.
function _clampToViewport(x, y, w, h, margin = CLAMP_MARGIN) {
    const vw = (typeof window !== 'undefined' ? window.innerWidth : 1024);
    const vh = (typeof window !== 'undefined' ? window.innerHeight : 768);
    return {
        left: Math.max(margin, Math.min(vw - w - margin, x)),
        top: Math.max(margin, Math.min(vh - h - margin, y)),
    };
}

// Tab focus trap for a dialog root — keeps Tab/Shift+Tab cycling inside `el`.
// Call from an onkeydown handler; returns true if it handled the event.
export function trapTab(el, e) {
    if (e.key !== 'Tab') return false;
    const nodes = el.querySelectorAll(FOCUSABLE_SEL);
    if (!nodes.length) { e.preventDefault(); return true; }
    const first = nodes[0], last = nodes[nodes.length - 1], a = document.activeElement;
    if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); return true; }
    if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); return true; }
    return false;
}

// Shared lifecycle for fixed anchor-positioned popovers (EmojiPicker,
// SettingsPopover): on mount, place+clamp near (anchorX, anchorY), focus the
// root, and wire an outside-mousedown close. Returns a cleanup fn the ref(null)
// branch must call. Both consumers deduped through this so the
// queueMicrotask/place/clamp/outside-close dance is authored once.
function _anchoredOverlayLifecycle(el, { anchorX, anchorY, fallbackW, fallbackH, close }) {
    const place = () => {
        const r = el.getBoundingClientRect();
        const { left, top } = _clampToViewport(anchorX, anchorY, r.width || fallbackW, r.height || fallbackH);
        el.style.left = left + 'px'; el.style.top = top + 'px';
    };
    queueMicrotask(() => { place(); el.focus(); });
    const onDown = (e) => { if (!el.contains(e.target)) close(); };
    queueMicrotask(() => document.addEventListener('mousedown', onDown, true));
    return () => document.removeEventListener('mousedown', onDown, true);
}

// CommandPalette — centered Cmd+K palette with live filter + keyboard nav.
export function CommandPalette({ open, items = [], onSelect, onClose } = {}) {
    if (!open) return null;
    const list = Array.isArray(items) ? items : [];
    const labelOf = (it) => String(it.label || it.title || it.name || '');
    let active = 0, filterText = '';

    const matches = () => {
        const q = filterText.trim().toLowerCase();
        return q ? list.filter(it => labelOf(it).toLowerCase().includes(q)) : list.slice();
    };

    const rowsFor = (filtered) => {
        const out = [];
        let lastGroup = null, flatIdx = 0;
        for (const it of filtered) {
            const grp = it.group != null ? String(it.group) : null;
            if (grp && grp !== lastGroup) {
                out.push(h('div', { class: 'ov-cmd-group', role: 'presentation' }, grp));
                lastGroup = grp;
            }
            const idx = flatIdx++;
            const glyph = it.icon != null ? it.icon : (it.glyph != null ? it.glyph : null);
            const hint = it.hint != null ? it.hint : (it.shortcut != null ? it.shortcut : null);
            out.push(h('button', {
                type: 'button', role: 'option',
                id: 'ov-cmd-item-' + idx,
                'data-idx': String(idx),
                'aria-selected': idx === active ? 'true' : 'false',
                class: 'ov-cmd-item' + (idx === active ? ' is-active' : ''),
                onclick: () => choose(it),
                onmousemove: () => { if (active !== idx) { active = idx; renderInner(); } },
            },
                glyph != null ? h('span', { class: 'ov-cmd-glyph', 'aria-hidden': 'true' }, glyph) : null,
                h('span', { class: 'ov-cmd-label' }, labelOf(it)),
                hint != null ? h('span', { class: 'ov-cmd-hint' }, hint) : null
            ));
        }
        return out;
    };

    let rootEl = null, inputEl = null, listEl = null, flat = [];
    // Remember the element focused before the palette opened so we can return
    // focus there on close (the input steals focus on mount).
    const prevFocus = (typeof document !== 'undefined') ? document.activeElement : null;
    const restoreFocus = () => { if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus(); };
    const close = () => { restoreFocus(); if (onClose) onClose(); };
    const choose = (it) => { if (it && onSelect) onSelect(it); };

    const renderInner = () => {
        if (!listEl) return;
        const filtered = matches();
        flat = filtered;
        if (active >= filtered.length) active = Math.max(0, filtered.length - 1);
        webjsx.applyDiff(listEl, h('div', { class: 'ov-cmd-list-inner' },
            filtered.length ? rowsFor(filtered) : h('div', { class: 'ov-cmd-empty' }, 'No results')));
        const sel = listEl.querySelector('.ov-cmd-item.is-active');
        if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
        if (inputEl) inputEl.setAttribute('aria-activedescendant', filtered.length ? 'ov-cmd-item-' + active : '');
    };

    const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); if (flat.length) { active = (active + 1) % flat.length; renderInner(); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (flat.length) { active = (active - 1 + flat.length) % flat.length; renderInner(); } }
        else if (e.key === 'Enter') { e.preventDefault(); if (flat[active]) choose(flat[active]); }
    };

    return h('div', {
        class: 'ov-cmd-backdrop', role: 'presentation',
        ref: (el) => {
            if (!el || el._ovCmd) return; el._ovCmd = true; rootEl = el;
            el.addEventListener('mousedown', (e) => {
                const panel = el.querySelector('.ov-cmd-panel');
                if (panel && !panel.contains(e.target)) close();
            });
        },
    },
        h('div', { class: 'ov-cmd-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette', onkeydown: onKey },
            h('input', {
                type: 'text', class: 'ov-cmd-input', placeholder: 'Type a command…',
                'aria-label': 'command search',
                role: 'combobox',
                'aria-autocomplete': 'list',
                'aria-expanded': 'true',
                'aria-controls': 'ov-cmd-list',
                'aria-activedescendant': '',
                oninput: (e) => { filterText = e.target.value; active = 0; renderInner(); },
                ref: (el) => { if (!el || el._ovCmdIn) return; el._ovCmdIn = true; inputEl = el; queueMicrotask(() => el.focus()); },
            }),
            h('div', { class: 'ov-cmd-list', id: 'ov-cmd-list', role: 'listbox',
                ref: (el) => { if (!el) return; listEl = el; queueMicrotask(renderInner); } })
        )
    );
}

// Sanctioned literal-emoji exception: an emoji picker's whole purpose is to
// present emoji, so the glyph ban does not apply to this data table or the
// per-emoji <button> labels below. This is intentional product content, not
// decorative chrome.
const EMOJI_CATEGORIES = [
    { id: 'smileys', label: '😀', emoji: [
        ['😀', 'grinning smile'], ['😁', 'grinning smile happy'], ['😂', 'joy tears laugh'], ['🤣', 'rofl laugh'],
        ['😊', 'smile blush happy'], ['😍', 'heart eyes love'], ['😘', 'kiss'], ['😎', 'cool sunglasses'],
        ['🤔', 'thinking'], ['😅', 'sweat smile'], ['😉', 'wink'], ['🙂', 'smile slight'],
        ['😇', 'angel innocent'], ['🥳', 'party'], ['😴', 'sleep'], ['🤩', 'starstruck'],
        ['😜', 'wink tongue'], ['😢', 'cry sad'], ['😭', 'sob cry'], ['😡', 'angry mad'],
        ['😱', 'scream shock'], ['🥺', 'pleading'], ['😤', 'huff'], ['😬', 'grimace'],
    ] },
    { id: 'gestures', label: '👍', emoji: [
        ['👍', 'thumbsup yes good'], ['👎', 'thumbsdown no bad'], ['👌', 'ok'], ['✌️', 'peace'],
        ['🤞', 'fingers crossed'], ['🙏', 'pray thanks'], ['👏', 'clap'], ['🙌', 'raised hands'],
        ['💪', 'muscle strong'], ['👀', 'eyes look'], ['🤝', 'handshake'], ['✋', 'hand stop'],
        ['🤙', 'call'], ['👋', 'wave hi bye'], ['🤟', 'love you'], ['☝️', 'point up'],
    ] },
    { id: 'hearts', label: '❤️', emoji: [
        ['❤️', 'heart love red'], ['🧡', 'heart orange'], ['💛', 'heart yellow'], ['💚', 'heart green'],
        ['💙', 'heart blue'], ['💜', 'heart purple'], ['🖤', 'heart black'], ['🤍', 'heart white'],
        ['💔', 'broken heart'], ['💕', 'hearts'], ['💖', 'sparkling heart'], ['💗', 'growing heart'],
    ] },
    { id: 'symbols', label: '✅', emoji: [
        ['🔥', 'fire lit'], ['💯', 'hundred'], ['✅', 'check yes done'], ['❌', 'cross no'],
        ['⭐', 'star'], ['🎉', 'party tada'], ['🎊', 'confetti'], ['✨', 'sparkles'],
        ['💡', 'idea lightbulb'], ['⚡', 'zap lightning'], ['💢', 'anger'], ['💀', 'skull dead'],
        ['🚀', 'rocket launch'], ['🏆', 'trophy win'],
    ] },
];
const ALL_EMOJI = EMOJI_CATEGORIES.flatMap((c) => c.emoji);

// EmojiPicker — fixed popover near (anchorX, anchorY) with category tabs + grid.
// `query`, when non-empty, filters across all categories by name/keyword
// substring match (case-insensitive) instead of showing the active tab.
export function EmojiPicker({ open, anchorX = 0, anchorY = 0, onSelect, onClose, query = '' } = {}) {
    if (!open) return null;
    let cat = EMOJI_CATEGORIES[0].id;
    let rootEl = null, gridEl = null;
    const close = () => onClose && onClose();

    const renderGrid = () => {
        if (!gridEl) return;
        const q = (query || '').trim().toLowerCase();
        const cells = q
            ? ALL_EMOJI.filter(([, name]) => name.toLowerCase().includes(q))
            : (EMOJI_CATEGORIES.find(x => x.id === cat) || EMOJI_CATEGORIES[0]).emoji;
        webjsx.applyDiff(gridEl, h('div', { class: 'ov-emoji-grid-inner' },
            cells.length ? cells.map(([ch, name]) => h('button', {
                type: 'button', class: 'ov-emoji-cell', 'aria-label': name || ch, title: name || ch,
                onclick: () => { if (onSelect) onSelect(ch); },
            }, ch)) : h('div', { class: 'ov-emoji-empty' }, 'no emoji found')));
    };

    const tabNavKey = (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const tabs = rootEl ? [...rootEl.querySelectorAll('.ov-emoji-tab')] : [];
        if (!tabs.length) return;
        const idx = tabs.indexOf(document.activeElement);
        if (idx < 0) return;
        e.preventDefault();
        const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
        tabs[next].focus();
        tabs[next].click();
    };

    return h('div', {
        class: 'ov-emoji-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Emoji picker',
        tabindex: '-1',
        onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); return; } tabNavKey(e); if (rootEl) trapTab(rootEl, e); },
        ref: (el) => {
            if (!el) { if (rootEl && rootEl._ovEmojiCleanup) rootEl._ovEmojiCleanup(); return; }
            if (el._ovEmoji) return; el._ovEmoji = true; rootEl = el;
            el._ovEmojiCleanup = _anchoredOverlayLifecycle(el, { anchorX, anchorY, fallbackW: 260, fallbackH: 240, close });
        },
    },
        (query || '').trim() ? null : h('div', { class: 'ov-emoji-tabs', role: 'tablist' },
            ...EMOJI_CATEGORIES.map((c) => h('button', {
                type: 'button', class: 'ov-emoji-tab', role: 'tab',
                'aria-selected': c.id === cat ? 'true' : 'false',
                'aria-controls': 'ov-emoji-panel',
                onclick: (e) => {
                    cat = c.id;
                    const tabs = rootEl.querySelectorAll('.ov-emoji-tab');
                    tabs.forEach(t => t.setAttribute('aria-selected', 'false'));
                    e.currentTarget.setAttribute('aria-selected', 'true');
                    renderGrid();
                },
            }, c.label))),
        h('div', {
            class: 'ov-emoji-grid', id: 'ov-emoji-panel', role: 'tabpanel',
            'aria-label': EMOJI_CATEGORIES.find(c => c.id === cat)?.label || EMOJI_CATEGORIES[0].label,
            ref: (el) => { if (!el) return; gridEl = el; queueMicrotask(renderGrid); } })
    );
}

// BootOverlay — full-screen brand/progress overlay with error state.
export function BootOverlay({ progress = 0, phase = '', errored = false, visible = false } = {}) {
    if (!visible) return null;
    let pct = Number(progress) || 0;
    if (pct <= 1) pct = pct * 100;
    pct = Math.max(0, Math.min(100, pct));
    return h('div', { class: 'ov-boot' + (errored ? ' is-error' : ''), role: errored ? 'alert' : 'status', 'aria-live': 'polite' },
        h('div', { class: 'ov-boot-inner' },
            errored
                ? h('div', { class: 'ov-boot-mark ov-boot-mark-error', 'aria-hidden': 'true' }, Icon('warn'))
                : h('div', { class: 'ov-boot-spinner', 'aria-hidden': 'true' }),
            !errored ? h('div', { class: 'ov-boot-bar', role: 'progressbar',
                'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100' },
                h('div', { class: 'ov-boot-bar-fill', style: 'width:' + pct + '%' })) : null,
            h('div', { class: 'ov-boot-phase' }, String(phase || (errored ? 'Error' : 'Loading…')))
        )
    );
}

// SettingsPopover — fixed popover with generic section/row control rendering.
export function SettingsPopover({ title = 'Settings', open, anchorX = 0, anchorY = 0, sections = [], onClose } = {}) {
    if (!open) return null;
    let rootEl = null;
    const close = () => onClose && onClose();
    const secs = Array.isArray(sections) ? sections : [];

    const renderRow = (row, i) => {
        const label = row.label != null ? row.label : (row.title != null ? row.title : '');
        const kind = row.kind;
        // Give every interactive control a stable id and point the row label's
        // `for` at it, so the visible label is the control's accessible name.
        const ctrlId = 'ov-set-' + i + '-' + kind;
        const labelNode = h('label', { class: 'ov-set-row-label', for: ctrlId }, String(label));
        let control = null;
        if (kind === 'select') {
            const opts = Array.isArray(row.options) ? row.options : [];
            // Controlled via the `value` prop only — per-option `selected` is
            // dropped so the two don't fight (value wins).
            control = h('select', {
                id: ctrlId,
                class: 'ov-set-control', value: row.value != null ? String(row.value) : undefined,
                onchange: (e) => row.onChange && row.onChange(e.target.value),
            }, ...opts.map(o => {
                const v = (o && typeof o === 'object') ? o.value : o;
                const l = (o && typeof o === 'object') ? (o.label != null ? o.label : o.value) : o;
                return h('option', { value: String(v) }, String(l));
            }));
        } else if (kind === 'toggle') {
            control = h('input', {
                id: ctrlId,
                type: 'checkbox', class: 'ov-set-toggle',
                checked: row.value ? 'checked' : undefined,
                onchange: (e) => row.onChange && row.onChange(e.target.checked),
            });
        } else if (kind === 'range') {
            control = h('input', {
                id: ctrlId,
                type: 'range', class: 'ov-set-control',
                min: String(row.min != null ? row.min : 0),
                max: String(row.max != null ? row.max : 100),
                step: String(row.step != null ? row.step : 1),
                value: String(row.value != null ? row.value : 0),
                oninput: (e) => row.onChange && row.onChange(Number(e.target.value)),
            });
        } else if (kind === 'button') {
            control = h('button', { type: 'button', class: 'ov-set-btn',
                onclick: () => row.onClick && row.onClick() }, String(label || 'Action'));
            return h('div', { class: 'ov-set-row', key: i }, control);
        } else {
            control = h('span', { class: 'ov-set-row-value' }, String(row.value != null ? row.value : ''));
            // Non-interactive value row: a plain span label (no `for` target).
            return h('div', { class: 'ov-set-row', key: i }, h('span', { class: 'ov-set-row-label' }, String(label)), control);
        }
        return h('div', { class: 'ov-set-row', key: i }, labelNode, control);
    };

    return h('div', {
        class: 'ov-set-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': String(title), tabindex: '-1',
        onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); return; } if (rootEl) trapTab(rootEl, e); },
        ref: (el) => {
            if (!el) { if (rootEl && rootEl._ovSetCleanup) rootEl._ovSetCleanup(); return; }
            if (el._ovSet) return; el._ovSet = true; rootEl = el;
            el._ovSetCleanup = _anchoredOverlayLifecycle(el, { anchorX, anchorY, fallbackW: 280, fallbackH: 200, close });
        },
    },
        h('div', { class: 'ov-set-head' }, String(title)),
        h('div', { class: 'ov-set-body' },
            ...secs.map((sec, si) => {
                const slabel = sec.label != null ? sec.label : (sec.title != null ? sec.title : '');
                const rows = Array.isArray(sec.rows) ? sec.rows : (Array.isArray(sec.items) ? sec.items : []);
                return h('div', { class: 'ov-set-section', key: si },
                    slabel ? h('div', { class: 'ov-set-section-head' }, String(slabel)) : null,
                    ...rows.map((r, ri) => renderRow(r, ri)));
            }))
    );
}

// AuthModal — centered login dialog: extension / generate / import (nsec) modes.
export function AuthModal({ mode = 'extension', error = '', busy = false, open = false, onModeChange, onConnectExtension, onGenerate, onImport, onClose } = {}) {
    if (!open) return null;
    const close = () => onClose && onClose();
    const modes = [
        { id: 'extension', label: 'Extension' },
        { id: 'generate', label: 'Generate' },
        { id: 'import', label: 'Import key' },
    ];
    let nsec = '';
    const body = () => {
        if (mode === 'generate') {
            return [
                h('p', { class: 'ov-auth-hint' }, 'Create a fresh Nostr identity. Back up the key after.'),
                h('button', { type: 'button', class: 'ov-auth-primary', disabled: busy ? true : null,
                    onclick: () => onGenerate && onGenerate() }, busy ? 'Working…' : 'Generate new key'),
            ];
        }
        if (mode === 'import') {
            return [
                h('p', { class: 'ov-auth-hint' }, 'Paste an existing nsec / hex secret key.'),
                h('input', {
                    type: 'password', class: 'ov-auth-input', placeholder: 'nsec1…',
                    'aria-label': 'secret key', disabled: busy ? true : null,
                    oninput: (e) => { nsec = e.target.value; },
                    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); onImport && onImport(nsec); } },
                }),
                h('button', { type: 'button', class: 'ov-auth-primary', disabled: busy ? true : null,
                    onclick: () => onImport && onImport(nsec) }, busy ? 'Working…' : 'Import'),
            ];
        }
        return [
            h('p', { class: 'ov-auth-hint' }, 'Connect a NIP-07 browser extension (Alby, nos2x…).'),
            h('button', { type: 'button', class: 'ov-auth-primary', disabled: busy ? true : null,
                onclick: () => onConnectExtension && onConnectExtension() }, busy ? 'Connecting…' : 'Connect extension'),
        ];
    };
    return h('div', {
        class: 'ov-auth-backdrop', role: 'presentation',
        ref: (el) => {
            if (!el || el._ovAuth) return; el._ovAuth = true;
            el.addEventListener('mousedown', (e) => {
                const panel = el.querySelector('.ov-auth-panel');
                if (panel && !panel.contains(e.target)) close();
            });
        },
    },
        h('div', {
            class: 'ov-auth-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sign in',
            onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } },
        },
            h('div', { class: 'ov-auth-head' },
                h('h2', { class: 'ov-auth-title' }, 'Sign in'),
                h('button', { type: 'button', class: 'ov-auth-x', 'aria-label': 'close', onclick: close }, Icon('x'))
            ),
            h('div', { class: 'ov-auth-tabs', role: 'tablist',
                onkeydown: (e) => {
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                    const panel = e.currentTarget.closest('.ov-auth-panel');
                    const tabs = panel ? [...panel.querySelectorAll('.ov-auth-tab')] : [];
                    if (!tabs.length) return;
                    const idx = tabs.indexOf(document.activeElement);
                    if (idx < 0) return;
                    e.preventDefault();
                    const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
                    tabs[next].focus();
                    onModeChange && onModeChange(modes[next].id);
                },
            },
                ...modes.map(m => h('button', {
                    type: 'button', role: 'tab', key: 'am-' + m.id,
                    id: 'ov-auth-tab-' + m.id,
                    class: 'ov-auth-tab' + (m.id === mode ? ' is-active' : ''),
                    'aria-selected': m.id === mode ? 'true' : 'false',
                    'aria-controls': 'ov-auth-panel',
                    onclick: () => onModeChange && onModeChange(m.id),
                }, m.label))
            ),
            h('div', { class: 'ov-auth-body', id: 'ov-auth-panel', role: 'tabpanel',
                'aria-labelledby': 'ov-auth-tab-' + mode }, ...body()),
            error ? h('div', { class: 'ov-auth-error', role: 'alert' }, String(error)) : null
        )
    );
}

// VideoLightbox — fullscreen video player overlay with backdrop dismiss.
export function VideoLightbox({ src, label = '', open = false, onClose } = {}) {
    if (!open || !src) return null;
    const close = () => onClose && onClose();
    return h('div', {
        class: 'ov-lightbox-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': label || 'Video',
        tabindex: '-1',
        onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } },
        ref: (el) => { if (el && !el._ovLb) { el._ovLb = true; queueMicrotask(() => el.focus()); } },
        onmousedown: (e) => { if (e.target === e.currentTarget) close(); },
    },
        h('button', { type: 'button', class: 'ov-lightbox-x', 'aria-label': 'close', onclick: close }, Icon('x')),
        h('div', { class: 'ov-lightbox-stage' },
            h('video', { class: 'ov-lightbox-video', src, controls: true, autoplay: true, playsinline: true }),
            label ? h('div', { class: 'ov-lightbox-label' }, label) : null
        )
    );
}
