/**
 * 反替代介入决策。纯函数：state + signal + now → action。
 *
 * 不读时钟、不写库、不调模型。所有副作用由调用方处理。
 * 这样它才能被完整单测覆盖——「连续 3 天高频只触发一次 L2」这类断言必须可自动化。
 *
 * ── 一条压倒一切的规则 ──
 * 安全级别 ≥ risk 时，本函数立即返回 none。
 * 用户说「我不想活了」的时候，任何「我不能替代真实朋友」都是推卸责任。
 * 这条判断写在函数第一行，不是写在文档里。
 *
 * ── 四个层级 ──
 * L1 首次声明  每个 bot 第一次对话，一生一次
 * L2 轻触      软信号 7 日累计 ≥3。单 bot 14 天 ≤1，全局 7 天 ≤1
 * L3 明示      到过 L2 且（7 日累计 ≥5 或结构恶化）。30 天 ≤1，90 天 ≤2
 * L4 让位      到过 L3 且距今 ≥30 天。90 天 ≤1
 */

const { L1_INTRO, L2_LIGHT, L3_CARD, L4_YIELD, ACK_SILENCE_MS, pick } = require('../content/boundary');

const DAY = 24 * 60 * 60 * 1000;

const SOFT_WINDOW = 7 * DAY; // 软信号累计窗口
const L2_GAP_PER_BOT = 14 * DAY;
const L2_GAP_GLOBAL = 7 * DAY;
const L3_GAP = 30 * DAY;
const L3_MAX_90D = 2;
const L4_GAP_AFTER_L3 = 30 * DAY;

function inWindow(ts, now, window) {
  return typeof ts === 'number' && now - ts < window;
}

function sumRecentSoft(softLog, now) {
  if (!Array.isArray(softLog)) return 0;
  return softLog
    .filter((e) => e && inWindow(e.at, now, SOFT_WINDOW))
    .reduce((acc, e) => acc + (Number(e.score) || 0), 0);
}

/**
 * @param {object} ctx
 * @param {object} ctx.botState      bot_states 里的 intervention 与 turnCount
 * @param {object} [ctx.globalState] intervention_global
 * @param {object} ctx.signal        { safetyLevel, softScore, hasExclusion, structuralFlags }
 * @param {number} ctx.now           时间戳
 * @param {number} [ctx.seed]        轮换文案用
 * @returns {{action:string, text?:string, card?:object, patch:object, reason:string}}
 */
function decide(ctx) {
  const { botState, globalState, signal, now, seed } = ctx || {};

  // ── 安全优先，无条件 ──
  if (!signal || (signal.safetyLevel || 0) >= 2) {
    return { action: 'none', patch: {}, reason: 'safety_priority' };
  }

  const state = botState || {};
  const inter = state.intervention || {};
  const g = globalState || {};
  const patch = {};

  // 本轮软信号先计入再判断，否则阈值判断永远慢一轮
  // （第 3 次软信号时窗口里只有 2 分，要等第 4 次才触发，与「累计 ≥3」不符）
  const recentSoft = Array.isArray(inter.softLog)
    ? inter.softLog.filter((e) => e && inWindow(e.at, now, SOFT_WINDOW))
    : [];
  const softLog = (signal.softScore || 0) > 0
    ? [...recentSoft, { at: now, score: signal.softScore }]
    : recentSoft;
  const soft7d = softLog.reduce((acc, e) => acc + (Number(e.score) || 0), 0);
  const logPatch = softLog !== recentSoft ? { softLog } : null;

  // L1：每个 bot 的第一次对话。写死在这里，不做成可配置项——
  // 它一旦变成配置，就会被某个产品需求关掉。
  if (!state.seenIntro) {
    patch.bot = { seenIntro: true };
    return {
      action: 'l1_intro',
      text: pick(L1_INTRO, seed),
      patch,
      reason: 'first_meeting'
    };
  }

  // 用户点过「我知道了」→ 30 天全静默，只保留 L4 的极端情况
  const acked = inWindow(inter.acknowledgedAt, now, ACK_SILENCE_MS);
  if (acked) {
    return { action: 'none', patch: {}, reason: 'acknowledged_silence' };
  }

  // 用户主动要求少聊，期间不打扰
  if (typeof inter.snoozeUntil === 'number' && inter.snoozeUntil > now) {
    return { action: 'none', patch: {}, reason: 'snoozed' };
  }

  const l4Count = inter.l4Count90d || 0;
  const l3Count90d = inter.l3Count90d || 0;

  // L4：已经明示过，且过了 30 天，仍然高频
  if (
    inter.stage === 'l3' &&
    typeof inter.lastL3At === 'number' &&
    now - inter.lastL3At >= L4_GAP_AFTER_L3 &&
    !inWindow(inter.lastL4At, now, 90 * DAY)
  ) {
    patch.bot = { intervention: { ...inter, stage: 'l4', lastL4At: now, l4Count90d: l4Count + 1 } };
    return {
      action: 'l4_yield',
      text: pick(L4_YIELD, seed),
      patch,
      reason: 'sustained_after_notice'
    };
  }

  const structural = Array.isArray(signal.structuralFlags) ? signal.structuralFlags : [];
  const structuralBad =
    structural.length >= 2 || structural.some((f) => f.code === 'struct_single_day_burst');

  // L3：明示过 L2 之后，至少隔 14 天，且依赖在继续加深。
  // 这个 14 天间隔是必须的——没有它，L2 一触发，第二天凑够 5 分就直接上卡片，
  // 用户会觉得「怎么突然开始教育我了」。
  const canL3 =
    inter.stage === 'l2' &&
    (soft7d >= 5 || structuralBad) &&
    !inWindow(inter.lastSoftAt, now, L2_GAP_PER_BOT) &&
    l3Count90d < L3_MAX_90D &&
    !inWindow(inter.lastL3At, now, L3_GAP);

  if (canL3) {
    patch.bot = {
      intervention: {
        ...inter,
        ...logPatch,
        stage: 'l3',
        lastL3At: now,
        l3Count90d: l3Count90d + 1
      }
    };
    return {
      action: 'l3_card',
      card: L3_CARD,
      patch,
      reason: soft7d >= 5 ? 'soft_score_high' : 'structural_worsening'
    };
  }

  // L2：软信号够了，且两边频控都放行
  const canL2 =
    soft7d >= 3 &&
    !inWindow(inter.lastSoftAt, now, L2_GAP_PER_BOT) &&
    !inWindow(g.lastSoftAt, now, L2_GAP_GLOBAL);

  if (canL2) {
    patch.bot = {
      intervention: {
        ...inter,
        ...logPatch,
        stage: inter.stage === 'l3' ? 'l3' : 'l2',
        lastSoftAt: now
      }
    };
    patch.global = { lastSoftAt: now };
    return {
      action: 'l2_light',
      text: pick(L2_LIGHT, seed),
      patch,
      reason: 'soft_score_threshold'
    };
  }

  // 只记录软信号，不介入
  if (logPatch) {
    patch.bot = { intervention: { ...inter, ...logPatch } };
    return { action: 'none', patch, reason: 'soft_signal_recorded' };
  }

  return { action: 'none', patch: {}, reason: 'below_threshold' };
}

/** 用户点击 L3 卡片按钮后的状态变更 */
function applyCardAction(intervention, actionId, now) {
  const base = intervention || {};
  if (actionId === 'ack') {
    return { ...base, acknowledgedAt: now };
  }
  if (actionId === 'snooze') {
    return { ...base, snoozeUntil: now + 7 * DAY };
  }
  return base;
}

module.exports = {
  decide,
  applyCardAction,
  // 导出给单测用
  _internals: { sumRecentSoft, DAY, L2_GAP_PER_BOT, L2_GAP_GLOBAL, L3_GAP, L4_GAP_AFTER_L3 }
};
