/**
 * 记忆排序与去重。
 *
 * 排序公式：weight × 新鲜度半衰 × 命中次数加成
 * 半衰 30 天——一个月前提过的事，重要性打对折。这比「按时间倒序」好，
 * 因为「对花生过敏」不该因为过期掉出上下文。
 */

const HALF_LIFE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

function freshness(updatedAt, now) {
  if (typeof updatedAt !== 'number' || !updatedAt) return 0.5;
  const ageDays = Math.max(0, (now - updatedAt) / DAY);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

function scoreOf(m, now) {
  const w = Number(m.weight) || 1;
  const hits = Number(m.hits) || 0;
  return w * (0.6 + freshness(m.updatedAt || m.createdAt, now)) + Math.min(hits, 5) * 0.2;
}

/**
 * @param {Array} memories
 * @param {number} now
 * @param {number} [limit]
 * @returns {Array}
 */
function rankMemories(memories, now, limit) {
  const max = limit || 8;
  const list = Array.isArray(memories) ? memories.filter((m) => m && m.text) : [];

  // 同一个事实被重复抽到多次时，只留一条（保留最高分）
  const byText = new Map();
  list.forEach((m) => {
    const key = `${m.kind || ''}|${String(m.text).trim()}`;
    const prev = byText.get(key);
    if (!prev || scoreOf(m, now) > scoreOf(prev, now)) byText.set(key, m);
  });

  return Array.from(byText.values())
    .map((m) => ({ ...m, _score: scoreOf(m, now) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, max);
}

module.exports = { rankMemories, scoreOf, HALF_LIFE_DAYS };
