import path from 'node:path';
import { isValidProjectId, PROJECTS_DIR } from './projectConfig.js';

/**
 * Server-side resolution of a project's data files.
 *
 * The project id arrives from the client and becomes a path segment, so it is
 * validated as a slug and the resolved directory is re-checked against the
 * projects root before any read or write.
 *
 * @param {string} projectId
 * @param {string} publicDir absolute path to the served root
 */
export function resolveProjectPaths(projectId, publicDir) {
  if (!isValidProjectId(projectId)) {
    throw new Error(`Invalid or missing project id "${projectId}"`);
  }
  const projectsRoot = path.join(publicDir, PROJECTS_DIR);
  const projectDir = path.resolve(projectsRoot, projectId);
  if (projectDir !== path.join(projectsRoot, projectId)) {
    throw new Error('Project path escapes the projects directory');
  }
  return {
    projectId,
    projectDir,
    layoutFile: path.join(projectDir, 'planting_layout.csv'),
    historyFile: path.join(projectDir, 'layout-history.json'),
  };
}

/** Pull the project id out of a request URL's query string. */
export function projectIdFromUrl(url) {
  return url.searchParams.get('project') || '';
}
