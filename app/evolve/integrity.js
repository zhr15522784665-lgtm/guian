/**
 * 见岸·自适应 · 三不变证据链。
 *
 * 赛道规则：两次运行之间「不能改代码、参数、模型，也不能手改提示词」。
 * 每次运行都把下面这些指纹记进运行记录，大屏把两次并排显示：
 *   - code：app/ 下所有 .js/.html/.css/.json（不含 data、docs、测试、config.local.json）的 sha256 合并值
 *   - frozen：评分器 / 任务集 / 安全层 / 提示词框架 各自的 sha256
 *   - model：模型名（写死在配置里）
 *   - params：温度、max_tokens、检索 K、并发 等参数 JSON 的 sha256
 *   - git：如果项目在 git 仓库里，记 HEAD
 * 策略库（data/evolve/）不在 code 指纹里——它就是「学到的东西」，应该变。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = path.join(__dirname, '..');

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'data' || name === 'docs' || name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|html|css|json)$/.test(name) && !/\.test\.js$/.test(name) && name !== 'config.local.json') out.push(p);
  }
  return out;
}

function codeHash() {
  const files = walk(APP_DIR, []).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(APP_DIR, f).replace(/\\/g, '/'));
    h.update(fs.readFileSync(f));
  }
  return { hash: h.digest('hex'), files: files.length };
}

function frozenHashes() {
  const dir = path.join(__dirname, 'frozen');
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) out[name] = sha(fs.readFileSync(path.join(dir, name))).slice(0, 16);
  return out;
}

function gitHead() {
  try {
    let dir = APP_DIR;
    for (let i = 0; i < 4; i++) {
      const head = path.join(dir, '.git', 'HEAD');
      if (fs.existsSync(head)) {
        const ref = fs.readFileSync(head, 'utf8').trim();
        if (ref.startsWith('ref: ')) {
          const rf = path.join(dir, '.git', ref.slice(5));
          return fs.existsSync(rf) ? fs.readFileSync(rf, 'utf8').trim().slice(0, 12) : null;
        }
        return ref.slice(0, 12);
      }
      dir = path.dirname(dir);
    }
  } catch (e) {
    /* 没有 git 就不记 */
  }
  return null;
}

function fingerprint(params) {
  const c = codeHash();
  return {
    code: c.hash.slice(0, 16),
    codeFiles: c.files,
    frozen: frozenHashes(),
    model: params.model,
    params: sha(JSON.stringify(params)).slice(0, 16),
    paramsDetail: params,
    git: gitHead()
  };
}

module.exports = { fingerprint, codeHash, frozenHashes };
