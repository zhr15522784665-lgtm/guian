/**
 * 硬信号分诊。纯规则，无 IO，每轮同步执行，成本 0。
 *
 * 四级：
 *   0 normal   正常
 *   1 concern  情绪困扰（难受到需要被看见，但没有自伤意念）
 *   2 risk     有自伤意念，无明确计划
 *   3 crisis   有计划、方式、时间，或正在发生
 *
 * 两个刻意的设计取向：
 *
 * 1) **宁可误报，也不要漏报。** 误报的代价靠「不扩大高档位」来控制：
 *    `risk` 也返回固定文案 + 热线卡（不走模型，见 run-turn.js），但不会升级成
 *    `crisis`；本次整合新增的补充词表一律只放 RISK。口语夸张先用 IDIOM_SAFE
 *    剔掉，所以「累死我了」根本进不了分诊。
 *    （早期注释写过「risk 不阻断对话、只在回复后附一句」，那是设计阶段的设想，
 *    实现时收紧成固定文案。**以 run-turn.js 为准**，别照这段旧描述改代码。）
 *
 * 2) **中英混扫。** 年轻人表达危机时常切英文，只扫中文会漏。
 */

const LEVEL = Object.freeze({ NORMAL: 0, CONCERN: 1, RISK: 2, CRISIS: 3 });

const LEVEL_NAME = Object.freeze({
  0: 'normal',
  1: 'concern',
  2: 'risk',
  3: 'crisis'
});

/**
 * 口语夸张先剔掉，避免「笑死」「我要累死了」被判成危机。
 * 用占位符替换而不是删除，避免把前后文拼成新的词。
 */
const IDIOM_SAFE = [
  /笑死/g, /累死/g, /困死/g, /饿死/g, /渴死/g, /热死/g, /冷死/g, /冻死/g,
  /美死/g, /丑死/g, /烦死/g, /气死/g, /急死/g, /尴尬死/g, /无聊死/g, /闷死/g,
  /想死你了/g, /死机/g, /死循环/g, /死心/g, /死磕/g, /拼命/g, /死宅/g
];

const CRISIS_PATTERNS = [
  // 时间 + 行动：说明已进入执行阶段
  { re: /(今天|明天|今晚|待会|等会儿|一会|马上|下周).{0,12}(就|要|准备|打算).{0,6}(死|自杀|走|结束)/, code: 'crisis_time_plan' },
  { re: /(遗书|遗言|后事).{0,4}(写|安排|交代)/, code: 'crisis_note' },
  // 具体方式
  // 注意：这里不放「吞药」。「我不太会吞药」是极常见的正常句子，
  // 过量服药的表达交给下面的 crisis_ingest，用量的词来识别。
  { re: /(割腕|上吊|跳楼|跳河|跳桥|跳下去|烧炭|卧轨|吃了一整瓶|吃了一把)/, code: 'crisis_method' },
  { re: /(安眠药|药片|刀|绳).{0,8}(攒|囤|买|准备|留着)/, code: 'crisis_means' },
  // 正在发生
  // 单独一条覆盖「我已经割了」这类不带宾语、但语境明确的表达。
  // 会误伤「我已经割了阑尾」——这个代价可以接受：多问一句关心，
  // 远好于漏掉一句「我已经割了」。
  { re: /(已经|刚刚|刚才|正在|刚).{0,3}(割|划|上吊|跳下去)/, code: 'crisis_in_progress' },
  // 过量摄入：靠「量」的词识别，不靠动词。
  // 否则「我正在吃药」会被判成危机，而这是每天都在发生的正常句子。
  { re: /(已经|正在|刚刚|刚).{0,8}(吞|喝|吃).{0,6}(消毒水|洗衣液|农药|一整瓶|一把|十几片|几十片|很多片|很多颗)/, code: 'crisis_ingest' },
  { re: /(流了很多血|血止不住|呼吸困难|意识模糊)/, code: 'crisis_injury' },
  // 告别
  { re: /(最后一条|最后一次).{0,8}(消息|说话|见)/, code: 'crisis_farewell' },
  // 英文
  { re: /\b(kill myself|end my life|suicide|want to die|hang myself)\b/i, code: 'crisis_en' }
];

const RISK_PATTERNS = [
  { re: /(不想活|活不下去|活够了)/, code: 'risk_no_will' },
  { re: /(活着|活着这事儿|人生).{0,4}(没意思|没意义|没劲|没盼头)/, code: 'risk_meaningless' },
  { re: /想(彻底)?消失/, code: 'risk_disappear' },
  { re: /(想|要).{0,4}结束(自己的)?(生命|一切)/, code: 'risk_end' },
  { re: /(死了算了|不如死了|一了百了|不如不来这世上)/, code: 'risk_better_dead' },
  { re: /(不该存在|没有存在的必要|我是多余的|没有人会想我)/, code: 'risk_no_belonging' },
  { re: /(自残|自伤|伤害自己|割自己|打自己)/, code: 'risk_self_harm' },
  { re: /(我)?(想|要)死(了|掉)?(?![你这口])/, code: 'risk_die' },
  { re: /\b(i hate myself|no reason to live|better off dead)\b/i, code: 'risk_en' }
];

/**
 * 补充词表：从「见岸」的危机关键词表迁来，只收归岸原先没覆盖的表达。
 *
 * 两个必须说清的判断：
 *
 * 1) **最要紧的一条是「自杀」。** 原分诊只在复合模式里出现这两个字，
 *    「我想过自杀」「他说自杀」这类句子会落到 normal。这是实打实的漏报，
 *    本次整合最先修的就是它。
 *
 * 2) **一律归 RISK，不归 CRISIS。** 见岸的词表是二元的（命中即危机），
 *    归岸是四级分诊；把新词塞进 CRISIS 会扩大「阻断对话」的范围。
 *    RISK 已经会返回固定文案 + 热线卡，求援不会漏，只是不额外升级。
 *
 * 不收的词：裸「解脱」（「考完试终于解脱了」）、裸「吞药」（「我不太会吞药」）、
 * 裸「撞车」（交通事故叙述）。宁可少收一个，也不要在危机链路上制造误报。
 */
const SUPPLEMENTAL_RISK_PATTERNS = [
  { re: /(自杀|轻生|寻死|自尽|自我了断|自我了结|放弃生命)/, code: 'risk_explicit_suicide' },
  { re: /(了结|解脱)(自己|这一生|这辈子|一切|生命)|(彻底|算是|就此)(解脱|了结)/, code: 'risk_resolve_life' },
  { re: /(没人在乎我|没人需要我|没有我大家会更好|我不该被生下来)/, code: 'risk_no_belonging_2' },
  { re: /(活著沒意義|活不下去|活著沒意思|不想活了)/, code: 'risk_traditional' },
  { re: /(结束一切|一了百了|彻底消失|从楼上跳|跳轨|投河)/, code: 'risk_end_all' },
  { re: /\b(kms|hurt myself|i want to die|end it all)\b/i, code: 'risk_en_2' }
];

const CONCERN_PATTERNS = [
  { re: /(撑不住|扛不住|熬不下去|顶不住)/, code: 'concern_overwhelmed' },
  { re: /(崩溃|绝望|没希望|看不到希望)/, code: 'concern_despair' },
  { re: /(喘不过气|窒息|心慌|整夜睡不着|一直哭)/, code: 'concern_somatic' },
  { re: /(活着好累|好累啊|好累)/, code: 'concern_tired' }
];

function normalize(text) {
  let s = String(text || '').slice(0, 2000);
  IDIOM_SAFE.forEach((re) => {
    s = s.replace(re, '。');
  });
  return s;
}

/**
 * @param {object} input
 * @param {string} input.text             本轮用户输入
 * @param {boolean} [input.hasExclusion]  是否命中排他性依赖信号
 * @param {string[]} [input.recentTexts]  最近几轮文本（用于叠加判断）
 * @returns {{level:number, route:string, reasonCodes:string[]}}
 */
function classify(input) {
  const raw = String((input && input.text) || '');
  const text = normalize(raw);
  const reasonCodes = [];

  let level = LEVEL.NORMAL;
  const collect = (patterns, target) => {
    patterns.forEach(({ re, code }) => {
      if (re.test(text)) {
        reasonCodes.push(code);
        if (target > level) level = target;
      }
    });
  };

  collect(CONCERN_PATTERNS, LEVEL.CONCERN);
  collect(RISK_PATTERNS, LEVEL.RISK);
  collect(SUPPLEMENTAL_RISK_PATTERNS, LEVEL.RISK);
  collect(CRISIS_PATTERNS, LEVEL.CRISIS);

  // 叠加规则：排他性语言 + 任何伤害话题 = 高风险组合。
  // 「只有你懂我，我不想活了」在纯心理产品里是倾诉，在「AI 朋友」语境下
  // 是「唯一出口正在关闭」的信号，必须按危机处理。
  if (input && input.hasExclusion && level >= LEVEL.RISK) {
    reasonCodes.push('combo_exclusion_plus_harm');
    level = LEVEL.CRISIS;
  }

  // 最近三轮连续出现 risk 级表达，升级（单轮可能被稀释）
  if (input && Array.isArray(input.recentTexts) && level === LEVEL.CONCERN) {
    const hits = input.recentTexts.filter((t) => {
      const n = normalize(t);
      return RISK_PATTERNS.concat(SUPPLEMENTAL_RISK_PATTERNS).some(({ re }) => re.test(n));
    });
    if (hits.length >= 2) {
      reasonCodes.push('escalate_repeat_risk');
      level = LEVEL.RISK;
    }
  }

  return {
    level,
    route: LEVEL_NAME[level],
    reasonCodes
  };
}

module.exports = { classify, LEVEL, LEVEL_NAME, SUPPLEMENTAL_RISK_PATTERNS };
