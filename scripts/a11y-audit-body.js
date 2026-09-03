// Live-DOM accessibility audit for the gmsniff GUI, run through the gm
// `browser` verb (page-context JS: bare document/window, plain return).
//
//   copy this file body into .gm/exec-spool/in/browser/<N>.txt behind
//   `timeout=120000` and `url=http://127.0.0.1:<port>/?cb=<nonce>` lines.
//
// Two measurement traps this encodes, both of which produced false failures
// before they were fixed:
//
//   1. A canvas fillStyle round-trip normalises rgb()/hex/color-mix but returns
//      oklab() VERBATIM, so parsing its numbers positionally reads
//      oklab(0.75 0.04 0.01) as RGB 0.75,0.04,0.01 -- near-black. That reported
//      a light dusty-pink (--stale, really rgb(201,164,166), 8.57:1 on --bg) as
//      1.09:1. Painting the colour and reading the PIXEL back forces real sRGB.
//
//   2. The first non-transparent ancestor is not the effective background: a
//      10%-alpha tint counted as opaque reported light text on a dark panel as
//      1.14:1. Every partially-transparent layer is composited over what is
//      behind it, stopping only at a fully opaque one.
//
// Measured clean at 96 text nodes: 0 contrast failures, 0 targets under 24px.
//
// Exported as a function so `node --check` and test.js can parse this file;
// the browser-verb body is the function source, which auditBody() returns.
export async function guiA11yAudit() {
  await new Promise(r => setTimeout(r, 4000));

  function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  // Colours arrive as rgb(), oklab(), oklch() or color-mix() output. Pulling the
  // numbers out positionally treats oklab(0.75 0.04 0.01) as RGB 0.75,0.04,0.01
  // -- effectively black -- and reported a light warm grey (--stale) as 1.09:1
  // against a dark background. Round-trip through a canvas so the browser
  // resolves every notation to real sRGB before any maths happens.
  // A canvas fillStyle round-trip normalises rgb()/hex/color-mix but PRESERVES
  // oklab() verbatim (witnessed: it returns the oklab string unchanged), so it
  // cannot be relied on alone. Paint the colour and read the pixel back instead
  // -- that forces the compositor to resolve any notation to real sRGB bytes.
  const _cv = (() => { const c = document.createElement('canvas'); c.width = c.height = 1; return c.getContext('2d', { willReadFrequently: true }); })();
  function toRgb(c) {
    try {
      _cv.clearRect(0, 0, 1, 1);
      _cv.fillStyle = '#000';
      _cv.fillStyle = c;
      _cv.fillRect(0, 0, 1, 1);
      const d = _cv.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    } catch (e) {
      const m = String(c).match(/-?[\d.]+/g);
      return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : null;
    }
  }
  function lum(c) {
    const v = toRgb(c);
    if (!v) return null;
    return 0.2126 * srgb(v[0]) + 0.7152 * srgb(v[1]) + 0.0722 * srgb(v[2]);
  }
  function ratio(fg, bg) {
    const a = lum(fg), b = lum(bg);
    if (a == null || b == null) return null;
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  }
  // A semi-transparent layer is NOT the effective background: taking the first
  // non-transparent ancestor treats a 10%-alpha tint as opaque and reported light
  // text on a dark panel as 1.14:1. Composite every partially-transparent layer
  // over what is behind it, the way the compositor does, and only stop at a fully
  // opaque one.
  function alphaOf(c) {
    const m = String(c).match(/[\d.]+\s*\)?\s*$/);
    if (/^(rgba|hsla)\(/.test(c) || /\/\s*[\d.]+\s*\)/.test(c)) {
      const parts = String(c).match(/[-\d.]+/g);
      if (parts && parts.length >= 4) return +parts[parts.length - 1];
    }
    return c === 'transparent' || c === 'rgba(0, 0, 0, 0)' ? 0 : 1;
  }
  function over(fg, fa, bg) {
    return [0, 1, 2].map(i => Math.round(fg[i] * fa + bg[i] * (1 - fa)));
  }
  function effBg(el) {
    const layers = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      const a = alphaOf(bg);
      if (a > 0) {
        layers.push([toRgb(bg), a]);
        if (a >= 1) break;
      }
      n = n.parentElement;
    }
    const base = toRgb(getComputedStyle(document.body).backgroundColor) || [0, 0, 0];
    let acc = base;
    for (let i = layers.length - 1; i >= 0; i--) {
      const [col, a] = layers[i];
      if (col) acc = over(col, a, acc);
    }
    return 'rgb(' + acc.join(', ') + ')';
  }

  // Contrast over every text-bearing element actually on screen
  const texts = Array.from(document.querySelectorAll('body *')).filter(el => {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
    const own = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
    return own;
  });
  const failures = [];
  const sizes = {};
  for (const el of texts) {
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    sizes[Math.round(fs)] = (sizes[Math.round(fs)] || 0) + 1;
    const r = ratio(cs.color, effBg(el));
    if (r == null) continue;
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = fs >= 24 || (fs >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (r < need) {
      failures.push({
        sel: el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0],
        ratio: r, need, fontSize: fs, color: cs.color, bg: effBg(el),
        text: (el.textContent || '').trim().slice(0, 30),
      });
    }
  }

  // Focus ring: does every focusable get a visible indicator?
  const focusables = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));
  const noRing = [];
  for (const el of focusables.slice(0, 60)) {
    el.focus();
    const cs = getComputedStyle(el);
    const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
    if (!hasOutline && !hasShadow) {
      noRing.push(el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0]);
    }
    el.blur();
  }

  // Touch target sizes
  const small = focusables.filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.width < 24 || r.height < 24);
  }).map(el => el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0] + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height));

  return {
    text_nodes_checked: texts.length,
    contrast_failures: failures.slice(0, 25),
    contrast_fail_count: failures.length,
    font_size_histogram: sizes,
    focus_no_ring: [...new Set(noRing)],
    focus_checked: Math.min(60, focusables.length),
    small_targets: [...new Set(small)].slice(0, 20),
  };

}

// The literal page-context body to paste behind the timeout=/url= prefix lines.
export function auditBody() {
  const src = guiA11yAudit.toString();
  return src.slice(src.indexOf("{") + 1, src.lastIndexOf("}"));
}
