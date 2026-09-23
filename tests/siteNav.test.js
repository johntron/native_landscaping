// Every tool page carries the same plain-HTML nav, in SITE_ROUTE's order, with
// exactly its own link marked active — see src/ui/siteRoute.js for why the nav
// is static markup and this test is what keeps the copies identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SITE_NAME, SITE_ROUTE } from '../src/ui/siteRoute.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function readNav(page) {
  const html = readFileSync(`${ROOT}${page}`, 'utf8');
  const nav = html.match(/<nav class="site-nav">([\s\S]*?)<\/nav>/);
  assert.ok(nav, `${page} has no <nav class="site-nav">`);
  const links = [...nav[1].matchAll(/<a\s+([^>]*)>([^<]*)<\/a>/g)].map(([, attrs, label]) => ({
    href: attrs.match(/href="([^"]*)"/)?.[1],
    id: attrs.match(/id="([^"]*)"/)?.[1],
    active: /site-nav__link--active/.test(attrs),
    label: label.trim(),
  }));
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
  return { links, title };
}

for (const { href: page } of SITE_ROUTE) {
  test(`${page}: nav matches SITE_ROUTE and marks only itself active`, () => {
    const { links } = readNav(page);
    assert.deepEqual(
      links.map(({ href, label, id }) => ({ href, label, ...(id ? { id } : {}) })),
      SITE_ROUTE.map(({ href, label, id }) => ({ href, label, ...(id ? { id } : {}) })),
    );
    assert.deepEqual(
      links.filter((l) => l.active).map((l) => l.href),
      [page],
    );
  });

  test(`${page}: title carries the site name`, () => {
    assert.match(readNav(page).title, new RegExp(SITE_NAME));
  });
}
