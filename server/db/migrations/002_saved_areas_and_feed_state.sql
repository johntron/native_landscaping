-- Saved monitoring areas and the feed's read/dismissed flags move here from
-- their own files, data/saved-areas.db and data/feed-state.db (nl-3s5.11), so
-- that owner_id can be a real foreign key to users and every hand-entered
-- table lives in one file to back up. Columns and semantics are unchanged from
-- tools/savedAreas/savedAreasDb.js and tools/feedState/feedStateDb.js; the
-- rows are copied over once by server/db/legacyImport.js.

-- owner_id is nullable on purpose: areas are not per-user yet. nl-3s5.5 makes
-- them per-user and decides whether to enforce it (NOT NULL, or scoping every
-- query by owner). An area whose owner is deleted loses its owner, not itself.
CREATE TABLE saved_areas (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  radius_mi    REAL NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  owner_id     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX saved_areas_owner_id ON saved_areas (owner_id);

-- No owner or viewer column: the flags stay keyed by (observation_id,
-- area_id), exactly as before. Making them per viewer means putting a user id
-- in the primary key, and a nullable column there would break the ON CONFLICT
-- upsert in setFeedState (NULLs never conflict), so that is a table rebuild for
-- nl-3s5.5 to decide, not a column to add now. No foreign key from area_id to
-- saved_areas either: deleting an area never cascaded to its flags, so the
-- legacy file can hold rows for areas that no longer exist.
CREATE TABLE feed_state (
  observation_id INTEGER NOT NULL,
  area_id        TEXT NOT NULL,
  read           INTEGER NOT NULL DEFAULT 0,
  dismissed      INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (observation_id, area_id)
);

-- Small key/value facts about this database itself, such as "the legacy
-- import of saved_areas has run" (server/db/legacyImport.js), so one-time work
-- is recorded once and never repeated.
CREATE TABLE app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
