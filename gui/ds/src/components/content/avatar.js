// Avatar — generic identity disc: an image when `src` resolves, else a
// letter fallback derived from `name`/`fallback`. Kit previously only had
// scoped one-offs (chat.js `.chat-avatar`, community.js `.cm-user-avatar`)
// duplicating this same letter-fallback logic; this is the reusable version.

import * as webjsx from '../../../vendor/webjsx/index.js';
const h = webjsx.createElement;

// avatarInitial — the single shared letter-fallback computation behind
// Avatar and every custom-colored avatar wrapper (community.js's voice/user/
// member rows use their own `--avatar-bg` CSS-variable styling and can't
// drop in the Avatar element directly, but still want the SAME fallback
// text, not their own independently-drifting .slice(0,n).toUpperCase()).
// Empty-guards to '?' identically everywhere it's used.
export function avatarInitial(name, count = 1) {
    return name ? String(name).trim().slice(0, count).toUpperCase() || '?' : '?';
}

// Avatar — the single letter-fallback/image avatar primitive. `initialsCount`
// (default 1) controls how many leading characters of `name` become the
// fallback letters when no `src`/`fallback` is given (community.js's
// pill-shaped ServerIcon wants 2); `shape` ('circle' default, or 'square')
// covers non-circular consumers without each hand-rolling its own
// .slice(0,n).toUpperCase() (previously duplicated across 5+ call sites in
// community.js and chat.js with drifting char-counts/empty-guards).
export function Avatar({ name, src, fallback, size = 'md', shape = 'circle', initialsCount = 1, key } = {}) {
    const letter = fallback != null ? fallback : avatarInitial(name, initialsCount);
    const cls = 'ds-avatar ds-avatar-' + size + (shape === 'square' ? ' ds-avatar-square' : '');
    if (src) return h('img', { key, class: cls, src, alt: name || '', loading: 'lazy' });
    return h('span', { key, class: cls, 'aria-hidden': !!name, role: name ? 'img' : undefined, 'aria-label': name || undefined }, letter);
}
