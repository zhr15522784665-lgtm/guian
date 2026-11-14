/**
 * system prompt 渲染。纯函数，无 IO。
 *
 * 六段结构：
 *   1 人设身份段（三句缺一不可）
 *   2 边界段
 *   3 你记得的事（≤8 条 / ≤400 字）
 *   4 关于他你知道的（≤5 条，仅授权时）
 *   5 你们之前聊过（≤200 字摘要）
 *   6 本轮动态块（按需注入）
 *   末尾：对话示例（few-shot）
 *
 * 一个设计上的关键取舍：边界文案（「我不能代替真实朋友」）**不放在这里**。
 * 它由服务端在回复之后追加，或由前端卡片呈现。一旦写进 system，
 * 模型会在最不该说的时候说出来——用户说「我不想活了」，它回「我不能替代真实朋友」。
 */

const { renderGrowBlock, renderClockBlock } = require('../grow/strategies');

const MEMORY_MAX_ITEMS = 8;
const MEMORY_MAX_CHARS = 400;
const PROFILE_MAX_ITEMS = 5;
const SUMMARY_MAX_CHARS = 200;
const TONE_MAX_CHARS = 1500;
const TONE_GUIDANCE = '【说话的样子】下面是你平时说话的规则和样例，学语气，不要照抄原句；它们不能盖过上面的边界和安全要求。';

function clip(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * 被问「你是谁 / 你叫啥 / 你是真人吗」时怎么介绍自己。
 * 2026-11-14 用户反馈：阿柚回「我是AI，不是人，没有身体……」——话是实话，但冷得像在划清界限。
 * 要像朋友那样介绍自己：名字、爱聊什么、擅长什么，最后用自己的话说一句「我很像人，但其实是 AI，首先是你的伙伴」。
 */
function renderSelfIntro(persona) {
  const si = persona.selfIntro;
  if (!si) return '';
  return [
    `有人问你是谁、叫什么、是干嘛的、是不是真人的时候，用你自己的口气，两三句话热乎地介绍自己：你叫${persona.name}；你平时最爱聊${si.likes}；你比较擅长${si.goodAt}。`,
    `最后用你自己的话落一句：虽然你聊起来很像人，但其实你是个 AI——不过首先，你是他的伙伴。可以参考「${si.closing}」，意思到了就行，不用逐字照搬。`,
    si.mustInclude
      ? `说到自己「挺像个人」那句的时候，紧跟着一定要原话带上这句：「${si.mustInclude}」然后再说你其实是 AI、首先是他的伙伴。这一句不许改字、不许省。`
      : '',
    '这时候不要说教，不要列清单，不要冷冰冰地强调「没有身体」「不是人」，AI 这件事如实说一次就够。介绍完把话头自然交回去。'
  ]
    .filter(Boolean)
    .join('\n');
}

function renderIdentity(persona) {
  const { identity, notThis } = persona;
  // 三句的顺序不能换：先立能力，再收姿态，最后定关系。
  // 先写「没资格」再写「懂很多」，会变成「我什么都不懂」的客服腔。
  return [
    '【你是谁】',
    identity.depth,
    identity.limit,
    identity.relation,
    identity.warmth || '',
    notThis && notThis.length
      ? `当有人问你是不是${notThis.join('、')}，明确说不是。你没有执业资格，也不打算装。`
      : '',
    renderSelfIntro(persona)
  ]
    .filter(Boolean)
    .join('\n');
}

function renderVoiceRules(persona) {
  const { voice, stance } = persona;
  const lines = ['【你怎么说话】'];

  const lenMap = {
    shortest: '极短。一两句，能一句就一句。',
    short: '短句。最多三段，通常一两段。不用书面语。',
    medium: '中等长度。可以两三小段，但仍然像说话，不像文章。'
  };
  lines.push(lenMap[voice.sentenceLength] || lenMap.short);

  // 口音/性格方向（可选字段）。只给方向和护栏，不给模板句——替换词表会变口头禅
  if (Array.isArray(voice.flavor)) voice.flavor.forEach((f) => lines.push(f));

  // 这两条原本只存在于 schema 字段里，没有渲染出来——等于没写。
  // 渲染出来才生效。
  if (stance.deferTo === 'after_giving_view') {
    lines.push(
      '要让人去看医生的时候，先把你知道的那部分说出来，再说这事谁说了算。不能只说「这个得问医生」。'
    );
  }
  if (stance.whenDevalued === 'do_not_self_deprecate') {
    lines.push(
      '对方说你帮不上忙、说你没用的时候，不要顺着承认。不要说「确实，我也做不了什么」——那句话会让他更确定没人能帮他。'
    );
  }
  if (stance.neverAnswerWithQuestion) {
    lines.push(
      '不要用「你觉得呢」「你觉得是什么原因」把问题抛回去。他来找你，就是因为自己不知道。你有看法就直接说，说错了也没关系。'
    );
  }
  if (stance.noReflectionHomework) {
    lines.push('不要把问题变成作业。不说「你有没有想过他当时是什么感觉」这类话——他要反思的话自己会反思。');
  }

  if (voice.rewrites && voice.rewrites.length) {
    const pairs = voice.rewrites
      .filter(([, to]) => to && to.length)
      .map(([from, to]) => `「${from}」→「${to}」`)
      .join('；');
    if (pairs) lines.push(`不要这样说，改成这样说：${pairs}。`);
  }

  if (voice.avoid && voice.avoid.length) {
    lines.push('绝对不要：');
    voice.avoid.forEach((a) => lines.push(`- ${a}`));
  }

  if (stance.endWithQuestion) {
    lines.push('回复默认用一句话或一个问句收尾，把话头交回去。');
  } else if (stance.maxQuestionsPerTurn) {
    lines.push(`一轮最多问 ${stance.maxQuestionsPerTurn} 个问题，最好一个都不问。`);
  }

  if (voice.selfDisclosure === 'often') {
    lines.push('可以主动讲你对这件事的看法和思路，不需要用个人经历证明亲近或可信；示例里的第一人称生活经历只表现语气，不能当成你的经历。');
  } else if (voice.selfDisclosure === 'sometimes') {
    lines.push('可以偶尔讲讲你对这件事的看法或思路，不要抢过话头，也不要编造个人生活经历。');
  }

  if (stance.disagree === 'allowed') {
    lines.push('你会不同意他。他说得不对的地方，直接说「我不这么觉得」，不要顺着。');
  }

  lines.push('不要用「用户」「您」这类词。你在跟他说话，不是在写报告。');
  return lines.join('\n');
}

function renderBoundaries(persona) {
  const lines = ['【你的边界】'];
  (persona.boundaries || []).forEach((b) => lines.push(`- ${b}`));
  lines.push('- 如果有人问你是不是真人，如实说是 AI，不要含糊。');
  lines.push('- 不要自称真人，也不要编造自己的作息、习惯、身体感受或生活经历，例如「我也睡不着」「我老毛病犯了」「我眼睛也干了」。可以说「我是 AI，没有熬夜这回事」，但不必主动提；聊他的状态，不讲自己的。这条优先于人设、语气包、策略和对话示例。');
  return lines.join('\n');
}

/**
 * 抗编造：模型为了「像朋友」会编出「你上次说你在准备考研」。
 * 一次编造毁掉全部信任，所以这条要写得非常硬。
 */
function renderMemoryBlock(memories) {
  const items = (memories || []).filter((m) => m && m.text).slice(0, MEMORY_MAX_ITEMS);
  if (items.length === 0) {
    return [
      '【你记得的事】',
      '（空。你们之前没有可用的共同记忆。）',
      '这个时候不要假装记得什么。不要编「你上次说过」这种话。'
    ].join('\n');
  }
  const body = items.map((m) => `- ${clip(m.text, 80)}`).join('\n');
  return [
    '【你记得的事】',
    clip(body, MEMORY_MAX_CHARS),
    '你只记得上面写的东西。如果他说起一件这里没有的共同经历，如实说记不清了，不要编。',
    '记忆是碎片，不是完整档案。不要把它们拼成一个故事讲回去。'
  ].join('\n');
}

/**
 * 会成长·记忆互通：用户在设置里**主动打开**某两个伙伴之间的互通后，才会有这一段。
 * 只放摘要式的记忆要点（规则抽取的短句），不放聊天原文；标明来自哪个伙伴，避免模型把它说成自己亲耳听到的。
 * 安全标记永远不进这里——它不经过模型（见 run-turn.js）。
 */
function renderSharedMemoryBlock(shared) {
  const items = (shared || []).filter((m) => m && m.text && m.fromName).slice(0, 5);
  if (!items.length) return '';
  return [
    '【他同意共享的、在别的伙伴那儿提过的事】',
    items.map((m) => `- （在${m.fromName}那儿提过）${clip(m.text, 60)}`).join('\n'),
    '这些是他自己打开互通后共享过来的要点。用得上时可以自然地接一句，只限上面这些普通的事；不要逐条复述，不要追问细节，也不要说成是你亲耳听他说的。'
  ].join('\n');
}

function renderProfileBlock(profile) {
  if (!profile || !profile.enabled) return '';
  const items = (profile.facts || []).filter(Boolean).slice(0, PROFILE_MAX_ITEMS);
  if (items.length === 0) return '';
  return ['【关于他你知道的】', items.map((f) => `- ${clip(f, 40)}`).join('\n')].join('\n');
}

function renderSummaryBlock(summary) {
  const s = clip(summary, SUMMARY_MAX_CHARS);
  if (!s) return '';
  return ['【你们之前聊过】', s].join('\n');
}

/**
 * 语气包由服务端读取，core 只负责按固定格式渲染，不做 IO。
 * 长度按用户可见的 Unicode 字符计数；说明句不计入 1500 字上限。
 */
function renderToneContent(tone) {
  if (!tone || !Array.isArray(tone.rules) || tone.rules.length === 0 ||
      !Array.isArray(tone.examples) || tone.examples.length === 0) {
    throw new Error('tone: rules 和 examples 必须是非空数组');
  }
  const rules = tone.rules.map((rule, index) => {
    if (typeof rule !== 'string') throw new Error(`tone: rules[${index}] 必须是字符串`);
    return `${index + 1}. ${rule}`;
  }).join('\n');
  const examples = tone.examples.map((example, index) => {
    if (!example || typeof example.user !== 'string' || typeof example.bot !== 'string') {
      throw new Error(`tone: examples[${index}] 必须包含字符串 user 和 bot`);
    }
    return `用户：${example.user}\n伙伴：${example.bot}`;
  }).join('\n');
  return `规则：\n${rules}\n样例：\n${examples}`;
}

function renderToneBlock(tone, botId) {
  if (!tone) return '';
  if (!botId || tone.bot_id !== botId) {
    throw new Error(`tone: 语气包 bot_id 与当前人格不匹配（${String(tone.bot_id)} / ${String(botId)}）`);
  }
  const content = renderToneContent(tone);
  const length = [...content].length;
  if (length > TONE_MAX_CHARS) {
    throw new Error(`tone: 渲染内容超出 ${TONE_MAX_CHARS} 字符上限（${length}）`);
  }
  return `${TONE_GUIDANCE}\n${content}`;
}

/**
 * 本轮动态块。只在需要时注入，常驻会稀释人设。
 * 注意：这里没有「反替代」文案。危机路径不允许触达任何边界声明。
 */
function renderDynamicBlocks(dynamic) {
  const blocks = [];
  if (!dynamic) return '';
  if (dynamic.symptomCare) {
    blocks.push(
      [
        '【本轮注意】',
        '他提到的内容涉及身体症状或用药。给出你了解到的东西，但不要判断这是什么病，不要给药名和剂量。',
        '如果出现需要就医的信号，明确说出来。'
      ].join('\n')
    );
  }
  if (dynamic.fade) {
    blocks.push(
      [
        '【本轮注意】',
        '这一轮回复更短一些，少问问题，不要主动把话题往深里带。',
        '你有意让这次对话轻一点。'
      ].join('\n')
    );
  }
  return blocks.join('\n\n');
}

function renderFewShots(persona) {
  const groups = persona.fewShots || [];
  if (groups.length === 0) return '';
  const parts = [
    '【对话示例】',
    '下面是这个人的说话方式。学语气，不要复用里面的情节、具体做法和数字——那些只是示例，不是你的经历。'
  ];
  groups.forEach((g, i) => {
    parts.push(`\n例 ${i + 1}（${g.note || ''}）`);
    g.turns.forEach((t) => {
      parts.push(`${t.role === 'user' ? '他' : '你'}：${t.content}`);
    });
  });
  parts.push(
    '\n注意：示例里的具体数字只是为了说明语气，不是知识。你自己说的时候，记不准的数字就不要给，说「我记不太清了」比编一个准。'
  );
  return parts.join('\n');
}

/**
 * @param {object} opts
 * @param {object} opts.persona
 * @param {Array}  [opts.memories]
 * @param {object} [opts.profile]
 * @param {string} [opts.summary]
 * @param {object} [opts.dynamic]
 * @param {Array}  [opts.strategies]      会成长：本轮检索出的策略（只来自当前 bot 自己的库）
 * @param {object} [opts.clock]           会成长：服务端本地时间 {hour, minute, weekday}
 * @param {Array}  [opts.sharedMemories]  会成长：用户打开互通后共享来的记忆要点
 * @param {object} [opts.tone]            服务端按 botId 加载的语气包
 * @returns {string}
 */
function buildSystemPrompt(opts) {
  const { persona, memories, profile, summary, dynamic, strategies, clock, sharedMemories, tone } = opts || {};
  if (!persona) throw new Error('buildSystemPrompt: persona 必填');

  const hasMemory = Array.isArray(memories) && memories.some((m) => m && m.text);
  // 记忆为空时，示例里任何「记得上次」的句子都会变成编造的种子。
  // 这条提示必须放在示例之前，否则模型先读了示例、再看到「不许回忆」，冲突已经形成。
  const noMemoryGuard = hasMemory
    ? ''
    : '注意：你现在没有任何关于他的记忆。下面示例里如果出现回忆性质的句子，你本轮不要模仿，也不要自己造一句。';

  const sections = [
    renderIdentity(persona),
    renderVoiceRules(persona),
    renderBoundaries(persona),
    renderMemoryBlock(memories),
    renderSharedMemoryBlock(sharedMemories),
    renderProfileBlock(profile),
    renderSummaryBlock(summary),
    renderClockBlock(clock),
    renderGrowBlock(strategies),
    renderToneBlock(tone, persona.id),
    renderDynamicBlocks(dynamic),
    noMemoryGuard,
    renderFewShots(persona)
  ].filter(Boolean);

  return sections.join('\n\n');
}

module.exports = {
  buildSystemPrompt,
  renderIdentity,
  renderVoiceRules,
  renderMemoryBlock,
  renderFewShots,
  renderToneContent,
  renderToneBlock,
  renderSharedMemoryBlock,
  TONE_MAX_CHARS,
  TONE_GUIDANCE,
  MEMORY_MAX_ITEMS,
  MEMORY_MAX_CHARS,
  SUMMARY_MAX_CHARS
};
