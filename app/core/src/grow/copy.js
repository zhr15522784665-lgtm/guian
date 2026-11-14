const { findPersona } = require('../personas');

const LEAVE_PROMPTS = Object.freeze({
  health: '刚才是我说多了，还是没听准？愿意的话选一下，直接关掉也行。',
  growth: '刚才哪儿没对上？点一个就行，不想选就直接关掉。',
  listener: '刚才我哪儿没接住？愿意就点一下，直接关掉也行嗷。'
});

function leavePrompt(botId) {
  findPersona(botId);
  return LEAVE_PROMPTS[botId];
}

module.exports = { leavePrompt };
