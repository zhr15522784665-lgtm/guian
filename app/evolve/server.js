/**
 * 见岸·自适应 · 演示台服务（零依赖）。
 *
 * 和归岸主服务（server/index.js）分开跑，端口默认 3100：
 *   - 演示台只依赖 server/llm.js + server/config.js，不依赖 core/，主产品出问题也不影响现场演示；
 *   - 默认只监听 127.0.0.1，演示台有「清空」「回退」这类按钮，不该暴露到局域网。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('../server/config');
const { createLab } = require('./lab');
const { defaultParams, createModelAdapter } = require('./model');
const { ensureSampleData } = require('./sample-data');

const WEB_DIR = path.join(__dirname, 'web');
const HOST = process.env.EVOLVE_HOST || '127.0.0.1';
const params = defaultParams(config);
const hasKey = Boolean(config.llm.apiKey);

let callModel = async () => {
  throw new Error('NO_API_KEY');
};
if (hasKey) callModel = createModelAdapter(config, params);

const lab = createLab({ dataDir: config.dataDir, callModel, params });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(WEB_DIR, rel);
  if (!target.startsWith(path.resolve(WEB_DIR) + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const ERRORS = {
  BUSY: [409, '上一个任务还在跑，等它结束'],
  NO_RUN: [400, '当前版本还没跑过训练集，先点「跑一次」'],
  NO_API_KEY: [503, '没有配置模型密钥，只能查看已有结果。双击「设置模型密钥.cmd」配好后重启演示台。']
};

function needKey() {
  if (!hasKey) {
    const e = new Error('NO_API_KEY');
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/api/')) return serveStatic(res, p);

    if (req.method === 'GET' && p === '/api/evolve/state') {
      return sendJson(res, 200, { ...lab.state(), hasKey });
    }
    if (req.method === 'GET' && p === '/api/evolve/run') {
      const run = lab.getRun(url.searchParams.get('id'));
      return run ? sendJson(res, 200, { ok: true, run }) : sendJson(res, 404, { ok: false, message: '没有这次运行' });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (p === '/api/evolve/run') {
        needKey();
        lab.run(body.set === 'holdout' ? 'holdout' : 'train');
        return sendJson(res, 202, { ok: true });
      }
      if (p === '/api/evolve/holdout') {
        needKey();
        lab.holdout();
        return sendJson(res, 202, { ok: true });
      }
      if (p === '/api/evolve/learn') {
        needKey();
        lab.learn();
        return sendJson(res, 202, { ok: true });
      }
      if (p === '/api/evolve/iterate') {
        needKey();
        const rounds = Math.max(1, Math.min(10, Number(body.rounds) || 3));
        if (lab.state().iterating || (lab.state().job && !lab.state().job.finished)) return sendJson(res, 409, { ok: false, message: '正在运行，请稍候' });
        lab.iterate({ maxRounds: rounds }).catch((e) => console.warn('[evolve] 自迭代中断', String(e && e.message)));
        return sendJson(res, 202, { ok: true });
      }
      if (p === '/api/evolve/rollback') {
        return sendJson(res, 200, { ok: true, active: lab.rollback(String(body.version || 'v0')) });
      }
      if (p === '/api/evolve/try') {
        needKey();
        const text = String(body.text || '').trim();
        if (!text) return sendJson(res, 400, { ok: false, message: '写一句话再试' });
        return sendJson(res, 200, { ok: true, ...(await lab.tryOne(text)) });
      }
      if (p === '/api/evolve/feedback') {
        return sendJson(res, 200, { ok: true, feedback: lab.setFeedback(String(body.runId), String(body.taskId), body.value === 'bad' ? 'bad' : null) });
      }
      if (p === '/api/evolve/reset') {
        if (body.confirm !== true) return sendJson(res, 400, { ok: false, message: '需要确认' });
        lab.reset();
        return sendJson(res, 200, { ok: true });
      }
    }
    sendJson(res, 404, { ok: false, message: '没有这个接口' });
  } catch (err) {
    const msg = String((err && err.message) || err);
    const known = ERRORS[msg];
    if (known) return sendJson(res, known[0], { ok: false, code: msg, message: known[1] });
    if (/版本/.test(msg)) return sendJson(res, 400, { ok: false, message: msg });
    console.error('[evolve] 异常', msg.slice(0, 300));
    sendJson(res, 500, { ok: false, message: '出错了：' + msg.slice(0, 120) });
  }
});

/** 与 server/index.js 同一写法；不 require 它，免得把 core/ 也拉进来 */
function openBrowser(url) {
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `cmd /c start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function start(opts = {}) {
  const port = config.evolve.port;
  const url = `http://localhost:${port}`;
  return new Promise((resolve, reject) => {
    try {
      ensureSampleData({
        dataDir: config.dataDir,
        sampleDir: path.join(__dirname, '..', 'docs', 'evolve-sample-data-certify', 'evolve')
      });
    } catch (err) {
      reject(err);
      return;
    }
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.log(`\n  端口 ${port} 已被占用，演示台多半已经开着了：${url}\n`);
        resolve({ busy: true, url });
        return;
      }
      reject(err);
    });
    server.listen(port, HOST, () => {
      console.log('');
      console.log(`  见岸·自适应 演示台 · ${url}`);
      console.log(`  模型      ${hasKey ? params.model : '未配置密钥（只能查看已有结果）'}`);
      console.log(`  数据目录  ${path.join(config.dataDir, 'evolve')}`);
      console.log('');
      if (opts.open) openBrowser(url);
      resolve({ busy: false, url });
    });
  });
}

if (require.main === module) {
  start({ open: process.env.GUARD_OPEN === '1' }).catch((e) => {
    console.error('[evolve] 启动失败', e);
    process.exit(1);
  });
}

module.exports = { server, start, lab };
