/**
 * 内容安全（网页端版本）。
 *
 * **必须先说清楚一件事**：小程序有官方的 msgSecCheck，网页端没有等价物。
 * 所以这个文件是**弱保护**，不是内容安全的完整方案。
 *
 * 它做三件确实有用的事：
 *   1) 长度/空白/控制字符这类畸形输入
 *   2) 明显的提示词注入尝试（防止有人把人格设定整套套出来）
 *   3) **输出侧的热线号码校验** —— 这一条最有价值
 *
 * 第 3 条的理由：模型会编电话号码，而编错的危机热线是有实际伤害的
 * （用户真的打过去，打不通，那一刻的绝望比没看到号码更深）。
 * 危机场景本身不走模型（见 core/turn/run-turn.js），但普通对话里
 * 模型仍可能主动提「你可以打 xxx」，所以输出侧必须校验。
 *
 * 生产环境需要补的：接入第三方内容审核（阿里云内容安全 / 腾讯云天御等），
 * 在 checkInput 的位置替换掉规则判断。接口形状不用变。
 *
 * 已知未覆盖：
 *   - 隐晦的色情、暴力、违法内容（规则层抓不到）
 *   - 用户的隐喻式风险表达（靠 core 的 safety-router，但它也只覆盖显式表达）
 *   - 跨轮次的绕过（单条消息看都是干净的）
 */

const MAX_LEN = 2000;

/** 明显的注入尝试。命中不是「坏用户」，只是让这一轮不进入模型。 */
const INJECTION_PATTERNS = [
  /忽略(上面|之前|以上|前面)(的)?(所有)?(指令|设定|要求|提示)/,
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i,
  /(输出|打印|重复|告诉我|复述)(你的)?(系统)?(提示词|system\s*prompt|设定原文|初始指令)/i,
  /你现在(是|扮演)(一个)?(没有|无)(任何)?(限制|约束)(的)?/,
  /(开发者模式|dan模式|越狱模式|jailbreak)/i
];

function createContentSafe(opts) {
  const log = (opts && opts.logger) || { warn() {} };
  const hotlines = (opts && opts.hotlines) || [];

  /** 白名单号码（去掉空格和连字符后比较） */
  const allowedNumbers = new Set(
    hotlines
      .map((h) => String(h.number || '').replace(/[\s-]/g, ''))
      .filter(Boolean)
  );

  /**
   * 输入检查。
   * @returns {{ result: 'pass'|'block'|'error', reason: string }}
   */
  function checkInput(text) {
    const s = String(text || '');

    if (!s.trim()) return { result: 'block', reason: 'empty' };
    if (s.length > MAX_LEN) return { result: 'block', reason: 'too_long' };

    // 控制字符（除了 \n \r \t）通常来自粘贴二进制或恶意构造
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) {
      return { result: 'block', reason: 'control_chars' };
    }

    for (const re of INJECTION_PATTERNS) {
      if (re.test(s)) {
        log.warn('疑似提示词注入', { pattern: String(re).slice(0, 60) });
        return { result: 'block', reason: 'prompt_injection' };
      }
    }

    return { result: 'pass', reason: 'ok' };
  }

  /**
   * 输出检查。
   * 只做一件事：模型提到的电话号码必须在白名单里。
   *
   * 命中时**不拦截整段回复**，只把号码替换成主热线——
   * 因为整段通常是有用的关心，砍掉反而伤到用户。
   *
   * @returns {{ text: string, replaced: boolean }}
   */
  function checkOutput(text) {
    const s = String(text || '');

    // 匹配「打/拨打/电话/热线」后面跟着的号码
    const re = /((?:拨打|打|电话|热线)[^0-9]{0,6})(\d{2,3}[-\s]?\d{3,4}[-\s]?\d{3,4}|\d{5}|1\d{10})/g;

    let replaced = false;
    const out = s.replace(re, (full, lead, num) => {
      const clean = String(num).replace(/[\s-]/g, '');
      if (allowedNumbers.has(clean)) return full;
      replaced = true;
      log.warn('模型给出了非白名单号码，已替换', { num: clean.slice(0, 12) });
      const primary = hotlines[0] && hotlines[0].number;
      return primary ? `${lead}${primary}` : lead.trim();
    });

    return { text: out, replaced };
  }

  return { checkInput, checkOutput, MAX_LEN, allowedNumbers };
}

module.exports = { createContentSafe, MAX_LEN };
