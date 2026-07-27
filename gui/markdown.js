// Minimal, dependency-free, offline markdown renderer for the served
// instruction body.
//
// The upstream markdown chain was deliberately NOT vendored (it pulls three
// CDN dependencies) and gmsniff's GUI must stay fully offline-clean, so this
// renders the small subset gm's instruction prose actually uses -- measured
// against the real next-step.md bodies on this machine: ATX headings, fenced
// code, bullet lists, blockquotes, bold/italic/inline-code, and paragraphs.
//
// Output is a webjsx vnode tree built node-by-node, never an innerHTML string:
// instruction text is untrusted file content, and constructing real text nodes
// means markup inside it can never become live DOM.

import * as webjsx from 'webjsx';

const h = webjsx.createElement;

// Inline pass: **bold**, *italic*/_italic_, `code`. Splits on the first match
// and recurses so nesting resolves without a regex that can backtrack badly.
// Every leftover is emitted as a plain string, which webjsx renders as a text
// node -- so `<script>` in an instruction is text, not an element.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

function inline(text, keyPrefix) {
  const out = [];
  let rest = String(text);
  let i = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    const key = keyPrefix + ':' + (i++);
    if (tok.startsWith('`')) out.push(h('code', { key }, tok.slice(1, -1)));
    else if (tok.startsWith('**')) out.push(h('strong', { key }, tok.slice(2, -2)));
    else out.push(h('em', { key }, tok.slice(1, -1)));
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export function renderMarkdown(src) {
  const lines = String(src || '').split(/\r?\n/);
  const blocks = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code -- content is emitted verbatim as one text node, never
    // re-parsed for inline markup.
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || null;
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // closing fence (or EOF -- an unterminated fence still renders)
      blocks.push(h('pre', { key: 'b' + key++, class: 'gm-md-code', 'data-lang': lang }, h('code', {}, body.join('\n'))));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      // Instruction bodies start at h1; rendering that as a real <h1> inside a
      // dialog would outrank the dialog's own title, so shift down one level.
      const tag = 'h' + Math.min(6, level + 1);
      blocks.push(h(tag, { key: 'b' + key++, class: 'gm-md-h' }, ...inline(heading[2], 'h' + key)));
      i++;
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      blocks.push(h('hr', { key: 'b' + key++, class: 'gm-md-hr' }));
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push(h('blockquote', { key: 'b' + key++, class: 'gm-md-quote' }, ...inline(body.join(' '), 'q' + key)));
      continue;
    }

    const bullet = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(h('li', { key: 'li' + items.length }, ...inline(m[2], 'l' + key + items.length)));
        i++;
      }
      blocks.push(h(ordered ? 'ol' : 'ul', { key: 'b' + key++, class: 'gm-md-list' }, ...items));
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // Paragraph: consume until a blank line or the start of another block.
    const para = [];
    while (i < lines.length && lines[i].trim()
           && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
           && !/^\s*>/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    if (para.length) blocks.push(h('p', { key: 'b' + key++, class: 'gm-md-p' }, ...inline(para.join(' '), 'p' + key)));
  }

  if (!blocks.length) return h('p', { class: 'gm-md-p gm-feed-muted' }, '(empty instruction body)');
  return h('div', { class: 'gm-md' }, ...blocks);
}
