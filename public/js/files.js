// SFTP 文件管理面板
import { h, toast, confirmDialog, promptDialog, showMenu, fmtBytes, fmtTime, copyText, modal } from './ui.js';
import { icon } from './icons.js';
import { get, post, api, uploadFile } from './api.js';
import { settings } from './settings.js';

const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentOf = (p) => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/');
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export class FilesPane {
  constructor(session) {
    this.s = session;
    this.cwd = null;
    this.entries = [];
    this.selected = new Set();
    this.sort = { key: 'name', dir: 1 };
    this.loading = false;
    this.transfers = [];
    this.build();
  }

  get base() {
    return `/api/sessions/${this.s.sessionId}/sftp`;
  }

  build() {
    this.pathInput = h('input', { class: 'input fs-path', spellcheck: 'false', placeholder: '/' });
    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.load(this.pathInput.value.trim() || '/');
    });
    const btn = (name, title, fn) => {
      const b = h('button', { class: 'icon-btn sm', title, html: icon(name, 15) });
      b.addEventListener('click', fn);
      return b;
    };
    this.hiddenBtn = btn(settings.showHidden ? 'eye' : 'eyeOff', '显示/隐藏隐藏文件', () => {
      settings.showHidden = !settings.showHidden;
      this.hiddenBtn.innerHTML = icon(settings.showHidden ? 'eye' : 'eyeOff', 15);
      this.hiddenBtn.classList.toggle('on', settings.showHidden);
      this.render();
    });
    this.hiddenBtn.classList.toggle('on', settings.showHidden);
    this.fileInput = h('input', { type: 'file', multiple: true, class: 'hidden' });
    this.fileInput.addEventListener('change', () => {
      this.uploadFiles([...this.fileInput.files]);
      this.fileInput.value = '';
    });

    const bar = h(
      'div',
      { class: 'fs-bar' },
      btn('up', '上一级', () => this.cwd && this.load(parentOf(this.cwd))),
      btn('home', '主目录', () => this.load('~')),
      this.pathInput,
      btn('refresh', '刷新', () => this.load(this.cwd))
    );
    const tools = h(
      'div',
      { class: 'fs-tools' },
      btn('upload', '上传文件', () => this.fileInput.click()),
      btn('folderPlus', '新建文件夹', () => this.mkdir()),
      btn('filePlus', '新建文件', () => this.touch()),
      btn('terminal', '在终端中进入此目录', () => this.cdHere()),
      h('span', { class: 'grow' }),
      this.hiddenBtn,
      this.fileInput
    );
    const sortHead = (key, label, cls = '') => {
      const s = h('span', { class: cls }, label);
      s.addEventListener('click', () => {
        this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : 1 };
        this.render();
      });
      return s;
    };
    this.head = h('div', { class: 'fs-head' }, h('span'), sortHead('name', '名称'), sortHead('size', '大小', 'num'), sortHead('mtime', '修改时间', 'num col-time'));
    this.list = h('div', { class: 'fs-list', tabindex: '0' });
    this.status = h('div', { class: 'fs-status' });
    this.transferBox = h('div', { class: 'transfers hidden' });
    this.el = h('div', { class: 'pane' }, bar, tools, this.head, this.list, this.transferBox, this.status);

    this.list.addEventListener('contextmenu', (e) => {
      if (e.target === this.list || e.target.closest('.fs-empty')) {
        e.preventDefault();
        this.selected.clear();
        this.paintSelection();
        this.blankMenu(e.clientX, e.clientY);
      }
    });
    this.list.addEventListener('mousedown', (e) => {
      if (e.target === this.list) {
        this.selected.clear();
        this.paintSelection();
      }
    });
    this.list.addEventListener('keydown', (e) => this.onKey(e));

    // 拖放上传
    let depth = 0;
    this.list.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      depth++;
      this.list.classList.add('drop');
    });
    this.list.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.list.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        this.list.classList.remove('drop');
      }
    });
    this.list.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      this.list.classList.remove('drop');
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.size > 0 || f.type);
      if (files.length) this.uploadFiles(files);
      else toast('暂不支持直接拖入文件夹，请先压缩', 'error');
    });
    this.renderEmpty('连接成功后显示远程文件');
  }

  onConnected() {
    this.load(this.cwd || '~');
  }

  onShow() {
    if (this.s.sessionId && this.cwd == null && !this.loading) this.load('~');
  }

  renderEmpty(text, ic = 'folder') {
    this.list.replaceChildren(h('div', { class: 'fs-empty', html: `${icon(ic, 32, 1.4)}<div>${text}</div>` }));
  }

  async load(path) {
    if (!this.s.sessionId) return;
    this.loading = true;
    try {
      const r = await get(`${this.base}/list?path=${encodeURIComponent(path || '~')}`);
      if (r.path !== this.cwd) this.selected.clear();
      this.cwd = r.path;
      this.entries = r.entries;
      this.pathInput.value = r.path;
      this.render();
    } catch (e) {
      toast(e.message, 'error');
      if (this.cwd == null) this.renderEmpty(e.message, 'alert');
      else this.pathInput.value = this.cwd;
    } finally {
      this.loading = false;
    }
  }

  visible() {
    const list = this.entries.filter((e) => settings.showHidden || !e.name.startsWith('.'));
    const { key, dir } = this.sort;
    const isDir = (e) => e.type === 'dir' || (e.type === 'link' && e.target === 'dir');
    return list.sort((a, b) => {
      const d = isDir(b) - isDir(a);
      if (d) return d;
      if (key === 'name') return dir * a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      return dir * ((a[key] || 0) - (b[key] || 0)) || a.name.localeCompare(b.name);
    });
  }

  render() {
    const items = this.visible();
    if (!items.length) {
      this.renderEmpty('这个文件夹是空的<br><span style="font-size:12px">把文件拖到这里即可上传</span>');
    } else {
      const frag = document.createDocumentFragment();
      for (const e of items) frag.append(this.row(e));
      this.list.replaceChildren(frag);
    }
    const dirs = items.filter((e) => e.type === 'dir' || e.target === 'dir').length;
    const hiddenCount = this.entries.length - items.length;
    this.status.replaceChildren(
      h('span', {}, `${dirs} 个文件夹，${items.length - dirs} 个文件${hiddenCount ? `（另有 ${hiddenCount} 个隐藏）` : ''}`),
      h('span', { class: 'ellipsis', style: { marginLeft: '8px' } }, this.cwd || '')
    );
    this.paintSelection();
  }

  row(e) {
    const isDir = e.type === 'dir' || (e.type === 'link' && e.target === 'dir');
    const ic = isDir ? 'folder' : /\.(txt|md|log|conf|cfg|ini|json|ya?ml|sh|py|js|ts|xml|html|css|env|toml|sql)$/i.test(e.name) ? 'fileText' : 'file';
    const r = h(
      'div',
      { class: `fs-row ${isDir ? 'dir' : ''} ${e.name.startsWith('.') ? 'hidden-file' : ''}`, title: `${e.perm}  ${e.owner}:${e.group}` },
      h('span', { class: 'fi', html: icon(ic, 16) }),
      h('span', { class: 'fs-name' }, e.name, e.type === 'link' ? h('span', { class: 'fs-link', html: icon('link', 11) }) : null),
      h('span', { class: 'num' }, isDir ? '—' : fmtBytes(e.size)),
      h('span', { class: 'num col-time' }, fmtTime(e.mtime))
    );
    r.dataset.name = e.name;
    r.addEventListener('mousedown', (ev) => {
      if (ev.button === 2 && this.selected.has(e.name)) return;
      if (ev.ctrlKey || ev.metaKey) {
        this.selected.has(e.name) ? this.selected.delete(e.name) : this.selected.add(e.name);
      } else if (ev.shiftKey && this.lastClicked) {
        const names = this.visible().map((x) => x.name);
        const [a, b] = [names.indexOf(this.lastClicked), names.indexOf(e.name)].sort((x, y) => x - y);
        this.selected = new Set(names.slice(a, b + 1));
      } else {
        this.selected = new Set([e.name]);
      }
      this.lastClicked = e.name;
      this.paintSelection();
    });
    r.addEventListener('dblclick', () => this.open(e));
    r.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.rowMenu(e, ev.clientX, ev.clientY);
    });
    return r;
  }

  paintSelection() {
    for (const r of this.list.querySelectorAll('.fs-row')) r.classList.toggle('sel', this.selected.has(r.dataset.name));
  }

  selectedEntries() {
    return this.entries.filter((e) => this.selected.has(e.name));
  }

  onKey(e) {
    if (e.key === 'Delete' && this.selected.size) this.remove(this.selectedEntries());
    else if (e.key === 'F2' && this.selected.size === 1) this.rename(this.selectedEntries()[0]);
    else if (e.key === 'Backspace' && this.cwd) this.load(parentOf(this.cwd));
    else if (e.key === 'Enter' && this.selected.size === 1) this.open(this.selectedEntries()[0]);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.selected = new Set(this.visible().map((x) => x.name));
      this.paintSelection();
    }
  }

  open(e) {
    const isDir = e.type === 'dir' || (e.type === 'link' && e.target === 'dir');
    if (isDir) this.load(joinPath(this.cwd, e.name));
    else if (e.size <= 5 * 1024 * 1024) this.edit(e);
    else this.download(e);
  }

  /* ---------- 菜单 ---------- */
  rowMenu(e, x, y) {
    const multi = this.selected.size > 1;
    const sel = multi ? this.selectedEntries() : [e];
    const isDir = e.type === 'dir' || (e.type === 'link' && e.target === 'dir');
    const p = joinPath(this.cwd, e.name);
    showMenu(x, y, [
      !multi && isDir ? { label: '打开', icon: 'folder', onClick: () => this.open(e) } : null,
      !multi && !isDir ? { label: '编辑', icon: 'pencil', onClick: () => this.edit(e) } : null,
      { label: multi ? `下载 ${sel.length} 项` : isDir ? '打包下载（tar.gz）' : '下载', icon: 'download', onClick: () => sel.forEach((x) => this.download(x)) },
      '-',
      !multi ? { label: '重命名', icon: 'type', shortcut: 'F2', onClick: () => this.rename(e) } : null,
      !multi ? { label: '修改权限', icon: 'lock', onClick: () => this.chmod(e) } : null,
      !multi ? { label: '复制路径', icon: 'copy', onClick: () => copyText(p) } : null,
      !multi && isDir ? { label: '在终端中进入', icon: 'terminal', onClick: () => this.cdHere(p) } : null,
      '-',
      { label: multi ? `删除 ${sel.length} 项` : '删除', icon: 'trash', danger: true, shortcut: 'Del', onClick: () => this.remove(sel) },
    ]);
  }

  blankMenu(x, y) {
    showMenu(x, y, [
      { label: '上传文件', icon: 'upload', onClick: () => this.fileInput.click() },
      { label: '新建文件夹', icon: 'folderPlus', onClick: () => this.mkdir() },
      { label: '新建文件', icon: 'filePlus', onClick: () => this.touch() },
      '-',
      { label: '刷新', icon: 'refresh', onClick: () => this.load(this.cwd) },
      { label: '复制当前路径', icon: 'copy', onClick: () => copyText(this.cwd) },
      { label: '在终端中进入此目录', icon: 'terminal', onClick: () => this.cdHere() },
    ]);
  }

  /* ---------- 操作 ---------- */
  cdHere(p = this.cwd) {
    if (!p) return;
    this.s.sendInput(`cd ${shQuote(p)}\r`);
    this.s.term.focus();
  }

  download(e) {
    const a = h('a', { href: `${this.base}/download?path=${encodeURIComponent(joinPath(this.cwd, e.name))}`, download: '' });
    document.body.append(a);
    a.click();
    a.remove();
    if (e.type === 'dir') toast('正在打包目录，下载马上开始');
  }

  validName(v) {
    if (!v) return '请输入名称';
    if (v.includes('/')) return '名称不能包含 /';
    if (v === '.' || v === '..') return '名称无效';
    return '';
  }

  async mkdir() {
    const name = await promptDialog({ title: '新建文件夹', placeholder: '文件夹名称', validate: (v) => this.validName(v) });
    if (!name) return;
    try {
      await post(`${this.base}/mkdir`, { path: joinPath(this.cwd, name) });
      await this.load(this.cwd);
      this.selected = new Set([name]);
      this.paintSelection();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async touch() {
    const name = await promptDialog({ title: '新建文件', placeholder: '文件名，例如 notes.txt', validate: (v) => this.validName(v) });
    if (!name) return;
    try {
      await post(`${this.base}/touch`, { path: joinPath(this.cwd, name) });
      await this.load(this.cwd);
      const e = this.entries.find((x) => x.name === name);
      if (e) this.edit(e);
    } catch (e) {
      toast(e.status === 400 ? '创建失败：可能已存在同名文件' : e.message, 'error');
    }
  }

  async rename(e) {
    const name = await promptDialog({ title: '重命名', value: e.name, selectBase: e.type !== 'dir', validate: (v) => this.validName(v) });
    if (!name || name === e.name) return;
    try {
      await post(`${this.base}/rename`, { from: joinPath(this.cwd, e.name), to: joinPath(this.cwd, name) });
      await this.load(this.cwd);
      this.selected = new Set([name]);
      this.paintSelection();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async remove(list) {
    if (!list.length) return;
    const ok = await confirmDialog({
      title: list.length > 1 ? `删除 ${list.length} 项？` : `删除“${list[0].name}”？`,
      message: list.some((x) => x.type === 'dir') ? '文件夹会连同里面的内容一起删除，无法恢复。' : '删除后无法恢复。',
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await post(`${this.base}/delete`, { paths: list.map((x) => joinPath(this.cwd, x.name)) });
      toast('已删除', 'success');
      this.selected.clear();
      this.load(this.cwd);
    } catch (err) {
      toast(err.message, 'error');
      this.load(this.cwd);
    }
  }

  chmod(e) {
    const p = joinPath(this.cwd, e.name);
    let mode = e.mode & 0o777;
    const input = h('input', { class: 'input mono-sm', style: { width: '90px' }, value: mode.toString(8).padStart(3, '0') });
    const boxes = [];
    const grid = h('div', { class: 'perm-grid' }, h('span'), h('span', { class: 'h' }, '读'), h('span', { class: 'h' }, '写'), h('span', { class: 'h' }, '执行'));
    ['所有者', '用户组', '其他人'].forEach((label, i) => {
      grid.append(h('span', { class: 'h' }, label));
      for (let j = 0; j < 3; j++) {
        const bit = 1 << (8 - (i * 3 + j));
        const cb = h('input', { type: 'checkbox' });
        cb.checked = !!(mode & bit);
        cb.addEventListener('change', () => {
          mode = cb.checked ? mode | bit : mode & ~bit;
          input.value = mode.toString(8).padStart(3, '0');
        });
        boxes.push([cb, bit]);
        grid.append(h('label', { class: 'form-check' }, cb));
      }
    });
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 8);
      if (v >= 0 && v <= 0o777) {
        mode = v;
        for (const [cb, bit] of boxes) cb.checked = !!(mode & bit);
      }
    });
    const ok = h('button', { class: 'btn btn-primary' }, '应用');
    const cancel = h('button', { class: 'btn' }, '取消');
    const m = modal({
      title: '修改权限',
      body: h('div', { class: 'modal-body' }, h('div', { class: 'form' }, h('div', { class: 'muted mono', style: { fontSize: '12px', wordBreak: 'break-all' } }, p), grid, h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '数字表示'), input))),
      footer: h('div', { class: 'modal-footer' }, cancel, ok),
    });
    cancel.addEventListener('click', () => m.close());
    ok.addEventListener('click', async () => {
      try {
        await post(`${this.base}/chmod`, { path: p, mode: input.value });
        m.close();
        toast('权限已修改', 'success');
        this.load(this.cwd);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  async edit(e) {
    const p = joinPath(this.cwd, e.name);
    let data;
    try {
      data = await get(`${this.base}/read?path=${encodeURIComponent(p)}`);
    } catch (err) {
      toast(err.message, 'error');
      if (err.status === 413 || err.status === 415) this.download(e);
      return;
    }
    const area = h('textarea', { class: 'editor-area', spellcheck: 'false', wrap: 'off' });
    area.value = data.content;
    let dirty = false;
    const dot = h('span', { class: 'dot hidden', style: { background: 'var(--warning)', marginLeft: '8px' }, title: '未保存' });
    const info = h('span', { class: 'muted' }, `${fmtBytes(data.size)} · UTF-8`);
    const save = h('button', { class: 'btn btn-primary' }, '保存');
    const cancel = h('button', { class: 'btn' }, '关闭');
    const title = h('span', { style: { display: 'flex', alignItems: 'center', minWidth: 0 } }, e.name, dot, h('span', { class: 'editor-path ellipsis' }, this.cwd));
    const m = modal({
      title,
      wide: true,
      closeOnOverlay: false,
      body: h('div', { class: 'editor-body' }, area),
      footer: h('div', { class: 'modal-footer split' }, h('div', { class: 'left' }, info, h('span', { class: 'muted' }, 'Ctrl+S 保存')), h('div', { class: 'right' }, cancel, save)),
    });
    const origClose = m.close.bind(m);
    m.close = async (r) => {
      if (dirty && !(await confirmDialog({ title: '放弃未保存的修改？', okText: '放弃', danger: true, iconName: 'alert' }))) return;
      origClose(r);
    };
    area.addEventListener('input', () => {
      dirty = true;
      dot.classList.remove('hidden');
    });
    area.addEventListener('keydown', (ev) => {
      if (ev.key === 'Tab') {
        ev.preventDefault();
        area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
        area.dispatchEvent(new Event('input'));
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        doSave();
      }
    });
    const doSave = async () => {
      save.disabled = true;
      try {
        await api('PUT', `${this.base}/write?path=${encodeURIComponent(p)}`, area.value, { raw: true });
        dirty = false;
        dot.classList.add('hidden');
        info.textContent = `${fmtBytes(new Blob([area.value]).size)} · 已保存`;
        toast('已保存', 'success', 1400);
        this.load(this.cwd);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        save.disabled = false;
      }
    };
    save.addEventListener('click', doSave);
    cancel.addEventListener('click', () => m.close());
    setTimeout(() => area.focus(), 50);
  }

  /* ---------- 上传 ---------- */
  async uploadFiles(files) {
    if (!this.s.sessionId || !this.cwd) return toast('尚未连接', 'error');
    const dir = this.cwd;
    const existing = new Set(this.entries.map((e) => e.name));
    const clash = files.filter((f) => existing.has(f.name));
    if (clash.length) {
      const ok = await confirmDialog({
        title: '覆盖同名文件？',
        message: `${clash.slice(0, 3).map((f) => f.name).join('、')}${clash.length > 3 ? ` 等 ${clash.length} 个文件` : ''} 已存在。`,
        okText: '覆盖',
        danger: true,
        iconName: 'alert',
      });
      if (!ok) return;
    }
    this.transferBox.classList.remove('hidden');
    // 依次上传，避免同时占满带宽
    for (const f of files) {
      const pct = h('span', { class: 'tf-pct' }, '等待中');
      const fill = h('i');
      const row = h('div', { class: 'tf' }, h('span', { class: 'tf-name', title: f.name }, f.name), pct, h('div', { class: 'bar' }, fill));
      this.transferBox.prepend(row);
      f._ui = { row, pct, fill };
    }
    for (const f of files) {
      const { row, pct, fill } = f._ui;
      try {
        const t = uploadFile(`${this.base}/upload?path=${encodeURIComponent(joinPath(dir, f.name))}`, f, (r) => {
          fill.style.width = `${Math.round(r * 100)}%`;
          pct.textContent = `${Math.round(r * 100)}% · ${fmtBytes(f.size)}`;
        });
        await t.promise;
        row.classList.add('done');
        fill.style.width = '100%';
        pct.textContent = `完成 · ${fmtBytes(f.size)}`;
      } catch (err) {
        row.classList.add('fail');
        pct.textContent = err.message;
      }
    }
    if (this.cwd === dir) this.load(dir);
    toast(`上传完成：${files.length} 个文件`, 'success');
    clearTimeout(this.tfTimer);
    this.tfTimer = setTimeout(() => {
      for (const r of this.transferBox.querySelectorAll('.tf.done')) r.remove();
      if (!this.transferBox.children.length) this.transferBox.classList.add('hidden');
    }, 6000);
  }
}
