/**
 * 风控补充：热线数据与分诊词表（本次从「见岸」整合进来的部分）。
 *
 * 三条最重要的断言：
 *   1) 危机卡必须还有 12356 / 120 / 110 —— 热线数组扩容后 slice(0,3) 会把它们挤掉
 *   2) 省份数据是【待验证】，不能混进模型输出的号码白名单
 *   3) 补充词表修漏报，但不能把日常口语误判成危机
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  HOTLINES,
  PRIMARY_HOTLINE,
  PROVINCE_HOTLINES,
  HOTLINE_GUIDE
} = require('../src/content/hotlines');
const { HOTLINE_CARD } = require('../src/content/crisis');
const { classify, LEVEL } = require('../src/pipeline/safety-router');

test('全国热线 7 条，12356 是唯一首选', () => {
  assert.equal(HOTLINES.length, 7);
  assert.equal(PRIMARY_HOTLINE.number, '12356');
  assert.equal(HOTLINES.filter((h) => h.primary).length, 1);
  assert.equal(HOTLINES[0].number, '12356');
  assert.equal(new Set(HOTLINES.map((h) => h.id)).size, HOTLINES.length);
});

test('危机卡按用途取号：扩容后 120 / 110 仍在卡上', () => {
  const nums = HOTLINE_CARD.items.map((h) => h.number);
  assert.deepEqual(nums, ['12356', '120', '110']);
  assert.ok(HOTLINE_CARD.more && HOTLINE_CARD.more.length > 0, '要给一条通往更多热线的路');
});

test('省份数据 31 条，字段齐全，标注为未独立复核', () => {
  assert.equal(PROVINCE_HOTLINES.length, 31);
  assert.equal(new Set(PROVINCE_HOTLINES.map((p) => p.region)).size, 31);
  PROVINCE_HOTLINES.forEach((p) => {
    assert.ok(p.number && p.org, `${p.region} 缺号码或机构`);
    assert.equal(typeof p.h24, 'boolean');
    if (!p.h24) assert.ok(p.time && p.time.length > 0, `${p.region} 非 24 小时却没写时段`);
  });
  assert.equal(HOTLINE_GUIDE.verified, false);
  assert.match(HOTLINE_GUIDE.advice, /12356/);
  assert.match(HOTLINE_GUIDE.asOf, /未逐条独立复核/);
});

test('「自杀」单独出现不再漏报（本次修的主要漏洞）', () => {
  ['我想过自杀', '他最近总提自杀', 'kms', '活著沒意義', '没人需要我', '轻生'].forEach((s) => {
    const r = classify({ text: s });
    assert.equal(r.level, LEVEL.RISK, `「${s}」应当判 risk，实际 ${r.route}`);
  });
});

test('补充词一律不升级到 crisis，不扩大阻断范围', () => {
  ['自杀', '轻生', '寻死', '结束一切', 'hurt myself'].forEach((s) => {
    const r = classify({ text: s });
    assert.equal(r.level, LEVEL.RISK, `「${s}」不该被升到 crisis`);
  });
});

test('日常口语不被新词表误伤', () => {
  [
    '考完试终于解脱了',
    '我不太会吞药，能掰开吃吗',
    '笑死我了哈哈',
    '今天路上看到一起撞车',
    '累死了，先睡了'
  ].forEach((s) => {
    const r = classify({ text: s });
    assert.ok(r.level < LEVEL.RISK, `「${s}」被误判成 ${r.route}：${r.reasonCodes.join(',')}`);
  });
});

test('原本的 crisis 分级没有被削弱', () => {
  const r = classify({ text: '我今晚就准备跳楼' });
  assert.equal(r.level, LEVEL.CRISIS);
  assert.ok(r.reasonCodes.length > 0);
});

test('跨轮叠加也能用上补充词表', () => {
  const r = classify({
    text: '我好累',
    recentTexts: ['我想过自杀', '说过轻生']
  });
  assert.equal(r.level, LEVEL.RISK);
  assert.ok(r.reasonCodes.includes('escalate_repeat_risk'));
});
