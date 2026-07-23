// ThemeToggle — segmented auto/paper/ink radio bound to src/theme.js.
//
// Usage:
//   import { ThemeToggle } from 'anentrypoint-design';
//   ThemeToggle()                                   // segmented control
//   ThemeToggle({ compact: true })                  // single cycling glyph button
//
// Reads current mode from the theme controller; clicks call applyTheme()
// which persists, updates <html data-theme>, and notifies listeners.

import * as webjsx from '../../vendor/webjsx/index.js';
import { applyTheme, getTheme, resolvedTheme, onThemeChange } from '../theme.js';

const h = webjsx.createElement;

const MODES = [
    ['auto',  'auto'],
    ['paper', 'light'],
    ['ink',   'dark'],
];

// Track instances so an OS-theme change while in 'auto' re-renders the
// glyph in the compact variant (the segmented variant doesn't need it).
const refresh = new Set();
let _bound = false;
function bindOnce() {
    if (_bound) return;
    _bound = true;
    onThemeChange(() => { for (const cb of refresh) cb(); });
}

export function ThemeToggle({ compact = false, onChange } = {}) {
    bindOnce();
    const current = getTheme();

    if (compact) {
        // Plain words only - 'ink'/'paper' are internal theme codenames a user
        // never chose; the resolved scheme rides in the title, not the label.
        const resolvedWord = resolvedTheme() === 'ink' ? 'dark' : 'light';
        const word = current === 'auto' ? 'auto' : (current === 'ink' ? 'dark' : 'light');
        const label = 'theme: ' + word;
        return h('button', {
            class: 'btn ds-theme-toggle',
            type: 'button',
            'aria-label': label,
            title: label + (current === 'auto' ? ' (currently ' + resolvedWord + ')' : '') + ' — click to cycle',
            onclick: () => {
                const next = current === 'auto' ? 'paper' : (current === 'paper' ? 'ink' : 'auto');
                applyTheme(next);
                if (onChange) try { onChange(next); } catch { /* swallow: consumer onChange callback must not break the toggle */ }
            }
        },
        // CSS-drawn half-disc so the control still reads as the theme switch
        // when the label is hidden (icon-only rail strip).
        h('span', { class: 'ds-theme-disc', 'aria-hidden': 'true' }),
        h('span', { class: 'ds-theme-toggle-label' }, label));
    }

    return h('div', {
        class: 'ds-theme-toggle ds-segmented',
        role: 'radiogroup',
        'aria-label': 'theme'
    }, ...MODES.map(([mode, label]) =>
        h('button', {
            key: mode,
            type: 'button',
            role: 'radio',
            'aria-checked': current === mode ? 'true' : 'false',
            class: 'ds-seg-btn' + (current === mode ? ' is-on' : ''),
            onclick: () => {
                applyTheme(mode);
                if (onChange) try { onChange(mode); } catch { /* swallow: consumer onChange callback must not break the toggle */ }
            }
        }, label)
    ));
}
