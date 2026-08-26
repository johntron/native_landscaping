import { STATUSES } from '../ecology.js';
import { getGenus } from '../../utils/speciesKey.js';

/**
 * Rule 5 — something here has to be food for a caterpillar.
 *
 * **Deliberately NOT derived from keystone membership.** The frontyard's
 * Asclepias asperula is a monarch host and Asclepias is on neither NWF top-30
 * list; grading rule 5 off the keystone columns would report that design as
 * having no larval host at all, which is plainly wrong. That is exactly why
 * host-genera.csv carries a separate, separately sourced larval_hosts column.
 *
 * Either signal counts: a named relationship in larval_hosts, or a caterpillar
 * count from the keystone list.
 */
export default {
  id: 'larval-hosts',
  title: 'Larval host plants',

  evaluate(ctx) {
    if (!ctx.hostGenera.size) {
      return {
        status: STATUSES.NOT_DECLARED,
        summary: ctx.ecoregion
          ? 'The host genus table did not load, so this check could not run.'
          : 'This project declares no ecoregion, and the host genus table is per ecoregion.',
      };
    }
    if (!ctx.plants.length) {
      return { status: STATUSES.NOT_DECLARED, summary: 'Nothing is planted yet.' };
    }

    const hosts = [...ctx.placedGenera]
      .map((genus) => ({ genus, row: ctx.hostGenera.lookup(genus) }))
      .filter(({ row }) => row && (row.larvalHosts || row.lepHostSpecies !== null));

    const named = hosts.filter(({ row }) => row.larvalHosts);
    const findings = hosts.map(({ genus, row }) =>
      row.larvalHosts
        ? `${genus} hosts ${row.larvalHosts}.`
        : `${genus} hosts ${row.lepHostSpecies} caterpillar species in this ecoregion.`
    );
    if (!hosts.length) {
      findings.push('No planted genus has a documented caterpillar host relationship on record.');
    }

    // One host genus is the bar the rule sets, but a single one is a thin thread:
    // lose that species and the design feeds nothing.
    const status = !hosts.length ? STATUSES.GAP : hosts.length === 1 ? STATUSES.PARTIAL : STATUSES.OK;
    const summary = !hosts.length
      ? 'Nothing planted here is a documented caterpillar host.'
      : hosts.length === 1
        ? `Only ${hosts[0].genus} feeds caterpillars — the whole larval food supply rests on one genus.`
        : `${hosts.length} planted genera feed caterpillars${named.length ? `, including ${named[0].genus}` : ''}.`;

    return { status, summary, findings, suggestions: suggest(ctx, hosts) };
  },
};

function suggest(ctx, hosts, limit = 3) {
  if (hosts.length > 1) return [];
  const have = new Set(hosts.map(({ genus }) => genus));
  return ctx.unplacedSpecies
    .map((entry) => ({ entry, genus: getGenus(entry), row: ctx.hostGenera.lookup(getGenus(entry)) }))
    .filter(({ genus, row }) => row && !have.has(genus) && (row.larvalHosts || row.lepHostSpecies !== null))
    .sort((a, b) => (b.row.lepHostSpecies ?? 0) - (a.row.lepHostSpecies ?? 0))
    .slice(0, limit)
    .map(
      ({ entry, genus, row }) =>
        `${entry.commonName} (${entry.botanicalName}) would add ${genus}, host to ${
          row.larvalHosts || `${row.lepHostSpecies} caterpillar species`
        }.`
    );
}
