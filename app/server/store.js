/**
 * 持久化。一个用户一个 JSON 文件。
 *
 * 为什么不用数据库：
 * 单机、单进程、用户量在几十到几千之间，JSON 文件足够，而且**能直接打开看**。
 * 调试「它到底记得我什么」这类问题时，能 cat 一个文件比查表快得多。
 * 上量了再换 SQLite，接口不用变。
 *
 * 三条必须守住的纪律：
 *
 * 1) **同一个 uid 的读改写必须串行。** 否则两个并发请求会互相覆盖，
 *    表现为「消息偶尔丢一条」——这种 bug 极难复现。用 promise 队列串起来。
 *
 * 2) **写入用临时文件 + rename。** rename 在同一文件系统上是原子的，
 *    进程被杀不会留下半截 JSON。
 *
 * 3) **涉及对话内容的方法一律带 botId，且没有默认值。**
 *    写 `listMemories(uid, botId = 'health')` 就等于埋了一颗串味的雷。
 *    另外这里**没有**任何「查这个人的所有记忆」的方法——物理上没有这条路，
 *    比「约定不要用」可靠。
 */

const fs = require('fs');
const path = require('path');
const { findPersona } = require('../core/src/personas');

function emptyDoc(uid) {
  return {
    uid,
    createdAt: Date.now(),
    ageBand: null,
    global: { lastSoftAt: 0 },
    bots: {}
  };
}

function ensureBot(doc, botId) {
  if (!doc.bots[botId]) {
    doc.bots[botId] = {
      state: { turnCount: 0, seenIntro: false, intervention: {}, session: {} },
      messages: [],
      memories: [],
      summary: '',
      summaryUpTo: 0
    };
  }
  return doc.bots[botId];
}

function createStore(opts) {
  const dir = (opts && opts.dir) || path.join(__dirname, '..', 'data');
  const maxMessagesPerBot = (opts && opts.maxMessagesPerBot) || 200;

  /** uid → doc 的内存缓存 */
  const cache = new Map();
  /** uid → 该 uid 的写入队列尾 */
  const queues = new Map();

  function fileFor(uid) {
    return path.join(dir, `u_${uid}.json`);
  }

  async function load(uid) {
    if (cache.has(uid)) return cache.get(uid);
    try {
      const raw = await fs.promises.readFile(fileFor(uid), 'utf8');
      const doc = JSON.parse(raw);
      cache.set(uid, doc);
      return doc;
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
      const doc = emptyDoc(uid);
      cache.set(uid, doc);
      return doc;
    }
  }

  async function persist(uid, doc) {
    await fs.promises.mkdir(dir, { recursive: true });
    const target = fileFor(uid);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
  }

  /**
   * 原子读改写。同一个 uid 的调用会排队。
   */
  function update(uid, mutator) {
    const prev = queues.get(uid) || Promise.resolve();
    const task = prev.then(async () => {
      const doc = await load(uid);
      const out = await mutator(doc);
      await persist(uid, doc);
      return out;
    });

    // 队列尾只用来串行，吞掉错误避免 unhandled rejection
    queues.set(
      uid,
      task.catch(() => {})
    );

    return task;
  }

  function requireBotId(botId) {
    findPersona(botId);
  }

  return {
    // ── 用户 ──
    async ensureUser(uid) {
      return update(uid, (doc) => ({ ageBand: doc.ageBand, createdAt: doc.createdAt }));
    },

    async getAgeBand(uid) {
      const doc = await load(uid);
      return doc.ageBand;
    },

    async setAgeBand(uid, band) {
      return update(uid, (doc) => {
        doc.ageBand = band;
        doc.ageBandSetAt = Date.now();
        return band;
      });
    },

    // ── 每 bot 状态 ──
    async getBotState(uid, botId) {
      requireBotId(botId);
      const doc = await load(uid);
      const bot = ensureBot(doc, botId);
      return { ...bot.state };
    },

    async saveBotState(uid, botId, patch) {
      requireBotId(botId);
      return update(uid, (doc) => {
        const bot = ensureBot(doc, botId);
        bot.state = { ...bot.state, ...patch, updatedAt: Date.now() };
        return { ...bot.state };
      });
    },

    // ── 全局介入状态（跨 bot 的总量频控）──
    async getGlobalState(uid) {
      const doc = await load(uid);
      return { ...(doc.global || {}) };
    },

    async saveGlobalState(uid, patch) {
      return update(uid, (doc) => {
        doc.global = { ...(doc.global || {}), ...patch, updatedAt: Date.now() };
        return doc.global;
      });
    },

    // ── 消息 ──
    async listMessages(uid, botId, limit) {
      requireBotId(botId);
      const doc = await load(uid);
      const bot = ensureBot(doc, botId);
      const max = limit || 30;
      return bot.messages.slice(-max);
    },

    async appendMessage(uid, botId, msg) {
      requireBotId(botId);
      return update(uid, (doc) => {
        const bot = ensureBot(doc, botId);
        bot.messages.push({
          role: msg.role,
          content: String(msg.content || '').slice(0, 4000),
          seq: msg.seq || Date.now(),
          at: Date.now(),
          safety: msg.safety || null,
          interventionTag: msg.interventionTag || null,
          ...(msg.turnId ? { turnId: msg.turnId } : {}),
          ...(msg.modelReply ? { modelReply: true } : {}),
          // 演示模式的假回复打标，配上真密钥后不回放、不进上下文
          ...(msg.mock ? { mock: true } : {})
        });
        // 裁剪：只留最近 N 条。超出部分不归档——这个产品不该无限保存对话
        if (bot.messages.length > maxMessagesPerBot) {
          bot.messages = bot.messages.slice(-maxMessagesPerBot);
        }
        return bot.messages.length;
      });
    },

    async markFeedback(uid, botId, turnId, kind) {
      requireBotId(botId);
      return update(uid, (doc) => {
        const message = ensureBot(doc, botId).messages.find((m) => m.turnId === turnId);
        if (message) message.feedbackKind = kind;
      });
    },

    // ── 记忆 ──
    async listMemories(uid, botId, limit) {
      requireBotId(botId);
      const doc = await load(uid);
      const bot = ensureBot(doc, botId);
      return (bot.memories || []).slice(-(limit || 40));
    },

    async addMemories(uid, botId, items) {
      requireBotId(botId);
      if (!Array.isArray(items) || !items.length) return [];
      return update(uid, (doc) => {
        const bot = ensureBot(doc, botId);
        const added = [];
        for (const it of items.slice(0, 5)) {
          if (!it || !it.text) continue;
          const text = String(it.text).slice(0, 80);
          // 简单去重：同一句已经在库里就不重复写
          if (bot.memories.some((m) => m.text === text)) continue;
          const entry = {
            kind: it.kind || 'fact',
            text,
            weight: Number(it.weight) || 1,
            hits: 0,
            createdAt: Date.now()
          };
          bot.memories.push(entry);
          added.push(entry);
        }
        // 记忆也不无限增长：超过 200 条就丢最久没被用到的
        if (bot.memories.length > 200) {
          bot.memories.sort((a, b) => (b.weight || 1) - (a.weight || 1));
          bot.memories = bot.memories.slice(0, 200);
        }
        return added;
      });
    },

    // ── 会话摘要 ──
    async getConversation(uid, botId) {
      requireBotId(botId);
      const doc = await load(uid);
      const bot = ensureBot(doc, botId);
      return { summary: bot.summary || '', summaryUpTo: bot.summaryUpTo || 0 };
    },

    async saveSummary(uid, botId, summary, upToSeq) {
      requireBotId(botId);
      return update(uid, (doc) => {
        const bot = ensureBot(doc, botId);
        bot.summary = String(summary || '').slice(0, 600);
        bot.summaryUpTo = upToSeq || Date.now();
        return true;
      });
    },

    // ── 清空 ──
    /** 只清一个 bot：记忆 + 消息 + 状态。另外两个 bot 不受影响。 */
    async clearBot(uid, botId) {
      requireBotId(botId);
      return update(uid, (doc) => {
        delete doc.bots[botId];
        return true;
      });
    },

    /** 清掉这个人的全部数据（含 cookie 之外的一切痕迹） */
    async deleteAll(uid) {
      const prev = queues.get(uid) || Promise.resolve();
      const task = prev.then(async () => {
        cache.delete(uid);
        try {
          await fs.promises.unlink(fileFor(uid));
        } catch (err) {
          if (err && err.code !== 'ENOENT') throw err;
        }
        return true;
      });
      queues.set(uid, task.catch(() => {}));
      return task;
    },

    /** 仅供调试/健康检查 */
    _stats() {
      return { users: cache.size, dir };
    }
  };
}

module.exports = { createStore, emptyDoc };
