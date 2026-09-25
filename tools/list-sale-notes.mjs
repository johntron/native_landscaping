#!/usr/bin/env node
/**
 * Print the admin-entered sale notes (nl-2bw, server/db/migrations/006_sale_notes.sql)
 * for the owner or an agent to read and research. Opens app.db read-only,
 * so it is safe to run against the live data/ while web is up.
 *
 *   node tools/list-sale-notes.mjs
 *
 * DATA_DIR picks the directory (default data/ under the repo), same as every
 * other tools/*Db.js store (tools/dataDir.js).
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { resolveDataDir } from './dataDir.js';
import { listSaleNotes } from '../server/db/saleNotesStore.js';

const dataDir = resolveDataDir();
const db = new DatabaseSync(join(dataDir, 'app.db'), { readOnly: true });
try {
  const notes = listSaleNotes(db);
  if (!notes.length) {
    console.log('No sale notes saved yet.');
  } else {
    for (const note of notes) {
      console.log(`#${note.id}  ${note.createdAt}  (${note.authorEmail})`);
      console.log(note.body);
      console.log('---');
    }
    console.log(`${notes.length} note(s).`);
  }
} finally {
  db.close();
}
