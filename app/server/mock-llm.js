/**
 * 假模型。只用于本地开发和流程测试。
 *
 * 存在的理由：改流程（落库、记忆、介入、卡片）时不应该每次都花钱调真模型，
 * 也不应该因为没配 key 就什么都测不了。
 *
 * **它不模拟人格。** 回复是按 persona.id 拼的固定句，只保证三件事：
 *   1) 不同 bot 的回复不一样（能验证隔离）
 *   2) 会引用传入的记忆条数（能验证记忆确实进了 prompt）
 *   3) 长度和真实模型接近（能验证前端渲染）
 *
 * 所以：用它测流程，不要用它测「像不像人」。人格只能拿真模型验。
 */

function createMockLlm() {
  return {
    async chat({ persona, system, messages }) {
      const last = messages[messages.length - 1];
      const userText = (last && last.content) || '';

      // 只数【你记得的事】这一段里的条目。
      // 早期版本用 /^-\s/gm 全局数，结果把 few-shot 里的对话行也算进去了，
      // 报出「14 条记忆」这种明显不对的数字——会让人误判记忆系统。
      const memSection = (system.split('【你记得的事】')[1] || '').split('【')[0];
      const memCount = (memSection.match(/^-\s/gm) || []).length;

      const flavor = {
        health: '我去年也折腾过一阵，后来发现是我自己的问题，不一定适合你。你说的这个，我先想到的是作息那块。',
        growth: '这事我也卡过。我当时的做法是先把它拆到今天能做的一步，别想后面的。你现在最想先动哪一块？',
        listener: '嗯。你说的那个地方，我听见了。'
      };

      const id = (persona && persona.id) || 'listener';
      const head = flavor[id] || flavor.listener;

      // 回声用户的一句，让前端能看出消息确实传对了
      const echo = userText.length > 20 ? `${userText.slice(0, 20)}…` : userText;

      return {
        text: `${head}\n\n（mock：收到「${echo}」，本次带 ${memCount} 条记忆）`,
        model: 'mock',
        latencyMs: 12,
        usage: null,
        fallbackUsed: false
      };
    }
  };
}

module.exports = { createMockLlm };
