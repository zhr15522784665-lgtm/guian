/**
 * 人格注册表。
 *
 * 一条硬规矩：findPersona 找不到必须抛错。
 * 绝对不能写成 `findPersona(id) || PERSONAS[0]`——那个写法在单人格产品里是容错，
 * 在三个独立 bot 的产品里就是串味的入口：任何一次 botId 传错，
 * 用户会突然收到另一个人格的回复，而系统不会有任何报错。
 *
 * 串味是本产品最不能出的错，比崩溃严重得多。崩溃至少是可见的。
 */

const health = require('./health');
const growth = require('./growth');
const listener = require('./listener');

const PERSONAS = Object.freeze([health, growth, listener]);
const PERSONA_IDS = Object.freeze(PERSONAS.map((p) => p.id));
const PERSONA_MAP = Object.freeze(new Map(PERSONAS.map((p) => [p.id, p])));

class PersonaError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'PersonaError';
    this.code = code;
    this.detail = detail || null;
  }
}

/**
 * @param {string} id
 * @returns {object} persona
 * @throws {PersonaError} 非法或未知的 botId
 */
function findPersona(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new PersonaError('BOT_ID_REQUIRED', 'botId 必填，不接受空值或默认值');
  }
  const persona = PERSONA_MAP.get(id);
  if (!persona) {
    throw new PersonaError('BOT_ID_UNKNOWN', `未知的 botId: ${id}`, { allowed: PERSONA_IDS });
  }
  return persona;
}

function isKnownBotId(id) {
  return typeof id === 'string' && PERSONA_MAP.has(id);
}

/** 只给前端用的展示信息，不含 prompt 与 few-shot */
function listPersonaCards() {
  return PERSONAS.map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    tagline: p.tagline,
    greetHint: p.greetHint,
    // 开场自我介绍：叫什么、爱聊什么、擅长什么，最后如实说自己是 AI、但首先是伙伴。
    // 它替代了原来追在第一条回复末尾的那句边界声明，常驻聊天页顶部。
    introNote: (p.selfIntro && p.selfIntro.greeting) || ''
  }));
}

module.exports = {
  PERSONAS,
  PERSONA_IDS,
  PersonaError,
  findPersona,
  isKnownBotId,
  listPersonaCards
};
