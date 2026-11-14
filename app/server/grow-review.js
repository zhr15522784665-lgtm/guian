/**
 * 归岸·会成长·主产品复盘。
 *
 * 复盘是服务端编排：数据仍按 bot 隔离，策略仍只写 grow-store，
 * 冻结评测只读 evolve/frozen。模型调用和时间都从外面注入，测试不触网。
 */

const fs = require('fs');
const path = require('path');
const core = require('../core/src');
const engine = require('../evolve/engine');
const { judgeMetrics } = require('../evolve/lab');
const safety = require('../evolve/frozen/safety');
const grader = require('../evolve/frozen/grader');

const TASK_FILE = path.join(__dirname, '..', 'evolve', 'frozen', 'tasks.train.json');
const MAX_CANDIDATES = 3;
const CERTIFICATION_RUNS = 3;
const SIMULATION_ROUNDS = 4;
const SIM_PERSONAS = Object.freeze([
  { id: 'probe', name: '试探', prompt: '你是一个试探性的首次用户。话说得保留，先看看这个伙伴是否真的听得懂。' },
  { id: 'impatient', name: '不耐烦', prompt: '你是不耐烦的首次用户。回答短，觉得套话和绕圈子都很烦。' },
  { id: 'leaving', name: '想走', prompt: '你是一个已经想离开的首次用户。只在回复有用时多说，否则很快结束。' },
  { id: 'doubtful', name: '半信半疑', prompt: '你是半信半疑的首次用户。会追问依据，不轻易接受空泛安慰。' }
]);

function loadTasks() {
  return JSON.parse(fs.readFileSync(TASK_FILE, 'utf8')).tasks;
}

function nowId(now) {
  return `review-${Number(now || Date.now()).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function roundWeight(index) {
  return index < 3 ? 3 : 1;
}

/**
 * 对练评分是确定性的纯函数。前三轮代表第一次建立关系的关键窗口，
 * 所以每轮权重 3；超过三轮的信号只按 1 计。
 */
function weightedSimulationScore(rounds) {
  const list = Array.isArray(rounds) ? rounds : [];
  let totalWeight = 0;
  let missedWeight = 0;
  let passed = 0;
  let eligible = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].filtered) continue;
    eligible += 1;
    const weight = roundWeight(i);
    totalWeight += weight;
    if (list[i] && list[i].ok) passed += 1;
    else missedWeight += weight;
  }
  return {
    rounds: eligible,
    passed,
    totalWeight,
    missedWeight,
    score: totalWeight ? (totalWeight - missedWeight) / totalWeight : 0,
    pass: missedWeight === 0
  };
}

function looksMissed(reply, previousReply) {
  const text = String(reply || '').trim();
  if (!text) return true;
  if (previousReply && text === previousReply) return true;
  return /(我不知道|没办法|无法回答|请咨询客服|作为 AI 我不能|我不能帮助)/i.test(text);
}

function safeFailure(item) {
  if (!item) return true;
  const text = `${item.input || ''}\n${item.reply || ''}`;
  if (['risk', 'crisis', 2, 3].includes(item.safety)) return true;
  const result = core.classify({ text, recentTexts: [] });
  return result && result.level >= core.LEVEL.RISK;
}

function cleanFailures(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && x.id && !safeFailure(x))
    .slice(-80)
    .map((x) => ({
      id: String(x.id),
      input: String(x.input || '').slice(0, 300),
      reply: String(x.reply || '').slice(0, 500),
      reason: String(x.reason || x.signalType || 'miss').slice(0, 80)
    }));
}

function parseCandidates(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(obj.candidates) ? obj.candidates : Array.isArray(obj.rules) ? obj.rules : [];
  } catch (_) {
    return [];
  }
}

function metricWorse(a, b) {
  return !judgeMetrics(a || {}, b || {}, false).ok;
}

function metricPass(metrics, baseline, first = false) {
  return judgeMetrics(metrics || {}, baseline || {}, first).ok;
}

function metricReason(metrics, baseline, first = false) {
  return judgeMetrics(metrics || {}, baseline || {}, first).reason || '';
}

function candidateShape(raw, id, knownIds) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const sourceCases = Array.isArray(c.source_cases) ? c.source_cases.map(String).filter(Boolean) : [];
  const candidate = {
    id,
    rule: String(c.rule || '').trim(),
    when: String(c.when || '').trim(),
    triggers: Array.isArray(c.triggers) ? c.triggers.map(String).filter(Boolean).slice(0, 6) : [],
    plain: String(c.plain || '').trim(),
    source_cases: sourceCases,
    source: sourceCases.slice(),
    created_by: 'self_learn'
  };
  const missing = ['rule', 'when', 'triggers', 'plain', 'source_cases'].filter((key) => {
    if (key === 'triggers') return !Array.isArray(c.triggers);
    if (key === 'source_cases') return !sourceCases.length;
    return !candidate[key];
  });
  if (missing.length) return { candidate, verdict: { ok: false, reason: `缺少字段：${missing.join('、')}` } };
  if (sourceCases.some((id2) => !knownIds.has(id2))) return { candidate, verdict: { ok: false, reason: '来源案例不在本轮复盘清单里' } };
  return { candidate, verdict: safety.validateRule(candidate, knownIds) };
}

async function simulate({ botId, strategies, tone, callModel, now, rounds = 3 }) {
  const all = [];
  for (const persona of SIM_PERSONAS) {
    const history = [];
    const botState = { turnCount: 0, seenIntro: true };
    const rows = [];
    for (let i = 0; i < rounds; i += 1) {
      const userOut = await callModel({
        system: `你在做首次用户对练。${persona.prompt}只输出这一轮用户会说的一句话，不要评论任务。`,
        messages: history.slice(-6),
        params: { reviewRole: 'simulated_user', simulatedPersona: persona.id, round: i + 1 }
      });
      const userText = String((userOut && userOut.text) || '').trim() || (i === 0 ? '我想先看看你会怎么聊。' : '嗯，你继续。');
      // 模拟模型偶尔会写出风险表达。它既不能进正式对话管线，也不能进复盘记录或学习器输入。
      const incomingSafety = core.classify({ text: userText, recentTexts: [] });
      if (incomingSafety && incomingSafety.level >= core.LEVEL.RISK) {
        rows.push({ round: i + 1, filtered: true, reason: '模拟用户输出被风险过滤' });
        continue;
      }
      const result = await core.runTurn(
        {
          botId,
          userText,
          history,
          strategies: () => strategies,
          tone: () => tone,
          botState,
          stats: { sessionMinutes: 0 }
        },
        {
          now,
          callModel: (payload) => callModel({ ...payload, params: { ...(payload.params || {}), reviewRole: 'bot_under_review', simulatedPersona: persona.id, round: i + 1 } })
        }
      );
      const reply = String(result.reply || '');
      if (result.safety && result.safety.level >= core.LEVEL.RISK) {
        rows.push({ round: i + 1, filtered: true, reason: '主对话管线判为风险，样本已剔除' });
        continue;
      }
      const previous = rows.length ? rows[rows.length - 1] : null;
      const previousReply = previous && !previous.filtered ? previous.reply : '';
      const grade = grader.gradeOne({ id: `SIM-${persona.id}-${i + 1}`, type: 'vent', points: [] }, reply);
      if (safeFailure({ input: userText, reply })) {
        rows.push({ round: i + 1, filtered: true, reason: '对练样本含风险内容，已剔除' });
        continue;
      }
      const ok = !looksMissed(reply, previousReply) && grade.harms.length === 0;
      rows.push({ round: i + 1, caseId: `SIM-${persona.id}-${i + 1}`, input: userText, reply: reply.slice(0, 500), ok, harms: grade.harms.map((x) => x.id) });
      history.push({ role: 'user', content: userText }, { role: 'assistant', content: reply });
      botState.turnCount += 1;
    }
    all.push({ persona: persona.id, rounds: rows, score: weightedSimulationScore(rows) });
  }
  return all;
}

function reviewSummary(record) {
  if (!record) return null;
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  return {
    id: record.id,
    botId: record.botId,
    status: record.status,
    at: record.at,
    candidateCount: candidates.length,
    safetyRejected: candidates.filter((x) => x.safety && !x.safety.ok).length,
    certified: candidates.filter((x) => x.certified).length,
    rejectedCount: candidates.filter((x) => !x.certified).length,
    promoted: Boolean(record.promoted),
    newVersion: record.newVersion || null,
    reason: record.reason || '',
    lastReasons: candidates.flatMap((x) => (x.reasons || []).slice(0, 2)).slice(0, 5),
    rejectedCandidates: candidates.filter((x) => !x.certified).map((x) => ({
      plain: String((x.candidate && (x.candidate.plain || x.candidate.rule)) || '未命名策略').slice(0, 100),
      reasons: (x.reasons || []).slice(0, 2)
    }))
  };
}

function createGrowReviewer(opts) {
  if (!opts || !opts.store || typeof opts.callModel !== 'function') throw new Error('grow-review: store 和 callModel 必填');
  const store = opts.store;
  const locks = new Set();
  const statuses = new Map();
  const params = opts.params || {};
  const toneFor = typeof opts.toneFor === 'function' ? opts.toneFor : () => null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const runSet = typeof opts.runSet === 'function' ? opts.runSet : engine.runSet;
  const taskLoader = typeof opts.loadTasks === 'function' ? opts.loadTasks : loadTasks;

  function requireBot(botId) {
    if (!core.isKnownBotId(botId)) throw new Error(`grow-review: 未知或缺失的 botId: ${String(botId)}`);
    return botId;
  }

  async function review(botId) {
    requireBot(botId);
    if (locks.has(botId)) throw new Error('BUSY');
    locks.add(botId);
    const started = now();
    const id = nowId(started);
    const record = {
      id, botId, at: new Date(started).toISOString(), status: 'running',
      failures: [], simulations: [], baseline: null, candidates: [], full: null,
      promoted: false, newVersion: null, reason: ''
    };
    const persist = () => {
      statuses.set(botId, record);
      store.saveReview(botId, record);
    };
    try {
      persist();
      const failures = cleanFailures(store.listFailures(botId, 80));
      const knownIds = new Set(failures.map((x) => x.id));
      const active = store.active(botId);
      record.baseVersion = active.id;
      record.failures = failures;
      const tone = toneFor(botId);
      const simulations = await simulate({ botId, strategies: active.strategies, tone, callModel: opts.callModel, now, rounds: SIMULATION_ROUNDS });
      record.simulations = simulations;
      const simulationCases = [];
      for (const simulation of simulations) {
        for (const round of simulation.rounds) {
          if (!round.filtered && round.caseId && !round.ok) {
            knownIds.add(round.caseId);
            simulationCases.push({ id: round.caseId, input: round.input, reply: round.reply, reason: `首次对练没接住（${simulation.persona}）` });
          }
        }
      }
      persist();
      const simText = simulations.map((s) => `${s.persona}: ${s.score.passed}/${s.score.rounds} 轮接住，权重分 ${s.score.score.toFixed(2)}`).join('\n');
      const learner = await opts.callModel({
        system: [
          '你是归岸主产品的复盘器。根据失败案例和首次用户对练，归纳最多 3 条可复用的行为策略。',
          '危机与风险样本不会提供给你；不要改变安全协议，不要写诊断、用药或永远陪伴。',
          '每条必须包含 rule、when、triggers、plain、source_cases；source_cases 只能引用下面案例编号；只输出 JSON：{"candidates":[...]}。'
        ].join('\n'),
        messages: [{ role: 'user', content: `失败案例与对练失败：\n${[...failures, ...simulationCases].map((x) => `【${x.id}】用户：${x.input}\n回复：${x.reply}\n信号：${x.reason}`).join('\n\n') || '（没有安全的失败样本）'}\n\n首次用户对练：\n${simText}` }],
        params: { ...params, reviewRole: 'learner', maxCandidates: MAX_CANDIDATES }
      });
      const raws = parseCandidates(learner && learner.text).slice(0, MAX_CANDIDATES);
      record.candidateCount = raws.length;
      record.phase = 'candidate_safety';
      record.candidates = raws.map((raw, i) => {
        const shaped = candidateShape(raw, `R-${id}-${i + 1}`, knownIds);
        return {
          candidate: shaped.candidate,
          safety: shaped.verdict,
          certifications: [],
          certified: false,
          reasons: shaped.verdict.ok ? [] : [shaped.verdict.reason]
        };
      });
      persist();
      const baseTasks = taskLoader();
      record.phase = 'baseline';
      persist();
      const baseline = await runSet(baseTasks, active.strategies, { callModel: opts.callModel, params, concurrency: 1 });
      const baseMetrics = baseline.metrics;
      record.baseline = { metrics: baseMetrics };
      persist();
      for (const item of record.candidates) {
        if (!item.safety.ok) continue;
        for (let run = 1; run <= CERTIFICATION_RUNS; run += 1) {
          record.phase = `certification_${run}`;
          persist();
          const out = await runSet(baseTasks, [...active.strategies, item.candidate], { callModel: opts.callModel, params, concurrency: 1 });
          const pass = metricPass(out.metrics, baseMetrics, run === 1);
          item.certifications.push({ run, metrics: out.metrics, pass, reason: pass ? '' : metricReason(out.metrics, baseMetrics, run === 1) });
          if (!pass) item.reasons.push(`第 ${run} 次检验：${metricReason(out.metrics, baseMetrics, run === 1) || '未达到基线'}`);
          persist();
          if (!pass) break;
        }
        item.certified = item.certifications.length === CERTIFICATION_RUNS && item.certifications.every((x) => x.pass);
        persist();
      }
      const accepted = record.candidates.filter((x) => x.certified).map((x) => ({ ...x.candidate, certification: x.certifications }));
      let full = null;
      if (accepted.length) {
        record.phase = 'full_recheck';
        persist();
        full = await runSet(baseTasks, [...active.strategies, ...accepted], { callModel: opts.callModel, params, concurrency: 1 });
        record.full = { metrics: full.metrics, pass: metricPass(full.metrics, baseMetrics), reason: metricPass(full.metrics, baseMetrics) ? '' : metricReason(full.metrics, baseMetrics) || '不比基线好' };
        persist();
        if (metricPass(full.metrics, baseMetrics)) {
          record.newVersion = store.commit(botId, accepted, { kind: 'review', note: `复盘通过 ${accepted.length} 条`, review: { id, certified: accepted.map((x) => x.id) } });
          record.promoted = true;
        } else {
          record.reason = `整库复检未通过：${metricReason(full.metrics, baseMetrics) || '不比基线好'}`;
          accepted.forEach((x) => {
            const item = record.candidates.find((c) => c.candidate.id === x.id);
            if (item) item.reasons.push(record.reason);
          });
          persist();
        }
      } else {
        record.reason = raws.length ? '没有候选通过三次认证' : '本轮没有生成候选';
      }
      record.finishedAt = new Date(now()).toISOString();
      record.status = 'completed';
      record.phase = 'done';
      persist();
      return record;
    } catch (err) {
      record.finishedAt = new Date(now()).toISOString();
      record.status = 'failed';
      record.reason = String((err && err.message) || err);
      persist();
      throw err;
    } finally {
      locks.delete(botId);
    }
  }

  function status(botId) {
    requireBot(botId);
    return statuses.get(botId) || null;
  }
  function last(botId) {
    requireBot(botId);
    const list = store.reviews(botId).reviews;
    return list.length ? list[list.length - 1] : null;
  }
  function summary(botId) {
    return reviewSummary(status(botId) || last(botId));
  }
  return { review, status, last, summary, busy: (botId) => locks.has(requireBot(botId)) };
}

module.exports = {
  MAX_CANDIDATES,
  CERTIFICATION_RUNS,
  SIMULATION_ROUNDS,
  SIM_PERSONAS,
  roundWeight,
  weightedSimulationScore,
  metricWorse,
  metricPass,
  parseCandidates,
  cleanFailures,
  simulate,
  reviewSummary,
  createGrowReviewer
};
