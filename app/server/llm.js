/**
 * DeepSeek 调用。OpenAI 兼容协议。
 *
 * 双通道：flash 为主，v4-pro 只在 flash 失败时兜底。
 * 降级不是「换个更好的模型」，是「换个更容忍的通道」——宁可慢一点，
 * 也不要让用户看到一句「服务繁忙」然后关掉。
 *
 * 用 https 而不是 fetch：少一层运行时差异。
 */

const https = require('https');

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 12000,
  // 一轮对话里所有尝试（主模型 ×2 + 兜底 ×2）加起来的上限。超过就交给 runTurn 说人话。
  budgetMs: 40000,
  // 两次尝试之间的等待。重置的连接马上重连大概率还是被重置，稍等一下成功率高得多。
  retryDelaysMs: [400, 1000, 1500],
  primaryModel: 'deepseek-flash',
  fallbackModel: 'deepseek-v4-pro'
};

// 复用连接：本机走代理（DNS 解析到 198.18.x.x 的 fake-ip）时，
// 新建 TLS 握手偶发被重置（ECONNRESET）或很慢；复用已建好的连接能绕开大部分握手。
const agent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 15000 });

/**
 * 「换一次可能就好」的错误：网络抖动、超时、限流、服务端 5xx、空回复。
 * 401/403/400 这类配置错误重试也没用，但仍会尝试一次兜底模型（模型名可能不同）。
 */
function isTransient(err) {
  const m = String((err && (err.code || '')) + ' ' + ((err && err.message) || err));
  if (/HTTP (408|409|425|429|5\d\d)/.test(m)) return true;
  if (/HTTP \d{3}/.test(m)) return false;
  return /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|socket hang up|EMPTY_REPLY|合法 JSON|TLS|disconnected/i.test(m);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requestJson(urlStr, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers
        },
        timeout: timeoutMs
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`响应不是合法 JSON: ${raw.slice(0, 200)}`));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.on('error', reject);
    // 超时之外再加一道总闸：有的代理会让连接卡在半开状态，socket 的 timeout 事件不一定触发
    const hard = setTimeout(() => req.destroy(new Error(`timeout ${timeoutMs}ms`)), timeoutMs + 1000);
    if (hard.unref) hard.unref();
    req.on('close', () => clearTimeout(hard));
    req.write(payload);
    req.end();
  });
}

/**
 * @param {object} opts { apiKey, baseUrl, timeoutMs, primaryModel, fallbackModel }
 */
function createLlm(opts) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  if (!cfg.apiKey) throw new Error('createLlm: 缺少 apiKey（设置环境变量 DEEPSEEK_API_KEY）');
  // 兼容带或不带尾斜杠的 baseUrl（https://api.deepseek.com 或 https://xxx/v1/）
  cfg.baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');

  async function once({ model, system, messages, maxTokens, temperature, reasoningEffort, timeoutMs }) {
    const body = {
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: maxTokens,
      temperature,
      stream: false
    };
    // 'none' 的意思是「不要思考」，此时**不发** reasoning_effort 字段。
    // 2026-11-14 实测（OpenAI 兼容中转 + deepseek-v4-flash）：显式发 reasoning_effort:"none"
    // 反而会触发思考，思考内容吃光 max_tokens，content 返回空串——用户会看到一片空白。
    if (reasoningEffort && reasoningEffort !== 'none') body.reasoning_effort = reasoningEffort;

    const t0 = Date.now();
    const data = await requestJson(
      `${cfg.baseUrl}/chat/completions`,
      body,
      { Authorization: `Bearer ${cfg.apiKey}` },
      timeoutMs || cfg.timeoutMs
    );
    const text =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (!String(text).trim()) {
      // 空回复当作失败，让上层走降级通道，而不是把空白发给用户
      const finish = data.choices && data.choices[0] && data.choices[0].finish_reason;
      throw new Error(`EMPTY_REPLY model=${model} finish=${finish || '?'}`);
    }
    return { text: String(text).trim(), model, latencyMs: Date.now() - t0, usage: data.usage || null };
  }

  return {
    async chat(payload) {
      const { persona } = payload;
      const primary = {
        model: cfg.forcePrimary ? cfg.primaryModel : (persona && persona.llm && persona.llm.model) || cfg.primaryModel,
        maxTokens: (persona && persona.llm && persona.llm.maxTokens) || 400,
        temperature: (persona && persona.llm && persona.llm.temperature) || 0.85,
        reasoningEffort: (persona && persona.llm && persona.llm.reasoningEffort) || 'none'
      };

      // 尝试顺序：主模型 → 主模型重试（仅临时性错误）→ 兜底模型 → 兜底重试（仅临时性错误）。
      // 2026-11-14 用户机器实测：首条消息主模型超时、兜底也超时，用户看到两次「我这会儿有点卡」；
      // 同一台机器紧接着再调一次 1~2 秒就回来了。所以失败一次不该直接放弃。
      const perAttempt = payload.timeoutMs || cfg.timeoutMs;
      const budget = payload.budgetMs || Math.max(cfg.budgetMs, perAttempt * 2 + 4000);
      const deadline = Date.now() + budget;
      const fallback = {
        model: cfg.fallbackModel,
        maxTokens: payload.fallbackMaxTokens || 300,
        temperature: 0.7,
        reasoningEffort: 'none'
      };
      const plan = [
        { ...primary, fb: false, timeout: perAttempt },
        { ...primary, fb: false, timeout: perAttempt, onlyIfTransient: true },
        { ...fallback, fb: true, timeout: perAttempt + 4000 },
        { ...fallback, fb: true, timeout: perAttempt + 4000, onlyIfTransient: true }
      ];
      if (fallback.model === primary.model) plan.splice(2, 2);

      const errors = [];
      let lastErr = null;
      for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        if (step.onlyIfTransient && lastErr && !isTransient(lastErr)) continue;
        const remaining = deadline - Date.now();
        if (i > 0 && remaining < 2500) break;
        if (i > 0) {
          const d = cfg.retryDelaysMs[Math.min(errors.length - 1, cfg.retryDelaysMs.length - 1)] || 0;
          if (d) await sleep(Math.min(d, Math.max(0, remaining - 2000)));
        }
        try {
          const out = await once({
            ...payload,
            model: step.model,
            maxTokens: step.maxTokens,
            temperature: step.temperature,
            reasoningEffort: step.reasoningEffort,
            timeoutMs: Math.max(1500, Math.min(step.timeout, deadline - Date.now()))
          });
          const res = { ...out, fallbackUsed: step.fb, attempts: i + 1 };
          if (errors.length) res.primaryError = errors.join(' | ');
          return res;
        } catch (err) {
          lastErr = err;
          errors.push(`${step.model}: ${String((err && err.message) || err).slice(0, 160)}`);
        }
      }
      const e = new Error(`ALL_ATTEMPTS_FAILED ${errors.join(' | ')}`);
      e.attempts = errors.length;
      throw e;
    }
  };
}

module.exports = { createLlm, DEFAULTS, isTransient };
