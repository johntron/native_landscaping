/**
 * Compress a photo in the browser, then upload it as a view's background.
 *
 * The re-encode is not only about size. The bytes that reach the server are
 * ones this code produced from decoded pixels, so whatever the original file
 * carried alongside its image — EXIF, colour profiles, an appended archive, a
 * second format hiding behind a valid header — does not survive the round trip.
 * The server still checks what it is handed; this just means the normal path
 * never sends it anything strange.
 *
 * The canvas work is injectable so the sizing and quality logic can be tested
 * without a DOM.
 */

/**
 * Backgrounds are sampled at more than panel resolution: a detail view crops a
 * sub-rectangle out of the full photo (src/render/backgroundCrop.js), so a
 * photo sized to the 800 px panel would be soft as soon as it was cropped into.
 * 2400 px keeps roughly a 3x crop sharp; below ~1600 the crops visibly soften.
 */
export const MAX_BACKGROUND_EDGE_PX = 2400;

/** What the ladder aims for. A yard photo at this size is visually clean. */
export const TARGET_BACKGROUND_BYTES = 800 * 1024;

/**
 * Descending quality, tried in order until the blob fits the target. Starting
 * at 0.86 rather than 0.9 because the difference is invisible on foliage and
 * costs about a third of the bytes; stopping at 0.55 because below that WebP
 * starts smearing the fine texture of gravel and leaves, which is most of what
 * these photos are.
 */
export const QUALITY_LADDER = [0.86, 0.78, 0.7, 0.62, 0.55];

/** A guard on the picked file, before anything tries to decode it. */
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

/**
 * Scale `width` × `height` down to fit inside `maxEdge`, preserving aspect.
 * An image already inside the box is left alone rather than upscaled.
 */
export function fitWithin(width, height, maxEdge) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const longest = Math.max(w, h);
  if (!Number.isFinite(maxEdge) || maxEdge <= 0 || longest <= maxEdge) {
    return { width: w, height: h };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Decode, downscale, and encode a picked file.
 *
 * @param {File|Blob} file
 * @param {{ maxEdge?: number, targetBytes?: number, ladder?: number[],
 *           decode?: Function, encode?: Function }} [options]
 * @returns {Promise<{ blob: Blob, contentType: string, width: number, height: number, quality: number }>}
 */
export async function compressBackgroundImage(file, options = {}) {
  const {
    maxEdge = MAX_BACKGROUND_EDGE_PX,
    targetBytes = TARGET_BACKGROUND_BYTES,
    ladder = QUALITY_LADDER,
    decode = decodeImage,
    encode = encodeCanvas,
  } = options;

  if (!file) throw new Error('Choose an image file');
  if (typeof file.type === 'string' && file.type && !file.type.startsWith('image/')) {
    throw new Error(`${file.type} is not an image`);
  }
  // SVG is refused here as well as on the server: it is a script-capable
  // document, and there is nothing for a raster encoder to usefully do with it.
  if (file.type === 'image/svg+xml') {
    throw new Error('SVG cannot be used as an uploaded background');
  }
  if (typeof file.size === 'number' && file.size > MAX_SOURCE_BYTES) {
    throw new Error(`Image is larger than ${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)} MB`);
  }

  const source = await decode(file);
  const { width, height } = fitWithin(source.width, source.height, maxEdge);

  // toBlob does not throw for a format it cannot encode — it quietly hands back
  // a PNG instead. So the first attempt is a probe: whatever type comes back is
  // the format the rest of the ladder uses, and the server's allowlist covers
  // all three possible answers.
  let contentType = 'image/webp';
  let best = await encode(source, width, height, contentType, ladder[0]);
  if (best.type && best.type !== contentType) {
    contentType = best.type === 'image/png' ? 'image/jpeg' : best.type;
    best = await encode(source, width, height, contentType, ladder[0]);
    if (best.type) contentType = best.type;
  }
  let quality = ladder[0];

  for (let i = 1; i < ladder.length && best.size > targetBytes; i += 1) {
    quality = ladder[i];
    best = await encode(source, width, height, contentType, quality);
  }

  source.close?.();
  return { blob: best, contentType, width, height, quality };
}

/**
 * POST the compressed bytes as the raw request body.
 *
 * There is no multipart envelope and no filename: the server names the file
 * from the view id and a hash of the content, so nothing the client could put
 * in a filename ever reaches the filesystem.
 *
 * @returns {Promise<string>} the new background path, relative to the project
 */
export async function uploadViewBackground({ projectId, viewId, blob, contentType, fetchFn }) {
  const doFetch = fetchFn || (typeof fetch === 'function' ? fetch : globalThis.fetch);
  if (!doFetch) throw new Error('Uploading requires running `node server.js`');
  if (!viewId) throw new Error('Missing view id');

  const query = new URLSearchParams({ project: projectId || '', view: viewId });
  const response = await doFetch(`/api/view-background?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType || blob.type || 'image/webp' },
    body: blob,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error || `Background upload failed (${response.status})`);
  }
  const data = await response.json();
  if (!data || typeof data.background !== 'string') {
    throw new Error('Server did not return a background path');
  }
  return data.background;
}

/**
 * `imageOrientation` is what keeps a phone photo from landing sideways — the
 * EXIF rotation is applied during decode and then baked into the pixels we
 * encode. The options overload is not universal, so a browser that rejects it
 * falls back to a plain decode rather than failing the upload.
 */
async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    return await createImageBitmap(file);
  }
}

function encodeCanvas(source, width, height, contentType, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(source, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image'))),
      contentType,
      quality
    );
  });
}
