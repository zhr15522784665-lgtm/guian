/**
 * 读取版本库内的静态语气包。文件 IO 留在 server，core 只接收解析后的对象。
 * 只按显式 botId 拼出白名单文件名；缺包时记录日志并跳过，不跨 bot 兜底。
 */

const fs = require('fs');
const path = require('path');
const core = require('../core/src');

function createToneStore(opts) {
  const dir = (opts && opts.dir) || path.join(__dirname, '..', 'tone');
  const logger = (opts && opts.logger) || console;

  function requireBot(botId) {
    if (!core.isKnownBotId(botId)) {
      throw new Error(`tone: 未知或缺失的 botId: ${String(botId)}`);
    }
    return botId;
  }

  function get(botId) {
    const id = requireBot(botId);
    const file = path.join(dir, `${id}.json`);
    if (!fs.existsSync(file)) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[tone] 语气包文件缺失，跳过注入', { botId: id });
      }
      return null;
    }

    let pack;
    try {
      pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`tone: 无法读取 ${id} 语气包: ${String(err && err.message || err)}`);
    }
    if (!pack || pack.bot_id !== id) {
      throw new Error(`tone: ${id}.json 的 bot_id 必须是 ${id}`);
    }

    const rendered = core.renderToneContent(pack);
    const chars = [...rendered].length;
    if (chars > core.TONE_MAX_CHARS) {
      throw new Error(`tone: ${id} 渲染后为 ${chars} 字符，超过 ${core.TONE_MAX_CHARS} 字符上限`);
    }
    return pack;
  }

  return { get };
}

module.exports = { createToneStore };
