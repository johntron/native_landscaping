/**
 * Utility helpers for exporting the three orthographic views to PNG blobs.
 */

const DEFAULT_EXPORT_SCALE = 2;

/**
 * Render a view (background + SVG overlay) into a PNG blob.
 * @param {{ svg: SVGSVGElement, viewBox: { width: number, height: number }, backgroundUrl?: string, scale?: number }} params
 * @returns {Promise<Blob>}
 */
export async function captureViewToPng({ svg, viewBox, backgroundUrl, scale = DEFAULT_EXPORT_SCALE }) {
  if (!svg || !viewBox) throw new Error('Missing SVG or viewBox for capture');
  const width = Math.round(viewBox.width * scale);
  const height = Math.round(viewBox.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context unavailable');

  if (backgroundUrl) {
    const bg = await loadImage(backgroundUrl);
    ctx.drawImage(bg, 0, 0, width, height);
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
