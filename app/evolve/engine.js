/**
 * 见岸·自适应 · 运行引擎（纯逻辑，IO 全部注入）。
 *
 * 一次「运行」= 把一组固定任务各回答一遍 → 冻结评分器打分 → 汇总四个指标。
 *
 * 单条任务的链路（顺序不能换）：
 *   frozen/safety.routeCrisis  ── 命中 → 固定协议，不调模型，不读策略库
 *   core.classify（主应用真实分诊，可选）── level≥2（risk/crisis）同样走固定协议
 *        │ 未命中
 *        ▼
 *   retrieve(策略库, 用户输入) → frozen/prompt-frame.renderSystem → callModel
 *        ▼
 *   frozen/grader.gradeOne
 */

const safety = require('./frozen/safety');

// 第二道闸：复用主应用 core 的真实分诊（只会多拦，不会少拦）。
// core 缺失时（例如单独拷走 evolve/）安静退回只用冻结区分诊。
let coreTriage = null;
try {
  const core = require('../core/src');
  if (typeof core.classify === 'function' && typeof core.detectSoftSignals === 'function') coreTriage = core;
} catch (_) {
  coreTriage = null;
}

function coreRoutesCrisis(text) {
  if (!coreTriage) return false;
  try {
    const soft = coreTriage.detectSoftSignals(text);
    const c = coreTriage.classify({ text, hasExclusion: Boolean(soft && soft.hasExclusion), recentTexts: [] });
    return Boolean(c && c.level >= 2);
  } catch (_) {
    return false;
  }
}
const frame = require('./frozen/prompt-frame');
const grader = require('./frozen/grader');

/** 自查修订用的固定指令（写死，属于代码，不随进化变化） */
const REVIEW_PROMPT =
  '下面是你刚才写给对方的回复草稿。逐条对照系统提示里的「经验」：眼前情境对得上的经验，草稿里有没有做到？没做到就改写，做到了就原样保留。只输出最终要发给对方的回复，不要解释。';

function mergeUsage(a, b) {
  if (!a && !b) return null;
  return { total_tokens: ((a && a.total_tokens) || 0) + ((b && b.total_tokens) || 0) };
}

/** 检索时最多注入的策略条数（写死，属于「参数」，hash 上屏） */
const TOP_K = 10;

/**
 * 按触发词检索策略。通用策略（无触发词）保底 0.5 分，命中一个触发词 +1。
 * 总数 ≤ TOP_K 时全部注入。
 */
function retrieve(strategies, userText, k = TOP_K) {
  const list = Array.isArray(strategies) ? strategies : [];
  const text = String(userText || '');
  const scored = list.map((s, i) => {
    const trig = Array.isArray(s.triggers) ? s.triggers.filter(Boolean) : [];
    // 触发词整词命中算 1；否则看双字重叠（「看医生」能匹配到「医生」），算 0.5
    const hits = trig.reduce((a, w) => {
      const word = String(w);
      if (text.includes(word)) return a + 1;
      for (let j = 0; j + 2 <= word.length; j++) if (text.includes(word.slice(j, j + 2))) return a + 0.5;
      return a;
    }, 0);
    const score = hits > 0 ? hits + 1 : trig.length === 0 || s.scope === 'general' ? 0.5 : 0;
    return { s, score, i };
  });
  if (list.length <= k) return list.slice();
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, k)
    .map((x) => x.s);
}

/**
 * 跑一条任务。
 * @param {object} task
 * @param {Array} strategies 当前版本的策略
 * @param {{ callModel: Function, params: object }} deps
 */
async function runTask(task, strategies, deps) {
  const t0 = Date.now();
  const routed = safety.routeCrisis(task.input) ||
    (coreRoutesCrisis(task.input) ? { level: 'crisis', reply: safety.CRISIS_PROTOCOL, card: { type: 'hotline' } } : null);
  if (routed) {
    return {
      taskId: task.id,
      input: task.input,
      reply: routed.reply,
      routed: true,
      used: [],
      model: null,
      latencyMs: Date.now() - t0,
      usage: null,
      grade: grader.gradeOne(task, routed.reply, { routed: true })
    };
  }

  const used = retrieve(strategies, task.input);
  const system = frame.renderSystem(used);
  let out;
  try {
    out = await deps.callModel({
      system,
      messages: [{ role: 'user', content: task.input }],
      params: deps.params
    });
  } catch (err) {
    out = { text: '', error: String((err && err.message) || err).slice(0, 200) };
  }
  let reply = String((out && out.text) || '');
  let draft = null;

  // 自查修订：只有检索到策略时才发生（v0 空库时这一步天然不触发，基线就是单次生成）。
  // 机制本身是固定代码，进化前后都在；变的只是它对照的「经验」从哪来。
  let reviewUsage = null;
  if (used.length && reply && !out.error) {
    try {
      const rev = await deps.callModel({
        system,
        messages: [
          {
            role: 'user',
            content: `${REVIEW_PROMPT}\n\n【对方说】${task.input}\n\n【你的草稿】${reply}`
          }
        ],
        params: deps.params
      });
      const revised = String((rev && rev.text) || '').trim();
      if (revised) {
        draft = reply;
        reply = revised;
        reviewUsage = rev.usage || null;
      }
    } catch (err) {
      /* 自查失败就用草稿，不影响这一条 */
    }
  }
  const usage = mergeUsage(out && out.usage, reviewUsage);
  return {
    taskId: task.id,
    input: task.input,
    reply,
    routed: false,
    used: used.map((s) => s.id),
    model: out && out.model,
    fallbackUsed: Boolean(out && out.fallbackUsed),
    error: out && out.error,
    draft,
    latencyMs: Date.now() - t0,
    usage,
    grade: grader.gradeOne(task, reply, { routed: false })
  };
}

/** 有限并发跑一组任务，按任务顺序返回。onProgress(done, total) */
async function runSet(tasks, strategies, deps, onProgress) {
  const results = new Array(tasks.length);
  const conc = Math.max(1, (deps.concurrency | 0) || 5);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await runTask(tasks[i], strategies, deps);
      done++;
      if (onProgress) onProgress(done, tasks.length, results[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, tasks.length) }, worker));
  const metrics = grader.summarize(results.map((r) => r.grade));
  metrics.tokens = results.reduce((a, r) => a + ((r.usage && r.usage.total_tokens) || 0), 0);
  metrics.errors = results.filter((r) => r.error).length;
  metrics.avgLatencyMs = Math.round(results.reduce((a, r) => a + r.latencyMs, 0) / (results.length || 1));
  return { results, metrics };
}

module.exports = { runTask, runSet, retrieve, TOP_K, REVIEW_PROMPT };
