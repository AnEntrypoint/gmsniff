// Visualisation panels: the squarified treemap behind CodeInsight, and the
// force-directed memory graph with its layout lifecycle.
import { ScopedPanelState } from './honest-state.js';
import { api, state } from './data.js';
import { StatsGrid } from 'ds/components/data-density.js';
import { JsonViewer } from 'ds/components/editor-primitives.js';
import { runForceLayout } from './forcegraph.js';
import { ELLIPSIS, Empty, colorFor, h } from './panels-internals.js';
function squarifiedTreemap(items, x, y, w, h) {
  const out = [];
  const worstAspectRatio = (row, len) => {
    if (!row.length) return Infinity;
    let sum = 0, max = -Infinity, min = Infinity;
    for (const it of row) { sum += it._sz; if (it._sz > max) max = it._sz; if (it._sz < min) min = it._sz; }
    const sideSq = (len * len) / (sum * sum);
    return Math.max(sideSq * max, min > 0 ? 1 / (sideSq * min) : Infinity);
  };
  const layoutRow = (row, rx, ry, rw, rh, vertical) => {
    const areaSum = row.reduce((s, it) => s + it._sz, 0);
    if (areaSum <= 0 || !row.length) return { rx, ry, rw, rh };
    if (vertical) {
      const bandW = rh > 0 ? areaSum / rh : 0;
      let cy = ry;
      for (const it of row) {
        const itH = bandW > 0 ? it._sz / bandW : 0;
        out.push({ name: it.name, complexity: it.complexity, x: rx, y: cy, w: bandW, h: itH });
        cy += itH;
      }
      return { rx: rx + bandW, ry, rw: rw - bandW, rh };
    } else {
      const bandH = rw > 0 ? areaSum / rw : 0;
      let cx = rx;
      for (const it of row) {
        const itW = bandH > 0 ? it._sz / bandH : 0;
        out.push({ name: it.name, complexity: it.complexity, x: cx, y: ry, w: itW, h: bandH });
        cx += itW;
      }
      return { rx, ry: ry + bandH, rw, rh: rh - bandH };
    }
  };
  const squarify = (queue, rx, ry, rw, rh) => {
    if (!queue.length || rw <= 0 || rh <= 0) return;
    const short = Math.min(rw, rh);
    let row = [];
    let i = 0;
    while (i < queue.length) {
      const candidate = [...row, queue[i]];
      if (row.length === 0 || worstAspectRatio(candidate, short) <= worstAspectRatio(row, short)) {
        row = candidate; i++;
      } else break;
    }
    const remaining = queue.slice(i);
    const vertical = rw >= rh;
    const rest = layoutRow(row, rx, ry, rw, rh, vertical);
    squarify(remaining, rest.rx, rest.ry, rest.rw, rest.rh);
  };
  const total = items.reduce((s, it) => s + Math.max(it.size || 0, 0.0001), 0);
  const scaled = items.map(it => ({ ...it, _sz: total > 0 ? (Math.max(it.size || 0, 0.0001) / total) * (w * h) : 0 }));
  squarify(scaled, x, y, w, h);
  return out;
}

const LOW_COMPLEXITY_GREEN = { r: 60, g: 180, b: 60 };
const HIGH_COMPLEXITY_RED = { r: 210, g: 50, b: 60 };
const UNIFORM_COMPLEXITY_SCALE_POINT = 0.3;

function complexityColor(val, min, max) {
  const span = max - min;
  const everyItemHasIdenticalComplexity = span <= 0;
  const t = everyItemHasIdenticalComplexity
    ? UNIFORM_COMPLEXITY_SCALE_POINT
    : Math.max(0, Math.min(1, (val - min) / span));
  const lerp = (from, to) => Math.round(from + t * (to - from));
  return `rgb(${lerp(LOW_COMPLEXITY_GREEN.r, HIGH_COMPLEXITY_RED.r)},`
    + `${lerp(LOW_COMPLEXITY_GREEN.g, HIGH_COMPLEXITY_RED.g)},`
    + `${lerp(LOW_COMPLEXITY_GREEN.b, HIGH_COMPLEXITY_RED.b)})`;
}

const codeInsightUi = { selected: null };

export async function CodeInsightPanel(setBody) {
  const unscoped = ScopedPanelState({ panel: "CodeInsight", cwd: state.cwd });
  if (unscoped) return unscoped;
  const r = await api('/api/codeinsight', { scoped: true });
  if (r.error) return Empty('No .codeinsight file found for this project (codeinsight has not run yet).');
  const summary = r.summary || {};
  const items = r.items || [];
  const complexities = items.map(it => it.complexity || 0);
  const minC = complexities.length ? Math.min(...complexities) : 0;
  const maxC = complexities.length ? Math.max(...complexities) : 1;
  const W = 900, H = 420;
  const rects = items.length ? squarifiedTreemap(items, 0, 0, W, H) : [];
  const byName = new Map(items.map(it => [it.name, it]));
  const selected = codeInsightUi.selected ? byName.get(codeInsightUi.selected) : null;

  const select = (name) => { codeInsightUi.selected = codeInsightUi.selected === name ? null : name; if (setBody) setBody(); };

  return h('div', {},
    StatsGrid({ items: [
      { val: summary.files ?? '?', lbl: 'files' }, { val: summary.lines ?? '?', lbl: 'lines' },
      { val: summary.functions ?? '?', lbl: 'functions' }, { val: summary.classes ?? '?', lbl: 'classes' },
      { val: summary.avgComplexity ?? '?', lbl: 'avg complexity' },
    ] }),
    h('div', { class: 'ds-panel gm-mt-12' },
      h('h2', {}, `File-size treemap (${items.length} file${items.length === 1 ? '' : 's'})`),
      !items.length ? Empty('No per-file size/complexity data extracted from .codeinsight.') :
      h('div', { class: 'gm-treemap-container', style: `--tm-w:${W}px;--tm-h:${H}px` },
        ...rects.map((rect, i) => {
          const fits = rect.w > 28 && rect.h > 16;
          const isSel = codeInsightUi.selected === rect.name;
          return h('div', {
            key: i,
            class: 'gm-treemap-rect',
            title: `${rect.name} -- complexity ${rect.complexity}`,
            onclick: () => select(rect.name),
            style: `--rx:${rect.x}px;--ry:${rect.y}px;--rw:${Math.max(rect.w - 1, 0)}px;--rh:${Math.max(rect.h - 1, 0)}px;` +
              `--rect-bg:${complexityColor(rect.complexity, minC, maxC)};--rect-border:${isSel ? 'var(--accent, #58a6ff)' : 'rgba(0,0,0,0.25)'};`,
          }, fits ? (rect.name.length > Math.floor(rect.w / 6) ? rect.name.slice(0, Math.max(1, Math.floor(rect.w / 6) - 1)) + '...' : rect.name) : null);
        }))),
    selected ? h('div', { class: 'ds-panel gm-mt-12' },
      h('h2', {}, `Detail: ${selected.name}`),
      JsonViewer({ value: selected, mode: 'highlight', copyable: true }))
      : null,
    h('div', { class: 'gm-mt-12' },
      ...((r.entries || []).length ? r.entries.map((entry, i) => h('details', { key: i, class: 'ds-panel gm-my-4' },
        h('summary', { class: 'gm-cursor-pointer' }, entry.section), h('pre', { class: 'gm-json' }, entry.content)))
        : [Empty('No sectioned codeinsight data.')])));
}

const NODE_R_MIN = 6, NODE_R_MAX = 10;
const graphUiState = { handle: null, selectedId: null };

export function stopMemoryGraphLayout() {
  if (graphUiState.handle) { graphUiState.handle.stop(); graphUiState.handle = null; }
}

const GRAPH_LABEL_MAX_CHARS = 28;

// The route pages this now and reports total/returned/truncated, so a second
// silent client-side cap on top of it would hide nodes the server had already
// declared it was sending. Labels carry a visible ellipsis and a full-value
// title rather than cutting mid-key, where a truncated name is indistinguishable
// from a genuinely short one.
function toShapeRunForceLayoutExpects(r) {
  const nodes = (r.nodes || []).map(n => {
    const full = `${n.namespace}/${n.key}`;
    return {
      id: n.key,
      // ELLIPSIS is three characters, so reserving one made every truncated
      // label 30 wide against a 28 limit -- measured on all 882 gm nodes.
      label: full.length > GRAPH_LABEL_MAX_CHARS ? full.slice(0, GRAPH_LABEL_MAX_CHARS - ELLIPSIS.length) + ELLIPSIS : full,
      title: full,
      namespace: n.namespace,
      text: n.text,
    };
  });
  const nodeIds = new Set(nodes.map(n => n.id));
  const edgesBetweenRenderedNodes = (r.edges || []).filter(e => nodeIds.has(e.src) && nodeIds.has(e.dst))
    .map(e => ({ source: e.src, target: e.dst, relation: e.relation }));
  return { nodes, edges: edgesBetweenRenderedNodes };
}

function neighborSet(edges, id) {
  const s = new Set([id]);
  for (const e of edges) {
    if (e.source === id) s.add(e.target);
    if (e.target === id) s.add(e.source);
  }
  return s;
}

export async function MemoryGraphPanel() {
  const unscoped = ScopedPanelState({ panel: "Memory Graph", cwd: state.cwd });
  if (unscoped) return unscoped;
  stopMemoryGraphLayout();
  const r = await api('/api/memory-graph', { scoped: true });
  if (r.error) return Empty('Failed to load memory graph: ' + r.error);
  if (!r.nodes || !r.nodes.length) return Empty(r.note || 'No memory nodes found for this project.');

  const { nodes, edges } = toShapeRunForceLayoutExpects(r);
  const width = 900, height = 520;
  graphUiState.selectedId = null;

  // "N nodes" counted the rendered set, so a 150-node view of an 882-node store
  // read as a complete 150-node graph. The heading now names the whole store and
  // the omission rides beside it.
  const nodesOmitted = (r.total || nodes.length) - nodes.length;
  const edgesDroppedWithTheirNodes = (r.edges_total || edges.length) - edges.length;
  const container = h('div', { class: 'ds-panel' },
    r.note ? h('p', { class: 'gm-hint-text' }, r.note) : null,
    h('h2', {}, `Memory Graph -- ${nodes.length} of ${r.total ?? nodes.length} nodes, ${edges.length} of ${r.edges_total ?? edges.length} edges`),
    nodesOmitted > 0
      ? h('p', { class: 'gm-muted-11' },
          `+${nodesOmitted} node${nodesOmitted === 1 ? '' : 's'} not shown (page caps at ${r.returned}) -- pass ?limit= for more`
          + (edgesDroppedWithTheirNodes > 0 ? `; ${edgesDroppedWithTheirNodes} edge${edgesDroppedWithTheirNodes === 1 ? '' : 's'} omitted with them` : ''))
      : null,
    h('svg', {
      class: 'gm-force-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet',
      id: 'memory-graph-svg',
    }));

  const afterCallerAppliesThisVnodeToTheDom = 0;
  setTimeout(() => mountForceGraph(nodes, edges, width, height), afterCallerAppliesThisVnodeToTheDom);

  return container;
}

function mountForceGraph(nodes, edges, width, height) {
  const svg = document.getElementById('memory-graph-svg');
  const panelNavigatedAwayBeforeMountFired = !svg;
  if (panelNavigatedAwayBeforeMountFired) return;

  let dragging = null;

  function paint() {
    if (!document.getElementById('memory-graph-svg')) { stopMemoryGraphLayout(); return; }
    const sel = graphUiState.selectedId;
    const neighbors = sel ? neighborSet(edges, sel) : null;

    const svgNS = 'http://www.w3.org/2000/svg';
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const edgeGroup = document.createElementNS(svgNS, 'g');
    for (const e of edges) {
      const a = nodes.find(n => n.id === e.source), b = nodes.find(n => n.id === e.target);
      if (!a || !b) continue;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      let cls = 'gm-force-edge';
      if (sel) cls += (neighbors.has(a.id) && neighbors.has(b.id)) ? ' hi' : ' dim';
      line.setAttribute('class', cls);
      edgeGroup.appendChild(line);
    }
    svg.appendChild(edgeGroup);

    const nodeGroup = document.createElementNS(svgNS, 'g');
    for (const n of nodes) {
      const g = document.createElementNS(svgNS, 'g');
      let cls = 'gm-force-node';
      if (sel) cls += (n.id === sel) ? ' hi' : (neighbors.has(n.id) ? '' : ' dim');
      if (dragging && dragging.node === n) cls += ' dragging';
      g.setAttribute('class', cls);

      const r = NODE_R_MIN + Math.min(NODE_R_MAX - NODE_R_MIN, (n.label.length % 5));
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', n.x); circle.setAttribute('cy', n.y); circle.setAttribute('r', r);
      circle.setAttribute('fill', colorFor(n.namespace || 'default'));
      circle.setAttribute('title', n.text || n.label);

      circle.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        n.pinned = true; n.vx = 0; n.vy = 0;
        const pt = svgPoint(svg, ev);
        dragging = { node: n, offsetX: pt.x - n.x, offsetY: pt.y - n.y };
        try { circle.setPointerCapture(ev.pointerId); } catch (_) {}
      });
      circle.addEventListener('pointermove', (ev) => {
        if (!dragging || dragging.node !== n) return;
        const pt = svgPoint(svg, ev);
        n.x = pt.x - dragging.offsetX; n.y = pt.y - dragging.offsetY;
        paint();
      });
      const endDrag = () => {
        if (dragging && dragging.node === n) { n.pinned = false; dragging = null; paint(); }
      };
      circle.addEventListener('pointerup', endDrag);
      circle.addEventListener('pointercancel', endDrag);
      circle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        graphUiState.selectedId = (graphUiState.selectedId === n.id) ? null : n.id;
        paint();
      });

      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', n.x + r + 3); text.setAttribute('y', n.y + 3);
      text.textContent = n.label;

      g.appendChild(circle); g.appendChild(text);
      nodeGroup.appendChild(g);
    }
    svg.appendChild(nodeGroup);
  }

  svg.addEventListener('click', () => { if (graphUiState.selectedId) { graphUiState.selectedId = null; paint(); } });

  graphUiState.handle = runForceLayout(nodes, edges, { width, height, onTick: paint });
  paint();
}

function svgPoint(svg, ev) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const scaleX = vb.width / rect.width, scaleY = vb.height / rect.height;
  return { x: (ev.clientX - rect.left) * scaleX, y: (ev.clientY - rect.top) * scaleY };
}

