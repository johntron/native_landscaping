-- Species a person has marked favorite / most wanted (nl-3on): one row per
-- (user, plants.csv species id). Per person, not per yard: wanting a species
-- is about the person, and the shopping list (nl-46b) reads it across all of
-- their yards. species_id is plants.csv's id, checked by the route
-- (server/routes/favorites.js); it is not a foreign key because the catalog is
-- a committed file, not a table. Additive only, like 006.
CREATE TABLE species_favorites (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, species_id)
);
