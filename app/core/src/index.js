/**
 * core 的统一出口。云函数只从这里拿东西。
 */

const { PERSONAS, PERSONA_IDS, PersonaError, findPersona, isKnownBotId, listPersonaCards } =
  require('./personas');
const { runTurn, isSymptomTalk } = require('./turn/run-turn');
const { buildContext, pickHistory, cleanHistory, isNoiseMessage } = require('./turn/context');
const { buildSystemPrompt, renderToneContent, renderToneBlock, TONE_MAX_CHARS } = require('./pipeline/prompt');
const { classify, LEVEL } = require('./pipeline/safety-router');
const { detectSoftSignals, detectStructural } = require('./pipeline/dependency');
const { decide, applyCardAction } = require('./pipeline/intervention');
const { extractByRule } = require('./memory/extract-rule');
const { rankMemories } = require('./memory/rank');
const { HOTLINES, PRIMARY_HOTLINE, PROVINCE_HOTLINES, HOTLINE_GUIDE } = require('./content/hotlines');
const { CRISIS_REPLY, RISK_REPLY, HOTLINE_CARD } = require('./content/crisis');
const boundaryCopy = require('./content/boundary');
const sessionPolicy = require('./compliance/session');
const {
  RELIEF_EXERCISES, RELIEF_NOTICE, reliefById
} = require('./content/relief');
const growStrategies = require('./grow/strategies');
const safetyFlag = require('./grow/safety-flag');
const growSignals = require('./grow/signals');
const growCopy = require('./grow/copy');

module.exports = {
  PERSONAS,
  PERSONA_IDS,
  PersonaError,
  findPersona,
  isKnownBotId,
  listPersonaCards,
  runTurn,
  isSymptomTalk,
  buildContext,
  pickHistory,
  cleanHistory,
  isNoiseMessage,
  buildSystemPrompt,
  renderToneContent,
  renderToneBlock,
  TONE_MAX_CHARS,
  classify,
  LEVEL,
  detectSoftSignals,
  detectStructural,
  decide,
  applyCardAction,
  extractByRule,
  rankMemories,
  HOTLINES,
  PRIMARY_HOTLINE,
  PROVINCE_HOTLINES,
  HOTLINE_GUIDE,
  CRISIS_REPLY,
  RISK_REPLY,
  HOTLINE_CARD,
  boundaryCopy,
  sessionPolicy,
  RELIEF_EXERCISES,
  RELIEF_NOTICE,
  reliefById,
  growStrategies,
  safetyFlag,
  growSignals,
  growCopy
};
