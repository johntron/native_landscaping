/**
 * The design tool's history as the page uses it: the undo and redo buttons,
 * the save-status line, and committing a change. Since nl-3s5.20 there are
 * three kinds of change, all in one revision stream shared with the server:
 *
 * - commit(description): the planting, on every drag, add, clone or remove
 *   (POST /api/layout);
 * - commitSetup(project): the setup, when Save views is pressed (POST /api/project);
 * - commitFeatures(features): the features, when Save features is pressed
 *   (POST /api/features).
 *
 * Undo and redo step across all three. Moving onto a revision always shows
 * its plants, and restores its setup or its features only where they differ
 * from what the stack showed before (onRestoreConfig / onRestoreFeatures),
 * so undoing a plant move leaves unsaved Setup edits alone, and undoing a
 * Save views brings back the previous setup while the planting stays as it was.
 *
 * Keeping the local stack and the server's stream on the same indices is the
 * whole game, so:
 * - every request (saves and cursor moves) goes through one queue, in the
 *   order the stack changed, so the server applies them in that order;
 * - each save is recorded locally when it is sent, and the server's answer
 *   annotates THAT entry (by index), never whichever entry is current by then;
 * - what a request sends is copied when the change is recorded, not when the
 *   queue gets to it: the plants and the project are mutated in place (a drag,
 *   a Setup edit), and a queued save must send the state it recorded;
 * - the server's cursor is checked, not adopted: an answer that disagrees
 *   with the local index means another tab (or a tab from before the deploy)
 *   changed the yard, and the controller stops offering undo and redo and says
 *   to reload rather than move a cursor it no longer understands. Saves keep
 *   going: the server appends each after its own cursor, so none is lost,
 *   and only undo and redo depend on the indices;
 * - a save the server refused is taken back off the stack if nothing came
 *   after it, and otherwise is the same reload case.
 *
 * Setup and features saves are skipped, not sent, when they would record the
 * same setup or features as the current revision (compared in normalized
 * form), so pressing Save twice is not two undo steps.
 *
 * History holds placements only (src/data/placements.js); the plants shown are
 * always built from them with plantsFromPlacements, so their attributes are
 * whatever plants.csv says now (nl-3s5.19). History IS the yard (nl-3s5.3):
 * the plants shown are the entry at the stored cursor.
 */
import { createLayoutHistory } from './layoutHistory.js';
import { toPlacements } from '../data/placements.js';
import { plantsFromPlacements } from '../data/plantParser.js';
import { normalizeProjectConfig, serializeProjectConfig } from '../data/projectConfig.js';
import { normalizeFeatures, serializeFeatures } from '../data/featureConfig.js';
import {
  persistFeatures,
  persistLayout,
  persistProjectConfig,
  updateHistoryCursor,
} from '../data/persistence.js';

export const SETUP_DESCRIPTION = 'Saved views';
export const FEATURES_DESCRIPTION = 'Saved features';
export const DESYNC_MESSAGE =
  'This yard changed somewhere else. Your changes are still saved; reload the page before undoing.';

/**
 * @param {object} deps
 * @param {object} deps.appState                  reads species and project; replaces plants
 * @param {HTMLButtonElement|null} deps.undoButton
 * @param {HTMLButtonElement|null} deps.redoButton
 * @param {HTMLElement|null} deps.historyStatus
 * @param {() => void} deps.render
 * @param {() => void} deps.refreshSpeciesTable
 * @param {(config: object) => void} [deps.onRestoreConfig]      show a revision's setup (file shape)
 * @param {(features: object|null) => void} [deps.onRestoreFeatures]  show a revision's features file
 */
export function createLayoutHistoryController({
  appState,
  undoButton,
  redoButton,
  historyStatus,
  render,
  refreshSpeciesTable,
  onRestoreConfig = () => {},
  onRestoreFeatures = () => {},
}) {
  let layoutHistoryInstance = null;
  let desynced = false;
  // Every request, in the order the stack changed. Each task resolves (the
  // persist helpers report failure as null, never a rejection).
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const run = queue.then(task);
    queue = run.catch(() => null);
    return run;
  };

  const projectId = () => appState.project?.id;

  const updateHistoryStatus = (message, state = '') => {
    if (!historyStatus) return;
    historyStatus.textContent = message || '';
    if (state) {
      historyStatus.dataset.state = state;
    } else {
      historyStatus.removeAttribute('data-state');
    }
  };

  const updateHistoryControls = () => {
    const canUndo = !desynced && (layoutHistoryInstance?.canUndo() ?? false);
    const canRedo = !desynced && (layoutHistoryInstance?.canRedo() ?? false);
    if (undoButton) {
      undoButton.disabled = !canUndo;
      const current = layoutHistoryInstance?.getCurrentEntry();
      undoButton.title = canUndo && current ? `Undo: ${current.description}` : '';
    }
    if (redoButton) {
      redoButton.disabled = !canRedo;
      const next = layoutHistoryInstance?.getEntry(layoutHistoryInstance.getCursor() + 1);
      redoButton.title = canRedo && next ? `Redo: ${next.description}` : '';
    }
  };

  /** Stop offering undo: the local stack no longer matches the server's. */
  const markDesynced = (why) => {
    if (!desynced) console.warn('Revision history out of step with the server:', why);
    desynced = true;
    updateHistoryStatus(DESYNC_MESSAGE, 'error');
    updateHistoryControls();
  };

  /**
   * After a save's answer: annotate the entry at `index`, or take it back.
   * @param {number} index        where the save was recorded locally
   * @param {{ entry?: object, cursor?: number } | null} revision  the server's revision, null on failure
   * @param {object} [extra]      further fields to adopt (the server's config or features)
   */
  const settleSave = (index, revision, extra = {}) => {
    if (desynced) {
      // The save still reached the server (or said why not); the indices are
      // what cannot be trusted, so keep the reload notice on screen.
      updateHistoryStatus(DESYNC_MESSAGE, 'error');
      return;
    }
    if (!revision) {
      if (layoutHistoryInstance.dropTip(index)) {
        updateHistoryControls();
      } else {
        markDesynced(`save at ${index} failed with later entries recorded`);
      }
      return;
    }
    if (revision.cursor !== index) {
      markDesynced(`server put the save at ${revision.cursor}, expected ${index}`);
      return;
    }
    const { plants: _ignored, ...entryMeta } = revision.entry || {};
    layoutHistoryInstance.annotateEntry(index, { ...entryMeta, ...extra });
    updateHistoryControls();
  };

  const toPlants = (placements) =>
    plantsFromPlacements(placements, appState.species, { synonyms: appState.speciesSynonyms });

  const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  /**
   * Show the entry the cursor just moved onto, given the one it left: its
   * plants always, its setup and features only where they differ.
   */
  const applyEntry = (from, to) => {
    if (!to) return;
    if (from && !sameJson(from.config, to.config)) onRestoreConfig(to.config);
    if (from && !sameJson(from.features, to.features)) onRestoreFeatures(to.features);
    // Undo/redo move POSITIONS through history; attributes come from the catalog.
    appState.plants = toPlants(to.plants);
    render();
    // Undoing an add or a remove changes which species are placed.
    refreshSpeciesTable();
    updateHistoryControls();
  };

  const step = (direction) => {
    if (!layoutHistoryInstance || desynced) return;
    const from = layoutHistoryInstance.getCurrentEntry();
    const moved = direction < 0 ? layoutHistoryInstance.undo() : layoutHistoryInstance.redo();
    if (!moved) return;
    const to = layoutHistoryInstance.getCurrentEntry();
    applyEntry(from, to);
    const cursor = layoutHistoryInstance.getCursor();
    const verb = direction < 0 ? 'Undid' : 'Redid';
    const described = direction < 0 ? from : to;
    enqueue(() =>
      updateHistoryCursor(cursor, updateHistoryStatus, { projectId: projectId() }).then((result) => {
        if (!result) {
          markDesynced(`cursor move to ${cursor} failed`);
        } else if (result.cursor !== cursor) {
          markDesynced(`server cursor ${result.cursor}, expected ${cursor}`);
        } else if (!desynced) {
          updateHistoryStatus(`${verb}: ${described?.description || 'change'}`, 'success');
        }
        return result;
      })
    );
  };

  if (undoButton) {
    undoButton.addEventListener('click', () => step(-1));
  }
  if (redoButton) {
    redoButton.addEventListener('click', () => step(1));
  }

  /**
   * Record `plants` as one planting revision and persist it through POST
   * /api/layout. The setup and features are carried from the current entry:
   * the saved ones, which is what the server carries too, not any unsaved
   * edit on screen.
   */
  function recordAndPersist(plants, description, status = updateHistoryStatus) {
    const previousPlants = layoutHistoryInstance.getCurrentPlants();
    // Copied now: a drag moves the plant objects in place, and this request
    // may wait in the queue behind another.
    const snapshot = toPlacements(plants);
    layoutHistoryInstance.record(snapshot, { description, kind: 'planting' });
    const index = layoutHistoryInstance.getCursor();
    updateHistoryControls();
    // previousPlants seeds the server's 'Initial layout' entry when it has no
    // history yet (a new yard), so both stacks keep the same indices.
    return enqueue(() =>
      persistLayout(snapshot, description, status, { previousPlants, projectId: projectId() })
    ).then((result) => {
      settleSave(index, result && typeof result.cursor === 'number' ? result : null);
      return result;
    });
  }

  /**
   * Build the stack from the saved history and return the plants to show:
   * the entry at the cursor, or none for a yard with no history yet.
   *
   * @param {{ entries?: Array, cursor?: number }} historyData  from loadLayoutHistory
   * @param {{ config?: object|null, features?: object|null }} [current]
   *   the setup (file shape) and features file the page loaded, for a yard
   *   with no history (its base entry) and for an entry that carries none
   */
  function start(historyData, current = {}) {
    const entries = Array.isArray(historyData?.entries) ? historyData.entries : [];
    layoutHistoryInstance = createLayoutHistory([], {
      seedEntries: entries,
      initialCursor: typeof historyData?.cursor === 'number' ? historyData.cursor : null,
      initialConfig: current.config ?? null,
      initialFeatures: current.features ?? null,
    });
    desynced = false;
    updateHistoryControls();
    return toPlants(layoutHistoryInstance.getCurrentPlants());
  }

  /** Record appState.plants as one undoable step and persist it. */
  function commit(description) {
    if (!layoutHistoryInstance) return;
    recordAndPersist(appState.plants, description);
  }

  const canonicalConfig = (config) => {
    try {
      return JSON.stringify(serializeProjectConfig(normalizeProjectConfig(config, projectId())));
    } catch {
      return null;
    }
  };

  const canonicalFeatures = (features) => {
    try {
      return JSON.stringify(serializeFeatures(normalizeFeatures(features ?? null, projectId() || 'project')));
    } catch {
      return null;
    }
  };

  /**
   * Save the setup as one revision. Resolves to `{ unchanged: true }` when it
   * matches the current revision's setup (nothing sent), the server's answer
   * on success, or null on failure (the status callback has said why).
   * @param {object} project  a normalized project config
   * @param {(message: string, state: string) => void} [status]
   */
  function commitSetup(project, status) {
    if (!layoutHistoryInstance) return Promise.resolve(null);
    const serialized = serializeProjectConfig(project);
    const current = layoutHistoryInstance.getCurrentEntry();
    const canonical = canonicalConfig(serialized);
    if (canonical !== null && canonical === canonicalConfig(current?.config)) {
      // Already the saved setup: nothing to record, and nothing to send.
      status?.('Views saved', 'success');
      return Promise.resolve({ unchanged: true });
    }
    layoutHistoryInstance.record(layoutHistoryInstance.getCurrentPlants(), {
      description: SETUP_DESCRIPTION,
      kind: 'setup',
      config: serialized,
    });
    const index = layoutHistoryInstance.getCursor();
    updateHistoryControls();
    // The project is edited in place (applyViewEdit); send it as it was saved.
    const sent = cloneJson(project);
    return enqueue(() => persistProjectConfig(sent, status, { projectId: projectId() })).then((data) => {
      settleSave(index, data?.revision ?? null, data?.config ? { config: data.config } : {});
      return data;
    });
  }

  /**
   * Save the features as one revision; resolves like commitSetup.
   * @param {Array<object>} features  normalized features
   * @param {(message: string, state: string) => void} [status]
   */
  function commitFeatures(features, status) {
    if (!layoutHistoryInstance) return Promise.resolve(null);
    const serialized = serializeFeatures({ features });
    const current = layoutHistoryInstance.getCurrentEntry();
    const canonical = canonicalFeatures(serialized);
    if (canonical !== null && canonical === canonicalFeatures(current?.features)) {
      status?.('Features saved', 'success');
      return Promise.resolve({ unchanged: true });
    }
    layoutHistoryInstance.record(layoutHistoryInstance.getCurrentPlants(), {
      description: FEATURES_DESCRIPTION,
      kind: 'features',
      features: serialized,
    });
    const index = layoutHistoryInstance.getCursor();
    updateHistoryControls();
    const sent = cloneJson(features);
    return enqueue(() => persistFeatures(sent, status, { projectId: projectId() })).then((data) => {
      const { revision, ...saved } = data || {};
      settleSave(index, revision ?? null, Array.isArray(saved.features) ? { features: saved } : {});
      return data;
    });
  }

  return {
    start,
    commit,
    commitSetup,
    commitFeatures,
    updateStatus: updateHistoryStatus,
    /** Resolves once every request sent so far has been answered (tests, e2e). */
    idle: () => queue,
    isDesynced: () => desynced,
  };
}

/** A deep copy of plain data (a normalized project or feature list). */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
