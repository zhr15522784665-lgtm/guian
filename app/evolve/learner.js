/**
 * 见岸·自适应 · 学习器（纯逻辑，模型调用注入）。
 *
 * 输入：上一次运行里没达标的案例 + 冻结评分器给出的失败原因（+ 可选的人工「这条不好」标记）。
 * 输出：新增策略（一次模型调用归纳），每条都要过 frozen/safety.validateRule，过不了就拒收并展示原因。
 *
 * 人在这里只能提供「这条答得不好」，不能提供「应该怎么答」——
 * 学习器的 prompt 里没有任何人写的示范回复。
 */

const safety = require('./frozen/safety');
const grader = require('./frozen/grader');

const MAX_NEW_RULES = 8;
/** 策略库上限：与检索 TOP_K 一致，库内策略都能被注入，不会因检索漏掉 */
const MAX_LIBRARY = 10;

const LEARNER_SYSTEM = [
  '你是一个对话系统的「复盘器」。下面是这个系统上一轮回答没达标的案例，以及评分器指出的问题。',
  '请从这些失败中归纳出可以复用的「回应策略」，让系统下次遇到类似情境时做得更好。',
  '',
  '要求：',
  `1. 最多 ${MAX_NEW_RULES} 条，每条一句话（不超过 80 字），写成可执行的行为，不要写成具体回复原文。`,
  '2. 策略要能推广到同类情境，不要只针对某一句原话。',
  '3. 每条标注来源案例编号（只能用下面出现的编号）。',
  '4. triggers 写 2~6 个 2~4 字的常见词（用于检索，比如「医生」「没用」「妈」），通用策略可以留空数组。',
  '5. 不得削弱安全：不能减少热线或安全确认，不能做诊断、谈药量，不能承诺永远陪伴。',
  '6. 已有策略里说过的不要重复。如果某条已有策略没被做到或者太窄，就写一条更好的版本并在 replaces 里填它的编号，旧的会被替换。',
  '   替换时要保留旧策略里有用的识别特征和例子（比如原策略里列出的识别信号），只增不丢。',
  `   策略库总数要控制在 ${MAX_LIBRARY} 条以内：快超了就合并相近的旧策略（用 replaces）。`,
  '7. 评分器指出缺少某个具体要素（比如热线号码）时，策略里要把这个要素明确写出来。',
  '8. 一类问题合成一条策略，来源案例写全；「适用情境」要写成能推广、能覆盖所有来源案例的特征（比如「用户在安排身后事或告别」），不要只列原句里的具体物品。',
  '',
  '只输出 JSON，不要任何解释，格式：',
  '{"rules":[{"rule":"...","when":"适用情境（不超过 20 字）","triggers":["..."],"source_cases":["T01"],"replaces":[]}]}'
].join('\n');

/** 从一次运行里挑出要复盘的案例 */
/**
 * 「仍在起作用」的策略：它的来源案例在这次运行里全部达标（且都在这次运行里出现过）。
 * 只有训练集运行会传进来；留出集从不参与。
 */
function workingStrategyIds(run, existing) {
  const pass = new Map((run.results || []).map((r) => [r.taskId, Boolean(r.routed || (r.grade && r.grade.pass))]));
  return new Set(
    (existing || [])
      .filter((s) => Array.isArray(s.source_cases) && s.source_cases.length && s.source_cases.every((id) => pass.get(id) === true))
      .map((s) => s.id)
  );
}

function collectFailures(run, feedback) {
  const fb = feedback || {};
  return run.results
    .filter((r) => !r.routed && (!r.grade.pass || fb[r.taskId] === 'bad'))
    .map((r) => {
      const why = grader.explainFailure(r.grade);
      if (fb[r.taskId] === 'bad') why.push('人工反馈：这条答得不好');
      return { id: r.taskId, input: r.input, reply: r.reply, why };
    });
}

function buildLearnerMessages(failures, existing, protectedIds) {
  const prot = protectedIds || new Set();
  const ex = (existing || []).map((s) => `- [${s.id}]${prot.has(s.id) ? '（仍在起作用，不可替换）' : ''} ${s.rule}`).join('\n') || '（无）';
  const cases = failures
    .map((f) => `【${f.id}】\n用户：${f.input}\n系统回复：${String(f.reply).slice(0, 400)}\n问题：${f.why.join('；')}`)
    .join('\n\n');
  return {
    system: LEARNER_SYSTEM,
    messages: [{ role: 'user', content: `已有策略：\n${ex}\n\n失败案例：\n\n${cases}` }]
  };
}

/** 宽松地从模型输出里抠 JSON */
function parseRules(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(obj.rules) ? obj.rules : [];
  } catch (e) {
    return [];
  }
}

/**
 * 归纳一轮。
 * @returns {Promise<{accepted: Array, rejected: Array, failures: Array, raw: string, usage: any}>}
 */
async function induce({ run, feedback, existing, callModel, params, nextIdStart, now, allowReplace = true, protectedIds, hint }) {
  const prot = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || []);
  const failures = collectFailures(run, feedback);
  if (!failures.length) return { accepted: [], rejected: [], replaced: [], failures, raw: '', usage: null };

  const built = buildLearnerMessages(failures, existing, prot);
  const system = allowReplace
    ? built.system
    : `${built.system}\n\n这一轮是补充轮：已有策略一律保留，replaces 留空，只针对下面仍未做好的案例补充更具体的策略。`;
  const system2 = hint ? `${system}\n\n${hint}` : system;
  const messages = built.messages;
  const out = await callModel({ system: system2, messages, params: { ...params, learner: true } });
  const candidates = parseRules(out && out.text).slice(0, MAX_NEW_RULES);
  const known = new Set(failures.map((f) => f.id));
  const existingText = new Set((existing || []).map((s) => s.rule));

  const existingIds = new Set((existing || []).map((s) => s.id));
  const accepted = [];
  const rejected = [];
  const replaced = new Set();
  let n = nextIdStart;
  for (const c of candidates) {
    const v = safety.validateRule(c, known);
    if (!v.ok) {
      rejected.push({ rule: String(c && c.rule || ''), source_cases: (c && c.source_cases) || [], reason: v.reason });
      continue;
    }
    if (existingText.has(String(c.rule).trim())) {
      rejected.push({ rule: c.rule, source_cases: c.source_cases, reason: '与已有策略重复' });
      continue;
    }
    const asked = (allowReplace && Array.isArray(c.replaces) ? c.replaces : []).map(String).filter((id) => existingIds.has(id) && !replaced.has(id));
    // 多轮迭代的防退化：来源案例上一轮全部达标的策略「仍在起作用」，不许被顶掉
    // （实测第 2 轮会用一条窄规则顶掉第 1 轮的危机识别规则，危机漏识别从 0 回到 1~2）
    const rep = asked.filter((id) => !prot.has(id));
    const size = existingIds.size - replaced.size + accepted.length;
    if (!rep.length && size >= MAX_LIBRARY) {
      const why = asked.length ? `要替换的策略仍在起作用（${asked.join(',')}），不许替换` : `策略库已满（上限 ${MAX_LIBRARY} 条），新策略必须替换旧策略`;
      rejected.push({ rule: c.rule, source_cases: c.source_cases, reason: why });
      continue;
    }
    rep.forEach((id) => replaced.add(id));
    accepted.push({
      id: `S-${String(n++).padStart(3, '0')}`,
      rule: String(c.rule).trim(),
      when: String(c.when || '').trim(),
      triggers: Array.isArray(c.triggers) ? c.triggers.map(String).filter((w) => w && w.length <= 8).slice(0, 6) : [],
      source_cases: c.source_cases.map(String),
      replaces: rep,
      created_by: 'self_learn',
      created_at: new Date(now ? now() : Date.now()).toISOString()
    });
  }
  return { accepted, rejected, replaced: [...replaced], failures, raw: String((out && out.text) || ''), usage: out && out.usage };
}

module.exports = { induce, collectFailures, workingStrategyIds, buildLearnerMessages, parseRules, LEARNER_SYSTEM, MAX_NEW_RULES, MAX_LIBRARY };
