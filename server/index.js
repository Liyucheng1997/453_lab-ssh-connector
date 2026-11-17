// 云桥 SSH —— 服务入口：静态页面、REST 接口、终端 WebSocket。
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./store');
const auth = require('./auth');
const { openClient, Session, getSession, sessions, shQuote } = require('./ssh');
const stats = require('./stats');
const sftpRouter = require('./sftp');

const PORT = Number(process.env.PORT) || 8822;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, '..');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules', '@xterm')));
app.use(express.json({ limit: '2mb' }));

const isSecure = (req) => req.secure;
const clientIp = (req) => req.ip || req.socket.remoteAddress || '';

/* ---------- 登录 ---------- */
app.get('/api/auth/status', (req, res) => {
  const cfg = store.getConfig();
  res.json({ setup: !!cfg.passwordHash, authed: auth.isAuthed(req) });
});

app.post('/api/auth/setup', (req, res) => {
  const cfg = store.getConfig();
  if (cfg.passwordHash) return res.status(409).json({ error: '已经设置过访问密码' });
  const pw = String(req.body?.password || '');
  if (pw.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  store.updateConfig({ passwordHash: auth.hashPassword(pw) });
  auth.setCookie(res, auth.issueToken(), isSecure(req));
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const ip = clientIp(req);
  const wait = auth.lockedSeconds(ip);
  if (wait) return res.status(429).json({ error: `尝试次数过多，请 ${wait} 秒后再试` });
  const cfg = store.getConfig();
  if (!auth.verifyPassword(String(req.body?.password || ''), cfg.passwordHash)) {
    auth.recordFailure(ip);
    return res.status(401).json({ error: '密码不正确' });
  }
  auth.clearFailures(ip);
  auth.setCookie(res, auth.issueToken(), isSecure(req));
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearCookie(res);
  res.json({ ok: true });
});

/* ---------- 以下接口都需要登录 ---------- */
app.use('/api', (req, res, next) => {
  if (!auth.isAuthed(req)) return res.status(401).json({ error: '请先登录' });
  // 防 CSRF：写操作必须带自定义请求头（跨站表单无法设置）
  if (req.method !== 'GET' && req.get('x-yq') !== '1') return res.status(403).json({ error: '非法请求' });
  next();
});

app.post('/api/auth/password', (req, res) => {
  const cfg = store.getConfig();
  if (!auth.verifyPassword(String(req.body?.oldPassword || ''), cfg.passwordHash)) {
    return res.status(400).json({ error: '当前密码不正确' });
  }
  const pw = String(req.body?.newPassword || '');
  if (pw.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  store.updateConfig({ passwordHash: auth.hashPassword(pw), authVersion: cfg.authVersion + 1 });
  auth.setCookie(res, auth.issueToken(), isSecure(req));
  res.json({ ok: true });
});

const handle = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 400).json({ error: err.message, code: err.code, fingerprint: err.fingerprint, expected: err.expected });
  }
};

/* ---------- 主机 ---------- */
app.get('/api/hosts', handle(() => store.listHosts()));
app.post('/api/hosts', handle((req) => store.saveHost(req.body || {})));
app.put('/api/hosts/:id', handle((req) => store.saveHost(req.body || {}, req.params.id)));
app.delete(
  '/api/hosts/:id',
  handle((req) => {
    if (!store.deleteHost(req.params.id)) throw Object.assign(new Error('主机不存在'), { status: 404 });
  })
);
// 清除记录的指纹（服务器重装后重新信任）
app.post(
  '/api/hosts/:id/trust',
  handle((req) => {
    store.patchHost(req.params.id, { fingerprint: String(req.body?.fingerprint || '') });
  })
);

// 测试连接：编辑时没重新填写的密码沿用已保存的
app.post(
  '/api/hosts/test',
  handle(async (req) => {
    const body = req.body || {};
    let target = { ...body };
    let expected = '';
    if (body.id) {
      const saved = store.getHostSecret(body.id);
      if (saved) {
        for (const f of ['password', 'privateKey', 'passphrase']) if (!target[f]) target[f] = saved[f];
        if (saved.host === body.host && Number(saved.port) === Number(body.port)) expected = saved.fingerprint;
      }
    }
    const started = Date.now();
    const { client, fingerprint } = await openClient(target, { expectedFingerprint: expected });
    const latency = Date.now() - started;
    client.end();
    return { ok: true, fingerprint, latency };
  })
);

/* ---------- 快捷命令 ---------- */
app.get('/api/snippets', handle(() => store.listSnippets()));
app.post('/api/snippets', handle((req) => store.saveSnippet(req.body || {})));
app.put('/api/snippets/:id', handle((req) => store.saveSnippet(req.body || {}, req.params.id)));
app.delete('/api/snippets/:id', handle((req) => store.deleteSnippet(req.params.id)));

/* ---------- 会话：监控、结束进程、SFTP ---------- */
function needSession(req) {
  const s = getSession(req.params.sid);
  if (!s) throw Object.assign(new Error('会话已断开，请重新连接'), { status: 410 });
  return s;
}

app.get('/api/sessions/:sid/stats', handle((req) => stats.collect(needSession(req))));

app.post(
  '/api/sessions/:sid/kill',
  handle(async (req) => {
    const s = needSession(req);
    const pid = Number(req.body?.pid);
    const signal = req.body?.force ? 'KILL' : 'TERM';
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('进程号无效');
    const r = await s.exec(`kill -${signal} ${pid}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || '结束进程失败');
  })
);

app.get(
  '/api/sessions/:sid/home',
  handle(async (req) => {
    const s = needSession(req);
    const r = await s.exec('pwd');
    return { path: r.stdout.trim() || '/' };
  })
);

app.use('/api/sessions/:sid/sftp', sftpRouter);

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

/* ---------- 终端 WebSocket ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  const sameOrigin = !origin || new URL(origin).host === req.headers.host;
  if (url.pathname !== '/ws' || !sameOrigin || !auth.isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  let session = null;
  let stream = null;
  let connecting = false;
  let closed = false;
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (stream) stream.write(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'resize' && stream) {
      const cols = Math.max(1, Math.min(1000, msg.cols | 0));
      const rows = Math.max(1, Math.min(500, msg.rows | 0));
      stream.setWindow(rows, cols, 0, 0);
    } else if (msg.type === 'connect' && !session && !connecting) {
      connecting = true;
      await connect(msg);
    }
  });

  async function connect(msg) {
    let target;
    let hostId = null;
    if (msg.hostId) {
      target = store.getHostSecret(msg.hostId);
      if (!target) {
        send({ type: 'error', message: '主机不存在，可能已被删除' });
        return ws.close();
      }
      hostId = target.id;
    } else {
      target = msg.target || {};
      if (!target.host || !target.username) {
        send({ type: 'error', message: '缺少主机地址或用户名' });
        return ws.close();
      }
    }
    const label = target.name || `${target.username}@${target.host}`;
    send({ type: 'status', message: `正在连接 ${target.username}@${target.host}:${target.port || 22} …` });
    try {
      const { client, fingerprint } = await openClient(target, {
        expectedFingerprint: target.fingerprint || '',
        acceptFingerprint: msg.acceptFingerprint,
      });
      if (closed) return client.end();
      session = new Session({ client, hostId, label, fingerprint, target });
      if (hostId) store.patchHost(hostId, { fingerprint, lastUsedAt: Date.now() });

      // 快速连接时选择了“保存”
      let savedHost = null;
      if (!hostId && msg.save) {
        try {
          savedHost = store.saveHost({ ...target, fingerprint });
          store.patchHost(savedHost.id, { fingerprint, lastUsedAt: Date.now() });
          session.hostId = savedHost.id;
        } catch {}
      }

      stream = await session.shell(msg.cols, msg.rows);
      stream.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d, { binary: true }));
      stream.stderr.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d, { binary: true }));
      stream.on('close', () => {
        send({ type: 'closed', message: '会话已结束' });
        session?.close();
        ws.close();
      });
      client.on('close', () => {
        send({ type: 'closed', message: '连接已断开' });
        ws.close();
      });
      send({ type: 'ready', sessionId: session.id, fingerprint, label, hostId: session.hostId, savedHost });
    } catch (err) {
      send({ type: 'error', message: err.message, code: err.code, fingerprint: err.fingerprint, expected: err.expected });
      ws.close();
    }
  }

  ws.on('close', () => {
    closed = true;
    session?.close();
  });
});

// 心跳：清理已经断开的浏览器连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`\n  云桥 SSH 已启动： http://${shown}:${PORT}\n  数据目录：${store.DATA_DIR}\n`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.log('  注意：当前监听在非本机地址，建议放在 HTTPS 反向代理之后使用。\n');
  }
});

function shutdown() {
  for (const s of sessions.values()) s.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, shQuote };
