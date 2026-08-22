/**
 * Utility helpers for exporting the three orthographic views to PNG blobs.
 */

const DEFAULT_EXPORT_SCALE = 2;

/** .view's background-color in styles.css — the letterbox behind a placed photo. */
const PANEL_COLOR = '#f2f0eb';

/**
 * Render a view (background + SVG overlay) into a PNG blob.
 *
 * `destRect` is where the background image lands in the drawing, in viewBox
 * pixels from the top-left. A view's rectangle is derived from the yard, so the
 * photo is placed inside it rather than stretched to fill it (see
 * render/photoPlacement.js); without this the export would stretch every photo
 * across a panel it may cover only part of.
 *
 * @param {{ svg: SVGSVGElement, viewBox: { width: number, height: number }, backgroundUrl?: string, destRect?: { x: number, y: number, width: number, height: number }, scale?: number }} params
 * @returns {Promise<Blob>}
 */
export async function captureViewToPng({
  svg,
  viewBox,
  backgroundUrl,
  destRect,
  scale = DEFAULT_EXPORT_SCALE,
}) {
  if (!svg || !viewBox) throw new Error('Missing SVG or viewBox for capture');
  const width = Math.round(viewBox.width * scale);
  const height = Math.round(viewBox.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context unavailable');

  // The panel's own surface, painted first. On screen a photo that covers only
  // part of the panel sits on .view's background-color; without this the export
  // left that margin transparent, and since a view is the yard plus a margin on
  // every side, that is now every export rather than an odd one.
  ctx.fillStyle = PANEL_COLOR;
  ctx.fillRect(0, 0, width, height);

  if (backgroundUrl) {
    const bg = await loadImage(backgroundUrl);
    if (destRect) {
      // A destination rect, not a source rect: a placed photo is as often
      // smaller than the panel as larger, and a source rect reaching outside
      // the image does not clip the way the CSS background does.
      ctx.drawImage(
        bg,
        destRect.x * scale,
        destRect.y * scale,
        destRect.width * scale,
        destRect.height * scale
      );
    } else {
      ctx.drawImage(bg, 0, 0, width, height);
    }
  }

  const svgUrl = await serializeSvgToUrl(svg, viewBox, { scale });
  try {
    const overlay = await loadImage(svgUrl);
    ctx.drawImage(overlay, 0, 0, width, height);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }

  const pngBlob = await new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
  if (!pngBlob) throw new Error('Failed to create PNG blob');
  return pngBlob;
}

async function serializeSvgToUrl(svg, viewBox, { scale }) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(viewBox.width * scale));
  clone.setAttribute('height', String(viewBox.height * scale));
  const serializer = new XMLSerializer();
  const markup = serializer.serializeToString(clone);
  const blob = new Blob([markup], { type: 'image/svg+xml' });
  return URL.createObjectURL(blob);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = url;
  });
}
