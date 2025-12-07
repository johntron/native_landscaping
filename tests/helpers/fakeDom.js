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

export function resetDocument() {
  const fakeDocument = new FakeDocument();
  globalThis.document = fakeDocument;
  globalThis.window = globalThis.window ?? { document: fakeDocument };
  return fakeDocument;
}

export { FakeElement, FakeDocument };
