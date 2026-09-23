/**
 * The plant detail sheet: tapping or clicking a plant opens its facts for the
 * current month, why its genus matters (keystone / larval host), and which
 * animals reported nearby use it. Elements come in from src/app.js, which owns
 * the DOM lookups; the Clone and Remove buttons stay wired there too, because
 * they go through the app's layout commit and undo path.
 */
import { computePlantState } from '../state/seasonalState.js';
import { buildTooltipLines } from '../render/tooltip.js';
import { ecologicalFitNotes } from '../analysis/hostGenera.js';
import { matchesForGenus } from '../analysis/faunaMatches.js';
import { getGenus } from '../utils/speciesKey.js';

/**
 * @param {object} deps
 * @param {{ sheet, title, lines, ecology, ecologyLines, fauna, faunaLines }} deps.elements
 * @param {object} deps.appState          read for plants, month, project, and the ecology indexes
 * @param {(plantId: string) => void} deps.setTargetedPlant
 * @returns {{ open: (plantId: string) => void, close: () => void }}
 */
export function createDetailSheet({ elements, appState, setTargetedPlant }) {
  const {
    sheet: detailSheet,
    title: detailSheetTitle,
    lines: detailSheetLines,
    ecology: detailSheetEcology,
    ecologyLines: detailSheetEcologyLines,
    fauna: detailSheetFauna,
    faunaLines: detailSheetFaunaLines,
  } = elements;

  const closeDetailSheet = () => {
    if (!detailSheet || detailSheet.hidden) return;
    detailSheet.hidden = true;
    delete detailSheet.dataset.plantId;
    setTargetedPlant('');
  };

  const openDetailSheet = (plantId) => {
    if (!detailSheet) return;
    const plant = appState.plants.find((p) => String(p.id) === String(plantId));
    if (!plant) return;
    const state = computePlantState(plant, appState.month);
    if (detailSheetTitle) {
      detailSheetTitle.innerHTML = '';
      if (plant.botanicalName) {
        const em = document.createElement('em');
        em.textContent = plant.botanicalName;
        detailSheetTitle.appendChild(em);
      } else {
        detailSheetTitle.textContent = plant.commonName || 'Plant details';
      }
    }
    if (detailSheetLines) {
      detailSheetLines.innerHTML = '';
      buildTooltipLines(plant, state)
        .filter(Boolean)
        .filter((line) => line !== plant.botanicalName)
        .forEach((line) => {
          const li = document.createElement('li');
          li.textContent = line;
          detailSheetLines.appendChild(li);
        });
    }
    if (detailSheetEcology && detailSheetEcologyLines) {
      renderDetailSheetEcology(plant, detailSheetEcology, detailSheetEcologyLines);
    }
    if (detailSheetFauna && detailSheetFaunaLines) {
      renderDetailSheetFauna(plant, detailSheetFauna, detailSheetFaunaLines);
    }
    detailSheet.dataset.plantId = plantId;
    detailSheet.hidden = false;
    setTargetedPlant(plantId);
  };

  /**
   * Same source data the keystone-genera and larval-hosts rules grade
   * against (ecologicalFitNotes), so "is this a keystone genus" here can
   * never disagree with the ecology check below the species table.
   */
  const renderDetailSheetEcology = (plant, container, list) => {
    list.innerHTML = '';
    const notes = ecologicalFitNotes(getGenus(plant), appState.hostGenera);
    if (!notes.length) {
      container.hidden = true;
      return;
    }
    notes.forEach((note) => {
      const li = document.createElement('li');
      li.textContent = note;
      list.appendChild(li);
    });
    container.hidden = false;
  };

  /**
   * A separate section from buildTooltipLines on purpose: a match list can run
   * to a dozen-plus animals, which reads as a distinct block of evidence
   * rather than one more line among the plant's static facts.
   */
  const renderDetailSheetFauna = (plant, container, list) => {
    list.innerHTML = '';
    const place = appState.project?.place;
    if (!place || !appState.nearbyFauna.size || !appState.interactions.size) {
      container.hidden = true;
      return;
    }
    const genus = getGenus(plant);
    const matches = matchesForGenus(genus, {
      interactions: appState.interactions,
      nearbyFauna: appState.nearbyFauna,
      place,
    }).filter((match) => match.inRange !== false);
    if (!matches.length) {
      container.hidden = true;
      return;
    }
    matches.forEach((match) => {
      const li = document.createElement('li');
      const name = match.animalCommon ? `${match.animalCommon} (${match.animalSpecies})` : match.animalSpecies;
      const verb = match.category === 'pollinator' ? 'visits its flowers' : 'feeds on it';
      li.textContent = `${name} — ${verb}, reported within ${match.nearestRadiusMi}mi (${match.observationCount} observation${match.observationCount === 1 ? '' : 's'})`;
      list.appendChild(li);
    });
    container.hidden = false;
  };

  if (detailSheet) {
    detailSheet.querySelectorAll('[data-detail-close]').forEach((el) => {
      el.addEventListener('click', closeDetailSheet);
    });
  }

  return { open: openDetailSheet, close: closeDetailSheet };
}
