// ---------------------------------------------------------------------------
// FocusTrap — wraps subtree, traps Tab/Shift+Tab. Mount/unmount lifecycle is
// managed via DOM-level keydown listener attached when first focused.
// ---------------------------------------------------------------------------

import * as webjsx from '../../../vendor/webjsx/index.js';
import { kids, FOCUSABLE_SEL, trapTabKey } from './shared.js';
const h = webjsx.createElement;

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
