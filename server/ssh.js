// SSH 连接与会话管理。每个终端标签页对应一个 Session（一条 SSH 连接），
// 终端、SFTP、监控、结束进程都复用这条连接。
const crypto = require('crypto');
const { Client } = require('ssh2');

const sessions = new Map();

function fingerprintOf(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** 把底层错误翻译成看得懂的中文 */
function friendlyError(err) {
  if (err && err.code === 'HOSTKEY_CHANGED') return err;
  const msg = String(err?.message || err || '未知错误');
  const code = err?.code;
  let text = msg;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') text = '找不到这个主机，请检查地址是否正确';
  else if (code === 'ECONNREFUSED') text = '连接被拒绝：对方没有在这个端口上运行 SSH 服务';
  else if (code === 'ETIMEDOUT' || err?.level === 'client-timeout' || /Timed out/i.test(msg)) text = '连接超时，请检查网络、防火墙或端口';
  else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') text = '网络不可达';
  else if (code === 'ECONNRESET') text = '连接被对方重置';
  else if (err?.level === 'client-authentication' || /authentication methods failed/i.test(msg)) text = '认证失败：用户名、密码或密钥不正确';
  else if (/Encrypted private OpenSSH key detected, but no passphrase/i.test(msg) || /no passphrase given/i.test(msg)) text = '私钥已加密，请填写私钥口令';
  else if (/Cannot parse privateKey|Unsupported key format|Bad passphrase|bad decrypt/i.test(msg)) text = '私钥无法解析：格式不支持或口令错误';
  const e = new Error(text);
  e.code = code || err?.level || 'SSH_ERROR';
  e.detail = msg;
  return e;
}

/**
 * 建立 SSH 连接。
 * opts.expectedFingerprint：上次记录的服务器指纹，不一致时拒绝连接（防中间人）。
 * opts.acceptFingerprint：用户确认信任的新指纹。
 */
function openClient(target, opts = {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint = '';
    let hostKeyError = null;
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      fn(v);
    };

    const cfg = {
      host: target.host,
      port: Number(target.port) || 22,
      username: target.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
      hostVerifier: (key) => {
        fingerprint = fingerprintOf(key);
        const expected = opts.expectedFingerprint;
        if (expected && expected !== fingerprint && opts.acceptFingerprint !== fingerprint) {
          hostKeyError = Object.assign(
            new Error('服务器指纹与上次记录的不一致。可能是服务器重装了系统，也可能有人在冒充这台服务器。'),
            { code: 'HOSTKEY_CHANGED', fingerprint, expected }
          );
          return false;
        }
        return true;
      },
    };
    if (target.authType === 'key' || (!target.password && target.privateKey)) {
      if (target.privateKey) cfg.privateKey = target.privateKey;
      if (target.passphrase) cfg.passphrase = target.passphrase;
    }
    if (target.password) cfg.password = target.password;

    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      finish(prompts.map(() => target.password || ''));
    });
    client.once('ready', () => done(resolve, { client, fingerprint }));
    client.on('error', (err) => {
      if (!settled) {
        done(reject, hostKeyError || friendlyError(err));
        try {
          client.end();
        } catch {}
      }
    });
    client.once('close', () => done(reject, hostKeyError || friendlyError(new Error('连接已关闭'))));
    try {
      client.connect(cfg);
    } catch (err) {
      done(reject, friendlyError(err));
    }
  });
}

class Session {
  constructor({ client, hostId, label, fingerprint, target }) {
    this.id = crypto.randomUUID();
    this.client = client;
    this.hostId = hostId || null;
    this.label = label;
    this.fingerprint = fingerprint;
    this.username = target.username;
    this.sftpPromise = null;
    this.prevCpu = null;
    this.prevNet = null;
    this.closed = false;
    sessions.set(this.id, this);
    client.on('close', () => this.close());
    client.on('error', () => {});
  }

  shell(cols, rows) {
    return new Promise((resolve, reject) => {
      this.client.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) =>
        err ? reject(err) : resolve(stream)
      );
    });
  }

  sftp() {
    if (!this.sftpPromise) {
      this.sftpPromise = new Promise((resolve, reject) => {
        this.client.sftp((err, sftp) => {
          if (err) {
            this.sftpPromise = null;
            return reject(new Error('无法打开 SFTP：服务器可能没有启用 SFTP 子系统'));
          }
          sftp.on('close', () => {
            this.sftpPromise = null;
          });
          resolve(sftp);
        });
      });
    }
    return this.sftpPromise;
  }

  /** 执行一条命令并收集输出 */
  exec(cmd, { timeout = 15000, maxBytes = 4 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        const out = [];
        const errOut = [];
        let size = 0;
        const timer = setTimeout(() => {
          try {
            stream.close();
          } catch {}
          reject(new Error('命令执行超时'));
        }, timeout);
        stream.on('data', (d) => {
          size += d.length;
          if (size <= maxBytes) out.push(d);
        });
        stream.stderr.on('data', (d) => errOut.push(d));
        stream.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8') });
        });
      });
    });
  }

  /** 执行命令并返回输出流（用于打包下载目录） */
  execStream(cmd) {
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    sessions.delete(this.id);
    try {
      this.client.end();
    } catch {}
  }
}

function getSession(id) {
  return sessions.get(id) || null;
}

/** 把字符串安全地放进单引号里交给远程 shell */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { openClient, Session, getSession, sessions, friendlyError, shQuote, fingerprintOf };
