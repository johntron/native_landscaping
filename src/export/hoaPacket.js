import { getSpeciesKey } from '../utils/speciesKey.js';

/**
 * Cover letter for an HOA/ARC submission packet — plain text so it opens
 * anywhere, meant to accompany the plan/elevation PNGs and species list the
 * bundle export already produces. Cites mirror rights.html; keep the two in
 * sync if the statute text there changes.
 */
export function buildHoaCoverLetter({ projectName, species, preparedOn }) {
  const lines = [];
  const add = (line = '') => lines.push(line);

  add(`HOA / ARC SUBMISSION — DROUGHT-RESISTANT LANDSCAPING PLAN`);
  add(`Property: ${projectName}`);
  add(`Prepared: ${preparedOn}`);
  add('');
  add(
    `This packet is the detailed description and plan for a proposed drought-resistant ` +
      `installation, submitted for review and approval under Texas Property Code Sec. ` +
      `202.007(d)(8). It includes a to-scale plan drawing, elevation drawing(s), and the ` +
      `species list below.`
  );
  add('');
  add('WHAT THE ASSOCIATION MAY NOT DO (Texas Property Code Ch. 202)');
  add(
    `- Sec. 202.007(a)(4): may not prohibit or restrict, or have the effect of prohibiting or ` +
      `restricting, an owner from using drought-resistant landscaping or water-conserving ` +
      `natural turf.`
  );
  add(
    `- Sec. 202.007(d-1): may not unreasonably deny or withhold approval of this installation, ` +
      `or unreasonably determine it is aesthetically incompatible with the rest of the ` +
      `development.`
  );
  add(
    `- Sec. 202.008 (H.B. 517, eff. 9/1/2025): may not fine an owner because the owner's lawn ` +
      `is brown, dry, or otherwise discolored as a result of a drought or water restriction, or ` +
      `during the 60 days after a watering restriction affecting the property is lifted.`
  );
  add('');
  add('LIMITS THAT STILL APPLY (do not oversell this)');
  add(`- (c): the association may restrict the type of turf used in new plantings.`);
  add(`- (d)(4): the association may regulate gravel, rocks, or cacti — hardscape is not protected the way plants are.`);
  add(`- (d)(5): the association may regulate yard/landscape maintenance, so long as that does not restrict water-conserving design.`);
  add(`- (e): Sec. 202.007 does not apply to certain large-acreage associations in specific counties — check whether this carve-out reaches this association before relying on the rest of this letter.`);
  add('');
  add(`SPECIES LIST (${species.length} species)`);
  species.forEach((entry) => {
    const name = entry.commonName ? `${entry.commonName} (${entry.botanicalName})` : entry.botanicalName;
    add(`- ${name}${entry.count > 1 ? ` × ${entry.count}` : ''}`);
  });
  add('');
  add(
    `This letter states what the statute says; it is not legal advice and does not cover ` +
      `municipal ordinances, which vary by city. Current through the 89th Legislature, 2nd ` +
      `Called Session (2025) — verify against statutes.capitol.texas.gov before relying on it.`
  );

  return lines.join('\n');
}

/**
 * One row per distinct species actually placed, counted like the ecology
 * engine counts them (src/analysis/ecology.js dedupeBySpecies) — a drift of
 * nineteen asters is one line, not nineteen.
 */
export function summarizePlacedSpecies(plants) {
  const byKey = new Map();
  plants.forEach((plant) => {
    const key = getSpeciesKey(plant);
    if (!key) return;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, {
        commonName: plant.commonName || '',
        botanicalName: plant.botanicalName || '',
        count: 1,
      });
    }
  });
  return [...byKey.values()].sort((a, b) =>
    (a.commonName || a.botanicalName).localeCompare(b.commonName || b.botanicalName)
  );
}
