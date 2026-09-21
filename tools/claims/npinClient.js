// Thin client for LBJ Wildflower Center's NPIN species pages
// (wildflower.org/plants/result.php?id_plant=<USDA symbol>), per
// docs/data-acquisition/02-source-inventory.md §2.3.
//
// **Treat NPIN as usable, rate-unknown, terms-unread** (02 §2.3's verdict):
// species pages were measured reachable by plain `curl` with a browser
// User-Agent on exactly three symbols (CHLI2, QUSH, ILVO — actually PRME;
// QUSH's own NPIN id differs from its USDA symbol, re-measured 2026-09-21).
// robots.txt/terms/copyright all return a Cloudflare challenge and were
// never read, so no declared crawl-delay exists to honor. The conservative
// choice here is the same one usdaClient.js made for an *undocumented but
// stable* API with no published limit: throttle client-side to a
// deliberately slow default and never retry aggressively.
const BASE = "https://www.wildflower.org/plants/result.php";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NpinClient {
  // requestDelayMs: the minimum gap between outgoing requests. 3s/request is
  // slower than usdaClient.js's 1s default on purpose — NPIN's rate limit is
  // genuinely unknown (02 §2.3), where USDA's is merely undocumented, so this
  // errs further toward polite. Record whatever value a caller actually used
  // (ingestNpinClaims reports it) rather than assuming this default forever.
  constructor({
    requestDelayMs = 3000,
    timeoutMs = 20000,
    maxRetries = 2,
    userAgent = "native_landscaping (personal, non-commercial research project; contact: john.syrinek@gmail.com)",
  } = {}) {
    this.requestDelayMs = requestDelayMs;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.userAgent = userAgent;
    this._lastRequestAt = 0;
  }

  async _throttle() {
    const wait = this._lastRequestAt + this.requestDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this._lastRequestAt = Date.now();
  }

  /**
   * Fetch the raw HTML for one species' NPIN page. A symbol NPIN doesn't
   * recognize redirects (302) to the plain search page, which `fetch`
   * follows transparently to a 200 with no species content — this method
   * returns that HTML as-is; npinIngest.js's isResolvedSpeciesPage is what
   * tells the two apart, not the HTTP status.
   */
  async fetchSpeciesPage(usdaSymbol) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this._throttle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${BASE}?id_plant=${encodeURIComponent(usdaSymbol)}`, {
          headers: { "User-Agent": this.userAgent },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          throw new Error(`NPIN ${usdaSymbol} -> HTTP ${res.status}`);
        }
        return await res.text();
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (attempt < this.maxRetries) await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastError;
  }
}
