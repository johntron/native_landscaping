/**
 * "Suggest drifts from an existing yard" (nl-o47.6.5, nl-o47.6's making
 * method 3): a yard planted before drifts existed has masses built by
 * cloning (the seed backyard's ~19 horseherb, 17 winecup, 16 Carex blanda,
 * interwoven along one strip). This reviews src/state/driftGeometry.js's
 * suggestClusters one at a time — the person accepts, adjusts, or skips each
 * — through src/state/driftSuggestions.js's pure helpers.
 *
 * DERIVED, NOT STORED (see driftSuggestions.js's own module comment): the
 * only state kept HERE across the session is which suggestions have been
 * Skipped (`skippedKeys`, by suggestionKey) and the CURRENT suggestion's own
 * person-made adjustments (`adjustedMemberIds`) and lifecycle choice. The
 * suggestion itself — its species, its algorithmic membership, its position
 * in the list — is recomputed fresh from `appState.plants` on every sync(),
 * which is exactly what makes Undo/Redo, and an edit made elsewhere while
 * reviewing, resolve for free: an undone Accept drops its driftId, so the
 * very same cluster (same key) simply reappears on the next read.
 *
 * Owns one appState field, `suggestedDriftMemberIds` (Set<string>|null): what
 * the plan outlines (a dashed violet hull, apparatus for a PROPOSAL — never a
 * real drift) and dims around, the same way `selectedDriftId` already
 * isolates a real one (src/render/topView.js, elevationViews.js).
 *
 * The review bar (#driftReviewBar) takes the exact same fixed-bottom slot
 * #selectionBar/#phoneEditorBar's idle bar already share — see design.html's
 * own comment on why reviewing keeps the plant selection empty throughout,
 * which is what keeps both of those hidden without this module having to
 * know about either directly.
 */
import { acceptDriftSuggestion } from '../state/driftEdits.js';
import { MIN_SUGGESTION_CLUSTER_SIZE } from '../state/driftGeometry.js';
import {
  describeLifecycleChoice,
  describeSuggestion,
  pendingSuggestions,
  summarizeStatusCounts,
  summarizeSuggestionLifecycle,
  suggestionKey,
  toggleSuggestionMember,
} from '../state/driftSuggestions.js';

/**
 * @param {object} deps
 * @param {object} deps.elements  every DOM node the bar needs; see the
 *   destructure below and design.html's #driftReviewBar markup.
 * @param {object} deps.appState  holds `plants`, `species`; gains
 *   `suggestedDriftMemberIds` (owned entirely by this module)
 * @param {() => void} deps.render
 * @param {() => void} deps.refreshSpeciesTable  rebuilds the species table
 *   (hiding/showing the "N possible drifts" banner) and the ecology panel
 * @param {(description: string) => void} deps.commitLayoutChange
 * @param {() => void} deps.clearSelection  plantSelection.clearSelection —
 *   review and the ordinary selection never coexist
 * @param {(locked: boolean) => void} deps.lockNonPlanControllers  locks every
 *   non-plan drag controller for the review's duration (src/app.js) —
 *   reviewing restricts its own taps to the plan; `locked: false` is safe to
 *   call unconditionally (src/app.js's own implementation re-checks
 *   appState.mode, so a Stop that races a mode change cannot wrongly
 *   re-unlock an elevation controller Edit mode has already left)
 * @param {{ isActive: () => boolean, closePlants: () => void, switchToPlan: () => void, focusOnPlants: (plants: Array) => void }} deps.phoneEditor
 * @param {() => void} deps.scrollPlanIntoView  the desktop counterpart of
 *   phoneEditor's focusOnPlants
 */
export function createDriftReviewMode({
  elements,
  appState,
  render,
  refreshSpeciesTable,
  commitLayoutChange,
  clearSelection,
  lockNonPlanControllers,
  phoneEditor,
  scrollPlanIntoView,
}) {
  const {
    bar,
    label,
    acceptBtn,
    skipBtn,
    stopBtn,
    moreBtn,
    moreGroup,
    hintEl,
    lifecycleGroup,
    lifecycleSummaryEl,
    lifecycleOptionsEl,
    undoBtn,
    redoBtn,
    undoRealBtn,
    redoRealBtn,
  } = elements;

  let active = false;
  let skippedKeys = new Set();
  let startingTotal = 0;
  let baseKey = '';
  /** null = "the suggestion's own algorithmic members, unmodified"; a Set once a tap has adjusted it. */
  let adjustedMemberIds = null;
  /** Index into summarizeSuggestionLifecycle(members).groups, or null (undecided/moot). */
  let lifecycleChoiceIndex = null;
  /** A one-shot message (a refused toggle or Accept) for the very next sync() to show, then clear. */
  let pendingMessage = '';

  const closeMore = () => {
    if (!moreGroup) return;
    moreGroup.classList.remove('is-open');
    moreBtn?.setAttribute('aria-expanded', 'false');
  };
  moreBtn?.addEventListener('click', () => {
    if (!moreGroup) return;
    const willOpen = !moreGroup.classList.contains('is-open');
    moreGroup.classList.toggle('is-open', willOpen);
    moreBtn.setAttribute('aria-expanded', String(willOpen));
  });
  // Forward to the REAL undo/redo buttons, exactly like src/ui/selectionBar.js's
  // own mirrored pair — never disabled-but-clicked.
  undoBtn?.addEventListener('click', () => {
    if (undoRealBtn && !undoRealBtn.disabled) undoRealBtn.click();
  });
  redoBtn?.addEventListener('click', () => {
    if (redoRealBtn && !redoRealBtn.disabled) redoRealBtn.click();
  });
  acceptBtn?.addEventListener('click', () => accept());
  skipBtn?.addEventListener('click', () => skip());
  stopBtn?.addEventListener('click', () => stop());

  /** The current suggestion, freshly derived — never a stored queue entry. */
  function currentSuggestion() {
    return pendingSuggestions(appState.plants, skippedKeys)[0] || null;
  }

  /** `suggestion`'s membership as the person has (maybe) adjusted it, as live plant objects. */
  function effectiveMembers(suggestion) {
    if (!suggestion) return [];
    if (!adjustedMemberIds) return suggestion.members;
    const byId = new Map(appState.plants.map((plant) => [String(plant.id), plant]));
    return [...adjustedMemberIds].map((id) => byId.get(id)).filter(Boolean);
  }

  /**
   * Drop any adjustment that no longer makes sense — a base member somehow
   * drifted elsewhere, or a manually-added extra removed or drifted since —
   * falling back to the suggestion's own algorithmic members if that leaves
   * too few. Only meaningful when the CURRENT suggestion's identity (its
   * species+base-members key) has not changed; a changed key already resets
   * adjustedMemberIds outright in sync().
   */
  function revalidateAdjusted(suggestion) {
    if (!adjustedMemberIds) return;
    const baseIds = new Set(suggestion.members.map((member) => String(member.id)));
    const plantsById = new Map(appState.plants.map((plant) => [String(plant.id), plant]));
    const kept = [...adjustedMemberIds].filter((id) => {
      if (baseIds.has(id)) return true; // guaranteed valid by pendingSuggestions itself
      const plant = plantsById.get(id);
      return Boolean(plant && !plant.driftId && plant.speciesId === suggestion.speciesId);
    });
    adjustedMemberIds = kept.length >= MIN_SUGGESTION_CLUSTER_SIZE ? new Set(kept) : null;
  }

  /** How many suggestions remain, this suggestion included — "Suggestion N of startingTotal". */
  function positionInSession() {
    const remaining = pendingSuggestions(appState.plants, skippedKeys).length;
    return startingTotal - remaining + 1;
  }

  function focusOnSuggestion(members) {
    if (phoneEditor?.isActive?.()) {
      phoneEditor.focusOnPlants(members);
    } else {
      scrollPlanIntoView?.();
    }
  }

  function setHint(message) {
    if (!hintEl) return;
    hintEl.textContent = message || '';
    hintEl.hidden = !message;
  }

  function hideBar() {
    if (bar) bar.hidden = true;
    closeMore();
  }

  function renderLifecycleChoice(members) {
    const { uniform, groups } = summarizeSuggestionLifecycle(members);
    if (uniform || !lifecycleGroup) {
      if (lifecycleGroup) lifecycleGroup.hidden = true;
      lifecycleChoiceIndex = null;
      return { needsChoice: false, groups };
    }
    lifecycleGroup.hidden = false;
    if (lifecycleSummaryEl) lifecycleSummaryEl.textContent = summarizeStatusCounts(members);
    if (lifecycleOptionsEl) {
      lifecycleOptionsEl.innerHTML = '';
      groups.forEach((group, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chip';
        const chosen = index === lifecycleChoiceIndex;
        if (chosen) button.classList.add('is-active');
        button.setAttribute('aria-pressed', chosen ? 'true' : 'false');
        button.textContent = describeLifecycleChoice(group);
        button.addEventListener('click', () => {
          lifecycleChoiceIndex = index;
          sync();
        });
        lifecycleOptionsEl.appendChild(button);
      });
    }
    return { needsChoice: lifecycleChoiceIndex === null, groups };
  }

  function renderReviewing(suggestion, members) {
    if (bar) bar.hidden = false;
    if (label) {
      // The drift label leads — the essential part, species and count both —
      // with the position last, so a narrow bar's own ellipsis
      // (.selection-bar__name) truncates the least essential piece first if
      // it has to truncate at all (a 393px screenshot found "Suggestion 1 of
      // 2 · Winecup · 4…" losing the plant count when position led instead).
      label.textContent = `${describeSuggestion(members, suggestion.speciesId)} · ${positionInSession()} of ${startingTotal}`;
    }
    if (acceptBtn) acceptBtn.hidden = false;
    if (skipBtn) skipBtn.hidden = false;

    const { needsChoice } = renderLifecycleChoice(members);
    const tooFew = members.length < MIN_SUGGESTION_CLUSTER_SIZE;
    const canAccept = !tooFew && !needsChoice;
    if (acceptBtn) {
      acceptBtn.disabled = !canAccept;
      acceptBtn.title = tooFew
        ? `A drift needs at least ${MIN_SUGGESTION_CLUSTER_SIZE} plants.`
        : needsChoice
          ? "Choose the planting status these plants share, or adjust the members."
          : '';
    }
  }

  function renderFinished() {
    if (bar) bar.hidden = false;
    if (label) label.textContent = 'Reviewed every suggested drift.';
    if (acceptBtn) acceptBtn.hidden = true;
    if (skipBtn) skipBtn.hidden = true;
    if (lifecycleGroup) lifecycleGroup.hidden = true;
  }

  /** Re-derive everything from appState.plants and redraw the bar/outline. */
  function sync() {
    if (!active) {
      hideBar();
      return;
    }
    const suggestion = currentSuggestion();
    const message = pendingMessage;
    pendingMessage = '';

    if (!suggestion) {
      baseKey = '';
      adjustedMemberIds = null;
      lifecycleChoiceIndex = null;
      appState.suggestedDriftMemberIds = null;
      renderFinished();
      setHint(message);
      render();
      return;
    }

    const key = suggestionKey(suggestion);
    if (key !== baseKey) {
      baseKey = key;
      adjustedMemberIds = null;
      lifecycleChoiceIndex = null;
      closeMore();
      focusOnSuggestion(suggestion.members);
    } else {
      revalidateAdjusted(suggestion);
    }

    const members = effectiveMembers(suggestion);
    appState.suggestedDriftMemberIds = new Set(members.map((member) => String(member.id)));
    renderReviewing(suggestion, members);
    setHint(message);
    render();
  }

  /** Edit mode, at least one suggestion, and no review already open — the
   * banner's own guard, checked again here defensively. */
  function start() {
    if (active) return;
    const pending = pendingSuggestions(appState.plants, new Set());
    if (!pending.length) return;
    active = true;
    skippedKeys = new Set();
    startingTotal = pending.length;
    baseKey = '';
    adjustedMemberIds = null;
    lifecycleChoiceIndex = null;
    pendingMessage = '';
    clearSelection();
    lockNonPlanControllers(true);
    phoneEditor?.closePlants?.();
    phoneEditor?.switchToPlan?.();
    refreshSpeciesTable(); // hides the banner now that isActive() is true
    sync();
  }

  function stop() {
    if (!active) return;
    active = false;
    skippedKeys = new Set();
    baseKey = '';
    adjustedMemberIds = null;
    lifecycleChoiceIndex = null;
    pendingMessage = '';
    appState.suggestedDriftMemberIds = null;
    lockNonPlanControllers(false);
    hideBar();
    render();
    refreshSpeciesTable(); // the banner reappears if anything is still pending
  }

  function skip() {
    if (!active) return;
    const suggestion = currentSuggestion();
    if (!suggestion) return;
    skippedKeys.add(suggestionKey(suggestion));
    baseKey = '';
    adjustedMemberIds = null;
    lifecycleChoiceIndex = null;
    sync();
  }

  function accept() {
    if (!active) return;
    const suggestion = currentSuggestion();
    if (!suggestion) return;
    const members = effectiveMembers(suggestion);
    if (members.length < MIN_SUGGESTION_CLUSTER_SIZE) return; // the bar's own disabled state already guards this
    const { uniform, groups } = summarizeSuggestionLifecycle(members);
    let lifecycle;
    if (!uniform) {
      if (lifecycleChoiceIndex === null) return; // ditto
      lifecycle = groups[lifecycleChoiceIndex]?.lifecycle;
      if (!lifecycle) return;
    }
    const memberIds = members.map((member) => member.id);
    const { driftId, reason } = acceptDriftSuggestion(appState, memberIds, lifecycle ? { lifecycle } : undefined);
    if (!driftId) {
      pendingMessage = reason || '';
      sync();
      return;
    }
    render();
    refreshSpeciesTable();
    commitLayoutChange(`Accepted suggestion: ${describeSuggestion(members, suggestion.speciesId)}`);
    // Move on: these plants now carry a driftId, so the accepted cluster no
    // longer exists to suggestClusters — whatever comes next is simply
    // whatever pendingSuggestions() now returns first.
    baseKey = '';
    adjustedMemberIds = null;
    lifecycleChoiceIndex = null;
    sync();
  }

  /**
   * A tap on the plan while reviewing (src/interaction/dragController.js's
   * own review bypass calls this with the nearest hit, or '' for a miss):
   * toggle it in/out of the current suggestion's adjusted membership.
   * @param {string} plantId
   */
  function handleTap(plantId) {
    if (!active || !plantId) return;
    const suggestion = currentSuggestion();
    if (!suggestion) return;
    const members = effectiveMembers(suggestion);
    const { members: next, reason } = toggleSuggestionMember(members, plantId, appState.plants);
    if (next === members) {
      if (reason) {
        pendingMessage = reason;
        sync();
      }
      return;
    }
    adjustedMemberIds = new Set(next.map((member) => String(member.id)));
    sync();
  }

  /** Called wherever refreshSpeciesTable already runs (add/remove/undo/redo/
   * load): re-derives the current suggestion so a review never shows a
   * suggestion built on stale plants. A no-op while inactive. */
  function refresh() {
    if (active) sync();
  }

  /** Every suggestion still worth showing, ignoring this module's own
   * in-progress skips (there are none while inactive) — the banner's count. */
  function pendingCount() {
    return pendingSuggestions(appState.plants, new Set()).length;
  }

  return {
    isActive: () => active,
    start,
    stop,
    skip,
    accept,
    handleTap,
    refresh,
    pendingCount,
    /** So src/app.js's document-level click handler can ignore a click that
     * lands on the bar itself, the way it already does for the selection bar. */
    contains: (node) => Boolean(bar && node instanceof Node && bar.contains(node)),
  };
}
