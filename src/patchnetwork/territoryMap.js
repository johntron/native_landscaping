/**
 * Part one's schematic: N yards scattered at random versus N yards placed
 * deliberately, and how many bird territories clear a habitat threshold either
 * way.
 *
 * **Every number in here is invented.** There is no parcel layer in this
 * project — no DCAD, no NLCD, no projection of any kind — and this draws none.
 * It is a geometric demonstration of a threshold effect, and the page labels it
 * a schematic in three places for that reason. The point it makes does not
 * depend on the specific lot count, hexagon size or corridor position; it
 * depends only on a threshold existing, which is the part worth arguing about.
 *
 * Kept as its own module with no DOM dependency beyond the SVG string it
 * returns, so the arithmetic can be tested without a browser.
 */

const R = 42;
const COLS = 6;
const ROWS = 4;
const PAD_X = 46;
const PAD_Y = 44;
const PARCELS_PER_HEX = 13;
/** Below this distance a territory counts as touching the corridor. */
const SOURCE_CONTACT = 80;

/** Deterministic, so the same slider position always draws the same picture. */
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hexPoints(cx, cy, r) {
  const points = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return points;
}

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function buildGrid(seed = 20260913) {
  const rnd = seeded(seed);
  const hexes = [];
  const parcels = [];
  const hSpace = Math.sqrt(3) * R;
  const vSpace = 1.5 * R;
  let id = 0;

  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const cx = PAD_X + col * hSpace + (row % 2 ? hSpace / 2 : 0);
      const cy = PAD_Y + row * vSpace;
      const pts = hexPoints(cx, cy, R);
      // Distance to the corridor along the bottom, with a slight west-east tiebreak.
      const srcDist = Math.abs(cy - 286) + cx * 0.06;
      const hex = { id: id++, cx, cy, pts, srcDist, parcels: [] };
      let tries = 0;
      while (hex.parcels.length < PARCELS_PER_HEX && tries < 500) {
        tries += 1;
        const px = cx + (rnd() * 2 - 1) * R * 0.8;
        const py = cy + (rnd() * 2 - 1) * R * 0.8;
        if (!inPolygon(px, py, pts)) continue;
        if (hex.parcels.some((q) => (q.x - px) ** 2 + (q.y - py) ** 2 < 150)) continue;
        const parcel = { x: px, y: py, hex: hex.id, r: rnd() };
        hex.parcels.push(parcel);
        parcels.push(parcel);
      }
      hexes.push(hex);
    }
  }
  return { hexes, parcels };
}

/**
 * Two join orders over the same parcels: random (what an opt-in program gets)
 * and saturating outward from the corridor (what targeting would get).
 */
export function buildOrders({ hexes, parcels }) {
  const scatter = parcels.slice().sort((a, b) => a.r - b.r);

  const byDistance = hexes.slice().sort((a, b) => a.srcDist - b.srcDist);
  const cluster = [];
  const taken = new Set();
  for (let round = 0; round < 40 && cluster.length < parcels.length; round += 1) {
    byDistance.forEach((hex) => {
      const cap = Math.min(hex.parcels.length, Math.ceil(hex.parcels.length * 0.6) + round * 3);
      let count = hex.parcels.filter((p) => taken.has(p)).length;
      hex.parcels.forEach((parcel) => {
        if (taken.has(parcel) || count >= cap) return;
        taken.add(parcel);
        cluster.push(parcel);
        count += 1;
      });
    });
  }
  return { scatter, cluster };
}

/** @returns {{activeIds: Set<number>, active: number, sourceTouching: number, insideActive: number, effortShare: number}} */
export function evaluate({ hexes, chosen, threshold }) {
  const counts = new Map();
  chosen.forEach((p) => counts.set(p.hex, (counts.get(p.hex) || 0) + 1));

  const activeIds = new Set();
  let sourceTouching = 0;
  hexes.forEach((hex) => {
    const share = (counts.get(hex.id) || 0) / hex.parcels.length;
    if (share >= threshold) {
      activeIds.add(hex.id);
      if (hex.srcDist < SOURCE_CONTACT) sourceTouching += 1;
    }
  });

  const insideActive = chosen.filter((p) => activeIds.has(p.hex)).length;
  return {
    activeIds,
    active: activeIds.size,
    sourceTouching,
    insideActive,
    effortShare: chosen.length ? insideActive / chosen.length : 0,
  };
}

export function renderSvg({ hexes, chosen, activeIds }) {
  const marked = new Set(chosen);
  let svg =
    '<path d="M -10 292 Q 110 268 230 288 Q 350 308 506 282 L 506 344 L -10 344 Z" fill="#7d9c68" opacity="0.18"></path>' +
    '<path d="M -10 292 Q 110 268 230 288 Q 350 308 506 282" fill="none" stroke="#5f7d4d" stroke-width="2.5" opacity="0.6"></path>' +
    '<text x="10" y="330" font-size="10" fill="#4f6b33" letter-spacing="0.06em">SOURCE HABITAT — CREEK CORRIDOR (SCHEMATIC)</text>';

  hexes.forEach((hex) => {
    const on = activeIds.has(hex.id);
    const d = hex.pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') + ' Z';
    svg += `<path d="${d}" fill="${on ? '#dbe3ec' : 'transparent'}" stroke="${on ? '#4d6b8a' : '#c3bdae'}" stroke-width="${on ? 2 : 1}"></path>`;
  });

  hexes.forEach((hex) => {
    hex.parcels.forEach((p) => {
      const on = marked.has(p);
      svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${on ? 3.5 : 2.2}" fill="${on ? '#4d6b8a' : '#e4dfd3'}" stroke="${on ? 'none' : '#c3bdae'}" stroke-width="0.8"></circle>`;
    });
  });
  return svg;
}

export function verdictText({ mode, n, active, insideActive, effortShare, sourceTouching }) {
  const pct = Math.round(effortShare * 100);
  if (mode === 'scatter') {
    return active === 0
      ? `Every one of these ${n} households did the work. Spread this thin, not one territory reaches the threshold — the effort is real and the ecological result is close to nothing.`
      : `Scattered, ${n} yards produce ${active} working ${active === 1 ? 'territory' : 'territories'}. The other ${n - insideActive} yards are isolated — good for those plants, invisible at the scale a bird forages.`;
  }
  return active === 0
    ? `Even targeted, ${n} yards is not enough to clear the threshold anywhere. That is a useful thing to know before recruiting.`
    : `The same ${n} yards, placed deliberately, yield ${active} working ${active === 1 ? 'territory' : 'territories'} — ${pct}% of the effort lands inside one, and ${sourceTouching} ${sourceTouching === 1 ? 'touches' : 'touch'} the source corridor, where recolonisation can actually come from.`;
}
