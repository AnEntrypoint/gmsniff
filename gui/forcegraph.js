// Minimal O(n^2) force-directed layout: Coulomb repulsion between every node
// pair + Hooke spring along edges + velocity damping, driven by a
// requestAnimationFrame loop. No dependencies -- plain physics on node.x/y/vx/vy.
//
// runForceLayout(nodes, edges, {width, height}) mutates node.x/node.y in place
// every frame and invokes onTick(nodes) so the caller can re-paint SVG
// positions. Returns a handle { stop() } -- callers MUST call stop() on
// unmount/hide to cancel the RAF loop and avoid a leaked timer.

const REPULSION = 2600;     // Coulomb-like repulsion constant
const SPRING_K = 0.02;      // Hooke spring constant along edges
const SPRING_LEN = 90;      // rest length for spring edges
const DAMPING = 0.85;       // velocity damping per tick
const MIN_DIST = 1;         // avoid division blowups at near-zero distance
const CENTER_PULL = 0.002;  // gentle pull toward container center to avoid drift

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

  function tick() {
    if (stopped) return;

    // Coulomb repulsion, all pairs
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < MIN_DIST) distSq = MIN_DIST;
        const dist = Math.sqrt(distSq);
        const force = REPULSION / distSq;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        if (!a.pinned) { a.vx += fx; a.vy += fy; }
        if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
      }
    }

    // Hooke spring along edges
    for (const e of edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || MIN_DIST;
      const diff = dist - SPRING_LEN;
      const force = SPRING_K * diff;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      if (!a.pinned) { a.vx += fx; a.vy += fy; }
      if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
    }

    // Gentle center pull + damping + integrate
    for (const n of nodes) {
      if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
      n.vx += (cx - n.x) * CENTER_PULL;
      n.vy += (cy - n.y) * CENTER_PULL;
      n.vx *= DAMPING; n.vy *= DAMPING;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(10, Math.min(width - 10, n.x));
      n.y = Math.max(10, Math.min(height - 10, n.y));
    }

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
