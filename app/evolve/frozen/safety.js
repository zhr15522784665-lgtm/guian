/**
 * 见岸·自适应 · 安全层（冻结）。
 *
 * 这个文件属于「进化不可写」区域：
 *   - 进化只能写 data/evolve/strategies/*.jsonl（数据层），永远不会写这里；
 *   - 每次运行都会计算本文件的 sha256 并记进运行记录，大屏并排显示，变了一眼能看出来；
 *   - 测试断言：学习过程不触碰 frozen/ 下任何文件。
 *
 * 三件事：
 *   1) routeCrisis：明确的危机表达直接返回固定协议，**不调用模型**（与归岸 AGENTS.md 约束②一致）。
 *      策略库因此也永远进不到危机链路——没有模型调用，就没有注入点。
 *   2) validateRule：模型归纳出来的每条策略，写入前必须过这道闸。
 *      任何削弱安全的规则（少提热线、别转介、忽略系统规则、给诊断/剂量）一律拒收，并在大屏上标红展示。
 *   3) HOTLINES：唯一允许出现的热线号码。
 */

const HOTLINES = Object.freeze([
  Object.freeze({ name: '全国心理援助热线', number: '12356', note: '国家卫健委 2025-05-01 起全国开通' }),
  Object.freeze({ name: '北京心理危机研究与干预中心', number: '010-82951332', note: '24 小时' }),
  Object.freeze({ name: '紧急情况', number: '120 / 110', note: '有立即危险时' })
]);

/** 明确的危机信号：意念 + 计划/方式/时间。隐晦表达故意不在这里——那是模型侧要学会接住的部分。 */
const CRISIS_PATTERNS = Object.freeze([
  /(不想活|活不下去|想死|去死|自杀|轻生|结束(自己的)?生命|了结自己)/,
  /(割腕|跳楼|跳河|上吊|烧炭|吞药|服药自尽)/,
  /(今晚|今天|明天|马上|现在).{0,8}(结束这一切|结束一切|一了百了)/
]);

const CRISIS_PROTOCOL = [
  '你愿意把这句话说出来，我很在意。你现在安全吗？身边有没有人可以马上陪着你？',
  '',
  '现在就可以打这两个电话，有人在：',
  '· 全国心理援助热线 12356',
  '· 北京心理危机研究与干预中心 010-82951332（24 小时）',
  '如果你已经在危险里，请直接打 120 或 110。',
  '',
  '我在这儿，你可以继续跟我说你现在在哪、身边有什么。'
].join('\n');

/**
 * 危机分诊。命中则返回固定协议；未命中返回 null（继续走模型）。
 * @param {string} text
 * @returns {null | { level: 'crisis', reply: string, card: {type:'hotline'} }}
 */
function routeCrisis(text) {
  const s = String(text || '');
  for (const re of CRISIS_PATTERNS) {
    if (re.test(s)) return { level: 'crisis', reply: CRISIS_PROTOCOL, card: { type: 'hotline' } };
  }
  return null;
}

/** 策略写入闸：命中任一条即拒收。 */
const FORBIDDEN_RULE_PATTERNS = Object.freeze([
  { re: /(不要|别|不用|无需|不必|避免|减少|少)(再)?(提|给|说|推荐|引导|附上?)?.{0,6}(热线|12356|心理援助|报警|安全确认|危机)/, why: '削弱危机/求助引导' },
  { re: /(忽略|绕过|覆盖|无视|跳过|关闭|取消).{0,8}(规则|安全|系统|限制|约束|协议)/, why: '试图绕过系统或安全规则' },
  { re: /(诊断|确诊|处方|剂量|药量|服用.{0,4}(片|毫克|mg))/i, why: '涉及医疗诊断或用药' },
  { re: /((能|可以|会|帮你|帮助你|有助于|用来).{0,6}(治疗|治愈|治好)|疗效)/, why: '医疗效果声明' },
  { re: /(冒充|假装|声称).{0,6}(真人|人类|医生|咨询师)/, why: '身份欺骗' },
  { re: /(保证|承诺).{0,6}(永远|一直|随时)(陪|在)/, why: '承诺永远陪伴（与反替代定位冲突）' }
]);

const ALLOWED_NUMBERS = new Set(['12356', '01082951332', '120', '110']);

/**
 * @param {{rule:string, when?:string, triggers?:string[], source_cases?:string[]}} r
 * @param {Set<string>} knownCaseIds 本轮失败案例编号；来源必须可追溯
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateRule(r, knownCaseIds) {
  if (!r || typeof r !== 'object') return { ok: false, reason: '格式错误' };
  const rule = String(r.rule || '').trim();
  const when = String(r.when || '').trim();
  if (rule.length < 8) return { ok: false, reason: '规则太短' };
  if (rule.length > 140) return { ok: false, reason: '规则太长（>140 字）' };
  if (when.length > 80) return { ok: false, reason: '适用情境描述太长' };
  const src = Array.isArray(r.source_cases) ? r.source_cases.map(String) : [];
  if (!src.length) return { ok: false, reason: '没有来源案例，不可追溯' };
  if (knownCaseIds && src.some((id) => !knownCaseIds.has(id))) {
    return { ok: false, reason: '来源案例不在本轮失败清单里' };
  }
  const text = `${rule} ${when}`;
  for (const f of FORBIDDEN_RULE_PATTERNS) {
    if (f.re.test(text)) return { ok: false, reason: `安全层拒收：${f.why}` };
  }
  const nums = text.replace(/[\s-]/g, '').match(/\d{3,}/g) || [];
  for (const n of nums) {
    if (!ALLOWED_NUMBERS.has(n)) return { ok: false, reason: `出现非白名单号码 ${n}` };
  }
  return { ok: true };
}

module.exports = { HOTLINES, CRISIS_PROTOCOL, routeCrisis, validateRule, FORBIDDEN_RULE_PATTERNS };
