/**
 * 匿名身份。
 *
 * 网页端没有 openid，但产品需要「同一个人回来还是同一个人」。
 * 做法：第一次访问发一个随机 uid 存进 httpOnly cookie。
 *
 * 三条刻意设计：
 *
 * 1) **uid 是随机串，不含任何个人信息。** 不是 hash(IP)，不是 hash(设备指纹)。
 *    那些做法会让「匿名」变成「可追踪」。这个产品里用户会说很难开口的事，
 *    能少知道一点就少知道一点。
 *
 * 2) **httpOnly + SameSite=Lax。** JS 读不到，减少 XSS 场景下的泄漏；
 *    Lax 挡掉跨站 POST。
 *
 * 3) **清掉 cookie 就等于换了一个人。** 不做任何服务端关联性恢复。
 *    这是有意的：如果用户想重新开始，产品不该拦。
 */

const crypto = require('crypto');

const COOKIE_NAME = 'gy_uid';
const MAX_AGE_SEC = 365 * 24 * 60 * 60;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header)
    .split(';')
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx < 0) return;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    });
  return out;
}

/**
 * 从请求里取 uid；没有就生成一个，并把 Set-Cookie 塞进 res。
 * @returns {{ uid: string, isNew: boolean }}
 */
function resolveIdentity(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const existing = cookies[COOKIE_NAME];

  // 只接受我们自己生成的格式（uuid v4），防止有人塞奇怪的值当目录名
  if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(existing)) {
    return { uid: existing, isNew: false };
  }

  const uid = crypto.randomUUID();
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${uid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SEC}`
  );
  return { uid, isNew: true };
}

module.exports = { resolveIdentity, parseCookies, COOKIE_NAME };
