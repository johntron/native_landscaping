-- Raw notes an admin jots down on plant sales they've found (nl-2bw), to be
-- read later and turned into a sourced row of sourcing/plant-sales.csv by
-- hand. Admin-only end to end (server/routes/saleNotes.js requireAdmin), so
-- author_id is never nullable: a note always has the admin who wrote it.
-- Additive only: no ALTER of an existing table, so this needs none of 005's
-- care about BEGIN IMMEDIATE/foreign_keys interactions.
CREATE TABLE sale_notes (
  id         INTEGER PRIMARY KEY,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sale_notes_created_at ON sale_notes (created_at);
