const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureSampleData } = require('../sample-data');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guian-evolve-sample-'));
}

test('演示台数据缺失时递归复制注入的样例目录', () => {
  const root = tempDir();
  try {
    const dataDir = path.join(root, 'data');
    const sampleDir = path.join(root, 'certified-sample', 'evolve');
    fs.mkdirSync(path.join(sampleDir, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(sampleDir, 'versions.json'), '{"active":"v4"}');
    fs.writeFileSync(path.join(sampleDir, 'runs', 'run.json'), '{"id":"run"}');

    const result = ensureSampleData({ dataDir, sampleDir });

    assert.equal(result.copied, true);
    assert.equal(result.targetDir, path.join(dataDir, 'evolve'));
    assert.equal(fs.readFileSync(path.join(dataDir, 'evolve', 'versions.json'), 'utf8'), '{"active":"v4"}');
    assert.equal(fs.readFileSync(path.join(dataDir, 'evolve', 'runs', 'run.json'), 'utf8'), '{"id":"run"}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('演示台已有数据时不覆盖也不合并样例', () => {
  const root = tempDir();
  try {
    const dataDir = path.join(root, 'data');
    const targetDir = path.join(dataDir, 'evolve');
    const sampleDir = path.join(root, 'certified-sample', 'evolve');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(sampleDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'versions.json'), '{"active":"v9"}');
    fs.writeFileSync(path.join(sampleDir, 'versions.json'), '{"active":"v4"}');
    fs.writeFileSync(path.join(sampleDir, 'sample-only.json'), '{}');

    const result = ensureSampleData({ dataDir, sampleDir });

    assert.equal(result.copied, false);
    assert.equal(fs.readFileSync(path.join(targetDir, 'versions.json'), 'utf8'), '{"active":"v9"}');
    assert.equal(fs.existsSync(path.join(targetDir, 'sample-only.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
