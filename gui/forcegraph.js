// Mutates node.x/y in place every frame; the returned stop() must be called on
// unmount or the requestAnimationFrame loop leaks for the life of the page.

const REPULSION = 2600;
const SPRING_K = 0.02;
const SPRING_REST_LENGTH = 90;
const DAMPING = 0.85;
const MIN_DIST_GUARDING_DIVISION_BY_ZERO = 1;
const CENTER_PULL = 0.002;
const EDGE_MARGIN = 10;

export function runForceLayout(nodes, edges, { width = 800, height = 600, onTick } = {}) {
  const byId = new Map();
  for (const n of nodes) {
    if (n.x == null) n.x = Math.random() * width;
    if (n.y == null) n.y = Math.random() * height;
    if (n.vx == null) n.vx = 0;
    if (n.vy == null) n.vy = 0;
    byId.set(n.id, n);
  }

  const cx = width / 2, cy = height / 2;
  let rafId = null;
  let stopped = false;

  function applyRepulsionBetweenEveryNodePair() {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < MIN_DIST_GUARDING_DIVISION_BY_ZERO) distSq = MIN_DIST_GUARDING_DIVISION_BY_ZERO;
        const dist = Math.sqrt(distSq);
        const force = REPULSION / distSq;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        if (!a.pinned) { a.vx += fx; a.vy += fy; }
        if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
      }
    }
  }

  function applySpringForceAlongEdges() {
    for (const e of edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || MIN_DIST_GUARDING_DIVISION_BY_ZERO;
      const diff = dist - SPRING_REST_LENGTH;
      const force = SPRING_K * diff;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      if (!a.pinned) { a.vx += fx; a.vy += fy; }
      if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
    }
  }

  function applyCenterPullThenDampThenIntegrate() {
    for (const n of nodes) {
      if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
      n.vx += (cx - n.x) * CENTER_PULL;
      n.vy += (cy - n.y) * CENTER_PULL;
      n.vx *= DAMPING; n.vy *= DAMPING;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(EDGE_MARGIN, Math.min(width - EDGE_MARGIN, n.x));
      n.y = Math.max(EDGE_MARGIN, Math.min(height - EDGE_MARGIN, n.y));
    }
  }

  function tick() {
    if (stopped) return;
    applyRepulsionBetweenEveryNodePair();
    applySpringForceAlongEdges();
    applyCenterPullThenDampThenIntegrate();
    if (onTick) onTick(nodes);
    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return {
    stop() {
      stopped = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
    },
  };
}
