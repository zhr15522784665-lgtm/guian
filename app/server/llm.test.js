/**
 * llm.js 的两处真实模型验证后修的问题（2026-11-14，OpenAI 兼容中转 + deepseek-v4-flash）：
 *   1) reasoningEffort='none' 时不能发 reasoning_effort 字段（发了反而触发思考，content 为空）
 *   2) 空回复要当失败走降级通道，不能把空白发给用户
 * 用桩替换 https.request，不联网。
 */
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const { EventEmitter } = require('events');

function stub(responder) {
  const bodies = [];
  const orig = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    let payload = '';
    req.write = (s) => (payload += s);
    req.end = () => {
      const body = JSON.parse(payload);
      bodies.push({ opts, body });
      const res = new EventEmitter();
      res.statusCode = 200;
      cb(res);
      res.emit('data', JSON.stringify(responder(body)));
      res.emit('end');
    };
    req.destroy = () => {};
    return req;
  };
  return { bodies, restore: () => (https.request = orig) };
}

const { createLlm } = require('./llm');

test("reasoningEffort='none' 时不发送 reasoning_effort；baseUrl 尾斜杠被去掉", async () => {
  const s = stub(() => ({ choices: [{ message: { content: '你好' } }], usage: { total_tokens: 3 } }));
  try {
    const llm = createLlm({ apiKey: 'k', baseUrl: 'https://example.com/v1/', primaryModel: 'm1' });
    const out = await llm.chat({ persona: { llm: { reasoningEffort: 'none' } }, system: 's', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.text, '你好');
    assert.equal('reasoning_effort' in s.bodies[0].body, false);
    assert.equal(s.bodies[0].opts.path, '/v1/chat/completions');
  } finally {
    s.restore();
  }
});

test('空回复走降级通道', async () => {
  const s = stub((body) =>
    body.model === 'primary'
      ? { choices: [{ message: { content: '', reasoning_content: '想了很多' }, finish_reason: 'length' }] }
      : { choices: [{ message: { content: '兜底回复' } }] }
  );
  try {
    const llm = createLlm({ apiKey: 'k', primaryModel: 'primary', fallbackModel: 'fb' });
    const out = await llm.chat({ persona: { llm: { model: 'primary' } }, system: 's', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.fallbackUsed, true);
    assert.equal(out.text, '兜底回复');
    assert.match(out.primaryError, /EMPTY_REPLY/);
  } finally {
    s.restore();
  }
});

test('显式配置主模型时，优先于人格里的默认模型名', async () => {
  const s = stub(() => ({ choices: [{ message: { content: 'ok' } }] }));
  try {
    const persona = { llm: { model: 'deepseek-flash' } };
    await createLlm({ apiKey: 'k', primaryModel: 'relay-model', forcePrimary: true }).chat({ persona, system: 's', messages: [] });
    await createLlm({ apiKey: 'k', primaryModel: 'relay-model' }).chat({ persona, system: 's', messages: [] });
    assert.equal(s.bodies[0].body.model, 'relay-model');
    assert.equal(s.bodies[1].body.model, 'deepseek-flash', '未显式配置时保持原行为');
  } finally {
    s.restore();
  }
});


// 2026-11-14 用户机器：本机走代理，首个连接偶发 ECONNRESET / 超时，用户首条消息就看到兜底话。
function flakyStub(failFor) {
  const seen = [];
  const orig = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    let payload = '';
    req.write = (s) => (payload += s);
    req.end = () => {
      const body = JSON.parse(payload);
      seen.push(body.model);
      setImmediate(() => {
        const n = seen.length;
        if (n <= failFor) {
          const e = new Error('read ECONNRESET');
          e.code = 'ECONNRESET';
          req.emit('error', e);
          return;
        }
        const res = new EventEmitter();
        res.statusCode = 200;
        cb(res);
        res.emit('data', JSON.stringify({ choices: [{ message: { content: `好的${n}` } }] }));
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  };
  return { seen, restore: () => (https.request = orig) };
}

test('连接被重置：先重试主模型，成功就不算降级', async () => {
  const s = flakyStub(1);
  try {
    const llm = createLlm({ apiKey: 'k', primaryModel: 'p', fallbackModel: 'fb', retryDelaysMs: [1] });
    const out = await llm.chat({ persona: { llm: { model: 'p' } }, system: 's', messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(s.seen, ['p', 'p']);
    assert.equal(out.fallbackUsed, false);
    assert.equal(out.attempts, 2);
  } finally {
    s.restore();
  }
});

test('主模型两次都失败 → 兜底模型，兜底也抖一次 → 再试一次兜底', async () => {
  const s = flakyStub(3);
  try {
    const llm = createLlm({ apiKey: 'k', primaryModel: 'p', fallbackModel: 'fb', retryDelaysMs: [1] });
    const out = await llm.chat({ persona: { llm: { model: 'p' } }, system: 's', messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(s.seen, ['p', 'p', 'fb', 'fb']);
    assert.equal(out.fallbackUsed, true);
  } finally {
    s.restore();
  }
});

test('全部失败才抛错；401 这类配置错误不重试同一个模型', async () => {
  const orig = https.request;
  const seen = [];
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    let payload = '';
    req.write = (x) => (payload += x);
    req.end = () => {
      seen.push(JSON.parse(payload).model);
      const res = new EventEmitter();
      res.statusCode = 401;
      cb(res);
      res.emit('data', '{"error":"bad key"}');
      res.emit('end');
    };
    req.destroy = () => {};
    return req;
  };
  try {
    const llm = createLlm({ apiKey: 'k', primaryModel: 'p', fallbackModel: 'fb', retryDelaysMs: [1] });
    await assert.rejects(
      llm.chat({ persona: { llm: { model: 'p' } }, system: 's', messages: [{ role: 'user', content: 'hi' }] }),
      /ALL_ATTEMPTS_FAILED/
    );
    assert.deepEqual(seen, ['p', 'fb']);
  } finally {
    https.request = orig;
  }
});

test('isTransient：网络抖动/超时/5xx/429 算临时，401/400 不算', () => {
  const { isTransient } = require('./llm');
  assert.equal(isTransient(new Error('timeout 12000ms')), true);
  assert.equal(isTransient(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransient(new Error('HTTP 503: busy')), true);
  assert.equal(isTransient(new Error('HTTP 429: slow down')), true);
  assert.equal(isTransient(new Error('HTTP 401: bad key')), false);
  assert.equal(isTransient(new Error('HTTP 400: bad model')), false);
});
