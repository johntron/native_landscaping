/*
 * Main JavaScript for the backyard visualization.
 *
 * Plants are loaded from a CSV file in the same folder as this script. The CSV
 * specifies location (x,y), size, growth and flowering seasons and color
 * preferences. The app renders three SVG overlays (top‑down, front and side
 * views) atop background images. A month selector updates the visuals to
 * reflect seasonal colour changes. When hovering over a plant the browser's
 * default tooltip reveals the plant's name and preferences.
 */

(function () {
  // Month names and their corresponding numbers (1‑12). The index in the array
  // matches the value stored in the select element.
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  // Populate the month dropdown on page load. The current month is selected by
  // default based on the user's local date.
  function initMonthSelector() {
    const select = document.getElementById('monthSelect');
    monthNames.forEach((name, idx) => {
      const option = document.createElement('option');
      option.value = idx + 1; // months numbered 1‑12
      option.textContent = name;
      select.appendChild(option);
    });
    // Default to the current month
    const now = new Date();
    select.value = now.getMonth() + 1;
  }

  // Fetch and parse the CSV file. Numeric fields are converted to numbers and
  // anything unrecognised is left as a string. The first line of the CSV is
  // assumed to be the header defining the property names.
  async function loadPlants(csvPath) {
    const response = await fetch(csvPath, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load plants CSV (${response.status})`);
    }
    const csvText = await response.text();
    const lines = csvText.trim().split(/\r?\n/);
    const header = lines[0].split(',');
    const plants = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = [];
      let current = '';
      let inQuotes = false;
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          parts.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      parts.push(current);
      const plant = {};
      header.forEach((key, idx) => {
        let val = parts[idx];
        if (
          ['x', 'y', 'width', 'height', 'growthStart', 'growthEnd', 'flowerStart', 'flowerEnd'].includes(
            key
          )
        ) {
          val = Number(val);
        }
        plant[key] = val;
      });
      plants.push(plant);
    }
    return plants;
  }

  // Determine whether a month lies within a given season (inclusive). Seasons
  // defined across year boundaries (e.g. Nov–Feb) are also handled.
  function isInSeason(month, start, end) {
    if (start <= end) {
      return month >= start && month <= end;
    }
    // season wraps across year end
    return month >= start || month <= end;
  }

  // Choose the current leaf and flower colours for a plant given the selected
  // month. When out of the growth season the leaf colour defaults to a brown
  // shade and flowers are hidden.
  function getPlantColours(plant, month) {
    const inGrowth = isInSeason(month, plant.growthStart, plant.growthEnd);
    const inFlower = isInSeason(month, plant.flowerStart, plant.flowerEnd);
    const leafColour = inGrowth ? plant.leafColor : '#a38c61';
    const flowerColour = inFlower && inGrowth ? plant.flowerColor : null;
    return { leafColour, flowerColour };
  }

  // Remove any existing plant groups from an SVG root
  function clearSvg(svg) {
    while (svg.firstChild) {
      svg.removeChild(svg.firstChild);
    }
  }

  // Render all plants into the three views for the selected month. Each plant
  // becomes a group (<g>) with shapes inside. A title element attached to the
  // group displays extra information on hover via the browser's native tooltip.
  function renderViews(plants, month) {
    const topSvg = document.getElementById('topSvg');
    const frontSvg = document.getElementById('frontSvg');
    const sideSvg = document.getElementById('sideSvg');
    clearSvg(topSvg);
    clearSvg(frontSvg);
    clearSvg(sideSvg);
    plants.forEach((plant) => {
      const { leafColour, flowerColour } = getPlantColours(plant, month);
      // Build tooltip text showing details. Use line breaks for readability.
      const tooltipLines = [
        plant.name,
        `Flower: ${plant.flowerColor}`,
        `Leaf: ${plant.leafColor}`,
        `Sun: ${plant.sunPref}`,
        `Water: ${plant.waterPref}`,
        `Soil: ${plant.soilPref}`,
      ];
      const titleText = tooltipLines.join('\n');
      // Top view: represent the plant as a circle scaled by width. X/Y are centre.
      {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('data-name', plant.name);
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', plant.x);
        circle.setAttribute('cy', 100 - plant.y); // flip y so origin is bottom left
        const radius = plant.width / 2;
        circle.setAttribute('r', radius);
        circle.setAttribute('fill', leafColour);
        g.appendChild(circle);
        // Flower indicator: a smaller circle inside if flowering
        if (flowerColour) {
          const flowerCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          flowerCircle.setAttribute('cx', plant.x);
          flowerCircle.setAttribute('cy', 100 - plant.y);
          flowerCircle.setAttribute('r', Math.max(radius * 0.4, 0.5));
          flowerCircle.setAttribute('fill', flowerColour);
          g.appendChild(flowerCircle);
        }
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = titleText;
        g.appendChild(title);
        topSvg.appendChild(g);
      }
      // Front view: represent the plant as an ellipse scaled by width and height.
      {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('data-name', plant.name);
        const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        ellipse.setAttribute('cx', plant.x);
        ellipse.setAttribute('cy', 100 - plant.height / 2);
        ellipse.setAttribute('rx', plant.width / 2);
        ellipse.setAttribute('ry', plant.height / 2);
        ellipse.setAttribute('fill', leafColour);
        g.appendChild(ellipse);
        // Flower indicator: small ellipse on top
        if (flowerColour) {
          const fEll = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
          fEll.setAttribute('cx', plant.x);
          fEll.setAttribute('cy', 100 - plant.height);
          fEll.setAttribute('rx', Math.max(plant.width * 0.2, 0.3));
          fEll.setAttribute('ry', Math.max(plant.width * 0.2, 0.3));
          fEll.setAttribute('fill', flowerColour);
          g.appendChild(fEll);
        }
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = titleText;
        g.appendChild(title);
        frontSvg.appendChild(g);
      }
      // Side view: similar to front view but x coordinate reflects y position to
      // provide a sense of depth (plants at the top of the yard appear farther
      // back). We map y (0‑100) into x‑position to create a parallax effect.
      {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('data-name', plant.name);
        // Map y to horizontal position: plants further back (higher y) appear
        // nearer the horizon (left side). We'll invert y for side view as
        // well to keep the yard origin bottom left. Range 0–100 maps to 0–100.
        const depthX = plant.y; // using y coordinate as depth axis
        const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        ellipse.setAttribute('cx', depthX);
        ellipse.setAttribute('cy', 100 - plant.height / 2);
        ellipse.setAttribute('rx', plant.width / 2);
        ellipse.setAttribute('ry', plant.height / 2);
        ellipse.setAttribute('fill', leafColour);
        g.appendChild(ellipse);
        if (flowerColour) {
          const fEll = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
          fEll.setAttribute('cx', depthX);
          fEll.setAttribute('cy', 100 - plant.height);
          fEll.setAttribute('rx', Math.max(plant.width * 0.2, 0.3));
          fEll.setAttribute('ry', Math.max(plant.width * 0.2, 0.3));
          fEll.setAttribute('fill', flowerColour);
          g.appendChild(fEll);
        }
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = titleText;
        g.appendChild(title);
        sideSvg.appendChild(g);
      }
    });
  }

  // Display a friendly error message if the CSV cannot be loaded.
  function showLoadError(message) {
    console.error(message);
    const existing = document.querySelector('.error-banner');
    if (existing) {
      existing.textContent = message;
      return;
    }
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.textContent = `${message} Please make sure plants.csv is served over HTTP (e.g. via \`npx serve\`).`;
    const main = document.querySelector('main');
    if (main) {
      main.insertAdjacentElement('beforebegin', banner);
    } else {
      document.body.appendChild(banner);
    }
  }

  // Initialise the application: load plants, populate the month selector and
  // render the initial views. Attach an event listener to the select so
  // changing the month updates the views without reloading data.
  async function init() {
    initMonthSelector();
    let plants;
    try {
      plants = await loadPlants(new URL('plants.csv', document.baseURI));
    } catch (err) {
      showLoadError('Unable to load plants data.');
      return;
    }
    const monthSelect = document.getElementById('monthSelect');
    const update = () => {
      const month = parseInt(monthSelect.value, 10);
      renderViews(plants, month);
    };
    monthSelect.addEventListener('change', update);
    update();
  }

  // Kick things off once the DOM is ready. Some browsers support DOMContentLoaded
  // while others default to load, but using both ensures compatibility.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();