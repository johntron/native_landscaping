import { collectPayload, createRateLimiter, enforceRateLimit, json, rateLimitKeyFor, requireAdmin } from '../http.js';
import { listSaleNotes, createSaleNote, deleteSaleNote, MAX_BODY_LENGTH } from '../db/saleNotesStore.js';

// Raw notes an admin jots down on a plant sale they've found (nl-2bw): read
// later, researched, and turned by hand into a sourced row of
// sourcing/plant-sales.csv (see AGENTS.md's "Buy plants" row and
// tools/list-sale-notes.mjs). Never fed into that CSV automatically.
//
// Admin-only (same reasoning as server/routes/claims.js, nl-3s5.7):
// sourcing.html is a public page (nl-3s5.8), so a non-admin or anonymous
// caller must get the same 404 a missing route gets, never a 403 that would
// confirm this exists. src/sourcing/saleNotesPage.js hides its whole section
// on anything but a 200 from the list endpoint.

const SALE_NOTES_PATH = /^\/api\/sale-notes(?:\/(\d+))?$/;

// A homeowner jotting down a few sales they found is nowhere near this
// capacity; it exists to blunt a scripted flood of rows, same judgement as
// the other light limiters in this file's siblings (server/routes/feed.js,
// server/routes/ecosystem.js).
const createLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 1 });

/**
 * Returns true when it handled the request (a response has been sent), false
 * to let server.js try the next route module.
 */
export async function handleSaleNotesRoutes(req, res, ctx) {
  const { pathname, db } = ctx;
  const match = SALE_NOTES_PATH.exec(pathname);
  if (!match) return false;
  if (!requireAdmin(ctx, res)) return true;

  const idParam = match[1];

  if (req.method === 'GET' && !idParam) {
    json(res, 200, { notes: listSaleNotes(db.app) });
    return true;
  }

  if (req.method === 'POST' && !idParam) {
    if (!enforceRateLimit(createLimiter, rateLimitKeyFor(ctx, req), res)) return true;
    let body;
    try {
      body = await collectPayload(req, { requirePlants: false });
    } catch (err) {
      json(res, 400, { error: err.message });
      return true;
    }
    const trimmed = typeof body.body === 'string' ? body.body.trim() : '';
    if (!trimmed) {
      json(res, 400, { error: 'body must not be empty' });
      return true;
    }
    if (trimmed.length > MAX_BODY_LENGTH) {
      json(res, 400, { error: `body must be ${MAX_BODY_LENGTH} characters or fewer` });
      return true;
    }
    const note = createSaleNote(db.app, { authorId: ctx.user.id, body: trimmed });
    json(res, 201, { note });
    return true;
  }

  if (req.method === 'DELETE' && idParam) {
    const deleted = deleteSaleNote(db.app, Number(idParam));
    if (!deleted) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    json(res, 200, { id: Number(idParam), deleted: true });
    return true;
  }

  json(res, 405, { error: `Method ${req.method} not allowed on ${pathname}` });
  return true;
}
