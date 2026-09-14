/*
 * Disclosure markers: the apparatus behind a click, the argument left in place.
 *
 * This page is shown to a room and red-lined by people who know the flora
 * better than I do. That sets two rules the usual hover tooltip breaks.
 *
 *   1. HOVER IS NOT AN OPTION. It reveals nothing on a phone, nothing to a
 *      keyboard, and nothing to an audience watching a projector. These open on
 *      click and STAY open, so two page citations can be compared side by side.
 *
 *   2. THE MARKER IS ITSELF CONTENT. An invisible hover zone hides the fact
 *      that a citation exists at all. Every trigger therefore renders a visible
 *      marker, and the marker says which kind of thing is behind it.
 *
 * What may hide behind one of these is apparatus: column definitions, page
 * numbers, provenance rules, source lists. What must NEVER hide behind one is
 * the ask itself -- the caveats naming what is schematic and which assumption I
 * most want challenged are the highest-value text on the page for the audience
 * it is written for. Hiding those would make "red-line the screen" unanswerable.
 */

const OPEN = new Set();

function place(panel, trigger) {
  // Measure first, then flip: a panel that opens off-screen is a panel nobody
  // reads. Coordinates are viewport-relative because the panel is position:fixed.
  const t = trigger.getBoundingClientRect();
  panel.style.visibility = 'hidden';
  panel.hidden = false;
  const p = panel.getBoundingClientRect();
  const margin = 8;

  let left = t.left;
  if (left + p.width > window.innerWidth - margin) left = window.innerWidth - p.width - margin;
  if (left < margin) left = margin;

  // Below the trigger, unless there is more room above.
  const below = window.innerHeight - t.bottom;
  const top = below < p.height + margin && t.top > below ? t.top - p.height - 6 : t.bottom + 6;

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.visibility = '';
}

function close(entry) {
  if (!OPEN.has(entry)) return;
  entry.panel.hidden = true;
  entry.trigger.setAttribute('aria-expanded', 'false');
  OPEN.delete(entry);
}

function closeAll() {
  for (const entry of [...OPEN]) close(entry);
}

function open(entry) {
  closeAll();
  place(entry.panel, entry.trigger);
  entry.trigger.setAttribute('aria-expanded', 'true');
  OPEN.add(entry);
}

/*
 * Wires every [data-disclosure] trigger under `root`. The trigger's panel is
 * the element whose id matches its aria-controls, so the content lives in the
 * markup next to what it annotates rather than in a JS string.
 */
export function initDisclosures(root = document) {
  const triggers = root.querySelectorAll('[data-disclosure]');
  for (const trigger of triggers) {
    const panel = document.getElementById(trigger.getAttribute('aria-controls'));
    if (!panel) continue;
    if (trigger.dataset.disclosureBound === 'true') continue;
    trigger.dataset.disclosureBound = 'true';

    panel.hidden = true;
    panel.classList.add('disclosure__panel');
    trigger.setAttribute('aria-expanded', 'false');

    const entry = { trigger, panel };
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      OPEN.has(entry) ? close(entry) : open(entry);
    });
    // A click inside the panel is reading, not dismissing.
    panel.addEventListener('click', (event) => event.stopPropagation());
  }
}

document.addEventListener('click', closeAll);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || OPEN.size === 0) return;
  const focus = [...OPEN][0].trigger;
  closeAll();
  focus.focus();   // Escape must not strand focus in a panel that is now gone.
});
/*
 * Follow the anchor rather than dismissing. The screened table scrolls inside
 * its own .pn-scroll container and the page scrolls under that, so closing on
 * scroll would mean the act of scrolling to READ a panel dismissed it -- which
 * on a phone is most of the ways you would open one.
 */
function reflow() {
  for (const entry of OPEN) place(entry.panel, entry.trigger);
}
window.addEventListener('resize', reflow);
window.addEventListener('scroll', reflow, true);
