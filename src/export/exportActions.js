/**
 * The design tool's two downloads: the plan bundle (plants.csv, the layout,
 * and a PNG per view) and the HOA submission packet (a cover letter and the
 * same PNGs). Both render every view in June with all layers shown and nothing
 * hovered, capture the panels, zip them, and then put the page back exactly as
 * the user left it.
 *
 * Everything the app may reassign after this is built — the project, the view
 * panels (rebuilt on a Setup save), the render function, the loaded species
 * CSV — comes in as a getter, so an export always reads the current value
 * rather than the one that existed when the button was wired.
 */
import { MONTH_NAMES } from '../constants.js';
import { projectAssetPath } from '../data/projectConfig.js';
import { buildLayoutCsv } from '../data/layoutExporter.js';
import { resolvePhotoPlacement } from '../render/photoPlacement.js';
import { nextFrame, toggleButtonBusy, triggerDownload } from '../ui/controls.js';
import { captureViewToPng } from './viewCapture.js';
import { buildHoaCoverLetter, summarizePlacedSpecies } from './hoaPacket.js';

const EXPORT_MONTH = 6; // June

/**
 * @param {object} deps
 * @param {object} deps.appState                 src/app.js's appState (mutated, then restored)
 * @param {() => object} deps.getProject
 * @param {() => Array<{ view: object, svg: SVGSVGElement }>} deps.getViewPanels
 * @param {() => string} deps.getSpeciesCsv      the loaded plants.csv text; '' until it loads
 * @param {() => void} deps.render
 * @param {(count: number, opts?: object) => void} deps.applyHiddenLayers
 * @param {(count: number) => void} deps.syncLayerButtons
 * @param {HTMLInputElement|null} deps.monthSlider
 * @param {HTMLElement|null} deps.monthReadout
 */
export function createExportActions({
  appState,
  getProject,
  getViewPanels,
  getSpeciesCsv,
  render,
  applyHiddenLayers,
  syncLayerButtons,
  monthSlider,
  monthReadout,
}) {
  let isBundleExporting = false;
  const JSZipLib = typeof window !== 'undefined' ? window.JSZip : null;

  const panelsReady = () => {
    const viewPanels = getViewPanels();
    return viewPanels.length && !viewPanels.some(({ svg }) => !svg);
  };

  /**
   * Put the page in its export state, hand `build` the captured PNGs, and
   * restore the page whatever happens. `build` returns the zip's blob and
   * file name.
   */
  async function runExport(button, busyText, failureLabel, build) {
    isBundleExporting = true;
    const restoreToken = snapshotViewState({
      monthSlider,
      monthReadout,
      state: appState,
    });
    toggleButtonBusy(button, true, busyText);
    applyHiddenLayers(0, { shouldRender: false });
    appState.hoveredPlantId = '';
    appState.targetedPlantId = '';
    appState.month = EXPORT_MONTH;
    if (monthSlider) monthSlider.value = String(EXPORT_MONTH);
    if (monthReadout) monthReadout.textContent = MONTH_NAMES[EXPORT_MONTH - 1] || '';
    render();
    await nextFrame();

    try {
      if (!JSZipLib) {
        throw new Error('JSZip is not loaded');
      }
      const project = getProject();
      const panels = getViewPanels().map(({ view, svg }) => ({
        view,
        svg,
        fileName: `${view.id}-view.png`,
      }));
      const pngs = await Promise.all(
        panels.map(({ view, svg }) =>
          captureViewToPng({
            svg,
            viewBox: view.viewBox,
            ...backgroundForCapture(project, view),
          })
        )
      );

      const zip = new JSZipLib();
      const fileName = build({ zip, project });
      pngs.forEach((png, index) => {
        zip.file(`images/${panels[index].fileName}`, png);
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      triggerDownload(blob, fileName);
    } catch (err) {
      console.error(`Failed to export ${failureLabel}`, err);
      alert(`Unable to export ${failureLabel}. Check console for details.`);
    } finally {
      restoreViewState(restoreToken, {
        monthSlider,
        monthReadout,
        state: appState,
        onRestore: () => {
          syncLayerButtons(appState.hiddenLayerCount);
          render();
        },
      });
      toggleButtonBusy(button, false);
      isBundleExporting = false;
    }
  }

  async function exportBundle(button) {
    if (isBundleExporting) return;
    if (!panelsReady()) return;
    const speciesCsv = getSpeciesCsv();
    if (!speciesCsv) {
      console.warn('No plants.csv loaded; cannot export bundle.');
      return;
    }
    await runExport(button, 'Preparing bundle…', 'plan bundle', ({ zip, project }) => {
      zip.file('plants.csv', speciesCsv);
      zip.file('planting_layout.csv', buildLayoutCsv(appState.plants));
      return `${project.id}-plan.zip`;
    });
  }

  async function exportHoaPacket(button) {
    if (isBundleExporting) return;
    if (!panelsReady()) return;
    await runExport(button, 'Preparing packet…', 'HOA packet', ({ zip, project }) => {
      const species = summarizePlacedSpecies(appState.plants);
      const coverLetter = buildHoaCoverLetter({
        projectName: project.name || project.id,
        species,
        preparedOn: new Date().toISOString().slice(0, 10),
      });
      zip.file('cover-letter.txt', coverLetter);
      return `${project.id}-hoa-packet.zip`;
    });
  }

  return { exportBundle, exportHoaPacket };
}

/**
 * Background to composite under a view's export: an absolute URL plus, for a
 * photo that has been placed, the rectangle of the drawing it occupies. Both
 * are null when the view has no image yet — captureViewToPng then skips the
 * background rather than fetching a photo named null.
 */
function backgroundForCapture(project, view) {
  const { path, rect } = resolvePhotoPlacement(view);
  if (!path) return { backgroundUrl: null, destRect: null };
  return {
    backgroundUrl: new URL(projectAssetPath(project.id, path), document.baseURI).toString(),
    destRect: rect,
  };
}

function snapshotViewState({ monthSlider, monthReadout, state }) {
  return {
    month: state.month,
    hiddenLayerCount: state.hiddenLayerCount,
    highlightedSpeciesKey: state.highlightedSpeciesKey,
    targetedPlantId: state.targetedPlantId,
    hoveredPlantId: state.hoveredPlantId,
    monthSliderValue: monthSlider ? monthSlider.value : null,
    monthReadoutText: monthReadout ? monthReadout.textContent : null,
  };
}

function restoreViewState(snapshot, { monthSlider, monthReadout, state, onRestore }) {
  if (!snapshot) return;
  state.month = snapshot.month;
  state.hiddenLayerCount = snapshot.hiddenLayerCount;
  state.highlightedSpeciesKey = snapshot.highlightedSpeciesKey;
  state.targetedPlantId = snapshot.targetedPlantId;
  state.hoveredPlantId = snapshot.hoveredPlantId;
  if (monthSlider && snapshot.monthSliderValue !== null) {
    monthSlider.value = snapshot.monthSliderValue;
  }
  if (monthReadout && snapshot.monthReadoutText !== null) {
    monthReadout.textContent = snapshot.monthReadoutText;
  }
  onRestore?.();
}
