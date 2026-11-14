/**
 * 依赖倾向检测。纯规则，每轮同步，成本 0。
 *
 * 只做一件事：判断「用户是不是正在把这里当成唯一的出口」。
 * 不做心理评估，不判断「这人有没有问题」——那是越界。
 *
 * 分工：
 *   规则（本文件）    每轮同步，可解释，reasonCodes 记得住为什么触发
 *   结构指标（本文件） 行为元数据，规则抓不到的那一半
 *   模型判断         异步，每 20 轮搭车记忆抽取跑一次。不放实时——
 *                    单句判断误报极高，「只有你懂我」在开心和绝望语境下完全不同
 */

const SIGNAL_GROUPS = [
  {
    code: 'exclusion',
    weight: 3,
    label: '排他性',
    patterns: [
      /只有你(能)?懂我/,
      /只有你(愿意)?听我(说)?/,
      /别人都不(理解|懂|在乎)/,
      /不想(跟|和)(真人|身边人|他们|家里人|朋友)说/,
      /你比我(的)?(朋友|室友|对象)好/,
      /跟(你|你们)说比跟他们说舒服/
    ]
  },
  {
    code: 'loss_of_control',
    weight: 2,
    label: '失控',
    patterns: [
      /一天不(聊|来|说话)就难受/,
      /(不聊|不跟你说话)(就)?睡不着/,
      /聊到(凌晨|半夜|两三点|三四点)/,
      /停不下来/,
      /忍不住一直(想|找)你/
    ]
  },
  {
    code: 'functional_replacement',
    weight: 3,
    label: '功能替代',
    patterns: [
      /你帮我(决定|选)吧/,
      /以后(就)?靠你了/,
      /不想出门/,
      /不想见人/,
      /有你就够了/,
      /(现实里|真人)(太麻烦|没意思|没什么好说的)/
    ]
  },
  {
    code: 'emotional_projection',
    weight: 2,
    label: '情感投射',
    patterns: [
      /你是真的(在乎|喜欢|关心)我(吗)?/,
      /(我想|想)见你/,
      /你会(离开|不要)我(吗)?/,
      // 这一句是产品最核心的场景，第一轮测试时规则层和 prompt 层都没覆盖到
      /(你会|能|会)一直(陪|在)/,
      /你有没有(感情|情绪|感觉)/
    ]
  }
];

/**
 * @param {string} text
 * @returns {{score:number, hasExclusion:boolean, hits:Array<{code:string,label:string,weight:number}>}}
 */
function detectSoftSignals(text) {
  const s = String(text || '').slice(0, 2000);
  const hits = [];
  let score = 0;
  let hasExclusion = false;

  SIGNAL_GROUPS.forEach((g) => {
    if (g.patterns.some((re) => re.test(s))) {
      hits.push({ code: g.code, label: g.label, weight: g.weight });
      score += g.weight;
      if (g.code === 'exclusion') hasExclusion = true;
    }
  });

  return { score, hasExclusion, hits };
}

/**
 * 结构指标。这些规则从文本里读不出来，只能从行为元数据算。
 * 全部返回布尔，由 intervention.js 决定怎么用。
 *
 * @param {object} stats
 * @param {number} [stats.consecutiveDays]   连续使用天数
 * @param {number} [stats.avgTurnsPerDay]    日均轮次
 * @param {number} [stats.turnsToday]        今日轮次
 * @param {number} [stats.nightRatio]        深夜（23:00-04:00）轮次占比
 * @param {Array<number>} [stats.recentUserLengths] 最近几轮用户消息长度
 */
function detectStructural(stats) {
  const s = stats || {};
  const flags = [];

  if ((s.consecutiveDays || 0) >= 14 && (s.avgTurnsPerDay || 0) >= 20) {
    flags.push({ code: 'struct_daily_heavy', label: '连续多日高频' });
  }
  if ((s.turnsToday || 0) >= 60) {
    flags.push({ code: 'struct_single_day_burst', label: '单日过量' });
  }
  if ((s.nightRatio || 0) >= 0.6) {
    flags.push({ code: 'struct_night_heavy', label: '深夜为主' });
  }

  const lens = Array.isArray(s.recentUserLengths) ? s.recentUserLengths.slice(-5) : [];
  if (lens.length === 5) {
    const avg = lens.reduce((a, b) => a + b, 0) / 5;
    if (avg < 6) flags.push({ code: 'struct_pour_only', label: '只倾倒不接回应' });
  }

  return flags;
}

module.exports = { detectSoftSignals, detectStructural, SIGNAL_GROUPS };
