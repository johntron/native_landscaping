import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectIdFromUrl, resolveProjectPaths } from '../src/data/projectPaths.js';

const PUBLIC_DIR = '/srv/yard';

test('resolves the per-project data files under projects/', () => {
  const paths = resolveProjectPaths('backyard', PUBLIC_DIR);
  assert.equal(paths.projectId, 'backyard');
  assert.equal(paths.layoutFile, path.join(PUBLIC_DIR, 'projects/backyard/planting_layout.csv'));
  assert.equal(paths.historyFile, path.join(PUBLIC_DIR, 'projects/backyard/layout-history.json'));
});

test('rejects ids that could escape the projects directory', () => {
  const hostile = ['../../etc', '..', 'a/b', 'a\\b', './x', '', 'Back Yard'];
  hostile.forEach((id) => {
    assert.throws(() => resolveProjectPaths(id, PUBLIC_DIR), /Invalid or missing project id/, id);
  });
});

test('reads the project id from a request URL', () => {
  assert.equal(
    projectIdFromUrl(new URL('http://localhost:8000/api/layout?project=frontyard')),
    'frontyard'
  );
  assert.equal(projectIdFromUrl(new URL('http://localhost:8000/api/layout')), '');
});
