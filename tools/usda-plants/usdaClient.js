// Thin client for the USDA PLANTS Database's public backend
// (plantsservices.sc.egov.usda.gov). Undocumented but stable enough in
// practice — endpoints and shapes were confirmed against the site's own
// Swagger spec at /swagger/v1/swagger.json. No API key; be polite.
//
// Known constraint: the site's own bulk "plants-search-results" endpoint
// (POST, filters by county/state/etc.) reliably returns HTTP 500
// "Execution Timeout Expired" server-side, regardless of payload shape —
// this looks like a bug/capacity issue on USDA's end, not something a
// different request body fixes. Retrying it in a loop would just hammer a
// broken endpoint, so callers should treat searchByLocation failures as
// terminal and fall back to searchByName for a curated species list.

const BASE = "https://plantsservices.sc.egov.usda.gov/api";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class UsdaClient {
  // requestDelayMs is the minimum gap between outgoing requests — the "be a
  // nice user" knob. USDA publishes no documented rate limit, so default to
  // a conservative 1 request/second.
  constructor({ requestDelayMs = 1000, timeoutMs = 20000, maxRetries = 2 } = {}) {
    this.requestDelayMs = requestDelayMs;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this._lastRequestAt = 0;
  }

  async _throttle() {
    const wait = this._lastRequestAt + this.requestDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this._lastRequestAt = Date.now();
  }

  async _request(path, { method = "GET", body } = {}) {
    return this._send(path, { method, body, parse: (res) => res.json() });
  }

  // Same throttle/retry machinery as _request, but for an endpoint that
  // returns text/csv rather than JSON — getDistributionCsv below.
  async _requestText(path, { method = "GET", body } = {}) {
    return this._send(path, { method, body, parse: (res) => res.text() });
  }

  async _send(path, { method = "GET", body, parse } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this._throttle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${BASE}${path}`, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`USDA API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
        }
        return await parse(res);
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (attempt < this.maxRetries) await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  // Full state/province/country location list (small, static-ish). Use to
  // resolve a state name to its PlantLocationId.
  async listStates() {
    const data = await this._request("/StateSearch");
    return data.Locations;
  }

  async resolveState(stateName) {
    const states = await this.listStates();
    const match = states.find(
      (s) => s.PlantLocationName.toLowerCase() === stateName.trim().toLowerCase(),
    );
    if (!match) throw new Error(`Unknown state/province: "${stateName}"`);
    return match;
  }

  async listCounties(stateId) {
    return this._request(`/StateSearch/GetCounties/${stateId}`);
  }

  async resolveCounty(stateId, countyName) {
    const counties = await this.listCounties(stateId);
    const wanted = countyName.trim().toLowerCase().replace(/\s+county$/, "");
    const match = counties.find((c) => c.PlantLocationName.toLowerCase() === wanted);
    if (!match) throw new Error(`Unknown county "${countyName}" for that state`);
    return match;
  }

  // Best-effort: mirrors the site's own "Advanced Filters" location search.
  // Observed to fail server-side with a SQL timeout regardless of payload —
  // see the class-level comment. Callers should catch and fall back.
  async searchByLocation({ stateLocationId, countyLocationId } = {}) {
    const body = { pageNumber: 1, sortBy: "ScientificName" };
    if (countyLocationId) {
      body.counties = [{ plantLocationId: countyLocationId }];
    } else if (stateLocationId) {
      body.locations = [{ plantLocationId: stateLocationId }];
    }
    return this._request("/plants-search-results", { method: "POST", body });
  }

  // Name/symbol/family autocomplete search. Reliable and fast.
  async searchByName(searchText) {
    const results = await this._request(
      `/PlantSearch?searchText=${encodeURIComponent(searchText)}`,
    );
    return results.map((r) => r.Plant);
  }

  // The full ~2,000-species pool of plants USDA has characteristics data
  // for. No filters are honored server-side (this always returns
  // everything); filter the array client-side. This is the reliable
  // fallback when searchByLocation's endpoint is unavailable.
  async listCharacterizedPlants() {
    return this._request("/characteristicSearchResults");
  }

  // Full Name/Value/Category characteristics table for one species, keyed by
  // its internal numeric id (from searchByName / listCharacterizedPlants).
  async getCharacteristics(plantId) {
    return this._request(`/PlantCharacteristics/${plantId}`);
  }

  // General profile: symbol, scientific/common name, growth habit(s), and
  // coarse (region-level, not state/county) native status.
  async getProfile(plantId) {
    return this._request(`/PlantProfile/${plantId}`);
  }

  // County-level distribution — the "misleadingly named" dedicated endpoint
  // measured in docs/data-acquisition/01-goals-and-required-fields.md §3.1.
  // Despite the name, it returns text/csv, not documentation:
  //   Distribution Data
  //   Symbol,Country,State,State FIP,County,County FIP
  //   QUSH,United States,Texas,48,Dallas,113
  // The first line is a title, not a header — callers must drop it before
  // parsing. `masterId` is the same numeric plant Id used elsewhere.
  async getDistributionCsv(masterId) {
    return this._requestText("/PlantProfile/getDownloadDistributionDocumentation", {
      method: "POST",
      body: { masterId },
    });
  }
}
