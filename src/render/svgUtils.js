export function clearSvg(svg) {
  while (svg.firstChild) {
    svg.removeChild(svg.firstChild);
  }
}

export function createSvgElement(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      el.setAttribute(key, String(value));
    }
  });
  return el;
}

export function appendTooltip(group, lines) {
  const title = createSvgElement('title');
  title.textContent = lines.filter(Boolean).join('\n');
  group.appendChild(title);
}
