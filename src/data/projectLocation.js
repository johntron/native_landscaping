/**
 * The browser side of a yard's location (nl-3s5.30): read it, look up what
 * the owner typed, save the confirmed match, or clear it. Every call goes to
 * this app's own server, which geocodes through tools/geocode.mjs; the
 * browser never calls a geocoder itself.
 *
 * Each returns `{ ok, status, data }` rather than throwing on an HTTP error,
 * so the panel can say what the server said (a 409 "look it up first", a 422
 * "no match", a 429 "slow down").
 */

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { cache: 'no-store', ...options });
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the server' } };
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data: data || {} };
}

const query = (projectId) => `?project=${encodeURIComponent(projectId)}`;
const post = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** @param {string} projectId */
export function fetchProjectLocation(projectId) {
  return request(`/api/project-location${query(projectId)}`);
}

/** Geocode `text` and return the match; writes nothing. */
export function previewProjectLocation(projectId, text) {
  return request(`/api/project-location/preview${query(projectId)}`, post({ query: text }));
}

/** Save the match for `text` (which must have been previewed). */
export function saveProjectLocation(projectId, text) {
  return request(`/api/project-location${query(projectId)}`, post({ query: text }));
}

export function clearProjectLocation(projectId) {
  return request(`/api/project-location${query(projectId)}`, post({ clear: true }));
}
