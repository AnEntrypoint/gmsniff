// Interaction primitives — pointer drag/drop + keyboard shortcuts.
// Pointer Events only (touch+mouse). Visuals via editor-primitives.css.
import * as webjsx from '../../vendor/webjsx/index.js';
import { Icon } from './shell.js';
const h = webjsx.createElement;
const DRAG_THRESHOLD = 5;
const IS_MAC = (typeof navigator !== 'undefined') && /Mac|iPhone|iPad/.test(navigator.platform || '');
const SHORTCUT_REGISTRY = new Set();
function dispatchDrag(el, detail) {
    el.dispatchEvent(new CustomEvent('ds-drag', { detail, bubbles: true, composed: true }));
}

export function useDraggable(el, { data, kind, onDragStart, onDragEnd } = {}) {
    if (!el) return { destroy() {} };
    let startX = 0, startY = 0, active = false, started = false, pid = null;
    let kbMode = false, kbTargets = [], kbIdx = 0;

    const onMove = (e) => {
        if (!active) return;
        if (!started) {
            const dx = e.clientX - startX, dy = e.clientY - startY;
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            started = true;
            el.setAttribute('data-dragging', 'true');
            if (onDragStart) onDragStart({ data, kind, pointerEvent: e });
        }
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const target = hit && hit.closest('[data-drop-target]');
        dispatchDrag(el, { phase: 'move', data, kind, pointerEvent: e, target });
    };
    const onUp = (e) => {
        if (!active) return;
        const wasStarted = started;
        active = false; started = false;
        try { if (pid != null) el.releasePointerCapture(pid); } catch { /* swallow: pointer capture may already be released, drag end still proceeds */ }
        pid = null;
        el.removeAttribute('data-dragging');
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const target = hit && hit.closest('[data-drop-target]');
        dispatchDrag(el, { phase: 'end', data, kind, pointerEvent: e, target });
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (wasStarted && onDragEnd) onDragEnd({ drop: target, data, kind });
    };
    const onDown = (e) => {
        if (e.button != null && e.button !== 0) return;
        active = true; started = false;
        startX = e.clientX; startY = e.clientY; pid = e.pointerId;
        try { el.setPointerCapture(e.pointerId); } catch { /* swallow: pointer capture unsupported/denied, drag still tracks via listeners */ }
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    };
    const clearActive = () => kbTargets.forEach(n => n.removeAttribute('data-drop-target-active'));
    const onKey = (e) => {
        if (e.key === ' ' || e.code === 'Space') {
            e.preventDefault();
            if (!kbMode) {
                kbMode = true; kbIdx = 0;
                kbTargets = Array.from(document.querySelectorAll('[data-drop-target]'));
                el.setAttribute('data-dragging', 'true');
                if (onDragStart) onDragStart({ data, kind, pointerEvent: null });
                if (kbTargets[0]) kbTargets[0].setAttribute('data-drop-target-active', 'true');
            } else {
                const t = kbTargets[kbIdx];
                kbMode = false; el.removeAttribute('data-dragging'); clearActive();
                if (t) dispatchDrag(el, { phase: 'end', data, kind, pointerEvent: null, target: t });
                if (onDragEnd) onDragEnd({ drop: t, data, kind });
            }
        } else if (kbMode && /^Arrow/.test(e.key)) {
            e.preventDefault();
            const dir = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
            clearActive();
            kbIdx = (kbIdx + dir + kbTargets.length) % kbTargets.length;
            if (kbTargets[kbIdx]) kbTargets[kbIdx].setAttribute('data-drop-target-active', 'true');
        } else if (kbMode && e.key === 'Escape') {
            e.preventDefault(); kbMode = false; el.removeAttribute('data-dragging'); clearActive();
        }
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('keydown', onKey);
    return { destroy() {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('keydown', onKey);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
    }};
}

// useNumberScrub — pointer-event horizontal drag-to-scrub on a numeric input.
// Pointer Events (mouse+touch+pen+XR), touch-action:none so a vertical page
// scroll never steals the gesture. Click-to-edit is preserved: a press that
// does not cross SCRUB_THRESHOLD leaves the input focusable for typing.
export function useNumberScrub(el, { getValue, onChange, step = 0.01, threshold = 3 } = {}) {
    if (!el) return { destroy() {} };
    el.style.touchAction = 'none';
    let pid = null, startX = 0, startV = 0, moved = false;
    const onMove = (e) => {
        if (pid == null) return;
        const dx = e.clientX - startX;
        if (!moved) {
            if (Math.abs(dx) < threshold) return;
            moved = true;
            el.setAttribute('data-scrubbing', 'true');
            if (document.activeElement === el) el.blur();
        }
        const v = startV + dx * step;
        if (onChange) onChange(v);
    };
    const onUp = () => {
        if (pid == null) return;
        try { el.releasePointerCapture(pid); } catch { /* swallow: pointer capture may already be released, drag end still proceeds */ }
        pid = null;
        el.removeAttribute('data-scrubbing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
    };
    const onDown = (e) => {
        if (e.button != null && e.button !== 0) return;
        // Let a focused input handle caret placement / text selection instead.
        if (document.activeElement === el) return;
        pid = e.pointerId; startX = e.clientX; moved = false;
        const cur = getValue ? getValue() : parseFloat(el.value);
        startV = Number.isFinite(cur) ? cur : 0;
        try { el.setPointerCapture(pid); } catch { /* swallow: pointer capture unsupported/denied, drag still tracks via listeners */ }
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointerdown', onDown);
    return { destroy() {
        el.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
    }};
}

// usePointerDrag — free 2D pointer drag with caller-supplied onMove, for surfaces
// that need raw pointer coordinates each frame (a 3D viewport gizmo, a canvas
// handle) rather than the data-transfer DnD model of useDraggable. Pointer Events
// only, so mouse+touch+pen+XR-controller all drive it. The primary pointer is
// captured on the element (drag keeps tracking when it leaves the element or
// crosses a panel) and released on pointerup/pointercancel; a non-primary pointer
// (second finger) is ignored mid-drag so multi-touch never makes the drag jump.
// onStart returns false to decline the drag (e.g. a miss in the gizmo raycast),
// leaving the pointerdown to propagate to other handlers.
export function usePointerDrag(el, { onStart, onMove, onEnd, button = 0 } = {}) {
    if (!el) return { destroy() {} };
    let pid = null;
    const onMoveEv = (e) => {
        if (pid == null || e.pointerId !== pid) return;
        if (onMove) onMove(e);
    };
    const finish = (e, cancelled) => {
        if (pid == null) return;
        try { el.releasePointerCapture(pid); } catch { /* swallow: pointer capture may already be released, drag end still proceeds */ }
        pid = null;
        el.removeAttribute('data-pointer-dragging');
        window.removeEventListener('pointermove', onMoveEv);
        window.removeEventListener('pointerup', onUpEv);
        window.removeEventListener('pointercancel', onCancelEv);
        if (onEnd) onEnd(e, cancelled);
    };
    const onUpEv = (e) => { if (e.pointerId === pid) finish(e, false); };
    const onCancelEv = (e) => { if (e.pointerId === pid) finish(e, true); };
    const onDown = (e) => {
        if (button != null && e.button != null && e.button !== button) return;
        if (pid != null) return; // already dragging with the primary pointer
        if (onStart && onStart(e) === false) return; // caller declined (e.g. raycast miss)
        pid = e.pointerId;
        el.setAttribute('data-pointer-dragging', 'true');
        try { el.setPointerCapture(pid); } catch { /* swallow: pointer capture unsupported/denied, drag still tracks via listeners */ }
        window.addEventListener('pointermove', onMoveEv);
        window.addEventListener('pointerup', onUpEv);
        window.addEventListener('pointercancel', onCancelEv);
    };
    el.addEventListener('pointerdown', onDown);
    return { destroy() {
        el.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointermove', onMoveEv);
        window.removeEventListener('pointerup', onUpEv);
        window.removeEventListener('pointercancel', onCancelEv);
    }, get dragging() { return pid != null; } };
}

export function useDropTarget(el, { accepts = [], onDrop, onDragOver } = {}) {
    if (!el) return { destroy() {} };
    el.setAttribute('data-drop-target', '');
    const handler = (e) => {
        const d = e.detail; if (!d) return;
        if (accepts.length && !accepts.includes(d.kind)) return;
        if (d.target !== el) {
            el.removeAttribute('data-drop-target-active');
            return;
        }
        if (d.phase === 'move') {
            el.setAttribute('data-drop-target-active', 'true');
            if (onDragOver) onDragOver({ data: d.data, kind: d.kind, pointerEvent: d.pointerEvent });
        } else if (d.phase === 'end') {
            el.removeAttribute('data-drop-target-active');
            if (onDrop) onDrop({ data: d.data, kind: d.kind, pointerEvent: d.pointerEvent });
        }
    };
    document.addEventListener('ds-drag', handler, true);
    return { destroy() {
        document.removeEventListener('ds-drag', handler, true);
        el.removeAttribute('data-drop-target');
        el.removeAttribute('data-drop-target-active');
    }};
}

export function Reorderable({ items = [], getKey, renderItem, onReorder, axis = 'vertical', kind = 'reorder' } = {}) {
    const order = items.map((_, i) => i);
    const cls = 'ds-reorderable ds-reorderable-' + axis;
    return h('div', { class: cls, role: 'list' },
        ...items.map((item, i) => {
            const key = getKey ? getKey(item, i) : i;
            const onRef = (el) => {
                if (!el || el._dsReorder) return;
                el._dsReorder = true;
                const handle = el.querySelector('.ds-reorder-handle') || el;
                const drag = useDraggable(handle, {
                    data: { index: i }, kind,
                    onDragEnd: ({ drop }) => {
                        if (!drop) return;
                        const toIdx = Number(drop.getAttribute('data-reorder-index'));
                        if (Number.isNaN(toIdx) || toIdx === i) return;
                        const next = order.slice();
                        const [m] = next.splice(i, 1);
                        next.splice(toIdx, 0, m);
                        if (onReorder) onReorder(next);
                    },
                });
                const drop = useDropTarget(el, { accepts: [kind] });
                el._dsReorderDestroy = () => { drag.destroy(); drop.destroy(); };
            };
            return h('div', {
                key, ref: onRef, class: 'ds-reorder-item',
                'data-reorder-index': String(i), role: 'listitem',
            },
                h('button', {
                    type: 'button', class: 'ds-reorder-handle',
                    'aria-label': 'Reorder', tabindex: '0',
                }, Icon('more-horizontal')),
                renderItem ? renderItem(item, i) : null
            );
        })
    );
}

function parseCombo(combo) {
    const parts = combo.split('+').map(s => s.trim());
    const key = parts.pop();
    const mods = new Set(parts.map(s => s.toLowerCase()));
    return { key: key.length === 1 ? key.toLowerCase() : key, mod: mods.has('mod'), shift: mods.has('shift'), alt: mods.has('alt'), ctrl: mods.has('ctrl') };
}
function matchEvent(e, spec) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k !== spec.key) return false;
    const modOk = spec.mod ? (IS_MAC ? e.metaKey : e.ctrlKey) : true;
    if (!modOk) return false;
    if (spec.shift !== !!e.shiftKey) return false;
    if (spec.alt !== !!e.altKey) return false;
    if (spec.ctrl && !e.ctrlKey) return false;
    return true;
}

export function formatShortcut(combo) {
    const s = parseCombo(combo);
    const mod = s.mod ? (IS_MAC ? 'Cmd+' : 'Ctrl+') : '';
    const shift = s.shift ? 'Shift+' : '';
    const alt = s.alt ? 'Alt+' : '';
    const key = s.key.length === 1 ? s.key.toUpperCase() : s.key;
    return mod + alt + shift + key;
}

export function useKeyboardShortcut(map = {}, { scope = 'global', enabled = true } = {}) {
    if (!enabled) return { destroy() {}, trigger() {} };
    const target = scope === 'global' ? (typeof document !== 'undefined' ? document : null) : scope;
    if (!target) return { destroy() {}, trigger() {} };
    const specs = Object.entries(map).map(([combo, fn]) => ({ combo, spec: parseCombo(combo), fn }));
    specs.forEach(s => SHORTCUT_REGISTRY.add({ combo: s.combo, scope: scope === 'global' ? 'global' : 'local' }));
    const onKey = (e) => {
        for (const s of specs) if (matchEvent(e, s.spec)) { e.preventDefault(); s.fn(e); return; }
    };
    target.addEventListener('keydown', onKey);
    return {
        destroy() { target.removeEventListener('keydown', onKey); },
        trigger(combo) { const s = specs.find(x => x.combo === combo); if (s) s.fn(); },
    };
}

export function ShortcutHint({ combo, kind = 'kbd' } = {}) { return h('kbd', { class: 'ds-kbd ds-kbd-' + kind }, formatShortcut(combo || '')); }

function shortcutCaps(keys) {
    const caps = [];
    let n = 0;
    const alts = String(keys || '').split(' / ');
    alts.forEach((alt, ai) => {
        if (ai > 0) caps.push(h('span', { key: 'sep-alt-' + (n++), class: 'ds-kbd-sep' }, ' / '));
        const steps = alt.split(' then ');
        steps.forEach((step, si) => {
            if (si > 0) caps.push(h('span', { key: 'sep-then-' + (n++), class: 'ds-kbd-sep' }, ' then '));
            caps.push(h('kbd', { key: 'cap-' + (n++), class: 'ds-kbd' }, step));
        });
    });
    return caps;
}

export function ShortcutList({ shortcuts = [] } = {}) {
    return h('div', { class: 'ds-shortcuts-hint' },
        ...shortcuts.map(s => h('div', { class: 'ds-shortcut-row' },
            h('span', { class: 'ds-kbd-caps' }, ...shortcutCaps(s.keys || s.combo || '')),
            h('span', { class: 'ds-kbd-label' }, s.desc || s.description || s.label || ''))));
}

export function useKeyboardShortcutHelp() { return { registry: Array.from(SHORTCUT_REGISTRY) }; }
export function ShortcutHelpDialog({ open = false, onClose, registry } = {}) {
    if (!open) return null;
    const list = registry || Array.from(SHORTCUT_REGISTRY);
    const groups = {};
    list.forEach(r => { (groups[r.scope] = groups[r.scope] || []).push(r); });
    // Escape-to-close, Tab focus trap, and autofocus on open — wired through a
    // ref so teardown runs on the webjsx ref(null) unmount branch.
    const dialogRef = (el) => {
        if (!el) { if (ShortcutHelpDialog._teardown) { ShortcutHelpDialog._teardown(); ShortcutHelpDialog._teardown = null; } return; }
        const focusables = () => el.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); if (onClose) onClose(); return; }
            if (e.key === 'Tab') {
                const f = focusables();
                if (!f.length) { e.preventDefault(); return; }
                const first = f[0], last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        };
        el.addEventListener('keydown', onKey);
        ShortcutHelpDialog._teardown = () => el.removeEventListener('keydown', onKey);
        // The dialog itself is focusable (tabindex=-1) so it always has a home
        // for focus even when it contains no interactive controls.
        const f = focusables();
        (f[0] || el).focus();
    };
    return h('div', { class: 'ds-ep-dialog-backdrop', onmousedown: (e) => { if (e.target === e.currentTarget && onClose) onClose(); } },
        h('div', { class: 'ds-ep-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts', tabindex: '-1', ref: dialogRef },
            h('h2', null, 'Keyboard shortcuts'),
            ...Object.entries(groups).map(([scope, rows]) =>
                h('section', { class: 'ds-kbd-group' },
                    h('h3', null, scope),
                    h('ul', null, ...rows.map(r => h('li', { class: 'ds-kbd-row' },
                        h(ShortcutHint, { combo: r.combo }),
                        (r.label || r.description) ? h('span', { class: 'ds-kbd-label' }, r.label || r.description) : null
                    )))
                )
            )
        )
    );
}
