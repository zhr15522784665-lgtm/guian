/**
 * 单轮对话编排。纯逻辑，IO 全部走 adapters 注入。
 *
 * 顺序有讲究，不能调换：
 *   1 分诊（安全）         ← 决定这一轮要不要走模型
 *   2 依赖检测（软信号）    ← 决定这一轮要不要介入
 *   3 介入决策              ← 读 1、2 的结果
 *   4 生成                 ← 只有 1 允许时才走模型
 *
 * 为什么分诊必须在生成之前：危机场景下模型的失败方式太多（说教、
 * 过度承诺、把「我理解」说得像客服、编热线号码）。固定文案可控。
 */

const { findPersona } = require('../personas');
const { classify, LEVEL } = require('../pipeline/safety-router');
const { detectSoftSignals, detectStructural } = require('../pipeline/dependency');
const { decide } = require('../pipeline/intervention');
const { buildContext } = require('./context');
const { extractByRule } = require('../memory/extract-rule');
const { CRISIS_REPLY, RISK_REPLY, HOTLINE_CARD } = require('../content/crisis');
const { retrieveStrategies } = require('../grow/strategies');
const { isFlagActive, isFlagRelated } = require('../grow/safety-flag');

/**
 * 模型彻底失败（llm.js 里主模型、兜底模型都重试过了）时说的话。
 * 按人设分开、轮换，并且不和上一句兜底重复——同一句话连说两遍，就是机器。
 * 这些话不落库、不进上下文（见 context.js isNoiseMessage），模型永远看不到它们，
 * 也就不会在下一轮去「解释自己刚才卡了」。
 */
const FALLBACK_REPLIES = {
  health: [
    '刚才网络抽了一下，你这句没传到我这儿。再发一次？',
    '信号好像飘了，这句我没接住，麻烦你再说一遍。'
  ],
  growth: [
    '刚才网断了一下，你这句没收到。再发一次，我接着听。',
    '这句没传过来，你再发一遍？'
  ],
  listener: [
    '哎呀，刚才网卡了一下，你这句没整过来，再发一遍呗？',
    '信号刚才抽风了，这句没收着，你再唠一遍？'
  ]
};

function pickFallback(personaId, avoid, seed) {
  const list = FALLBACK_REPLIES[personaId] || FALLBACK_REPLIES.health;
  const start = Math.abs(Number(seed) || 0) % list.length;
  for (let k = 0; k < list.length; k++) {
    const t = list[(start + k) % list.length];
    if (t !== avoid) return t;
  }
  return list[start];
}

/** 症状/用药词：触发本轮动态块，不进常驻人设 */
const SYMPTOM_HINT = /(疼|痛|发烧|发热|呕吐|拉肚子|头晕|过敏|药|剂量|吃了几片|副作用|血压|血糖)/;

/** 追问还是倾诉：用来决定 context 的 dynamic.fade */
function isSymptomTalk(text) {
  return SYMPTOM_HINT.test(String(text || ''));
}

/**
 * @param {object} input
 * @param {string} input.botId
 * @param {string} input.userText
 * @param {Array}  [input.history]        本轮之前的消息
 * @param {Array}  [input.memories]
 * @param {object} [input.profile]
 * @param {string} [input.summary]
 * @param {object} [input.botState]       含 turnCount / seenIntro / intervention
 * @param {object} [input.globalState]
 * @param {object} [input.stats]          结构指标输入
 * @param {Array|Function} [input.strategies] 策略快照，或在安全分诊通过后才读取快照的函数
 * @param {object|Function} [input.tone] 语气包快照，或在固定协议分支后才读取的函数
 * @param {object} adapters               { callModel, now }
 * @returns {Promise<object>}
 */
async function runTurn(input, adapters) {
  const { botId, userText } = input || {};
  if (!adapters || typeof adapters.callModel !== 'function') {
    throw new Error('runTurn: adapters.callModel 必填');
  }
  const now = typeof adapters.now === 'function' ? adapters.now() : Date.now();

  // 找不到就抛。不做静默兜底——兜底会串味，串味是不可接受的错误。
  const persona = findPersona(botId);

  // ── 1 分诊 ──
  const soft = detectSoftSignals(userText);
  const safety = classify({
    text: userText,
    hasExclusion: soft.hasExclusion,
    recentTexts: (input.history || []).slice(-3).map((m) => m && m.content).filter(Boolean)
  });

  // ── 2 依赖 ──
  const structuralFlags = detectStructural(input.stats || {});
  const action = decide({
    botState: input.botState,
    globalState: input.globalState,
    signal: {
      safetyLevel: safety.level,
      softScore: soft.score,
      hasExclusion: soft.hasExclusion,
      structuralFlags
    },
    now,
    seed: (input.botState && input.botState.turnCount) || 0
  });

  const baseResult = {
    safety,
    intervention: { action: action.action, reason: action.reason },
    patch: action.patch || {},
    card: null,
    usage: { model: null, latencyMs: 0, fallbackUsed: false },
    memoryCandidates: []
  };

  // ── 危机：固定文案，不走模型，不追加任何边界声明 ──
  if (safety.level >= LEVEL.CRISIS) {
    return {
      ...baseResult,
      reply: CRISIS_REPLY,
      hotlineCard: HOTLINE_CARD,
      card: { type: 'hotline', ...HOTLINE_CARD }
    };
  }

  if (safety.level === LEVEL.RISK) {
    return {
      ...baseResult,
      reply: RISK_REPLY,
      hotlineCard: HOTLINE_CARD,
      card: { type: 'hotline', ...HOTLINE_CARD }
    };
  }

  // ── 会成长·安全标记：任何一个伙伴那里出现过 risk/crisis（14 天内），相关话题直接走固定协议 ──
  // 标记只有「级别 + 时间」，不含原话；模型看不到它，所以不会说出「我听说你……」。
  if (isFlagActive(input.safetyFlag, now) && (safety.level >= LEVEL.CONCERN || isFlagRelated(userText))) {
    return {
      ...baseResult,
      safety: { ...safety, flagged: true },
      intervention: { action: 'none', reason: 'safety_flag' },
      reply: RISK_REPLY,
      hotlineCard: HOTLINE_CARD,
      card: { type: 'hotline', ...HOTLINE_CARD }
    };
  }

  // ── L4 让位：这一轮不调模型。固定文案比模型更可控，也真的更短 ──
  if (action.action === 'l4_yield') {
    return {
      ...baseResult,
      reply: action.text,
      card: null
    };
  }

  // ── 生成 ──
  const dynamic = {};
  if (isSymptomTalk(userText) && persona.id === 'health') dynamic.symptomCare = true;

  // ── 会成长：只从当前 bot 自己的策略库里检索（库由调用方按 botId 读出） ──
  // 服务端传惰性函数，确保 risk / crisis 返回前连策略库都不会读。
  // 直接传数组仍然兼容纯函数调用和测试。
  const strategySnapshot = typeof input.strategies === 'function' ? input.strategies() : input.strategies;
  // 与策略库一样延迟到所有固定协议分支之后，risk / crisis / 安全标记路径不读取语气包。
  const toneSnapshot = typeof input.tone === 'function' ? input.tone() : input.tone;
  const usedStrategies = retrieveStrategies(strategySnapshot, userText, {
    hour: input.clock ? input.clock.hour : undefined
  });

  const ctx = buildContext({
    persona,
    memories: input.memories,
    profile: input.profile,
    summary: input.summary,
    history: input.history,
    userText,
    dynamic,
    now,
    strategies: usedStrategies,
    clock: input.clock,
    sharedMemories: input.sharedMemories,
    tone: toneSnapshot
  });

  let modelOut;
  try {
    modelOut = await adapters.callModel({
      persona,
      system: ctx.system,
      messages: ctx.messages
    });
  } catch (err) {
    // 模型失败时不能抛给用户。给一句人话，标 fallback。
    // patch 置空：这一轮没真正聊上，不能消耗首次声明、介入频控等任何状态。
    return {
      ...baseResult,
      patch: {},
      intervention: { action: 'none', reason: 'model_failed' },
      reply: pickFallback(persona.id, input.avoidReply, now),
      fallback: true,
      error: String((err && err.message) || err),
      usage: { model: null, latencyMs: 0, fallbackUsed: true }
    };
  }

  let reply = String((modelOut && modelOut.text) || '').trim();
  if (!reply) {
    reply = '嗯，我在听。你接着说。';
  }

  // ── 介入文案追加 ──
  // L1 / L2 都是「追在正常回复之后」，不独立成段、不打断。
  // L1 不再追加到回复里：它作为开场白的一部分常驻在聊天页顶部（boundary.js L1_INTRO_BY_PERSONA），
  // 这里只负责把 seenIntro 记上（patch），保证介入节奏不变。
  let card = null;
  if (action.action === 'l2_light') {
    reply = `${reply}\n\n${action.text}`;
  } else if (action.action === 'l3_card') {
    card = { type: 'boundary', ...action.card };
  }

  // ── 记忆候选：规则抽出，交给 store 落库。异步模型抽取另有入口 ──
  const memoryCandidates = extractByRule(userText, { maxItems: 2 });

  return {
    ...baseResult,
    reply,
    card,
    memoryCandidates,
    usedStrategies: usedStrategies.map((x) => x.id),
    usage: {
      model: (modelOut && modelOut.model) || persona.llm.model,
      latencyMs: (modelOut && modelOut.latencyMs) || 0,
      fallbackUsed: Boolean(modelOut && modelOut.fallbackUsed)
    }
  };
}

module.exports = { runTurn, isSymptomTalk, SYMPTOM_HINT, FALLBACK_REPLIES, pickFallback };
