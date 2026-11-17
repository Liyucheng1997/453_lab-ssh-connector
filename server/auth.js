// 访问密码与登录态。登录态是带 HMAC 签名的 Cookie，服务重启后依然有效；修改密码会让旧登录全部失效。
const crypto = require('crypto');
const store = require('./store');

const COOKIE = 'yq_token';
const TTL = 7 * 24 * 3600 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [kind, salt, hash] = stored.split(':');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function issueToken() {
  const cfg = store.getConfig();
  const payload = `${Date.now() + TTL}.${cfg.authVersion}`;
  return `${payload}.${sign(payload, cfg.authSecret)}`;
}

function checkToken(token) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const [exp, ver, sig] = parts;
  const cfg = store.getConfig();
  if (!cfg.passwordHash) return false;
  if (Number(exp) < Date.now() || Number(ver) !== cfg.authVersion) return false;
  const expected = sign(`${exp}.${ver}`, cfg.authSecret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  return checkToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function setCookie(res, token, secure) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(TTL / 1000)}`];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/* 登录失败限速：同一 IP 连续失败 5 次后锁定 60 秒 */
const failures = new Map();
function lockedSeconds(ip) {
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
  return 0;
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) {
    f.until = Date.now() + 60_000;
    f.count = 0;
  }
  failures.set(ip, f);
}
function clearFailures(ip) {
  failures.delete(ip);
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  isAuthed,
  setCookie,
  clearCookie,
  lockedSeconds,
  recordFailure,
  clearFailures,
};
