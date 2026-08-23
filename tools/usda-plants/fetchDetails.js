import { mapPlantToIntermediateRow } from "./mapCharacteristics.js";

// Fetches full profile + characteristics for each candidate and maps it to
// an intermediate-CSV row. Candidates need only {Id}; everything else comes
// back from the API. Rate limiting is handled by the UsdaClient instance
// passed in (its requestDelayMs applies to every call here, in order — two
// USDA requests per plant).
//
// onProgress(done, total, current) is optional, for CLI/MCP progress output.
export async function fetchPlantDetails(client, candidates, { onProgress } = {}) {
  const rows = [];
  const errors = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      // Sequenced, not Promise.all'd — the client's throttle only serializes
      // calls that await each other, and this loop is exactly the "one
      // request in flight at a time" behavior a rate limiter should produce.
      const profile = await client.getProfile(candidate.Id);
      const characteristics = await client.getCharacteristics(candidate.Id);
      rows.push(mapPlantToIntermediateRow(profile, characteristics));
    } catch (err) {
      errors.push({ candidate, error: err.message });
    }
    if (onProgress) onProgress(i + 1, candidates.length, candidate);
  }
  return { rows, errors };
}
