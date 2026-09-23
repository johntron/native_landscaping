/**
 * The "Buy plants" page: dated native plant sales and chapter-listed nurseries
 * around Dallas–Fort Worth, read from the two sourced tables under sourcing/.
 * Which sales are still ahead is decided in saleSchedule.js; this module only
 * renders what it is handed.
 */
import { fetchCsv, parseCsv } from '../data/csvLoader.js';
import { initDisclosures } from '../ui/disclosure.js';
import { daysUntil, formatSaleDates, localIsoDate, splitSales } from './saleSchedule.js';

const $ = (id) => document.getElementById(id);

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const link = (href, text) =>
  href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>` : escapeHtml(text);

const OFFERS_LABEL = { native: 'Natives', mixed: 'Natives and others' };

function whenLabel(row, today) {
  const days = daysUntil(row, today);
  if (days < 0) return row.kind === 'online' ? 'Open now' : 'Under way';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

function saleItem(row, today, { held = false } = {}) {
  const tags = [];
  if (row.access === 'members') tags.push('<span class="sale-tag sale-tag--members">Members only</span>');
  if (row.kind === 'online') tags.push('<span class="sale-tag">Online orders</span>');
  if (row.kind === 'event') tags.push('<span class="sale-tag">Event</span>');
  if (OFFERS_LABEL[row.offers]) tags.push(`<span class="sale-tag sale-tag--offers">${OFFERS_LABEL[row.offers]}</span>`);
  const place = [row.venue, row.city].filter(Boolean).map(escapeHtml).join(' · ');
  return `
    <li class="sale">
      <div class="sale__when">
        <span class="sale__date">${escapeHtml(formatSaleDates(row))}</span>
        ${held ? `<span class="sale__year">${escapeHtml(row.start_date.slice(0, 4))}</span>` : `<span class="sale__countdown">${whenLabel(row, today)}</span>`}
      </div>
      <div class="sale__body">
        <p class="sale__title">${link(row.url, row.event)}</p>
        <p class="sale__org">${escapeHtml(row.organizer)}${row.hours ? ` · ${escapeHtml(row.hours)}` : ''}</p>
        ${place ? `<p class="sale__place">${place}</p>` : ''}
        ${row.notes && !held ? `<p class="sale__notes">${escapeHtml(row.notes)}</p>` : ''}
        ${tags.length ? `<p class="sale__tags">${tags.join('')}</p>` : ''}
      </div>
    </li>`;
}

function nurseryItem(row) {
  const where = [row.address, row.city].filter(Boolean).join(', ');
  const premier = row.tier === 'premier' ? '<span class="sale-tag sale-tag--offers">Premier</span>' : '';
  return `
    <li class="nursery">
      <p class="nursery__name">${link(row.website, row.name)}${premier}</p>
      ${where ? `<p class="nursery__place">${escapeHtml(where)}</p>` : ''}
      ${row.notes ? `<p class="nursery__notes">${escapeHtml(row.notes)}</p>` : ''}
    </li>`;
}

function renderNurseryGroups(el, rows, heading) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.chapter)) groups.set(row.chapter, []);
    groups.get(row.chapter).push(row);
  }
  el.innerHTML = [...groups]
    .map(([chapter, list]) => {
      const sorted = [...list].sort(
        (a, b) => (a.tier === 'premier' ? 0 : 1) - (b.tier === 'premier' ? 0 : 1) || a.name.localeCompare(b.name),
      );
      return `
        <div class="nursery-group">
          <h3>${escapeHtml(heading(chapter))}</h3>
          <ul class="nursery-list">${sorted.map(nurseryItem).join('')}</ul>
        </div>`;
    })
    .join('');
}

function renderSources(sales, nurseries) {
  const checked = new Map();
  for (const row of [...sales, ...nurseries]) {
    const prior = checked.get(row.source);
    if (!prior || row.checked_on > prior) checked.set(row.source, row.checked_on);
  }
  $('sourceList').innerHTML = [...checked]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([url, on]) => `<li>${link(url, url.replace(/^https?:\/\/(www\.)?/, ''))} <cite>checked ${escapeHtml(on)}</cite></li>`)
    .join('');
}

async function init() {
  const today = localIsoDate();
  let sales;
  let nurseries;
  try {
    [sales, nurseries] = await Promise.all([
      fetchCsv(new URL('sourcing/plant-sales.csv', document.baseURI)).then(parseCsv),
      fetchCsv(new URL('sourcing/nurseries.csv', document.baseURI)).then(parseCsv),
    ]);
  } catch (err) {
    $('upcomingSales').innerHTML = '<li class="sale-list__empty">Could not load the sale list.</li>';
    console.error(err);
    return;
  }

  const { upcoming, held } = splitSales(sales, today);
  $('upcomingSales').innerHTML = upcoming.length
    ? upcoming.map((row) => saleItem(row, today)).join('')
    : '<li class="sale-list__empty">No dated sales ahead in this list. Check NPSOT’s Upcoming Plant Sales for new ones.</li>';
  $('heldSales').innerHTML = held.map((row) => saleItem(row, today, { held: true })).join('');

  const latest = sales.map((r) => r.checked_on).filter(Boolean).sort().pop();
  if (latest) $('salesChecked').textContent = latest;

  renderNurseryGroups(
    $('niceNurseries'),
    nurseries.filter((r) => r.program === 'NICE'),
    (chapter) => `${chapter} chapter`,
  );
  renderNurseryGroups(
    $('otherNurseries'),
    nurseries.filter((r) => r.program !== 'NICE'),
    (chapter) => `${chapter} chapter list`,
  );
  renderSources(sales, nurseries);
  initDisclosures();
}

init();
