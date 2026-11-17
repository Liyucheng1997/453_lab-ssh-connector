// 主机编辑表单
import { h, modal, toast } from './ui.js';
import { icon } from './icons.js';
import { post, put } from './api.js';

/**
 * 打开新建 / 编辑主机的表单。
 * @returns Promise<{host, connect}|null>
 */
export function hostForm({ host = null, groups = [], preset = {} } = {}) {
  return new Promise((resolve) => {
    const v = { name: '', group: '', host: '', port: 22, username: 'root', authType: 'password', note: '', ...preset, ...(host || {}) };
    const field = (attrs) => h('input', { class: 'input', spellcheck: 'false', autocomplete: 'off', ...attrs });
    const name = field({ value: v.name, placeholder: '例如：生产环境 Web' });
    const group = field({ value: v.group, placeholder: '可选，例如：阿里云', list: 'yq-groups' });
    const datalist = h('datalist', { id: 'yq-groups' }, ...groups.map((g) => h('option', { value: g })));
    const addr = field({ value: v.host, placeholder: 'IP 或域名' });
    const port = field({ value: v.port, type: 'number', min: 1, max: 65535, style: { width: '84px', flex: 'none' } });
    const user = field({ value: v.username, placeholder: 'root' });
    const pw = field({ type: 'password', placeholder: host?.hasPassword ? '已保存（留空则不修改）' : '登录密码', autocomplete: 'new-password' });
    const eye = h('button', { class: 'icon-btn', type: 'button', title: '显示密码', html: icon('eye', 15) });
    eye.addEventListener('click', () => {
      pw.type = pw.type === 'password' ? 'text' : 'password';
      eye.innerHTML = icon(pw.type === 'password' ? 'eye' : 'eyeOff', 15);
    });
    const key = h('textarea', {
      class: 'input mono-sm',
      rows: 5,
      spellcheck: 'false',
      placeholder: host?.hasKey ? '已保存私钥（留空则不修改）' : '粘贴私钥内容（-----BEGIN OPENSSH PRIVATE KEY----- …）',
    });
    const keyFile = h('input', { type: 'file', class: 'hidden' });
    const pickKey = h('button', { class: 'btn btn-sm', type: 'button', html: `${icon('key', 13)}从文件读取` });
    pickKey.addEventListener('click', () => keyFile.click());
    keyFile.addEventListener('change', async () => {
      const f = keyFile.files[0];
      if (!f) return;
      if (f.size > 64 * 1024) return toast('这不像是私钥文件（太大了）', 'error');
      key.value = (await f.text()).trim();
      keyFile.value = '';
    });
    const pass = field({ type: 'password', placeholder: host?.hasPassphrase ? '已保存（留空则不修改）' : '私钥没有口令可不填', autocomplete: 'new-password' });
    const note = h('textarea', { class: 'input', rows: 2, placeholder: '备注（可选）' });
    note.value = v.note || '';

    let authType = v.authType;
    const seg = h('div', { class: 'seg' });
    const segPw = h('button', { type: 'button' }, '密码');
    const segKey = h('button', { type: 'button' }, '私钥');
    seg.append(segPw, segKey);
    const pwRow = h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '密码'), h('div', { class: 'field-with-btn' }, pw, eye));
    const keyRows = h(
      'div',
      { class: 'form' },
      h('div', { class: 'form-row top' }, h('span', { class: 'form-label' }, '私钥'), h('div', { class: 'grow', style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, key, h('div', {}, pickKey, keyFile))),
      h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '私钥口令'), pass)
    );
    const setAuth = (t) => {
      authType = t;
      segPw.classList.toggle('active', t === 'password');
      segKey.classList.toggle('active', t === 'key');
      pwRow.classList.toggle('hidden', t !== 'password');
      keyRows.classList.toggle('hidden', t !== 'key');
    };
    segPw.addEventListener('click', () => setAuth('password'));
    segKey.addEventListener('click', () => setAuth('key'));
    setAuth(authType);

    // 粘贴 user@host:port 时自动拆分
    addr.addEventListener('change', () => {
      const m = addr.value.trim().match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
      if (m && (m[1] || m[3])) {
        if (m[1]) user.value = m[1];
        addr.value = m[2];
        if (m[3]) port.value = m[3];
      }
    });

    const msg = h('div', { class: 'form-err' });
    const testBtn = h('button', { class: 'btn', type: 'button' }, '测试连接');
    const cancel = h('button', { class: 'btn', type: 'button' }, '取消');
    const saveBtn = h('button', { class: 'btn', type: 'button' }, '保存');
    const saveGo = h('button', { class: 'btn btn-primary', type: 'button' }, '保存并连接');

    const body = h(
      'div',
      { class: 'modal-body' },
      h(
        'div',
        { class: 'form' },
        h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '名称'), name),
        h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '分组'), group, datalist),
        h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '主机'), addr, port),
        h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '用户名'), user),
        h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '认证方式'), seg),
        pwRow,
        keyRows,
        h('div', { class: 'form-row top' }, h('span', { class: 'form-label' }, '备注'), note),
        host?.fingerprint ? h('div', { class: 'form-hint mono', style: { wordBreak: 'break-all' } }, `服务器指纹 ${host.fingerprint}`) : null,
        msg
      )
    );
    const m = modal({
      title: host ? '编辑主机' : '新建主机',
      body,
      footer: h('div', { class: 'modal-footer split' }, h('div', { class: 'left' }, testBtn), h('div', { class: 'right' }, cancel, saveBtn, saveGo)),
      closeOnOverlay: false,
      onClose: (r) => resolve(r || null),
    });
    m.el.style.width = '540px';
    setTimeout(() => (host ? name : addr).focus(), 40);

    const collect = () => {
      const out = {
        name: name.value.trim(),
        group: group.value.trim(),
        host: addr.value.trim(),
        port: Number(port.value) || 22,
        username: user.value.trim(),
        authType,
        note: note.value,
      };
      if (pw.value) out.password = pw.value;
      if (key.value.trim()) out.privateKey = key.value.trim() + '\n';
      if (pass.value) out.passphrase = pass.value;
      return out;
    };
    const check = (d) => {
      if (!d.host) return '请填写主机地址';
      if (!d.username) return '请填写用户名';
      if (!host && authType === 'password' && !d.password) return '请填写密码';
      if (!host && authType === 'key' && !d.privateKey) return '请粘贴或选择私钥';
      return '';
    };

    testBtn.addEventListener('click', async () => {
      const d = collect();
      const e = check(d);
      msg.className = 'form-err';
      if (e) return (msg.textContent = e);
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';
      msg.textContent = '';
      try {
        const r = await post('/api/hosts/test', { ...d, id: host?.id });
        msg.className = 'form-ok';
        msg.textContent = `连接成功，用时 ${r.latency} ms`;
      } catch (err) {
        msg.textContent = err.message;
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '测试连接';
      }
    });

    const save = async (connect) => {
      const d = collect();
      const e = check(d);
      msg.className = 'form-err';
      if (e) return (msg.textContent = e);
      try {
        const saved = host ? await put(`/api/hosts/${host.id}`, d) : await post('/api/hosts', d);
        m.close({ host: saved, connect });
      } catch (err) {
        msg.textContent = err.message;
      }
    };
    saveBtn.addEventListener('click', () => save(false));
    saveGo.addEventListener('click', () => save(true));
    cancel.addEventListener('click', () => m.close(null));
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') save(true);
    });
  });
}

/** 快速连接：解析 user@host:port，再询问密码 */
export function quickConnectDialog(text) {
  return new Promise((resolve) => {
    const m0 = String(text || '').trim().replace(/^ssh\s+/, '').match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
    const v = { username: m0?.[1] || 'root', host: m0?.[2] || '', port: Number(m0?.[3]) || 22 };
    const addr = h('input', { class: 'input mono-sm', value: `${v.username}@${v.host}${v.port !== 22 ? `:${v.port}` : ''}`, spellcheck: 'false' });
    const pw = h('input', { class: 'input', type: 'password', placeholder: '密码', autocomplete: 'new-password' });
    const save = h('input', { type: 'checkbox' });
    const err = h('div', { class: 'form-err' });
    const ok = h('button', { class: 'btn btn-primary' }, '连接');
    const cancel = h('button', { class: 'btn' }, '取消');
    const m = modal({
      title: '快速连接',
      body: h(
        'div',
        { class: 'modal-body' },
        h(
          'div',
          { class: 'form' },
          h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '地址'), addr),
          h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '密码'), pw),
          h('label', { class: 'form-check', style: { marginLeft: '88px' } }, save, '连接成功后保存到主机列表'),
          h('div', { class: 'form-hint' }, '需要用私钥登录？请使用“新建主机”。'),
          err
        )
      ),
      footer: h('div', { class: 'modal-footer' }, cancel, ok),
      onClose: (r) => resolve(r || null),
    });
    setTimeout(() => (v.host ? pw : addr).focus(), 40);
    const submit = () => {
      const mm = addr.value.trim().match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
      if (!mm) return (err.textContent = '地址格式应为 用户名@主机:端口');
      if (!mm[1]) return (err.textContent = '请在地址前加上用户名，例如 root@1.2.3.4');
      m.close({ target: { username: mm[1], host: mm[2], port: Number(mm[3]) || 22, password: pw.value, authType: 'password' }, save: save.checked });
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => m.close(null));
    for (const el of [addr, pw]) el.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  });
}
