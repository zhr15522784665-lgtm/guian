const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 原生前端的最小 DOM 桩：运行实际 app.js，核对异步请求与离开生命周期。
class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.classList = { add() {}, remove() {} };
    this.dataset = {};
    this.hidden = true;
    this.value = '';
    this._text = '';
  }
  set textContent(text) { this._text = text; this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  append(...children) { children.forEach((child) => { child.parent = this; this.children.push(child); }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (selector === child.tagName || (selector.startsWith('.') && String(child.className || '').split(/\s+/).includes(selector.slice(1)))) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  focus() {}
}

function browser() {
  const ids = new Map();
  const requests = [];
  const beacons = [];
  const storage = new Map();
  const confirmations = [];
  const document = {
    body: new Element('body'), hidden: false,
    getElementById(id) { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); },
    createElement: (tag) => new Element(tag),
    querySelectorAll(selector) { return [...ids.values()].flatMap((el) => el.querySelectorAll(selector)); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  };
  document.body.dataset.view = 'chat';
  const context = vm.createContext({
    document, location: { protocol: 'file:' },
    window: { scrollTo() {} },
    navigator: { sendBeacon(url, body) { beacons.push({ url, body }); return true; } },
    Blob, setTimeout() {}, clearTimeout() {},
    confirm(message) { confirmations.push(message); return true; },
    sessionStorage: { setItem(k, v) { storage.set(k, v); }, getItem(k) { return storage.get(k) || null; }, removeItem(k) { storage.delete(k); } },
    async fetch(url, options = {}) {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, options, body });
      const result = await apiReply(url, body);
      return { ok: true, async json() { return result; } };
    }
  });
  let apiReply = () => ({ ok: true, recorded: true });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), context);
  const ui = vm.runInContext('({state, appendMessage, send, enterChat, show, reportLeave, finishLeave, reviewCurrentBot, renderGrowthCard, loadGrowth, rollbackGrowth})', context);
  Object.assign(ui.state, {
    botId: 'health', ageBand: 'adult',
    personas: ['health', 'growth', 'listener'].map((id) => ({ id, name: id, leavePrompt: `${id} 的问法`, greetHint: '你好' }))
  });
  return { ...ui, document, context, requests, beacons, storage, confirmations, el: document.getElementById,
    replyWith(fn) { apiReply = fn; } };
}

test('反馈按钮仅出现在未评价的模型回复下，提交捕获原 bot 和 turnId', async () => {
  const b = browser();
  b.appendMessage('assistant', '<img src=x>', true, 'turn-health', 'normal', true);
  const feedback = b.document.querySelectorAll('.feedback')[0];
  assert.equal(feedback.children.map((el) => el.textContent).join('/'), '说到心里了/不太对');
  assert.equal(b.el('messages').children[0].children[0].textContent, '<img src=x>');
  b.state.botId = 'listener';
  await feedback.children[1].listeners.click();
  assert.equal(b.requests[0].body.botId, 'health');
  assert.equal(b.requests[0].body.turnId, 'turn-health');
  assert.equal(b.requests[0].body.kind, 'miss');
  assert.ok(feedback.children.every((el) => el.disabled));
  b.appendMessage('assistant', '固定协议', true, 'risk-turn', 'risk', false);
  b.appendMessage('assistant', '已经评价', true, 'rated-turn', 'normal', true, 'good');
  assert.equal(b.document.querySelectorAll('.feedback').length, 1);
});

test('离开只问一次、允许直接关闭；隐藏上报后仍可补一次原因，缓存无对话', async () => {
  const b = browser();
  Object.assign(b.state, { growSessionId: 'session-health', sessionUserTurns: 2 });
  b.show('home');
  assert.equal(b.el('leave-sheet').hidden, false);
  assert.equal(b.el('leave-desc').textContent, 'health 的问法');
  b.reportLeave(); // 模拟提示期间切到后台。
  b.finishLeave('没听懂我');
  b.reportLeave('太啰嗦');
  assert.equal(b.beacons.length, 2);
  assert.equal(JSON.parse(await b.beacons[1].body.text()).reason, '没听懂我');
  assert.equal(b.document.body.dataset.view, 'home');
  assert.equal(b.el('leave-sheet').hidden, true);
  assert.deepEqual(Object.keys(JSON.parse(b.storage.get('guian-grow-leave-health'))).sort(), ['botId', 'reason', 'sessionId']);
  b.show('chat');
  b.show('home');
  assert.equal(b.el('leave-sheet').hidden, true);
  const skip = browser();
  Object.assign(skip.state, { growSessionId: 'skip', sessionUserTurns: 1 });
  skip.show('about');
  skip.finishLeave();
  assert.equal(skip.document.body.dataset.view, 'about');
  assert.equal(JSON.parse(await skip.beacons[0].body.text()).reason, undefined);
});

test('beacon 不可用时用 keepalive；风险响应移除旧按钮且不问离开原因', async () => {
  const b = browser();
  b.context.navigator.sendBeacon = () => false;
  b.state.growSessionId = 'normal-session';
  b.reportLeave();
  assert.equal(b.requests[0].options.keepalive, true);
  b.state.leaveReported = false;
  b.appendMessage('assistant', '上轮', true, 'old-turn', 'normal', true);
  b.replyWith(() => ({ ok: true, reply: '固定求援协议 12356', safety: 'crisis', feedbackBlocked: true, modelReply: false, growSessionId: 'risk-session' }));
  b.el('input').value = '我不想活了';
  await b.send();
  assert.equal(b.state.feedbackAllowed, false);
  assert.equal(b.document.querySelectorAll('.feedback').length, 0);
  const count = b.requests.length;
  b.show('home');
  assert.equal(b.el('leave-sheet').hidden, true);
  assert.equal(b.requests.length, count);
});

test('在途回复遇到角色切换：不渲染到另一 bot，离开仍上报原 bot', async () => {
  const b = browser();
  let resolveChat;
  b.replyWith((url) => url === '/api/chat' ? new Promise((resolve) => { resolveChat = resolve; }) : { ok: true, feedbackAllowed: true, messages: [] });
  b.el('input').value = '只给健康角色的消息';
  const sending = b.send();
  const entering = b.enterChat('listener');
  resolveChat({ ok: true, reply: '健康角色回复', safety: 'normal', modelReply: true, turnId: 'health-turn', growSessionId: 'health-session' });
  await Promise.all([sending, entering]);
  assert.equal(b.state.botId, 'listener');
  assert.equal(b.state.messages.length, 0);
  assert.equal(b.document.querySelectorAll('.feedback').length, 0);
  assert.equal(JSON.parse(await b.beacons[0].body.text()).botId, 'health');
  assert.equal(b.requests.at(-1).url, '/api/history?botId=listener');
});

test('复盘显示进行中和逐条未过原因，模型文本通过 textContent 展示', async () => {
  const b = browser();
  b.replyWith(() => ({
    ok: true,
    review: {
      promoted: false, certified: 0, candidateCount: 1, rejectedCount: 1,
      reason: '没有候选通过三次认证',
      rejectedCandidates: [{ plain: '<img src=x>', reasons: ['第 2 次检验：整体未达标数比基线多'] }]
    }
  }));
  const pending = b.reviewCurrentBot();
  assert.equal(b.state.reviewRunning, true);
  assert.equal(b.el('review-status').hidden, false);
  assert.match(b.el('review-status').textContent, /正在复盘/);
  await pending;
  assert.equal(b.requests[0].url, '/api/grow/review');
  assert.equal(b.requests[0].body.botId, 'health');
  assert.match(b.el('review-status').textContent, /没过「<img src=x>」/);
  assert.match(b.el('review-status').textContent, /第 2 次检验/);
  assert.equal(b.el('review-status').children.length, 0, '结果使用 textContent，不解析模型提供的标记');
  assert.equal(b.state.reviewRunning, false);
});

test('我在成长只展示 plain、来源和待确认状态，不渲染规则或语气包字段', () => {
  const b = browser();
  const card = b.renderGrowthCard('health', {
    active: 'v3', canRollback: true, parent: 'v2',
    versions: [
      { id: 'v1', kind: 'seed', at: '2026-11-14T00:00:00Z' },
      { id: 'v2', kind: 'review', at: '2026-11-15T00:00:00Z' },
      { id: 'v3', kind: 'review', at: '2026-11-15T01:00:00Z' }
    ],
    strategies: [{
      id: 'U-001', plain: '<b>人话做法</b>', source: '你亲手教的', sourceNote: '来源说明',
      rule: '不能出现在页面的策略规则', toneRules: '语气包规则秘密'
    }],
    pending: [{
      id: 'S6', plain: '等待确认的候选', source: '你亲手教的', sourceNote: '用户补充',
      status: 'pending', effective: false, rule: '候选规则也不能展示'
    }],
    tonePack: { examples: ['语气包样例秘密'] }
  });
  const text = card.textContent;
  assert.match(text, /当前 v3/);
  assert.match(text, /v2/);
  assert.match(text, /人话做法/);
  assert.match(text, /你亲手教的/);
  assert.match(text, /来源说明/);
  assert.match(text, /还在等你点头（尚未生效）/);
  assert.match(text, /未生效/);
  for (const secret of ['不能出现在页面的策略规则', '语气包规则秘密', '候选规则也不能展示', '语气包样例秘密']) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(card.querySelectorAll('.growth-rollback').length, 1);
});

test('成长页按 bot 加载；回退前人话确认并重新请求列表', async () => {
  const b = browser();
  let active = 'v3';
  const history = [
    { id: 'v1', kind: 'seed', at: '2026-11-14T00:00:00Z' },
    { id: 'v2', kind: 'review', at: '2026-11-15T00:00:00Z' },
    { id: 'v3', kind: 'review', at: '2026-11-15T01:00:00Z' }
  ];
  b.replyWith((url, body) => {
    if (url.startsWith('/api/grow?botId=')) {
      const botId = decodeURIComponent(url.split('botId=')[1]);
      return { ok: true, botId, active, parent: active === 'v3' ? 'v2' : 'v1', canRollback: true,
        versions: history, strategies: [], pending: [] };
    }
    if (url === '/api/grow/rollback') {
      assert.equal(body.botId, 'health');
      active = 'v2';
      return { ok: true, botId: 'health', active };
    }
    return { ok: true };
  });

  await b.loadGrowth();
  const box = b.el('growth-state');
  assert.match(box.textContent, /health · 当前 v3/);
  assert.equal(b.requests.filter((request) => request.url.startsWith('/api/grow?botId=')).length, 3);
  const rollback = box.querySelectorAll('.growth-rollback')[0];
  await rollback.listeners.click();
  assert.equal(b.confirmations.length, 1);
  assert.match(b.confirmations[0], /health回到上一版本（v2）/);
  assert.equal(b.requests.filter((request) => request.url === '/api/grow/rollback').length, 1);
  assert.equal(b.requests.filter((request) => request.url.startsWith('/api/grow?botId=')).length, 6, '回退后重新加载三个 bot 的列表');
  assert.match(box.textContent, /health · 当前 v2/);
});
