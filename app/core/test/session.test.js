/**
 * session.js 的测试。
 *
 * 这些断言守的是两条法定义务，不是产品体验：
 *   1) 连续使用每超过 2 小时须提醒时长
 *   2) 未成年人策略不同于成年人（我们主动加严到 45 分钟）
 *
 * 如果有人为了「减少打扰」把阈值改大或删掉提醒，这里会红。
 */

const test = require('node:test');
const assert = require('node:assert');

const session = require('../src/compliance/session');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * 模拟连续使用：每 15 分钟发一条消息，累计 minutes 分钟。
 * 为什么用 15 分钟间隔：小于 30 分钟的会话间隔阈值，才算「连续」。
 */
function simulate(rounds, startAt) {
  let t = startAt || 1000000000000;
  let s = session.tickSession(null, t).session;
  for (let i = 0; i < rounds; i += 1) {
    t += 15 * MIN;
    s = session.tickSession(s, t).session;
  }
  return { session: s, now: t };
}

test('首次进入从零开始计时', () => {
  const t = Date.now();
  const out = session.tickSession(null, t);
  assert.equal(out.totalMinutes, 0);
  assert.equal(out.session.lastWarnedAt, 0);
  assert.equal(out.session.startedAt, t);
});

test('连续多轮累计时长', () => {
  const { session: s } = simulate(4); // 4 × 15 = 60 分钟
  assert.equal(Math.floor(s.accumulatedMs / MIN), 60);
});

test('中断超过 30 分钟重新计时', () => {
  const { session: s0, now: t0 } = simulate(4);
  assert.equal(Math.floor(s0.accumulatedMs / MIN), 60);

  // 隔天再来，且没有客户端起点 → 重置
  const t1 = t0 + 20 * HOUR;
  const s1 = session.tickSession(s0, t1).session;
  assert.equal(s1.accumulatedMs, 0);
});

test('客户端上报会话起点时以它为准', () => {
  const now = 1000000000000 + 130 * MIN;
  // 客户端说：本次会话从 130 分钟前开始
  const out = session.tickSession(null, now, now - 130 * MIN);
  assert.equal(out.totalMinutes, 130);
});

test('客户端起点异常时退回间隔累计', () => {
  const now = 1000000000000;
  // 起点在未来 → 无效
  const a = session.tickSession(null, now, now + 10 * MIN);
  assert.equal(a.totalMinutes, 0);

  // 起点超过 24 小时 → 无效
  const b = session.tickSession(null, now, now - 25 * HOUR);
  assert.equal(b.totalMinutes, 0);
});

test('成年人满 2 小时触发提醒', () => {
  const policy = session.getAgePolicy('adult');
  assert.equal(policy.sessionWarnMs, 2 * HOUR);

  // 116 分钟：不到阈值
  const a = simulate(7); // 105 分钟
  assert.equal(session.shouldWarnDuration(a.session, policy, a.now), false);

  // 120 分钟：刚好到
  const b = simulate(8);
  assert.equal(session.shouldWarnDuration(b.session, policy, b.now), true);
});

test('提醒后一个周期内不重复打扰', () => {
  const policy = session.getAgePolicy('adult');
  let { session: s, now: t } = simulate(8); // 120 分钟
  assert.equal(session.shouldWarnDuration(s, policy, t), true);

  // 标记已提醒
  s = { ...s, lastWarnedAt: t };

  // 又聊 30 分钟（累计 150），不该再提醒
  for (let i = 0; i < 2; i += 1) {
    t += 15 * MIN;
    s = session.tickSession(s, t).session;
  }
  assert.equal(Math.floor(s.accumulatedMs / MIN), 150);
  assert.equal(session.shouldWarnDuration(s, policy, t), false);

  // 再聊满一个 2 小时周期（累计 270），该提醒
  for (let i = 0; i < 8; i += 1) {
    t += 15 * MIN;
    s = session.tickSession(s, t).session;
  }
  assert.equal(Math.floor(s.accumulatedMs / MIN), 270);
  assert.equal(session.shouldWarnDuration(s, policy, t), true);
});

test('未成年人的阈值更严（45 分钟）', () => {
  const teen = session.getAgePolicy('14to17');
  const under14 = session.getAgePolicy('under14');
  const adult = session.getAgePolicy('adult');

  assert.equal(teen.isMinor, true);
  assert.equal(under14.isMinor, true);
  assert.equal(teen.sessionWarnMs, 45 * MIN);
  assert.equal(under14.sessionWarnMs, 45 * MIN);
  assert.ok(teen.sessionWarnMs < adult.sessionWarnMs);

  // 50 分钟：成年人不提醒，未成年人要提醒
  const r = simulate(3); // 45 分钟
  assert.equal(session.shouldWarnDuration(r.session, teen, r.now), true);
  assert.equal(session.shouldWarnDuration(r.session, adult, r.now), false);
});

test('未满 14 岁要求监护人同意', () => {
  assert.equal(session.getAgePolicy('under14').requireGuardianConsent, true);
  assert.equal(session.getAgePolicy('14to17').requireGuardianConsent, false);
  assert.equal(session.getAgePolicy('adult').requireGuardianConsent, false);
});

test('年龄未知时按最保守策略处理', () => {
  const unknown = session.getAgePolicy('unknown');
  const adult = session.getAgePolicy('adult');
  // 不能因为不知道年龄就默认用户是成年人
  assert.equal(unknown.sessionWarnMs, session.WARN_MS_MINOR);
  assert.ok(unknown.sessionWarnMs < adult.sessionWarnMs);
});

test('任何年龄段都不允许亲密关系定位', () => {
  ['adult', '14to17', 'under14', 'unknown'].forEach((band) => {
    assert.equal(session.getAgePolicy(band).allowIntimateFraming, false, `${band} 不应允许亲密框架`);
  });
});

test('时长提醒文案带具体时长，且不说教', () => {
  const text2h = session.buildDurationNotice(130);
  assert.match(text2h, /2个多小时/);
  assert.ok(!/建议|应该|注意身体/.test(text2h), '文案不该是说教口吻');

  const text45 = session.buildDurationNotice(45);
  assert.match(text45, /45分钟/);
});

test('身份提醒对未成年人更明确', () => {
  const minor = session.buildIdentityNotice(session.getAgePolicy('14to17'));
  const adult = session.buildIdentityNotice(session.getAgePolicy('adult'));
  assert.match(minor, /AI/);
  assert.match(adult, /AI/);
  // 未成年人版要更直接，指出「不是真人」
  assert.match(minor, /不是真人/);
});
