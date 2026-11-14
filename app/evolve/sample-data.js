/**
 * 首次打开演示台时，用随仓库提供的认证样例初始化空数据目录。
 * 已有 data/evolve 一律保留，避免覆盖现场积累的实验结果。
 */

const fs = require('fs');
const path = require('path');

function ensureSampleData(opts) {
  if (!opts || !opts.dataDir || !opts.sampleDir) {
    throw new Error('evolve sample data: dataDir 和 sampleDir 必填');
  }

  const targetDir = path.join(opts.dataDir, 'evolve');
  if (fs.existsSync(targetDir)) return { copied: false, targetDir };

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(opts.sampleDir, targetDir, { recursive: true, errorOnExist: true, force: false });
  return { copied: true, targetDir };
}

module.exports = { ensureSampleData };
