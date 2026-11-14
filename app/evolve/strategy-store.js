/**
 * 见岸·自适应 · 策略库（数据层，进化唯一允许写的地方）。
 *
 * 目录：<dataDir>/evolve/
 *   strategies/v0.jsonl     空库 = 基线
 *   strategies/vN.jsonl     每次学习生成一个新版本（完整快照，旧版本永不改写）
 *   versions.json           { active, versions:[{id, parent, created_at, added:[ids], rejected:[...], fromRun}] }
 *   runs/<runId>.json       每次运行的完整记录（回复、评分、指标、指纹）
 *   feedback.json           人工「这条不好」标记 { runId: { taskId: 'bad' } }
 *
 * 回退 = 把 active 指回旧版本。因为每个版本是完整快照，回退是 O(1) 且绝对可复原。
 */

const fs = require('fs');
const path = require('path');

function createStrategyStore(baseDir) {
  const root = path.join(baseDir, 'evolve');
  const sdir = path.join(root, 'strategies');
  const rdir = path.join(root, 'runs');
  const vfile = path.join(root, 'versions.json');
  const ffile = path.join(root, 'feedback.json');

  function atomicWrite(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  }

  function readJson(file, def) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return def;
    }
  }

  function ensure() {
    fs.mkdirSync(sdir, { recursive: true });
    fs.mkdirSync(rdir, { recursive: true });
    if (!fs.existsSync(path.join(sdir, 'v0.jsonl'))) atomicWrite(path.join(sdir, 'v0.jsonl'), '');
    if (!fs.existsSync(vfile)) {
      atomicWrite(
        vfile,
        JSON.stringify({ active: 'v0', versions: [{ id: 'v0', parent: null, created_at: new Date().toISOString(), added: [], rejected: [], fromRun: null }] }, null, 1)
      );
    }
  }

  function versions() {
    ensure();
    return readJson(vfile, { active: 'v0', versions: [] });
  }

  function load(versionId) {
    ensure();
    if (!/^v\d+$/.test(String(versionId))) throw new Error(`非法版本号 ${versionId}`);
    const file = path.join(sdir, `${versionId}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`版本不存在 ${versionId}`);
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  function active() {
    const v = versions();
    return { id: v.active, strategies: load(v.active) };
  }

  /** 在当前 active 之上追加新策略，生成新版本并激活 */
  function commit(added, rejected, fromRun, replacedIds) {
    const v = versions();
    const drop = new Set(replacedIds || []);
    const base = load(v.active).filter((s) => !drop.has(s.id));
    const nums = v.versions.map((x) => Number(x.id.slice(1)));
    const id = `v${Math.max(...nums) + 1}`;
    const all = [...base, ...added.map((s) => ({ ...s, version: id }))];
    atomicWrite(path.join(sdir, `${id}.jsonl`), all.map((s) => JSON.stringify(s)).join('\n') + (all.length ? '\n' : ''));
    v.versions.push({ id, parent: v.active, created_at: new Date().toISOString(), added: added.map((s) => s.id), replaced: [...drop], rejected, fromRun });
    v.active = id;
    atomicWrite(vfile, JSON.stringify(v, null, 1));
    return id;
  }

  function setActive(versionId) {
    load(versionId); // 校验存在
    const v = versions();
    v.active = versionId;
    atomicWrite(vfile, JSON.stringify(v, null, 1));
    return versionId;
  }

  function iterations() {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'iterations.json'), 'utf8'));
    } catch (_) {
      return { best: null, rounds: [] };
    }
  }

  function saveIterations(log) {
    ensure();
    atomicWrite(path.join(root, 'iterations.json'), JSON.stringify(log, null, 1));
  }

  function certifications() {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'certifications.json'), 'utf8'));
    } catch (_) {
      return { batches: [], candidates: [], rounds: [] };
    }
  }

  function saveCertifications(log) {
    ensure();
    atomicWrite(path.join(root, 'certifications.json'), JSON.stringify(log, null, 1));
  }

  function saveRun(run) {
    ensure();
    atomicWrite(path.join(rdir, `${run.id}.json`), JSON.stringify(run, null, 1));
  }

  function listRuns() {
    ensure();
    return fs
      .readdirSync(rdir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(rdir, f), null))
      .filter(Boolean)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  function getRun(id) {
    if (!/^[\w-]+$/.test(String(id))) return null;
    return readJson(path.join(rdir, `${id}.json`), null);
  }

  function feedback() {
    return readJson(ffile, {});
  }

  function setFeedback(runId, taskId, value) {
    const fb = feedback();
    fb[runId] = fb[runId] || {};
    if (value) fb[runId][taskId] = value;
    else delete fb[runId][taskId];
    atomicWrite(ffile, JSON.stringify(fb, null, 1));
    return fb[runId];
  }

  /** 清空全部进化数据（演示前重置用） */
  function reset() {
    fs.rmSync(root, { recursive: true, force: true });
    ensure();
  }

  return { root, versions, load, active, commit, setActive, saveRun, listRuns, getRun, feedback, setFeedback, reset, iterations, saveIterations, certifications, saveCertifications };
}

module.exports = { createStrategyStore };
