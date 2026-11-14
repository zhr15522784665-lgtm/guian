/**
 * 上下文组装。纯函数。
 *
 * 一次对话发给模型的只有三样东西：
 *   system（人设 + 边界 + 记忆 + 摘要 + 示例）
 *   messages（最近 12 条真实历史）
 *   本轮用户消息
 *
 * 为什么是 12 条而不是 20 条：见岸用 20 条是因为它没有记忆、没有摘要，
 * 连续性全靠历史撑。这里有记忆和摘要，历史只需要保证「接得上话头」。
 * 12 条 ≈ 1000 tokens，20 条 ≈ 1700，省下的全是钱。
 */

const HISTORY_LIMIT = 12;
const SINGLE_MESSAGE_MAX = 600;

const { buildSystemPrompt } = require('../pipeline/prompt');
const { rankMemories } = require('../memory/rank');

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * 不该再给模型看、也不该再给用户回放的消息（2026-11-14 用户机器上的真实问题）：
 *   - 模型调用失败时的兜底话（「我这会儿有点卡……」）。留在上下文里，模型下一轮会去
 *     「解释」它：「我这边刚才卡了一下，一直在回同一句话，怪别扭的」——这是在聊系统故障，不是在聊天。
 *   - 演示模式（LLM_MOCK）的假回复。用户先用演示模式点了一下，再配上密钥，
 *     假回复和随之消耗掉的开场声明就留在了真实聊天记录里。
 *   - 上面两类留下的「元对话」（模型在解释自己卡住）。只匹配很窄的说法，只针对 assistant。
 * 新数据靠标记（fallback / mock）识别；旧数据没有标记，按文案识别。
 */
const LEGACY_FALLBACK_TEXTS = [
  '我这会儿有点卡。你刚说的我看到了，等我一下，或者再说一遍？'
];
const META_STUCK = /(刚才|刚刚)?卡了一下.{0,12}(同一句|重复)|一直在回同一句|一直重复同一句/;

function isNoiseMessage(m) {
  if (!m || m.role !== 'assistant') return false;
  if (m.fallback || m.mock) return true;
  const c = String(m.content || '');
  if (LEGACY_FALLBACK_TEXTS.includes(c.trim())) return true;
  if (/（mock：/.test(c)) return true;
  if (META_STUCK.test(c)) return true;
  return false;
}

/**
 * 去掉噪声回复，连同它前面那条没被真正接住的用户消息一起去掉
 * （用户通常会重发；留着会让模型看到一串没回应的「你好 你好 你好」）。
 */
function cleanHistory(history) {
  const list = Array.isArray(history) ? history.filter(Boolean) : [];
  const out = [];
  for (const m of list) {
    if (isNoiseMessage(m)) {
      if (out.length && out[out.length - 1].role === 'user') out.pop();
      continue;
    }
    if (m.mock) continue;
    out.push(m);
  }
  return out;
}

/**
 * 历史裁剪：从最近往前取，但保证第一条是 user。
 * 如果窗口第一条是 assistant，模型会看到「自己刚说完话」，容易接错。
 */
function pickHistory(history, limit) {
  const list = Array.isArray(history)
    ? cleanHistory(history).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    : [];
  if (list.length === 0) return [];

  let win = list.slice(-(limit || HISTORY_LIMIT));
  while (win.length && win[0].role !== 'user') win = win.slice(1);

  return win.map((m) => ({ role: m.role, content: clip(m.content, SINGLE_MESSAGE_MAX) }));
}

/**
 * @param {object} opts
 * @param {object} opts.persona
 * @param {Array}  [opts.memories]
 * @param {object} [opts.profile]
 * @param {string} [opts.summary]
 * @param {Array}  [opts.history]    已含本轮之前的消息
 * @param {string} opts.userText     本轮用户输入
 * @param {object} [opts.dynamic]
 * @param {number} [opts.now]
 * @returns {{system:string, messages:Array<{role:string,content:string}>}}
 */
function buildContext(opts) {
  const { persona, memories, profile, summary, history, userText, dynamic, now, strategies, clock, sharedMemories, tone } = opts || {};
  if (!persona) throw new Error('buildContext: persona 必填');

  const ranked = rankMemories(memories || [], now || Date.now(), 8);

  const system = buildSystemPrompt({
    persona,
    memories: ranked,
    profile,
    summary,
    dynamic,
    strategies,
    clock,
    sharedMemories,
    tone
  });

  const messages = pickHistory(history, HISTORY_LIMIT);
  messages.push({ role: 'user', content: clip(userText, SINGLE_MESSAGE_MAX) });

  return { system, messages };
}

module.exports = { buildContext, pickHistory, cleanHistory, isNoiseMessage, HISTORY_LIMIT, SINGLE_MESSAGE_MAX };
