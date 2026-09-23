// Request-body readers shared by every route module.

export async function collectPayload(req, options = {}) {
  const { requirePlants = true } = options;
  const body = await collectRequestBody(req);
  if (!body) {
    throw new Error('Request body is empty');
  }
  const parsed = JSON.parse(body);
  if (requirePlants && !Array.isArray(parsed.plants)) {
    throw new Error('Missing plant list');
  }
  return parsed;
}

/**
 * Read a request body as bytes, refusing one that grows past `limit`.
 *
 * The cap is checked as chunks arrive, not at the end: a check in the 'end'
 * handler has already buffered whatever was sent. Content-Length is not
 * consulted at all — it is a claim, and the accumulated length is a fact.
 */
export function collectBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        // Pause rather than destroy: the socket has to stay alive long enough
        // to carry the 413 back, or the client sees a dropped connection and
        // has no idea why. server.js destroys it once the response is out.
        req.pause();
        const err = new Error(`Image is larger than ${Math.round(limit / 1024 / 1024)} MB`);
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
