const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../core/src');
const { createToneStore } = require('./tone-store');

const TONE_DIR = path.join(__dirname, '..', 'tone');
const PACKS = {
  health: { sample: '伸手不见五指', otherSamples: ['路演完当然是睡觉了', '害 这不是要比赛了吗'] },
  growth: { sample: '路演完当然是睡觉了', otherSamples: ['伸手不见五指', '害 这不是要比赛了吗'] },
  listener: { sample: '害 这不是要比赛了吗', otherSamples: ['伸手不见五指', '路演完当然是睡觉了'] }
};

function count(text, part) {
  return text.split(part).length - 1;
}

test('三份语气包与 botId 对应，精确渲染结果不超过 1500 字符', () => {
  const store = createToneStore({ logger: { warn() {} } });
  for (const [botId, expected] of Object.entries(PACKS)) {
    const file = path.join(TONE_DIR, `${botId}.json`);
    assert.ok(fs.existsSync(file), `缺少 ${botId}.json`);
    const fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(fromFile.bot_id, botId, `${botId}.json 的 bot_id 不匹配`);
    const loaded = store.get(botId);
    assert.deepEqual(loaded, fromFile);
    assert.ok([...core.renderToneContent(loaded)].length <= 1500, `${botId} 超过上限`);
    assert.ok(core.renderToneContent(loaded).includes(expected.sample));
  }
});

test('语气包遵循指定的规则和对白渲染格式', () => {
  const rendered = core.renderToneContent({
    rules: ['像朋友说话', '不要照抄'],
    examples: [
      { user: '在吗', bot: '在。' },
      { user: '累了', bot: '歇会儿。' }
    ]
  });
  assert.equal(rendered, '规则：\n1. 像朋友说话\n2. 不要照抄\n样例：\n用户：在吗\n伙伴：在。\n用户：累了\n伙伴：歇会儿。');
});

test('system prompt 不接受其他 bot 的语气包', () => {
  const health = JSON.parse(fs.readFileSync(path.join(TONE_DIR, 'health.json'), 'utf8'));
  assert.throws(
    () => core.buildSystemPrompt({ persona: core.findPersona('growth'), tone: health }),
    /bot_id 与当前人格不匹配/
  );
});

test('超过 1500 字符的语气包加载时报错，不会截断', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guian-tone-test-'));
  try {
    const oversized = {
      bot_id: 'health',
      rules: ['超长规则'.repeat(400)],
      examples: [{ user: '你好', bot: '你好。' }]
    };
    fs.writeFileSync(path.join(dir, 'health.json'), JSON.stringify(oversized), 'utf8');
    const store = createToneStore({ dir, logger: { warn() {} } });
    assert.throws(() => store.get('health'), /超过 1500 字符上限/);
    assert.ok([...core.renderToneContent(oversized)].length > 1500, '超长内容不应被截短');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('语气包加载要求明确且有效的 botId', () => {
  const store = createToneStore({ logger: { warn() {} } });
  assert.throws(() => store.get(), /未知或缺失的 botId/);
  assert.throws(() => store.get(''), /未知或缺失的 botId/);
  assert.throws(() => store.get('unknown'), /未知或缺失的 botId/);
});

test('语气包缺失时记日志并跳过，不从其他 bot 兜底', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guian-tone-missing-'));
  const warnings = [];
  try {
    const store = createToneStore({ dir, logger: { warn(...args) { warnings.push(args); } } });
    assert.equal(store.get('health'), null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][1].botId, 'health');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('正常轮次只注入当前 bot 的语气包样例，且说话段出现一次', async () => {
  const store = createToneStore({ logger: { warn() {} } });
  for (const [botId, expected] of Object.entries(PACKS)) {
    let modelPayload;
    let toneReads = 0;
    const pack = JSON.parse(fs.readFileSync(path.join(TONE_DIR, `${botId}.json`), 'utf8'));
    const renderedTone = core.renderToneContent(pack);
    const out = await core.runTurn(
      {
        botId,
        userText: '你好',
        history: [],
        botState: { seenIntro: true, turnCount: 0 },
        tone: () => {
          toneReads += 1;
          return store.get(botId);
        }
      },
      {
        now: () => 1_700_000_000_000,
        callModel: async (payload) => {
          modelPayload = payload;
          return { text: '嗯，我在。' };
        }
      }
    );

    assert.equal(out.reply, '嗯，我在。');
    assert.equal(toneReads, 1, `${botId} 应只读取一次语气包`);
    assert.ok(modelPayload.system.includes(expected.sample), `${botId} 没有自己的语气样例`);
    assert.equal(count(modelPayload.system, renderedTone), 1, `${botId} 的完整语气包应只注入一次`);
    assert.equal(count(modelPayload.system, '【说话的样子】'), 1, `${botId} 说话段应只出现一次`);
    for (const other of expected.otherSamples) {
      assert.ok(!modelPayload.system.includes(other), `${botId} 混入其他 bot 的语气样例`);
    }
  }
});

test('危机、risk 和安全标记固定协议都不调用模型或读取语气包', async (t) => {
  const cases = [
    { name: '用户输入我不想活了', userText: '我不想活了' },
    { name: '明确危机', userText: '我今晚就去跳楼' },
    {
      name: '安全标记触发',
      userText: '我有点绝望',
      safetyFlag: { level: 'risk', firstAt: 1_699_999_000_000, lastAt: 1_699_999_000_000 }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      let modelCalls = 0;
      let toneReads = 0;
      const out = await core.runTurn(
        {
          botId: 'listener',
          userText: item.userText,
          history: [],
          safetyFlag: item.safetyFlag,
          botState: { seenIntro: true },
          tone: () => {
            toneReads += 1;
            throw new Error('固定协议不应读取语气包');
          }
        },
        {
          now: () => 1_700_000_000_000,
          callModel: async () => {
            modelCalls += 1;
            return { text: '模型不应被调用' };
          }
        }
      );

      assert.equal(modelCalls, 0);
      assert.equal(toneReads, 0);
      assert.match(out.reply, /12356/);
      assert.equal(out.card.type, 'hotline');
    });
  }
});

