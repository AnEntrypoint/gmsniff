// The upstream markdown chain was deliberately NOT vendored: its upstream form
// fetches three CDN dependencies and the served gui/ tree must stay
// offline-clean. What this renders instead is the subset measured against the
// real next-step.md bodies on this machine -- ATX headings, fenced code, bullet
// and ordered lists, blockquotes, bold/italic/inline-code, and paragraphs.

import * as webjsx from 'webjsx';

const h = webjsx.createElement;

// Instruction text is untrusted file content, so every leftover run is emitted
// as a plain JS string and webjsx turns it into a real text node -- `<script>`
// inside an instruction can therefore never become live DOM. A regex-alternation
// scan that splits on the FIRST match and recurses on the remainder was chosen
// over a single whole-line pattern, which backtracks pathologically on the
// unbalanced `*` and `_` runs that appear in real prose.
const INLINE_TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

const FENCE_OPEN = /^\s*```(\S*)\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;
const THEMATIC_BREAK = /^\s*(?:[-*_]\s*){3,}$/;
const BLOCKQUOTE_MARKER = /^\s*>\s?/;
const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+(.*)$/;

const MAX_HEADING_LEVEL = 6;
// The dialog hosting an instruction owns the <h1> in its own subtree, and
// instruction bodies themselves start at h1, so every heading shifts down one
// level rather than outranking the dialog's title.
const HEADING_LEVEL_SHIFT_BELOW_DIALOG_TITLE = 1;

// Deliberately looser than the block openers above: a paragraph must stop at
// anything that even LOOKS like the start of another block, including a fence
// line with trailing text that FENCE_OPEN itself rejects.
const ANY_BLOCK_OPENER = [/^\s*```/, ATX_HEADING, /^\s*>/, LIST_ITEM];

function startsAnotherBlock(line) {
  return ANY_BLOCK_OPENER.some(re => re.test(line));
}

function inlineNodes(text, keyPrefix) {
  const out = [];
  let rest = String(text);
  let i = 0;
  while (rest) {
    const m = INLINE_TOKEN.exec(rest);
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

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const lang = fence[1] || null;
      const verbatimBody = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) { verbatimBody.push(lines[i]); i++; }
      i++;
      blocks.push(h('pre', { key: 'b' + key++, class: 'gm-md-code', 'data-lang': lang },
        h('code', {}, verbatimBody.join('\n'))));
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (heading) {
      const level = Math.min(MAX_HEADING_LEVEL, heading[1].length);
      const tag = 'h' + Math.min(MAX_HEADING_LEVEL, level + HEADING_LEVEL_SHIFT_BELOW_DIALOG_TITLE);
      blocks.push(h(tag, { key: 'b' + key++, class: 'gm-md-h' }, ...inlineNodes(heading[2], 'h' + key)));
      i++;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      blocks.push(h('hr', { key: 'b' + key++, class: 'gm-md-hr' }));
      i++;
      continue;
    }

    if (BLOCKQUOTE_MARKER.test(line)) {
      const quoted = [];
      while (i < lines.length && BLOCKQUOTE_MARKER.test(lines[i])) {
        quoted.push(lines[i].replace(BLOCKQUOTE_MARKER, ''));
        i++;
      }
      blocks.push(h('blockquote', { key: 'b' + key++, class: 'gm-md-quote' }, ...inlineNodes(quoted.join(' '), 'q' + key)));
      continue;
    }

    const bullet = LIST_ITEM.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const items = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m) break;
        items.push(h('li', { key: 'li' + items.length }, ...inlineNodes(m[2], 'l' + key + items.length)));
        i++;
      }
      blocks.push(h(ordered ? 'ol' : 'ul', { key: 'b' + key++, class: 'gm-md-list' }, ...items));
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !startsAnotherBlock(lines[i])) {
      paragraph.push(lines[i]); i++;
    }
    if (paragraph.length) blocks.push(h('p', { key: 'b' + key++, class: 'gm-md-p' }, ...inlineNodes(paragraph.join(' '), 'p' + key)));
  }

  if (!blocks.length) return h('p', { class: 'gm-md-p gm-feed-muted' }, '(empty instruction body)');
  return h('div', { class: 'gm-md' }, ...blocks);
}
