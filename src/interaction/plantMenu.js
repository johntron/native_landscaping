/**
 * The right-click (long-press on touch) menu on a plant: Clone and Remove.
 * Appends its own element to <body> and hands back show/hide.
 */

export function createPlantMenu({ onClone, onRemove, onClose }) {
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  const list = document.createElement('ul');
  list.className = 'context-menu__list';
  const addItem = (label, handler, modifier) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = modifier ? `context-menu__item ${modifier}` : 'context-menu__item';
    button.textContent = label;
    button.addEventListener('click', () => {
      const plantId = menu.dataset.plantId;
      if (plantId) {
        handler?.(plantId);
      }
    });
    item.appendChild(button);
    list.appendChild(item);
  };
  addItem('Clone plant', onClone);
  addItem('Remove plant', onRemove, 'context-menu__item--danger');
  menu.appendChild(list);
  document.body.appendChild(menu);

  const api = {
    show: ({ x, y, plantId }) => {
      if (!plantId) return;
      const offsetX = window.scrollX || 0;
      const offsetY = window.scrollY || 0;
      const menuWidth = 180;
      const menuHeight = 88; // two items
      const maxLeft = offsetX + window.innerWidth - menuWidth - 8;
      const maxTop = offsetY + window.innerHeight - menuHeight - 8;
      menu.style.left = `${Math.min(x + offsetX, maxLeft)}px`;
      menu.style.top = `${Math.min(y + offsetY, maxTop)}px`;
      menu.dataset.plantId = plantId;
      menu.classList.add('is-open');
    },
    hide: () => {
      menu.classList.remove('is-open');
      delete menu.dataset.plantId;
      onClose?.();
    },
    contains: (node) => node instanceof Node && menu.contains(node),
    isOpen: () => menu.classList.contains('is-open'),
  };

  return api;
}
