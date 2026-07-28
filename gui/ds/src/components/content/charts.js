// Metric visuals — Kpi (stat cards with optional delta/sparkline footer),
// Sparkline (inline trend line) and BarChart (horizontal breakdown). All
// token-stroke/token-fill only; no raw color literals.

import * as webjsx from '../../../vendor/webjsx/index.js';
import { Icon } from '../shell.js';
const h = webjsx.createElement;

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
