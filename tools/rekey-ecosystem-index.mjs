#!/usr/bin/env node
/**
 * One-time move of the nearby-species index from place labels to yards
 * (nl-3s5.6). Before it, data/ecosystem.db's species_observations was keyed by
 * a yard's free-text `place`; now rows belong to one app.db projects.id
 * (tools/ecosystemIndexDb.js). This copies one place's old rows to each of one
 * owner's yards that has that place AND a location, and records each copy as
 * a ready build for that yard's current location, so the page shows the same
 * species it did, at once, with no iNaturalist request.
 *
 * Without it nothing is lost, only delayed: feed-poller builds every located
 * yard that has no index (tools/ecosystemIndexQueue.js), replaying from the
 * probe cache when the same requests were made before. This tool is for a
 * deploy that must not show "building…" even for one tick, and for keeping
 * exactly the rows the page showed.
 *
 * What it trusts: that the old rows were fetched for these yards' current
 * location. So it refuses when the matching yards have different locations
 * (the rows can describe at most one of them), unless --project narrows it to
 * one yard. It never prints a location.
 *
 * Idempotent: a yard that already has a ready index for its current location
 * (copied before, or built by feed-poller first) is skipped. The old table is
 * left as it is, so rolling back to the previous code still works; drop it by
 * hand once the new code has settled.
 *
 * Usage:
 *   node tools/rekey-ecosystem-index.mjs --place home [--owner <email>] [--project <slug>] [--dry-run]
 */
import { findOwner } from '../server/db/legacyImport.js';
import { listOwnerProjectSites } from '../server/db/projectSites.js';
import { openAppDbReadOnly, ownerFromArgs } from './projectSite.mjs';
import {
  indexStatus,
  listLegacyPlaceRows,
  locationKey,
  markBuildFinished,
  markBuildStarted,
  openEcosystemDb,
  replaceTaxonRows,
} from './ecosystemIndexDb.js';

/**
 * @param {object} args
 * @param {import('node:sqlite').DatabaseSync} args.appDb
 * @param {import('node:sqlite').DatabaseSync} args.ecosystemDb
 * @param {number} args.ownerId
 * @param {string} args.place
 * @param {string} [args.slug] only this yard
 * @param {boolean} [args.dryRun]
 * @returns {{ legacyRows: number, copied: string[], skipped: Array<{ slug: string, why: string }> }}
 */
export function rekeyPlace({ appDb, ecosystemDb, ownerId, place, slug, dryRun = false }) {
  const legacy = listLegacyPlaceRows(ecosystemDb, place);
  const result = { legacyRows: legacy.length, copied: [], skipped: [] };
  if (!legacy.length) return result;

  const targets = listOwnerProjectSites(appDb, ownerId).filter(
    (site) => site.place === place && (!slug || site.slug === slug)
  );
  const located = [];
  for (const site of targets) {
    const key = locationKey(site.location);
    if (!key) result.skipped.push({ slug: site.slug, why: 'no location' });
    else located.push({ ...site, key });
  }
  const keys = new Set(located.map((site) => site.key));
  if (keys.size > 1) {
    throw new Error(
      `Yards with place "${place}" have ${keys.size} different locations (${located.map((s) => s.slug).join(', ')}); ` +
        'the old rows describe at most one. Pass --project <slug> for the yard they were fetched for.'
    );
  }

  const byTaxon = new Map();
  for (const row of legacy) {
    if (!byTaxon.has(row.iconic_taxon)) byTaxon.set(row.iconic_taxon, []);
    byTaxon.get(row.iconic_taxon).push(row);
  }
  const fetchedOn = legacy.map((row) => row.fetched_on).sort().at(-1);

  for (const site of located) {
    if (indexStatus(ecosystemDb, site.id, site.key).state === 'ready') {
      result.skipped.push({ slug: site.slug, why: 'already has a ready index for its location' });
      continue;
    }
    if (!dryRun) {
      markBuildStarted(ecosystemDb, site.id, site.key);
      for (const [taxon, rows] of byTaxon) replaceTaxonRows(ecosystemDb, site.id, taxon, rows);
      markBuildFinished(ecosystemDb, site.id, { state: 'ready', fetchedOn });
    }
    result.copied.push(site.slug);
  }
  return result;
}

function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const place = argAfter(args, '--place');
  if (!place) {
    console.error('Usage: node tools/rekey-ecosystem-index.mjs --place <label> [--owner <email>] [--project <slug>] [--dry-run]');
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');
  const appDb = openAppDbReadOnly();
  try {
    const ownerEmail = ownerFromArgs(args) ?? process.env.OWNER_EMAIL;
    const owner = findOwner(appDb, ownerEmail);
    if (!owner) {
      throw new Error(
        ownerEmail ? `No user ${ownerEmail} in app.db` : 'Whose yards? Pass --owner <email> or set OWNER_EMAIL'
      );
    }
    const ecosystemDb = openEcosystemDb();
    const result = rekeyPlace({ appDb, ecosystemDb, ownerId: owner.id, place, slug: argAfter(args, '--project'), dryRun });
    console.log(`Old rows for place "${place}": ${result.legacyRows}`);
    console.log(`${dryRun ? 'Would copy' : 'Copied'} to: ${result.copied.join(', ') || '(none)'}`);
    for (const { slug, why } of result.skipped) console.log(`Skipped ${slug}: ${why}`);
  } finally {
    appDb.close();
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
