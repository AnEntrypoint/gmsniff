// Chrome: Topbar, Crumb, Side, Status, AppShell, plus primitives
// (Brand, Chip, Btn, Glyph, Heading, Lede). Pure factories — props in,
// webjsx vnode out. CSS in app-shell.css uses these class names.

import * as webjsx from '../../vendor/webjsx/index.js';
import { trapTab } from './overlay-primitives.js';
const h = webjsx.createElement;

/**
 * The wordmark used in Topbar/AppShell headers.
 *
 * @param {Object} [props]
 * @param {string} [props.name='247420'] - the brand text.
 * @param {*} [props.leaf] - optional trailing breadcrumb-style leaf, rendered after a " / " separator.
 * @returns {*} webjsx vnode
 */
export function Brand({ name = '247420', leaf } = {}) {
    return h('span', { class: 'brand' }, name,
        leaf ? h('span', { class: 'slash' }, ' / ') : null,
        leaf || null);
}

/**
 * A small pill/tag label.
 *
 * @param {Object} props
 * @param {string} [props.tone=''] - semantic color tone (empty = neutral).
 * @param {'sm'|'md'|'lg'} [props.size='md']
 * @param {boolean} [props.tag=false] - true renders a rectangular sentence-case variant for dense data (drops the all-caps pill styling). Orthogonal to tone.
 * @param {*} props.children
 * @returns {*} webjsx vnode
 */
export function Chip({ tone = '', size = 'md', tag = false, children }) {
    const sizeCls = size === 'sm' ? ' chip--sm' : (size === 'lg' ? ' chip--lg' : '');
    return h('span', { class: 'chip' + sizeCls + (tag ? ' chip--tag' : '') + (tone ? ' tone-' + tone : '') }, children);
}

/**
 * The standard button/link factory. Renders an `<a>` when `href` is given,
 * otherwise a `<button>`.
 *
 * @param {Object} props
 * @param {string} [props.href] - if present, renders as a link instead of a button.
 * @param {'default'|'primary'|'ghost'|'danger'} [props.variant='default']
 * @param {'sm'|'md'|'lg'} [props.size='md']
 * @param {*} props.children
 * @param {Function} [props.onClick]
 * @param {string} [props['aria-label']]
 * @param {boolean} [props.primary] - legacy alias for variant:'primary', kept for backward compatibility.
 * @param {boolean} [props.ghost] - legacy alias for variant:'ghost'.
 * @param {boolean} [props.danger] - legacy alias for variant:'danger'.
 * @param {boolean} [props.disabled]
 * @param {string} [props.class] - extra class name(s) appended to the generated class list.
 * @param {*} [props.key]
 * @returns {*} webjsx vnode
 */
export function Btn({ href, variant = 'default', size = 'md', children, onClick, 'aria-label': ariaLabel, primary, ghost, danger, disabled, class: className, key }) {
    // Support legacy primary/ghost props for backward compatibility, but prefer variant
    const resolvedVariant = variant !== 'default' ? variant : (primary ? 'primary' : (ghost ? 'ghost' : (danger ? 'danger' : 'default')));
    // size: 'sm' | 'md' | 'lg' — md is the base .btn rule (no class); sm/lg add a
    // modifier that snaps height/padding/font to the --ctl-* ladder. Unknown
    // sizes fall back to md so a typo never drops the button's base styling.
    const sizeCls = size === 'sm' ? ' btn-sm' : (size === 'lg' ? ' btn-lg' : '');
    const cls = (resolvedVariant === 'primary' ? 'btn-primary' : (resolvedVariant === 'ghost' ? 'btn-ghost' : (resolvedVariant === 'danger' ? 'btn-primary danger' : 'btn')))
        + sizeCls
        + (disabled ? ' is-disabled' : '')
        + (className ? ' ' + className : '');
    const onclick = (e) => {
        if (disabled) { e.preventDefault(); return; }
        if (onClick) onClick(e);
    };
    const ariaName = ariaLabel || (typeof children === 'string' ? children : undefined);

    // A real navigational href renders an anchor; everything else is an action
    // button and renders a native <button> (correct semantics + keyboard
    // activation for free, no role=button / href="#" scroll-jump hack).
    // children may be a string OR an array of vnodes (e.g. icon + label); spread
    // arrays so each vnode is a real child - passing the array as a single child
    // produces a nested array webjsx applyDiff cannot key-diff (reading 'key').
    const kids = Array.isArray(children) ? children : [children];
    const isLink = href != null && href !== '' && href !== '#';
    if (isLink) {
        return h('a', {
            key,
            class: cls, href,
            'aria-label': ariaName,
            'aria-disabled': disabled ? 'true' : null,
            tabindex: disabled ? '-1' : null,
            onclick
        }, ...kids);
    }
    return h('button', {
        key,
        type: 'button', class: cls,
        disabled: disabled ? true : null,
        'aria-label': ariaName,
        onclick
    }, ...kids);
}

export function IconButton({ icon, onClick, title, size = 'base', variant = 'ghost', disabled = false }) {
    const cls = 'ds-icon-btn ds-icon-btn-' + variant + ' ds-icon-btn-' + size + (disabled ? ' is-disabled' : '');
    return h('button', {
        type: 'button',
        class: cls,
        title,
        'aria-label': title,
        disabled: disabled ? true : null,
        onclick: (e) => { if (disabled) { e.preventDefault(); return; } if (onClick) onClick(e); }
    }, Glyph({ children: icon, size }));
}

export function Badge({ children, variant = 'default', tone = 'neutral', size = 'md' }) {
    // size: 'sm' | 'md' | 'lg' — md is the base 18px badge.
    const sizeCls = size === 'sm' ? ' ds-badge--sm' : (size === 'lg' ? ' ds-badge--lg' : '');
    return h('span', { class: 'ds-badge ds-badge-' + variant + sizeCls + ' tone-' + tone }, children);
}

// Pill — plain non-interactive label chip for tag-like annotations (a phase
// name, an id, a subsystem tag). Distinct from Chip (status-tone indicator),
// Badge (count/variant marker), and FilterPills (interactive toggle-group):
// Pill renders no button, carries no pressed/active state, just a small
// rounded label. tone is a semantic keyword ('' | 'accent' | 'muted'),
// never a raw color — every visual rides colors_and_type.css tokens.
export function Pill({ tone = '', children, key } = {}) {
    return h('span', { key, class: 'ds-pill' + (tone ? ' tone-' + tone : '') }, children);
}

export function Glyph({ children, color, size = 'base', label } = {}) {
    // Font-size is var-driven per size class (--glyph-size-{size}) so themes can
    // retune glyph scale; inline fallback keeps sizing if the SDK CSS hasn't
    // loaded yet. Size class is the stable hook (glyph-sm / glyph-base / glyph-lg).
    const fallback = size === 'sm' ? '11px' : (size === 'lg' ? '16px' : '13px');
    const cls = 'glyph glyph-' + size;
    const style = `font-size:var(--glyph-size-${size}, ${fallback})` + (color ? `;color:${color}` : '');
    // Decorative by default (screen readers skip the glyph char). Pass `label`
    // to expose an accessible name instead.
    return h('span', label
        ? { class: cls, style, role: 'img', 'aria-label': label }
        : { class: cls, style, 'aria-hidden': 'true' }, children);
}

// Monochrome inline-SVG icons (stroke=currentColor) so chrome reads as one
// coherent line-icon set instead of multicolor OS emoji. 16px box, 1.6 stroke.
export const ICON_PATHS = {
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    mic: '<path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    'mic-off': '<path d="M9 9v2a3 3 0 0 0 4.5 2.6M15 11V6a3 3 0 0 0-5.9-.8"/><path d="M5 11a7 7 0 0 0 11.5 5.4M12 18v3"/><path d="m4 4 16 16"/>',
    speaker: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
    'speaker-off': '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m17 9 4 6M21 9l-4 6"/>',
    camera: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
    screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    phone: '<path d="M5 4h3l2 5-2 1a11 11 0 0 0 5 5l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    members: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.7"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    paperclip: '<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0"/><path d="M9 9h.01M15 9h.01"/>',
    'more-horizontal': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 8a4 4 0 0 1 0 8M18 5a8 8 0 0 1 0 14"/>',
    forum: '<path d="M4 5h13a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
    page: '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5M8 13h8M8 17h6"/>',
    thread: '<path d="M5 6h14M5 11h14M5 16h8"/><circle cx="17" cy="17" r="3"/>',
    // status / control icons (replace decorative text glyphs at the source)
    check: '<path d="M20 6 9 17l-5-5"/>',
    'check-check': '<path d="M18 6 7 17l-3-3"/><path d="m22 10-7.5 7.5L13 16"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m6 15 6-6 6 6"/>',
    'arrow-down': '<path d="M12 5v14M5 12l7 7 7-7"/>',
    'arrow-right': '<path d="M5 12h14M12 5l7 7-7 7"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    play: '<path d="M6 4v16l14-8z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    'circle-dot': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
    square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
    activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2-2.4 3.7M12 17h.01"/>',
    warn: '<path d="M10.3 4 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    // file-type icons (replace the FILE_GLYPHS unicode set)
    'file-pdf': '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
    'file-zip': '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M11 4v3M11 9v3M11 14v3"/>',
    'file-video': '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="m10 12 4 2.5L10 17z"/>',
    'file-audio': '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M9 17v-3l4-1v3"/><circle cx="8" cy="17" r="1"/><circle cx="12" cy="16" r="1"/>',
    'file-sheet': '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h8M12 11v8"/>',
    'file-code': '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="m10 12-2 2 2 2M14 12l2 2-2 2"/>',
    'file-text': '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h6"/>',
    file: '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
    pencil: '<path d="M4 20h4L19 9a2 2 0 0 0-3-3L5 17z"/><path d="M14 6l3 3"/>',
    'skip-forward': '<path d="M5 5v14l9-7z"/><path d="M19 5v14"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
    'external-link': '<path d="M14 4h6v6M20 4l-9 9M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/>',
    // theme-toggle icons (replace decorative sun/moon/contrast text glyphs)
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>',
    // file-browser icons (replace folder/file emoji + arrow glyphs in fs apps)
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'folder-open': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2H5l-2 9z"/><path d="M3 18l2-9h17l-2 9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    // density-picker icons (list / compact / thumbnail view modes)
    rows: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    'rows-tight': '<path d="M4 5h16M4 9h16M4 13h16M4 17h16"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    'file-image': '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><circle cx="9.5" cy="12.5" r="1.5"/><path d="M18 19l-4-4-3 3-2-2-3 3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M5 20h14"/>',
    'corner-up-left': '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v6"/>',
    // clipboard/copy — for the per-block code copy + message copy action, so the
    // copy affordance reads as copy, not the lined-document `page` glyph.
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    clipboard: '<rect x="8" y="4" width="8" height="4" rx="1"/><path d="M8 6H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2"/>'
};
// Raw-DOM consumers (no webjsx render in scope) need the SVG as a markup string
// rather than an h() vnode. Same path table, same viewBox/stroke contract as
// Icon(); use innerHTML = iconMarkup(name). Keeps the icon paths upstream so
// raw-DOM call sites never reintroduce decorative glyph literals.
// The single SVG attribute contract (viewBox/stroke/linecap…) shared by both
// the markup-string and the vnode renderers below, so the icon shape is defined
// once. Insertion order is the serialized attribute order iconMarkup emits.
function iconAttrs(name, size) {
    return {
        class: 'ds-icon ds-icon-' + name,
        width: String(size), height: String(size), viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 'var(--ds-icon-stroke, 1.6)',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    };
}
// Normalize the (name) | ({name,size}) call shapes both renderers accept.
function iconArgs(name, size) {
    if (name && typeof name === 'object') ({ name, size = 16 } = name);
    return { name, size };
}
// Raw-DOM consumers (no webjsx render in scope) need the SVG as a markup string
// rather than an h() vnode. Same path table + attr contract as Icon(); use
// innerHTML = iconMarkup(name). Keeps the icon paths upstream so raw-DOM call
// sites never reintroduce decorative glyph literals.
export function iconMarkup(name, { size = 16 } = {}) {
    ({ name, size } = iconArgs(name, size));
    const inner = ICON_PATHS[name];
    if (!inner) return '';
    const attrs = Object.entries(iconAttrs(name, size)).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<svg ${attrs}>${inner}</svg>`;
}
export function Icon(name, { size = 16 } = {}) {
    ({ name, size } = iconArgs(name, size));
    const inner = ICON_PATHS[name];
    if (!inner) return h('span', { class: 'glyph', 'aria-hidden': 'true' }, '');
    return h('svg', { ...iconAttrs(name, size), dangerouslySetInnerHTML: { __html: inner } });
}

export function Topbar({ brand = '247420', leaf = '', items = [], active = '', onNav, search } = {}) {
    return h('header', { class: 'app-topbar', role: 'banner' },
        Brand({ name: brand, leaf }),
        search ? h('label', { class: 'app-search' },
            h('span', { class: 'icon', 'aria-hidden': 'true' }, 'search'),
            // `search` is either a plain placeholder string (renders the
            // default uncontrolled input) or a caller-built VElement (has
            // .type/.props — e.g. a controlled <input> wired to app state)
            // rendered as-is. Stringifying a VElement into placeholder/
            // aria-label previously produced literal "[object Object]" text.
            (search && typeof search === 'object' && 'type' in search)
                ? search
                : h('input', { type: 'search', name: 'q', placeholder: search, 'aria-label': `search ${search}` })
        ) : null,
        h('nav', { 'aria-label': 'main navigation' }, ...items.map(([label, href]) => {
            const cleanLabel = String(label).replace(' ->', '');
            return h('a', {
                key: label,
                href,
                class: active === cleanLabel ? 'active' : '',
                'aria-current': active === cleanLabel ? 'page' : null,
                onclick: (e) => {
                    if (!String(href).startsWith('http') && onNav) {
                        e.preventDefault();
                        onNav(cleanLabel);
                    }
                }
            }, label);
        }))
    );
}

export function Crumb({ trail = [], leaf = '', right } = {}) {
    const parts = [];
    trail.forEach((t, i) => {
        parts.push(h('span', { key: 't' + i }, t));
        parts.push(h('span', { key: 's' + i, class: 'sep' }, '/'));
    });
    parts.push(h('span', { key: 'leaf', class: 'leaf' }, leaf));
    if (right) parts.push(h('span', { key: 'r', class: 'crumb-right' }, ...(Array.isArray(right) ? right : [right])));
    return h('div', { class: 'app-crumb' }, ...parts);
}

// ArrowUp/ArrowDown/Home/End move focus between sidebar links without
// altering tabindex -- every link stays naturally Tab-reachable (a plain
// link list, not a role=tablist), arrows are a same-list quick-nav shortcut
// layered on top, mirroring the roving-nav affordance Tabs already has
// (editor-primitives.js) but without roving-tabindex's activate-on-move
// semantics, since a nav link's "activation" is a real navigation the user
// should still choose deliberately with Enter/click.
function onSideLinkKeyDown(e) {
    let dir = 0;
    if (e.key === 'ArrowDown') dir = 1;
    else if (e.key === 'ArrowUp') dir = -1;
    else if (e.key === 'Home' || e.key === 'End') dir = e.key === 'Home' ? 'first' : 'last';
    else return;
    const side = e.currentTarget.closest('.app-side');
    if (!side) return;
    const links = Array.from(side.querySelectorAll('a'));
    const curIdx = links.indexOf(e.currentTarget);
    if (curIdx === -1) return;
    e.preventDefault();
    let nextIdx;
    if (dir === 'first') nextIdx = 0;
    else if (dir === 'last') nextIdx = links.length - 1;
    else nextIdx = (curIdx + dir + links.length) % links.length;
    const next = links[nextIdx];
    if (next) next.focus();
}

export function Side({ sections = [] } = {}) {
    return h('aside', { class: 'app-side', role: 'navigation', 'aria-label': 'sidebar navigation' }, ...sections.map(sec => {
        const groupId = 'side-group-' + String(sec.group).replace(/\W+/g, '-').toLowerCase();
        // Each section is a group labelled by its heading, so AT users hear the
        // heading as the group name instead of an orphan heading.
        return h('div', { class: 'app-side-group', key: sec.group, role: 'group', 'aria-labelledby': groupId },
            h('h2', { class: 'group', id: groupId }, sec.group),
            ...sec.items.map((item, i) => {
                const { glyph, label, href = '#', active, count, color, onClick } = item;
                const countLabel = (count != null && count !== 0 && count !== '0') ? ` (${count})` : '';
                return h('a', {
                    key: sec.group + i,
                    href,
                    class: active ? 'active' : '',
                    'aria-current': active ? 'page' : null,
                    'aria-label': label + countLabel,
                    onclick: onClick,
                    onkeydown: onSideLinkKeyDown
                },
                    glyph != null ? Glyph({ children: glyph, color }) : h('span', { class: 'glyph', 'aria-hidden': 'true' }),
                    h('span', {}, label),
                    (count != null && count !== 0 && count !== '0') ? h('span', { class: 'count', 'aria-hidden': 'true' }, String(count)) : null
                );
            })
        );
    }));
}

export function Status({ left = [], right = [] } = {}) {
    return h('footer', { class: 'app-status', role: 'contentinfo' },
        ...left.map((t, i) => h('span', { key: 'l' + i, class: 'item' }, t)),
        h('span', { key: 'spread', class: 'spread', 'aria-hidden': 'true' }),
        ...right.map((t, i) => h('span', { key: 'r' + i, class: 'item' }, t))
    );
}

// Toggle the sidebar drawer. Pure-DOM because AppShell is stateless chrome; the
// class lives on .app-body and is read by the @container(max-width:900px) query.
// `fromEl` scopes the toggle to the shell that owns the clicked control — without
// it, document.querySelector grabs the FIRST .app-body on the page, so a second
// dashboard instance (multiple thebird WM windows) would toggle the wrong drawer.
function toggleSide(open, fromEl) {
    const shell = (fromEl && fromEl.closest && fromEl.closest('.app')) || document;
    const body = shell.querySelector('.app-body');
    if (!body) return;
    const next = open != null ? open : !body.classList.contains('side-open');
    body.classList.toggle('side-open', next);
    const btn = shell.querySelector('.app-side-toggle');
    if (btn) btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    // Keyboard parity with toggleWsDrawer: Esc dismisses the drawer and Tab is
    // trapped inside it while it overlays the content behind the scrim.
    if (body._dsSideKey) { document.removeEventListener('keydown', body._dsSideKey); body._dsSideKey = null; }
    if (next) {
        const drawer = shell.querySelector('.app-side-shell');
        const focusable = drawer && drawer.querySelector('button, a, input, [tabindex]');
        if (focusable) try { focusable.focus(); } catch (_) { /* swallow: focus() can throw on a detached/hidden element, drawer still opens */ }
        const onKey = (e) => {
            if (e.key === 'Escape') { toggleSide(false, btn || body); if (btn) try { btn.focus(); } catch (_) { /* swallow: focus() can throw on a detached/hidden element */ } return; }
            if (drawer) trapTab(drawer, e);
        };
        body._dsSideKey = onKey;
        document.addEventListener('keydown', onKey);
    }
}

// Ref on the .app root: re-sync the toggle's aria-expanded from the live
// .side-open class (applyDiff re-renders reset the attribute to 'false'), and
// arm a ResizeObserver that closes a stuck-open drawer when the shell grows
// past the 900px container breakpoint (the drawer CSS stops applying there,
// but the class would otherwise persist and reappear on the next shrink).
function syncAppSide(el) {
    if (!el) return;
    const body = el.querySelector('.app-body');
    const btn = el.querySelector('.app-side-toggle');
    if (btn && body) btn.setAttribute('aria-expanded', body.classList.contains('side-open') ? 'true' : 'false');
    if (!el._dsSideRO && typeof ResizeObserver !== 'undefined') {
        el._dsSideRO = new ResizeObserver((entries) => {
            const w = entries[0] && entries[0].contentRect.width;
            const b = el.querySelector('.app-body');
            if (w > 900 && b && b.classList.contains('side-open')) toggleSide(false, el);
        });
        el._dsSideRO.observe(el);
    }
}

export function AppShell({ topbar, crumb, side, main, status, narrow } = {}) {
    const hasSide = Boolean(side);
    const sideNode = hasSide ? side : h('aside', { class: 'app-side', 'aria-hidden': 'true' });
    // Topbar and crumb used to stack as two separate chrome bars — a "double
    // title bar". When both are present, fold them into one sticky row:
    // brand + nav (topbar) and breadcrumb + right slot (crumb) share a single
    // band so the chrome reads as one bar, not two. Either prop alone still
    // renders on its own (consumers that pass only a topbar are unaffected).
    const chrome = (topbar && crumb)
        ? h('div', { class: 'app-chrome' }, topbar, crumb)
        : (topbar || crumb || null);
    return h('div', { class: 'app', ref: syncAppSide },
        h('a', { href: '#app-main', class: 'skip-link' }, 'skip to main content'),
        hasSide ? h('button', {
            class: 'app-side-toggle', type: 'button',
            'aria-label': 'toggle navigation', 'aria-expanded': 'false', 'aria-controls': 'app-side-shell',
            onclick: (e) => toggleSide(null, e.currentTarget),
        }, Icon('menu')) : null,
        chrome,
        h('div', { class: 'app-body' + (hasSide ? '' : ' no-side') },
            h('div', { class: 'app-side-scrim', 'aria-hidden': 'true', onclick: (e) => toggleSide(false, e.currentTarget) }),
            h('div', { class: 'app-side-shell', id: 'app-side-shell', onclick: (e) => { if (e.target.closest('a')) toggleSide(false, e.currentTarget); } }, sideNode),
            // tabindex=-1 so the skip-link (href="#app-main") actually moves
            // keyboard focus into the main region, not just scroll to it.
            h('main', { class: 'app-main' + (narrow ? ' narrow' : ''), id: 'app-main', tabindex: '-1' }, ...(Array.isArray(main) ? main : [main]))
        ),
        status || null
    );
}

// Toggle a named WorkspaceShell column (left rail or right pane). Pure-DOM like
// toggleSide: WorkspaceShell is stateless chrome, the collapsed class lives on
// .ws-shell and is read by both CSS and the toggle buttons' aria-expanded.
function toggleWs(which, fromEl) {
    // Scope to the shell owning the clicked control, like toggleSide — the
    // first-on-page querySelector toggles the WRONG shell with two instances.
    const shell = (fromEl && fromEl.closest && fromEl.closest('.ws-shell')) || document.querySelector('.ws-shell');
    if (!shell) return;
    const cls = which === 'pane' ? 'ws-pane-collapsed'
        : which === 'sessions' ? 'ws-sessions-collapsed'
        : 'ws-rail-collapsed';
    const nowCollapsed = shell.classList.toggle(cls);
    // Inline --ws-*-w beats the collapsed-class rule in the cascade, so a
    // persisted width would render a "collapsed" column 200-640px wide.
    if (nowCollapsed) shell.style.removeProperty('--ws-' + which + '-w');
    shell.querySelectorAll('.ws-' + which + '-toggle').forEach((btn) => {
        btn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        const nextLabel = nowCollapsed ? 'expand ' + which : 'collapse ' + which;
        btn.setAttribute('aria-label', nextLabel);
        btn.setAttribute('title', nextLabel);
    });
    try {
        localStorage.setItem('ds.ws.' + which, nowCollapsed ? 'collapsed' : 'open');
    } catch (_) { /* swallow: persistence is best-effort, collapse state still applies in-memory */ }
    // Expanding restores the persisted width (seed skips collapsed columns, so
    // it must run after the open flag is written).
    if (!nowCollapsed) seedWsWidths(shell);
}

// Column resize: read the current rendered track width and write a clamped inline
// --ws-<col>-w on .ws-shell (inline overrides the fluid clamp base), persisted.
// Floors match the CSS fluid clamp() floors in app-shell.css (--ws-rail-w
// clamp(200,16vw,260); sessions clamp(248,22vw,360); pane clamp(288,24vw,420))
// so a drag/arrow can never shrink a column below its designed minimum (the
// collapsed rail is a SEPARATE class, not a resize target). The ceilings are
// INTENTIONALLY raised above the fluid clamp() mid-term ceilings: on wide
// viewports the 16/22/24vw mid term already pins each column to its clamp
// ceiling, so a ceiling-equals-clamp bound made the outward drag inert there.
// The higher resize ceilings let a deliberate drag/arrow grow a column past its
// auto-fluid width (the inline --ws-<col>-w override pins the chosen width past
// the clamp base).
const WS_RESIZE_CLAMP = { rail: [200, 320], sessions: [248, 520], pane: [288, 640] };
function wsResize(col, dx, persist = true, fromEl) {
    const shell = (fromEl && fromEl.closest && fromEl.closest('.ws-shell')) || document.querySelector('.ws-shell');
    if (!shell) return;
    const track = shell.querySelector('.ws-' + col);
    const cur = track ? track.getBoundingClientRect().width : 0;
    const [lo, hi] = WS_RESIZE_CLAMP[col] || [120, 600];
    const next = Math.max(lo, Math.min(hi, Math.round(cur + dx)));
    shell.style.setProperty('--ws-' + col + '-w', next + 'px');
    const handle = shell.querySelector('.ws-resizer-' + col);
    if (handle) { handle.setAttribute('aria-valuenow', String(next)); handle.setAttribute('aria-valuetext', next + ' pixels'); }
    // Commit to storage only on a settled move (pointerup / keyboard), not on
    // every pointermove frame (that fired dozens of synchronous writes per drag).
    if (persist) { try { localStorage.setItem('ds.ws.w.' + col, String(next)); } catch (_) { /* swallow: persistence is best-effort, resize still applies in-memory */ } }
}
// Per-column viewport caps for persisted widths: a width dragged on a wide
// monitor must not crush the content column when the page reloads on a
// narrower screen (rail 320 + sessions 520 would leave ~180px of content).
const WS_VW_CAP = { rail: '20vw', sessions: '30vw', pane: '32vw' };
function seedWsWidths(el) {
    if (!el) return;
    ['rail', 'sessions', 'pane'].forEach((col) => {
        try {
            // A persisted-collapsed column must stay collapsed: the inline var
            // would beat the .ws-*-collapsed class rule in the cascade.
            if (wsCollapsed(col, false)) return;
            const v = localStorage.getItem('ds.ws.w.' + col);
            if (v && /^\d+$/.test(v)) el.style.setProperty('--ws-' + col + '-w', `min(${v}px, ${WS_VW_CAP[col]})`);
        } catch (_) { /* swallow: localStorage unavailable, seeding is best-effort */ }
    });
}
function WsResizer(col) {
    const onKey = (e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); wsResize(col, -16, true, e.currentTarget); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); wsResize(col, 16, true, e.currentTarget); }
    };
    const onDown = (e) => {
        e.preventDefault();
        const handleEl = e.currentTarget;
        let lastX = e.clientX;
        const move = (ev) => { const dx = ev.clientX - lastX; lastX = ev.clientX; wsResize(col, dx, false, handleEl); };
        const up = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            document.body.style.cursor = '';
            wsResize(col, 0, true, handleEl); // commit the settled width once
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        document.body.style.cursor = 'col-resize';
    };
    const [lo, hi] = WS_RESIZE_CLAMP[col] || [120, 600];
    // Seed aria-valuenow from the rendered track width so AT announces real widths.
    const seedNow = (el) => {
        if (!el) return;
        const track = el.closest('.ws-shell') && el.closest('.ws-shell').querySelector('.ws-' + col);
        if (track) { const w = Math.round(track.getBoundingClientRect().width); el.setAttribute('aria-valuenow', String(w)); el.setAttribute('aria-valuetext', w + ' pixels'); }
    };
    return h('div', {
        class: 'ws-resizer ws-resizer-' + col, role: 'separator', tabindex: '0',
        'aria-orientation': 'vertical', 'aria-label': 'resize ' + col + ' column (arrow keys)',
        'aria-valuemin': String(lo), 'aria-valuemax': String(hi), 'aria-valuetext': String(hi) + ' pixels',
        onpointerdown: onDown, onkeydown: onKey, ref: seedNow,
    });
}

// Toggle a mobile WorkspaceShell DRAWER (sessions or pane). Distinct from the
// desktop width-collapse (toggleWs): on mobile the columns are fixed overlays
// revealed by .ws-sessions-open / .ws-pane-open. Opening one closes the other
// (only one drawer at a time over the content). Esc + scrim dismiss call this
// with open=false. Pure-DOM, matching the AppShell toggleSide pattern.
function toggleWsDrawer(which, open, fromEl) {
    const shell = (fromEl && fromEl.closest && fromEl.closest('.ws-shell')) || document.querySelector('.ws-shell');
    if (!shell) return;
    const cls = which === 'pane' ? 'ws-pane-open' : 'ws-sessions-open';
    const other = which === 'pane' ? 'ws-sessions-open' : 'ws-pane-open';
    const next = open != null ? open : !shell.classList.contains(cls);
    shell.classList.toggle(cls, next);
    if (next) shell.classList.remove(other);
    const btn = shell.querySelector('.ws-' + which + '-drawer-toggle');
    if (btn) btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (!next) { removeWsDrawerHandlers(shell); return; }
    // When opening, move focus into the drawer, arm an Esc-to-close, and trap
    // Tab/Shift+Tab inside the drawer (a real focus trap, matching the kit's
    // own dialogs - Tab from inside an open drawer previously walked focus out
    // into the scrim/background content behind it).
    const drawer = shell.querySelector(which === 'pane' ? '.ws-pane' : '.ws-sessions');
    const focusable = drawer && drawer.querySelector('button, a, input, [tabindex]');
    if (focusable) try { focusable.focus(); } catch (_) { /* swallow: focus() can throw on a detached/hidden element, drawer still opens */ }
    removeWsDrawerHandlers(shell); // replace, never stack (opening one drawer over the other)
    const onKey = (e) => {
        if (e.key === 'Escape') { toggleWsDrawer(which, false, shell); if (btn) try { btn.focus(); } catch (_) { /* swallow: focus() can throw on a detached/hidden element */ } return; }
        if (drawer) trapTab(drawer, e);
    };
    shell._wsEscHandler = onKey;
    document.addEventListener('keydown', onKey);
    // The drawer CSS stops applying above its breakpoint; auto-close when the
    // viewport grows past it so the open class and armed Esc/focus-trap
    // handlers do not linger invisibly in desktop layout.
    const mq = window.matchMedia('(max-width: 1480px)');
    const onMq = () => { if (!mq.matches) closeWsDrawers(shell); };
    shell._wsDrawerMq = { mq, onMq };
    mq.addEventListener('change', onMq);
}
function removeWsDrawerHandlers(shell) {
    // Remove Esc/focus-trap handler armed by toggleWsDrawer (prevents ghost
    // close on next Esc) and the viewport-growth auto-close listener.
    if (shell._wsEscHandler) { document.removeEventListener('keydown', shell._wsEscHandler); shell._wsEscHandler = null; }
    if (shell._wsDrawerMq) { shell._wsDrawerMq.mq.removeEventListener('change', shell._wsDrawerMq.onMq); shell._wsDrawerMq = null; }
}
function closeWsDrawers(fromEl) {
    const shell = (fromEl && fromEl.closest && fromEl.closest('.ws-shell')) || document.querySelector('.ws-shell');
    if (!shell) return;
    shell.classList.remove('ws-sessions-open', 'ws-pane-open');
    shell.querySelectorAll('.ws-sessions-drawer-toggle, .ws-pane-drawer-toggle').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    removeWsDrawerHandlers(shell);
}

// Read persisted collapse state for a WorkspaceShell column so the layout is
// predictable across reloads (Claude-Desktop keeps the rail where you left it).
function wsCollapsed(which, fallback) {
    try {
        const v = localStorage.getItem('ds.ws.' + which);
        if (v === 'collapsed') return true;
        if (v === 'open') return false;
    } catch (_) { /* swallow: localStorage unavailable, fall back to caller-supplied default */ }
    return !!fallback;
}

/**
 * A Claude-Desktop / cowork three-(or four-)column app shell.
 *
 * Pure stateless chrome (props in, vnode out). Collapse is DOM-class + a
 * persisted flag, so the host does not have to thread collapse state through
 * its own store. Visual styling lives in app-shell.css (.ws-*).
 *
 * @param {Object} props
 * @param {*} props.rail - the persistent left workspace nav (icon+label items, collapsible to icon-only). Pass the result of WorkspaceRail() or any vnode.
 * @param {*} props.sessions - an OPTIONAL second column (a conversation/session list) shown between the rail and the main content. Null hides it.
 * @param {*} props.main - the primary content column (chat thread, files view, dashboard...).
 * @param {*} props.pane - an OPTIONAL right context pane (per-conversation context, file preview...). Null hides it; collapsible when present.
 * @param {*} props.crumb - an optional thin top chrome bar (breadcrumb + status), spanning the content area only (the rail has its own header).
 * @param {*} props.status - an optional footer.
 * @param {boolean} props.narrow - caller's isNarrow() — drives the mobile single-column collapse.
 * @param {boolean} props.railCollapsed - initial rail collapse (persisted state wins).
 * @param {boolean} props.paneCollapsed - initial pane collapse (persisted state wins).
 * @returns {*} webjsx vnode
 */
export function WorkspaceShell({ rail, sessions, main, pane, crumb, status, narrow,
                                 railCollapsed = false, paneCollapsed = false,
                                 railLabel = 'workspace navigation',
                                 paneLabel = 'context', stableFrame = false, mainFlush = false } = {}) {
    const hasSessions = Boolean(sessions);
    const hasPane = Boolean(pane);
    // Stable frame: keep the pane grid TRACK present even when this tab has no
    // pane, so the shell does not re-flow its column count (4/3/2) on every tab
    // switch - the loudest "separate pages" tell. The track collapses to width 0
    // (ws-pane-collapsed) instead of being removed (ws-no-pane), so chat/history/
    // files/live/settings all keep the same column geometry. The sessions column
    // gets the identical treatment (ws-sessions-collapsed instead of ws-no-sessions)
    // so files/live/settings do not shift the main column when sessions is null.
    const keepPaneTrack = stableFrame && !hasPane;
    const keepSessionsTrack = stableFrame && !hasSessions;
    const railIsCollapsed = wsCollapsed('rail', railCollapsed);
    const paneIsCollapsed = hasPane ? wsCollapsed('pane', paneCollapsed) : true;
    const sessionsIsCollapsed = hasSessions ? wsCollapsed('sessions', false) : true;
    const shellCls = 'ws-shell'
        + (railIsCollapsed ? ' ws-rail-collapsed' : '')
        + ((hasPane || keepPaneTrack) ? '' : ' ws-no-pane')
        + (((hasPane && paneIsCollapsed) || keepPaneTrack) ? ' ws-pane-collapsed' : '')
        + ((hasSessions || keepSessionsTrack) ? '' : ' ws-no-sessions')
        + (((hasSessions && sessionsIsCollapsed) || keepSessionsTrack) ? ' ws-sessions-collapsed' : '')
        + (narrow ? ' narrow' : '');
    return h('div', { class: shellCls, ref: seedWsWidths },
        h('a', { href: '#ws-main', class: 'skip-link' }, 'skip to main content'),
        // Left rail column. Its own toggle collapses it to icon-only.
        h('nav', { class: 'ws-rail', role: 'navigation', 'aria-label': railLabel },
            h('button', {
                class: 'ws-rail-toggle', type: 'button',
                // Label reflects the ACTION the click performs (expand when
                // collapsed, collapse when expanded), not a static word - a
                // stale "collapse navigation" on an already-collapsed rail
                // mis-announces the control to AT.
                'aria-label': railIsCollapsed ? 'expand navigation' : 'collapse navigation',
                title: railIsCollapsed ? 'expand navigation' : 'collapse navigation',
                'aria-expanded': railIsCollapsed ? 'false' : 'true',
                onclick: (e) => toggleWs('rail', e.currentTarget),
            }, Icon('menu')),
            rail || null),
        // Tap-scrim behind an open mobile drawer; click anywhere dismisses.
        h('div', { class: 'ws-scrim', 'aria-hidden': 'true', onclick: (e) => closeWsDrawers(e.currentTarget) }),
        // Optional sessions column. On mobile it is a drawer; selecting a row
        // (any button click inside) auto-closes it, mirroring AppShell.
        hasSessions
            ? h('div', { id: 'ws-sessions-col', class: 'ws-sessions', role: 'complementary', 'aria-label': 'conversations',
                // Drawer mode is detected by geometry (position:fixed only holds
                // in drawer mode), not window.innerWidth - the shell may live in
                // an embedded window narrower than the viewport.
                onclick: (e) => {
                    const col = e.currentTarget;
                    if (getComputedStyle(col).position === 'fixed' && e.target.closest('button, a, [role="button"]')) closeWsDrawers(col);
                } }, sessions)
            : null,
        // Primary content column, with an optional thin crumb bar on top. On
        // mobile the crumb hosts the drawer toggles (sessions on the left, pane
        // on the right) so both overlay columns are reachable - without them the
        // conversation list and context pane are dead on <=900px.
        h('div', { class: 'ws-content' },
            crumb
                ? h('div', { class: 'ws-crumb' },
                    hasSessions ? h('button', {
                        class: 'ws-drawer-toggle ws-sessions-drawer-toggle', type: 'button',
                        'aria-label': 'toggle conversations', 'aria-expanded': 'false',
                        'aria-controls': 'ws-sessions-col',
                        onclick: (e) => toggleWsDrawer('sessions', null, e.currentTarget),
                    }, Icon('thread')) : null,
                    // Desktop-only sessions collapse (reclaims its width for a
                    // full-width thread/grid). Hidden on mobile via CSS.
                    hasSessions ? h('button', {
                        class: 'ws-desktop-toggle ws-sessions-toggle', type: 'button',
                        'aria-label': sessionsIsCollapsed ? 'expand conversations' : 'collapse conversations',
                        title: sessionsIsCollapsed ? 'expand conversations' : 'collapse conversations',
                        'aria-expanded': sessionsIsCollapsed ? 'false' : 'true', onclick: (e) => toggleWs('sessions', e.currentTarget),
                    }, Icon(sessionsIsCollapsed ? 'chevron-right' : 'chevron-left')) : null,
                    h('div', { class: 'ws-crumb-main' }, crumb),
                    // Desktop-only context-pane collapse, on the same crumb-level
                    // chrome idiom as the sessions toggle. Hidden on mobile via CSS.
                    hasPane ? h('button', {
                        class: 'ws-desktop-toggle ws-pane-toggle', type: 'button',
                        'aria-label': paneIsCollapsed ? 'show context pane' : 'hide context pane',
                        title: paneIsCollapsed ? 'show context pane' : 'hide context pane',
                        'aria-expanded': paneIsCollapsed ? 'false' : 'true',
                        onclick: (e) => toggleWs('pane', e.currentTarget),
                    }, Icon(paneIsCollapsed ? 'chevron-left' : 'chevron-right')) : null,
                    hasPane ? h('button', {
                        class: 'ws-drawer-toggle ws-pane-drawer-toggle', type: 'button',
                        'aria-label': 'toggle context pane', 'aria-expanded': 'false',
                        'aria-controls': 'ws-pane-col',
                        onclick: (e) => toggleWsDrawer('pane', null, e.currentTarget),
                    }, Icon('page')) : null)
                : null,
            h('main', { class: 'ws-main' + (narrow ? ' narrow' : '') + (mainFlush ? ' ws-main--flush' : ''), id: 'ws-main', tabindex: '-1' },
                ...(Array.isArray(main) ? main : [main])),
            status || null),
        // Optional right context pane. Its desktop collapse toggle now lives in
        // the crumb cluster, alongside the sessions toggle.
        hasPane
            ? h('aside', { id: 'ws-pane-col', class: 'ws-pane', role: 'complementary', 'aria-label': paneLabel },
                pane)
            : null,
        // Keyboard/pointer column resize handles (desktop only).
        (!narrow && !railIsCollapsed) ? WsResizer('rail') : null,
        (!narrow && (hasSessions || keepSessionsTrack) && !sessionsIsCollapsed) ? WsResizer('sessions') : null,
        (!narrow && (hasPane || keepPaneTrack) && !paneIsCollapsed) ? WsResizer('pane') : null,
    );
}

// WorkspaceRail — the contents of the WorkspaceShell left rail: a brand/header,
// a primary action (New chat), and a list of nav items. Each item collapses to
// an icon when the rail is collapsed (the label is kept in the DOM for AT and
// shown via CSS when expanded).
//
//   brand   : short product name shown in the rail header.
//   action  : { label, icon, onClick } a prominent primary button (New chat).
//   items   : [{ key, label, icon, active, count, rail, onClick }] nav entries.
//             `rail` (optional tone e.g. 'flame') paints an attention dot on the
//             item — used when something in that surface needs the user's eyes
//             even though they are looking at a different tab (e.g. a live
//             session in error while the user is in Chat).
//   footer  : optional vnode pinned to the rail bottom (e.g. settings/theme).
export function WorkspaceRail({ brand = '247420', action, items = [], footer } = {}) {
    return h('div', { class: 'ws-rail-inner' },
        h('div', { class: 'ws-rail-head' },
            h('span', { class: 'ws-rail-brand' }, brand)),
        action
            ? h('button', {
                class: 'ws-rail-action', type: 'button',
                'aria-label': action.label,
                onclick: action.onClick || null,
            }, action.icon ? Icon(action.icon) : null, h('span', { class: 'ws-rail-action-label' }, action.label))
            : null,
        h('ul', { class: 'ws-rail-nav', role: 'list' },
            ...items.map((it) => h('li', { key: it.key || it.label, role: 'listitem' },
                h('button', {
                    type: 'button',
                    class: 'ws-rail-item' + (it.active ? ' active' : '') + (it.rail ? ' has-rail-flag' : ''),
                    'aria-current': it.active ? 'page' : null,
                    'aria-label': it.label + (it.count ? ' (' + it.count + ')' : '') + (it.rail === 'flame' ? ', needs attention' : ''),
                    title: it.label,
                    onclick: it.onClick || null,
                },
                    it.icon ? Icon(it.icon) : h('span', { class: 'ws-rail-item-glyph', 'aria-hidden': 'true' }),
                    h('span', { class: 'ws-rail-item-label' }, it.label),
                    (it.count != null && it.count !== 0 && it.count !== '0')
                        ? h('span', { class: 'ws-rail-item-count', 'aria-hidden': 'true' }, String(it.count))
                        : null,
                    it.rail ? h('span', { class: 'ws-rail-item-flag tone-' + it.rail, 'aria-hidden': 'true' }) : null)))),
        footer ? h('div', { class: 'ws-rail-foot' }, footer) : null,
    );
}

export function Heading({ level = 1, children, style = '', class: className = '', 'aria-level': ariaLevel }) {
    return h('h' + level, { class: className || null, style, 'aria-level': ariaLevel != null ? String(ariaLevel) : null }, children);
}

export function Lede({ children }) {
    return h('p', { class: 'lede' }, children);
}

export function Dot({ tone = 'on' }) {
    const isOn = tone === 'on' || tone === 'live';
    const cls = 'ds-dot ' + (isOn ? 'ds-dot-on' : 'ds-dot-off');
    const statusLabel = isOn ? 'on status indicator' : 'off status indicator';
    // Drawn as a CSS circle (.ds-dot) — no decorative text glyph.
    return h('span', { class: cls, role: 'img', 'aria-label': statusLabel });
}

export function Rail({ tone = 'green' }) {
    return h('span', { class: 'ds-rail tone-' + tone, 'aria-hidden': 'true' });
}
