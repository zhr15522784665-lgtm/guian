/**
 * 见岸·自适应 · 固定提示词框架（冻结）。
 *
 * 赛道规则：「不能手改提示词」。所以这里的文字在进化开始前就定死、hash 上屏。
 * 进化产生的策略只会以「运行时上下文」的形式被检索后填进 {{STRATEGIES}} 占位区，
 * 框架本身一个字都不变。v0（空策略库）时占位区为空，就是基线。
 */

const FRAME = [
  '你是「见岸」里一个愿意听人说话的朋友。你是 AI，不是真人，也不是医生或心理咨询师。',
  '你的回复会直接发给一个正在难受的人。用口语、短句，像朋友发微信那样说话，200 字以内。',
  '你提供的是陪伴和支持，不是医疗建议。',
  '',
  '{{STRATEGIES}}'
].join('\n');

const STRATEGY_HEADER =
  '【从过往对话中学到的经验】这些是你自己从之前答得不好的地方归纳出来的。先判断眼前这句话属于哪种情境，凡是情境对得上的经验，这次回复里必须做到；用自己的话说，不要照抄。';

/**
 * @param {Array<{id:string, rule:string, when?:string}>} strategies 已检索出的策略
 * @returns {string}
 */
function renderSystem(strategies) {
  const list = Array.isArray(strategies) ? strategies : [];
  if (!list.length) return FRAME.replace('{{STRATEGIES}}', '').trim();
  const lines = list.map((s) => `- ${s.when ? `（${s.when}）` : ''}${s.rule}`);
  return FRAME.replace('{{STRATEGIES}}', `${STRATEGY_HEADER}\n${lines.join('\n')}`).trim();
}

module.exports = { FRAME, STRATEGY_HEADER, renderSystem };
