# Data notices for ecology/

## `anchors.csv`

Rows whose `source` is **OpenStreetMap via Overpass** (parks, cemeteries, and
other green space) are derived from OpenStreetMap data,
© OpenStreetMap contributors, and are available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
See <https://www.openstreetmap.org/copyright>. A database derived from those
rows must be offered under the ODbL; a work produced from them (such as the
"Habitat nearby" list on `ecosystem.html`) must credit OpenStreetMap and say
the data is available under the ODbL, which that page does.

Rows whose `source` is **hydro.nationalmap.gov** (streams) come from the U.S.
Geological Survey's National Hydrography Dataset. USGS-authored data is in the
U.S. public domain; credit: U.S. Geological Survey.

Both notices were checked against the sources' own pages on 2026-09-23
(nl-3hi.7.6, item 3).

## Other tables

Each row in every `ecology/*.csv` names its own source in the `source` column
(enforced by `tests/sourcedTables.test.js`).
