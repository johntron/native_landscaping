import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse a project's planting_layout.csv into {id, botanicalName} rows. */
export async function readLayoutRows(projectId) {
  const csv = await readFile(
    path.join(REPO_ROOT, 'projects', projectId, 'planting_layout.csv'),
    'utf8'
  );
  return csv
    .split(/\r?\n/)
    .slice(1) // drop header
    .filter((line) => line.trim())
    .map((line) => {
      const [id, botanicalName] = line.split(',');
      return { id, botanicalName: (botanicalName || '').trim() };
    });
}

/**
 * Open a project and wait for the first render. Every plan-view plant is a <g>
 * stamped with data-plant-id by renderTopView, so their presence is the signal
 * that CSV loading, parsing, and rendering all completed.
 */
export async function openProject(page, projectId) {
  await page.goto(`/index.html?project=${projectId}`);
  await page.locator('#topSvg g[data-plant-id]').first().waitFor();
}
