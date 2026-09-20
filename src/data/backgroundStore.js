import path from 'node:path';
import { isValidProjectId } from './projectConfig.js';

/**
 * Server-side rules for storing an uploaded view background.
 *
 * The upload arrives as a raw image body rather than multipart: there is one
 * file, its name is not the client's to choose, and a parser we would have to
 * write ourselves is the largest attack surface in the whole feature. Keeping
 * the body opaque bytes means nothing here decodes the image — the only things
 * inspected are its length, its declared type, and its first few bytes.
 *
 * Everything in this module is pure so the guards can be tested without a
 * socket; server.js supplies the I/O.
 */

/** Backgrounds live beside the project's other assets. */
export const BACKGROUND_DIR = 'img';

/**
 * 8 MB is far above anything the client encoder produces (it aims for well
 * under 1 MB) and far below what an unbounded buffer costs us. The cap exists
 * for bodies that never went through our encoder at all.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * The upload allowlist, deliberately short.
 *
 * SVG is absent on purpose and must stay absent: serveStaticFile hands `.svg`
 * back as image/svg+xml, which browsers execute script from, so an uploaded SVG
 * is stored XSS against every future visitor to the project. The three raster
 * formats here are all identifiable from their first bytes, which is what makes
 * the sniff below meaningful.
 */
const IMAGE_TYPES = [
  { contentType: 'image/webp', ext: '.webp', matches: isWebp },
  { contentType: 'image/jpeg', ext: '.jpg', matches: isJpeg },
  { contentType: 'image/png', ext: '.png', matches: isPng },
];

/** Strip parameters and casing from a Content-Type header. */
export function parseContentType(header) {
  return String(header || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/** The allowlist entry for a declared content type, or null. */
export function imageTypeForContentType(header) {
  const contentType = parseContentType(header);
  return IMAGE_TYPES.find((type) => type.contentType === contentType) || null;
}

/**
 * The allowlist entry the bytes themselves claim, or null.
 *
 * A declared Content-Type is just a string the client chose. This is what stops
 * an HTML document being stored as `north.webp` and later served back under a
 * content type that renders it.
 */
export function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return IMAGE_TYPES.find((type) => type.matches(buffer)) || null;
}

/**
 * Where an upload for `viewId` lands, given the project directory that
 * resolveProjectPaths already validated.
 *
 * The name is built here from a validated id, a content hash, and an extension
 * derived from the sniffed type — never from anything the client sent. The hash
 * is what makes a re-upload a *different* path: the app sets `background` to
 * this string, and a stable name would produce an identical string that no
 * renderer has any reason to re-fetch, so replacing a photo would appear to do
 * nothing.
 *
 * @param {{ projectDir: string, viewId: string, contentHash: string, ext: string }} options
 */
export function resolveBackgroundTarget({ projectDir, viewId, contentHash, ext }) {
  // View ids are slugs on the same conservative pattern as project ids, and for
  // the same reason: this one becomes a filename.
  if (!isValidProjectId(viewId)) {
    throw new Error(`Invalid or missing view id "${viewId}"`);
  }
  if (!/^[0-9a-f]{8,64}$/.test(String(contentHash || ''))) {
    throw new Error('Invalid content hash');
  }
  const known = IMAGE_TYPES.find((type) => type.ext === ext);
  if (!known) {
    throw new Error(`Unsupported image extension "${ext}"`);
  }

  const relativePath = `${BACKGROUND_DIR}/${viewId}-${contentHash}${ext}`;
  const dir = path.join(projectDir, BACKGROUND_DIR);
  const file = path.resolve(dir, `${viewId}-${contentHash}${ext}`);
  // Belt and braces over the id check above: the path that gets written must
  // still be inside the project's own img/ directory.
  if (file !== path.join(dir, `${viewId}-${contentHash}${ext}`)) {
    throw new Error('Background path escapes the project directory');
  }
  return { dir, file, relativePath };
}

/**
 * Earlier uploads for the same view, so a replacement does not leave the old
 * photo behind forever. Content-addressed names mean one file per upload, and
 * only the view that owns the prefix can be matched.
 *
 * @param {string[]} entries directory listing of the project's img/
 * @param {string} viewId
 * @param {string} keepFileName the upload that just succeeded
 */
export function supersededBackgrounds(entries, viewId, keepFileName) {
  if (!isValidProjectId(viewId)) return [];
  const pattern = new RegExp(`^${viewId}-[0-9a-f]{8,64}\\.(webp|jpg|png)$`);
  return (Array.isArray(entries) ? entries : []).filter(
    (name) => name !== keepFileName && pattern.test(name)
  );
}

/** Matches any view's content-addressed upload, not just one view's. */
const ANY_BACKGROUND_PATTERN = /^[a-z0-9][a-z0-9_-]*-[0-9a-f]{8,64}\.(webp|jpg|png)$/;

/**
 * Uploaded backgrounds that no view's `background` path references any more.
 *
 * Content-addressed names make this safe: a file this pattern matches was
 * only ever written by the upload handler, and if the current project config
 * does not name it, nothing else can be pointing at it either — including an
 * upload the user made and then abandoned by closing the tab before Setup
 * mode's Save views ran.
 *
 * @param {string[]} entries directory listing of the project's img/
 * @param {string[]} referencedFileNames basenames of every view's `background`
 */
export function orphanedBackgrounds(entries, referencedFileNames) {
  const referenced = new Set(referencedFileNames);
  return (Array.isArray(entries) ? entries : []).filter(
    (name) => ANY_BACKGROUND_PATTERN.test(name) && !referenced.has(name)
  );
}

function isWebp(buffer) {
  return (
    buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP'
  );
}

function isJpeg(buffer) {
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isPng(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, index) => buffer[index] === byte);
}
