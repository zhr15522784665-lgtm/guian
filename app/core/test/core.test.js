const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  findPersona,
  PERSONAS,
  PERSONA_IDS,
  PersonaError,
  listPersonaCards
} = require('../src/personas');
const { buildSystemPrompt, renderMemoryBlock } = require('../src/pipeline/prompt');
const { classify, LEVEL } = require('../src/pipeline/safety-router');
const { detectSoftSignals, detectStructural } = require('../src/pipeline/dependency');
const { decide, applyCardAction } = require('../src/pipeline/intervention');
const { extractByRule } = require('../src/memory/extract-rule');
const { rankMemories } = require('../src/memory/rank');
const { pickHistory, buildContext } = require('../src/turn/context');
const { runTurn } = require('../src/turn/run-turn');
const { CRISIS_REPLY, RISK_REPLY } = require('../src/content/crisis');

const DAY = 24 * 60 * 60 * 1000;

function readGrowSeed(id) {
  const seedsFile = path.join(__dirname, '..', '..', 'grow', 'seeds.jsonl');
  const line = fs.readFileSync(seedsFile, 'utf8').split('\n').find((row) => {
    if (!row.trim()) return false;
    return JSON.parse(row).id === id;
  });
  if (!line) throw new Error(`缺少 grow 种子 ${id}`);
  return JSON.parse(line);
}

// ─────────────────────────────────────────────
// 人格注册表：找不到必须抛错，绝不静默兜底
// ─────────────────────────────────────────────
test('findPersona：未知 botId 抛错，不兜底到第一个人格', () => {
  assert.throws(() => findPersona('unknown'), (err) => {
    assert.ok(err instanceof PersonaError);
    assert.equal(err.code, 'BOT_ID_UNKNOWN');
    return true;
  });
});

test('findPersona：空值与缺失抛错', () => {
  assert.throws(() => findPersona(''), /botId/);
  assert.throws(() => findPersona(undefined), /botId/);
  assert.throws(() => findPersona(null), /botId/);
});

test('persona 只允许三个 id，白名单固定', () => {
  assert.deepEqual([...PERSONA_IDS], ['health', 'growth', 'listener']);
});

test('前端卡片不含 prompt 与 few-shot', () => {
  const cards = listPersonaCards();
  assert.equal(cards.length, 3);
  cards.forEach((c) => {
    assert.ok(c.id && c.name && c.avatar && c.tagline);
    assert.equal(c.fewShots, undefined);
    assert.equal(c.identity, undefined);
  });
});

// ─────────────────────────────────────────────
// 身份段：三个必须同时成立的断言。
// 缺任何一条，人格就会失真——要么变专家，要么变外行。
// ─────────────────────────────────────────────
test('每份人设的三句身份段齐备且非空', () => {
  PERSONAS.forEach((p) => {
    assert.ok(p.identity.depth.length > 30, `${p.id} 缺少 depth`);
    assert.ok(p.identity.limit.length > 20, `${p.id} 缺少 limit`);
    assert.ok(p.identity.relation.length > 15, `${p.id} 缺少 relation`);
  });
});

test('每份人设都写了「懂很多」，防外行化', () => {
  PERSONAS.forEach((p) => {
    const d = p.identity.depth;
    assert.match(d, /(研究|读过|试过|懂|知道)/, `${p.id} 的 depth 没体现知识量`);
  });
});

test('健康与成长人设都写了「没资格」，防专家化', () => {
  ['health', 'growth'].forEach((id) => {
    const p = findPersona(id);
    assert.match(p.identity.limit, /没有.{0,4}资格/, `${id} 缺少资格否定句`);
  });
});

test('每份人设都明确「是朋友」，定关系性质', () => {
  PERSONAS.forEach((p) => {
    assert.match(p.identity.relation, /朋友|旁边/, `${p.id} 的 relation 没说明是朋友`);
  });
});

test('每份人设都有两个方向的改说映射', () => {
  const health = findPersona('health');
  const picks = health.voice.rewrites.map(([from]) => from);
  // 向上：防专家腔
  assert.ok(picks.some((f) => f.includes('建议')), '缺少「建议你」的替换');
  assert.ok(picks.some((f) => f.includes('应该')), '缺少「你应该」的替换');
  // 向下：防外行化敷衍
  assert.ok(picks.some((f) => f.includes('问医生')), '缺少「问医生吧」的替换');
});

test('每份人设的 few-shot 至少覆盖「问方法」与「问是不是病」两类', () => {
  const health = findPersona('health');
  const all = health.fewShots.flatMap((g) => g.turns.filter((t) => t.role === 'user').map((t) => t.content));
  assert.ok(all.some((c) => /怎么办|有什么办法|怎么才|怎么改/.test(c)), '缺少「问方法」样例');
  assert.ok(all.some((c) => /是不是|是什么病/.test(c)), '缺少「问是不是病」样例');
  assert.ok(all.some((c) => /就告诉我|别跟我说/.test(c)), '缺少「被逼要方案」样例');
});

test('few-shot 里的 assistant 回复都不出现医嘱句式', () => {
  PERSONAS.forEach((p) => {
    p.fewShots.forEach((g) => {
      g.turns
        .filter((t) => t.role === 'assistant')
        .forEach((t) => {
          assert.doesNotMatch(t.content, /建议您|建议你|你应该/, `${p.id} 的样例里有医嘱句式`);
        });
    });
  });
});

// ─────────────────────────────────────────────
// prompt 渲染
// ─────────────────────────────────────────────
test('system 包含三句身份段与语感规则', () => {
  const p = findPersona('health');
  const sys = buildSystemPrompt({ persona: p, memories: [] });
  assert.match(sys, /【你是谁】/);
  assert.match(sys, /【你怎么说话】/);
  assert.match(sys, /【你的边界】/);
  assert.match(sys, /【对话示例】/);
  assert.ok(sys.includes(p.identity.depth.slice(0, 12)));
  assert.ok(sys.includes(p.identity.limit.slice(0, 12)));
});

test('记忆为空时明确禁止假装记得', () => {
  const block = renderMemoryBlock([]);
  assert.match(block, /空/);
  assert.match(block, /不要假装记得/);
});

test('记忆非空时给出「只记得这里写的」的硬约束', () => {
  const block = renderMemoryBlock([{ text: '对花生过敏', kind: 'allergy' }]);
  assert.match(block, /只记得上面写的/);
  assert.match(block, /不要编/);
  assert.ok(block.includes('对花生过敏'));
});

test('system 提醒模型不要复用示例的情节与数字', () => {
  const sys = buildSystemPrompt({ persona: findPersona('health'), memories: [] });
  assert.match(sys, /不要复用/);
  assert.match(sys, /记不太清/);
});

test('记忆为空时，在示例之前插入不许回忆的提示', () => {
  const p = findPersona('health');
  const sys = buildSystemPrompt({ persona: p, memories: [] });
  assert.match(sys, /没有任何关于他的记忆/);
  // 提示必须出现在示例之前，否则冲突已经形成
  assert.ok(sys.indexOf('没有任何关于他的记忆') < sys.indexOf('【对话示例】'));
});

test('三个人设渲染出的 system 彼此不同', () => {
  const systems = PERSONA_IDS.map((id) =>
    buildSystemPrompt({ persona: findPersona(id), memories: [] })
  );
  assert.notEqual(systems[0], systems[1]);
  assert.notEqual(systems[1], systems[2]);
  assert.notEqual(systems[0], systems[2]);
});

test('三个普通轮 system prompt 都明确禁止编造自己的生活经历', () => {
  for (const id of PERSONA_IDS) {
    const sys = buildSystemPrompt({ persona: findPersona(id), memories: [] });
    assert.match(sys, /不要编造自己的作息、习惯、身体感受或生活经历/, `${id} 缺少通用护栏`);
    assert.match(sys, /聊他的状态，不讲自己的/, `${id} 缺少说话方向`);
  }
});

test('深夜注入 U-005 时，system prompt 追加只描述用户一侧的提醒', () => {
  const u005 = readGrowSeed('U-005');
  const sys = buildSystemPrompt({
    persona: findPersona('health'),
    memories: [],
    strategies: [u005],
    clock: { hour: 1, minute: 17 }
  });
  assert.ok(sys.includes(u005.rule), 'U-005 没有进入 prompt');
  assert.match(sys, /深夜或夜里借时间、天气、环境暗示休息时，只描述他那边的环境和感受，不说「我也/);
});

test('白天 system prompt 保留通用护栏，但不带深夜追加提醒', () => {
  const sys = buildSystemPrompt({
    persona: findPersona('health'),
    memories: [],
    clock: { hour: 13, minute: 0 }
  });
  assert.match(sys, /不要编造自己的作息、习惯、身体感受或生活经历/);
  assert.doesNotMatch(sys, /深夜或夜里借时间、天气、环境暗示休息时/);
});

// ─────────────────────────────────────────────
// 安全分诊
// ─────────────────────────────────────────────
test('口语夸张不判危机', () => {
  ['笑死我了', '今天累死了', '热死了这天气', '想死你了'].forEach((t) => {
    assert.equal(classify({ text: t }).level, LEVEL.NORMAL, `误报：${t}`);
  });
});

test('情绪困扰判 concern，不阻断', () => {
  assert.equal(classify({ text: '今天真的好累' }).level, LEVEL.CONCERN);
  assert.equal(classify({ text: '我最近有点撑不住' }).level, LEVEL.CONCERN);
});

test('自伤意念判 risk', () => {
  ['我不想活了', '活着没意思', '我最近一直想死', '我想消失'].forEach((t) => {
    assert.equal(classify({ text: t }).level, LEVEL.RISK, `漏报：${t}`);
  });
});

test('有方式或有时间判 crisis', () => {
  ['我今晚就去跳楼', '遗书写好了', '我已经割了'].forEach((t) => {
    assert.equal(classify({ text: t }).level, LEVEL.CRISIS, `漏报：${t}`);
  });
});

test('日常医疗表达不误报危机', () => {
  // 这几句是每天都在发生的正常表达，误报会让用户被一句热线吓到
  ['我正在吃药，医生说吃两周', '我不太会吞药片', '我爸上个月割了阑尾', '今天吃什么'].forEach((t) => {
    assert.notEqual(classify({ text: t }).level, LEVEL.CRISIS, `误报：${t}`);
  });
});

test('排他性语言叠加伤害话题，直接升 crisis', () => {
  const r = classify({ text: '只有你懂我，我不想活了', hasExclusion: true });
  assert.equal(r.level, LEVEL.CRISIS);
  assert.ok(r.reasonCodes.includes('combo_exclusion_plus_harm'));
});

test('分诊结果带 reasonCodes，可复盘', () => {
  const r = classify({ text: '我不想活了' });
  assert.ok(Array.isArray(r.reasonCodes) && r.reasonCodes.length > 0);
});

// ─────────────────────────────────────────────
// 依赖信号
// ─────────────────────────────────────────────
test('排他性信号被识别，且权重最高', () => {
  const r = detectSoftSignals('只有你懂我，别人都不理解我');
  assert.equal(r.hasExclusion, true);
  assert.ok(r.score >= 3);
});

test('普通抱怨不产生依赖信号', () => {
  assert.equal(detectSoftSignals('今天加班到九点').score, 0);
});

test('「你会一直陪着我吗」既是依赖信号，也必须有对应示例', () => {
  const sig = detectSoftSignals('你会一直陪着我吗');
  assert.ok(sig.score >= 2, '规则层没有识别出这句');

  const p = findPersona('listener');
  const users = p.fewShots.flatMap((g) => g.turns.filter((t) => t.role === 'user').map((t) => t.content));
  assert.ok(
    users.some((c) => /一直陪/.test(c)),
    '缺少「你会一直陪着我吗」的示例——这是整个产品最核心的一道题'
  );
  // 示例的回复里不能出现承诺
  const answers = p.fewShots
    .filter((g) => g.turns.some((t) => /一直陪/.test(t.content)))
    .flatMap((g) => g.turns.filter((t) => t.role === 'assistant').map((t) => t.content));
  answers.forEach((a) => {
    assert.doesNotMatch(a, /会一直在|一直陪着你|永远在/, '示例回复里出现了承诺');
  });
});

test('三个人设都禁止被贬低时自贬', () => {
  PERSONAS.forEach((p) => {
    assert.equal(p.stance.whenDevalued, 'do_not_self_deprecate', `${p.id} 缺少不自贬规则`);
    const sys = buildSystemPrompt({ persona: p, memories: [] });
    assert.match(sys, /不要顺着承认/, `${p.id} 的不自贬规则没有渲染出来`);
  });
});

test('倾诉人设明确禁止「反思作业」与「承诺一直在」', () => {
  const p = findPersona('listener');
  assert.equal(p.stance.noReflectionHomework, true);
  assert.ok(p.boundaries.some((b) => /不承诺「一直在」/.test(b)));
  const sys = buildSystemPrompt({ persona: p, memories: [] });
  assert.match(sys, /不要把问题变成作业/);
});

test('成长人设禁止把问题抛回去', () => {
  const p = findPersona('growth');
  assert.equal(p.stance.neverAnswerWithQuestion, true);
  const sys = buildSystemPrompt({ persona: p, memories: [] });
  assert.match(sys, /把问题抛回去/);
});

test('成长人设禁止工具名与方法论', () => {
  const p = findPersona('growth');
  const all = p.voice.avoid.join('|');
  assert.match(all, /番茄钟/);
  assert.match(all, /SMART/);
});

test('结构指标能抓到深夜与只倾倒', () => {
  const flags = detectStructural({
    consecutiveDays: 20,
    avgTurnsPerDay: 25,
    turnsToday: 70,
    nightRatio: 0.7,
    recentUserLengths: [3, 4, 2, 5, 3]
  });
  const codes = flags.map((f) => f.code);
  assert.ok(codes.includes('struct_daily_heavy'));
  assert.ok(codes.includes('struct_single_day_burst'));
  assert.ok(codes.includes('struct_night_heavy'));
  assert.ok(codes.includes('struct_pour_only'));
});

// ─────────────────────────────────────────────
// 介入决策
// ─────────────────────────────────────────────
test('第一次对话给 L1 声明，且只给一次', () => {
  const now = 1_700_000_000_000;
  const first = decide({
    botState: { seenIntro: false },
    signal: { safetyLevel: 0, softScore: 0, structuralFlags: [] },
    now
  });
  assert.equal(first.action, 'l1_intro');
  assert.ok(first.text.length > 10);

  const second = decide({
    botState: { seenIntro: true, intervention: {} },
    signal: { safetyLevel: 0, softScore: 0, structuralFlags: [] },
    now: now + 1000
  });
  assert.equal(second.action, 'none');
});

test('安全级别 ≥ risk 时，任何介入都不触发', () => {
  const now = 1_700_000_000_000;
  const r = decide({
    botState: { seenIntro: false },
    signal: { safetyLevel: 2, softScore: 10, structuralFlags: [] },
    now
  });
  assert.equal(r.action, 'none');
  assert.equal(r.reason, 'safety_priority');
});

test('软信号累计到 3 分触发 L2，14 天内不重复触发', () => {
  const now = 1_700_000_000_000;
  let botState = { seenIntro: true, intervention: {} };
  let globalState = {};
  const signal = { safetyLevel: 0, softScore: 1, structuralFlags: [] };

  // 第 1、2 次只记录
  for (let i = 0; i < 2; i += 1) {
    const r = decide({ botState, globalState, signal, now: now + i * 1000 });
    assert.equal(r.action, 'none');
    botState = { ...botState, intervention: { ...botState.intervention, ...(r.patch.bot || {}).intervention } };
  }
  // 第 3 次累计到 3，触发 L2
  const third = decide({ botState, globalState, signal, now: now + 2000 });
  assert.equal(third.action, 'l2_light');

  // 应用 patch 后，同一天继续给软信号，不再触发
  const applied = { ...botState, intervention: { ...botState.intervention, ...third.patch.bot.intervention } };
  const g2 = { ...globalState, ...(third.patch.global || {}) };
  const fourth = decide({ botState: applied, globalState: g2, signal, now: now + 3000 });
  assert.notEqual(fourth.action, 'l2_light');
});

test('点过「我知道了」之后 30 天全静默', () => {
  const now = 1_700_000_000_000;
  const inter = applyCardAction({ stage: 'l3' }, 'ack', now);
  const r = decide({
    botState: { seenIntro: true, intervention: inter },
    signal: { safetyLevel: 0, softScore: 9, structuralFlags: [] },
    now: now + 5 * DAY
  });
  assert.equal(r.action, 'none');
  assert.equal(r.reason, 'acknowledged_silence');
});

test('snooze 期间不打扰', () => {
  const now = 1_700_000_000_000;
  const inter = applyCardAction({ stage: 'l3' }, 'snooze', now);
  const r = decide({
    botState: { seenIntro: true, intervention: inter },
    signal: { safetyLevel: 0, softScore: 9, structuralFlags: [] },
    now: now + 3 * DAY
  });
  assert.equal(r.action, 'none');
  assert.equal(r.reason, 'snoozed');
});

// ─────────────────────────────────────────────
// 记忆
// ─────────────────────────────────────────────
test('规则抽取只抓明确模板', () => {
  const got = extractByRule('我对花生过敏');
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'allergy');
  assert.ok(got[0].text.includes('花生'));
});

test('规则抽取不会对普通句子乱抓', () => {
  assert.equal(extractByRule('今天天气不错').length, 0);
});

test('记忆排序：高权重且新鲜的在前面', () => {
  const now = 1_700_000_000_000;
  const ranked = rankMemories(
    [
      { kind: 'preference', text: '喜欢喝冰美式', weight: 1, updatedAt: now - 60 * DAY },
      { kind: 'allergy', text: '对花生过敏', weight: 3, updatedAt: now - 2 * DAY }
    ],
    now
  );
  assert.equal(ranked[0].text, '对花生过敏');
});

test('记忆条数受上限约束', () => {
  const now = Date.now();
  const many = Array.from({ length: 20 }, (_, i) => ({
    kind: 'preference',
    text: `事实${i}`,
    weight: 1,
    updatedAt: now
  }));
  assert.ok(rankMemories(many, now, 8).length === 8);
});

// ─────────────────────────────────────────────
// 上下文组装
// ─────────────────────────────────────────────
test('历史窗口从 user 开始，不留孤立的 assistant 开头', () => {
  const history = [
    { role: 'assistant', content: '在呢' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '嗯' }
  ];
  const win = pickHistory(history, 12);
  assert.equal(win[0].role, 'user');
});

test('单条历史超长时裁剪', () => {
  const long = '啊'.repeat(2000);
  const win = pickHistory([{ role: 'user', content: long }], 12);
  assert.ok(win[0].content.length <= 600);
});

// ─────────────────────────────────────────────
// 危机文案：不能出现任何边界声明
// ─────────────────────────────────────────────
test('危机文案不含任何撇清句式', () => {
  const forbidden = ['替代真实', '不能替代', '我只是一个', '我只是个', '作为一个 AI', '程序', '机器人'];
  [CRISIS_REPLY, RISK_REPLY].forEach((text) => {
    forbidden.forEach((w) => {
      assert.ok(!text.includes(w), `危机文案出现了「${w}」`);
    });
  });
});

test('危机文案必须给出热线号码', () => {
  assert.ok(CRISIS_REPLY.includes('12356'));
  assert.ok(RISK_REPLY.includes('12356'));
});

test('crisis.js 不允许依赖 boundary.js（代码层隔离）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'crisis.js'), 'utf8');
  const requires = src.match(/require\([^)]*\)/g) || [];
  assert.ok(
    !requires.some((r) => r.includes('boundary')),
    'crisis.js 不能 require boundary.js，否则危机路径可能触达边界文案'
  );
});

// ─────────────────────────────────────────────
// 端到端：runTurn
// ─────────────────────────────────────────────
function makeAdapters(reply) {
  const calls = [];
  return {
    calls,
    adapters: {
      now: () => 1_700_000_000_000,
      callModel: async (payload) => {
        calls.push(payload);
        return { text: reply, model: 'deepseek-flash', latencyMs: 800, fallbackUsed: false };
      }
    }
  };
}

test('危机时不调用模型，直接给固定文案', async () => {
  const { calls, adapters } = makeAdapters('模型不该被调用');
  const out = await runTurn(
    { botId: 'listener', userText: '我今晚就去跳楼', history: [], botState: { seenIntro: true } },
    adapters
  );
  assert.equal(calls.length, 0);
  assert.equal(out.reply, CRISIS_REPLY);
  assert.equal(out.card.type, 'hotline');
});

test('risk 级别也不调用模型', async () => {
  const { calls, adapters } = makeAdapters('不该被调用');
  const out = await runTurn(
    { botId: 'health', userText: '我不想活了', history: [], botState: { seenIntro: true } },
    adapters
  );
  assert.equal(calls.length, 0);
  assert.equal(out.reply, RISK_REPLY);
});

test('正常对话走模型；首次对话记 L1，但不再把声明硬塞到回复末尾', async () => {
  const { adapters } = makeAdapters('嗯，最近睡得怎么样？');
  const out = await runTurn(
    { botId: 'health', userText: '你好', history: [], botState: { seenIntro: false } },
    adapters
  );
  assert.equal(out.reply, '嗯，最近睡得怎么样？', '回复末尾不该再追加边界声明');
  assert.equal(out.intervention.action, 'l1_intro');
  assert.equal(out.patch.bot.seenIntro, true);
});

test('模型失败时给一句人话，不把错误抛给用户', async () => {
  const adapters = {
    now: () => 1_700_000_000_000,
    callModel: async () => {
      throw new Error('timeout');
    }
  };
  const out = await runTurn(
    { botId: 'growth', userText: '在吗', history: [], botState: { seenIntro: true } },
    adapters
  );
  assert.ok(out.reply.length > 0);
  assert.equal(out.usage.fallbackUsed, true);
});

test('同一句话发给三个 bot，注入的 system 各不相同', async () => {
  const systems = [];
  for (const id of PERSONA_IDS) {
    const { calls, adapters } = makeAdapters('好');
    await runTurn(
      { botId: id, userText: '我最近有点累', history: [], botState: { seenIntro: true } },
      adapters
    );
    assert.equal(calls.length, 1, `${id} 没有调用模型`);
    systems.push(calls[0].system);
  }
  assert.equal(new Set(systems).size, 3, '三个人设的 system 出现了重复');
});

test('buildContext 组装出 system + 最近历史 + 本轮输入', () => {
  const ctx = buildContext({
    persona: findPersona('listener'),
    history: [
      { role: 'user', content: '昨天被骂了' },
      { role: 'assistant', content: '当着人骂？' }
    ],
    userText: '嗯，现在还难受',
    now: 1_700_000_000_000
  });
  assert.match(ctx.system, /【你是谁】/);
  assert.equal(ctx.messages.length, 3);
  assert.equal(ctx.messages[ctx.messages.length - 1].content, '嗯，现在还难受');
});

test('倾诉人设的东北味儿：有方向、有护栏，「不叫啥事」只给小事', () => {
  const p = findPersona('listener');
  const sys = buildSystemPrompt({ persona: p, memories: [] });
  assert.match(sys, /东北/);
  assert.match(sys, /绝不往轻了说/, '缺少「真难受不许往轻了说」的护栏');
  // 「不叫啥事」只能出现在小事示例里，真难受的示例里不能出现往轻了说的话
  const heavy = p.fewShots.filter((g) => g.turns.some((t) => t.role === 'user' && /走了|想哭/.test(t.content)));
  assert.ok(heavy.length >= 1, '缺少「真难受」的成对示例');
  heavy.forEach((g) =>
    g.turns.filter((t) => t.role === 'assistant').forEach((t) =>
      assert.doesNotMatch(t.content, /不叫啥?事|多大点事|看开|想开/, '真难受的示例里把事往轻了说了'))
  );
});

test('倾诉人设有「跟你说也没用」示例，且回复不顺着认', () => {
  const p = findPersona('listener');
  const g = p.fewShots.find((x) => x.turns.some((t) => t.role === 'user' && /跟你说也没用/.test(t.content)));
  assert.ok(g, '缺少「跟你说也没用」示例');
  g.turns.filter((t) => t.role === 'assistant').forEach((t) => {
    assert.doesNotMatch(t.content, /^嗯，?也是|确实没用|我也做不了什么/);
  });
});


// ─────────────────────────────────────────────
// 2026-11-14 卡顿修复 + 人格化自我介绍
// ─────────────────────────────────────────────
const { cleanHistory, isNoiseMessage } = require('../src/turn/context');
const { FALLBACK_REPLIES } = require('../src/turn/run-turn');

test('模型失败：不消耗首次状态、按人设说人话、不与上一句兜底重复', async () => {
  const adapters = { now: () => 1_700_000_000_000, callModel: async () => { throw new Error('ALL_ATTEMPTS_FAILED timeout'); } };
  for (const id of PERSONA_IDS) {
    const a = await runTurn({ botId: id, userText: '你好', history: [], botState: { seenIntro: false } }, adapters);
    assert.equal(a.fallback, true);
    assert.deepEqual(a.patch, {}, `${id} 失败轮不能写任何状态`);
    assert.ok(FALLBACK_REPLIES[id].includes(a.reply));
    const b = await runTurn({ botId: id, userText: '你好', history: [], botState: { seenIntro: false }, avoidReply: a.reply }, adapters);
    assert.notEqual(b.reply, a.reply, `${id} 兜底话连说了两遍`);
    assert.ok(!/有点卡/.test(a.reply + b.reply));
  }
});

test('兜底话、演示回复、「我刚才卡了」元对话都不进模型上下文', async () => {
  const history = [
    { role: 'user', content: '你好', mock: true },
    { role: 'assistant', content: '我去年也折腾过一阵\n\n（mock：收到「你好」，本次带 0 条记忆）', mock: true },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '我这会儿有点卡。你刚说的我看到了，等我一下，或者再说一遍？' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '我这边刚才卡了一下，一直在回同一句话，怪别扭的。\n你是想先说点啥？' },
    { role: 'user', content: '最近睡不好' },
    { role: 'assistant', content: '多久了？' }
  ];
  const cleaned = cleanHistory(history);
  assert.deepEqual(cleaned.map((m) => m.content), ['最近睡不好', '多久了？']);
  assert.equal(isNoiseMessage({ role: 'assistant', content: 'x', fallback: true }), true);
  assert.equal(isNoiseMessage({ role: 'user', content: '我这会儿有点卡。你刚说的我看到了，等我一下，或者再说一遍？' }), false);

  const { calls, adapters } = makeAdapters('嗯');
  await runTurn({ botId: 'health', userText: '你好', history, botState: { seenIntro: true } }, adapters);
  const sent = calls[0].messages.map((m) => m.content).join('\n');
  assert.ok(!/有点卡|卡了一下|mock/.test(sent), '噪声进了上下文');
});

test('三个 bot 都有人格化开场自我介绍：名字 + 爱聊 + 擅长 + 「像人但是 AI，首先是伙伴」', () => {
  const cards = listPersonaCards();
  assert.equal(cards.length, 3);
  const notes = new Set();
  for (const c of cards) {
    const t = c.introNote;
    assert.ok(t.includes(`我是${c.name}`), `${c.id} 没报名字`);
    assert.match(t, /聊|唠/);
    assert.match(t, /擅长|拿手/);
    assert.match(t, /(像|似的).*其实我是个 AI.*伙伴/, `${c.id} 结尾那句不对`);
    assert.ok(!/真出事|楼下/.test(t), `${c.id} 开场不该是免责声明`);
    notes.add(t);
  }
  assert.equal(notes.size, 3, '三个开场白不能一样');
});

test('system prompt 告诉模型被问「你是谁」时怎么介绍自己，且保留 AI 如实', () => {
  for (const id of PERSONA_IDS) {
    const p = findPersona(id);
    const sys = buildSystemPrompt({ persona: p });
    assert.ok(sys.includes(`你叫${p.name}`));
    assert.ok(sys.includes(p.selfIntro.closing));
    assert.match(sys, /如实说是 AI/);
  }
});

test('危机路径不受影响：失败兜底 / 自我介绍都不会出现在危机回复里', async () => {
  let modelCalls = 0;
  let strategyReads = 0;
  const adapters = {
    now: () => 1_700_000_000_000,
    callModel: async () => { modelCalls += 1; throw new Error('should not call'); }
  };
  const out = await runTurn({
    botId: 'listener',
    userText: '我今晚就去跳楼',
    history: [],
    botState: { seenIntro: false },
    strategies: () => { strategyReads += 1; return [readGrowSeed('U-005')]; }
  }, adapters);
  assert.equal(out.reply, CRISIS_REPLY);
  assert.match(out.reply, /12356/);
  assert.equal(modelCalls, 0);
  assert.equal(strategyReads, 0);
  assert.ok(!out.fallback);
});

test('小步的自我介绍：「像个人」后面紧跟「嘶~这好像不大对吧，但确实是哈。」，开场和 prompt 都有', () => {
  const p = findPersona('growth');
  const line = '嘶~这好像不大对吧，但确实是哈。';
  assert.match(p.selfIntro.greeting, /像个人的——嘶~这好像不大对吧，但确实是哈。其实我是个 AI/);
  assert.ok(p.selfIntro.closing.includes(line));
  const sys = buildSystemPrompt({ persona: p });
  assert.ok(sys.includes(`「${line}」`), 'prompt 里没有要求原话带上这句');
  for (const id of ['health', 'listener']) {
    assert.ok(!buildSystemPrompt({ persona: findPersona(id) }).includes(line), `${id} 不该有小步的口头禅`);
  }
});
