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
 *
 * nl-o47.6.4 adds a SECOND, "group" mode to this same module rather than
 * building a parallel one: `startGroup(plantId)` (the selection bar's "Make
 * drift", on a single plant not already in a drift) opens the exact same bar,
 * outline, dimming, and tap-to-toggle a suggestion review does — every guard
 * keyed off `isActive()`/`handleTap()` (src/app.js's isDriftReviewActive,
 * every drag controller's isReviewActive/onReviewTap, phoneEditor's own idle-
 * bar guard) keeps working with no changes, because they all go through this
 * one instance. `mode` ('suggestion' | 'group') is the only new piece of
 * state: a group proposal has no algorithmic baseline or position in a queue
 * (no suggestionKey, no "· N of M"), starts at ONE member instead of
 * suggestClusters' own floor, and — the one place its own pure toggle
 * (src/state/driftGroup.js's toggleGroupMember) differs from a suggestion's
 * (toggleSuggestionMember) — a tap may pull in a plant that already belongs
 * to another real drift, which src/state/driftEdits.js's acceptDriftGroup
 * then moves rather than refuses.
 */
import { acceptDriftGroup, acceptDriftSuggestion } from '../state/driftEdits.js';
import { MIN_SUGGESTION_CLUSTER_SIZE } from '../state/driftGeometry.js';
import { describeGroupSources, seedGroupProposal, summarizeGroupSources, toggleGroupMember } from '../state/driftGroup.js';
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
 * @param {(driftId: string) => void} deps.selectDrift  plantSelection.selectDrift
 *   — nl-o47.6.4's group Accept selects the new drift whole once review is
 *   out of the way, same as every other drift-making action in src/app.js
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
  selectDrift,
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
    movingHintEl,
    lifecycleGroup,
    lifecycleSummaryEl,
    lifecycleOptionsEl,
    undoBtn,
    redoBtn,
    undoRealBtn,
    redoRealBtn,
  } = elements;

  let active = false;
  /** 'suggestion' (nl-o47.6.5) or 'group' (nl-o47.6.4, a hand-made proposal). */
  let mode = 'suggestion';
  /** group mode only: the proposal's fixed species (src/state/driftGroup.js's seedGroupProposal). */
  let groupSpeciesId = '';
  /** Whether the LAST sync() needed a lifecycle choice, in EITHER mode —
   * tracked so sync can open More itself the moment this turns true on a
   * phone (openMore, below), once, not on every re-render. Reset whenever
   * review starts fresh (start/startGroup), a different suggestion comes up
   * (syncSuggestion's own baseKey check), or review ends (stop). */
  let lastNeededChoice = false;
  let skippedKeys = new Set();
  let startingTotal = 0;
  let baseKey = '';
  /**
   * Suggestion mode: null = "the suggestion's own algorithmic members,
   * unmodified"; a Set once a tap has adjusted it. Group mode: ALWAYS a Set —
   * a hand-made proposal has no algorithmic baseline to fall back to, so this
   * IS its membership, from the seed onward.
   */
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
  /** Shared by both modes (syncSuggestion/syncGroup, below): open More itself
   * the moment a mixed lifecycle first needs a choice on a phone, where the
   * chooser lives behind it and there is no other way to reach it without
   * guessing (and, unlike acceptBtn.title, touch never shows a title at all). */
  const openMore = () => {
    if (!moreGroup) return;
    moreGroup.classList.add('is-open');
    moreBtn?.setAttribute('aria-expanded', 'true');
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
  // Suggestion mode: Skip, moving to the next one. Group mode: the SAME
  // button, relabelled "Cancel" (renderGroup), means "leave without writing"
  // — exactly stop()'s own meaning.
  skipBtn?.addEventListener('click', () => (mode === 'group' ? stop() : skip()));
  stopBtn?.addEventListener('click', () => stop());

  /** The current suggestion, freshly derived — never a stored queue entry. */
  function currentSuggestion() {
    return pendingSuggestions(appState.plants, skippedKeys)[0] || null;
  }

  /** `suggestion`'s membership as the person has (maybe) adjusted it, as live
   * plant objects — or, in group mode (`suggestion` is unused there),
   * `adjustedMemberIds` IS the proposal's whole membership. */
  function effectiveMembers(suggestion) {
    if (mode === 'group') {
      if (!adjustedMemberIds) return [];
      const byId = new Map(appState.plants.map((plant) => [String(plant.id), plant]));
      return [...adjustedMemberIds].map((id) => byId.get(id)).filter(Boolean);
    }
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

  /** A second status line (#driftReviewMovingHint, design.html), shared by
   * BOTH modes — a direct child of the bar rather than tucked inside
   * #driftReviewMore, so it is visible without opening More on a phone
   * (unlike #driftReviewHint's one-shot messages above, which a suggestion
   * review has always used exactly as before for a refused toggle). Group
   * mode's setGroupHint, below, decides its text there; syncSuggestion sets
   * it directly for the one thing suggestion mode now shares this line for —
   * the "choose a planting status" prompt (choicePrompt, below). */
  function setMovingHint(message) {
    if (!movingHintEl) return;
    movingHintEl.textContent = message || '';
    movingHintEl.hidden = !message;
  }

  /** The visible prompt for "Accept needs a lifecycle choice first," shared
   * by both modes: a phone needs telling where the chooser lives (behind
   * More — see the needsChoice handling in syncSuggestion/syncGroup, which
   * open it the moment this becomes true); desktop's own copy is already
   * inline (.selection-bar__more is `display: contents` there), so it only
   * needs the bare instruction. */
  function choicePrompt() {
    return phoneEditor?.isActive?.()
      ? 'Choose a planting status in More before Accept.'
      : 'Choose a planting status before Accept.';
  }

  function hideBar() {
    if (bar) bar.hidden = true;
    closeMore();
    setMovingHint('');
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

  /**
   * The Accept-gating part of the bar, shared by both modes: the lifecycle
   * chooser itself (renderLifecycleChoice, unchanged) plus disabling Accept
   * below the floor or while members disagree. `acceptBtn.title` stays as a
   * DESKTOP-only affordance (a hover tooltip) — the visible, touch-reachable
   * explanation is setGroupHint/choicePrompt below, driven by this same
   * `needsChoice`, which both renderReviewing and renderGroup return to
   * their own syncSuggestion/syncGroup.
   */
  function renderAcceptGate(members) {
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
    return { needsChoice, tooFew };
  }

  function renderReviewing(suggestion, members) {
    if (bar) {
      bar.hidden = false;
      bar.setAttribute('aria-label', 'Reviewing suggested drifts');
    }
    if (label) {
      // The drift label leads — the essential part, species and count both —
      // with the position last, so a narrow bar's own ellipsis
      // (.selection-bar__name) truncates the least essential piece first if
      // it has to truncate at all (a 393px screenshot found "Suggestion 1 of
      // 2 · Winecup · 4…" losing the plant count when position led instead).
      label.textContent = `${describeSuggestion(members, suggestion.speciesId)} · ${positionInSession()} of ${startingTotal}`;
    }
    if (acceptBtn) acceptBtn.hidden = false;
    if (skipBtn) {
      skipBtn.hidden = false;
      skipBtn.textContent = 'Skip'; // group mode (renderGroup) relabels this "Cancel"
    }
    if (stopBtn) stopBtn.hidden = false;
    return renderAcceptGate(members);
  }

  function renderFinished() {
    if (bar) bar.hidden = false;
    if (label) label.textContent = 'Reviewed every suggested drift.';
    if (acceptBtn) acceptBtn.hidden = true;
    if (skipBtn) skipBtn.hidden = true;
    if (stopBtn) stopBtn.hidden = false;
    if (lifecycleGroup) lifecycleGroup.hidden = true;
  }

  /**
   * Group mode's own bar (nl-o47.6.4): the label with no "· N of M" (there is
   * no queue), Accept and Cancel (the relabelled skipBtn) together on the
   * primary row — reusing renderAcceptGate unchanged, so the same choice a
   * suggestion needs when members disagree works here too.
   */
  function renderGroup(members) {
    if (bar) {
      bar.hidden = false;
      bar.setAttribute('aria-label', 'Building a drift');
    }
    if (label) label.textContent = describeSuggestion(members, groupSpeciesId);
    if (acceptBtn) acceptBtn.hidden = false;
    if (skipBtn) {
      skipBtn.hidden = false;
      skipBtn.textContent = 'Cancel';
    }
    // Cancel already leaves without writing; a Stop in More would be the
    // same button twice.
    if (stopBtn) stopBtn.hidden = true;
    return renderAcceptGate(members);
  }

  /**
   * Group mode's standing status line (#driftReviewMovingHint) — visible
   * without opening More on a phone, unlike `acceptBtn.title` (touch never
   * shows a title) and unlike the lifecycle chooser itself (genuinely behind
   * More there; see the `needsChoice` handling in syncGroup, which opens it
   * the moment this turns true). Priority: a one-shot refusal/no-op message
   * (a different-species tap, a refused Accept) leads when there is one;
   * otherwise "N from <drift>" for whatever is about to move out of another
   * real drift (src/state/driftGroup.js's summarizeGroupSources/
   * describeGroupSources) — so that is never hidden either, even while a
   * choice is ALSO needed — with choicePrompt (shared with suggestion mode,
   * above) appended/shown for whichever of "below the floor" or "needs a
   * choice" applies; neither can be true at once (the floor is 2, a choice
   * needs 2+ members to disagree over).
   */
  function setGroupHint(members, oneShotMessage, needsChoice) {
    if (oneShotMessage) {
      setMovingHint(oneShotMessage);
      return;
    }
    const moving = describeGroupSources(summarizeGroupSources(members, appState.plants));
    if (members.length < MIN_SUGGESTION_CLUSTER_SIZE) {
      const name = members[0]?.commonName || members[0]?.botanicalName || 'this species';
      const nudge = `Tap another ${name} plant to add it to the drift.`;
      setMovingHint(moving ? `${moving}. ${nudge}` : nudge);
      return;
    }
    if (needsChoice) {
      const prompt = choicePrompt();
      setMovingHint(moving ? `${moving}. ${prompt}` : prompt);
      return;
    }
    setMovingHint(moving);
  }

  /** Re-derive everything from appState.plants and redraw the bar/outline. */
  function sync() {
    if (!active) {
      hideBar();
      return;
    }
    if (mode === 'group') {
      syncGroup();
      return;
    }
    syncSuggestion();
  }

  function syncSuggestion() {
    const suggestion = currentSuggestion();
    const message = pendingMessage;
    pendingMessage = '';

    if (!suggestion) {
      baseKey = '';
      adjustedMemberIds = null;
      lifecycleChoiceIndex = null;
      lastNeededChoice = false;
      appState.suggestedDriftMemberIds = null;
      renderFinished();
      setHint(message);
      setMovingHint('');
      render();
      return;
    }

    const key = suggestionKey(suggestion);
    if (key !== baseKey) {
      baseKey = key;
      adjustedMemberIds = null;
      lifecycleChoiceIndex = null;
      // A genuinely different suggestion: whatever the LAST one needed is
      // moot, so the open-More-once trigger below re-arms for this one too.
      lastNeededChoice = false;
      closeMore();
      focusOnSuggestion(suggestion.members);
    } else {
      revalidateAdjusted(suggestion);
    }

    const members = effectiveMembers(suggestion);
    appState.suggestedDriftMemberIds = new Set(members.map((member) => String(member.id)));
    const { needsChoice } = renderReviewing(suggestion, members);
    // nl-o47.6.4 shares this with group mode: open the chooser itself the
    // moment a choice is FIRST needed, on a phone, where acceptBtn.title (the
    // ONLY explanation before this) is invisible and the chooser lives behind
    // More with nothing else pointing at it.
    if (needsChoice && !lastNeededChoice && phoneEditor?.isActive?.()) openMore();
    lastNeededChoice = needsChoice;
    setHint(message);
    // Suggestion mode has no "moving from another drift" text (a suggestion
    // never includes an already-drifted plant) — this line is used for
    // exactly one thing here, the same choicePrompt group mode shows.
    setMovingHint(needsChoice ? choicePrompt() : '');
    render();
  }

  function syncGroup() {
    const message = pendingMessage;
    pendingMessage = '';
    setHint(''); // the suggestion review's own one-shot line; never shown here

    const members = effectiveMembers(null);
    if (!members.length) {
      // The seed (or every member since) vanished out from under the
      // proposal — undone, removed elsewhere. Nothing left to build.
      stop();
      return;
    }
    adjustedMemberIds = new Set(members.map((member) => String(member.id)));
    appState.suggestedDriftMemberIds = adjustedMemberIds;
    const { needsChoice } = renderGroup(members);
    // Shared with syncSuggestion above: open the chooser itself the moment a
    // choice is FIRST needed, on a phone; never re-open it if the person has
    // since closed it again.
    if (needsChoice && !lastNeededChoice && phoneEditor?.isActive?.()) openMore();
    lastNeededChoice = needsChoice;
    setGroupHint(members, message, needsChoice);
    render();
  }

  /** Edit mode, at least one suggestion, and no review already open — the
   * banner's own guard, checked again here defensively. */
  function start() {
    if (active) return;
    const pending = pendingSuggestions(appState.plants, new Set());
    if (!pending.length) return;
    active = true;
    mode = 'suggestion';
    groupSpeciesId = '';
    lastNeededChoice = false;
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

  /**
   * nl-o47.6.4: enter GROUP mode on `plantId` (the selection bar's "Make
   * drift" — a single plant not already in a drift). Everything else about
   * entering review is identical to start() above: clear the ordinary
   * selection (the two never coexist), lock the elevation controllers, land
   * on the plan.
   * @param {string} plantId
   */
  function startGroup(plantId) {
    if (active) return;
    const plant = appState.plants.find((candidate) => String(candidate.id) === String(plantId));
    const seed = seedGroupProposal(plant);
    if (!seed) return;
    active = true;
    mode = 'group';
    groupSpeciesId = seed.speciesId;
    lastNeededChoice = false;
    adjustedMemberIds = new Set(seed.members.map((member) => String(member.id)));
    lifecycleChoiceIndex = null;
    pendingMessage = '';
    clearSelection();
    lockNonPlanControllers(true);
    phoneEditor?.closePlants?.();
    phoneEditor?.switchToPlan?.();
    sync();
  }

  function stop() {
    if (!active) return;
    active = false;
    mode = 'suggestion';
    groupSpeciesId = '';
    lastNeededChoice = false;
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
    if (!active || mode !== 'suggestion') return;
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
    if (mode === 'group') {
      acceptGroup();
      return;
    }
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
   * nl-o47.6.4: Accept a hand-made proposal. Unlike a suggestion's Accept,
   * this LEAVES review (there is no queue to move on to) and selects the new
   * drift whole — the same "just made it, now it's selected" pattern every
   * other drift-making action in src/app.js already follows (addDriftMember's
   * plantId path, addDriftFromCatalog, acceptDriftSuggestion's OWN first
   * accept does not select, but that one stays mid-review on purpose).
   */
  function acceptGroup() {
    const members = effectiveMembers(null);
    if (members.length < MIN_SUGGESTION_CLUSTER_SIZE) return; // the bar's own disabled state already guards this
    const { uniform, groups } = summarizeSuggestionLifecycle(members);
    let lifecycle;
    if (!uniform) {
      if (lifecycleChoiceIndex === null) return; // ditto
      lifecycle = groups[lifecycleChoiceIndex]?.lifecycle;
      if (!lifecycle) return;
    }
    const memberIds = members.map((member) => member.id);
    const { driftId, reason } = acceptDriftGroup(appState, memberIds, lifecycle ? { lifecycle } : undefined);
    if (!driftId) {
      pendingMessage = reason || '';
      sync();
      return;
    }
    const description = `Made a drift: ${describeSuggestion(members, groupSpeciesId)}`;
    stop(); // leaves review: clears mode/group state, hides the bar, unlocks controllers, renders
    selectDrift?.(driftId);
    commitLayoutChange(description);
  }

  /**
   * A tap on the plan while reviewing (src/interaction/dragController.js's
   * own review bypass calls this with the nearest hit, or '' for a miss):
   * toggle it in/out of the current suggestion's adjusted membership. Group
   * mode (nl-o47.6.4) dispatches to handleGroupTap below — same entry point,
   * same bypass of selection/isolation/dragging, so "shift-click toggles
   * membership" needs no separate code: dragController's review branch never
   * looks at modifier keys, a plain click already does this.
   * @param {string} plantId
   */
  function handleTap(plantId) {
    if (!active || !plantId) return;
    if (mode === 'group') {
      handleGroupTap(plantId);
      return;
    }
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

  /** nl-o47.6.4: a tap while building a hand-made proposal — toggleGroupMember
   * (src/state/driftGroup.js) is the one place this differs from a
   * suggestion's own toggle: a same-species plant already in ANOTHER drift is
   * allowed in (it will move), not refused. */
  function handleGroupTap(plantId) {
    const members = effectiveMembers(null);
    const { members: next, reason } = toggleGroupMember(groupSpeciesId, members, plantId, appState.plants);
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
    startGroup,
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
