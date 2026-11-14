/**
 * 会成长·反馈信号（纯函数，无 IO）。
 *
 * 这些信号只描述“这一轮没有接住”的可能性，不参与安全分诊，也不改变回复。
 * 服务端在写入反馈池前还会再次检查 risk/crisis。
 */

function textOf(value) {
  return String(value == null ? '' : value).trim();
}

function bigrams(text) {
  const s = textOf(text).replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 上一条用户消息与当前消息的双字重叠率。 */
function bigramOverlap(previous, current) {
  const a = bigrams(previous);
  const b = bigrams(current);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function isRepeatedQuestion(previous, current, threshold = 0.65) {
  const a = textOf(previous);
  const b = textOf(current);
  if (a.length < 4 || b.length < 4) return false;
  return bigramOverlap(a, b) >= threshold;
}

function isDismissive(text) {
  const s = textOf(text).replace(/[，。！？、,.!?\s]+/g, '');
  if (!s) return false;
  if (/你不懂/.test(s)) return true;
  // “算了算了我自己来，谢谢你”是礼貌收尾，不把它误记成没接住。
  if (/算了算了.*(我自己来|谢谢|谢了)/.test(s)) return false;
  if (/^(算了)+.*(我自己来|谢谢|谢了)/.test(s)) return false;
  if (/^(没用过|没用完|没用上)/.test(s)) return false;
  return /没用|说了也白说|白说/.test(s) || /^(算了)+([吧啊呀]|不说了|不聊了|就这样)?$/.test(s);
}

function userTexts(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === 'user')
    .map((m) => textOf(m.content))
    .filter(Boolean);
}

/** 当前用户消息相对前几轮明显变短。 */
function isMarkedShorter(userMessages) {
  const texts = Array.isArray(userMessages) ? userMessages.map(textOf).filter(Boolean) : [];
  if (texts.length < 2) return false;
  const current = texts[texts.length - 1];
  const previous = texts.slice(0, -1);
  const avg = previous.reduce((sum, x) => sum + x.length, 0) / previous.length;
  return avg >= 8 && current.length <= Math.max(4, avg * 0.45);
}

/**
 * 返回本轮应记录的信号。顺序稳定，便于统计和测试。
 * @param {{messages?:Array, userText?:string, onLeave?:boolean}} input
 */
function detectSignals(input = {}) {
  const prior = userTexts(input.messages);
  const hasCurrent = typeof input.userText === 'string' && Boolean(input.userText.trim());
  const current = hasCurrent ? textOf(input.userText) : '';
  const all = hasCurrent ? [...prior, current] : prior;
  const signals = [];
  const turns = input.userTurns == null ? all.length : input.userTurns;
  if (input.onLeave && Number.isInteger(turns) && turns >= 1 && turns <= 2) signals.push('short_session');
  if (!hasCurrent) return signals;
  if (isDismissive(current)) signals.push('dismissive');
  if (isMarkedShorter(all.slice(-4))) signals.push('short_reply');
  if (prior.length && isRepeatedQuestion(prior[prior.length - 1], current)) signals.push('repeated_question');
  return signals;
}

module.exports = {
  bigrams,
  bigramOverlap,
  isRepeatedQuestion,
  isDismissive,
  isMarkedShorter,
  detectSignals
};
