import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectIdFromUrl, resolveProjectPhoto } from '../src/data/projectPaths.js';

const PROJECT_DIR = '/srv/data/projects/7';

test('resolves a photo path inside the yard directory', () => {
  assert.equal(resolveProjectPhoto(PROJECT_DIR, 'img/top.webp'), path.join(PROJECT_DIR, 'img/top.webp'));
  assert.equal(
    resolveProjectPhoto(PROJECT_DIR, 'img/plan-130d05047b7d.webp'),
    path.join(PROJECT_DIR, 'img/plan-130d05047b7d.webp')
  );
  assert.equal(resolveProjectPhoto(PROJECT_DIR, 'img/north.svg'), path.join(PROJECT_DIR, 'img/north.svg'));
});

test('refuses anything that is not a photo in img/', () => {
  const hostile = [
    '',
    '../1/img/top.webp',
    'img/../../2/img/top.webp',
    'img/sub/top.webp',
    '/etc/passwd',
    'img/top.xcf',
    'img/top.html',
    'img/.hidden.webp',
    'project.json',
    'img\\top.webp',
  ];
  hostile.forEach((rel) => assert.equal(resolveProjectPhoto(PROJECT_DIR, rel), null, rel));
});

test('reads the project id from a request URL', () => {
  assert.equal(
    projectIdFromUrl(new URL('http://localhost:8000/api/layout?project=frontyard')),
    'frontyard'
  );
  assert.equal(projectIdFromUrl(new URL('http://localhost:8000/api/layout')), '');
});
