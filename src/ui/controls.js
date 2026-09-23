/**
 * Small controls for the design tool's toolbar: the month slider, the zoom
 * input + slider, the scale-indicator bars, a busy state for buttons, and the
 * file-download helper. Each takes its elements as arguments.
 */
import { DEFAULT_ZOOM, INCHES_PER_FOOT, MONTH_NAMES, ZOOM_LIMITS } from '../constants.js';

export function initMonthSlider(sliderEl, readoutEl, initialMonth) {
  if (!sliderEl) return;
  sliderEl.min = '1';
  sliderEl.max = '12';
  sliderEl.step = '1';
  const clamped = clampMonthValue(initialMonth);
  sliderEl.value = String(clamped);
  if (readoutEl) {
    readoutEl.textContent = MONTH_NAMES[clamped - 1] || '';
  }
}

export function initZoomControls(inputEl, sliderEl, onChange, initialValue = DEFAULT_ZOOM) {
  if (!inputEl || !sliderEl) return;

  const { min, max, step } = ZOOM_LIMITS;
  [inputEl, sliderEl].forEach((el) => {
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
  });

  const apply = (rawValue) => {
    const parsed = clampZoomValue(Number(rawValue));
    if (parsed === null) return;
    inputEl.value = formatZoomValue(parsed);
    sliderEl.value = String(parsed);
    onChange?.(parsed);
  };

  inputEl.addEventListener('change', (e) => apply(e.target.value));
  sliderEl.addEventListener('input', (e) => apply(e.target.value));

  apply(initialValue);
}

/**
 * The reference bars are drawn at the view's own scale, which no longer moves —
 * zoom resizes the panel around them rather than restretching the yard.
 */
export function updateScaleIndicator(container, pxPerFt) {
  if (!container) return;
  const items = container.querySelectorAll('.scale-indicator__item');
  items.forEach((item) => {
    const inches = resolveInches(item);
    if (!inches) return;
    const width = Math.max((inches / INCHES_PER_FOOT) * pxPerFt, 4);
    const line = item.querySelector('.scale-indicator__line');
    if (line) {
      line.style.width = `${width}px`;
    }
  });
}

function clampZoomValue(value) {
  if (!Number.isFinite(value)) return null;
  const { min, max } = ZOOM_LIMITS;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clampMonthValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1) return 1;
  if (parsed > 12) return 12;
  return Math.round(parsed);
}

function formatZoomValue(value) {
  return value.toFixed(2);
}

export function formatFileSize(bytes) {
  const kb = Number(bytes) / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
}

function resolveInches(item) {
  const inchesAttr = item.dataset.inches;
  if (inchesAttr) {
    const val = Number(inchesAttr);
    return Number.isFinite(val) ? val : null;
  }
  const feetAttr = item.dataset.feet;
  if (feetAttr) {
    const val = Number(feetAttr);
    return Number.isFinite(val) ? val * 12 : null;
  }
  return null;
}

export function triggerDownload(blob, filename) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'download';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function toggleButtonBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = button.textContent || '';
    }
    button.disabled = true;
    if (busyText) {
      button.textContent = busyText;
    }
    return;
  }
  button.disabled = false;
  if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
  }
}

export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
