// 云桥 SSH 前端入口：登录、布局、标签页、主机列表、主页、设置
import { h, toast, confirmDialog, modal, showMenu, copyText, fmtAgo, esc } from './ui.js';
import { icon } from './icons.js';
import { get, post, del, setUnauthorizedHandler } from './api.js';
import { settings, applyTheme, isDark } from './settings.js';
import { hostForm, quickConnectDialog } from './hosts.js';
import { TermSession } from './session.js';
import { snippetStore } from './commands.js';

const root = document.getElementById('app');
const logo = (size = 16) => h('div', { class: 'logo-mark', html: icon('terminal', size, 2.2) });

/* ---------- 登录 / 首次设置 ---------- */
function authScreen(setup) {
  const pw = h('input', { class: 'input', type: 'password', placeholder: setup ? '设置访问密码（至少 6 位）' : '访问密码', autocomplete: setup ? 'new-password' : 'current-password' });
  const pw2 = setup ? h('input', { class: 'input', type: 'password', placeholder: '再输入一次', autocomplete: 'new-password' }) : null;
  const err = h('div', { class: 'auth-err' });
  const btn = h('button', { class: 'btn btn-primary' }, setup ? '开始使用' : '登录');
  const card = h(
    'form',
    { class: 'auth-card card' },
    logo(26),
    h('h1', { class: 'auth-title' }, setup ? '欢迎使用云桥 SSH' : '云桥 SSH'),
    h('p', { class: 'auth-desc' }, setup ? '先设置一个访问密码。服务器的密码和私钥会加密保存在本机，只有输入这个密码才能使用。' : '输入访问密码以继续。'),
    pw,
    pw2,
    err,
    btn
  );
  card.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (setup && pw.value !== pw2.value) return (err.textContent = '两次输入的密码不一致');
    btn.disabled = true;
    try {
      await post(setup ? '/api/auth/setup' : '/api/auth/login', { password: pw.value });
      boot();
    } catch (ex) {
      err.textContent = ex.message;
      pw.select();
    } finally {
      btn.disabled = false;
    }
  });
  root.replaceChildren(h('div', { class: 'auth-page' }, card));
  setTimeout(() => pw.focus(), 50);
}

/* ---------- 主界面 ---------- */
class App {
  constructor() {
    this.hosts = [];
    this.tabs = [];
    this.active = null; // null = 主页
    this.filter = '';
    this.build();
    this.reloadHosts();
    snippetStore.load().catch(() => {});
    window.addEventListener('beforeunload', (e) => {
      if (this.tabs.some((t) => t.state === 'ready')) e.preventDefault();
    });
    document.addEventListener('keydown', (e) => {
      if (e.altKey && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        const n = Number(e.key);
        this.activate(n === 0 ? null : this.tabs[n - 1] || this.active);
      }
    });
  }

  build() {
    // 顶栏
    this.tabsTrack = h('div', { class: 'tabs-track' });
    this.homeTab = h('button', { class: 'tab home', title: '主页 (Alt+0)', html: `${icon('home', 14)}<span>主页</span>` });
    this.homeTab.addEventListener('click', () => this.activate(null));
    this.tabsTrack.append(this.homeTab);
    const round = (name, title, fn, cls = '') => {
      const b = h('button', { class: `tb-round ${cls}`, title, html: icon(name, 16) });
      b.addEventListener('click', fn);
      return b;
    };
    this.themeBtn = round(isDark() ? 'sun' : 'moon', '切换深色 / 浅色', () => {
      settings.theme = isDark() ? 'light' : 'dark';
      applyTheme();
      this.themeBtn.innerHTML = icon(isDark() ? 'sun' : 'moon', 16);
    });
    const menuBtn = round('menu', '主机列表', () => this.sidebar.classList.toggle('open'), 'menu-toggle');
    const titlebar = h(
      'header',
      { class: 'titlebar' },
      menuBtn,
      h('div', { class: 'brand' }, logo(), h('div', { class: 'brand-text' }, h('div', { class: 'brand-name' }, '云桥 SSH'), h('div', { class: 'brand-sub' }, '服务器远程管理'))),
      h('div', { class: 'tabs' }, this.tabsTrack),
      h('div', { class: 'tb-actions' }, this.themeBtn, round('settings', '设置', () => this.openSettings()), round('logout', '退出登录', () => this.logout(), 'hide-sm'))
    );

    // 侧栏
    this.searchInput = h('input', { class: 'input', placeholder: '搜索主机', spellcheck: 'false' });
    this.searchInput.addEventListener('input', () => {
      this.filter = this.searchInput.value.trim().toLowerCase();
      this.renderSidebar();
    });
    const addBtn = h('button', { class: 'icon-btn', title: '新建主机', html: icon('plus', 18) });
    addBtn.addEventListener('click', () => this.newHost());
    this.hostList = h('div', { class: 'sb-list' });
    this.quickInput = h('input', { class: 'input', placeholder: 'root@1.2.3.4:22', spellcheck: 'false' });
    const quickBtn = h('button', { class: 'btn btn-sm btn-primary', title: '快速连接' }, '连接');
    const quick = () => this.quickConnect(this.quickInput.value);
    quickBtn.addEventListener('click', quick);
    this.quickInput.addEventListener('keydown', (e) => e.key === 'Enter' && quick());
    this.sidebar = h(
      'aside',
      { class: 'sidebar card' },
      h(
        'div',
        { class: 'sb-head' },
        h('div', { class: 'sb-title-row' }, h('span', { class: 'sb-title' }, '主机'), addBtn),
        h('div', { class: 'search' }, h('span', { html: icon('search', 14) }).firstChild, this.searchInput)
      ),
      this.hostList,
      h('div', { class: 'sb-foot' }, h('div', { class: 'quick' }, this.quickInput, quickBtn), h('div', { class: 'sb-hint' }, '快速连接：用户名@地址:端口'))
    );

    // 工作区
    this.homeView = h('div', { class: 'view home-view active' });
    this.workspace = h('main', { class: 'workspace' }, this.homeView);
    this.workspace.addEventListener('mousedown', () => this.sidebar.classList.remove('open'));

    root.replaceChildren(titlebar, h('div', { class: 'body' }, this.sidebar, this.workspace));
  }

  /* ---------- 主机 ---------- */
  async reloadHosts(silent) {
    try {
      this.hosts = await get('/api/hosts');
    } catch (e) {
      if (!silent) toast(e.message, 'error');
    }
    this.renderSidebar();
    if (!this.active) this.renderHome();
  }

  groups() {
    return [...new Set(this.hosts.map((x) => x.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  isOnline(hostId) {
    return this.tabs.some((t) => t.hostId === hostId && t.state === 'ready');
  }

  renderSidebar() {
    const f = this.filter;
    const list = this.hosts.filter((x) => !f || `${x.name} ${x.host} ${x.username} ${x.group} ${x.note}`.toLowerCase().includes(f));
    if (!this.hosts.length) {
      this.hostList.replaceChildren(h('div', { class: 'sb-empty', html: `还没有主机<br>点右上角 <b>+</b> 添加一台服务器` }));
      return;
    }
    if (!list.length) {
      this.hostList.replaceChildren(h('div', { class: 'sb-empty' }, '没有匹配的主机'));
      return;
    }
    const byGroup = new Map();
    for (const x of list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))) {
      const g = x.group || '';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(x);
    }
    const keys = [...byGroup.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh-CN')));
    const frag = document.createDocumentFragment();
    const showHeads = keys.length > 1 || keys[0] !== '';
    for (const g of keys) {
      const collapsed = !f && settings.collapsedGroups.includes(g);
      if (showHeads) {
        const head = h('div', { class: `group-head ${collapsed ? 'collapsed' : ''}`, html: `${icon('chevronDown', 13)}<span>${esc(g || '未分组')}</span><span class="group-count">${byGroup.get(g).length}</span>` });
        head.addEventListener('click', () => {
          const set = new Set(settings.collapsedGroups);
          set.has(g) ? set.delete(g) : set.add(g);
          settings.collapsedGroups = [...set];
          this.renderSidebar();
        });
        frag.append(head);
      }
      if (collapsed) continue;
      for (const x of byGroup.get(g)) frag.append(this.hostRow(x));
    }
    this.hostList.replaceChildren(frag);
  }

  hostRow(x) {
    const online = this.isOnline(x.id);
    const isActive = this.active?.hostId === x.id;
    const more = h('button', { class: 'icon-btn sm', title: '更多', html: icon('more', 15) });
    const row = h(
      'div',
      { class: `host-row ${online ? 'online' : ''} ${isActive ? 'active' : ''}`, title: `${x.username}@${x.host}:${x.port}${x.note ? `\n${x.note}` : ''}` },
      h('div', { class: 'host-ico', html: icon('server', 15) }),
      h('div', { class: 'host-meta' }, h('div', { class: 'host-name' }, x.name), h('div', { class: 'host-sub' }, `${x.username}@${x.host}${x.port !== 22 ? `:${x.port}` : ''}`)),
      online ? h('span', { class: 'dot ok' }) : null,
      more
    );
    row.addEventListener('click', (e) => {
      if (e.target.closest('.icon-btn')) return;
      this.openHost(x);
      this.sidebar.classList.remove('open');
    });
    const menu = (mx, my) => this.hostMenu(x, mx, my);
    more.addEventListener('click', (e) => {
      const r = more.getBoundingClientRect();
      menu(r.left, r.bottom + 4);
      e.stopPropagation();
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      menu(e.clientX, e.clientY);
    });
    return row;
  }

  hostMenu(x, mx, my) {
    showMenu(mx, my, [
      { label: '连接', icon: 'terminal', onClick: () => this.openHost(x) },
      { label: '在新标签页中连接', icon: 'plus', onClick: () => this.openHost(x, true) },
      '-',
      { label: '编辑', icon: 'pencil', onClick: () => this.editHost(x.id) },
      { label: '复制为新主机', icon: 'copy', onClick: () => this.newHost({ ...x, name: `${x.name} 副本`, id: undefined }) },
      { label: '复制 SSH 命令', icon: 'code', onClick: () => copyText(`ssh ${x.port !== 22 ? `-p ${x.port} ` : ''}${x.username}@${x.host}`) },
      '-',
      { label: '删除', icon: 'trash', danger: true, onClick: () => this.deleteHost(x) },
    ]);
  }

  async newHost(preset) {
    const { id, fingerprint, hasPassword, hasKey, hasPassphrase, ...rest } = preset || {};
    const r = await hostForm({ groups: this.groups(), preset: rest });
    if (!r) return;
    toast('主机已保存', 'success');
    await this.reloadHosts();
    if (r.connect) this.openHost(r.host, true);
  }

  async editHost(id) {
    const x = this.hosts.find((h0) => h0.id === id);
    if (!x) return;
    const r = await hostForm({ host: x, groups: this.groups() });
    if (!r) return;
    toast('已保存', 'success');
    await this.reloadHosts();
    for (const t of this.tabs) if (t.hostId === id) t.host = r.host;
    if (r.connect) {
      const t = this.tabs.find((t0) => t0.hostId === id);
      if (t && t.state !== 'ready') {
        this.activate(t);
        t.reconnect();
      } else this.openHost(r.host, true);
    }
  }

  async deleteHost(x) {
    const ok = await confirmDialog({ title: `删除“${x.name}”？`, message: '保存的密码和私钥也会一起删除。已打开的终端不受影响。', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await del(`/api/hosts/${x.id}`);
      toast('已删除', 'success');
      this.reloadHosts();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async quickConnect(text) {
    const r = await quickConnectDialog(text);
    if (!r) return;
    this.quickInput.value = '';
    this.addTab(new TermSession({ target: r.target, save: r.save, app: this }));
  }

  /* ---------- 标签页 ---------- */
  openHost(x, forceNew) {
    if (!forceNew) {
      const t = this.tabs.find((t0) => t0.hostId === x.id);
      if (t) return this.activate(t);
    }
    this.addTab(new TermSession({ host: x, app: this }));
  }

  addTab(t) {
    const label = h('span', { class: 'tab-label' }, t.label);
    const dot = h('span', { class: 'dot busy' });
    const x = h('span', { class: 'tab-x', title: '关闭', html: icon('x', 12, 2.2) });
    t.tabEl = h('button', { class: 'tab', title: t.addr }, dot, label, x);
    t.tabDot = dot;
    t.tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.tab-x')) return this.closeTab(t);
      this.activate(t);
    });
    t.tabEl.addEventListener('auxclick', (e) => e.button === 1 && this.closeTab(t));
    t.tabEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: '重新连接', icon: 'rotate', onClick: () => t.reconnect() },
        t.host ? { label: '复制会话', icon: 'copy', onClick: () => this.openHost(t.host, true) } : null,
        '-',
        { label: '关闭', icon: 'x', onClick: () => this.closeTab(t) },
        { label: '关闭其他标签', icon: 'x', disabled: this.tabs.length < 2, onClick: () => this.tabs.filter((o) => o !== t).forEach((o) => this.closeTab(o, true)) },
      ]);
    });
    this.tabs.push(t);
    this.tabsTrack.append(t.tabEl);
    t.mount(this.workspace);
    this.activate(t);
    t.tabEl.scrollIntoView({ inline: 'nearest' });
  }

  activate(t) {
    if (this.active && this.active !== t) this.active.deactivate();
    this.active = t;
    this.homeTab.classList.toggle('active', !t);
    this.homeView.classList.toggle('active', !t);
    for (const o of this.tabs) o.tabEl.classList.toggle('active', o === t);
    if (t) {
      t.activate();
      t.tabEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    } else this.renderHome();
    this.renderSidebar();
  }

  async closeTab(t, silent) {
    if (!silent && t.state === 'ready') {
      const ok = await confirmDialog({ title: `关闭“${t.label}”？`, message: '终端会话会断开，正在运行的前台程序可能会被终止。', okText: '关闭', iconName: 'x' });
      if (!ok) return;
    }
    const i = this.tabs.indexOf(t);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    t.tabEl.remove();
    t.dispose();
    if (this.active === t) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)] || null);
    else this.renderSidebar();
  }

  onSessionState(t) {
    if (t.tabDot) t.tabDot.className = `dot ${{ connecting: 'busy', ready: 'ok', closed: '', error: 'err' }[t.state] || ''}`;
    this.renderSidebar();
  }

  applySideToAll() {
    for (const t of this.tabs) t.applySide();
  }

  /* ---------- 主页 ---------- */
  renderHome() {
    const hour = new Date().getHours();
    const hello = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
    const recent = [...this.hosts].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || a.name.localeCompare(b.name, 'zh-CN'));
    const grid = h('div', { class: 'host-grid' });
    recent.forEach((x, i) => {
      const card = h(
        'div',
        { class: 'host-card card', style: { animationDelay: `${Math.min(i, 12) * 30}ms` } },
        h('div', { class: 'hc-top' }, h('div', { class: 'hc-ico', html: icon('server', 20) }), h('div', { class: 'grow' }, h('div', { class: 'hc-name ellipsis' }, x.name), h('div', { class: 'hc-addr ellipsis' }, `${x.username}@${x.host}:${x.port}`))),
        h(
          'div',
          { class: 'hc-foot' },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, this.isOnline(x.id) ? h('span', { class: 'dot ok' }) : null, this.isOnline(x.id) ? '已连接' : `${x.group ? `${x.group} · ` : ''}${fmtAgo(x.lastUsedAt)}`),
          h('span', { class: 'hc-go', html: icon('chevronRight', 15, 2) })
        )
      );
      card.addEventListener('click', () => this.openHost(x));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.hostMenu(x, e.clientX, e.clientY);
      });
      grid.append(card);
    });
    const add = h('div', { class: 'host-card add', html: `${icon('plus', 22)}<span>新建主机</span>` });
    add.addEventListener('click', () => this.newHost());
    grid.append(add);

    const newBtn = h('button', { class: 'btn btn-primary', html: `${icon('plus', 15)}新建主机` });
    newBtn.addEventListener('click', () => this.newHost());
    const quickBtn = h('button', { class: 'btn', html: `${icon('zap', 15)}快速连接` });
    quickBtn.addEventListener('click', () => this.quickConnect(''));

    const feature = (ic, title, text) => h('div', { class: 'feature card' }, h('div', { class: 'fi', html: icon(ic, 17) }), h('b', {}, title), h('span', {}, text));

    this.homeView.replaceChildren(
      h('div', { class: 'home-hello' }, `${hello} 👋`),
      h('h1', { class: 'home-title', html: '在浏览器里，<em>管理</em>你的每一台服务器' }),
      h('p', { class: 'home-desc' }, '多标签 SSH 终端、拖拽上传的文件管理、实时资源监控和一键执行的快捷命令。所有密码与私钥都加密保存在这台电脑上。'),
      h('div', { class: 'home-actions' }, newBtn, quickBtn),
      h('div', { class: 'sec-label' }, 'Servers'),
      h('div', { class: 'sec-title' }, this.hosts.length ? `我的主机 · ${this.hosts.length}` : '添加第一台主机'),
      grid,
      h(
        'div',
        { class: 'features' },
        feature('terminal', '多标签终端', '256 色、查找、复制粘贴、自适应窗口大小，断线可一键重连。'),
        feature('folder', 'SFTP 文件管理', '浏览、上传下载、拖拽上传、在线编辑、改权限，目录可打包下载。'),
        feature('activity', '实时监控', 'CPU、内存、网络、磁盘和进程，图表每 3 秒刷新。'),
        feature('code', '快捷命令', '常用命令一键执行，还能同时发送到所有已连接的服务器。')
      )
    );
  }

  /* ---------- 设置 ---------- */
  openSettings() {
    const row = (title, desc, control) => h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('b', {}, title), desc ? h('span', {}, desc) : null), control);
    const sw = (key) => {
      const input = h('input', { type: 'checkbox' });
      input.checked = !!settings[key];
      input.addEventListener('change', () => (settings[key] = input.checked));
      return h('label', { class: 'switch' }, input, h('i'));
    };
    const themeSeg = h('div', { class: 'seg' });
    for (const [v, label] of [
      ['system', '跟随系统'],
      ['light', '浅色'],
      ['dark', '深色'],
    ]) {
      const b = h('button', { class: settings.theme === v ? 'active' : '' }, label);
      b.addEventListener('click', () => {
        settings.theme = v;
        applyTheme();
        this.themeBtn.innerHTML = icon(isDark() ? 'sun' : 'moon', 16);
        for (const o of themeSeg.children) o.classList.toggle('active', o === b);
      });
      themeSeg.append(b);
    }
    const fontSize = h('input', { class: 'input', type: 'number', min: 9, max: 28, value: settings.fontSize, style: { width: '76px' } });
    fontSize.addEventListener('change', () => (settings.fontSize = Math.max(9, Math.min(28, Number(fontSize.value) || 14))));
    const fontFamily = h('input', { class: 'input mono-sm', value: settings.fontFamily, style: { width: '220px' } });
    fontFamily.addEventListener('change', () => (settings.fontFamily = fontFamily.value || "Consolas, monospace"));

    const oldPw = h('input', { class: 'input', type: 'password', placeholder: '当前密码', autocomplete: 'current-password' });
    const newPw = h('input', { class: 'input', type: 'password', placeholder: '新密码（至少 6 位）', autocomplete: 'new-password' });
    const pwBtn = h('button', { class: 'btn btn-sm' }, '修改');
    pwBtn.addEventListener('click', async () => {
      try {
        await post('/api/auth/password', { oldPassword: oldPw.value, newPassword: newPw.value });
        oldPw.value = newPw.value = '';
        toast('访问密码已修改', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });

    const body = h(
      'div',
      { class: 'modal-body' },
      row('外观', null, themeSeg),
      row('终端字号', '也可以用终端右上角的 − / + 调整', fontSize),
      row('终端字体', '等宽字体，按顺序回退', fontFamily),
      row('光标闪烁', null, sw('cursorBlink')),
      row('选中即复制', '在终端里选中文字后自动复制', sw('copyOnSelect')),
      row('右键复制 / 粘贴', '有选中内容时右键复制，否则粘贴', sw('rightClickPaste')),
      h('div', { class: 'set-row', style: { flexDirection: 'column', alignItems: 'stretch', gap: '8px', paddingTop: '10px' } }, h('div', { class: 'set-label' }, h('b', {}, '修改访问密码'), h('span', {}, '修改后其他设备上的登录会失效')), h('div', { style: { display: 'flex', gap: '8px' } }, oldPw, newPw, pwBtn)),
      h('div', { class: 'muted', style: { fontSize: '12px', margin: '14px 0 4px' } }, '快捷键：Alt+数字 切换标签 · Ctrl+Shift+C / V 复制粘贴 · Ctrl+Shift+F 终端内查找')
    );
    modal({ title: '设置', body, footer: h('div', { style: { height: '14px' } }) }).el.style.width = '560px';
  }

  async logout() {
    if (this.tabs.some((t) => t.state === 'ready')) {
      const ok = await confirmDialog({ title: '退出登录？', message: '所有已打开的终端都会断开。', okText: '退出', iconName: 'logout' });
      if (!ok) return;
    }
    await post('/api/auth/logout').catch(() => {});
    location.reload();
  }
}

/* ---------- 启动 ---------- */
let app = null;
async function boot() {
  applyTheme();
  let status;
  try {
    status = await get('/api/auth/status');
  } catch (e) {
    root.replaceChildren(h('div', { class: 'auth-page' }, h('div', { class: 'auth-card card' }, h('div', { class: 'auth-title' }, '无法连接服务'), h('p', { class: 'auth-desc' }, e.message))));
    return;
  }
  if (!status.setup) return authScreen(true);
  if (!status.authed) return authScreen(false);
  app = new App();
  window.yq = app;
}

setUnauthorizedHandler(() => {
  if (app) {
    app = null;
    toast('登录已过期，请重新登录', 'error');
    authScreen(false);
  }
});

boot();
