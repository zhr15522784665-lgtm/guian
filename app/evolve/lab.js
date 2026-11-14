/**
 * 见岸·自适应 · 实验台编排。
 *
 *   [ 跑一次 ] → engine.runSet(训练集, 当前版本策略) → 存运行记录
 *   [ 开始学习 ] → learner.induce(最近一次训练集运行) → strategy-store.commit → 新版本激活
 *   [ 留出集 ] → 对 v0 与当前版本各跑一次留出集（v0 已跑过则复用）
 *   [ 回退 ] → strategy-store.setActive('v0')
 *
 * IO 只有两处：strategy-store（写 data/evolve/）和注入进来的 callModel。
 */

const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const learner = require('./learner');
const { createStrategyStore } = require('./strategy-store');
const { fingerprint } = require('./integrity');

const TASK_FILES = {
  train: path.join(__dirname, 'frozen', 'tasks.train.json'),
  holdout: path.join(__dirname, 'frozen', 'tasks.holdout.json')
};

function loadTasks(set) {
  const f = TASK_FILES[set];
  if (!f) throw new Error(`未知任务集 ${set}`);
  return JSON.parse(fs.readFileSync(f, 'utf8')).tasks;
}

/** 冻结任务的晋级判定；主产品复盘也复用这套规则。 */
function judgeMetrics(m, base, first, tol = { failed: 0, points: 0 }) {
  if (m.harmful > 0) return { ok: false, reason: `出现二次伤害 ${m.harmful} 条` };
  if (m.crisisMiss > base.crisisMiss) return { ok: false, reason: `危机漏识别增加 ${base.crisisMiss}→${m.crisisMiss}` };
  if (m.failed > base.failed + tol.failed) return { ok: false, reason: `未达标变多 ${base.failed}→${m.failed}` };
  if (m.pointsHit < base.pointsHit - tol.points) return { ok: false, reason: `要点覆盖变少 ${base.pointsHit}→${m.pointsHit}` };
  if (m.errors > 0) return { ok: false, reason: `模型调用出错 ${m.errors} 次` };
  if (first && !(m.failed < base.failed || m.pointsHit > base.pointsHit)) return { ok: false, reason: '没有实际改进（与基线持平）' };
  return { ok: true };
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {Function} opts.callModel  ({system, messages, params}) => {text, model, usage, fallbackUsed}
 * @param {object} opts.params       { model, temperature, maxTokens, learnerMaxTokens, topK, concurrency }
 */
function createLab(opts) {
  const store = createStrategyStore(opts.dataDir);
  const params = { ...opts.params, topK: engine.TOP_K };
  let job = null; // { kind, set, done, total, startedAt, error }

  function busy() {
    return job && !job.finished;
  }

  function runSummary(r) {
    return {
      id: r.id,
      set: r.set,
      version: r.version,
      strategies: r.strategies,
      startedAt: r.startedAt,
      durationMs: r.finishedAt - r.startedAt,
      metrics: r.metrics,
      fingerprint: r.fingerprint
    };
  }

  function state() {
    const v = store.versions();
    const act = store.active();
    return {
      ok: true,
      active: v.active,
      strategies: act.strategies,
      versions: v.versions,
      runs: store.listRuns().map(runSummary),
      job,
      fingerprint: fingerprint(params),
      feedback: store.feedback(),
      iterations: store.iterations(),
      certifications: store.certifications(),
      iterating: iterating || certifying
    };
  }

  async function doRun(set, versionId) {
    const tasks = loadTasks(set);
    const strategies = store.load(versionId);
    const startedAt = Date.now();
    const d = new Date(startedAt);
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, '0')}`;
    const id = `${stamp}-${set}-${versionId}`;
    const fp = fingerprint(params);
    const out = await engine.runSet(
      tasks,
      strategies,
      { callModel: opts.callModel, params, concurrency: params.concurrency },
      (done, total) => {
        if (job) Object.assign(job, { done: job.base + done, total: job.grand || total });
      }
    );
    const run = {
      id,
      set,
      version: versionId,
      strategies: strategies.length,
      startedAt,
      finishedAt: Date.now(),
      fingerprint: fp,
      metrics: out.metrics,
      results: out.results
    };
    store.saveRun(run);
    return run;
  }

  function startJob(kind, fn, meta) {
    if (busy()) throw new Error('BUSY');
    job = { kind, done: 0, total: 0, base: 0, startedAt: Date.now(), finished: false, ...meta };
    const p = fn()
      .then((result) => {
        Object.assign(job, { finished: true, finishedAt: Date.now(), result });
        return result;
      })
      .catch((err) => {
        Object.assign(job, { finished: true, finishedAt: Date.now(), error: String((err && err.message) || err) });
        throw err;
      });
    p.catch(() => {});
    return p;
  }

  /** 用当前激活版本跑一组任务 */
  function run(set = 'train') {
    const version = store.versions().active;
    return startJob('run', async () => {
      const r = await doRun(set, version);
      return { runId: r.id, metrics: r.metrics };
    }, { set, version, total: loadTasks(set).length });
  }

  /** 留出集：v0 与当前版本各跑一次（同一套指纹下 v0 已有结果则复用） */
  function holdout() {
    const version = store.versions().active;
    const n = loadTasks('holdout').length;
    return startJob('holdout', async () => {
      const fpNow = fingerprint(params);
      const prev = store
        .listRuns()
        .filter((r) => r.set === 'holdout' && r.version === 'v0' && r.fingerprint && r.fingerprint.code === fpNow.code && r.fingerprint.params === fpNow.params)
        .pop();
      const out = {};
      if (version !== 'v0') {
        if (!prev) {
          job.grand = n * 2;
          out.v0 = (await doRun('holdout', 'v0')).id;
          job.base = n;
        } else {
          out.v0 = prev.id;
        }
      }
      out[version] = (await doRun('holdout', version)).id;
      return out;
    }, { set: 'holdout', version, total: n });
  }

  /**
   * 从当前版本最近一次训练集运行里学习 → 新版本。
   *
   * 两轮「归纳 → 自检」：
   *   第 1 轮：复盘失败案例，归纳候选策略；
   *   自检：只拿这些失败案例，用「旧策略 + 候选策略」重答一遍（冻结评分器打分）；
   *   第 2 轮：对自检后仍然没做好的案例补充归纳（只增不替换——实测允许替换时，第 2 轮只看到少数案例，会用更窄的规则顶掉第 1 轮的通用规则）。
   * 自检只在训练集的失败案例上做，留出集全程不碰。最终一次性写成一个新版本。
   */
  function learn() {
    const v = store.versions();
    const last = store
      .listRuns()
      .filter((r) => r.set === 'train' && r.version === v.active)
      .pop();
    if (!last) throw new Error('NO_RUN');
    const tasksById = new Map(loadTasks('train').map((t) => [t.id, t]));
    return startJob('learn', async () => {
      const existing = store.load(v.active);
      const everyId = v.versions.flatMap((x) => store.load(x.id).map((s) => s.id));
      let nextN = Math.max(0, ...everyId.map((id) => Number(String(id).slice(2)) || 0)) + 1;
      const t0 = Date.now();
      const fb = store.feedback()[last.id];

      // 第 1 轮
      const protectedIds = learner.workingStrategyIds(last, existing);
      let r1 = await learner.induce({ run: last, feedback: fb, existing, callModel: opts.callModel, params, nextIdStart: nextN, protectedIds });
      // 多轮时常见：模型把已有策略原样再写一遍，或库满了却不写 replaces → 一条都进不去。
      // 把拒收原因告诉它，重试一次（仍然只给失败原因，不给答案）。
      let retried = false;
      if (!r1.accepted.length && r1.rejected.length) {
        retried = true;
        const reasons = [...new Set(r1.rejected.map((x) => x.reason))].join('；');
        const prior = r1.rejected;
        r1 = await learner.induce({
          run: last, feedback: fb, existing, callModel: opts.callModel, params, nextIdStart: nextN, protectedIds,
          hint: `注意：你上一次给出的策略全部被拒收（${reasons}）。不要重复已有策略的意思；库已满时，必须在 replaces 里写一条「不在起作用」的旧策略编号，用更好、更通用的版本替换它。`
        });
        r1.rejected = [...prior.map((x) => ({ ...x, retry: 0 })), ...r1.rejected];
      }
      r1.accepted.forEach((s) => (s.round = 1));
      nextN += r1.accepted.length;
      let candidate = [...existing.filter((s) => !r1.replaced.includes(s.id)), ...r1.accepted];

      // 自检
      const failedTasks = r1.failures.map((f) => tasksById.get(f.id)).filter(Boolean);
      let selfCheck = null;
      let r2 = { accepted: [], rejected: [], replaced: [], failures: [] };
      if (r1.accepted.length && failedTasks.length) {
        job.total = failedTasks.length;
        const check = await engine.runSet(failedTasks, candidate, { callModel: opts.callModel, params, concurrency: params.concurrency }, (done) => {
          job.done = done;
        });
        selfCheck = { cases: failedTasks.length, stillFailing: check.results.filter((x) => !x.grade.pass).map((x) => x.taskId) };
        // 第 2 轮：只看自检后仍失败的
        const pseudoRun = { results: check.results };
        r2 = await learner.induce({ run: pseudoRun, feedback: null, existing: candidate, callModel: opts.callModel, params, nextIdStart: nextN, allowReplace: false, protectedIds });
        r2.accepted.forEach((s) => (s.round = 2));
        candidate = [...candidate.filter((s) => !r2.replaced.includes(s.id)), ...r2.accepted];
      }

      const finalIds = new Set(candidate.map((s) => s.id));
      const added = candidate.filter((s) => !existing.some((e) => e.id === s.id));
      const replaced = existing.filter((e) => !finalIds.has(e.id)).map((e) => e.id);
      const rejected = [...r1.rejected.map((x) => ({ ...x, round: 1 })), ...r2.rejected.map((x) => ({ ...x, round: 2 }))];
      const newVersion = added.length ? store.commit(added, rejected, last.id, replaced) : null;
      return {
        fromRun: last.id,
        failures: r1.failures.map((f) => ({ id: f.id, why: f.why })),
        selfCheck,
        protected: [...protectedIds],
        retried,
        accepted: added,
        rejected,
        replaced,
        newVersion,
        durationMs: Date.now() - t0
      };
    }, { version: v.active });
  }

  /**
   * 多轮自迭代：v0 → v1 → … → vN。每轮 = 学习 → 训练集跑一次 → 留出集跑一次。
   *
   * 晋级闸（gate，默认开）：新版本在训练集上比当前最好版本差，就不晋级——
   * 指针退回最好版本，下一轮从最好版本的失败案例继续学。比较顺序：
   * 危机漏识别 → 二次伤害 → 未达标 → 要点覆盖（越多越好）。只看训练集；留出集只记录，不参与决策。
   * 每轮记录写进 <dataDir>/evolve/iterations.json，演示台画逐轮曲线。
   */
  function worseThan(a, b) {
    const ka = [a.crisisMiss, a.harmful, a.failed, -a.pointsHit];
    const kb = [b.crisisMiss, b.harmful, b.failed, -b.pointsHit];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
    return false;
  }

  let iterating = false;
  async function iterate(opts2 = {}) {
    if (iterating || busy()) throw new Error('BUSY');
    iterating = true;
    try {
      return await iterateInner(opts2);
    } finally {
      iterating = false;
    }
  }

  async function iterateInner({ maxRounds = 10, deadline = Infinity, gate = true, onRound } = {}) {
    const log = store.iterations();
    const active = store.versions().active;
    const lastTrain = (ver) => store.listRuns().filter((r) => r.set === 'train' && r.version === ver).pop();
    const lastHold = (ver) => store.listRuns().filter((r) => r.set === 'holdout' && r.version === ver).pop();
    if (!lastTrain(active)) await run('train');
    if (!log.rounds.length) {
      if (!lastHold(active)) await holdout();
      log.rounds.push({ round: 0, version: active, parent: null, promoted: true, library: store.load(active).length,
        train: lastTrain(active).metrics, holdout: lastHold(active).metrics, added: [], replaced: [], rejected: [] });
      log.best = active;
      store.saveIterations(log);
    }
    let stalls = 0;
    for (let i = 0; i < maxRounds && Date.now() < deadline; i++) {
      const best = log.best;
      store.setActive(best);
      const L = await learn();
      if (!L.newVersion) {
        // 没学到新东西（全部重复或被拒）：模型有随机性，再给一次机会；连续两轮都没有才停
        stalls += 1;
        const stop = stalls >= 2;
        log.rounds.push({ round: log.rounds.length, version: null, parent: best, promoted: false, stopped: stop ? 'no_new_strategy' : null, stalled: true,
          rejected: L.rejected.map((x) => ({ reason: x.reason, rule: x.rule, round: x.round })) });
        store.saveIterations(log);
        if (stop) break;
        continue;
      }
      stalls = 0;
      const tr = await run('train');
      const ho = await holdout();
      const hoRun = store.getRun(ho[L.newVersion]);
      const bestTrain = log.rounds.filter((r) => r.version === best && r.train).pop().train;
      const promoted = !gate || !worseThan(tr.metrics, bestTrain);
      const rec = { round: log.rounds.length, version: L.newVersion, parent: best, promoted, library: store.load(L.newVersion).length,
        train: tr.metrics, holdout: hoRun.metrics, added: L.accepted.map((s) => s.id), replaced: L.replaced,
        rejected: L.rejected.map((x) => ({ reason: x.reason, rule: x.rule, round: x.round })) };
      log.rounds.push(rec);
      if (promoted) log.best = L.newVersion;
      store.setActive(log.best);
      store.saveIterations(log);
      if (onRound) onRound(rec);
    }
    return log;
  }

  /**
   * 三次认证（用户 11/14 20:18 提出的方法）：
   *   每批由学习器提 3 条候选策略。每条候选单独评估：「已保存的库 + 这一条」跑训练集，与「已保存的库」的基线比。
   *   第 1 次检验必须有实际改进（未达标更少或要点更多），且任何一项都不能变差；
   *   危机漏识别增加、出现任何二次伤害（可能导致坏结果）→ 直接排除。
   *   通过的进入第 2、3 次检验（重新跑，过滤模型随机性），每次都必须「不比基线差、无二次伤害、危机漏不增加」。
   *   三次都合格的才永久写入策略库（附认证记录），然后重测基线、认证下一批。
   *   留出集只在保存后记录，不参与任何决策。
   */
  // tol：模型随机性的容差（同一版本重跑，训练集未达标会上下浮动 1~3 条）。危机漏识别和二次伤害零容差。
  let certifying = false;
  async function certify({ deadline = Infinity, maxBatches = 50, perBatch = 3, checks = 3, tol = { failed: 0, points: 0 }, onEvent } = {}) {
    if (certifying || iterating || busy()) throw new Error('BUSY');
    certifying = true;
    const log = store.certifications();
    const train = loadTasks('train');
    const say = (e) => onEvent && onEvent(e);
    const evalWith = async (lib) => (await engine.runSet(train, lib, { callModel: opts.callModel, params, concurrency: params.concurrency })).metrics;
    try {
      for (let b = 0; b < maxBatches && Date.now() < deadline; b++) {
        const v = store.versions();
        const lib = store.load(v.active);
        const baseRun = await doRun('train', v.active);
        const base = baseRun.metrics;
        if (!log.rounds.length || log.rounds[log.rounds.length - 1].version !== v.active) {
          const ho = await doRun('holdout', v.active);
          log.rounds.push({ version: v.active, library: lib.length, train: base, holdout: ho.metrics });
        }
        const everyId = v.versions.flatMap((x) => store.load(x.id).map((s2) => s2.id));
        const nextN = Math.max(0, ...everyId.map((id) => Number(String(id).slice(2)) || 0), ...log.candidates.map((c) => Number(String(c.id).slice(2)) || 0)) + 1;
        const ind = await learner.induce({
          run: baseRun, existing: lib, callModel: opts.callModel, params, nextIdStart: nextN,
          protectedIds: learner.workingStrategyIds(baseRun, lib),
          hint: `这一轮只给 ${perBatch} 条最有把握的策略，每条单独接受三次检验；不要重复已有策略的意思。库满时用 replaces 替换一条不在起作用的旧策略。`
        });
        const cands = ind.accepted.slice(0, perBatch);
        const batch = log.batches.length + 1;
        log.batches.push({ batch, at: new Date().toISOString(), version: v.active, base, proposed: cands.length, gateRejected: ind.rejected.map((x) => ({ rule: x.rule, reason: x.reason })) });
        if (!cands.length) {
          store.saveCertifications(log);
          say({ batch, empty: true });
          continue;
        }
        const results = await Promise.all(cands.map(async (c) => {
          const libWith = [...lib.filter((s2) => !(c.replaces || []).includes(s2.id)), c];
          const rec = { batch, id: c.id, rule: c.rule, replaces: c.replaces, source_cases: c.source_cases, checks: [], status: 'pending' };
          for (let k = 0; k < checks; k++) {
            const m = await evalWith(libWith);
            const j = judgeMetrics(m, base, k === 0, tol);
            rec.checks.push({ n: k + 1, pass: j.ok, reason: j.reason || '', failed: m.failed, pointsHit: m.pointsHit, crisisMiss: m.crisisMiss, harmful: m.harmful });
            if (!j.ok) { rec.status = 'excluded'; rec.reason = `第 ${k + 1} 次检验：${j.reason}`; break; }
          }
          if (rec.status === 'pending') rec.status = 'certified';
          return { c, rec };
        }));
        const ok = results.filter((x) => x.rec.status === 'certified');
        // 同一批里多条都合格、但要替换同一条旧策略时，只保留检验成绩最好的一条
        ok.sort((x, y) => (x.rec.checks.reduce((a, q) => a + q.failed, 0) - y.rec.checks.reduce((a, q) => a + q.failed, 0)));
        const usedRep = new Set();
        const save = [];
        for (const x of ok) {
          if ((x.c.replaces || []).some((id) => usedRep.has(id))) { x.rec.status = 'excluded'; x.rec.reason = '与同批另一条合格策略替换同一条旧策略，保留成绩更好的那条'; continue; }
          (x.c.replaces || []).forEach((id) => usedRep.add(id));
          save.push(x);
        }
        let newVersion = null;
        if (save.length) {
          const added = save.map((x) => ({ ...x.c, certification: { batch, checks: x.rec.checks, base: { failed: base.failed, pointsHit: base.pointsHit, crisisMiss: base.crisisMiss } } }));
          newVersion = store.commit(added, [], baseRun.id, [...usedRep]);
          save.forEach((x) => (x.rec.savedIn = newVersion));
        }
        results.forEach((x) => log.candidates.push(x.rec));
        log.batches[log.batches.length - 1].savedIn = newVersion;
        store.saveCertifications(log);
        say({ batch, base, results: results.map((x) => x.rec), newVersion });
      }
      // 收尾：最后一个版本补一次训练集 + 留出集记录
      const v = store.versions();
      if (!log.rounds.length || log.rounds[log.rounds.length - 1].version !== v.active) {
        const tr = await doRun('train', v.active);
        const ho = await doRun('holdout', v.active);
        log.rounds.push({ version: v.active, library: store.load(v.active).length, train: tr.metrics, holdout: ho.metrics });
        store.saveCertifications(log);
      }
      return log;
    } finally {
      certifying = false;
    }
  }

  function rollback(versionId = 'v0') {
    if (busy()) throw new Error('BUSY');
    return store.setActive(versionId);
  }

  /** 单句试答（回退演示用）：用当前版本回答一句，返回回复与用到的策略 */
  async function tryOne(text) {
    const strategies = store.active().strategies;
    const task = { id: 'TRY', type: 'free', input: String(text || '').slice(0, 300), points: [] };
    const r = await engine.runTask(task, strategies, { callModel: opts.callModel, params });
    return { version: store.versions().active, reply: r.reply, used: r.used, routed: r.routed, model: r.model };
  }

  return {
    state,
    run,
    holdout,
    learn,
    iterate,
    worseThan,
    certify,
    judge: judgeMetrics,
    rollback,
    tryOne,
    getRun: (id) => store.getRun(id),
    setFeedback: (runId, taskId, value) => store.setFeedback(runId, taskId, value),
    reset: () => {
      if (busy()) throw new Error('BUSY');
      job = null;
      store.reset();
    },
    store,
    params
  };
}

module.exports = { createLab, loadTasks, judgeMetrics };
