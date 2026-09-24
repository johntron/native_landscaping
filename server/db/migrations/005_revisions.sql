-- One revision stream per yard (nl-3s5.20). Until now only the planting had
-- history: the setup (projects.config_json) and the features
-- (projects.features_json) were overwritten on every save, with nothing to
-- undo to. Now every save of any of the three appends a row to
-- history_entries, and the three share one seq per project, so undo, redo and
-- the cursor step across all of them.
--
-- Each row is a FULL snapshot of the yard at that revision: plants_json (the
-- placements, as before), config_json and features_json (both small). So
-- restoring any revision is one row read, never a replay. `kind` says which
-- of the three that save changed ('planting' | 'setup' | 'features').
--
-- projects.config_json, features_json and name stay, as the current copy:
-- every save and every cursor move rewrites them from the revision at the
-- cursor in the same transaction (server/db/projectStore.js), so the readers
-- of the projects row (GET /api/project, GET /api/features,
-- tools/projectSite.mjs) are unchanged. A yard with no revisions yet (cursor
-- -1) has only that copy.
--
-- Additive only: ALTER TABLE ADD COLUMN and an UPDATE, no table rebuild.
-- runMigrations runs this inside BEGIN IMMEDIATE, where PRAGMA foreign_keys =
-- OFF is a no-op, so a DROP of projects would cascade through history_entries
-- (see 004). Nothing here drops, deletes or rewrites an existing column.
--
-- Existing entries become planting revisions carrying the CURRENT config and
-- features: there is no older setup or features history to give them. Their
-- seq, entry_id, description, plants_json, created_at and every cursor are
-- untouched.
ALTER TABLE history_entries
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'planting'
  CHECK (kind IN ('planting', 'setup', 'features'));

-- NULL features_json means "never drew a feature", as on projects.
ALTER TABLE history_entries ADD COLUMN config_json TEXT;
ALTER TABLE history_entries ADD COLUMN features_json TEXT;

UPDATE history_entries
SET config_json = (SELECT p.config_json FROM projects p WHERE p.id = history_entries.project_id),
    features_json = (SELECT p.features_json FROM projects p WHERE p.id = history_entries.project_id);

-- config_json is required on every revision. ADD COLUMN cannot declare NOT
-- NULL without a default, so triggers hold the rule, as 004 does for
-- visibility.
--
-- An INSERT without one is filled, not refused: it can only come from code
-- older than 5.20 (tools/deploy.sh restarts on the previous commit when a
-- deploy fails, and this migration stays applied), which writes the six
-- pre-005 columns. Filling it from the projects row is exactly what the new
-- code carries (the current setup and features), so a rolled-back server
-- keeps saving plants instead of failing every POST /api/layout. Only when
-- config_json is NULL: a new-code row with features_json NULL means "no
-- features drawn" and is left alone.
CREATE TRIGGER history_entries_config_fill
AFTER INSERT ON history_entries
WHEN NEW.config_json IS NULL
BEGIN
  UPDATE history_entries
  SET config_json = (SELECT p.config_json FROM projects p WHERE p.id = NEW.project_id),
      features_json = (SELECT p.features_json FROM projects p WHERE p.id = NEW.project_id)
  WHERE project_id = NEW.project_id AND seq = NEW.seq;
END;

CREATE TRIGGER history_entries_config_update
BEFORE UPDATE OF config_json ON history_entries
WHEN NEW.config_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'history_entries.config_json is required');
END;
