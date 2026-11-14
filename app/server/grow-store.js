/**
 * 归岸·会成长 · 每个伙伴一份带版本的策略库 + 反馈池（数据层）。
 *
 * 目录：<dataDir>/grow/<botId>/
 *   v0.jsonl, v1.jsonl, …   每个版本是完整快照，旧版本永不改写（v0 = 空库基线，v1 = 用户亲手教的种子）
 *   versions.json            { active, versions:[{id, parent, kind, created_at, added, replaced, note}], log:[…] }
 *   failures.jsonl           「没接住」的样本（按钮 / 隐式信号 / 离开原因）。只存这一轮的输入和回复片段，不存 uid
 *   reviews.json             每次「复盘」的完整记录（候选、三次检验、整库复检、是否晋级）
 *
 * 三条纪律：
 *   1) 所有方法第一个参数都是 botId，没有默认值，未知 botId 直接抛错（AGENTS.md 约束①）。
 *      没有「列出所有 bot 的策略」这种方法——物理上没有串味的路。
 *   2) 回退 = 把 active 指回旧版本，O(1) 且绝对可复原。
 *   3) 危机 / 风险级别的对话不会进 failures.jsonl（调用方先过滤，这里再兜一层）。
 */

const fs = require('fs');
const path = require('path');
const core = require('../core/src');

let validateRule = null;
try {
  ({ validateRule } = require('../evolve/frozen/safety'));
} catch (_) {
  validateRule = null;
}

const DEFAULT_SEEDS = path.join(__dirname, '..', 'grow', 'seeds.jsonl');
const DEFAULT_PENDING = path.join(__dirname, '..', 'grow', 'pending.jsonl');
const MAX_FAILURES = 300;

function createGrowStore(opts) {
  const root = path.join((opts && opts.dir) || path.join(__dirname, '..', 'data'), 'grow');
  const seedsFile = (opts && opts.seedsFile) || DEFAULT_SEEDS;
  const pendingFile = (opts && opts.pendingFile) || DEFAULT_PENDING;
  const logger = (opts && opts.logger) || console;

  function requireBot(botId) {
    if (!core.isKnownBotId(botId)) throw new Error(`grow: 未知或缺失的 botId: ${String(botId)}`);
    return botId;
  }
  const dirOf = (botId) => path.join(root, requireBot(botId));

  function atomicWrite(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  }
  function readJson(file, def) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return def;
    }
  }
  function readJsonl(file) {
    try {
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    } catch (_) {
      return [];
    }
  }
  const writeJsonl = (file, list) => atomicWrite(file, list.map((x) => JSON.stringify(x)).join('\n') + (list.length ? '\n' : ''));

  /** 读种子文件里属于这个 bot 的条目（过安全闸） */
  function seedsFor(botId) {
    requireBot(botId);
    return readJsonl(seedsFile)
      .filter((s) => s && s.id && s.rule && (s.bots === 'all' || (Array.isArray(s.bots) && s.bots.includes(botId))))
      .filter((s) => {
        if (!validateRule) return true;
        const v = validateRule(s);
        if (!v.ok) logger.warn && logger.warn('[grow] 种子被安全闸拒收', s.id, v.reason);
        return v.ok;
      })
      .map((s) => {
        const { bots, ...rest } = s;
        return { ...rest, created_by: s.created_by || 'user_taught' };
      });
  }

  /** 只列出候选，不写入版本，也不供 active() 使用。 */
  function pending(botId) {
    requireBot(botId);
    return readJsonl(pendingFile).filter(
      (s) => s && s.id && s.rule && (s.bots === 'all' || (Array.isArray(s.bots) && s.bots.includes(botId)))
    );
  }

  function ensure(botId) {
    const d = dirOf(botId);
    const vfile = path.join(d, 'versions.json');
    if (!fs.existsSync(vfile)) {
      writeJsonl(path.join(d, 'v0.jsonl'), []);
      atomicWrite(
        vfile,
        JSON.stringify({ active: 'v0', versions: [{ id: 'v0', parent: null, kind: 'baseline', created_at: new Date().toISOString(), added: [], replaced: [], note: '空库基线' }], log: [] }, null, 1)
      );
    }
    syncSeeds(botId);
  }

  function rawVersions(botId) {
    return readJson(path.join(dirOf(botId), 'versions.json'), null);
  }

  function load(botId, versionId) {
    const d = dirOf(botId);
    if (!/^v\d+$/.test(String(versionId))) throw new Error(`grow: 非法版本号 ${versionId}`);
    const file = path.join(d, `${versionId}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`grow: 版本不存在 ${versionId}`);
    return readJsonl(file);
  }

  function commitRaw(botId, added, meta) {
    const d = dirOf(botId);
    const v = rawVersions(botId);
    if (!Array.isArray(added)) throw new Error('grow: added 必须是数组');
    if (validateRule) {
      for (const strategy of added) {
        const verdict = validateRule(strategy);
        if (!verdict.ok) throw new Error(`grow: 策略 ${String(strategy && strategy.id)} 未通过安全闸：${verdict.reason}`);
      }
    }
    const drop = new Set((meta && meta.replaced) || []);
    const base = load(botId, v.active).filter((s) => !drop.has(s.id));
    const id = `v${Math.max(...v.versions.map((x) => Number(x.id.slice(1)))) + 1}`;
    const all = [...base, ...added.map((s) => ({ ...s, version: s.version || id }))];
    writeJsonl(path.join(d, `${id}.jsonl`), all);
    v.versions.push({
      id,
      parent: v.active,
      kind: (meta && meta.kind) || 'learn',
      created_at: new Date().toISOString(),
      added: added.map((s) => s.id),
      replaced: [...drop],
      note: (meta && meta.note) || '',
      review: (meta && meta.review) || null
    });
    v.log.push({ at: new Date().toISOString(), action: 'commit', to: id, from: v.active });
    v.active = id;
    atomicWrite(path.join(d, 'versions.json'), JSON.stringify(v, null, 1));
    return id;
  }

  /** 种子文件里有、但任何版本里都没出现过的条目 → 生成一个新版本。补种子不用改代码。 */
  function syncSeeds(botId) {
    const v = rawVersions(botId);
    if (!v) return null;
    const seen = new Set(v.versions.flatMap((x) => load(botId, x.id).map((s) => s.id)));
    const fresh = seedsFor(botId).filter((s) => !seen.has(s.id));
    if (!fresh.length) return null;
    return commitRaw(botId, fresh, { kind: 'seed', note: `你亲手教的 ${fresh.length} 条` });
  }

  function versions(botId) {
    ensure(botId);
    return rawVersions(botId);
  }

  function active(botId) {
    const v = versions(botId);
    return { id: v.active, strategies: load(botId, v.active) };
  }

  function commit(botId, added, meta) {
    ensure(botId);
    return commitRaw(botId, added, meta);
  }

  /** 一键回退：默认退到当前版本的上一版；也可以指定版本。 */
  function rollback(botId, toVersion) {
    const v = versions(botId);
    const cur = v.versions.find((x) => x.id === v.active);
    const target = toVersion || (cur && cur.parent);
    if (!target) throw new Error('grow: 已经是最早的版本，没法再退');
    load(botId, target);
    v.log.push({ at: new Date().toISOString(), action: 'rollback', from: v.active, to: target });
    v.active = target;
    atomicWrite(path.join(dirOf(botId), 'versions.json'), JSON.stringify(v, null, 1));
    return target;
  }

  // ── 反馈池 ──
  function unsafeSample(item) {
    if (!item || item.crisis || item.sessionBlocked || ['risk', 'crisis', 2, 3].includes(item.safety)) return true;
    // 防止调用方漏传安全级别，原文在截断前过同一分诊器；不改分诊规则。
    return [item.input, item.reply].some((text) => core.classify({ text: String(text || '') }).level >= core.LEVEL.RISK);
  }

  function sampleEntry(item, prefix) {
    return {
      id: `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      source: String(item.source || 'button').slice(0, 40),
      reason: String(item.reason || '').slice(0, 40),
      signalType: String(item.signalType || item.reason || item.source || 'miss').slice(0, 40),
      input: String(item.input || '').slice(0, 300),
      reply: String(item.reply || '').slice(0, 500)
    };
  }

  function addFailure(botId, item) {
    const d = dirOf(botId);
    if (unsafeSample(item)) return null;
    const entry = sampleEntry(item, 'F');
    const file = path.join(d, 'failures.jsonl');
    const list = readJsonl(file);
    list.push(entry);
    writeJsonl(file, list.slice(-MAX_FAILURES));
    return entry;
  }
  function listFailures(botId, limit) {
    return readJsonl(path.join(dirOf(botId), 'failures.jsonl')).slice(-(limit || 50));
  }
  function addGood(botId, item) {
    const d = dirOf(botId);
    if (unsafeSample(item)) return null;
    const goodFile = path.join(d, 'good.jsonl');
    const samples = readJsonl(goodFile);
    const entry = sampleEntry(item, 'G');
    writeJsonl(goodFile, [...samples, entry].slice(-MAX_FAILURES));
    const file = path.join(d, 'stats.json');
    const st = readJson(file, { good: 0 });
    st.good = (st.good || 0) + 1;
    atomicWrite(file, JSON.stringify(st));
    return st;
  }
  function stats(botId) {
    const st = readJson(path.join(dirOf(botId), 'stats.json'), { good: 0 });
    const failures = listFailures(botId, MAX_FAILURES);
    const bySource = {};
    const byReason = {};
    const bySignal = {};
    failures.forEach((f) => {
      const source = f.source || 'unknown';
      const reason = f.reason || 'miss';
      const signal = f.signalType || reason;
      bySource[source] = (bySource[source] || 0) + 1;
      byReason[reason] = (byReason[reason] || 0) + 1;
      bySignal[signal] = (bySignal[signal] || 0) + 1;
    });
    return { good: st.good || 0, failures: failures.length, failuresBySource: bySource, failuresByReason: byReason, failuresBySignal: bySignal };
  }

  // ── 复盘记录 ──
  function reviews(botId) {
    return readJson(path.join(dirOf(botId), 'reviews.json'), { reviews: [] });
  }
  function saveReview(botId, rec) {
    const log = reviews(botId);
    const i = log.reviews.findIndex((r) => r.id === rec.id);
    if (i >= 0) log.reviews[i] = rec;
    else log.reviews.push(rec);
    log.reviews = log.reviews.slice(-20);
    atomicWrite(path.join(dirOf(botId), 'reviews.json'), JSON.stringify(log, null, 1));
    return rec;
  }

  return { root, requireBot, seedsFor, pending, versions, load, active, commit, rollback, syncSeeds, addFailure, listFailures, addGood, stats, reviews, saveReview };
}

module.exports = { createGrowStore, DEFAULT_SEEDS, DEFAULT_PENDING };
