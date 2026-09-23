/**
 * The one route through Rewilder's tools, in the order a homeowner walks it:
 * learn why it matters, see what already lives nearby, design the yard, then
 * defend it. The flora index is reference and comes last.
 *
 * Every page's `<nav class="site-nav">` is plain HTML (so it works with no
 * script, as rights.html has none) and must list exactly these links in this
 * order. tests/siteNav.test.js enforces that, which is what stops one page's nav
 * from drifting the way ecosystem.html's once did.
 *
 * `id` marks the links a page script rewrites to carry `?project=` along.
 */
export const SITE_NAME = 'Rewilder';

export const SITE_ROUTE = [
  { href: 'index.html', label: 'Start here' },
  { href: 'ecosystem.html', label: 'What’s nearby', id: 'navEcosystemLink' },
  { href: 'feed.html', label: 'New sightings' },
  { href: 'design.html', label: 'Your yard', id: 'navDesignLink' },
  { href: 'rights.html', label: 'Your rights' },
  { href: 'fnct.html', label: 'Flora index' },
];

/** Page `<title>` for a tool page: "<what> · Rewilder". */
export function pageTitle(what) {
  return what ? `${what} · ${SITE_NAME}` : SITE_NAME;
}
