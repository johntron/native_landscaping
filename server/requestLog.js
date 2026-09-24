// One compact log line per request, wired up once in server.js via
// res.on('finish', ...). Errors otherwise reach console.error with no
// context: no method, path, user, or timing.
//
// Never logs the query string, bodies, headers, JWTs or emails: queries can
// carry precise coordinates (e.g. /api/ecoregion?lat=..&lng=..) and this repo
// keeps coordinates out of logs and git (AGENTS.md "Privacy and licensing").
//
// Mode is controlled by REQUEST_LOG (default 'api'):
//   all  - every request
//   api  - /api/* requests, plus any non-2xx/3xx response to any path
//          (static-asset 200s are the bulk of traffic and carry nothing
//          worth a log line; a failing static request is still worth
//          seeing)
//   off  - nothing
export const VALID_REQUEST_LOG_MODES = ['all', 'api', 'off'];

/**
 * @param {string | undefined} raw
 * @returns {'all' | 'api' | 'off'}
 */
export function resolveRequestLogMode(raw) {
  return VALID_REQUEST_LOG_MODES.includes(raw) ? /** @type {any} */ (raw) : 'api';
}

/**
 * @param {'all' | 'api' | 'off'} mode
 * @param {string} pathname path only, no query string
 * @param {number} status
 * @returns {boolean}
 */
export function shouldLogRequest(mode, pathname, status) {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  // mode === 'api'
  if (pathname.startsWith('/api/')) return true;
  return status < 200 || status >= 400;
}

/**
 * @param {object} entry
 * @param {string} entry.method
 * @param {string} entry.pathname path only, no query string
 * @param {number} entry.status
 * @param {string | number | null | undefined} entry.userId ctx.user?.id, or falsy for anonymous
 * @param {number} entry.durationMs
 * @returns {string}
 */
export function formatRequestLog({ method, pathname, status, userId, durationMs }) {
  const user = userId === null || userId === undefined || userId === '' ? '-' : `u${userId}`;
  const duration = Math.max(0, Math.round(durationMs));
  // Safety net: server.js already passes url.pathname (query-free), but cut
  // at the first `?` or `#` here too so this module's own guarantee doesn't
  // depend on every caller getting that right.
  const path = String(pathname).split(/[?#]/)[0];
  return `${method} ${path} ${status} ${user} ${duration}ms`;
}
