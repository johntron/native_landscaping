// Resolves a location string ("Texas", "Dallas County, Texas") and returns
// species candidates for the fetch-details step. See usdaClient.js for why
// searchByLocation is best-effort: USDA's own bulk location-filter endpoint
// has been observed to fail server-side with a SQL timeout on every payload
// shape tried, independent of state/county size. When it fails, this throws
// a descriptive error rather than silently returning nothing or hammering
// the endpoint with retries — callers (CLI/MCP tool) should surface that to
// the user and suggest searchByName as a fallback for a curated list.

export function parseLocationCriteria(criteria) {
  // "Dallas County, Texas" / "Dallas, Texas" / "Texas"
  const parts = criteria
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1) return { state: parts[0], county: null };
  const [countyPart, statePart] = parts;
  return { state: statePart, county: countyPart.replace(/\s+county$/i, "") };
}

// NOTE: the shape of a *successful* searchByLocation response is unverified
// — every payload tried against USDA's endpoint during development returned
// a 500 SQL timeout, never a 200. The swagger spec for POST
// /api/plants-search-results documents only the request body
// (PlantsSearchResultCriteria) and a bare "200 OK" with no response schema.
// If/when this succeeds, confirm the actual field names (id vs Id, etc.)
// before trusting downstream code that reads `r.Id ?? r.id`.
export async function searchByLocationCriteria(client, criteria) {
  const { state, county } = parseLocationCriteria(criteria);
  const stateLoc = await client.resolveState(state);
  const countyLoc = county ? await client.resolveCounty(stateLoc.PlantLocationId, county) : null;

  let results;
  try {
    results = await client.searchByLocation({
      stateLocationId: stateLoc.PlantLocationId,
      countyLocationId: countyLoc?.PlantLocationId,
    });
  } catch (err) {
    throw new Error(
      `USDA's location-search endpoint failed for "${criteria}" (${err.message}). ` +
        `This endpoint is known to be unreliable server-side. Fall back to usda_search_by_name ` +
        `with specific species you already have in mind, or pick species manually from ` +
        `https://plants.usda.gov/state-search and pass them to usda_search_by_name.`,
    );
  }
  return { state: stateLoc, county: countyLoc, results };
}

// USDA's ScientificName includes the taxonomic author after the italicized
// binomial/trinomial, e.g. "<i>Abies concolor</i> (Gord. & Glend.) Lindl. ex
// Hildebr." — extract just the italic part so a plain "Abies concolor" query
// can match without the caller needing to know the author citation.
export function binomialOf(scientificName) {
  const italic = scientificName?.match(/<i>(.*?)<\/i>/);
  return (italic ? italic[1] : scientificName?.replace(/<[^>]+>/g, "")) ?? "";
}

export async function searchByNames(client, names) {
  const out = [];
  for (const name of names) {
    const matches = await client.searchByName(name);
    const wanted = name.trim().toLowerCase();
    const exact = matches.find(
      (m) =>
        binomialOf(m.ScientificName).trim().toLowerCase() === wanted ||
        m.ScientificName?.replace(/<[^>]+>/g, "").trim().toLowerCase() === wanted ||
        m.CommonName?.trim().toLowerCase() === wanted ||
        m.Symbol?.trim().toLowerCase() === wanted,
    );
    if (exact) {
      out.push({ query: name, match: exact, alternatives: [] });
    } else if (matches.length) {
      out.push({ query: name, match: null, alternatives: matches.slice(0, 5) });
    } else {
      out.push({ query: name, match: null, alternatives: [] });
    }
  }
  return out;
}
