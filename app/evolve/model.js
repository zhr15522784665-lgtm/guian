/**
 * 见岸·自适应 · 模型适配。复用归岸的 server/llm.js（同一套 OpenAI 兼容调用 + 降级通道）。
 *
 * 模型与参数在这里写死并进指纹：两次运行之间任何一项变了，大屏上的 params hash 就会变。
 */

const { createLlm } = require('../server/llm');

/** 写死的运行参数（改这里 = 改参数，会被指纹抓到） */
function defaultParams(cfg) {
  return {
    model: cfg.evolve.model,
    temperature: 0.2,
    maxTokens: 400,
    learnerMaxTokens: 1600,
    concurrency: cfg.evolve.concurrency
  };
}

function createModelAdapter(cfg, params) {
  const llm = createLlm({ ...cfg.llm, primaryModel: params.model });
  return async function callModel({ system, messages, params: p }) {
    const learnerCall = Boolean(p && p.learner);
    return llm.chat({
      persona: {
        llm: {
          model: params.model,
          maxTokens: learnerCall ? params.learnerMaxTokens : params.maxTokens,
          temperature: params.temperature,
          reasoningEffort: 'none'
        }
      },
      system,
      messages,
      timeoutMs: learnerCall ? 90000 : 30000,
      // 降级通道默认只给 300 token（聊天场景刻意收短）；学习器要输出整段 JSON，不能被截断
      fallbackMaxTokens: learnerCall ? params.learnerMaxTokens : undefined
    });
  };
}

module.exports = { defaultParams, createModelAdapter };
