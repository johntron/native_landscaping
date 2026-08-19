/**
 * Build a smooth closed quadratic path through a list of points.
 * @param {Array<{ x: number, y: number }>} points
 * @returns {string}
 */
export function buildSmoothPath(points) {
  if (!points?.length) return '';
  const parts = [];
  const last = points[points.length - 1];
  const first = points[0];
  const start = midpoint(last, first);
  parts.push(`M ${start.x.toFixed(2)} ${start.y.toFixed(2)}`);

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const mid = midpoint(current, next);
    parts.push(
      `Q ${current.x.toFixed(2)} ${current.y.toFixed(2)} ${mid.x.toFixed(2)} ${mid.y.toFixed(2)}`
    );
  }

  parts.push('Z');
  return parts.join(' ');
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
