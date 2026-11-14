/**
 * 首次打开演示台时，用随仓库提供的认证样例初始化空数据目录。
 * 已有 data/evolve 一律保留，避免覆盖现场积累的实验结果。
 */

const fs = require('fs');
const path = require('path');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else if (!fs.existsSync(to)) fs.writeFileSync(to, fs.readFileSync(from));
  }
}

function ensureSampleData(opts) {
  if (!opts || !opts.dataDir || !opts.sampleDir) {
    throw new Error('evolve sample data: dataDir 和 sampleDir 必填');
  }

  const targetDir = path.join(opts.dataDir, 'evolve');
  if (fs.existsSync(targetDir)) return { copied: false, targetDir };

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  // 不用 fs.cpSync：Windows 上 Node 22 遇到中文路径（如桌面\\归岸）会直接崩溃退出
  copyDir(opts.sampleDir, targetDir);
  return { copied: true, targetDir };
}

module.exports = { ensureSampleData };
