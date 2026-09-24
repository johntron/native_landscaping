-- projects.visibility gets its allowed values (nl-3s5.4). 003 left it free
-- text with no CHECK, so nothing stopped a stray value from landing there.
--
-- Triggers rather than a CHECK: adding a CHECK in SQLite means rebuilding the
-- table, and runMigrations (server/db/migrate.js) runs each file inside
-- BEGIN IMMEDIATE, where PRAGMA foreign_keys = OFF is a no-op. With foreign
-- keys on, DROP TABLE projects would cascade through history_entries
-- (ON DELETE CASCADE) and take every yard's undo history with it. Triggers
-- enforce the same rule on every INSERT and UPDATE with no rebuild.
--
-- The database accepts both values so the deferred public-view work
-- (nl-3s5.10) needs no migration to start using 'public'. The application
-- only assigns 'private' today: server/db/projectStore.js ASSIGNABLE_VISIBILITIES,
-- and no route takes a visibility from a request. Every row was 'private'
-- when this was written (003's default; nothing wrote the column since).
CREATE TRIGGER projects_visibility_insert
BEFORE INSERT ON projects
WHEN NEW.visibility NOT IN ('private', 'public')
BEGIN
  SELECT RAISE(ABORT, 'projects.visibility must be ''private'' or ''public''');
END;

CREATE TRIGGER projects_visibility_update
BEFORE UPDATE OF visibility ON projects
WHEN NEW.visibility NOT IN ('private', 'public')
BEGIN
  SELECT RAISE(ABORT, 'projects.visibility must be ''private'' or ''public''');
END;
