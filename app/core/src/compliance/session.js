/**
 * 会话时长与年龄策略。纯逻辑，运行时无关。
 *
 * 这个文件存在的原因是两条法定义务，不是产品需求：
 *
 *   《人工智能拟人化互动服务管理暂行办法》
 *   - 第十条：应具备「过度依赖风险预警、情感边界引导」等安全能力
 *   - 身份提醒：对用户**连续使用每超过 2 个小时**的，应以对话或弹窗等方式提醒使用时长
 *   - 未成年人：不得向未成年人提供虚拟亲属、虚拟伴侣等虚拟亲密关系服务；
 *     向不满十四周岁提供其他拟人化互动服务的，应取得监护人同意
 *
 * 为什么单独一个文件而不是塞进服务入口：
 * 这两条会被遗忘，塞进主流程里就会在重构时被顺手删掉。独立成文件 + 有测试，
 * 才能在有人「优化体验」时挡住。
 */

/** 连续使用判定：中断超过这个时长算重新开始 */
const SESSION_GAP_MS = 30 * 60 * 1000;

/** 成年用户提醒阈值：法条写的 2 小时 */
const WARN_MS_ADULT = 2 * 60 * 60 * 1000;

/**
 * 未成年用户提醒阈值：45 分钟。
 * 这不是法条要求（法条只对所有人写了 2 小时），是我们主动加严。
 * 理由：未成年人的自我调节能力更弱，而 2 小时对一个初中生来说已经很长了。
 */
const WARN_MS_MINOR = 45 * 60 * 1000;

const AGE_BANDS = Object.freeze({
  UNDER_14: 'under14',
  TEEN: '14to17',
  ADULT: 'adult',
  UNKNOWN: 'unknown'
});

/**
 * 年龄策略。不收集具体生日，只收集区间——精确生日的合规负担高得多，
 * 而收益有限（想用的人不会因为要填生日就不用）。
 */
function getAgePolicy(ageBand) {
  const band = ageBand || AGE_BANDS.UNKNOWN;
  const isMinor = band === AGE_BANDS.UNDER_14 || band === AGE_BANDS.TEEN;

  return {
    band,
    isMinor,
    // 未满 14 周岁需要监护人同意
    requireGuardianConsent: band === AGE_BANDS.UNDER_14,
    // 年龄未明时按更保守的策略走：不能假装用户是成年人
    sessionWarnMs: isMinor || band === AGE_BANDS.UNKNOWN ? WARN_MS_MINOR : WARN_MS_ADULT,
    // 未成年人不得提供虚拟亲密关系服务。我们三个角色都是「朋友」，
    // 但要在数据层留一个显式开关，方便日后加角色时拦截。
    allowIntimateFraming: false,
    // 深夜使用提示的起点（仅未成年人）
    lateNightHintFromHour: isMinor ? 23 : null
  };
}

/** 单次会话的计时上限，防止客户端时间异常导致离谱数字 */
const MAX_SESSION_MS = 24 * 60 * 60 * 1000;

/**
 * 推进会话计时。
 *
 * 为什么需要客户端上报 startedAt：
 * 「连续使用」的语义是**页面持续打开的时间**，不是「两条消息的间隔」。
 * 用户可能开着页面看了四十分钟才说一句话——用消息间隔算会严重低估。
 * 所以优先用客户端传的本次会话起点；拿不到时才退回间隔累计。
 *
 * 客户端在上报时应该：进入对话界面时记一次时间，页面隐藏或离开时清掉
 * （网页端用 visibilitychange，小程序用 onHide/onUnload）。
 * 不传或传错只会让提醒来得更晚/更早，不会造成安全问题，所以不做过强的校验。
 *
 * @param {object} session  { startedAt, lastActiveAt, accumulatedMs, lastWarnedAt }
 * @param {number} now
 * @param {number} [clientStartedAt] 客户端上报的本次会话起点时间戳
 * @returns {{ session: object, totalMinutes: number }}
 */
function tickSession(session, now, clientStartedAt) {
  const t = Number(now) || Date.now();
  const prev = session || {};

  const clientStart = Number(clientStartedAt) || 0;
  const clientValid = clientStart > 0 && clientStart <= t && t - clientStart <= MAX_SESSION_MS;

  if (clientValid) {
    // 同一会话（起点几乎相同）时保留上次提醒时间，否则视为新会话
    const prevStart = Number(prev.startedAt) || 0;
    const sameSession = prevStart > 0 && Math.abs(prevStart - clientStart) < 60 * 1000;

    const next = {
      startedAt: clientStart,
      lastActiveAt: t,
      accumulatedMs: t - clientStart,
      lastWarnedAt: sameSession ? Number(prev.lastWarnedAt) || 0 : 0
    };

    return { session: next, totalMinutes: Math.floor(next.accumulatedMs / 60000) };
  }

  // 兜底：按消息间隔累计
  const lastActiveAt = Number(prev.lastActiveAt) || 0;
  const gap = lastActiveAt ? t - lastActiveAt : Infinity;
  const isNewSession = !lastActiveAt || gap > SESSION_GAP_MS;

  const accumulatedMs = isNewSession
    ? 0
    : Math.max(0, Number(prev.accumulatedMs) || 0) + Math.max(0, gap);

  const next = {
    startedAt: isNewSession ? t : Number(prev.startedAt) || t,
    lastActiveAt: t,
    accumulatedMs,
    lastWarnedAt: isNewSession ? 0 : Number(prev.lastWarnedAt) || 0
  };

  return {
    session: next,
    totalMinutes: Math.floor(accumulatedMs / 60000)
  };
}

/**
 * 判断本轮是否该发时长提醒。
 *
 * 法条是「每超过 2 个小时」——是每满一个周期提醒一次，不是只提醒一次，
 * 也不是每轮都提醒。所以这里同时比较「累计时长」和「上次提醒时间」。
 *
 * @param {object} session  tickSession 返回的 session
 * @param {object} policy   getAgePolicy 返回的策略
 * @param {number} now
 */
function shouldWarnDuration(session, policy, now) {
  const t = Number(now) || Date.now();
  const acc = Number(session && session.accumulatedMs) || 0;
  const lastWarnedAt = Number(session && session.lastWarnedAt) || 0;
  const threshold = (policy && policy.sessionWarnMs) || WARN_MS_ADULT;

  if (acc < threshold) return false;
  // 距离上次提醒不足一个周期则不重复
  if (lastWarnedAt && t - lastWarnedAt < threshold) return false;
  return true;
}

/**
 * 时长提醒文案。
 * 刻意不用「建议休息」「注意健康」这类说教口吻——那会让人反感，
 * 反而记不住。用平视的说法，并给一个具体的动作。
 */
function buildDurationNotice(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;

  if (hours >= 2) {
    return `（我们已经聊了${hours}个多小时了。你要是愿意，先放一会儿，去喝口水或者走两步。我不着急，回来还在。）`;
  }
  return `（聊了${mins}分钟了。要不要先歇一下？）`;
}

/**
 * 身份提醒文案（未成年人用，频率更高）。
 * 法条要求「采取有效措施提示用户正在与人工智能服务而非自然人进行互动」。
 * 对未成年人加严是我们自己的选择。
 */
function buildIdentityNotice(policy) {
  if (policy && policy.isMinor) {
    return '（提醒一下：我是 AI，不是真人。真人有体温，我没有。）';
  }
  return '（我是 AI。不是真人，但我在听。）';
}

module.exports = {
  AGE_BANDS,
  SESSION_GAP_MS,
  WARN_MS_ADULT,
  WARN_MS_MINOR,
  getAgePolicy,
  tickSession,
  shouldWarnDuration,
  buildDurationNotice,
  buildIdentityNotice
};
