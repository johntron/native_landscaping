/**
 * The NPSOT chapter demo page.
 *
 * Part one is the territory schematic (src/patchnetwork/territoryMap.js).
 * Part two is the screened keystone table (src/analysis/keystoneScreen.js).
 *
 * Everything is read from files already in this repository — no API call, no
 * font CDN, no remote asset — because the meeting wifi is unreliable and a demo
 * that degrades on stage is worse than no demo.
 */
import { fetchCsv } from '../data/csvLoader.js';
import { loadProjectConfig, resolveActiveProjectId } from '../data/projectConfig.js';
import { buildHostGeneraIndex } from '../analysis/hostGenera.js';
import { buildNearbyFaunaIndex } from '../analysis/faunaMatches.js';
import { TIERS, tierInfo } from '../analysis/provenance.js';
import {
  buildFnctScreenIndex,
  buildGrowthIndex,
  buildLepHostIndex,
  buildNameChangeIndex,
  screenKeystoneGenera,
  GROWTH_TIERS,
  VERDICTS,
} from '../analysis/keystoneScreen.js';
import { buildGrid, buildOrders, evaluate, renderSvg, verdictText } from './territoryMap.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ Part 1 */

const grid = buildGrid();
const orders = buildOrders(grid);
const mapState = { n: 44, mode: 'scatter', threshold: 0.4 };

function renderMap() {
  const chosen = orders[mapState.mode].slice(0, mapState.n);
  const result = evaluate({ hexes: grid.hexes, chosen, threshold: mapState.threshold });

  $('pnHexMap').innerHTML = renderSvg({ hexes: grid.hexes, chosen, activeIds: result.activeIds });
  $('pnRoHex').textContent = result.active;
  $('pnRoHexSub').textContent = `of ${grid.hexes.length} in the study frame`;
  $('pnRoEff').textContent = `${Math.round(result.effortShare * 100)}%`;
  $('pnRoEffSub').textContent = `${result.insideActive} of ${mapState.n} participating yards`;
  $('pnRoSrc').textContent = result.sourceTouching;
  $('pnVerdict').textContent = verdictText({ mode: mapState.mode, n: mapState.n, ...result });
}

function wireMap() {
  $('pnRange').addEventListener('input', (e) => {
    mapState.n = Number(e.target.value);
    renderMap();
  });
  $('pnThreshold').addEventListener('change', (e) => {
    mapState.threshold = Number(e.target.value);
    renderMap();
  });
  const setMode = (mode) => {
    mapState.mode = mode;
    $('pnScatter').setAttribute('aria-pressed', String(mode === 'scatter'));
    $('pnCluster').setAttribute('aria-pressed', String(mode === 'cluster'));
    renderMap();
  };
  $('pnScatter').addEventListener('click', () => setMode('scatter'));
  $('pnCluster').addEventListener('click', () => setMode('cluster'));
  renderMap();
}

/* ------------------------------------------------------------------ Part 2 */

let allRows = [];
let selected = null;

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

function tierBadge(tier) {
  const info = tierInfo(tier);
  return `<span class="pn-tier pn-tier--${escapeHtml(tier)}" title="${escapeHtml(info.note)}">${escapeHtml(info.short)}</span>`;
}

function renderTierKey() {
  $('pnTierKey').innerHTML = [
    '<strong style="color:#5a5548">Provenance:</strong>',
    ...Object.keys(TIERS).map((key) => `${tierBadge(key)} ${escapeHtml(TIERS[key].label)}`),
  ].join(' ');
}

function matchesFilters(row, { verdict, habit, search }) {
  if (verdict === 'recommendable' && !(row.inCatalog && row.verdict === 'confirmed-local')) return false;
  if (verdict === 'confirmed-local' && row.verdict !== 'confirmed-local') return false;
  if (verdict === 'flora-cited' && !row.lepHostCount) return false;
  if (verdict === 'rejected' && row.verdict !== 'rejected') return false;
  if (verdict === 'renamed' && row.verdict !== 'renamed') return false;
  if (habit && row.habit !== habit) return false;
  if (search) {
    const hay = [
      row.genus,
      ...row.lepHosts.map((h) => `${h.common} ${h.species}`),
    ]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(search.toLowerCase())) return false;
  }
  return true;
}

function renderTable() {
  const filters = {
    verdict: $('pnVerdictFilter').value,
    habit: $('pnHabitFilter').value,
    search: $('pnSearch').value.trim(),
  };
  const rows = allRows.filter((r) => matchesFilters(r, filters));

  $('pnRows').innerHTML =
    rows
      .map((row) => {
        const verdict = VERDICTS[row.verdict] || { label: row.verdict };
        const tierClass = row.verdict === 'rejected' ? ' class="pn-rejected"' : '';
        return `<tr${tierClass} data-genus="${escapeHtml(row.genus)}">
        <td><span class="pn-genus">${escapeHtml(row.genus)}</span> ${tierBadge(row.tier)}${
          row.inCatalog
            ? ''
            : ' <span class="pn-hostonly" title="FNCT records Lepidoptera using this genus. That is not a recommendation to plant it — the genus is not in the Blackland natives catalog and may include introduced species.">host record only</span>'
        }</td>
        <td><span class="pn-verdict-chip pn-v-${escapeHtml(row.verdict)}">${escapeHtml(verdict.label)}</span></td>
        <td>${escapeHtml(row.growthTier ? row.growthTier.room : '—')}</td>
        <td class="num">${row.maxHeightFt === null ? '—' : `${Math.round(row.maxHeightFt)} ft`}</td>
        <td class="num">${row.lepHostSpecies ?? '—'}</td>
        <td class="num">${row.beeSpecialistSpecies ?? '—'}</td>
        <td class="num">${row.lepHostCount || '—'}</td>
        <td class="num">${row.confirmedCount ? `<span class="pn-near">${row.confirmedCount}</span>` : '—'}</td>
      </tr>`;
      })
      .join('') || '<tr><td colspan="8">Nothing matches those filters.</td></tr>';

  $('pnCount').textContent = `${rows.length} of ${allRows.length} genera`;

  $('pnRows').querySelectorAll('tr[data-genus]').forEach((tr) => {
    tr.addEventListener('click', () => {
      selected = allRows.find((r) => r.genus === tr.dataset.genus) || selected;
      renderDetail();
    });
  });

  if (!selected || !rows.includes(selected)) {
    selected = rows[0] || allRows[0] || null;
  }
  renderDetail();
}

function renderDetail() {
  if (!selected) {
    $('pnDetail').innerHTML = '<p class="data-note">Select a genus.</p>';
    return;
  }
  const row = selected;
  const verdict = VERDICTS[row.verdict] || { label: row.verdict, note: '' };

  const hosts = row.lepHosts
    .slice()
    .sort((a, b) => a.species.localeCompare(b.species))
    .reduce((acc, host) => {
      if (!acc.some((h) => h.species === host.species)) acc.push(host);
      return acc;
    }, []);
  const nearSet = new Set(row.confirmedNearby.map((c) => c.species));

  const hostList = hosts.length
    ? `<ul class="pn-hostlist">${hosts
        .map((h) => {
          const near = row.confirmedNearby.find((c) => c.species === h.species);
          const flag = near
            ? ` <span class="pn-near">— reported within ${near.nearestRadiusMi} mi</span>`
            : '';
          const inferred = h.nameInferred ? ' <em title="Expanded from an abbreviation in the printed table">(name expanded)</em>' : '';
          return `<li>${escapeHtml(h.common || '—')} <span class="sci">${escapeHtml(h.species)}</span>${inferred}${flag}</li>`;
        })
        .join('')}</ul>`
    : '<p class="data-note">Appendix Ten names no Lepidoptera for this genus.</p>';

  const cites = [];
  if (row.fnctPage) cites.push(`FNCT p. ${escapeHtml(row.fnctPage)} — ${escapeHtml(row.fnctHeading)}`);
  if (row.lepHostPages.length) cites.push(`Appendix Ten pp. ${row.lepHostPages.map(escapeHtml).join(', ')}`);
  if (row.nwfSource) cites.push(`NWF: ${escapeHtml(row.nwfSource)}`);

  $('pnDetail').innerHTML = `
    <h3>${escapeHtml(row.genus)}</h3>
    <p><span class="pn-verdict-chip pn-v-${escapeHtml(row.verdict)}">${escapeHtml(verdict.label)}</span> ${tierBadge(row.tier)}</p>
    <p style="font-size:0.86rem;color:#4a4a44;margin:0.4rem 0 0">${escapeHtml(verdict.note)}</p>
    <dl>
      <dt>In the flora</dt><dd>${
        row.fnctTreated
          ? `Yes — p. ${escapeHtml(row.fnctPage)}${row.fnctUnderName ? ` (as <i>${escapeHtml(row.fnctUnderName)}</i>)` : ''}`
          : 'No treatment'
      }</dd>
      <dt>Dallas Co.</dt><dd>${row.fnctDallas ? 'Named in the treatment' : 'Not named'}</dd>
      <dt>Room</dt><dd>${escapeHtml(row.growthTier ? `${row.growthTier.label} — ${row.growthTier.room}` : 'Not in the catalog')}</dd>
      <dt>Mature height</dt><dd>${row.maxHeightFt === null ? '—' : `${Math.round(row.maxHeightFt)} ft`}</dd>
      <dt>NWF claim</dt><dd>${row.lepHostSpecies ?? '—'} caterpillar spp., ${row.beeSpecialistSpecies ?? '—'} specialist bees</dd>
    </dl>
    ${row.fnctDallasEvidence ? `<p class="pn-cite">&ldquo;${escapeHtml(row.fnctDallasEvidence)}&rdquo;</p>` : ''}
    ${
      row.inCatalog
        ? ''
        : '<p class="pn-warn"><strong>A record, not a recommendation.</strong> The flora documents Lepidoptera using this genus, which is not the same as advice to plant it. It is not in the Blackland natives catalog, and some genera on this list are introduced or weedy — <i>Stenotaphrum</i> (St. Augustine turf) carries a confirmed skipper. Check the species before recommending anything here.</p>'
    }
    ${row.renamedNote ? `<p class="pn-mine"><strong>Renamed since 1999.</strong> ${escapeHtml(row.renamedNote)}<br><span style="font-size:0.76rem">${escapeHtml(row.renamedSource)}</span></p>` : ''}
    ${row.habitConflict ? `<p class="pn-mine"><strong>My call, not the source's.</strong> ${escapeHtml(row.habitConflict)}</p>` : ''}
    ${row.curatedLarvalHosts ? `<p class="pn-mine"><strong>Hand-added, weaker provenance.</strong> ${escapeHtml(row.curatedLarvalHosts)}</p>` : ''}
    <p style="margin:0.7rem 0 0;font-size:0.78rem;letter-spacing:0.06em;text-transform:uppercase;color:#7a7566">
      Larval hosts in the flora (${hosts.length})${nearSet.size ? ` — ${nearSet.size} confirmed nearby` : ''}
    </p>
    ${hostList}
    <p class="pn-cite">${cites.map((c) => escapeHtml(c)).join('<br>')}</p>
  `;
}

/**
 * The six genera the talk actually walks through, pinned above the scrollable
 * table. Chosen to span the argument rather than to top any ranking: a canopy
 * tree the keystone list and the flora agree on, the tree only the flora
 * carries, a forb, and the two the keystone list gets wrong in the two
 * different ways it gets things wrong.
 */
const COMPARE_GENERA = ['Quercus', 'Celtis', 'Asclepias', 'Betula', 'Larix', 'Symphyotrichum'];

function renderCompare() {
  const cards = COMPARE_GENERA.map((genus) => {
    const row = allRows.find((r) => r.genus === genus);
    if (!row) return '';
    const reject = row.verdict === 'rejected';
    const nwf = row.lepHostSpecies === null ? '—' : String(row.lepHostSpecies);

    // Each card states BOTH claims side by side rather than resolving them to
    // one number. Betula is why: it is the card that matters most and the
    // honest version of it is "189 versus none", which a single figure cannot
    // say. The one-line reading underneath is mine, and is labelled as such in
    // the caption below the strip.
    const reading = reject
      ? 'On the keystone list. No treatment in the flora at all — recommending it here would be a mistake.'
      : row.verdict === 'renamed'
        ? `Not absent — the flora keeps these under <i>${escapeHtml(row.fnctUnderName)}</i>, a 1999 naming decision.`
        : row.lepHostCount === 0
          ? `In the flora (p. ${escapeHtml(row.fnctPage)}), but its host appendix names no Lepidoptera, and its one nc TX species is a riverbank tree with no Dallas record.`
          : `${row.confirmedCount ? `<span class="pn-near">${row.confirmedCount} of them recorded near here.</span> ` : ''}Cited to FNCT p. ${escapeHtml(row.fnctPage)}.`;

    return `<div class="pn-card${reject ? ' pn-card--reject' : ''}">
      <span class="g">${escapeHtml(genus)}</span>
      <span class="room">${escapeHtml(row.growthTier ? row.growthTier.room : 'Not in the natives catalog')}</span>
      <span class="pn-pair">
        <span class="pn-stat"><b class="no">${nwf}</b><i>NWF claim</i></span>
        <span class="pn-stat"><b class="${row.lepHostCount ? 'ok' : 'no'}">${row.lepHostCount || 'none'}</b><i>FNCT hosts</i></span>
      </span>
      <span class="sub">${reading}</span>
    </div>`;
  });
  $('pnCompare').innerHTML = cards.join('');
}

function renderHeadline() {
  const confirmed = allRows.filter((r) => r.verdict === 'confirmed-local' && r.inCatalog);
  const rejected = allRows.filter((r) => r.verdict === 'rejected');
  const worstReject = rejected
    .filter((r) => r.lepHostSpecies)
    .sort((a, b) => b.lepHostSpecies - a.lepHostSpecies)[0];
  const nearTaxa = new Set(confirmed.flatMap((r) => r.confirmedNearby.map((c) => c.species)));
  const habits = new Set(confirmed.map((r) => r.habit).filter(Boolean));

  $('pnHeadline').innerHTML =
    `<strong>${confirmed.length} genera</strong> in the Blackland natives catalog clear the screen with ` +
    `at least one flora-cited larval host confirmed near this site — ${nearTaxa.size} distinct butterflies ` +
    `and moths, across ${habits.size} growth forms, from canopy trees to forbs. ` +
    `<strong>${rejected.length} genera</strong> on the keystone list have no treatment in the flora at all` +
    (worstReject
      ? `, including <i>${escapeHtml(worstReject.genus)}</i>, which that list credits with ${worstReject.lepHostSpecies} caterpillar species.`
      : '.');
}

function populateHabitFilter() {
  const habits = [...new Set(allRows.map((r) => r.habit).filter(Boolean))].sort(
    (a, b) => (GROWTH_TIERS[a]?.order ?? 9) - (GROWTH_TIERS[b]?.order ?? 9)
  );
  const select = $('pnHabitFilter');
  habits.forEach((habit) => {
    const option = document.createElement('option');
    option.value = habit;
    option.textContent = GROWTH_TIERS[habit] ? `${GROWTH_TIERS[habit].label} — ${GROWTH_TIERS[habit].room}` : habit;
    select.appendChild(option);
  });
}

async function main() {
  wireMap();
  renderTierKey();

  let project = { ecoregion: '9', place: 'home' };
  try {
    project = await loadProjectConfig(resolveActiveProjectId());
  } catch (err) {
    console.warn('Falling back to the default ecoregion/place; project config unavailable', err);
  }

  const url = (path) => new URL(path, document.baseURI);
  const [hostGeneraCsv, screenCsv, lepCsv, catalogCsv, faunaCsv, nameChangeCsv] = await Promise.all([
    fetchCsv(url('ecology/host-genera.csv')),
    fetchCsv(url('ecology/fnct-genus-screen.csv')),
    fetchCsv(url('ecology/fnct-lepidoptera-hosts.csv')),
    fetchCsv(url('blackland-prairie-natives.csv')),
    fetchCsv(url('ecology/nearby-fauna.csv')),
    fetchCsv(url('ecology/fnct-name-changes.csv')),
  ]);

  allRows = screenKeystoneGenera({
    hostGenera: buildHostGeneraIndex(hostGeneraCsv, { ecoregion: project.ecoregion || '9' }),
    fnctScreen: buildFnctScreenIndex(screenCsv),
    lepHosts: buildLepHostIndex(lepCsv),
    growth: buildGrowthIndex(catalogCsv),
    nearbyFauna: buildNearbyFaunaIndex(faunaCsv),
    place: project.place || 'home',
    nameChanges: buildNameChangeIndex(nameChangeCsv),
  });

  populateHabitFilter();
  renderCompare();
  renderHeadline();
  ['pnVerdictFilter', 'pnHabitFilter'].forEach((id) =>
    $(id).addEventListener('change', () => renderTable())
  );
  $('pnSearch').addEventListener('input', () => renderTable());
  renderTable();
}

main().catch((err) => {
  console.error(err);
  $('pnHeadline').textContent =
    'The screened table could not be loaded. The schematic above still works; see the console for what failed.';
});
