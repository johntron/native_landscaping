import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTopView } from '../src/render/topView.js';

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this._textContent = '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index === -1) throw new Error('child not found');
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  querySelectorAll(selector = '') {
    const parsed = this._parseSelector(selector);
    const matches = [];

    const walk = (node) => {
      if (parsed && this._matches(node, parsed)) {
        matches.push(node);
      }
      node.children.forEach(walk);
    };

    walk(this);
    return matches;
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value ?? '');
  }

  _parseSelector(selector) {
    if (!selector) return null;
    const match = selector.trim().match(/^([a-z]+)?(?:\[([^=\]]+)(?:=(["']?)(.*?)\3)?\])?$/i);
    if (!match) return null;
    return {
      tag: match[1] ? match[1].toUpperCase() : null,
      attr: match[2] ?? null,
      value: match[4] ?? null,
    };
  }

  _matches(node, parsed) {
    if (parsed.tag && node.tagName !== parsed.tag) return false;
    if (parsed.attr) {
      const attrValue = node.getAttribute(parsed.attr);
      if (attrValue === null) return false;
      if (parsed.value && attrValue !== parsed.value) return false;
    }
    return true;
  }
}

class FakeDocument {
  createElementNS(_namespaceURI, tagName) {
    return new FakeElement(tagName);
  }
}

function resetDocument() {
  const fakeDocument = new FakeDocument();
  globalThis.document = fakeDocument;
  globalThis.window = globalThis.window ?? { document: fakeDocument };
  return fakeDocument;
}

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
