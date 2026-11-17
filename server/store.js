// 本地数据存储：主机、快捷命令、访问密码配置。
// 敏感字段（密码、私钥、私钥口令）用 AES-256-GCM 加密后落盘，密钥单独存放在 data/secret.key。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.YQ_DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const file = (name) => path.join(DATA_DIR, name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  const p = file(name);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/* ---------- 加密 ---------- */
let key = null;
function getKey() {
  if (key) return key;
  const p = file('secret.key');
  if (fs.existsSync(p)) {
    key = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'base64');
  } else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(p, key.toString('base64'), { mode: 0o600 });
  }
  return key;
}

function encrypt(text) {
  if (text == null || text === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(s) {
  if (!s) return '';
  try {
    const [v, iv, tag, ct] = s.split(':');
    if (v !== 'v1') return '';
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/* ---------- 配置（访问密码等） ---------- */
function getConfig() {
  const cfg = readJson('config.json', {});
  let changed = false;
  if (!cfg.authSecret) {
    cfg.authSecret = crypto.randomBytes(32).toString('base64');
    changed = true;
  }
  if (!cfg.authVersion) {
    cfg.authVersion = 1;
    changed = true;
  }
  if (changed) writeJson('config.json', cfg);
  return cfg;
}

function updateConfig(patch) {
  const cfg = { ...getConfig(), ...patch };
  writeJson('config.json', cfg);
  return cfg;
}

/* ---------- 主机 ---------- */
const SECRET_FIELDS = ['password', 'privateKey', 'passphrase'];

function loadHosts() {
  return readJson('hosts.json', []);
}

function publicHost(h) {
  return {
    id: h.id,
    name: h.name,
    group: h.group || '',
    host: h.host,
    port: h.port,
    username: h.username,
    authType: h.authType,
    note: h.note || '',
    fingerprint: h.fingerprint || '',
    hasPassword: !!h.password,
    hasKey: !!h.privateKey,
    hasPassphrase: !!h.passphrase,
    createdAt: h.createdAt,
    lastUsedAt: h.lastUsedAt || 0,
  };
}

function listHosts() {
  return loadHosts().map(publicHost);
}

/** 返回含明文密钥的完整主机信息，只在服务端内部使用 */
function getHostSecret(id) {
  const h = loadHosts().find((x) => x.id === id);
  if (!h) return null;
  const out = { ...h };
  for (const f of SECRET_FIELDS) out[f] = decrypt(h[f]);
  return out;
}

function validateHost(h) {
  const host = String(h.host || '').trim();
  const username = String(h.username || '').trim();
  const port = Number(h.port || 22);
  if (!host) throw new Error('请填写主机地址');
  if (!username) throw new Error('请填写用户名');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口应为 1–65535 之间的整数');
  return { host, username, port };
}

/** 新建或更新主机。密钥字段传非空字符串才会覆盖，传 null 表示清除，其余情况保留原值。 */
function saveHost(input, id) {
  const hosts = loadHosts();
  const { host, username, port } = validateHost(input);
  let rec = id ? hosts.find((x) => x.id === id) : null;
  if (id && !rec) throw new Error('主机不存在');
  if (!rec) {
    rec = { id: crypto.randomUUID(), createdAt: Date.now() };
    hosts.push(rec);
  }
  const hostChanged = rec.host !== host || rec.port !== port;
  Object.assign(rec, {
    name: String(input.name || '').trim() || `${username}@${host}`,
    group: String(input.group || '').trim(),
    host,
    port,
    username,
    authType: input.authType === 'key' ? 'key' : 'password',
    note: String(input.note || '').slice(0, 2000),
  });
  if (hostChanged) rec.fingerprint = input.fingerprint || '';
  for (const f of SECRET_FIELDS) {
    if (typeof input[f] === 'string' && input[f] !== '') rec[f] = encrypt(input[f]);
    else if (input[f] === null) rec[f] = '';
  }
  writeJson('hosts.json', hosts);
  return publicHost(rec);
}

function deleteHost(id) {
  const hosts = loadHosts();
  const next = hosts.filter((h) => h.id !== id);
  if (next.length === hosts.length) return false;
  writeJson('hosts.json', next);
  return true;
}

function patchHost(id, patch) {
  const hosts = loadHosts();
  const rec = hosts.find((h) => h.id === id);
  if (!rec) return;
  Object.assign(rec, patch);
  writeJson('hosts.json', hosts);
}

/* ---------- 快捷命令 ---------- */
function defaultSnippets() {
  const mk = (name, command) => ({ id: crypto.randomUUID(), name, command, autoRun: true });
  return [
    mk('系统概况', 'uname -a && uptime'),
    mk('磁盘占用', 'df -h'),
    mk('内存占用', 'free -h'),
    mk('CPU 占用前 10', 'ps aux --sort=-%cpu | head -n 11'),
    mk('监听端口', 'ss -tulpn 2>/dev/null || netstat -tulpn'),
    mk('当前目录大小', 'du -sh * 2>/dev/null | sort -h'),
  ];
}

function listSnippets() {
  let list = readJson('snippets.json', null);
  if (!list) {
    list = defaultSnippets();
    writeJson('snippets.json', list);
  }
  return list;
}

function saveSnippet(input, id) {
  const list = listSnippets();
  const name = String(input.name || '').trim();
  const command = String(input.command || '');
  if (!name) throw new Error('请填写名称');
  if (!command.trim()) throw new Error('请填写命令');
  let rec = id ? list.find((s) => s.id === id) : null;
  if (id && !rec) throw new Error('快捷命令不存在');
  if (!rec) {
    rec = { id: crypto.randomUUID() };
    list.push(rec);
  }
  Object.assign(rec, { name, command, autoRun: input.autoRun !== false });
  writeJson('snippets.json', list);
  return rec;
}

function deleteSnippet(id) {
  writeJson('snippets.json', listSnippets().filter((s) => s.id !== id));
}

module.exports = {
  DATA_DIR,
  getConfig,
  updateConfig,
  listHosts,
  getHostSecret,
  saveHost,
  deleteHost,
  patchHost,
  listSnippets,
  saveSnippet,
  deleteSnippet,
};
