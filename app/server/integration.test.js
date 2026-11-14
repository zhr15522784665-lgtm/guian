/**
 * 集成测试：起一个真实的 HTTP 服务（mock 模型），验证六个不变量。
 *
 * 用 node --test 跑。不依赖外部服务、不花钱、不写真实数据目录。
 *
 * 为什么这些必须测：
 *   1) 危机链路不走模型 —— 这是整个产品最重要的安全设计，只靠读代码不算数
 *   2) 三个 bot 的隔离 —— 串味是这个产品最致命的错误，且很难在界面上发现
 *   3) 记忆隔离 —— 同上，而且更隐蔽
 *   4) 2 小时提醒 —— 法定义务，跨越时间才有意义
 *   5) 消息落库 —— 在真实文件上验证，不只看返回值
 *   6) 清除 —— 法规的删除权
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Duplex } = require('stream');

// 必须在 require server 之前设好环境
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guian-test-'));
process.env.LLM_MOCK = '1';
process.env.DATA_DIR = TMP_DIR;

// 测试只注入本地 mock 配置，绝不读取含真实密钥的 config.local.json。
require.cache[require.resolve('./config')] = { exports: {
  dataDir: TMP_DIR, maxMessagesPerBot: 200, maxInputLen: 1000, maxBodyBytes: 64 * 1024,
  webDir: path.join(__dirname, '..', 'web'), llm: {}
} };

const { server, grow, store } = require('./index');

let basePort = 0;
let cookie = '';
// 沙箱禁止 listen 时可显式启用，仅替换传输；仍经过真实路由、cookie、JSON 和磁盘存储。
// 默认始终跑真实 HTTP，不能把此模式当成端口监听验证。
const IN_PROCESS_HTTP = process.env.GUIAN_IN_PROCESS_HTTP === '1';

function requestInProcess(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({
      read() {},
      write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }
    });
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = urlPath;
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    req.complete = true;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}), 'content-type': 'application/json' };
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      const wire = Buffer.concat(chunks).toString('utf8');
      const raw = wire.slice(wire.indexOf('\r\n\r\n') + 4);
      const headers = { ...res.getHeaders() };
      if (headers['set-cookie']) {
        headers['set-cookie'] = [].concat(headers['set-cookie']);
        cookie = headers['set-cookie'][0].split(';')[0];
      }
      let json = null;
      try { json = JSON.parse(raw); } catch (_) { /* 非 JSON */ }
      socket.destroy();
      resolve({ status: res.statusCode, json, raw, headers });
    });
    server.emit('request', req, res);
    if (body) req.push(Buffer.from(JSON.stringify(body)));
    req.push(null);
  });
}

function request(method, urlPath, body) {
  if (IN_PROCESS_HTTP) return requestInProcess(method, urlPath, body);
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: basePort,
        path: urlPath,
        method,
        headers: {
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...(cookie ? { Cookie: cookie } : {})
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          const sc = res.headers['set-cookie'];
          if (sc && sc[0]) cookie = sc[0].split(';')[0];
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (e) {
            /* 非 JSON 响应 */
          }
          resolve({ status: res.statusCode, json, raw, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  if (!IN_PROCESS_HTTP) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, () => { server.removeListener('error', reject); resolve(); });
    });
    basePort = server.address().port;
  }

  // 先把年龄设好，否则所有对话都会被门禁挡住
  await request('POST', '/api/age', { ageBand: 'adult' });
});

test.after(async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test('对话能成功返回，并落库到 history', async () => {
  const res = await request('POST', '/api/chat', { botId: 'health', text: '我最近睡不好' });
  assert.equal(res.status, 200);
  assert.ok(res.json.ok, JSON.stringify(res.json));
  assert.ok(res.json.reply.length > 0);

  const hist = await request('GET', '/api/history?botId=health');
  assert.ok(hist.json.messages.length >= 2, '应该有用户与助手各一条');
  assert.equal(hist.json.messages[0].role, 'user');
  assert.equal(hist.json.messages[0].content, '我最近睡不好');
  assert.equal(hist.json.messages[1].role, 'assistant');
});

test('三个 bot 的消息互不可见', async () => {
  const marker = `隔离测试${Date.now()}`;
  await request('POST', '/api/chat', { botId: 'growth', text: marker });

  const health = await request('GET', '/api/history?botId=health');
  const growth = await request('GET', '/api/history?botId=growth');

  const inHealth = health.json.messages.some((m) => m.content.includes(marker));
  const inGrowth = growth.json.messages.some((m) => m.content.includes(marker));

  assert.equal(inHealth, false, 'health 不该看到 growth 的消息');
  assert.equal(inGrowth, true, 'growth 应该看到自己的消息');
});

test('危机输入不走模型', async () => {
  const res = await request('POST', '/api/chat', { botId: 'listener', text: '我不想活了' });
  assert.equal(res.status, 200);
  // 「我不想活了」是意念，没有计划或方式 → 判 risk 是对的；
  // 关键是 risk 与 crisis 都不走模型，所以这里接受两者。
  assert.ok(['risk', 'crisis'].includes(res.json.safety), `应该是 risk 或 crisis，实际 ${res.json.safety}`);
  // mock 模型的回复里一定带「mock：」字样；没有就说明没走模型
  assert.equal(/mock：/.test(res.json.reply), false, '危机回复不该来自模型');
  assert.ok(res.json.card && res.json.card.type === 'hotline', '应该给热线卡');
  assert.ok(/12356/.test(res.json.reply), '回复里应该有具体号码');
  // 危机时刻不能出现边界声明
  assert.equal(/不能替代真实朋友|我只是个程序/.test(res.json.reply), false, '危机文案不该撇清责任');
});

test('连续使用满 2 小时会带出时长提醒', async () => {
  const startedAt = Date.now() - 125 * 60 * 1000; // 125 分钟前开始
  const res = await request('POST', '/api/chat', {
    botId: 'health',
    text: '还在',
    sessionStartedAt: startedAt
  });

  assert.ok(res.json.ok);
  const hasDurationNotice = (res.json.notices || []).some((n) => n.type === 'duration');
  assert.equal(hasDurationNotice, true, '应当有 duration 提醒');
  assert.ok(/聊了|个多小时|分钟/.test(res.json.reply), '回复里应包含时长');
});

test('记忆按 bot 隔离，写在各自文件里', async () => {
  const file = path.join(TMP_DIR, `u_${cookie.split('=')[1]}.json`);
  await request('POST', '/api/chat', { botId: 'health', text: '我妈最近住院了，我在准备考研' });

  assert.ok(fs.existsSync(file), '数据文件应该存在');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));

  const healthMem = (doc.bots.health && doc.bots.health.memories) || [];
  const listenerMem = (doc.bots.listener && doc.bots.listener.memories) || [];

  assert.ok(healthMem.length > 0, 'health 应该抽到了记忆');
  assert.equal(listenerMem.length, 0, 'listener 不该有这条记忆');
});

test('清除一个 bot 不影响另外两个', async () => {
  await request('POST', '/api/chat', { botId: 'listener', text: '今天有点烦' });
  await request('POST', '/api/chat', { botId: 'growth', text: '想换个方向' });

  await request('POST', '/api/clear', { botId: 'listener' });

  const listener = await request('GET', '/api/history?botId=listener');
  const growth = await request('GET', '/api/history?botId=growth');

  assert.equal(listener.json.messages.length, 0, 'listener 应被清空');
  assert.ok(growth.json.messages.length > 0, 'growth 不该受影响');
});

test('缺年龄时对话被拦下', async () => {
  // 用一个新 cookie（新用户）
  const saved = cookie;
  cookie = '';
  const fresh = await request('POST', '/api/chat', { botId: 'health', text: '你好' });
  assert.equal(fresh.json.needAgeBand, true, '新用户应先选年龄');
  cookie = saved;
});

// ── 见岸整合：解压与热线 ──

test('/api/relief 是公开只读，连 cookie 都不发', async () => {
  const saved = cookie;
  cookie = '';
  const res = await request('GET', '/api/relief');
  cookie = saved;

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.exercises.length, 6);
  assert.ok(res.json.notice.disclaimer.includes('12356'));
  assert.ok(res.json.exercises.every((x) => x.safety.length >= 3 && x.evidence.length >= 2));
  // 这条是产品承诺：做解压不需要「你是谁」
  assert.equal(res.headers['set-cookie'], undefined, '解压接口不该写身份 cookie');
});

test('/api/personas 下发全国 + 省份热线与可信度说明', async () => {
  const res = await request('GET', '/api/personas');
  assert.equal(res.status, 200);
  assert.equal(res.json.hotlines.length, 7);
  assert.equal(res.json.hotlines[0].number, '12356');
  assert.equal(res.json.provinceHotlines.length, 31);
  assert.equal(res.json.hotlineGuide.verified, false);
  assert.match(res.json.hotlineGuide.advice, /12356/);
  assert.equal(res.json.reliefCount, 6);
});

test('危机卡仍给出 12356 / 120 / 110，且有通往更多热线的入口', async () => {
  const res = await request('POST', '/api/chat', {
    botId: 'listener',
    text: '我今晚就准备跳楼'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.safety, 'crisis');
  // 危机不走模型：mock 的回复前缀不能出现
  assert.ok(!/mock：/.test(res.json.reply), '危机链路不该经过模型');
  assert.ok(res.json.card && res.json.card.type === 'hotline');
  assert.deepEqual(res.json.card.items.map((h) => h.number), ['12356', '120', '110']);
  assert.ok(res.json.card.more, '卡片要能通往省份热线');
});

test('「自杀」单独一句话也会触发固定求援文案，不再漏报', async () => {
  const res = await request('POST', '/api/chat', { botId: 'growth', text: '我想过自杀' });
  assert.equal(res.status, 200);
  assert.ok(['risk', 'crisis'].includes(res.json.safety), `实际：${res.json.safety}`);
  assert.match(res.json.reply, /12356/);
  assert.ok(res.json.card && res.json.card.type === 'hotline');
});

test('会成长 API：每个 bot 有独立版本，回退可用，未知 botId 返回 4xx', async () => {
  const state = await request('GET', '/api/grow?botId=health');
  assert.equal(state.status, 200);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.active, 'v1');
  assert.deepEqual(state.json.pending.map((s) => s.id), ['S7', 'S8', 'S9']);
  assert.ok(state.json.strategies.some((s) => s.id === 'U-001'));
  assert.ok(state.json.strategies.every((s) => typeof s.plain === 'string' && s.plain.length > 0));
  assert.ok(state.json.strategies.every((s) => ['你亲手教的', '我自己复盘、过了三次检验学会的'].includes(s.source)));
  assert.ok(state.json.strategies.every((s) => !Object.prototype.hasOwnProperty.call(s, 'rule')));
  assert.ok(state.json.pending.every((s) => s.status === 'pending' && s.effective === false));
  assert.ok(JSON.stringify(state.json).includes('还在等你点头') === false);
  // 成长页只给策略 plain；语气包中的规则/样例不得泄露到 API。
  assert.equal(JSON.stringify(state.json).includes('多数回1到3句'), false);
  assert.equal(JSON.stringify(state.json).includes('今晚用户亲教规则'), false);

  const growthState = await request('GET', '/api/grow?botId=growth');
  assert.deepEqual(growthState.json.pending.map((s) => s.id), ['S6', 'S7', 'S8', 'S9']);
  assert.ok(growthState.json.pending.every((s) => s.status === 'pending' && s.effective === false));

  const unknownGet = await request('GET', '/api/grow?botId=unknown');
  assert.ok(unknownGet.status >= 400 && unknownGet.status < 500);
  assert.equal(unknownGet.json.code, 'BAD_BOT_ID');

  const rollback = await request('POST', '/api/grow/rollback', { botId: 'health', to: 'v0' });
  assert.equal(rollback.status, 200);
  assert.equal(rollback.json.active, 'v0');
  const after = await request('GET', '/api/grow?botId=health');
  assert.equal(after.json.active, 'v0');
  assert.equal(after.json.strategies.length, 0);

  const unknownPost = await request('POST', '/api/grow/rollback', { botId: 'unknown' });
  assert.ok(unknownPost.status >= 400 && unknownPost.status < 500);
  assert.equal(unknownPost.json.code, 'BAD_BOT_ID');

  const unknownReview = await request('POST', '/api/grow/review', { botId: 'unknown' });
  assert.ok(unknownReview.status >= 400 && unknownReview.status < 500);
  assert.equal(unknownReview.json.code, 'BAD_BOT_ID');

  const missingReview = await request('POST', '/api/grow/review', {});
  assert.ok(missingReview.status >= 400 && missingReview.status < 500);
  assert.equal(missingReview.json.code, 'BAD_BOT_ID');

  const reviewed = await request('POST', '/api/grow/review', { botId: 'listener' });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.json.ok, true);
  assert.equal(reviewed.json.lastReview.status, 'completed');
  const reviewState = await request('GET', '/api/grow?botId=listener');
  assert.equal(reviewState.json.lastReview.status, 'completed');
});

test('回访提示只出现一次，按 uid + bot 隔离；风险轮不消费提示且仍走固定协议', async () => {
  await withFreshUser(async () => {
    // 两个 bot 都先见过当前版本，才有资格比较版本变化。
    const healthFirst = await request('POST', '/api/chat', { botId: 'health', text: '今天午饭吃什么好' });
    const listenerFirst = await request('POST', '/api/chat', { botId: 'listener', text: '今天想随便聊聊' });
    assert.equal(healthFirst.json.safety, 'normal');
    assert.equal(listenerFirst.json.safety, 'normal');
    const uid = cookie.split('=')[1];
    assert.equal((await store.getBotState(uid, 'health')).lastSeenGrowVersion, grow.versions('health').active);
    assert.equal((await store.getBotState(uid, 'listener')).lastSeenGrowVersion, grow.versions('listener').active);

    const before = grow.versions('listener').active;
    const learned = {
      id: `T-${Date.now()}`,
      scope: 'general',
      triggers: ['随便聊'],
      rule: '用户说想随便聊时，先接住当下的话头。',
      when: '用户想随便聊',
      plain: '你说想随便聊的时候，我会先接住这个话头。',
      source_cases: ['T-1'],
      source_note: '复盘三次检验通过（测试）',
      created_by: 'self_learn'
    };
    const after = grow.commit('listener', [learned], { kind: 'review', note: '测试版本' });
    assert.notEqual(after, before);
    const apiState = await request('GET', '/api/grow?botId=listener');
    const displayed = apiState.json.strategies.find((strategy) => strategy.id === learned.id);
    assert.equal(displayed.plain, learned.plain);
    assert.equal(displayed.source, '我自己复盘、过了三次检验学会的');
    assert.equal(displayed.sourceNote, learned.source_note);

    // 危机轮不附加成长句，也不把版本标记为已见；仍是固定 12356 协议。
    const active = grow.active;
    let activeReads = 0;
    grow.active = function (botId) { activeReads += 1; return active(botId); };
    let crisis;
    try {
      crisis = await request('POST', '/api/chat', { botId: 'listener', text: '我今晚就准备跳楼' });
    } finally {
      grow.active = active;
    }
    assert.equal(crisis.json.safety, 'crisis');
    assert.equal(crisis.json.reply, require('../core/src').CRISIS_REPLY);
    assert.equal(crisis.json.modelReply, false, '固定协议没有调用模型');
    assert.equal(activeReads, 0, '危机分支没有读取策略库');
    assert.equal(crisis.json.reply.includes('上次之后我学了一招'), false);
    assert.equal((await store.getBotState(uid, 'listener')).lastSeenGrowVersion, before, '危机轮不更新已见版本');

    const revisit = await request('POST', '/api/chat', { botId: 'listener', text: '今天想随便聊聊' });
    assert.match(revisit.json.reply, /上次之后我学了一招：你说想随便聊的时候/);
    const again = await request('POST', '/api/chat', { botId: 'listener', text: '再聊一句别的' });
    assert.equal(again.json.reply.includes('上次之后我学了一招'), false);

    // 同一 uid 的另一个 bot 没有版本变化，不应出现提示。
    const otherBot = await request('POST', '/api/chat', { botId: 'health', text: '今天继续聊聊' });
    assert.equal(otherBot.json.reply.includes('上次之后我学了一招'), false);

    // 新 uid 第一次见到该 bot，不显示回访提示。
    await withFreshUser(async () => {
      const fresh = await request('POST', '/api/chat', { botId: 'listener', text: '第一次来，随便聊聊' });
      assert.equal(fresh.json.reply.includes('上次之后我学了一招'), false);
    });

    // 让后续测试回到原来的版本，避免共享测试数据改变默认状态。
    grow.rollback('listener', before);
  });
});

test('回访提示跳过带追问或虚构真人经历的策略说明', async () => {
  await withFreshUser(async () => {
    await request('POST', '/api/chat', { botId: 'health', text: '今天想随便聊两句' });
    const before = grow.versions('health').active;
    let committed = false;
    try {
      grow.commit('health', [{
        id: `T-unsafe-plain-${Date.now()}`,
        scope: 'general',
        triggers: [],
        rule: '用户说想随便聊时，先接住当下的话头。',
        when: '用户想随便聊',
        plain: '我听说你以前有个朋友，要不要讲讲？',
        source_cases: ['T-unsafe-plain'],
        source_note: '回访提示清理测试',
        created_by: 'self_learn'
      }], { kind: 'review', note: '回访提示清理测试' });
      committed = true;
      const revisit = await request('POST', '/api/chat', { botId: 'health', text: '今天也想随便聊聊' });
      assert.equal(revisit.json.reply.includes('上次之后我学了一招'), false);
      assert.equal(revisit.json.reply.includes('我听说你以前有个朋友'), false);
    } finally {
      if (committed) grow.rollback('health', before);
    }
  });
});

async function withFreshUser(fn) {
  const saved = cookie;
  cookie = '';
  try {
    await request('POST', '/api/age', { ageBand: 'adult' });
    await fn();
  } finally {
    cookie = saved;
  }
}

function growFiles() {
  const root = path.join(TMP_DIR, 'grow');
  const files = {};
  if (!fs.existsSync(root)) return files;
  for (const bot of fs.readdirSync(root)) {
    for (const name of fs.readdirSync(path.join(root, bot))) {
      files[`${bot}/${name}`] = fs.readFileSync(path.join(root, bot, name), 'utf8');
    }
  }
  return files;
}

function samples(botId, name = 'failures') {
  const file = path.join(TMP_DIR, 'grow', botId, `${name}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('成长反馈 HTTP：good/miss 写本 bot，不能用另一个 bot 的 turnId，失败文件不含 uid', async () => {
  await withFreshUser(async () => {
    const otherBefore = growFiles();
    const failuresBefore = samples('health').length;
    const goodBefore = samples('health', 'good').length;
    const turn = await request('POST', '/api/chat', { botId: 'health', text: '今天想聊午餐搭配' });
    assert.equal(turn.json.feedbackAllowed, true);
    const feedback = await request('POST', '/api/grow/feedback', { botId: 'health', turnId: turn.json.turnId, kind: 'miss', uid: 'fake-body-uid', input: '不能使用客户端片段' });
    assert.equal(feedback.json.recorded, true);
    const second = await request('POST', '/api/chat', { botId: 'health', text: '那晚餐怎么搭配比较丰富呢' });
    const good = await request('POST', '/api/grow/feedback', { botId: 'health', turnId: second.json.turnId, kind: 'good' });
    assert.equal(good.json.recorded, true);
    assert.equal(samples('health').length, failuresBefore + 1);
    assert.equal(samples('health', 'good').length, goodBefore + 1);
    assert.equal(samples('health').at(-1).input, '今天想聊午餐搭配');
    assert.equal(samples('health').at(-1).reply, turn.json.reply.slice(0, 500));
    const raw = JSON.stringify(samples('health'));
    assert.equal(raw.includes(cookie.split('=')[1]), false);
    assert.doesNotMatch(raw, /"uid"|fake-body-uid|不能使用客户端片段|"history"/);
    const other = await request('POST', '/api/grow/feedback', { botId: 'listener', turnId: turn.json.turnId, kind: 'miss' });
    assert.equal(other.status, 400);
    assert.equal(other.json.code, 'TURN_NOT_FOUND');
    const after = growFiles();
    for (const [file, content] of Object.entries(otherBefore)) {
      if (!file.startsWith('health/')) assert.equal(after[file], content, file);
    }
    const duplicate = await request('POST', '/api/grow/feedback', { botId: 'health', turnId: turn.json.turnId, kind: 'good' });
    assert.equal(duplicate.json.reason, 'duplicate');
    const history = await request('GET', '/api/history?botId=health');
    assert.equal(history.json.messages.find((m) => m.turnId === turn.json.turnId).feedbackKind, 'miss');
  });
});

test('成长反馈 HTTP：未知/缺失 botId、无效轮次、错误类型返回 4xx，正文 uid 不能冒充', async () => {
  const before = growFiles();
  for (const endpoint of ['feedback', 'leave']) {
    for (const botId of ['unknown', undefined, '../listener']) {
      const res = await request('POST', `/api/grow/${endpoint}`, { botId, kind: 'good' });
      assert.equal(res.status, 400);
      assert.equal(res.json.code, 'BAD_BOT_ID');
    }
  }
  await withFreshUser(async () => {
    for (const body of [{ kind: 'oops' }, { kind: 'good' }, { kind: 'miss', turnId: 'not-a-turn' }, { kind: 'miss', messageIndex: -1 }]) {
      const res = await request('POST', '/api/grow/feedback', { botId: 'health', ...body });
      assert.equal(res.status, 400);
    }
    const badReason = await request('POST', '/api/grow/leave', { botId: 'health', reason: '任意原文不许写入' });
    assert.equal(badReason.status, 400);
  });
  assert.deepEqual(growFiles(), before);
  await withFreshUser(async () => {
    const turn = await request('POST', '/api/chat', { botId: 'health', text: '今天想说说午饭' });
    const victimUid = cookie.split('=')[1];
    await withFreshUser(async () => {
      const beforeAttack = growFiles();
      const res = await request('POST', '/api/grow/feedback', { botId: 'health', turnId: turn.json.turnId, kind: 'miss', uid: victimUid });
      assert.equal(res.status, 400);
      assert.deepEqual(growFiles(), beforeAttack);
    });
  });
});

test('成长反馈 HTTP：隐式不满/变短/重复问法自动记录，离开按本次轮数判断并去重', async () => {
  await withFreshUser(async () => {
    const first = await request('POST', '/api/chat', { botId: 'growth', text: '我总是拖延到最后一天才开始，应该怎么办才好' });
    const baseline = samples('growth').length;
    const second = await request('POST', '/api/chat', { botId: 'growth', text: '换个说法，我总是拖延到最后一天才开始，这该怎么办才好' });
    await request('POST', '/api/chat', { botId: 'growth', text: '你不懂' });
    const implicit = samples('growth').slice(baseline);
    assert.ok(implicit.some((s) => s.signalType === 'repeated_question' && s.reply === first.json.reply.slice(0, 500)));
    assert.ok(implicit.some((s) => s.signalType === 'dismissive' && s.input === '你不懂' && s.reply === second.json.reply.slice(0, 500)));
    assert.ok(implicit.some((s) => s.signalType === 'short_reply'));
    const leave = await request('POST', '/api/grow/leave', { botId: 'growth', sessionId: first.json.growSessionId });
    assert.equal(leave.json.recorded, false, '3 轮离开不标短会话');
    const fourth = await request('POST', '/api/chat', { botId: 'growth', text: '换个话题说说下周旅行' });
    assert.notEqual(fourth.json.growSessionId, first.json.growSessionId);
    const short = await request('POST', '/api/grow/leave', { botId: 'growth', sessionId: fourth.json.growSessionId, reason: '没听懂我', userTurns: 999 });
    assert.equal(short.json.recorded, true, '只看服务端计数，不信客户端轮数');
    const end = samples('growth').length;
    const duplicate = await request('POST', '/api/grow/leave', { botId: 'growth', sessionId: fourth.json.growSessionId, reason: '太啰嗦' });
    assert.equal(duplicate.json.reason, 'duplicate');
    assert.equal(samples('growth').length, end);
    const stats = (await request('GET', '/api/grow?botId=growth')).json.stats;
    for (const signal of ['dismissive', 'short_reply', 'repeated_question', 'short_session', 'leave_reason']) assert.ok(stats.failuresBySignal[signal] >= 1, signal);
    assert.ok(stats.failuresByReason['没听懂我'] >= 1);
    assert.ok(stats.failuresBySource.implicit >= 3);
  });
});

test('成长反馈 HTTP：2 轮离开命中短会话，beacon 后可补一次三选一原因', async () => {
  await withFreshUser(async () => {
    await request('POST', '/api/chat', { botId: 'listener', text: '今天午饭吃得挺开心' });
    const second = await request('POST', '/api/chat', { botId: 'listener', text: '下周准备跟同学出门逛逛' });
    const before = samples('listener').length;
    const leave = await request('POST', '/api/grow/leave', { botId: 'listener', sessionId: second.json.growSessionId });
    assert.equal(leave.json.recorded, true);
    await request('POST', '/api/grow/leave', { botId: 'listener', sessionId: second.json.growSessionId, reason: '不是我要的' });
    const added = samples('listener').slice(before);
    assert.deepEqual(added.map((s) => s.signalType), ['short_session', 'leave_reason']);
    assert.equal(added[1].reason, '不是我要的');
  });
});

test('成长反馈 HTTP：风险/危机出现后旧反馈、好样本、离开原因及后续隐式信号均拒收', async () => {
  for (const text of ['我不想活了', '我今晚就去跳楼']) {
    await withFreshUser(async () => {
      const old = await request('POST', '/api/chat', { botId: 'listener', text: '今天想说说同事送的小礼物' });
      const before = growFiles();
      const crisis = await request('POST', '/api/chat', { botId: 'listener', text });
      assert.equal(crisis.json.feedbackAllowed, false);
      assert.match(crisis.json.reply, /12356/);
      for (const turnId of [old.json.turnId, crisis.json.turnId]) {
        for (const kind of ['good', 'miss']) {
          const res = await request('POST', '/api/grow/feedback', { botId: 'listener', turnId, kind });
          assert.equal(res.json.ignored, true);
          assert.equal(res.json.reason, 'safety');
        }
      }
      const leave = await request('POST', '/api/grow/leave', { botId: 'listener', reason: '太啰嗦', signals: ['short_session'] });
      assert.equal(leave.json.reason, 'safety');
      assert.deepEqual(growFiles(), before, '风险/危机及反馈不写任何成长文件');
      const normal = await request('POST', '/api/chat', { botId: 'listener', text: '你不懂' });
      assert.equal(normal.json.feedbackAllowed, false);
      assert.deepEqual(growFiles(), before, '后续隐式信号也禁收');
      const history = await request('GET', '/api/history?botId=listener');
      assert.equal(history.json.feedbackAllowed, false);
      const other = await request('POST', '/api/chat', { botId: 'health', text: '中午想多吃些青菜' });
      assert.equal(other.json.feedbackAllowed, true, '本阶段反馈禁收按 uid+bot 隔离');
      assert.equal((await request('POST', '/api/grow/feedback', { botId: 'health', turnId: other.json.turnId, kind: 'good' })).json.recorded, true);
    });
  }
});
