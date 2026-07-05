// 247420 design system — theme controller.
//
// Theme modes (data-theme):
//   'auto'    — follow OS (prefers-color-scheme). Live-updates on OS change.
//   'paper'   — force light.
//   'ink'     — force dark.
//   'thebird' — warm-paper brand preset (named theme).
// Accents (data-accent): 'green' | 'purple' | 'mascot'.
// Density (data-density): 'compact' | 'comfortable' | 'spacious'.
//
// Each is one attribute on <html> the canonical theme (colors_and_type.css)
// reads. Adding a theme = one [data-theme="X"] block in colors_and_type.css
// plus its name in THEMES below. Persists to localStorage; auto-inits on
// browser import; safe no-op on server.

const KEY = '247420:theme';
const ACCENT_KEY = '247420:accent';
const DENSITY_KEY = '247420:density';
// 'auto' is a mode, not a [data-theme] preset block — it stays in VALID for the
// controller but is the OS-follow path. The named presets are the rest.
const VALID = new Set(['auto', 'paper', 'ink', 'thebird']);
const VALID_ACCENT = new Set(['green', 'purple', 'mascot']);
const VALID_DENSITY = new Set(['compact', 'comfortable', 'spacious']);
const listeners = new Set();
let _mq = null;
let _current = 'auto';

function isBrowser() {
    return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function readStored() {
    try {
        const v = window.localStorage.getItem(KEY);
        return VALID.has(v) ? v : null;
    } catch { return null; }
}

function writeStored(mode) {
    try { window.localStorage.setItem(KEY, mode); } catch {}
}

function writeAttr(mode) {
    if (!isBrowser()) return;
    document.documentElement.setAttribute('data-theme', mode);
}

function ensureMq() {
    if (_mq || !isBrowser() || !window.matchMedia) return;
    _mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
        if (_current === 'auto') {
            // Re-emit so listeners can re-render derived UI even though
            // data-theme stays "auto" — the CSS @media handles the swap.
            for (const cb of listeners) {
                try { cb({ mode: 'auto', resolved: _mq.matches ? 'ink' : 'paper' }); } catch {}
            }
        }
    };
    if (_mq.addEventListener) _mq.addEventListener('change', onChange);
    else if (_mq.addListener) _mq.addListener(onChange);
}

export function applyTheme(mode) {
    if (!VALID.has(mode)) mode = 'auto';
    _current = mode;
    writeAttr(mode);
    writeStored(mode);
    ensureMq();
    const resolved = mode === 'auto'
        ? (_mq && _mq.matches ? 'ink' : 'paper')
        : mode;
    for (const cb of listeners) {
        try { cb({ mode, resolved }); } catch {}
    }
    return mode;
}

export function getTheme() {
    return _current;
}

export function resolvedTheme() {
    if (_current !== 'auto') return _current;
    ensureMq();
    return _mq && _mq.matches ? 'ink' : 'paper';
}

export function onThemeChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

// ---- Accent + density: independent attribute controllers ----

function readStoredKey(key, valid) {
    try { const v = window.localStorage.getItem(key); return valid.has(v) ? v : null; } catch { return null; }
}

export function applyAccent(accent) {
    if (!isBrowser()) return accent;
    if (VALID_ACCENT.has(accent)) {
        document.documentElement.setAttribute('data-accent', accent);
        try { window.localStorage.setItem(ACCENT_KEY, accent); } catch {}
    } else {
        // No accent attribute = the theme's default accent (green).
        document.documentElement.removeAttribute('data-accent');
        try { window.localStorage.removeItem(ACCENT_KEY); } catch {}
    }
    return accent;
}

export function getAccent() {
    if (!isBrowser()) return null;
    return document.documentElement.getAttribute('data-accent');
}

export function applyDensity(density) {
    if (!isBrowser()) return density;
    if (VALID_DENSITY.has(density)) {
        document.documentElement.setAttribute('data-density', density);
        try { window.localStorage.setItem(DENSITY_KEY, density); } catch {}
    }
    return density;
}

export function getDensity() {
    if (!isBrowser()) return null;
    return document.documentElement.getAttribute('data-density');
}

// Auto-init on browser import. Picks stored value, else falls back to
// whatever data-theme is already on <html> (set by page-html.js), else 'auto'.
export function initTheme() {
    if (!isBrowser()) return 'auto';
    const stored = readStored();
    const fromAttr = document.documentElement.getAttribute('data-theme');
    const initial = stored || (VALID.has(fromAttr) ? fromAttr : 'auto');
    applyTheme(initial);
    // Restore persisted accent/density (no-op if none stored — keeps the
    // theme's default accent and the page's authored density).
    const accent = readStoredKey(ACCENT_KEY, VALID_ACCENT);
    if (accent) applyAccent(accent);
    const density = readStoredKey(DENSITY_KEY, VALID_DENSITY);
    if (density) applyDensity(density);
    return initial;
}

if (isBrowser()) {
    // Run on next microtask so SSR-injected attributes settle first.
    Promise.resolve().then(() => { try { initTheme(); } catch {} });
}
