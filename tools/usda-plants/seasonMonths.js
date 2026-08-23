// Converts USDA's qualitative season phrases ("Spring and Summer", "Mid Summer",
// "Fall") into the numeric month-range strings plants.csv expects (e.g. "3-8").
// USDA period fields are free-text combinations of an optional intensity
// ("Early"/"Mid"/"Late") and one or more season names joined by "and"/",".

const SEASON_MONTHS = {
  winter: [12, 1, 2],
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  fall: [9, 10, 11],
  autumn: [9, 10, 11],
};

const INTENSITY_INDEX = { early: 0, mid: 1, late: 2 };

function monthsForToken(token) {
  const words = token.trim().toLowerCase().split(/\s+/);
  let intensity = null;
  let season = null;
  for (const word of words) {
    if (word in INTENSITY_INDEX) intensity = word;
    else if (word in SEASON_MONTHS) season = word;
  }
  if (!season) return null;
  const months = SEASON_MONTHS[season];
  if (intensity == null) return months;
  const month = months[INTENSITY_INDEX[intensity]];
  return [month];
}

// "Spring and Summer" / "Spring, Summer, Fall" / "Mid Summer" / "Year Round"
export function parseSeasonPhrase(phrase) {
  if (!phrase) return null;
  const normalized = phrase.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "unknown") return null;
  if (normalized === "year round" || normalized === "year-round") return "1-12";

  const tokens = normalized.split(/\s*(?:,|and)\s*/).filter(Boolean);
  const allMonths = [];
  for (const token of tokens) {
    const months = monthsForToken(token);
    if (months) allMonths.push(...months);
  }
  if (!allMonths.length) return null;

  const unique = [...new Set(allMonths)].sort((a, b) => a - b);
  if (unique.length === 1) return String(unique[0]);

  // Detect a contiguous run (handling December -> January wraparound) and
  // collapse it to "start-end"; otherwise fall back to a comma list.
  const isContiguous = unique.every((m, i) => {
    if (i === 0) return true;
    const prev = unique[i - 1];
    return m === prev + 1 || (prev === 12 && m === 1);
  });
  if (isContiguous) return `${unique[0]}-${unique[unique.length - 1]}`;
  return unique.join(",");
}

// Combine a begin/end pair of season phrases (e.g. Fruit/Seed Period Begin/End)
// into one month range.
export function parseSeasonRange(beginPhrase, endPhrase) {
  const begin = parseSeasonPhrase(beginPhrase);
  const end = parseSeasonPhrase(endPhrase);
  if (!begin && !end) return null;
  if (begin && !end) return begin;
  if (!begin && end) return end;
  const beginMonth = parseInt(begin, 10);
  const endMonth = parseInt(String(end).split(/[-,]/).pop(), 10);
  if (Number.isNaN(beginMonth) || Number.isNaN(endMonth)) return begin;
  return `${beginMonth}-${endMonth}`;
}
