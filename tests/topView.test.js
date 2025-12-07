import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTopView } from '../src/render/topView.js';
import { resetDocument } from './helpers/fakeDom.js';

const sharedState = {
  foliageColor: '#5b8c3a',
  flowerColor: null,
  fruitColor: null,
  isGrowing: true,
  isFlowering: false,
  isFruiting: false,
};

test('renderTopView clears nodes and renders groups along with highlight/target markers', () => {
  const doc = resetDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.appendChild(doc.createElementNS('http://www.w3.org/2000/svg', 'circle'));

  const plantStates = [
    {
      plant: {
        id: 'alpha',
        commonName: 'Alpha Shrub',
        botanicalName: 'Ceanothus americanus',
        botanicalKey: 'ceanothus americanus',
        width: 3,
        height: 4,
        x: 10,
        y: 5,
        sunPref: 'Full sun',
        waterPref: 'Moderate',
        soilPref: 'Loam',
      },
      state: sharedState,
    },
    {
      plant: {
        id: 'beta',
        commonName: 'Beta Grass',
        botanicalName: 'Bouteloua curtipendula',
        botanicalKey: 'bouteloua curtipendula',
        width: 2,
        height: 2,
        x: 12,
        y: 6,
        sunPref: 'Full sun',
        waterPref: 'Dry',
        soilPref: 'Clay',
      },
      state: sharedState,
    },
  ];

  renderTopView(svg, plantStates, 2.5, {
    highlightedSpeciesKey: 'bouteloua curtipendula',
    targetedPlantId: 'alpha',
    hoveredPlantId: 'beta',
  });

  const plantGroups = svg.querySelectorAll('g[data-plant-id]');
  assert.equal(plantGroups.length, plantStates.length);
  assert.ok(
    plantGroups[0].querySelectorAll('title').some((node) => node.textContent.includes('Alpha Shrub')),
    'tooltip includes the common name for each plant group'
  );

  const highlightRing = svg
    .querySelectorAll('circle')
    .find((circle) => circle.getAttribute('stroke-dasharray') === '7 6');
  assert.ok(highlightRing, 'highlight ring is appended');

  const targetRing = svg
    .querySelectorAll('circle')
    .find((circle) => circle.getAttribute('stroke') === '#1b74d8');
  assert.ok(targetRing, 'target marker is appended for hovered/targeted plants');
});
