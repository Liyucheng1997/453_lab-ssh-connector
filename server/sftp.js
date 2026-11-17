// SFTP 文件管理接口，全部挂在 /api/sessions/:sid/ 下，复用该会话的 SSH 连接。
const express = require('express');
const path = require('path').posix;
const { getSession, shQuote } = require('./ssh');

const router = express.Router({ mergeParams: true });

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const MAX_EDIT = 5 * 1024 * 1024;

const call = (sftp, fn, ...args) =>
  new Promise((resolve, reject) => sftp[fn](...args, (err, r) => (err ? reject(err) : resolve(r))));

function sftpError(err) {
  const map = { 2: '文件或目录不存在', 3: '没有权限', 4: '操作失败' };
  const e = new Error(map[err?.code] ? `${map[err.code]}${err.message && err.code === 4 ? `：${err.message}` : ''}` : err?.message || '操作失败');
  e.status = err?.code === 2 ? 404 : err?.code === 3 ? 403 : 400;
  return e;
}

function needPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) {
    const e = new Error('路径无效');
    e.status = 400;
    throw e;
  }
  return path.normalize(p);
}

function typeOf(mode) {
  const t = mode & S_IFMT;
  if (t === S_IFDIR) return 'dir';
  if (t === S_IFLNK) return 'link';
  return 'file';
}

function permString(mode, type) {
  const c = type === 'dir' ? 'd' : type === 'link' ? 'l' : '-';
  const bits = 'rwxrwxrwx';
  let s = c;
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : '-';
  return s;
}

// 取会话 + SFTP
router.use(async (req, res, next) => {
  const session = getSession(req.params.sid);
  if (!session) return res.status(410).json({ error: '会话已断开，请重新连接' });
  req.session = session;
  try {
    req.sftp = await session.sftp();
    next();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    const e = err.status ? err : sftpError(err);
    if (!res.headersSent) res.status(e.status || 400).json({ error: e.message });
    else res.destroy();
  });

// 列目录
router.get(
  '/list',
  wrap(async (req, res) => {
    const sftp = req.sftp;
    const raw = req.query.path && req.query.path !== '~' ? req.query.path : '.';
    const dir = await call(sftp, 'realpath', raw);
    const items = await call(sftp, 'readdir', dir);
    const entries = await Promise.all(
      items.map(async (it) => {
        const mode = it.attrs.mode;
        let type = typeOf(mode);
        let target = null;
        if (type === 'link') {
          try {
            const st = await call(sftp, 'stat', path.join(dir, it.filename));
            target = typeOf(st.mode);
          } catch {
            target = 'broken';
          }
        }
        const parts = String(it.longname || '').split(/\s+/);
        return {
          name: it.filename,
          type,
          target,
          size: it.attrs.size,
          mtime: it.attrs.mtime * 1000,
          mode: mode & 0o7777,
          perm: permString(mode, type),
          owner: parts[2] || String(it.attrs.uid),
          group: parts[3] || String(it.attrs.gid),
        };
      })
    );
    res.json({ path: dir, entries });
  })
);

// 下载文件；目录打包成 tar.gz
router.get(
  '/download',
  wrap(async (req, res) => {
    const p = needPath(req.query.path);
    const st = await call(req.sftp, 'stat', p);
    const base = path.basename(p) || 'root';
    if (typeOf(st.mode) === 'dir') {
      const name = `${base}.tar.gz`;
      const stream = await req.session.execStream(`cd ${shQuote(path.dirname(p))} && tar czf - ${shQuote(base)}`);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      stream.pipe(res);
      stream.stderr.resume();
      res.on('close', () => stream.close?.());
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(base)}`);
    const rs = req.sftp.createReadStream(p);
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  })
);

// 上传：请求体就是文件内容（流式写入，不占内存）
router.put(
  '/upload',
  wrap(
    (req, res) =>
      new Promise((resolve, reject) => {
        const p = needPath(req.query.path);
        const ws = req.sftp.createWriteStream(p, { mode: 0o644 });
        let failed = false;
        ws.on('error', (err) => {
          failed = true;
          reject(err);
        });
        ws.on('close', () => {
          if (failed) return;
          if (req.aborted || !req.complete) {
            req.sftp.unlink(p, () => {});
            return resolve();
          }
          res.json({ ok: true });
          resolve();
        });
        req.on('aborted', () => ws.end());
        req.pipe(ws);
      })
  )
);

// 读取文本文件（在线编辑）
router.get(
  '/read',
  wrap(async (req, res) => {
    const p = needPath(req.query.path);
    const st = await call(req.sftp, 'stat', p);
    if (typeOf(st.mode) === 'dir') throw Object.assign(new Error('这是一个目录'), { status: 400 });
    if (st.size > MAX_EDIT) throw Object.assign(new Error('文件超过 5 MB，请下载后编辑'), { status: 413 });
    const buf = await call(req.sftp, 'readFile', p);
    if (buf.subarray(0, 8000).includes(0)) throw Object.assign(new Error('这是二进制文件，不能在线编辑'), { status: 415 });
    res.json({ path: p, content: buf.toString('utf8'), size: st.size, mtime: st.mtime * 1000 });
  })
);

// 保存文本文件
router.put(
  '/write',
  express.text({ type: '*/*', limit: '10mb' }),
  wrap(async (req, res) => {
    const p = needPath(req.query.path);
    await call(req.sftp, 'writeFile', p, Buffer.from(typeof req.body === 'string' ? req.body : '', 'utf8'));
    res.json({ ok: true });
  })
);

router.post(
  '/mkdir',
  wrap(async (req, res) => {
    await call(req.sftp, 'mkdir', needPath(req.body.path));
    res.json({ ok: true });
  })
);

router.post(
  '/touch',
  wrap(async (req, res) => {
    const p = needPath(req.body.path);
    const handle = await call(req.sftp, 'open', p, 'wx');
    await call(req.sftp, 'close', handle);
    res.json({ ok: true });
  })
);

router.post(
  '/rename',
  wrap(async (req, res) => {
    await call(req.sftp, 'rename', needPath(req.body.from), needPath(req.body.to));
    res.json({ ok: true });
  })
);

router.post(
  '/chmod',
  wrap(async (req, res) => {
    const mode = parseInt(String(req.body.mode), 8);
    if (!(mode >= 0 && mode <= 0o7777)) throw Object.assign(new Error('权限值无效'), { status: 400 });
    await call(req.sftp, 'chmod', needPath(req.body.path), mode);
    res.json({ ok: true });
  })
);

// 删除（目录递归删除）
router.post(
  '/delete',
  wrap(async (req, res) => {
    const paths = (Array.isArray(req.body.paths) ? req.body.paths : [req.body.path]).map(needPath);
    for (const p of paths) {
      if (p === '/') throw Object.assign(new Error('不能删除根目录'), { status: 400 });
    }
    const dirs = [];
    for (const p of paths) {
      const st = await call(req.sftp, 'lstat', p);
      if (typeOf(st.mode) === 'dir') dirs.push(p);
      else await call(req.sftp, 'unlink', p);
    }
    if (dirs.length) {
      const r = await req.session.exec(`rm -rf -- ${dirs.map(shQuote).join(' ')}`, { timeout: 120000 });
      if (r.code !== 0) throw Object.assign(new Error(r.stderr.trim() || '删除失败'), { status: 400 });
    }
    res.json({ ok: true });
  })
);

module.exports = router;
