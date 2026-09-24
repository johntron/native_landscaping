/** The read-only server, as Node (not the page) reaches it. */
const MAIN_BASE = `http://127.0.0.1:${Number(process.env.E2E_PORT) || 8123}`;

/** The write-safe server; see scratch-fixture.mjs. */
export const SCRATCH_BASE = `http://127.0.0.1:${(Number(process.env.E2E_PORT) || 8123) + 1}`;

// Yards live in each server's app.db (nl-3s5.3), so the specs read what was
// saved through the same API the page uses. Node's fetch sends no identity
// header, and the e2e servers make every request the seeded owner
// (DEV_USER_EMAIL), so these see exactly the yards the page does.
async function apiText(base, route, projectId) {
  const response = await fetch(`${base}${route}?project=${encodeURIComponent(projectId)}`);
  if (!response.ok) throw new Error(`${route} for ${projectId} answered ${response.status}`);
  return response.text();
}

/** Parse the exported layout CSV (id,species_id,x_ft,y_ft) into rows keyed by its header. */
function parseLayoutCsv(csv) {
  const [header, ...lines] = csv.split(/\r?\n/).filter((line) => line.trim());
  const columns = header.split(',').map((name) => name.trim());
  return lines.map((line) => {
    const cells = line.split(',');
    const row = {};
    columns.forEach((name, i) => {
      row[name] = cells[i];
    });
    return row;
  });
}

/**
 * A yard's layout on the read-only server (the entry at its cursor, as GET
 * /api/layout exports it), as {id, speciesId, xFt, yFt} rows.
 */
export async function readLayoutRows(projectId) {
  return parseLayoutCsv(await apiText(MAIN_BASE, '/api/layout', projectId)).map((row) => ({
    id: row.id,
    speciesId: (row.species_id || '').trim(),
    xFt: Number.parseFloat(row.x_ft),
    yFt: Number.parseFloat(row.y_ft),
  }));
}

/**
 * Open a project and wait for the first render. Every plan-view plant is a <g>
 * stamped with data-plant-id by renderTopView, so their presence is the signal
 * that loading, parsing, and rendering all completed.
 */
export async function openProject(page, projectId) {
  await page.goto(`/design.html?project=${projectId}`);
  await page.locator('#topSvg g[data-plant-id]').first().waitFor();
}

/** Open a project on the write-safe server, for specs that save. */
export async function openScratchProject(page, projectId) {
  await page.goto(`${SCRATCH_BASE}/design.html?project=${projectId}`);
  await page.locator('#topSvg g[data-plant-id]').first().waitFor();
}

/** A scratch yard's saved history, `{ entries, cursor }`; null if it has none yet. */
export async function readScratchHistory(projectId) {
  const history = JSON.parse(await apiText(SCRATCH_BASE, '/api/history', projectId));
  return history.entries.length ? history : null;
}

/** A scratch yard's saved layout (the entry at its cursor) as {id, x, y} rows. */
export async function readScratchLayout(projectId) {
  return parseLayoutCsv(await apiText(SCRATCH_BASE, '/api/layout', projectId)).map((row) => ({
    id: row.id,
    x: Number(row.x_ft),
    y: Number(row.y_ft),
  }));
}

/** A scratch yard's saved features, or [] if it has none. */
export async function readScratchFeatures(projectId) {
  return JSON.parse(await apiText(SCRATCH_BASE, '/api/features', projectId)).features || [];
}

/**
 * Point at a plant the way the app's own hit test will find it.
 *
 * Plan views hit-test geometrically, and the label <text> is drawn at exactly
 * the plant's centre — the one point guaranteed to be inside the hit radius.
 * Elevations hit-test through the DOM and their labels carry
 * pointer-events: none, so those aim at the silhouette instead. Guessing with a
 * bounding box picks up the label's own extent and misses.
 */
export async function plantPointerTarget(page, svgId, kind = 'plan') {
  // page.mouse works in viewport coordinates and does not scroll.
  await page.locator(`#${svgId}`).scrollIntoViewIfNeeded();
  return page.evaluate(
    ([id, viewKind]) => {
      const svg = document.getElementById(id);
      const rect = svg.getBoundingClientRect();
      const box = svg.viewBox.baseVal;
      const toScreen = (x, y) => ({
        x: rect.left + (x * rect.width) / box.width,
        y: rect.top + (y * rect.height) / box.height,
      });
      const group = svg.querySelector('g[data-plant-id]');
      const label = group.querySelector('text');
      if (viewKind === 'plan' && label) {
        return {
          id: group.getAttribute('data-plant-id'),
          ...toScreen(Number(label.getAttribute('x')), Number(label.getAttribute('y'))),
        };
      }
      const bounds = group.querySelector('path').getBBox();
      return {
        id: group.getAttribute('data-plant-id'),
        ...toScreen(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
      };
    },
    [svgId, kind]
  );
}

/**
 * Drag inside a panel and report what happened. `grabbed` distinguishes "the
 * hit test found nothing" from "the drag was refused", which is the difference
 * between a broken test and a broken app.
 */
export async function dragInPanel(page, svgId, { kind = 'plan', dx = 45, dy = 25 } = {}) {
  const target = await plantPointerTarget(page, svgId, kind);
  const snapshot = () =>
    page.evaluate(
      (id) =>
        [...document.querySelectorAll(`#${id} g[data-plant-id]`)]
          .map((g) => g.getAttribute('data-plant-id') + (g.querySelector('path')?.getAttribute('d') || ''))
          .join('|'),
      svgId
    );

  const before = await snapshot();
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  const grabbed =
    (await page.evaluate((id) => document.getElementById(id).style.cursor, svgId)) === 'grabbing';
  await page.mouse.move(target.x + dx, target.y + dy, { steps: 8 });
  await page.mouse.up();
  return { grabbed, moved: (await snapshot()) !== before };
}

/**
 * Drive a real touch gesture through CDP.
 *
 * page.mouse never produces touch input and page.touchscreen only taps, so
 * neither exercises `touch-action` — a gesture built on them would pass against
 * an app whose drags are being stolen by the scroller. Input.dispatchTouchEvent
 * goes in as genuine touch, which the compositor routes through touch-action
 * the same way a finger does.
 *
 * The move is stepped rather than jumped: the scroll threshold is crossed by
 * accumulated movement, and one big hop can miss it in either direction.
 */
export async function touchGesture(page, { x, y, dx = 0, dy = 0, steps = 10, holdMs = 0 }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  if (holdMs) await page.waitForTimeout(holdMs);
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * step) / steps, y: y + (dy * step) / steps }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Where a plant sits in yard feet, straight off the app's own state. */
export async function plantPosition(page, plantId) {
  return page.evaluate((id) => {
    const group = document.querySelector(`#topSvg g[data-plant-id="${id}"]`);
    if (!group) return null;
    const label = group.querySelector('text');
    return label ? { x: Number(label.getAttribute('x')), y: Number(label.getAttribute('y')) } : null;
  }, plantId);
}
