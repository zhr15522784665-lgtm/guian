/**
 * 配置。优先级：环境变量 > 本地配置文件 > 默认值。
 *
 * 为什么加本地配置文件：双击启动的用户不会去设环境变量。
 * 之前只读 process.env，结果是「双击启动 → 服务起来了 → 一说话就报
 * NO_API_KEY」，用户完全不知道该怎么办。配置得能从文件和界面改，
 * 不能只面向会开终端的人。
 *
 * config.local.json 里有明文密钥，不进版本库。
 */

const fs = require('fs');
const path = require('path');

// 放在 app/ 根目录，不在 server/ 里：用户偶尔要打开看或备份，
// 藏进代码目录会让人找不到。
const LOCAL_FILE = path.join(__dirname, '..', 'config.local.json');

/** 读本地配置。文件不存在或写坏了都当空对象——配置错误不能让服务起不来。 */
function readLocal() {
  try {
    const raw = fs.readFileSync(LOCAL_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

const local = readLocal();

/** 环境变量优先，便于临时覆盖；文件兜底。 */
function pick(envVal, localVal, def) {
  if (envVal !== undefined && envVal !== '') return envVal;
  if (localVal !== undefined && localVal !== null && localVal !== '') return localVal;
  return def;
}

/** 从设置脚本粘进来的密钥常带引号或首尾空白，统一洗一遍。 */
function cleanKey(v) {
  return String(v == null ? '' : v)
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

module.exports = {
  port: Number(pick(process.env.PORT, local.port, 3000)),

  // 模型
  llm: {
    // DEEPSEEK_* 优先；LLM_* 是通用别名，方便接任何 OpenAI 兼容服务（如测试用的中转）。
    // 默认值仍然是 DeepSeek 官方，用户什么都不配时行为不变。
    apiKey: cleanKey(pick(process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY, local.apiKey, '')),
    baseUrl: pick(process.env.DEEPSEEK_BASE_URL || process.env.LLM_BASE_URL, local.baseUrl, 'https://api.deepseek.com'),
    primaryModel: pick(process.env.LLM_PRIMARY, local.primaryModel, 'deepseek-flash'),
    // 显式配置了主模型（环境变量或 config.local.json）时，它优先于人格文件里写的默认模型名。
    // 理由：人格里的 model 是产品默认值；换服务商/中转时模型名不同，运维必须能不改 core 就切过去。
    // 2026-11-14 实测：中转上没有 deepseek-flash，人格默认名会让每一轮都落到降级通道。
    forcePrimary: Boolean(process.env.LLM_PRIMARY || local.primaryModel),
    fallbackModel: pick(process.env.LLM_FALLBACK, local.fallbackModel, 'deepseek-v4-pro'),
    timeoutMs: Number(pick(process.env.LLM_TIMEOUT_MS, local.timeoutMs, 12000))
  },

  // 见岸·自适应（自进化演示台）。模型默认跟主模型一致；温度等参数写死，hash 上屏。
  evolve: {
    port: Number(pick(process.env.EVOLVE_PORT, local.evolvePort, 3100)),
    model: pick(process.env.EVOLVE_MODEL, local.evolveModel, pick(process.env.LLM_PRIMARY, local.primaryModel, 'deepseek-flash')),
    concurrency: Number(pick(process.env.EVOLVE_CONCURRENCY, local.evolveConcurrency, 5))
  },

  // 数据目录。单文件 JSON，一个用户一个文件。
  dataDir: pick(process.env.DATA_DIR, local.dataDir, path.join(__dirname, '..', 'data')),

  webDir: path.join(__dirname, '..', 'web'),

  // 单条消息与单次请求的上限
  maxInputLen: 1000,
  maxBodyBytes: 64 * 1024,

  // 每个 bot 保留的消息条数（防止文件无限增长）
  maxMessagesPerBot: 200,

  // 给启动器和设置脚本用的路径，避免它们各写一份
  paths: {
    localFile: LOCAL_FILE
  }
};
