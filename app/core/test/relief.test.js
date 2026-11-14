/**
 * 解压练习数据的结构约束。
 *
 * 这些断言不是为了测数据「对不对」，是为了守住见岸踩过的坑：
 * 一个练习如果没写「可以随时停」或没写「不上传不保存」，
 * 它在产品里就变成了「逼着用户做完」和「偷偷记下来」——都不能接受。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  RELIEF_EXERCISES,
  RELIEF_NOTICE,
  reliefById
} = require('../src/content/relief');

const KINDS = new Set(['write', 'paced', 'choice', 'checklist']);

test('有 6 个练习，id 唯一且可查', () => {
  assert.equal(RELIEF_EXERCISES.length, 6);
  const ids = RELIEF_EXERCISES.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(reliefById('breath-bubble').name, '呼吸泡泡');
  assert.equal(reliefById('不存在'), null);
});

test('每个练习的字段齐全', () => {
  RELIEF_EXERCISES.forEach((x) => {
    ['name', 'emoji', 'tagline', 'mechanism', 'intro', 'closing', 'ip'].forEach((k) => {
      assert.ok(typeof x[k] === 'string' && x[k].length > 0, `${x.id} 缺 ${k}`);
    });
    assert.ok(KINDS.has(x.kind), `${x.id} 的 kind 不认识：${x.kind}`);
    assert.equal(typeof x.durationSec, 'number', `${x.id} 的时长应为数字`);
    assert.ok(x.steps.length >= 3, `${x.id} 步骤太少`);
    assert.ok(x.safety.length >= 3, `${x.id} 安全边界太少`);
    assert.ok(x.evidence.length >= 2, `${x.id} 证据太少`);
  });
});

test('每条证据都写清出处、定位和效应量级，不写空泛结论', () => {
  RELIEF_EXERCISES.forEach((x) => {
    x.evidence.forEach((e) => {
      assert.ok(e.ref && e.locator && e.note, `${x.id} 有证据缺字段`);
      assert.ok(!/^有效$|^显著改善$/.test(String(e.note).trim()), `${x.id} 证据写成结论了`);
    });
  });
});

test('每个练习都允许随时停下', () => {
  RELIEF_EXERCISES.forEach((x) => {
    const joined = x.safety.join(' ');
    assert.ok(/停|跳过|结束|离开/.test(joined), `${x.id} 没写「可以停」`);
  });
});

test('每个练习都声明了隐私边界：不上传、不保存、不进记忆', () => {
  RELIEF_EXERCISES.forEach((x) => {
    const joined = x.safety.join(' ');
    assert.ok(/不上传|不保存/.test(joined), `${x.id} 没写不上传/不保存`);
    assert.ok(/不进|不会进/.test(joined), `${x.id} 没写不进记忆`);
  });
});

test('至少有练习在安全边界里给出热线或找人的指引', () => {
  const joined = RELIEF_EXERCISES.map((x) => x.safety.join(' ')).join(' ');
  assert.match(joined, /12356/);
  assert.match(joined, /联系身边的人|身边的人/);
});

test('说明文案不含面向特定病症的表述，且保留求助指引', () => {
  const all = JSON.stringify({ RELIEF_EXERCISES, RELIEF_NOTICE });
  assert.ok(!/强迫|ERP|见岸/.test(all), '还残留见岸/OCD 语境的文案');
  assert.match(RELIEF_NOTICE.disclaimer, /12356/);
  assert.match(RELIEF_NOTICE.body, /不经过 AI/);
  assert.match(RELIEF_NOTICE.body, /不会上传|不上传/);
});

test('呼吸与肌肉练习的节拍是公开生理参数，不含憋气指令', () => {
  const paced = RELIEF_EXERCISES.filter((x) => x.kind === 'paced');
  assert.equal(paced.length, 2);
  paced.forEach((x) => {
    assert.ok(x.safety.join(' ').includes('不憋气') || /全程正常呼吸/.test(x.safety.join(' ')),
      `${x.id} 没提醒不要憋气`);
  });
  const bubble = reliefById('breath-bubble');
  assert.equal(bubble.pace.inhaleMs, 4000);
  assert.equal(bubble.pace.exhaleMs, 6000);
  assert.ok(bubble.pace.exhaleMs > bubble.pace.inhaleMs, '呼气应当长于吸气');
});
