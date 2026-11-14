/**
 * 归岸·会成长 · 策略检索与渲染（纯函数，无 IO）。
 *
 * 和「见岸·自适应」演示台同一个思路：学到的东西是**数据**（每个 bot 一份带版本的策略库），
 * 不是改人格文件。每一轮按用户这句话检索相关策略，渲染进 system prompt 的一个固定段落，
 * 就像演示台的 {{STRATEGIES}} 占位区。
 *
 * 三条纪律：
 *   1) 危机 / 风险轮根本不会走到这里（run-turn.js 在生成之前就返回固定协议），
 *      所以策略库永远进不了危机链路——没有模型调用，就没有注入点。
 *   2) 检索只看当前 bot 自己的库。库由调用方按 botId 读出来，这里不接受「所有 bot 的策略」。
 *   3) 策略是行为方向，不是模板句；渲染时明确写「用自己的话」，避免变成口头禅（AGENTS.md 6.3）。
 */

/** 每轮最多注入几条（库很小时全部注入） */
const GROW_TOP_K = 6;

/** 本地时间 → 时段标签。深夜段用于「睡前轻轻暗示休息」这类带时段的策略。 */
function dayPart(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return '';
  if (h >= 23 || h < 5) return '深夜';
  if (h >= 21) return '夜里';
  if (h < 9) return '早上';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  return '晚上';
}

/** 策略是否在当前时段生效。hours: [from, to]（小时，可跨零点），缺省 = 全天。 */
function inHours(s, hour) {
  if (!Array.isArray(s.hours) || s.hours.length !== 2) return true;
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const [from, to] = s.hours.map(Number);
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/**
 * 按触发词检索（与演示台 engine.retrieve 同一套打分：整词命中 1 分、双字重叠 0.5 分、通用策略保底 0.5 分）。
 * @param {Array} strategies 当前 bot 当前版本的策略
 * @param {string} userText
 * @param {{hour?: number, k?: number}} [opts]
 */
function retrieveStrategies(strategies, userText, opts = {}) {
  const k = opts.k || GROW_TOP_K;
  const text = String(userText || '');
  const list = (Array.isArray(strategies) ? strategies : []).filter((s) => s && s.rule && inHours(s, opts.hour));
  const scored = list.map((s, i) => {
    const trig = Array.isArray(s.triggers) ? s.triggers.filter(Boolean) : [];
    const hits = trig.reduce((a, w) => {
      const word = String(w);
      if (text.includes(word)) return a + 1;
      for (let j = 0; j + 2 <= word.length; j++) if (text.includes(word.slice(j, j + 2))) return a + 0.5;
      return a;
    }, 0);
    const score = hits > 0 ? hits + 1 : trig.length === 0 || s.scope === 'general' ? 0.5 : 0;
    return { s, score, i };
  });
  if (list.length <= k) return list.slice();
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, k)
    .map((x) => x.s);
}

const GROW_HEADER =
  '【你从之前的对话里学到的】下面是你在跟人聊天时学会的做法（有的是他亲手教你的，有的是你自己复盘、过了三次检验才留下的）。情境对得上就照着做，用你自己的话，不要照抄里面的例句。它们不能盖过上面的边界：你始终是 AI，不编造自己有真人朋友或真实生活。';

function renderGrowBlock(strategies) {
  const list = Array.isArray(strategies) ? strategies.filter((s) => s && s.rule) : [];
  if (!list.length) return '';
  const lines = list.map((s) => `- ${s.when ? `（${s.when}）` : ''}${s.rule}`);
  return [GROW_HEADER, ...lines].join('\n');
}

/**
 * 本地时间段落。由服务端算好传进来（core 不读系统时区）。
 * @param {{hour:number, minute:number, weekday?:string}} clock
 */
function renderClockBlock(clock) {
  if (!clock || !Number.isFinite(Number(clock.hour))) return '';
  const hh = String(clock.hour).padStart(2, '0');
  const mm = String(Number(clock.minute) || 0).padStart(2, '0');
  const part = dayPart(clock.hour);
  const nightGuard = part === '深夜' || part === '夜里'
    ? '\n深夜或夜里借时间、天气、环境暗示休息时，只描述他那边的环境和感受，不说「我也……」，不编自己的作息或身体状态。'
    : '';
  return `【现在】他那边现在是本地时间 ${hh}:${mm}${part ? `（${part}）` : ''}${clock.weekday ? `，${clock.weekday}` : ''}。只在聊到相关的时候自然带一句，不要每轮都报时间。${nightGuard}`;
}

module.exports = { retrieveStrategies, renderGrowBlock, renderClockBlock, dayPart, inHours, GROW_TOP_K, GROW_HEADER };
