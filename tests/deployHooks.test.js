// The .githooks/ dispatcher (nl-3s5.12): a commit or merge on main deploys,
// a commit anywhere else never does, a failed deploy never loses the commit,
// and the beads/git-lfs hooks in .beads/hooks/ still run. Hermetic: a scratch
// repo in a temp dir, no global or system git config, and REWILDER_DEPLOY_CMD
// standing in for tools/deploy.sh, so nothing here touches Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_') || key.startsWith('REWILDER_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    ...extra,
  };
}

function scratchRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(path.join(REPO, '.githooks'), path.join(dir, '.githooks'), { recursive: true });
  const marker = path.join(dir, 'deploys.log');
  const deployCmd = path.join(dir, 'fake-deploy.sh');
  writeFileSync(deployCmd, `#!/bin/sh\ngit rev-parse HEAD >> '${marker}'\nexit "\${FAKE_DEPLOY_EXIT:-0}"\n`);
  chmodSync(deployCmd, 0o755);
  const env = cleanEnv({ REWILDER_DEPLOY_CMD: deployCmd });
  const git = (args, extraEnv = {}) =>
    spawnSync('git', args, { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const ok = (args, extraEnv) => {
    const result = git(args, extraEnv);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`);
    return result;
  };
  ok(['init', '-q', '-b', 'main']);
  ok(['config', 'core.hooksPath', path.join(dir, '.githooks')]);
  const commit = (message, extraEnv) => {
    writeFileSync(path.join(dir, 'file.txt'), `${message}\n`);
    ok(['add', 'file.txt']);
    return git(['commit', '-q', '-m', message], extraEnv);
  };
  const deploys = () =>
    existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : [];
  const head = () => ok(['rev-parse', 'HEAD']).stdout.trim();
  return { dir, git, ok, commit, deploys, head };
}

test('a commit on main deploys that commit', (t) => {
  const repo = scratchRepo(t);
  assert.equal(repo.commit('first').status, 0);
  assert.deepEqual(repo.deploys(), [repo.head()]);
});

test('a commit on another branch, or on a detached HEAD, never deploys', (t) => {
  const repo = scratchRepo(t);
  repo.commit('first');
  repo.ok(['checkout', '-q', '-b', 'feature']);
  assert.equal(repo.commit('on feature').status, 0);
  repo.ok(['checkout', '-q', '--detach']);
  assert.equal(repo.commit('detached').status, 0);
  assert.equal(repo.deploys().length, 1, 'only the first commit, made on main, deployed');
});

test('a fast-forward merge onto main deploys through post-merge', (t) => {
  const repo = scratchRepo(t);
  repo.commit('first');
  repo.ok(['checkout', '-q', '-b', 'feature']);
  repo.commit('on feature');
  repo.ok(['checkout', '-q', 'main']);
  repo.ok(['merge', '-q', '--ff-only', 'feature']);
  const deploys = repo.deploys();
  assert.equal(deploys.length, 2);
  assert.equal(deploys[1], repo.head());
});

test('a failed deploy is loud but keeps the commit and exits 0', (t) => {
  const repo = scratchRepo(t);
  const result = repo.commit('first', { FAKE_DEPLOY_EXIT: '1' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /DEPLOY FAILED/);
  assert.equal(repo.ok(['log', '--format=%s', '-1']).stdout.trim(), 'first');
});

test('REWILDER_SKIP_DEPLOY skips the deploy', (t) => {
  const repo = scratchRepo(t);
  assert.equal(repo.commit('first', { REWILDER_SKIP_DEPLOY: '1' }).status, 0);
  assert.equal(repo.deploys().length, 0);
});

test('the beads hooks still run, and a refusing pre-commit still refuses', (t) => {
  const repo = scratchRepo(t);
  const beads = path.join(repo.dir, '.beads', 'hooks');
  mkdirSync(beads, { recursive: true });
  const ran = path.join(repo.dir, 'beads-ran.log');
  writeFileSync(path.join(beads, 'post-commit'), `#!/bin/sh\necho post-commit >> '${ran}'\n`);
  writeFileSync(path.join(beads, 'pre-commit'), `#!/bin/sh\n[ -z "$REFUSE" ]\n`);
  chmodSync(path.join(beads, 'post-commit'), 0o755);
  chmodSync(path.join(beads, 'pre-commit'), 0o755);

  assert.notEqual(repo.commit('refused', { REFUSE: '1' }).status, 0);
  assert.equal(repo.git(['rev-parse', '--verify', '-q', 'HEAD']).status, 1, 'no commit was made');

  assert.equal(repo.commit('accepted').status, 0);
  assert.equal(readFileSync(ran, 'utf8').trim(), 'post-commit');
  assert.equal(repo.deploys().length, 1);
});
