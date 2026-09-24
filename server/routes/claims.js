import { coverageView, conflictsView } from '../../tools/claims/humanViews.js';
import { claimsCorrect } from '../../tools/claims/claimsTools.js';
import { collectPayload } from '../http.js';

/**
 * The plant-data claim store's human views (coverage, conflicts) and the
 * conflicts queue's correction submit.
 *
 * Returns true when it handled the request (a response has been sent), false
 * to let server.js try the next route module. `publicDir` is the served root,
 * which the e2e scratch server points somewhere else.
 */
export async function handleClaimsRoutes(req, res, { url, pathname, publicDir, db }) {
  // Two human-facing views over the plant-data claim store (nl-scx.10),
  // implementing docs/data-acquisition/07-mcp-introspection.md §5. Both GET
  // routes reshape the existing claims_* tool output (tools/claims/humanViews.js)
  // rather than querying data/claims.db directly — one data source for the
  // agent tools and the app views. Catalog-wide, not per-project: species and
  // fields have no yard/project scope, unlike every other route above.
  if (pathname === '/api/claims-coverage' && req.method === 'GET') {
    try {
      const rows = coverageView(db.claims(), {
        field: url.searchParams.get('field') || undefined,
        species: url.searchParams.get('species') || undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rows }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (pathname === '/api/claims-conflicts' && req.method === 'GET') {
    try {
      const rows = conflictsView(db.claims(), { field: url.searchParams.get('field') || undefined });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rows }));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // The conflicts queue's submit action. Same tool the claims_correct MCP
  // tool calls (07 §3.5/§4, 09 §4) — one write path, two callers — so this
  // route is a thin body-parse wrapper, not a second implementation.
  // `author` and `reason` come from the request body only: nothing on this
  // server authenticates a caller, so defaulting `author` to anything the
  // server already knows would fabricate attribution, exactly what 09 §2
  // requires a human to supply. `correctionsPath` is never accepted from the
  // request — the write target is fixed to the repo's own manual-corrections.tsv.
  if (pathname === '/api/claims-correct' && req.method === 'POST') {
    try {
      const body = await collectPayload(req, { requirePlants: false });
      const result = claimsCorrect(db.claims(), {
        species: body.species,
        field: body.field,
        value: body.value,
        reason: body.reason,
        author: body.author,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  return false;
}
