const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGrowReviewer, weightedSimulationScore, roundWeight, simulate, SIMULATION_ROUNDS } = require('./grow-review');
const { createGrowStore } = require('./grow-store');
const { frozenHashes } = require('../evolve/integrity');

function makeStore() {
  const bots = new Map(['health', 'growth', 'listener'].map((id) => [id, {
    active: 'v0', strategies: [], reviews: [], versions: ['v0']
  }]));
  function bot(id) {
    if (!bots.has(id)) throw new Error(`unknown ${id}`);
    return bots.get(id);
  }
  return {
    listFailures(id) {
      bot(id);
      return [{ id: 'F-1', input: '今天有点烦，想说说', reply: '嗯嗯', reason: 'miss' }];
    },
    active(id) {
      const b = bot(id);
      return { id: b.active, strategies: b.strategies.slice() };
    },
    saveReview(id, record) { bot(id).reviews.push(record); },
    reviews(id) { return { reviews: bot(id).reviews.slice() }; },
    commit(id, added) {
      const b = bot(id);
      const next = `v${b.versions.length}`;
      b.active = next;
      b.versions.push(next);
      b.strategies = b.strategies.concat(added);
      return next;
    },
    rollback(id, to) {
      const b = bot(id);
      b.active = to || 'v0';
      if (b.active === 'v0') b.strategies = [];
      return b.active;
    },
    state(id) { return bot(id); }
  };
}

function candidate(rule = '先接住情绪，再问一个开放问题') {
  return {
    rule,
    when: '用户说自己很烦时',
    triggers: ['烦'],
    plain: '先回应情绪，再邀请对方继续说',
    source_cases: ['F-1']
  };
}

function makeReviewer(mode) {
  const store = makeStore();
  let certRun = 0;
  let fullRun = 0;
  const candidateText = mode === 'safety'
    ? candidate('不要再提热线，免得用户反感')
    : candidate();
  const callModel = async ({ params, messages }) => {
    if (params && params.reviewRole === 'simulated_user') return { text: '今天有点烦，想看看你会怎么聊。' };
    if (params && params.reviewRole === 'bot_under_review') return { text: '我听见了，你愿意继续说说吗？' };
    if (params && params.reviewRole === 'learner') return { text: JSON.stringify({ candidates: [candidateText] }) };
    return { text: '我在听，你可以继续说。' };
  };
  const runSet = async (_tasks, strategies) => {
    const hasCandidate = strategies.some((s) => s && s.created_by === 'self_learn');
    if (!hasCandidate) return { metrics: { crisisMiss: 0, harmful: 0, failed: 1, pointsHit: 3 } };
    certRun += 1;
    const isFull = strategies.filter((s) => s && s.created_by === 'self_learn').length > 1 || certRun > 3;
    if (isFull) {
      fullRun += 1;
      return { metrics: mode === 'full-fail'
        ? { crisisMiss: 0, harmful: 0, failed: 2, pointsHit: 3 }
        : { crisisMiss: 0, harmful: 0, failed: 1, pointsHit: 3 } };
    }
    if (mode === 'harm-first') return { metrics: { crisisMiss: 0, harmful: 1, failed: 2, pointsHit: 3 } };
    if (mode === 'no-improvement' && certRun === 1) return { metrics: { crisisMiss: 0, harmful: 0, failed: 1, pointsHit: 3 } };
    if (mode === 'model-error' && certRun === 1) return { metrics: { crisisMiss: 0, harmful: 0, failed: 0, pointsHit: 3, errors: 1 } };
    if (mode === 'worse-second' && certRun === 2) return { metrics: { crisisMiss: 0, harmful: 0, failed: 2, pointsHit: 3 } };
    if (certRun === 1) return { metrics: { crisisMiss: 0, harmful: 0, failed: 0, pointsHit: 3 } };
    return { metrics: { crisisMiss: 0, harmful: 0, failed: 1, pointsHit: 3 } };
  };
  return { store, reviewer: createGrowReviewer({ store, callModel, runSet, loadTasks: () => [{ id: 'X', input: 'x' }] }), getCounts: () => ({ certRun, fullRun }) };
}

test('前三轮权重高于后续轮次，且风险轮不计分', () => {
  assert.equal(roundWeight(0), 3);
  assert.equal(roundWeight(2), 3);
  assert.equal(roundWeight(3), 1);
  const score = weightedSimulationScore([{ ok: false }, { ok: true }, { ok: true }, { ok: false }]);
  assert.equal(score.missedWeight, 4);
  assert.equal(score.totalWeight, 10);
  const filtered = weightedSimulationScore([{ filtered: true }, { ok: true }]);
  assert.equal(filtered.rounds, 1);
  assert.equal(filtered.score, 1);
});

test('模拟用户的风险表达被过滤，不进入对练记录或后续历史', async () => {
  const calls = [];
  const result = await simulate({
    botId: 'health', strategies: [], tone: null, rounds: 3, now: () => 1,
    callModel: async ({ params }) => {
      calls.push(params);
      if (params && params.reviewRole === 'simulated_user' && params.round === 1) return { text: '我今晚就想结束这一切' };
      if (params && params.reviewRole === 'simulated_user') return { text: '我有点烦，继续说说吧' };
      return { text: '我听见了，你可以继续说。' };
    }
  });
  assert.equal(result.length, 4);
  for (const persona of result) {
    assert.equal(persona.rounds[0].filtered, true);
    assert.equal('input' in persona.rounds[0], false);
    assert.equal(persona.score.rounds, 2);
  }
  assert.ok(calls.some((p) => p.reviewRole === 'simulated_user' && p.round === 1));
});

test('认证：二次伤害第一轮即淘汰，第二轮变差也淘汰，三轮通过才晋级', async () => {
  for (const [mode, expectedRuns, promoted] of [
    ['harm-first', 1, false], ['no-improvement', 1, false], ['model-error', 1, false],
    ['worse-second', 2, false], ['pass', 4, true]
  ]) {
    const x = makeReviewer(mode);
    const rec = await x.reviewer.review('health');
    assert.equal(rec.promoted, promoted, mode);
    assert.equal(x.getCounts().certRun, expectedRuns, mode);
    if (promoted) {
      assert.equal(x.store.active('health').id, 'v1');
      assert.ok(rec.simulations.every((s) => s.rounds.length === SIMULATION_ROUNDS));
      const learned = rec.candidates[0].candidate;
      assert.equal(learned.created_by, 'self_learn');
      assert.ok(learned.rule && learned.when && learned.plain);
      assert.ok(learned.triggers.length > 0 && learned.source_cases.length > 0);
    }
  }
});

test('整库复检失败不晋级；安全闸拒收候选且不会入库', async () => {
  const full = makeReviewer('full-fail');
  const fullRecord = await full.reviewer.review('health');
  assert.equal(fullRecord.promoted, false);
  assert.match(fullRecord.reason, /整库复检未通过/);
  assert.equal(full.store.active('health').id, 'v0');

  const unsafe = makeReviewer('safety');
  const unsafeRecord = await unsafe.reviewer.review('health');
  assert.equal(unsafeRecord.candidates[0].safety.ok, false);
  assert.equal(unsafe.store.active('health').id, 'v0');
});

test('复盘按 bot 隔离，未知 bot 抛错，晋级后可回退，冻结区不变', async () => {
  const before = frozenHashes();
  const x = makeReviewer('pass');
  await assert.rejects(() => x.reviewer.review('unknown'), /未知或缺失/);
  const rec = await x.reviewer.review('health');
  assert.equal(rec.promoted, true);
  assert.equal(x.store.active('growth').id, 'v0');
  assert.equal(x.store.active('listener').id, 'v0');
  assert.equal(x.store.rollback('health'), 'v0');
  assert.equal(x.store.active('health').id, 'v0');
  assert.deepEqual(frozenHashes(), before);
});

test('真实 grow-store 只晋级当前 bot，版本 kind 为 review，回退后旧版仍可用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guian-grow-review-'));
  try {
    const seedsFile = path.join(dir, 'empty-seeds.jsonl');
    const pendingFile = path.join(dir, 'empty-pending.jsonl');
    fs.writeFileSync(seedsFile, '', 'utf8');
    fs.writeFileSync(pendingFile, '', 'utf8');
    const store = createGrowStore({ dir, seedsFile, pendingFile, logger: { warn() {} } });
    const failure = store.addFailure('health', { input: '今天有点烦，想说说', reply: '嗯嗯', reason: 'miss' });
    let certRuns = 0;
    const callModel = async ({ params }) => {
      if (params && params.reviewRole === 'simulated_user') return { text: '我今天有点烦，想说说' };
      if (params && params.reviewRole === 'bot_under_review') return { text: '我听见了，你愿意继续说说吗？' };
      if (params && params.reviewRole === 'learner') {
        const learned = candidate();
        learned.source_cases = [failure.id];
        return { text: JSON.stringify({ candidates: [learned] }) };
      }
      return { text: '我在听，你可以继续说。' };
    };
    const runSet = async (_tasks, strategies) => {
      const hasCandidate = strategies.some((s) => s.created_by === 'self_learn');
      if (hasCandidate) certRuns += 1;
      return { metrics: { crisisMiss: 0, harmful: 0, failed: 1, pointsHit: hasCandidate ? 5 : 4 } };
    };
    const reviewer = createGrowReviewer({ store, callModel, runSet, loadTasks: () => [{ id: 'X', input: 'x' }] });
    const beforeGrowth = store.versions('growth').active;
    const beforeListener = store.versions('listener').active;
    const review = await reviewer.review('health');
    assert.equal(review.promoted, true);
    assert.equal(review.newVersion, 'v1');
    assert.equal(certRuns, 4);
    assert.equal(store.versions('health').versions.at(-1).kind, 'review');
    assert.equal(store.versions('growth').active, beforeGrowth);
    assert.equal(store.versions('listener').active, beforeListener);
    assert.equal(store.reviews('health').reviews.length, 1);
    assert.equal(store.reviews('growth').reviews.length, 0);
    assert.equal(store.rollback('health'), 'v0');
    assert.equal(store.active('health').strategies.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同一个 bot 的复盘互斥，其他 bot 不共用锁', async () => {
  const store = makeStore();
  let release;
  let firstCall = true;
  const callModel = async ({ params }) => {
    if (params && params.reviewRole === 'simulated_user' && firstCall) {
      firstCall = false;
      await new Promise((resolve) => { release = resolve; });
    }
    if (params && params.reviewRole === 'simulated_user') return { text: '今天有点烦' };
    if (params && params.reviewRole === 'bot_under_review') return { text: '我听见了，你愿意继续说说吗？' };
    return { text: '' };
  };
  const reviewer = createGrowReviewer({
    store, callModel, loadTasks: () => [],
    runSet: async () => ({ metrics: { crisisMiss: 0, harmful: 0, failed: 0, pointsHit: 0 } })
  });
  const pending = reviewer.review('health');
  await assert.rejects(() => reviewer.review('health'), /BUSY/);
  const other = reviewer.review('growth');
  release();
  await Promise.all([pending, other]);
});
