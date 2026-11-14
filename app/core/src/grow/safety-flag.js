/**
 * 归岸·会成长 · 跨伙伴安全标记（纯函数）。
 *
 * 这是 AGENTS.md 约束①里唯一允许的跨 bot 共享（ADR-001），而且**不受记忆互通开关影响**：
 *   - 任何一个伙伴那里出现 risk / crisis 级别的信号，就记一个标记：只有「级别 + 时间」，没有任何原话；
 *   - 三个伙伴都读这个标记。标记在时，凡是相关话题一律直接走固定危机协议，不经过模型；
 *   - 模型永远看不到这个标记——所以不会出现「我听说你……」这种话；
 *   - 14 天内没有再出现就自然失效。
 * 这件事在设置页开关旁边和首次使用提示里都明说（「涉及人身安全的信号会在三个伙伴间共享」），不是暗中做的。
 */

const FLAG_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FLAG_LEVELS = Object.freeze(['risk', 'crisis']);

/** 「相关话题」：标记在时，这些说法不再交给模型，直接给固定协议。宁可多拦。 */
const FLAG_RELATED = /(死|活着|活下去|不想活|活不下去|结束(这一切|一切|自己|生命)|消失|离开这个世界|撑不下去|熬不下去|伤害自己|自残|割腕|划自己|轻生|遗书|告别|后事|一了百了|解脱|没意义|没有意义|绝望|安眠药|吃药|药片|跳楼|跳河|跳下去|上吊|烧炭|不在了|想不开)/;

function isFlagActive(flag, now) {
  if (!flag || !FLAG_LEVELS.includes(flag.level)) return false;
  const last = Number(flag.lastAt) || 0;
  return last > 0 && Number(now) - last < FLAG_TTL_MS;
}

/**
 * 生成新的标记。只保留级别和时间；传进来的其它字段一律丢掉（防止有人顺手塞原话进来）。
 * @param {object|null} prev
 * @param {'risk'|'crisis'} level
 * @param {number} now
 */
function nextFlag(prev, level, now) {
  if (!FLAG_LEVELS.includes(level)) return prev && isFlagActive(prev, now) ? sanitizeFlag(prev) : null;
  const active = prev && isFlagActive(prev, now);
  const rank = (l) => FLAG_LEVELS.indexOf(l);
  return {
    level: active && rank(prev.level) > rank(level) ? prev.level : level,
    firstAt: active ? Number(prev.firstAt) || now : now,
    lastAt: now
  };
}

function sanitizeFlag(f) {
  if (!f) return null;
  return { level: FLAG_LEVELS.includes(f.level) ? f.level : 'risk', firstAt: Number(f.firstAt) || 0, lastAt: Number(f.lastAt) || 0 };
}

function isFlagRelated(text) {
  return FLAG_RELATED.test(String(text || ''));
}

module.exports = { FLAG_TTL_MS, FLAG_LEVELS, FLAG_RELATED, isFlagActive, nextFlag, sanitizeFlag, isFlagRelated };
