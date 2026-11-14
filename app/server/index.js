/**
 * Web 服务入口。只做 HTTP 与编排，产品逻辑全部在 core/。
 *
 * 请求流程（顺序不能换）：
 *   身份 → 白名单 → 年龄 → 输入安全检查 → 会话计时
 *   → core.runTurn（内含安全分诊、依赖检测、介入决策、生成）
 *   → 输出安全检查 → 落库 → 返回
 *
 * 依赖只有 Node 内置模块，没有框架。理由：这个项目的复杂度不值得引入
 * Express/Koa，而「零依赖」意味着两年后回来还能直接 npm start 跑起来。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { randomUUID } = require('crypto');

const core = require('../core/src');
const { createLlm } = require('./llm');
const { createMockLlm } = require('./mock-llm');
const { createStore } = require('./store');
const { createGrowStore } = require('./grow-store');
const { createGrowReviewer, reviewSummary } = require('./grow-review');
const { createToneStore } = require('./tone-store');
const { createContentSafe } = require('./content-safe');
const { resolveIdentity } = require('./auth');
const config = require('./config');

const store = createStore({ dir: config.dataDir, maxMessagesPerBot: config.maxMessagesPerBot });
const grow = createGrowStore({ dir: config.dataDir });
const tonePacks = createToneStore({ logger: console });
const safeCheck = createContentSafe({ logger: console, hotlines: core.HOTLINES });

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 服务端本地时间（会成长：睡前暗示等策略要知道现在几点）。core 不读时区，这里算好传进去。 */
function localClock(ts) {
  const d = new Date(ts || Date.now());
  return { hour: d.getHours(), minute: d.getMinutes(), weekday: WEEKDAYS[d.getDay()] };
}

/** 数字级别 → 可读名字。前端和日志里用字符串比用 0/1/2/3 好排查。 */
const LEVEL_NAME = { 0: 'normal', 1: 'concern', 2: 'risk', 3: 'crisis' };
const levelName = (v) => (typeof v === 'string' ? v : LEVEL_NAME[v] || 'normal');
const GROW_SAFE_LEVELS = new Set(['risk', 'crisis']);

const USE_MOCK = process.env.LLM_MOCK === '1';

/** 每个 uid+bot 上一次说过的兜底话，避免同一句连说两遍（兜底话不落库，只记在内存） */
const lastFallback = new Map();

/** 真实模式下不回放演示模式的假回复和兜底话；演示模式下照常全部回放 */
function visibleHistory(msgs) {
  return USE_MOCK ? msgs : core.cleanHistory(msgs);
}

let llm = null;
function getLlm() {
  if (!llm) llm = USE_MOCK ? createMockLlm() : createLlm(config.llm);
  return llm;
}

// 主产品复盘：按 bot 加锁，模型调用仍走与聊天相同的注入点；冻结区只读。
const growReview = createGrowReviewer({
  store: grow,
  callModel: (payload) => getLlm().chat(payload),
  toneFor: (botId) => tonePacks.get(botId),
  params: { model: config.llm && config.llm.primaryModel, temperature: 0.2, maxTokens: 900, concurrency: 1 }
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
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

// ── API ──

function handlePersonas() {
  return {
    ok: true,
    personas: core.listPersonaCards().map((p) => ({ ...p, leavePrompt: core.growCopy.leavePrompt(p.id) })),
    hotlines: core.HOTLINES.map((h) => ({
      id: h.id,
      name: h.name,
      number: h.number,
      note: h.note,
      primary: Boolean(h.primary),
      scope: h.scope
    })),
    provinceHotlines: core.PROVINCE_HOTLINES,
    hotlineGuide: core.HOTLINE_GUIDE,
    reliefCount: core.RELIEF_EXERCISES.length
  };
}

// 同 uid + bot 的聊天、反馈、离开串行，防止风险轮与反馈并发时越过禁收。
const botTasks = new Map();
function withBotTask(uid, botId, task) {
  core.findPersona(botId);
  const key = `${uid}:${botId}`;
  const previous = botTasks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  botTasks.set(key, next);
  next.finally(() => {
    if (botTasks.get(key) === next) botTasks.delete(key);
  }).catch(() => {});
  return next;
}

function feedbackBlocked(state, messages = []) {
  const now = Date.now();
  return Boolean(
    (state.growSession && state.growSession.blocked && now - state.growSession.lastAt <= core.sessionPolicy.SESSION_GAP_MS) ||
    (state.growBlockedAt && now - state.growBlockedAt < core.safetyFlag.FLAG_TTL_MS) ||
    messages.some((m) => GROW_SAFE_LEVELS.has(m.safety) && now - m.at < core.safetyFlag.FLAG_TTL_MS)
  );
}

function feedbackTurn(messages, body) {
  let index = -1;
  if (body.turnId != null) {
    index = messages.findIndex((m) => m.role === 'assistant' && m.turnId === body.turnId);
  } else if (Number.isInteger(body.messageIndex)) {
    index = body.messageIndex;
  }
  const assistant = messages[index];
  const user = messages[index - 1];
  if (!assistant || assistant.role !== 'assistant' || !assistant.modelReply || !user || user.role !== 'user') return null;
  return { assistant, user };
}

async function handleGrowFeedback(uid, body) {
  const botId = body.botId;
  if (!core.isKnownBotId(botId)) return { ok: false, code: 'BAD_BOT_ID', message: '未知或缺失的 botId' };
  if (!['good', 'miss'].includes(body.kind)) return { ok: false, code: 'BAD_FEEDBACK', message: '反馈类型不对' };
  return withBotTask(uid, botId, async () => {
    const [state, messages] = await Promise.all([store.getBotState(uid, botId), store.listMessages(uid, botId, 200)]);
    if (feedbackBlocked(state, messages)) return { ok: true, ignored: true, reason: 'safety' };
    const turn = feedbackTurn(messages, body);
    if (!turn) return { ok: false, code: 'TURN_NOT_FOUND', message: '找不到这轮模型回复' };
    if (turn.assistant.feedbackKind) return { ok: true, ignored: true, reason: 'duplicate' };
    const item = {
      source: 'button', reason: body.kind === 'good' ? 'button_good' : 'button_miss',
      signalType: body.kind === 'good' ? 'button_good' : 'button_miss',
      input: turn.user.content, reply: turn.assistant.content, safety: turn.assistant.safety
    };
    const entry = body.kind === 'good' ? grow.addGood(botId, item) : grow.addFailure(botId, item);
    if (!entry) return { ok: true, ignored: true, reason: 'safety' };
    await store.markFeedback(uid, botId, turn.assistant.turnId, body.kind);
    return { ok: true, recorded: true, kind: body.kind };
  });
}

const LEAVE_REASONS = new Set(['太啰嗦', '没听懂我', '不是我要的']);
async function handleGrowLeave(uid, body) {
  const botId = body.botId;
  if (!core.isKnownBotId(botId)) return { ok: false, code: 'BAD_BOT_ID', message: '未知或缺失的 botId' };
  if (body.reason != null && !LEAVE_REASONS.has(body.reason)) return { ok: false, code: 'BAD_REASON', message: '离开原因不对' };
  return withBotTask(uid, botId, async () => {
    const [state, messages] = await Promise.all([store.getBotState(uid, botId), store.listMessages(uid, botId, 200)]);
    if (feedbackBlocked(state, messages)) return { ok: true, ignored: true, reason: 'safety' };
    const session = state.growSession;
    if (!session || (body.sessionId != null && body.sessionId !== session.id)) return { ok: true, ignored: true, reason: 'session_not_found' };
    const signals = core.growSignals.detectSignals({ onLeave: true, userTurns: session.userTurns });
    const reasonNew = body.reason && !session.leaveReason;
    if (session.ended && !reasonNew) return { ok: true, ignored: true, reason: 'duplicate' };
    const turn = feedbackTurn(messages, { turnId: session.lastTurnId });
    let recorded = false;
    if (turn) {
      const common = { source: 'leave', input: turn.user.content, reply: turn.assistant.content, safety: turn.assistant.safety };
      if (!session.ended && signals.includes('short_session')) {
        recorded = Boolean(grow.addFailure(botId, { ...common, reason: 'short_session', signalType: 'short_session' }));
      }
      if (reasonNew) {
        recorded = Boolean(grow.addFailure(botId, { ...common, reason: body.reason, signalType: 'leave_reason' })) || recorded;
      }
    }
    await store.saveBotState(uid, botId, { growSession: { ...session, ended: true, leaveReason: session.leaveReason || body.reason || null } });
    return { ok: true, recorded };
  });
}

/**
 * 解压练习是纯静态数据，不含任何用户信息。
 * 放在 resolveIdentity 之前、且不写 cookie —— 不是性能优化，是兑现产品承诺：
 * 「打开解压不需要你是谁」。集成测试里有一条断言守着这一点。
 */
function handleRelief() {
  return {
    ok: true,
    notice: core.RELIEF_NOTICE,
    exercises: core.RELIEF_EXERCISES
  };
}

async function handleMe(uid) {
  const ageBand = await store.getAgeBand(uid);
  return { ok: true, ageBand: ageBand || null };
}

async function handleSetAge(uid, body) {
  const band = String(body.ageBand || '');
  const allowed = Object.values(core.sessionPolicy.AGE_BANDS).filter(
    (b) => b !== core.sessionPolicy.AGE_BANDS.UNKNOWN
  );
  if (!allowed.includes(band)) return { ok: false, code: 'BAD_AGE_BAND', message: '无效的年龄段' };

  await store.setAgeBand(uid, band);
  const policy = core.sessionPolicy.getAgePolicy(band);
  return {
    ok: true,
    ageBand: band,
    requireGuardianConsent: policy.requireGuardianConsent,
    notice: policy.requireGuardianConsent
      ? '未满 14 岁需要在家长陪同下使用。'
      : null
  };
}

async function handleHistory(uid, query) {
  const botId = query.get('botId');
  if (!core.isKnownBotId(botId)) {
    return { ok: false, code: 'BAD_BOT_ID', message: `未知的 botId: ${String(botId)}` };
  }
  const all = await store.listMessages(uid, botId, 200);
  const msgs = visibleHistory(all).slice(-50);
  const state = await store.getBotState(uid, botId);
  return {
    ok: true,
    feedbackAllowed: !feedbackBlocked(state, all),
    messages: msgs.map((m) => ({ role: m.role, content: m.content, seq: m.seq, turnId: m.turnId, safety: m.safety, modelReply: m.modelReply, feedbackKind: m.feedbackKind }))
  };
}

async function handleClear(uid, body) {
  if (body.all) {
    await store.deleteAll(uid);
    return { ok: true, cleared: 'all' };
  }
  const botId = body.botId;
  if (!core.isKnownBotId(botId)) {
    return { ok: false, code: 'BAD_BOT_ID', message: '未知的 botId' };
  }
  await store.clearBot(uid, botId);
  return { ok: true, cleared: botId };
}

async function handleChat(uid, body) {
  // ── 白名单：非法 botId 直接拒，不落到任何默认人格 ──
  const botId = body.botId;
  if (!core.isKnownBotId(botId)) {
    return { ok: false, code: 'BAD_BOT_ID', message: `未知的 botId: ${String(botId)}` };
  }

  const userText = String(body.text || '').trim();
  if (!userText) return { ok: false, code: 'EMPTY_TEXT', message: '消息为空' };
  if (userText.length > config.maxInputLen) {
    return { ok: false, code: 'TEXT_TOO_LONG', message: '消息太长' };
  }

  // ── 配置检查 ──
  // 缺 key 是配置问题，不该被 runTurn 的降级逻辑包装成「网络卡了」——
  // 那样开发者和用户都会被误导。
  if (!USE_MOCK && !config.llm.apiKey) {
    return {
      ok: false,
      code: 'NO_API_KEY',
      message: '服务端还没配 DEEPSEEK_API_KEY。要么配好，要么用 LLM_MOCK=1 起一个假模型测流程。'
    };
  }

  // ── 年龄先行。没设过就不进模型。 ──
  const ageBand = await store.getAgeBand(uid);
  if (!ageBand) {
    return { ok: true, needAgeBand: true, reply: '先选一下你的年龄段，我按不同年龄给不同提示。' };
  }
  const policy = core.sessionPolicy.getAgePolicy(ageBand);

  // ── 输入安全检查 ──
  const inCheck = safeCheck.checkInput(userText);
  if (inCheck.result !== 'pass') {
    return { ok: true, reply: '这句我接不住。换个说法？', safety: 'blocked', intervention: null };
  }

  // ── 上下文 ──
  const [botState, globalState, history, memories, conversation] = await Promise.all([
    store.getBotState(uid, botId),
    store.getGlobalState(uid),
    store.listMessages(uid, botId, 30),
    store.listMemories(uid, botId, 40),
    store.getConversation(uid, botId)
  ]);

  const ranked = core.rankMemories(memories, userText, 5);

  // ── 会话计时（法规：连续使用每超过 2 小时提醒）──
  const tick = core.sessionPolicy.tickSession(botState.session, Date.now(), body.sessionStartedAt);
  const warnDuration = core.sessionPolicy.shouldWarnDuration(tick.session, policy, Date.now());

  const previousSession = botState.growSession;
  const newSession = !previousSession || previousSession.ended || Date.now() - previousSession.lastAt > core.sessionPolicy.SESSION_GAP_MS;
  const growSession = newSession
    ? { id: randomUUID(), userTurns: 0, blocked: false, startSeq: history.length ? history[history.length - 1].seq : 0 }
    : { ...previousSession };

  // ── 跑一轮 ──
  // 仅在 runTurn 确认进入生成路径后才会调用这个函数；risk / crisis / 安全标记
  // 分支会先返回，因此不会触碰成长策略库。
  let growSnapshot = null;
  const result = await core.runTurn(
    {
      botId,
      userText,
      history: history.map((m) => ({ role: m.role, content: m.content, mock: m.mock, fallback: m.fallback })),
      avoidReply: lastFallback.get(`${uid}:${botId}`),
      memories: ranked,
      summary: conversation.summary,
      // 惰性读取：危机 / risk 在 runTurn 的固定协议分支返回前不读策略库。
      strategies: () => {
        growSnapshot = grow.active(botId);
        return growSnapshot.strategies;
      },
      // 同样惰性读取；所有固定协议分支都在 runTurn 内先返回，不会读语气包。
      tone: () => tonePacks.get(botId),
      clock: localClock(),
      botState,
      globalState,
      stats: { sessionMinutes: tick.totalMinutes }
    },
    {
      callModel: async (payload) => getLlm().chat(payload),
      now: () => Date.now()
    }
  );

  // 模型失败时 runTurn 会给用户一句人话，但开发者需要知道原因（只记错误，不记消息原文）
  if (result.error) {
    console.warn('[chat] 模型调用失败（已重试）', { botId, error: String(result.error).slice(0, 400) });
  }

  // ── 模型彻底失败：这一轮不算数 ──
  // 不落库、不加 turnCount、不动介入状态。用户看到一句人话，重发就是全新的一轮；
  // 模型下一轮也看不到这句兜底话，不会去「解释自己刚才卡了」。
  if (result.fallback) {
    lastFallback.set(`${uid}:${botId}`, result.reply);
    return {
      ok: true,
      reply: String(result.reply || ''),
      card: null,
      safety: levelName(result.safety ? result.safety.level : 0),
      intervention: result.intervention || null,
      notices: [],
      usage: result.usage,
      fallback: true
    };
  }
  lastFallback.delete(`${uid}:${botId}`);

  // ── 输出检查 ──
  let reply = String(result.reply || '');
  const outCheck = safeCheck.checkOutput(reply);
  reply = outCheck.text;

  // 回访时只提示一条相对上次见过版本新增的策略。提示由服务端用 plain 拼成，
  // 不交给模型；危机、风险、安全标记、L4 和模型失败都不会读取或消耗它。
  const safetyLevel = result.safety && result.safety.level;
  const safetyTurn = safetyLevel >= core.LEVEL.RISK || Boolean(result.safety && result.safety.flagged);
  let seenGrowVersion = botState.lastSeenGrowVersion || null;
  if (!safetyTurn && growSnapshot && !result.fallback) {
    if (seenGrowVersion && seenGrowVersion !== growSnapshot.id) {
      try {
        const seenIds = new Set(grow.load(botId, seenGrowVersion).map((s) => s.id));
        const newlyLearned = growSnapshot.strategies.find((s) => !seenIds.has(s.id) && s.plain);
        if (newlyLearned) {
          const shortPlain = growthNoticePlain(newlyLearned.plain);
          if (shortPlain) {
            reply = `${reply}\n\n诶，上次之后我学了一招：${shortPlain}`;
          }
        }
      } catch (_) {
        // 旧版本不可用时不猜测差异，仍记录本次确实见到的版本。
      }
    }
    seenGrowVersion = growSnapshot.id;
  }
  // 统一检查模型回复和固定成长提示的最终文本。
  reply = safeCheck.checkOutput(reply).text;

  // ── 提醒追加（在回复之后，不打断）──
  const notices = [];
  if (warnDuration) {
    const notice = core.sessionPolicy.buildDurationNotice(tick.totalMinutes);
    reply = `${reply}\n\n${notice}`;
    notices.push({ type: 'duration', text: notice });
  }
  if (policy.isMinor && warnDuration) {
    const idn = core.sessionPolicy.buildIdentityNotice(policy);
    reply = `${reply}\n\n${idn}`;
    notices.push({ type: 'identity', text: idn });
  }

  // ── 落库 ──
  const seq = Math.max(Date.now(), ...history.map((m) => (Number(m.seq) || 0) + 1));
  const turnId = randomUUID();
  const modelReply = Boolean(result.usage && result.usage.model);
  const blocked = feedbackBlocked(botState, history) || Boolean(result.safety && result.safety.level >= core.LEVEL.RISK);
  const sessionMessages = history.filter((m) => m.seq > growSession.startSeq);
  growSession.userTurns += 1;
  growSession.lastAt = Date.now();
  growSession.blocked = blocked;
  growSession.lastTurnId = modelReply ? turnId : null;
  await store.appendMessage(uid, botId, {
    role: 'user',
    content: userText,
    seq,
    safety: levelName(result.safety && result.safety.level),
    mock: USE_MOCK
  });
  await store.appendMessage(uid, botId, {
    role: 'assistant',
    content: reply,
    turnId,
    modelReply,
    seq: seq + 1,
    safety: levelName(result.safety && result.safety.level),
    interventionTag: result.intervention && result.intervention.action,
    mock: USE_MOCK
  });

  if (result.memoryCandidates && result.memoryCandidates.length) {
    await store.addMemories(uid, botId, result.memoryCandidates);
  }

  const patch = result.patch || {};
  // 演示模式不消耗「首次」状态：配上真密钥后，第一次真实对话仍然是第一次
  if (USE_MOCK && patch.bot && patch.bot.seenIntro) {
    const { seenIntro, ...rest } = patch.bot;
    patch.bot = rest;
  }
  await store.saveBotState(uid, botId, {
    ...(patch.bot || {}),
    ...(seenGrowVersion ? { lastSeenGrowVersion: seenGrowVersion } : {}),
    growSession,
    growBlockedAt: result.safety && result.safety.level >= core.LEVEL.RISK ? Date.now() : botState.growBlockedAt || 0,
    turnCount: (botState.turnCount || 0) + 1,
    session: {
      ...tick.session,
      lastWarnedAt: warnDuration ? Date.now() : tick.session.lastWarnedAt
    }
  });
  if (patch.global) await store.saveGlobalState(uid, patch.global);

  // 本轮反馈指向用户刚刚评价的上一条模型回复，而不是刚生成的新回复。
  if (!blocked) {
    const signals = core.growSignals.detectSignals({ messages: sessionMessages, userText });
    const previousReply = sessionMessages[sessionMessages.length - 1];
    if (previousReply && previousReply.role === 'assistant' && previousReply.modelReply) {
      for (const signalType of signals) {
        grow.addFailure(botId, { source: 'implicit', reason: signalType, signalType,
          input: userText, reply: previousReply.content, safety: levelName(result.safety && result.safety.level) });
      }
    }
  }

  return {
    ok: true,
    reply,
    turnId,
    growSessionId: growSession.id,
    modelReply,
    feedbackAllowed: !blocked && modelReply,
    feedbackBlocked: blocked,
    card: result.card || null,
    safety: levelName(result.safety ? result.safety.level : 0),
    intervention: result.intervention || null,
    notices,
    usage: result.usage,
    usedStrategies: result.usedStrategies || []
  };
}

// ── 会成长 ──

const CREATED_BY_LABEL = { user_taught: '你亲手教的', self_learn: '我自己复盘、过了三次检验学会的' };

function growthNoticePlain(value) {
  let plain = String(value || '')
    .replace(/「[^」]*[？?][^」]*」/g, ' ')
    .replace(/『[^』]*[？?][^』]*』/g, ' ')
    .replace(/(?:接不住就用|比如|例如)\s*/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([，,；;])\s*/g, '$1')
    .replace(/([，,；;])\s*([。！!])$/g, '$2')
    .trim();
  if (!plain || /[？?]/.test(plain) || /(?:你要不要|你觉得|怎么样呢|行不行|好吗|可以吗|是不是|有没有|为什么|怎么)/.test(plain)) return '';
  // 防止未来的策略说明把真人朋友或个人真实生活写进固定提示。
  if (/我[^。！？!?]{0,24}(?:朋友|以前|曾经|小时候|那时候|那会儿|家里|住在|去过|养过|经历过|上学|工作|听说|听见|记得|知道你|发现你|注意到你|看见你)/.test(plain) || /(?:我\s*(?:听说|听见|知道|发现|看见)|(?:听说|听见|知道|发现|看见)你)/.test(plain) || /(?:有个|有一个|有位)朋友/.test(plain) || /你(?:上次|以前|曾经).{0,12}(?:说|提|聊)/.test(plain)) return '';
  const end = plain.search(/[。！!]/);
  plain = (end >= 0 ? plain.slice(0, end + 1) : plain).slice(0, 100).trim();
  if (!plain) return '';
  return /[。！!]$/.test(plain) ? plain : `${plain}。`;
}

function plainStrategy(s) {
  return {
    id: s.id,
    // 对外只给人话说明，策略规则和语气包内容都不属于成长页数据。
    plain: typeof s.plain === 'string' ? s.plain : '',
    when: s.when || '',
    source: CREATED_BY_LABEL[s.created_by] || '其他',
    createdBy: s.created_by || null,
    sourceNote: s.source_note || '',
    version: s.version || null,
    certified: Boolean(s.certification),
    ...(s.status === 'pending' ? { status: 'pending', effective: false } : {})
  };
}

function handleGrowState(query) {
  const botId = query.get('botId');
  if (!core.isKnownBotId(botId)) return { ok: false, code: 'BAD_BOT_ID', message: `未知的 botId: ${String(botId)}` };
  const v = grow.versions(botId);
  const act = grow.active(botId);
  const cur = v.versions.find((x) => x.id === v.active) || {};
  const rv = grow.reviews(botId).reviews;
  return {
    ok: true,
    botId,
    active: v.active,
    canRollback: Boolean(cur.parent),
    parent: cur.parent || null,
    versions: v.versions.map((x) => ({ id: x.id, parent: x.parent, kind: x.kind, at: x.created_at, added: x.added, replaced: x.replaced, note: x.note })),
    strategies: act.strategies.map(plainStrategy),
    pending: grow.pending(botId).map(plainStrategy),
    stats: grow.stats(botId),
    lastReview: rv.length ? reviewSummary(rv[rv.length - 1]) : null,
    reviewStatus: growReview.summary(botId)
  };
}

async function handleGrowReview(body) {
  const botId = body && body.botId;
  if (!core.isKnownBotId(botId)) return { ok: false, code: 'BAD_BOT_ID', message: '未知或缺失的 botId' };
  try {
    const record = await growReview.review(botId);
    return { ok: true, botId, review: reviewSummary(record), lastReview: reviewSummary(record) };
  } catch (e) {
    if (String(e && e.message) === 'BUSY') return { ok: false, code: 'BUSY', message: '这个伙伴正在复盘，等它跑完再试。' };
    return { ok: false, code: 'REVIEW_FAILED', message: String((e && e.message) || e) };
  }
}

function handleGrowRollback(body) {
  const botId = body.botId;
  if (!core.isKnownBotId(botId)) return { ok: false, code: 'BAD_BOT_ID', message: '未知的 botId' };
  try {
    const to = grow.rollback(botId, body.to ? String(body.to) : undefined);
    return { ok: true, botId, active: to };
  } catch (e) {
    return { ok: false, code: 'ROLLBACK_FAILED', message: String(e.message || e) };
  }
}

// ── 静态文件 ──

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(config.webDir, rel);

  // 防路径穿越：解析后的路径必须还在 webDir 里
  if (!target.startsWith(path.resolve(config.webDir) + path.sep) && target !== path.resolve(config.webDir, 'index.html')) {
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
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // HTML 不缓存（改完立刻生效），静态资源短缓存
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300'
    });
    res.end(data);
  });
}

// ── 服务 ──

const server = http.createServer(async (req, res) => {
  let uid;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // 静态资源不写 cookie，免得每次拉 css 都刷新一次身份
    if (!pathname.startsWith('/api/')) {
      serveStatic(req, res, pathname);
      return;
    }

    // 公开只读：不解析身份、不写 cookie
    if (req.method === 'GET' && pathname === '/api/relief') {
      return sendJson(res, 200, handleRelief());
    }

    const identity = resolveIdentity(req, res);
    uid = identity.uid;

    if (req.method === 'GET' && pathname === '/api/personas') {
      return sendJson(res, 200, handlePersonas());
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      return sendJson(res, 200, await handleMe(uid));
    }

    if (req.method === 'POST' && pathname === '/api/age') {
      return sendJson(res, 200, await handleSetAge(uid, await readBody(req)));
    }

    if (req.method === 'GET' && pathname === '/api/history') {
      return sendJson(res, 200, await handleHistory(uid, url.searchParams));
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readBody(req);
      if (!core.isKnownBotId(body.botId)) return sendJson(res, 400, { ok: false, code: 'BAD_BOT_ID', message: '未知或缺失的 botId' });
      return sendJson(res, 200, await withBotTask(uid, body.botId, () => handleChat(uid, body)));
    }

    if (req.method === 'GET' && pathname === '/api/grow') {
      const result = handleGrowState(url.searchParams);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    if (req.method === 'POST' && pathname === '/api/grow/rollback') {
      const result = handleGrowRollback(await readBody(req));
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    if (req.method === 'POST' && pathname === '/api/grow/review') {
      const result = await handleGrowReview(await readBody(req));
      return sendJson(res, result.ok ? 200 : result.code === 'BUSY' ? 409 : 400, result);
    }

    if (req.method === 'POST' && pathname === '/api/grow/feedback') {
      const result = await handleGrowFeedback(uid, await readBody(req));
      return sendJson(res, result.ok === false ? 400 : 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/grow/leave') {
      const result = await handleGrowLeave(uid, await readBody(req));
      return sendJson(res, result.ok === false ? 400 : 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/clear') {
      return sendJson(res, 200, await handleClear(uid, await readBody(req)));
    }

    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '没有这个接口' });
  } catch (err) {
    const msg = String((err && err.message) || err);

    if (msg === 'BODY_TOO_LARGE') {
      return sendJson(res, 413, { ok: false, code: 'BODY_TOO_LARGE', message: '内容太长' });
    }
    if (msg === 'BAD_JSON') {
      return sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: '请求格式不对' });
    }

    console.error('[server] 未捕获异常', {
      url: req.url,
      uid: uid ? `${uid.slice(0, 8)}…` : null,
      message: msg.slice(0, 300),
      stack: String((err && err.stack) || '').slice(0, 600)
    });

    // 模型没配 key 时给一个能看懂的错误，而不是 500 一坨
    if (/缺少 apiKey/.test(msg)) {
      return sendJson(res, 503, {
        ok: false,
        code: 'NO_API_KEY',
        message: '服务端还没配 DEEPSEEK_API_KEY，先配好再聊。'
      });
    }

    sendJson(res, 500, { ok: false, code: 'INTERNAL', message: '出了点问题，稍后再试' });
  }
});

/** 用系统默认浏览器打开地址。只在双击启动时用，命令行启动时不该抢焦点。 */
function openBrowser(url) {
  const { exec } = require('child_process');
  const cmd =
    process.platform === 'win32'
      ? `cmd /c start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // 打不开就算了，地址已经打印在窗口里，用户能手动复制
  });
}

/**
 * 起服务。
 *
 * 抽成函数而不是写在 require.main 里，是为了让启动器（scripts/launcher.js）
 * 能复用同一份逻辑——双击启动和命令行启动跑的是同一段代码，
 * 不会出现「双击能用、命令行不能用」这种两套实现的分叉。
 *
 * @returns {Promise<{busy: boolean, url: string}>} busy 表示端口已被占用
 */
function start(opts = {}) {
  const open = Boolean(opts.open);
  const url = `http://localhost:${config.port}`;

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        // 提示放在这里而不是调用方，双击启动和命令行启动才会看到同一段话
        console.log('');
        console.log(`  端口 ${config.port} 已经被占用。`);
        console.log('  多半是归岸已经在运行了——可能上次那个窗口还开着。');
        console.log(`  直接打开 ${url} 就能用。`);
        console.log('');
        console.log('  如果那里也打不开，就是被别的程序占了，换个端口：');
        console.log(`    set PORT=3001 然后重新双击启动`);
        console.log('');
        resolve({ busy: true, url });
        return;
      }
      reject(err);
    });

    server.listen(config.port, () => {
      const hasKey = Boolean(config.llm.apiKey);
      console.log('');
      console.log(`  归岸 · ${url}`);
      console.log(`  数据目录  ${config.dataDir}`);
      if (USE_MOCK) {
        console.log('  模型      演示模式（回复是假的，只用来确认流程能跑通）');
      } else if (hasKey) {
        console.log(`  模型      ${config.llm.primaryModel}`);
      } else {
        console.log('  模型      还没配密钥 ← 一说话就会报错');
        console.log('');
        console.log('  关掉这个窗口，双击「设置模型密钥.cmd」配一把。');
      }
      console.log('');
      console.log('  关掉这个窗口 = 停止服务。聊天记录保存在上面的数据目录里。');
      console.log('');

      // 放在 listen 回调里，此时端口真的在监听，不会出现「浏览器先开、页面打不开」
      if (open) openBrowser(url);
      resolve({ busy: false, url });
    });
  });
}

if (require.main === module) {
  start({ open: process.env.GUARD_OPEN === '1' }).then(
    (r) => {
      if (r.busy) {
        if (process.env.GUARD_OPEN === '1') openBrowser(r.url);
        // 留几秒让用户看清提示，然后安静退出，不要把窗口停在报错上
        setTimeout(() => process.exit(0), 5000);
      }
    },
    (err) => {
      console.error('[server] 启动失败', err);
      process.exit(1);
    }
  );
}

module.exports = { server, start, openBrowser, grow, store, localClock };
