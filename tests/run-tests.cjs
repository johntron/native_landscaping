const { runLayoutHistoryTest } = require('./layoutHistory.test.cjs');
const { runPersistenceTest } = require('./persistence.test.cjs');
const { spawn } = require('child_process');
const { readdir } = require('fs').promises;
const path = require('path');

async function runLegacySuite() {
  await runLayoutHistoryTest();
  await runPersistenceTest();
  console.log('Legacy tests passed');
}

async function runNodeTestFiles() {
  const testsDir = path.resolve(__dirname);
  const entries = await readdir(testsDir);
  const files = entries.filter(
    (entry) =>
      entry !== path.basename(__filename) &&
      (entry.endsWith('.test.js') || entry.endsWith('.test.cjs'))
  );
  for (const file of files) {
    await runNodeTestFile(path.join(testsDir, file));
  }
  console.log('All tests passed');
}

function runNodeTestFile(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--test', filePath], { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Test failed: ${filePath}`));
      }
    });
  });
}

(async () => {
  const nodeMajor = Number(process.versions.node.split('.')[0]) || 0;
  try {
    if (nodeMajor >= 18) {
      await runNodeTestFiles();
    } else {
      await runLegacySuite();
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
