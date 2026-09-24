-- Yards move here from projects/<slug>/ on disk (nl-3s5.3): project.json,
-- features.json, the gitignored layout-history.json and location.json. The
-- layout is no longer a file of its own: history is the truth, and the layout
-- is the entry at history_cursor (planting_layout.csv is only an export now,
-- GET /api/layout). Photos stay files, under DATA_DIR/projects/<id>/img/,
-- outside the served root (server/db/projectStore.js).
--
-- Slugs are unique per owner, not globally: ?project=<slug> is resolved
-- against the caller (server/http.js loadOwnedProject). An owner who is
-- deleted does not take their yards with them silently: NO ACTION, so the
-- delete fails while they own any.
--
-- config_json and features_json hold the JSON exactly as it was saved (the
-- import copies the files' text verbatim) and are normalized on read, as the
-- files were; features_json is NULL for a yard that never drew a feature.
-- location_json is the old location.json ({ lat, lng } and/or { address },
-- plus provenance), NULL when none was ever set. It never leaves the server
-- except as { lat, lng } to the yard's owner (/api/ecosystem).
--
-- visibility is 'private' for every yard today; nl-3s5.4 decides the other
-- values and enforces them, so there is no CHECK yet.
CREATE TABLE projects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id       INTEGER NOT NULL REFERENCES users(id),
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'private',
  config_json    TEXT NOT NULL,
  features_json  TEXT,
  location_json  TEXT,
  -- Index (seq) of the history entry the yard shows; -1 while it has none.
  history_cursor INTEGER NOT NULL DEFAULT -1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (owner_id, slug)
);

-- One row per undoable layout step. seq runs 0..n-1 with no gaps: a save
-- after an undo deletes the entries past the cursor (the redo tail) and
-- appends, exactly as the old file did. entry_id is the id the client adopts
-- for the entry; created_at keeps the old file's timestamp verbatim.
-- plants_json is the entry's placements (src/data/placements.js).
CREATE TABLE history_entries (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  entry_id    TEXT NOT NULL,
  description TEXT NOT NULL,
  plants_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, seq)
);
