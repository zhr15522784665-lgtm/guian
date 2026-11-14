const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectSignals, isDismissive, isMarkedShorter, isRepeatedQuestion } = require('../src/grow/signals');
const { leavePrompt } = require('../src/grow/copy');
const { createGrowStore } = require('../../server/grow-store');

const user = (content) => ({ role: 'user', content });

test('离开信号：只有本次 1–2 轮用户消息命中', () => {
  for (const n of [1, 2]) assert.deepEqual(detectSignals({ onLeave: true, userTurns: n }), ['short_session']);
  for (const n of [0, 3, 12, -1, 1.5]) assert.deepEqual(detectSignals({ onLeave: true, userTurns: n }), []);
  assert.deepEqual(detectSignals({ messages: [user('你好')], onLeave: true }), ['short_session']);
  assert.deepEqual(detectSignals({ messages: [user('你好')] }), []);
});

test('不满意信号：你不懂、算了、没用、白说命中，礼貌收尾与计算不误伤', () => {
  for (const text of ['你不懂', '算了', '算了吧', '跟你说没用', '说了也白说']) {
    assert.equal(isDismissive(text), true, text);
    assert.ok(detectSignals({ userText: text }).includes('dismissive'));
  }
  for (const text of ['算了算了我自己来，谢谢你', '我算了总共二十块', '这个办法挺有用', '没用过这个软件', '没用完这张纸']) {
    assert.equal(isDismissive(text), false, text);
    assert.equal(detectSignals({ userText: text }).includes('dismissive'), false);
  }
});

test('变短信号：相对前几轮大幅缩短命中，一直简短或长度相近不命中', () => {
  const prior = ['最近一直在准备考试，但是每次打开书又觉得什么都看不进去', '我每天都想开始复习但到了晚上又觉得很烦躁，不知道怎么办'];
  assert.equal(isMarkedShorter([...prior, '嗯']), true);
  assert.ok(detectSignals({ messages: prior.map(user), userText: '嗯' }).includes('short_reply'));
  for (const texts of [['嗯'], ['在吗', '嗯'], [...prior, '我觉得还是先从每天看一点书开始吧']]) {
    assert.equal(isMarkedShorter(texts), false);
  }
});

test('重复问法信号：双字重叠高命中，换话题、太短和无当前输入不命中', () => {
  const previous = '我总是拖延到最后一天才开始，应该怎么办';
  const current = '换个说法，我总是拖延到最后一天才开始，这该怎么办';
  assert.equal(isRepeatedQuestion(previous, current), true);
  assert.ok(detectSignals({ messages: [user(previous)], userText: current }).includes('repeated_question'));
  assert.equal(isRepeatedQuestion(previous, '今天午饭吃了牛肉和青菜'), false);
  assert.equal(isRepeatedQuestion('嗯', '嗯'), false);
  assert.equal(detectSignals({ messages: [user(previous)], onLeave: true }).includes('repeated_question'), false);
});

test('三个人格离开文案各异、允许直接关闭，未知 botId 抛错', () => {
  const prompts = ['health', 'growth', 'listener'].map(leavePrompt);
  assert.equal(new Set(prompts).size, 3);
  prompts.forEach((text) => {
    assert.match(text, /直接关掉/);
    assert.doesNotMatch(text, /别走|留下|一直陪|真人朋友/);
  });
  assert.throws(() => leavePrompt(), /botId/);
  assert.throws(() => leavePrompt('unknown'), /botId/);
});

test('反馈池只保存当前片段及分类，按 bot 隔离，不接收 uid/history 等额外字段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guian-feedback-'));
  try {
    const store = createGrowStore({ dir });
    const item = { input: '问'.repeat(400), reply: '答'.repeat(600), safety: 'normal', source: 'implicit', reason: 'short_reply', signalType: 'short_reply', uid: 'private-uid', history: [{ content: '完整对话不许存' }] };
    store.addFailure('health', item);
    store.addGood('health', { ...item, reason: 'button_good', signalType: 'button_good', source: 'button' });
    for (const file of ['failures.jsonl', 'good.jsonl']) {
      const raw = fs.readFileSync(path.join(dir, 'grow', 'health', file), 'utf8');
      const entry = JSON.parse(raw.trim());
      assert.equal(entry.input.length, 300);
      assert.equal(entry.reply.length, 500);
      assert.doesNotMatch(raw, /uid|history|完整对话不许存|private-uid/);
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'at', 'source', 'reason', 'signalType', 'input', 'reply'].sort());
    }
    assert.equal(store.stats('health').good, 1);
    assert.equal(store.stats('health').failuresBySignal.short_reply, 1);
    assert.deepEqual(store.stats('listener'), { good: 0, failures: 0, failuresBySource: {}, failuresByReason: {}, failuresBySignal: {} });
    assert.equal(fs.existsSync(path.join(dir, 'grow', 'listener')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('反馈池兜底：risk/crisis、会话禁收和漏传安全级别的危险原文均不写任何文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guian-feedback-safety-'));
  try {
    const store = createGrowStore({ dir });
    for (const item of [
      { safety: 'risk' }, { safety: 'crisis' }, { safety: 2 }, { safety: 3 },
      { crisis: true }, { sessionBlocked: true }, { input: '我不想活了' }, { reply: '我今晚就去跳楼' }
    ]) {
      assert.equal(store.addFailure('health', item), null);
      assert.equal(store.addGood('health', item), null);
    }
    assert.equal(fs.existsSync(path.join(dir, 'grow')), false);
    assert.throws(() => store.addGood('unknown', { safety: 'risk' }), /botId/);
    assert.throws(() => store.addFailure('unknown', { safety: 'risk' }), /botId/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
