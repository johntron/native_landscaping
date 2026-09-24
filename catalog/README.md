# catalog/

Regional plant lists and the human corrections file that feed the claim store
(`tools/claims/`). The app's own species catalog is still `plants.csv` at the
repo root. That file is the one every yard renders from, and nothing here
replaces it.

| file | read by | what it is |
| --- | --- | --- |
| `blackland-prairie-natives.csv` | `tools/claims/*`, `src/patchnetwork/patchNetworkPage.js`, tests | 467 Blackland Prairie natives in the `plants.csv` schema plus USDA fields; the wider catalog the flora screen and claim rebuild run over |
| `dfw-avoid-non-natives.csv` | `src/patchnetwork/patchNetworkPage.js` | 13 invasive or problem non-natives; the homepage's "No invasives" list |
| `dfw-nctx-natives.csv` | nothing reads it; cited as evidence in `tools/claims/unsourceableRegister.js` | 61-row DFW subset, kept because the register points at it |
| `species-synonyms.csv` | `src/data/speciesResolver.js` (via `src/app.js`), `tools/migrate-species-ids.mjs` | older or alternative names that resolve to a plants.csv species id, generated from the claim store's `taxa.resolves_to` by `tools/link-species-taxa.mjs`; lets a legacy layout or import that names a species find its id. Regenerate, don't hand-edit |
| `manual-corrections.tsv` | `tools/claims/*`, `server.js` (via `claimsCorrect`) | hand corrections replayed last on every claim rebuild; the system of record for a correction (docs/data-acquisition/09 §2) |

These were at the repo root until 2026-09-22. The draft files nothing read
(`dfw-needs-manual-data.txt`, `dfw-already-in-plants-csv.csv`,
`dfw-plant-list-names.txt`, `blackland-prairie-species-names.txt`,
`texas-usda-plants.csv`) were deleted then. `docs/data-acquisition/` still
mentions some of them by name; they are in git history at `d19e78f`.
