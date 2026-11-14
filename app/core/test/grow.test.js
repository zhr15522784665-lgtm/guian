const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runTurn } = require('../src/turn/run-turn');
const { retrieveStrategies } = require('../src/grow/strategies');
const { CRISIS_REPLY, RISK_REPLY } = require('../src/content/crisis');
const { validateRule } = require('../../evolve/frozen/safety');
const { createGrowStore } = require('../../server/grow-store');

const SEEDS_FILE = path.join(__dirname, '..', '..', 'grow', 'seeds.jsonl');
const PENDING_FILE = path.join(__dirname, '..', '..', 'grow', 'pending.jsonl');

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function validExtra(id, rule) {
  return {
    id,
    bots: ['health'],
    scope: 'general',
    triggers: ['隔离标记'],
    rule,
    when: '测试策略',
    plain: rule,
    source_cases: [id],
    created_by: 'user_taught'
  };
}

test('S1-S5 种子齐全、属于全部 bot，并通过冻结安全闸', () => {
  const seeds = readJsonl(SEEDS_FILE);
  assert.deepEqual(
    seeds.map((s) => s.id),
    ['U-001', 'U-002', 'U-003', 'U-004', 'U-005']
  );
  seeds.forEach((seed) => {
    assert.equal(seed.bots, 'all', `${seed.id} 应覆盖全部 bot`);
    assert.equal(seed.created_by, 'user_taught');
    assert.deepEqual(validateRule(seed), { ok: true }, `${seed.id} 未通过 frozen/safety.validateRule`);
  });
});

test('S6–S9 只在 pending，永不进入种子 v1 和策略提示词', () => {
  const pending = readJsonl(PENDING_FILE);
  assert.deepEqual(pending.map((s) => s.id), ['S6', 'S7', 'S8', 'S9']);
  assert.deepEqual(pending.find((s) => s.id === 'S6').bots, ['growth']);
  const seeds = readJsonl(SEEDS_FILE);
  assert.equal(seeds.some((s) => ['S6', 'S7', 'S8', 'S9'].includes(s.id)), false);

  const systemStrategies = retrieveStrategies(seeds, '我想聊聊天', { hour: 14 });
  const text = systemStrategies.map((s) => s.rule).join('\n');
  assert.doesNotMatch(text, /揉进聊天|就想聊天|其他伙伴|咋唠/);
});

test('pending 候选不注入任何 bot 的 system prompt', async () => {
  const seeds = readJsonl(SEEDS_FILE);
  for (const botId of ['health', 'growth', 'listener']) {
    const { system } = await captureSystem({ botId, strategies: seeds, userText: '我就想聊天，你跟小步他俩聊了啥？下一步怎么拆', clock: { hour: 23, minute: 30 } });
    assert.doesNotMatch(system, /揉进聊天|别把话题往干活上拽|其他伙伴聊过|咋唠的/, `${botId} 不应注入 pending`);
  }
});

async function captureSystem(input) {
  const calls = [];
  const result = await runTurn(
    {
      botId: input.botId || 'growth',
      userText: input.userText || '你好',
      history: [],
      botState: { seenIntro: true },
      strategies: input.strategies,
      clock: input.clock
    },
    {
      now: () => 1_700_000_000_000,
      callModel: async (payload) => {
        calls.push(payload);
        return { text: '收到', model: 'test', latencyMs: 1, fallbackUsed: false };
      }
    }
  );
  assert.equal(calls.length, 1);
  return { system: calls[0].system, result };
}

test('普通轮次注入策略和服务端本地时间；S5 只在深夜注入', async () => {
  const seeds = readJsonl(SEEDS_FILE);
  const day = await captureSystem({
    strategies: seeds,
    clock: { hour: 14, minute: 7, weekday: '周六' }
  });
  assert.match(day.system, /【你从之前的对话里学到的】/);
  assert.match(day.system, /本地时间 14:07（下午）/);
  assert.doesNotMatch(day.system, /到了该睡的点/);

  const night = await captureSystem({
    strategies: seeds,
    clock: { hour: 23, minute: 5, weekday: '周六' }
  });
  assert.match(night.system, /本地时间 23:05（深夜）/);
  assert.match(night.system, /到了该睡的点/);

  const lateEvening = await captureSystem({
    strategies: seeds,
    clock: { hour: 22, minute: 5, weekday: '周六' }
  });
  assert.match(lateEvening.system, /本地时间 22:05（夜里）/);
  assert.match(lateEvening.system, /到了该睡的点/);
});

test('策略提供器在 risk/crisis 固定协议前不被读取', async () => {
  let reads = 0;
  let calls = 0;
  const adapters = {
    now: () => 1_700_000_000_000,
    callModel: async () => {
      calls += 1;
      return { text: '不该出现', model: 'test' };
    }
  };
  const strategySource = () => {
    reads += 1;
    return [{ id: 'LEAK', rule: '不应出现在危机回复里的策略文本' }];
  };

  const risk = await runTurn(
    { botId: 'listener', userText: '我不想活了', history: [], botState: { seenIntro: true }, strategies: strategySource },
    adapters
  );
  assert.equal(calls, 0);
  assert.equal(reads, 0);
  assert.equal(risk.reply, RISK_REPLY);
  assert.match(risk.reply, /12356/);
  assert.doesNotMatch(risk.reply, /LEAK|不应出现在/);

  const crisis = await runTurn(
    { botId: 'listener', userText: '我今晚就去跳楼', history: [], botState: { seenIntro: true }, strategies: strategySource },
    adapters
  );
  assert.equal(calls, 0);
  assert.equal(reads, 0);
  assert.equal(crisis.reply, CRISIS_REPLY);
  assert.match(crisis.reply, /12356/);
  assert.doesNotMatch(crisis.reply, /LEAK|不应出现在/);
});

test('grow-store 按 bot 隔离、版本快照可回退且旧文件不改写', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guian-grow-'));
  try {
    const store = createGrowStore({ dir: tmp, seedsFile: SEEDS_FILE, pendingFile: PENDING_FILE, logger: { warn() {} } });
    const initial = store.active('health');
    assert.equal(initial.id, 'v1');
    const oldFile = path.join(tmp, 'grow', 'health', 'v1.jsonl');
    const oldContents = fs.readFileSync(oldFile, 'utf8');

    const extra = validExtra('HEALTH-ONLY', '只给 health 的隔离标记策略');
    const next = store.commit('health', [extra], { kind: 'test' });
    assert.equal(next, 'v2');
    assert.match(store.active('health').strategies.map((s) => s.id).join(','), /HEALTH-ONLY/);
    assert.doesNotMatch(store.active('listener').strategies.map((s) => s.id).join(','), /HEALTH-ONLY/);

    const healthPrompt = await captureSystem({ botId: 'health', strategies: store.active('health').strategies, userText: '隔离标记' });
    const listenerPrompt = await captureSystem({ botId: 'listener', strategies: store.active('listener').strategies, userText: '隔离标记' });
    assert.match(healthPrompt.system, /只给 health 的隔离标记策略/);
    assert.doesNotMatch(listenerPrompt.system, /只给 health 的隔离标记策略/);

    assert.equal(store.rollback('health'), 'v1');
    assert.equal(store.active('health').id, 'v1');
    assert.doesNotMatch(store.active('health').strategies.map((s) => s.id).join(','), /HEALTH-ONLY/);
    const rolledPrompt = await captureSystem({ botId: 'health', strategies: store.active('health').strategies, userText: '隔离标记' });
    assert.doesNotMatch(rolledPrompt.system, /只给 health 的隔离标记策略/);
    assert.equal(fs.readFileSync(oldFile, 'utf8'), oldContents);
    assert.equal(store.pending('health').map((s) => s.id).join(','), 'S7,S8,S9');
    assert.equal(store.pending('growth').map((s) => s.id).join(','), 'S6,S7,S8,S9');
    assert.equal(store.active('health').strategies.some((s) => /^S[6-9]$/.test(s.id)), false);

    const methods = [
      ['versions', []], ['active', []], ['load', ['v0']], ['commit', [[]]], ['rollback', []],
      ['syncSeeds', []], ['addFailure', [{}]], ['listFailures', []], ['addGood', []],
      ['stats', []], ['reviews', []], ['saveReview', [{ id: 'x' }]], ['pending', []]
    ];
    for (const [name, args] of methods) {
      assert.throws(() => store[name](...args), /botId|未知|缺失/, `${name} 缺 botId 应抛错`);
      assert.throws(() => store[name]('unknown', ...args), /botId|未知|缺失/, `${name} 未知 botId 应抛错`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
