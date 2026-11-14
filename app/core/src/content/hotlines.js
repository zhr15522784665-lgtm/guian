/**
 * 热线与专业资源。
 *
 * 纪律（见 knowledge/04）：
 *   1) 只写号码与可核事实，不写「接通率」这类会过期的统计。
 *   2) 危机文案只从这里取号，模型不得自行生成号码（content-safe.js 会兜底替换）。
 *   3) 12356 是唯一的首选。其余号码都是「补充」，不是并列选项。
 *
 * 数据来源分两层，可信度不同，不要混用：
 *
 *   HOTLINES          全国通用 + 急救报警。经过核对，**同时作为模型输出的号码白名单**。
 *   PROVINCE_HOTLINES 各省本地补充号，从「见岸」项目迁来（原注释：数据截至
 *                     2025–2026，来源国家卫健委及各地精神卫生中心）。
 *                     **未逐条独立复核**，标为【待验证】，且**不进白名单**——
 *                     模型若自己编出这些号码，替换掉比放行安全。
 *
 * 为什么仍然保留省份数据：人在慌的时候会想找「离我最近的」，这是真实需求。
 * 做法是把 12356 顶在最上面、明确写出「打不通就回到 12356」，
 * 而不是把一堆可能过期的号码摆成同等选项。
 */

const HOTLINES = Object.freeze([
  {
    id: '12356',
    name: '全国心理援助热线',
    number: '12356',
    note: '24 小时 · 全国 · 免费',
    primary: true,
    action: 'call',
    scope: 'nation'
  },
  {
    id: 'hope24',
    name: '希望 24 热线',
    number: '400-161-9995',
    note: '24 小时 · 学生按 1 / 抑郁与自伤防治按 2 / 生命热线按 3',
    primary: false,
    action: 'call',
    scope: 'nation'
  },
  {
    id: 'youth',
    name: '青少年服务台',
    number: '12355',
    note: '各地服务时间不同，多为工作日',
    primary: false,
    action: 'call',
    scope: 'nation'
  },
  {
    id: 'women',
    name: '妇女维权公益热线',
    number: '12338',
    note: '以工作日为主',
    primary: false,
    action: 'call',
    scope: 'nation'
  },
  {
    id: 'bj-crisis',
    name: '北京心理危机研究与干预中心',
    number: '010-82951332',
    note: '24 小时',
    primary: false,
    action: 'call',
    scope: 'nation'
  },
  {
    id: 'emergency',
    name: '急救',
    number: '120',
    note: '已经受伤、或身边有危险物品时',
    primary: false,
    action: 'call',
    scope: 'emergency'
  },
  {
    id: 'police',
    name: '报警',
    number: '110',
    note: '当下有人身危险时',
    primary: false,
    action: 'call',
    scope: 'emergency'
  }
]);

const PRIMARY_HOTLINE = HOTLINES[0];

/**
 * 各省本地官方补充号。
 * h24=true 表示原资料标注 24 小时；false 时 time 给出可接通时段。
 * 这份数据是【待验证】，UI 上必须同时展示 HOTLINE_GUIDE.advice。
 */
const PROVINCE_HOTLINES = Object.freeze([
  { region: '北京', number: '010-82951332', org: '北京心理危机研究与干预中心', h24: true, time: '' },
  { region: '天津', number: '022-88188858', org: '天津市安定医院', h24: true, time: '' },
  { region: '河北', number: '0312-96312', org: '河北省精神卫生中心', h24: true, time: '' },
  { region: '山西', number: '0351-8726199', org: '山西省精神卫生中心', h24: true, time: '' },
  { region: '内蒙古', number: '0471-12320', org: '内蒙古自治区精神卫生中心', h24: true, time: '' },
  { region: '辽宁', number: '024-96687', org: '辽宁省精神卫生中心', h24: true, time: '' },
  { region: '吉林', number: '0431-89685000', org: '长春市第六医院', h24: true, time: '' },
  { region: '黑龙江', number: '0451-12320', org: '黑龙江省危机干预热线', h24: true, time: '' },
  { region: '上海', number: '021-962525', org: '上海市精神卫生中心', h24: true, time: '' },
  { region: '江苏', number: '025-83712977', org: '南京脑科医院（江苏省精神卫生中心）', h24: true, time: '' },
  { region: '浙江', number: '0571-85029595', org: '杭州市第七人民医院', h24: true, time: '' },
  { region: '安徽', number: '0551-63666903', org: '合肥市第四人民医院', h24: true, time: '' },
  { region: '福建', number: '0591-85666661', org: '福州神经精神病防治院', h24: true, time: '' },
  { region: '江西', number: '0791-966525', org: '江西省社会心理服务热线', h24: true, time: '' },
  { region: '山东', number: '0531-86336666', org: '山东省精神卫生中心', h24: false, time: '17:30–21:00（工作日）' },
  { region: '河南', number: '0373-7095888', org: '河南省精神卫生中心', h24: true, time: '' },
  { region: '湖北', number: '027-85844666', org: '武汉市精神卫生中心', h24: true, time: '' },
  { region: '湖南', number: '0731-85501010', org: '长沙市第九医院', h24: true, time: '' },
  { region: '广东', number: '020-81899120', org: '广州医科大学附属脑科医院', h24: true, time: '' },
  { region: '广西', number: '0772-3136120', org: '广西壮族自治区脑科医院', h24: true, time: '' },
  { region: '海南', number: '0898-96363', org: '海南省安宁医院', h24: true, time: '' },
  { region: '重庆', number: '023-96320', org: '重庆市精神卫生中心', h24: true, time: '' },
  { region: '四川', number: '028-87577510', org: '成都市第四人民医院', h24: true, time: '' },
  { region: '贵州', number: '0851-88417888', org: '贵州省第二人民医院', h24: false, time: '周一至周五 8:00–17:00' },
  { region: '云南', number: '0871-12320', org: '昆明心理危机研究与干预中心', h24: true, time: '' },
  { region: '西藏', number: '0891-12320', org: '西藏自治区卫健委', h24: false, time: '以当地最新公布为准' },
  { region: '陕西', number: '400-896-0960', org: '西安市精神卫生中心', h24: false, time: '8:00–22:00' },
  { region: '甘肃', number: '0931-12320', org: '兰州市精神卫生中心', h24: false, time: '8:00–22:00' },
  { region: '青海', number: '0971-8140371', org: '青海省第三人民医院', h24: true, time: '' },
  { region: '宁夏', number: '0951-2160707', org: '宁夏心理援助热线', h24: true, time: '' },
  { region: '新疆', number: '0991-3016111', org: '新疆心理援助热线', h24: true, time: '' }
]);

const HOTLINE_GUIDE = Object.freeze({
  primary: PRIMARY_HOTLINE.number,
  advice: '优先拨打 12356（全国统一、24 小时、免费）。本地号码可能变动，若占线或打不通，请回到 12356；已经受伤打 120。',
  asOf: '各省数据整理自 2025–2026 年公开资料，未逐条独立复核，以当地最新公布为准',
  verified: false
});

module.exports = {
  HOTLINES,
  PRIMARY_HOTLINE,
  PROVINCE_HOTLINES,
  HOTLINE_GUIDE
};
