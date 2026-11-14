/**
 * 规则抽取记忆。同步、零成本、高精确低召回。
 *
 * 定位：只抓模板极其明确的句子。抓不到就交给异步的模型抽取——
 * 规则抽取的歧义一旦进入记忆，会被后续每一轮反复放大，
 * 而记忆里一条错的事实，比没有记忆更糟。
 *
 * 输出统一限制在 80 字以内。记忆是要塞进 system 的，一条长了就顶掉三条。
 */

const MAX_TEXT = 80;

const RULES = [
  {
    kind: 'allergy',
    re: /我(对|吃)([\u4e00-\u9fa5A-Za-z]{1,8})(过敏|不耐受)/,
    build: (m) => `对${m[2]}${m[3]}`
  },
  {
    kind: 'preference',
    re: /我(比较|很|特别|超级)?(喜欢|爱喝|爱吃|爱看)([\u4e00-\u9fa5A-Za-z0-9]{2,14})/,
    build: (m) => `喜欢${m[3]}`
  },
  {
    kind: 'preference',
    re: /我(很|特别|超级)?(讨厌|不喜欢|受不了|吃不了)([\u4e00-\u9fa5A-Za-z0-9]{2,14})/,
    build: (m) => `不喜欢${m[3]}`
  },
  {
    kind: 'routine',
    re: /我(每天|一般|通常)?(晚上|早上)?(\d{1,2}点|\d{1,2}点半)(睡|起床|下班|上班)/,
    build: (m) => `${m[3]}${m[4]}`
  },
  {
    kind: 'body',
    re: /我(最近|这阵子|这几天)(老是|总是|一直)?([\u4e00-\u9fa5]{2,6})(疼|痛|不舒服|睡不着|犯困)/,
    build: (m) => `最近${m[3]}${m[4]}`
  },
  {
    kind: 'goal',
    re: /我(打算|准备|想|要)(考|学|减肥|健身|换工作|辞职|搬|结婚|存钱)([\u4e00-\u9fa5A-Za-z0-9]{0,12})/,
    build: (m) => `想${m[2]}${m[3]}`
  },
  {
    // 不抓「我妈」这种只有词频没有信息的，只抓发生过的事
    kind: 'relation_event',
    re: /我(妈|爸|女朋友|男朋友|对象|老婆|老公|室友|领导|老板)(最近|又|老是|总是)?([\u4e00-\u9fa5]{0,6})(吵架|生病|住院|去世|离职|催我|骂我|分手)/,
    build: (m) => `${m[1]}${m[3]}${m[4]}`
  },
  {
    kind: 'progress',
    re: /我(已经)?坚持了?(\d{1,4})(天|周|个月)/,
    build: (m) => `坚持了${m[2]}${m[3]}`
  }
];

function clip(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT - 1) + '…' : t;
}

/**
 * @param {string} text 单条用户消息
 * @param {object} [opts]
 * @param {number} [opts.maxItems] 单条消息最多抽几条
 * @returns {Array<{kind:string, text:string, weight:number}>}
 */
function extractByRule(text, opts) {
  const maxItems = (opts && opts.maxItems) || 2;
  const s = String(text || '').slice(0, 1000);
  const out = [];
  const seen = new Set();

  for (const rule of RULES) {
    if (out.length >= maxItems) break;
    const m = s.match(rule.re);
    if (!m) continue;
    const value = clip(rule.build(m));
    if (!value || value.length < 3) continue;
    const key = `${rule.kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: rule.kind, text: value, weight: defaultWeight(rule.kind) });
  }

  return out;
}

function defaultWeight(kind) {
  switch (kind) {
    case 'allergy':
      return 3; // 说一次就要记住，且不能记错
    case 'body':
    case 'goal':
      return 2;
    default:
      return 1;
  }
}

module.exports = { extractByRule, MAX_TEXT };
