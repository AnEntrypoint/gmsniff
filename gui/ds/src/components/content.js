// Content blocks: Panel, Row, RowLink, Section, Hero, Install, Receipt,
// Changelog, WorksList, WritingList, Manifesto, Kpi, Table, HomeView,
// ProjectView, Form. Pure factories.

import * as webjsx from '../../vendor/webjsx/index.js';
import { Btn, Heading, Lede, Dot, Icon } from './shell.js';
const h = webjsx.createElement;

// Avatar — generic identity disc: an image when `src` resolves, else a
// letter fallback derived from `name`/`fallback`. Kit previously only had
// scoped one-offs (chat.js `.chat-avatar`, community.js `.cm-user-avatar`)
// duplicating this same letter-fallback logic; this is the reusable version.
export function Avatar({ name, src, fallback, size = 'md', key } = {}) {
    const letter = fallback != null ? fallback
        : (name ? String(name).trim().charAt(0).toUpperCase() || '?' : '?');
    const cls = 'ds-avatar ds-avatar-' + size;
    if (src) return h('img', { key, class: cls, src, alt: name || '', loading: 'lazy' });
    return h('span', { key, class: cls, 'aria-hidden': !!name, role: name ? 'img' : undefined, 'aria-label': name || undefined }, letter);
}

export function Panel({ title, count, right, style = '', class: className = '', children, kind, id }) {
    const cls = 'panel' + (kind ? ' panel-' + kind : '') + (className ? ' ' + className : '');
    return h('div', { class: cls, style, id: id || null },
        title != null ? h('div', { class: 'panel-head' },
            h('span', {}, title),
            right != null ? right : (count != null ? h('span', {}, String(count)) : null)
        ) : null,
        h('div', { class: 'panel-body' }, ...(Array.isArray(children) ? children : [children]))
    );
}

// Card — semantic alias of Panel; behaves identically.
export const Card = Panel;

// Split a title string around case-insensitive matches of `highlight`, wrapping
// hits in <mark class="ds-hl">. Every segment is a keyed span so the children
// array never mixes keyed VElements with bare strings (webjsx applyDiff crashes
// on mixed keying).
function highlightTitle(title, highlight) {
    const text = String(title);
    const needle = String(highlight).toLowerCase();
    if (!needle) return text;
    const lower = text.toLowerCase();
    const segs = [];
    let pos = 0, n = 0;
    while (pos <= text.length) {
        const hit = lower.indexOf(needle, pos);
        if (hit === -1) break;
        if (hit > pos) segs.push(h('span', { key: 'hs' + n++ }, text.slice(pos, hit)));
        segs.push(h('mark', { key: 'hs' + n++, class: 'ds-hl' }, text.slice(hit, hit + needle.length)));
        pos = hit + needle.length;
    }
    if (!segs.length) return text;
    if (pos < text.length) segs.push(h('span', { key: 'hs' + n++ }, text.slice(pos)));
    return segs;
}

export function Row({ code, rank, title, sub, meta, active, state = 'default', onClick, key, style, href, kind, cols, leading, trailing, target, selected, rail, expanded, highlight, actions, detail }) {
    // `rank` is an alias for `code` (the leading monospace index); callers use
    // either name. `rail` renders a thin colour bar at the row's leading edge as
    // a status indicator (tone: green | purple | flame | <any token>).
    const codeVal = code != null ? code : rank;
    // Support legacy active/selected props for backward compatibility
    const isActive = state === 'active' || (state === 'default' && (active || selected));
    const isLink = kind === 'link' || (href != null && !onClick);
    const isButton = !isLink && !!onClick;
    const stateCls = state === 'disabled' ? ' row-state-disabled' : (state === 'error' ? ' row-state-error' : '');
    // With no leading/code, the title would otherwise land in the narrow code
    // column and wrap; `row-nocode` collapses that column so the title gets the
    // full width (meta still pinned right).
    const noLead = codeVal == null && leading == null;
    const cls = 'row' + (isActive ? ' active' : '') + stateCls + (cols ? ' row-grid' : '') + (noLead && !cols ? ' row-nocode' : '') + (rail ? ' rail-' + rail : '');
    const isDisabled = state === 'disabled';
    const props = { key, class: cls, style: cols ? `${style ? style + ';' : ''}grid-template-columns:${cols}` : style };
    if (isLink) {
        props.href = href || '#';
        if (target) props.target = target;
    } else if (isButton && !isDisabled) {
        // Clickable div needs button semantics + keyboard activation for a11y parity.
        // A disabled row is inert: no click, no button role, no tab stop.
        props.onclick = onClick;
        props.role = 'button';
        props.tabindex = '0';
        props.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); }
        };
        // When the row is a disclosure toggle (host passes a boolean `expanded`),
        // announce its open/closed state so AT users hear "expanded/collapsed".
        // Omitted entirely for plain action buttons (expanded === undefined).
        if (expanded === true || expanded === false) props['aria-expanded'] = expanded ? 'true' : 'false';
    }
    if (isDisabled) props['aria-disabled'] = 'true';
    if (isActive && (isLink || isButton)) props['aria-current'] = isActive ? 'page' : null;
    // `highlight` wraps case-insensitive matches in the title in <mark class="ds-hl">.
    // The segments live inside a single wrapper span so the title's child list
    // never mixes keyed and unkeyed siblings.
    const titleNode = (highlight && typeof title === 'string')
        ? h('span', {}, ...[].concat(highlightTitle(title, highlight)))
        : title;
    // `actions` render ONLY when the row is expanded, as a sibling action strip
    // inside the row container; each button stops propagation so it never fires
    // the row onClick.
    const actionRow = (expanded === true && Array.isArray(actions) && actions.length)
        ? h('span', { class: 'row-actions', role: 'group', 'aria-label': 'row actions' },
            ...actions.map((a, i) => h('button', {
                key: 'ract' + i,
                type: 'button',
                class: 'row-act',
                title: a.title || a.label,
                'aria-label': a.title || a.label,
                onclick: (e) => { e.stopPropagation(); a.onClick && a.onClick(e); },
                onkeydown: (e) => { e.stopPropagation(); },
            }, a.label)))
        : null;
    // Color is not the only status channel: emit a visually-hidden word for the
    // meaningful rail tones (error/subagent) so AT and color-blind users get the
    // state. green is the unremarkable default - announcing "ok" everywhere would
    // be AT noise - so it emits nothing.
    const railWord = rail === 'flame' ? 'error' : rail === 'purple' ? 'subagent' : null;
    // `detail` renders as a sibling block AFTER the title/meta children (its own
    // line via flex-basis:100% in .ds-row-detail), not inside the title span.
    // The same `highlight` search term that marks matches in the collapsed
    // title previously stopped applying the moment a row expanded - the
    // expanded body (often the ONLY place a match beyond the 220-char title
    // window is actually visible) rendered as plain unmarked text.
    const detailNode = (highlight && typeof detail === 'string')
        ? h('span', {}, ...[].concat(highlightTitle(detail, highlight)))
        : detail;
    return h(isLink ? 'a' : 'div', props,
        railWord ? h('span', { class: 'sr-only' }, railWord) : null,
        leading != null ? leading : (codeVal != null ? h('span', { class: 'code' }, codeVal) : null),
        h('span', { class: 'title', title: typeof title === 'string' ? title : undefined }, titleNode, sub ? h('span', { class: 'sub', title: typeof sub === 'string' ? sub : undefined }, sub) : null),
        trailing != null ? trailing : (meta != null ? h('span', { class: 'meta' }, meta) : null),
        actionRow,
        detail != null ? h('pre', { class: 'ds-row-detail' }, detailNode) : null);
}

export function RowLink({ code, title, sub, meta, href = '#', key, target }) {
    return Row({ code, title, sub, meta, href, kind: 'link', key, target });
}

// PanelFromItems — the shared 'items[] -> RowLink wrapped in Panel' mapper
// every portfolio consumer theme.mjs (zellous/wireweave/thebird/247420) had
// hand-rolled identically: items.map((it,i) => RowLink({code, title, sub,
// meta, href})) inside a titled Panel. `keyPrefix` seeds each row's stable
// key (`${keyPrefix}${i}`), matching the consumer convention of a
// one-letter-per-section prefix (e.g. 'f' for features, 'm' for modules).
// Field aliasing mirrors the union of shapes actually hand-rolled downstream:
// title reads `title` then `name`; sub reads `sub` then `desc`; code falls
// back to a zero-padded 1-based index when the item carries none. `heading`/
// `count`/`style`/`kind` pass through to Panel unchanged.
export function PanelFromItems({ heading, items = [], keyPrefix = 'i', count, style, kind, emptyText } = {}) {
    if (!items || !items.length) return emptyText != null ? h('div', { class: 'empty' }, emptyText) : null;
    const rows = items.map((it, i) => {
        const codeVal = it.code != null ? it.code : (it.rank != null ? it.rank : String(i + 1).padStart(2, '0'));
        return RowLink({
            key: keyPrefix + i,
            code: codeVal,
            title: it.title != null ? it.title : it.name,
            sub: it.sub != null ? it.sub : (it.desc != null ? it.desc : ''),
            meta: it.meta != null ? it.meta : '',
            href: it.href || '#'
        });
    });
    return Panel({ title: heading, count, style, kind, children: rows });
}

export function Section({ title, eyebrow, children, id }) {
    return h('section', { class: 'ds-section', id: id || null },
        eyebrow ? h('span', { class: 'eyebrow' }, eyebrow) : null,
        title ? h('h3', {}, title) : null,
        ...(Array.isArray(children) ? children : [children])
    );
}

export function Hero({ eyebrow, title, body, accent, actions, badges }) {
    // Eyebrow + title share the title grid-area so the named-area layout stays
    // intact; body occupies the wide left column, badges + actions stack in
    // the narrow right column so it carries real visual weight instead of
    // sitting empty beside the body copy.
    const badgeList = Array.isArray(badges) ? badges.filter(Boolean) : [];
    const badgeRow = badgeList.length
        ? h('div', { class: 'ds-hero-stats' }, ...badgeList.map((b, i) =>
            h('span', { key: 'hb' + i, class: 'ds-hero-stat' }, String(b && b.label != null ? b.label : b))))
        : null;
    const actionRow = actions ? h('div', { class: 'ds-hero-actions' }, ...(Array.isArray(actions) ? actions : [actions])) : null;
    const aside = (badgeRow || actionRow) ? h('div', { class: 'ds-hero-aside' }, badgeRow, actionRow) : null;
    return h('div', { class: 'ds-hero' },
        h('div', { class: 'ds-hero-head' },
            eyebrow ? h('span', { class: 'eyebrow' }, eyebrow) : null,
            h('h1', { class: 'ds-hero-title' }, title)
        ),
        body ? h('p', { class: 'ds-hero-body' },
            body,
            accent ? h('span', { class: 'ds-hero-accent' }, ' ' + accent) : null
        ) : null,
        aside
    );
}

// HeroFromPageData — a single factory for the "hero block driven by a page-data
// object" shape that recurs, independently hand-rolled, across every flatspace
// consumer theme.mjs (heading/subheading/body/badges/ctas/install all read off
// a `hero` object parsed from the `__site__` JSON script tag). Consumers differ
// only in which fields their content YAML populates; this factory renders every
// field it is given and omits what is absent, so it is a drop-in for the
// narrowest (heading+body only) or richest (badges+ctas+install) hero shape
// alike. Returns null on a falsy `hero` so callers can write
// `HeroFromPageData(page.hero)` unconditionally, matching the existing
// `!home.hero ? null : ...` guard every hand-rolled version repeats.
//
// Shape: { heading, title, subheading, body, accent, badges, ctas, install }
//   heading/title  — hero <h1> text (heading wins if both given)
//   subheading     — a Lede-style standalone line above `body`
//   body           — the hero paragraph
//   accent         — a muted trailing aside appended to `body`
//   badges         — [{label, desc}] or [string], rendered as a stat strip
//   ctas           — [{label, href, primary}], rendered as Btn-equivalent links
//   install        — a single install command string, rendered as a `.cli` block
export function HeroFromPageData(hero) {
    if (!hero) return null;
    const heading = hero.heading || hero.title || '';
    const badges = Array.isArray(hero.badges) ? hero.badges.filter(Boolean) : [];
    const ctas = Array.isArray(hero.ctas) ? hero.ctas.filter(Boolean) : [];
    const badgeRow = badges.length
        ? h('div', { class: 'ds-hero-stats' }, ...badges.map((b, i) =>
            h('span', { key: 'hb' + i, class: 'ds-hero-stat' },
                h('strong', { class: 'ds-hero-stat-n' }, String(b && b.label != null ? b.label : b)),
                (b && b.desc) ? h('span', { class: 'ds-hero-stat-l' }, String(b.desc)) : null,
            )))
        : null;
    const ctaRow = ctas.length
        ? h('div', { class: 'ds-hero-actions' }, ...ctas.map((c, i) =>
            h('a', {
                key: 'hc' + i,
                class: (c.primary || i === 0) ? 'btn btn-accent' : 'btn btn-ghost',
                href: c.href || '#',
            }, c.label || c.cta || 'go')))
        : null;
    const installRow = hero.install
        ? h('div', { class: 'cli' },
            h('span', { class: 'prompt' }, '$'),
            h('span', { class: 'cmd' }, hero.install))
        : null;
    return h('div', { class: 'ds-hero' },
        h('div', { class: 'ds-hero-head' },
            hero.eyebrow ? h('span', { class: 'eyebrow' }, hero.eyebrow) : null,
            h('h1', { class: 'ds-hero-title' }, heading)
        ),
        hero.subheading ? h('p', { class: 'ds-hero-body lede' }, hero.subheading) : null,
        hero.body ? h('p', { class: 'ds-hero-body' },
            hero.body,
            hero.accent ? h('span', { class: 'ds-hero-accent' }, ' ' + hero.accent) : null,
        ) : null,
        (badgeRow || ctaRow || installRow)
            ? h('div', { class: 'ds-hero-aside' }, badgeRow, installRow, ctaRow)
            : null,
    );
}

export function Marquee({ items = [], sep = '/' }) {
    // No items -> no ticker: an empty marquee still paints its border-block
    // rules as an unexplained full-width stripe.
    if (!items.length) return null;
    // Two identical runs make the -50% translate loop seamless. Each text and
    // separator is a keyed span so webjsx applyDiff never sees a primitive
    // sibling beside a keyed VElement.
    const run = (runKey) => items.flatMap((it, i) => [
        h('span', { class: 'ds-marquee-item', key: `${runKey}-i${i}` }, it),
        h('span', { class: 'ds-marquee-sep', key: `${runKey}-s${i}`, 'aria-hidden': 'true' }, sep),
    ]);
    return h('div', { class: 'ds-marquee', role: 'marquee' },
        h('div', { class: 'ds-marquee-track' }, ...run('a'), ...run('b'))
    );
}

export function Install({ cmd, copied, onCopy }) {
    return h('div', { class: 'cli' },
        h('span', { class: 'prompt' }, '$'),
        h('span', { class: 'cmd' }, cmd),
        h('span', { class: 'copy', onclick: () => onCopy && onCopy(cmd) }, copied ? 'copied' : 'copy')
    );
}

// CliBlock — the shared 'quickstart.lines[] -> stacked CLI block' renderer
// every portfolio consumer theme.mjs (zellous/wireweave/247420) had hand-rolled
// identically: lines.map((l,i) => a div per line holding a prompt span ('$' or
// '#' for a comment line) and a cmd span, all wrapped in a Panel. This factory
// targets the multi-line `.ds-cli-block` contract defined in gm-prose.css
// (`.ds-cli-block` holding `.ds-cli-row` rows — each a prompt+cmd pair — and
// `.ds-cli-comment` comment rows). `lines` is [{kind, text}] where kind: 'cmt' renders a
// comment-only row (no prompt glyph); any other kind (or omitted) renders a
// command row prefixed '$'. `heading` titles the wrapping Panel ('quick start'
// default, matching every hand-rolled instance); pass `heading: null` to
// render the bare `.ds-cli-block` block with no Panel chrome.
// Note: this is a different component than the bare `.cli` single prompt+cmd
// row primitive (app-shell.css; see Install() above and the per-line usage
// in terminal/site quickstart renderers) — the two used to collide on the
// same `.cli` class name with incompatible display models.
export function CliBlock({ lines = [], heading = 'quick start', className = '' } = {}) {
    if (!lines || !lines.length) return null;
    const rows = lines.map((l, i) => {
        const isComment = l && l.kind === 'cmt';
        const text = l && l.text != null ? l.text : '';
        return isComment
            ? h('div', { key: 'q' + i, class: 'ds-cli-comment' }, text)
            : h('div', { key: 'q' + i, class: 'ds-cli-row' },
                h('span', { class: 'prompt' }, '$'),
                h('span', { class: 'cmd' }, text));
    });
    const body = h('div', { class: 'ds-cli-block' + (className ? ' ' + className : '') }, ...rows);
    return heading == null ? body : Panel({ title: heading, children: body });
}

export function Receipt({ rows = [], emptyText = 'nothing here yet' }) {
    if (!rows.length) return h('div', { class: 'empty' }, emptyText);
    return h('table', { class: 'kv' },
        h('tbody', {}, ...rows.map(([k, v], i) =>
            h('tr', { key: i }, h('td', {}, k), h('td', {}, v))
        ))
    );
}

export function Changelog({ entries = [], emptyText = 'no changelog entries yet' }) {
    if (!entries.length) return h('div', { class: 'empty' }, emptyText);
    return Panel({
        kind: 'wide',
        children: entries.map((e, i) =>
            h('div', { key: i, class: 'row ds-changelog-row' },
                h('span', { class: 'code' }, e.date),
                h('span', { class: 'ds-changelog-ver' }, e.ver),
                h('span', { class: 'title' }, e.msg)
            )
        )
    });
}

export function WorksList({ works = [], openedIndex = -1, onToggle }) {
    return Panel({
        children: works.map((w, i) => {
            const isOpen = openedIndex === i;
            return h('div', { key: i },
                Row({
                    code: w.code,
                    title: w.title, sub: w.sub,
                    // Expand affordance: a chevron icon (down when open, right when
                    // collapsed) separated from the meta text by a CSS gap, not a
                    // literal +/- with a double-space.
                    meta: h('span', { class: 'ds-works-meta' },
                        w.meta != null ? h('span', {}, w.meta) : null,
                        Icon(isOpen ? 'chevron-down' : 'chevron-right')),
                    active: isOpen,
                    expanded: isOpen,
                    onClick: () => onToggle && onToggle(isOpen ? -1 : i)
                }),
                isOpen ? h('div', { class: 'work-detail', 'data-work-index': String(i) },
                    h('div', { class: 'ds-prose' },
                        h('p', { class: 'ds-work-body' }, w.body)
                    ),
                    h('div', { class: 'ds-work-actions' },
                        Btn({ variant: 'primary', href: w.href || '#', children: 'open ->' }),
                        Btn({ href: w.source || '#', children: 'source' })
                    )
                ) : null
            );
        })
    });
}

export function WritingList({ posts = [] }) {
    return Panel({
        children: posts.map((p, i) =>
            RowLink({ key: i, code: p.date, title: p.title, meta: p.tag, href: p.href || '#' })
        )
    });
}

export function Manifesto({ paragraphs = [], maxWidth }) {
    return h('div', {
        class: 'ds-prose ds-manifesto',
        'data-max-width': maxWidth ? String(maxWidth) : null
    },
        ...paragraphs.map((p, i) => h('p', {
            key: i,
            class: 'ds-manifesto-para' + (p.dim ? ' dim' : '')
        }, p.text || p))
    );
}

// items: [n, label] or [n, label, {delta, tone: 'up'|'down', spark: number[]}]
// meta is optional and additive — every existing 2-tuple call site is untouched.
export function Kpi({ items = [], emptyText = 'no metrics yet' }) {
    if (!items.length) return h('div', { class: 'empty' }, emptyText);
    return h('div', { class: 'kpi' }, ...items.map(([n, l, meta], i) =>
        h('div', { key: i, class: 'kpi-card' },
            h('div', { class: 'num' }, String(n)),
            h('div', { class: 'lbl' }, l),
            meta && (meta.delta != null || meta.spark)
                ? h('div', { class: 'kpi-foot' },
                    meta.delta != null
                        ? h('span', { class: 'kpi-delta kpi-delta-' + (meta.tone === 'down' ? 'down' : 'up') },
                            Icon(meta.tone === 'down' ? 'arrow-down' : 'arrow-up', { size: 12 }),
                            String(meta.delta))
                        : null,
                    meta.spark ? Sparkline({ values: meta.spark, tone: meta.tone }) : null)
                : null)));
}

// Minimal inline SVG trend line — token-stroke only, no raw color literals.
export function Sparkline({ values = [], width = 72, height = 24, tone }) {
    if (!values.length) return null;
    const max = Math.max(...values), min = Math.min(...values);
    const span = (max - min) || 1;
    const step = width / (values.length - 1 || 1);
    const points = values.map((v, i) => [i * step, height - ((v - min) / span) * height]);
    const d = points.map(([x, y], i) => (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
    return h('svg', { class: 'ds-sparkline ds-sparkline-' + (tone === 'down' ? 'down' : 'up'), viewBox: '0 0 ' + width + ' ' + height, width, height, 'aria-hidden': 'true' },
        h('path', { d, fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

// Horizontal token-only bar breakdown — e.g. revenue by channel, traffic by source.
export function BarChart({ items = [], emptyText = 'no data yet' }) {
    if (!items.length) return h('div', { class: 'empty' }, emptyText);
    const max = Math.max(...items.map(it => it.value || 0)) || 1;
    return h('div', { class: 'ds-barchart' }, ...items.map((it, i) =>
        h('div', { key: i, class: 'ds-barchart-row' },
            h('div', { class: 'ds-barchart-label' }, it.label),
            h('div', { class: 'ds-barchart-track' },
                h('div', { class: 'ds-barchart-fill', style: '--bar-pct:' + Math.round((it.value / max) * 100) + '%' })),
            h('div', { class: 'ds-barchart-value' }, it.display != null ? it.display : String(it.value)))));
}

export function Table({ headers = [], rows = [], onRowClick, emptyText = 'nothing here yet', rowLabels, striped = false, compact = false, sortable = false, sortKey, sortDir = 'asc', onSort }) {
    if (!rows || rows.length === 0) return h('div', { class: 'empty' }, emptyText);
    // rowLabels lets callers supply a plain-text label per row when the first
    // cell is a vnode (so the aria-label is meaningful, not the literal 'row').
    const labelFor = (row, i) => {
        if (Array.isArray(rowLabels) && rowLabels[i] != null) return String(rowLabels[i]);
        const c = row[0];
        return c == null ? 'row' : (typeof c === 'object' ? 'row' : String(c));
    };
    // Native <table>/<tr>/<th>/<td> already carry the correct implicit ARIA
    // roles — explicit role="table"/row/columnheader/cell is redundant and only
    // risks overriding native semantics, so it is omitted.
    // Scroll containment lives on the component itself: a wide table used
    // outside a Panel must never force page-level horizontal scroll.
    // striped/compact are opt-in density modifiers (webgeist g-table parity) —
    // default false so the existing contract/visual is byte-unchanged.
    const wrapClass = 'ds-table-wrap' + (striped ? ' is-striped' : '') + (compact ? ' is-compact' : '');
    // sortable is opt-in (default false, byte-unchanged for existing callers):
    // a header becomes a real <button> announcing aria-sort, dispatching
    // onSort(headerIndex) so the HOST owns the actual row-ordering logic (this
    // component has no opinion on comparator/locale/type - it only renders the
    // control and current state). A docstudio-style dense admin table needs
    // sortable columns; Table previously had no way to express that at all.
    const thFor = (hd, i) => {
        if (!sortable || !onSort) return h('th', { key: i, scope: 'col' }, hd);
        const isActive = sortKey === i;
        const ariaSort = isActive ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none';
        return h('th', { key: i, scope: 'col', 'aria-sort': ariaSort },
            h('button', { type: 'button', class: 'ds-table-sort-btn' + (isActive ? ' is-active' : ''), onclick: () => onSort(i) },
                h('span', { class: 'ds-table-sort-label' }, hd),
                isActive ? Icon(sortDir === 'desc' ? 'chevron-down' : 'chevron-up', { size: 12 }) : null));
    };
    return h('div', { class: wrapClass }, h('table', {},
        h('thead', {}, h('tr', {}, ...headers.map((hd, i) => thFor(hd, i)))),
        h('tbody', {}, ...rows.map((row, i) => h('tr', {
            key: i,
            class: onRowClick ? 'clickable' : '',
            onclick: onRowClick ? () => onRowClick(i) : null,
            // Space scrolls by default — preventDefault on Space (and Enter) so
            // keyboard activation matches click without page jump.
            ...(onRowClick ? { tabindex: '0', role: 'button', 'aria-label': 'open ' + labelFor(row, i), onkeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onRowClick(i); } } } : {})
        }, ...row.map((c, j) => h('td', { key: j }, c == null ? '' : (typeof c === 'object' ? c : String(c)))))))));
}

export function HomeView({ state = {}, onNav, onToggleWork, works = [], posts = [], manifesto = [], currentlyShipping } = {}) {
    return [
        Hero({
            eyebrow: 'an entrypoint',
            title: 'Small, weird, useful tools — built in public.',
            body: '247420 is a creative collective of eight, scattered across three timezones. We have been shipping open-source tools for the web since 2018.',
            accent: 'Some become the future. Most don\'t. That\'s the deal.'
        }),
        currentlyShipping ? Section({
            eyebrow: 'currently shipping',
            children: Panel({
                kind: 'wide',
                children: currentlyShipping.map((row, i) => {
                    const dotNode = Dot({ tone: row.live ? 'live' : 'idle' });
                    dotNode.props = { ...dotNode.props, 'aria-label': row.live ? 'live status' : 'idle status' };
                    return Row({
                        key: i,
                        code: dotNode,
                        title: row.title, sub: row.sub, meta: row.meta
                    });
                })
            })
        }) : null,
        works.length ? Section({
            eyebrow: 'works', title: 'Everything else.',
            children: WorksList({ works, openedIndex: state.opened ?? -1, onToggle: onToggleWork })
        }) : null,
        posts.length ? Section({
            eyebrow: 'writing', title: 'When we have something to say.',
            children: WritingList({ posts })
        }) : null,
        manifesto.length ? Section({
            eyebrow: 'who\'s here', title: 'Eight people, three timezones, one ongoing conversation.',
            children: Manifesto({ paragraphs: manifesto })
        }) : null
    ].filter(Boolean);
}

export function ProjectView({ project = {}, copied, onCopy } = {}) {
    return [
        h('div', { class: 'ds-prose' },
            Heading({ level: 1, children: project.name }),
            Lede({ children: project.tagline })
        ),
        project.install ? [
            Heading({ level: 3, children: 'install' }),
            Install({ cmd: project.install, copied, onCopy }),
        ] : null,
        project.receipt ? [
            Heading({ level: 3, children: 'by the numbers' }),
            Receipt({ rows: project.receipt }),
        ] : null,
        project.changelog ? [
            Heading({ level: 3, children: 'recent releases' }),
            Changelog({ entries: project.changelog })
        ] : null
    ].filter(Boolean).flat();
}

export function PageHeader({ title, lede, eyebrow, right, compact, dense, id }) {
    // `compact` drops the large leading/trailing section margins so a PageHeader
    // used as a page's first element top-aligns cleanly without the consumer
    // having to !important-override the .ds-section margin. `id` lands on the
    // outermost section so the header can serve as a deep-link anchor.
    // `dense` is the content-first working-surface form: one row - a small
    // heading with the lede beside it, clamped to a single muted line - instead
    // of a display H1 over a paragraph. App surfaces (files, dashboards,
    // settings) should not spend 150px of fold on an intro.
    if (dense) {
        return h('section', { class: 'ds-section ds-section-compact ds-page-header-dense', id: id || null },
            h('div', { class: 'ds-page-header-dense-row' },
                ...[
                    title != null ? h('h1', { key: 'dh' }, title) : null,
                    lede != null ? h('span', { key: 'dl', class: 'ds-page-header-dense-lede', title: typeof lede === 'string' ? lede : null }, lede) : null,
                    right != null ? h('div', { key: 'dr', class: 'ds-page-header-right' }, ...(Array.isArray(right) ? right : [right])) : null,
                ].filter(Boolean)));
    }
    return h('section', { class: 'ds-section' + (compact ? ' ds-section-compact' : ''), id: id || null },
        eyebrow ? h('span', { class: 'eyebrow' }, eyebrow) : null,
        title != null ? h('h1', {}, title) : null,
        lede != null ? h('p', { class: 'lede' }, lede) : null,
        right != null ? h('div', { class: 'ds-page-header-right' }, ...(Array.isArray(right) ? right : [right])) : null
    );
}

export function SearchInput({ value = '', placeholder = 'search…', onInput, onSubmit, name = 'q', key, label, resultCount }) {
    // Shared clear path — both the Escape key and the visible clear button
    // call this, so there is exactly one place that clears the field.
    const doClear = (e) => { if (onInput) onInput('', e); };
    const input = h('input', {
        key: 'i',
        type: 'search',
        name,
        class: 'ds-search-input',
        placeholder,
        'aria-label': label || placeholder,
        value,
        oninput: onInput ? (e) => onInput(e.target.value, e) : null,
        onkeydown: (e) => {
            // Escape clears the field in place (stays focused) rather than
            // falling through to whatever ancestor Escape handler exists.
            if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); doClear(e); return; }
            // IME guard: the Enter that commits a CJK composition must not submit.
            if (onSubmit && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) onSubmit(e.target.value, e);
        }
    });
    // Visible clear (X) button — mouse/touch users have no way to discover the
    // Escape-to-clear shortcut, so this surfaces the same clear path visibly.
    // Only rendered when there's something to clear.
    const clearBtn = value
        ? h('button', {
            key: 'clr', type: 'button', class: 'ds-search-clear',
            'aria-label': 'clear search',
            onclick: doClear,
        }, Icon('x'))
        : null;
    // Always return the same wrapping shape regardless of whether resultCount/
    // clearBtn are present this render - a conditional bare-input-vs-wrapped-
    // span return here previously changed SearchInput's VElement type at the
    // SAME keyed slot from render to render (e.g. typing into an empty filter
    // makes resultCount go from undefined to a string), and webjsx's applyDiff
    // has no way to morph one element type into another in place - it produced
    // a corrupted merged DOM node carrying attributes from both shapes.
    return h('span', { key, class: 'ds-search-input-wrap' },
        input,
        clearBtn,
        resultCount != null ? h('span', { key: 'cnt', class: 'sr-only', role: 'status', 'aria-live': 'polite' }, resultCount) : null);
}

export function TextField({ label, value = '', type = 'text', placeholder = '', onInput, onChange, name, key, hint, multiline, rows = 4, maxLength, min, max, error, title, size = 'md', 'aria-label': ariaLabel, 'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedBy }) {
    // size: 'sm' | 'md' | 'lg' — md is the base .ds-field control; sm/lg add a
    // wrapper modifier that snaps the control height/padding/font to --ctl-*.
    const sizeCls = size === 'sm' ? ' ds-field--sm' : (size === 'lg' ? ' ds-field--lg' : '');
    const errorId = error != null ? ((key ? key : 'tf') + '-err') : null;
    const describedBy = ariaDescribedBy || errorId || null;
    const input = multiline
        ? h('textarea', {
            key: 'i', name, rows, placeholder, value,
            maxlength: maxLength != null ? maxLength : null,
            'aria-label': ariaLabel || null,
            'aria-invalid': error != null ? 'true' : (ariaInvalid || null),
            'aria-describedby': describedBy,
            title: title || null,
            oninput: onInput ? (e) => onInput(e.target.value, e) : null,
            onchange: onChange ? (e) => onChange(e.target.value, e) : null
        })
        : h('input', {
            key: 'i', type, name, placeholder, value,
            maxlength: maxLength != null ? maxLength : null,
            min: min != null ? String(min) : null,
            max: max != null ? String(max) : null,
            'aria-label': ariaLabel || null,
            'aria-invalid': error != null ? 'true' : (ariaInvalid || null),
            'aria-describedby': describedBy,
            title: title || null,
            oninput: onInput ? (e) => onInput(e.target.value, e) : null,
            onchange: onChange ? (e) => onChange(e.target.value, e) : null
        });
    return h('label', { key, class: 'ds-field' + sizeCls },
        ...[
            label != null ? h('span', { key: 'l', class: 'ds-field-label' }, label) : null,
            input,
            error != null ? h('span', { key: 'e', id: errorId, class: 'ds-field-error', role: 'alert', 'aria-live': 'polite', 'aria-atomic': 'true' }, error) : null,
            maxLength != null ? h('span', { key: 'c', class: 'ds-field-count' }, String(value.length) + '/' + maxLength) : null,
            hint != null ? h('span', { key: 'h', class: 'ds-field-hint' }, hint) : null
        ].filter(Boolean)
    );
}

export function Select({ label, value = '', options = [], onChange, name, key, placeholder, hint, title, size = 'md', 'aria-label': ariaLabel }) {
    const sizeCls = size === 'sm' ? ' ds-field--sm' : (size === 'lg' ? ' ds-field--lg' : '');
    const opts = [];
    if (placeholder != null) opts.push(h('option', { key: '_ph', value: '', disabled: true, selected: value === '' || value == null }, placeholder));
    for (const o of options) {
        const id = typeof o === 'string' ? o : (o.value != null ? o.value : o.id);
        const lab = typeof o === 'string' ? o : (o.label != null ? o.label : (o.id || o.value));
        opts.push(h('option', { key: 'o-' + id, value: id, selected: id === value }, lab));
    }
    const select = h('select', {
        key: 'i', name, class: 'ds-select',
        // Guarantee an accessible name even when rendered without a visible label.
        'aria-label': ariaLabel || (label == null ? (title || placeholder || name) : null),
        title,
        onchange: onChange ? (e) => onChange(e.target.value, e) : null
    }, ...opts);
    if (label == null && hint == null && size === 'md') return select;
    if (label == null && hint == null) return h('label', { key, class: 'ds-field' + sizeCls }, select);
    return h('label', { key, class: 'ds-field' + sizeCls },
        label != null ? h('span', { key: 'l', class: 'ds-field-label' }, label) : null,
        select,
        hint != null ? h('span', { key: 'h', class: 'ds-field-hint' }, hint) : null
    );
}

export function EventList({ items, events, emptyText = 'no events', rankPad = 3, loading = false, loadingText = 'loading events…' }) {
    const list = items || events || [];
    // Shape-matched skeleton rows for the slow first events fetch (the ccsniff
    // cold walk can take 30-90s) - a lone spinner collapses the whole pane.
    // Keying discipline mirrors ConversationList: a single keyed wrapper with
    // all-keyed siblings (webjsx applyDiff crashes on mixed keyed/unkeyed).
    if (loading && !list.length) {
        return h('section', { class: 'ds-section ds-event-list' },
            h('div', { key: 'st', role: 'status', 'aria-live': 'polite', class: 'ds-event-state lede' }, loadingText),
            ...Array.from({ length: 7 }, (_, i) => h('div', { key: 'sk' + i, class: 'ds-event-row-skeleton', 'aria-hidden': 'true' },
                h('span', { key: 'r', class: 'ds-skel ds-skel-rank' }),
                h('span', { key: 't', class: 'ds-skel ds-skel-title' }),
                h('span', { key: 'm', class: 'ds-skel ds-skel-meta' }))));
    }
    if (!list.length) return h('p', { class: 'lede' }, emptyText);
    return h('section', { class: 'ds-section ds-event-list' },
        ...list.map((it, i) => Row({
            key: it.key || ('ev' + i),
            code: it.code != null ? it.code : (it.rank != null ? it.rank : String(i + 1).padStart(rankPad, '0')),
            title: it.title || '(empty)',
            sub: it.sub || '',
            active: it.active,
            onClick: it.onClick,
            kind: it.kind,
            rail: it.rail,
            // Forward a disclosure state when the host marks the row as a toggle,
            // so a clickable event row announces aria-expanded.
            expanded: it.expanded,
            detail: it.detail,
            actions: it.actions,
            highlight: it.highlight,
            meta: it.meta
        }))
    );
}

export function Form({ fields = [], submit = 'submit', onSubmit, columns = 1 }) {
    const cols = columns > 1 ? String(columns) : null;
    return h('form', { class: 'row-form', 'data-columns': cols, onsubmit: (ev) => { ev.preventDefault(); onSubmit && onSubmit(ev); } },
        ...fields.map((f, i) => {
            // Each control gets a stable id and an associated <label> so the
            // placeholder is no longer the only (inaccessible) name. The label
            // text falls back to label -> placeholder -> name.
            const fieldId = 'ds-form-' + (f.name || 'field') + '-' + i;
            const labelText = f.label != null ? f.label : (f.placeholder || f.name || '');
            const control = f.kind === 'textarea'
                ? h('textarea', { key: 'i', id: fieldId, name: f.name, placeholder: f.placeholder || '', rows: f.rows || 4, required: f.required ? true : null })
                : h('input', { key: 'i', id: fieldId, name: f.name, type: f.type || 'text', placeholder: f.placeholder || '', value: f.value || '', required: f.required ? true : null });
            return h('label', { key: i, class: 'ds-field', for: fieldId },
                labelText !== '' ? h('span', { key: 'l', class: 'ds-field-label' }, labelText) : null,
                control);
        }),
        h('button', { type: 'submit', class: 'btn-primary' }, submit));
}

export function Spinner({ size = 'base', tone = 'accent', label = 'loading', key } = {}) {
    const SIZE_CLASS = { xs: 'ds-spinner-xs', sm: 'ds-spinner-sm', base: '', lg: 'ds-spinner-lg', xl: 'ds-spinner-xl' };
    const sizeClass = SIZE_CLASS[size] != null ? SIZE_CLASS[size] : '';
    return h('div', {
        key, class: 'ds-spinner ' + sizeClass + ' tone-' + tone,
        role: 'status', 'aria-live': 'polite', 'aria-label': label
    },
        h('span', { key: '1', 'aria-hidden': 'true' }),
        h('span', { key: '2', 'aria-hidden': 'true' }),
        h('span', { key: '3', 'aria-hidden': 'true' })
    );
}

// Clamp a caller-supplied CSS length to a sane range so a raw prop like
// height="9999px" can't blow out the layout. Accepts a CSS length string
// (px/em/rem/%/vh/vw) or a bare number (treated as px); rejects anything else
// back to the default. Numeric values are clamped to [2, 600] (px-equivalent).
function clampLen(v, fallback) {
    if (v == null) return fallback;
    const s = String(v).trim();
    const m = /^(\d+(?:\.\d+)?)(px|em|rem|%|vh|vw)?$/.exec(s);
    if (!m) return fallback;
    const unit = m[2] || 'px';
    let n = parseFloat(m[1]);
    if (unit === '%' || unit === 'vh' || unit === 'vw') n = Math.min(100, Math.max(0, n));
    else n = Math.min(600, Math.max(2, n));
    return n + unit;
}

export function Skeleton({ height = '1em', width = '100%', count = 1, label = 'loading content', key } = {}) {
    const h_ = clampLen(height, '1em');
    const w_ = clampLen(width, '100%');
    return h('div', {
        key, class: 'ds-skeleton-group',
        role: 'status', 'aria-busy': 'true', 'aria-label': label
    },
        ...Array(count).fill(0).map((_, i) =>
            h('div', { key: String(i), class: 'ds-skeleton', style: `height:${h_};width:${w_};`, 'aria-hidden': 'true' })
        )
    );
}

// FilterPills — a role=group of pill toggle buttons for quick category filters.
// `options` is [{ id, label }]; `selected` the active id; clicking a pill calls
// onSelect(id). Pressed state is announced via aria-pressed.
export function FilterPills({ options = [], selected, onSelect, label = 'filters' } = {}) {
    if (!options.length) return null;
    return h('div', { class: 'ds-filter-pills', role: 'group', 'aria-label': label },
        ...options.map((o) => h('button', {
            key: 'fp-' + o.id,
            type: 'button',
            class: 'ds-filter-pill' + (o.id === selected ? ' active' : ''),
            'aria-pressed': o.id === selected ? 'true' : 'false',
            onclick: () => onSelect && onSelect(o.id),
        }, o.label != null ? o.label : o.id)));
}

export function Alert({ kind = 'info', children, onDismiss, title, key } = {}) {
    const icons = { info: 'info', success: 'check', warn: 'warn', error: 'x' };
    const cls = 'ds-alert ds-alert-' + kind;
    return h('div', { key, class: cls, role: 'alert' },
        h('span', { key: 'icon', class: 'ds-alert-icon' }, Icon(icons[kind] || 'info')),
        h('div', { key: 'content', class: 'ds-alert-content' },
            title ? h('div', { key: 'title', class: 'ds-alert-title' }, title) : null,
            h('div', { key: 'msg', class: 'ds-alert-message' }, ...(Array.isArray(children) ? children : [children]))
        ),
        onDismiss ? h('button', { key: 'dismiss', class: 'ds-alert-dismiss', 'aria-label': 'dismiss', onclick: onDismiss }, Icon('x')) : null
    );
}
