import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

/**
 * Two function declarations of the same name in one file.
 *
 * JavaScript accepts this silently — the later one wins — so an edit that
 * leaves a stale copy behind changes nothing visible until someone deletes
 * what looks like the duplicate and finds it was the live one. That happened
 * to src/app.js, where a spliced edit left `applyMode`, `syncSetupOverlay`, and
 * `syncFeatureOverlay` each declared twice and the shadowed copies drifted from
 * the real ones. Every module here is small enough that a repeated name is a
 * mistake rather than a pattern.
 */
test('no module declares the same function name twice in one scope', () => {
  const offenders = [];
  sourceFiles(SRC).forEach((file) => {
    const seen = new Map();
    const scope = [];
    let depth = 0;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        // A function is out of scope once the depth falls back to where it
        // opened. Two `handlePointerDown`s in dragController.js are two
        // controllers' own handlers, not a duplicate.
        while (scope.length && depth <= scope[scope.length - 1].openedAt) scope.pop();
        const match = line.match(/^\s*(?:export\s+)?function\s+(\w+)\s*\(/);
        const openedAt = depth;
        const code = line.replace(/\/\/.*$/, '');
        for (const char of code) {
          if (char === '{') depth += 1;
          if (char === '}') depth -= 1;
        }
        if (!match) return;
        const key = `${scope.map((entry) => entry.name).join('>')}>${match[1]}`;
        const at = seen.get(key);
        if (at) offenders.push(`${path.relative(SRC, file)}: ${key} at ${at} and ${index + 1}`);
        else seen.set(key, index + 1);
        scope.push({ name: match[1], openedAt });
      });
  });
  assert.deepEqual(offenders, []);
});

/**
 * And the shape that let those copies hide: a nested function declaration.
 *
 * Every module here is a flat set of helpers plus, in app.js, one long `init`.
 * A `function` indented past its module's top level — or past `init`'s body —
 * means a brace went missing somewhere above it, which is exactly how a stale
 * copy ends up scoped inside its replacement.
 */
test('no function declaration hides inside another', () => {
  const offenders = [];
  sourceFiles(SRC).forEach((file) => {
    let depth = 0;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '');
        for (const char of code) {
          if (char === '{') depth += 1;
          if (char === '}') depth -= 1;
        }
        // Depth is counted AFTER the line, so a declaration's own brace is
        // already included: a top-level function reads 1, one inside `init`
        // reads 2.
        if (/^\s*(?:export\s+)?function\s+\w+\s*\(/.test(line) && depth > 2) {
          offenders.push(`${path.relative(SRC, file)}:${index + 1} ${line.trim()}`);
        }
      });
  });
  assert.deepEqual(offenders, []);
});
