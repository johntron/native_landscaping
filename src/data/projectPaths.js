import path from 'node:path';

/**
 * Server-side resolution of a yard's photo files.
 *
 * Since nl-3s5.3 a yard's config, features, location and history live in
 * app.db (server/db/projectStore.js), and only its photos are files, under
 * DATA_DIR/projects/<projects.id>/img/ (projectDataDir). The path a view's
 * `background` names arrives from the client and becomes a path, so it is held
 * to the shape the upload handler writes (plus the shipped .svg drawings and
 * un-hashed names the older yards carry) and re-checked for containment.
 */
const PHOTO_PATH = /^img\/[A-Za-z0-9_-]+\.(?:webp|png|jpe?g|svg)$/;

/**
 * @param {string} projectDir the yard's directory under DATA_DIR (projectDataDir)
 * @param {string} relativePath e.g. "img/plan-130d05047b7d.webp"
 * @returns {string | null} the absolute file path, or null if the path is not a photo path
 */
export function resolveProjectPhoto(projectDir, relativePath) {
  const rel = String(relativePath || '');
  if (!PHOTO_PATH.test(rel)) return null;
  const file = path.resolve(projectDir, rel);
  if (file !== path.join(projectDir, rel)) return null;
  return file;
}

/** Pull the project id out of a request URL's query string. */
export function projectIdFromUrl(url) {
  return url.searchParams.get('project') || '';
}
