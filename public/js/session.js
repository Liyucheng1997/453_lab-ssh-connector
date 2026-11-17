// 一个终端会话标签页：xterm 终端 + 右侧（文件 / 监控 / 命令）面板
import { Terminal } from '/vendor/xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm/addon-fit/lib/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/xterm/addon-web-links/lib/addon-web-links.mjs';
import { SearchAddon } from '/vendor/xterm/addon-search/lib/addon-search.mjs';
import { h, iconEl, toast, copyText } from './ui.js';
import { icon } from './icons.js';
import { settings, isDark, onSettingsChange } from './settings.js';
import { post } from './api.js';
import { FilesPane } from './files.js';
import { MonitorPane } from './monitor.js';
import { CommandsPane } from './commands.js';

const LIGHT = {
  background: '#ffffff',
  foreground: '#1d1d1f',
  cursor: '#0071e3',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(0,113,227,0.22)',
  black: '#1d1d1f',
  red: '#c41a16',
  green: '#1f7a35',
  yellow: '#9a6700',
  blue: '#0058c4',
  magenta: '#a626a4',
  cyan: '#0e7490',
  white: '#8e8e93',
  brightBlack: '#6e6e73',
  brightRed: '#d70015',
  brightGreen: '#248a3d',
  brightYellow: '#b25000',
  brightBlue: '#0071e3',
  brightMagenta: '#ad3bd6',
  brightCyan: '#0891b2',
  brightWhite: '#3a3a3c',
};
const DARK = {
  background: '#1c1c1e',
  foreground: '#f5f5f7',
  cursor: '#0a84ff',
  cursorAccent: '#1c1c1e',
  selectionBackground: 'rgba(10,132,255,0.35)',
  black: '#3a3a3c',
  red: '#ff6961',
  green: '#4cd964',
  yellow: '#ffd426',
  blue: '#409cff',
  magenta: '#da8fff',
  cyan: '#5ac8fa',
  white: '#d1d1d6',
  brightBlack: '#8e8e93',
  brightRed: '#ff8a80',
  brightGreen: '#6ee38b',
  brightYellow: '#ffe066',
  brightBlue: '#70b5ff',
  brightMagenta: '#e6b0ff',
  brightCyan: '#8ad8fc',
  brightWhite: '#ffffff',
};
const termTheme = () => (isDark() ? DARK : LIGHT);

let seq = 0;

export class TermSession {
  /**
   * @param {object} opts
   * @param {object} opts.host        已保存的主机（可选）
   * @param {object} opts.target      快速连接参数（可选）
   * @param {boolean} opts.save       快速连接后保存
   * @param {object} opts.app         App 实例
   */
  constructor({ host, target, save, app }) {
    this.key = `t${++seq}`;
    this.app = app;
    this.host = host || null;
    this.target = target || null;
    this.save = !!save;
    this.label = host ? host.name : `${target.username}@${target.host}`;
    this.addr = host ? `${host.username}@${host.host}:${host.port}` : `${target.username}@${target.host}:${target.port || 22}`;
    this.state = 'idle'; // idle | connecting | ready | closed | error
    this.sessionId = null;
    this.ws = null;
    this.unsubs = [];
    this.build();
  }

  get hostId() {
    return this.host?.id || null;
  }

  build() {
    this.stateDot = h('span', { class: 'dot busy' });
    this.stateText = h('span', {}, '连接中');
    // FitAddon 按父元素的计算宽度算列数（border-box 下包含 padding），所以终端放进无 padding 的内层
    this.termInner = h('div', { class: 'term-inner' });
    this.termHost = h('div', { class: 'term-host' }, this.termInner);

    const tool = (name, title, fn) => {
      const b = h('button', { class: 'icon-btn sm', title, html: icon(name, 15) });
      b.addEventListener('click', fn);
      return b;
    };
    this.sideBtn = tool('panel', '显示/隐藏侧边栏', () => this.toggleSide());
    const bar = h(
      'div',
      { class: 'term-bar' },
      h('span', { class: 'term-title ellipsis' }, this.label),
      h('span', { class: 'term-sub ellipsis' }, this.addr),
      h('span', { class: 'term-state' }, this.stateDot, this.stateText),
      h(
        'div',
        { class: 'term-tools' },
        tool('search', '在终端中查找 (Ctrl+Shift+F)', () => this.openSearch()),
        tool('minus', '缩小字号', () => this.zoom(-1)),
        tool('plus', '放大字号', () => this.zoom(1)),
        tool('eraser', '清屏', () => this.term?.clear()),
        tool('rotate', '重新连接', () => this.reconnect()),
        this.sideBtn
      )
    );
    this.termCard = h('div', { class: 'term-card card' }, bar, this.termHost);

    // 侧边栏
    this.files = new FilesPane(this);
    this.monitor = new MonitorPane(this);
    this.commands = new CommandsPane(this);
    this.panes = { files: this.files, monitor: this.monitor, commands: this.commands };
    const seg = h('div', { class: 'seg' });
    this.segBtns = {};
    for (const [k, label, ic] of [
      ['files', '文件', 'folder'],
      ['monitor', '监控', 'activity'],
      ['commands', '命令', 'code'],
    ]) {
      const b = h('button', { html: `${icon(ic, 14)}<span>${label}</span>` });
      b.addEventListener('click', () => this.showPane(k));
      this.segBtns[k] = b;
      seg.append(b);
    }
    const closeSide = h('button', { class: 'icon-btn sm', title: '收起侧边栏', html: icon('x', 14) });
    closeSide.addEventListener('click', () => this.toggleSide(false));
    this.side = h(
      'aside',
      { class: 'side card' },
      h('div', { class: 'side-head' }, seg, closeSide),
      h('div', { class: 'side-body' }, this.files.el, this.monitor.el, this.commands.el)
    );
    this.resizer = h('div', { class: 'resizer', title: '拖动调整宽度' });
    this.bindResizer();

    this.view = h('div', { class: 'view session-view' }, this.termCard, this.resizer, this.side);
    this.applySide();
  }

  /* ---------- 生命周期 ---------- */
  mount(container) {
    container.append(this.view);
    this.term = new Terminal({
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      theme: termTheme(),
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
    });
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
    this.term.open(this.termInner);

    this.term.onData((d) => this.sendInput(d));
    this.term.onBinary((d) => {
      if (this.ws?.readyState === 1) this.ws.send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 255));
    });
    this.term.onResize(({ cols, rows }) => this.sendJson({ type: 'resize', cols, rows }));
    this.term.onSelectionChange(() => {
      if (settings.copyOnSelect && this.term.hasSelection()) navigator.clipboard?.writeText(this.term.getSelection()).catch(() => {});
    });
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && e.shiftKey && k === 'c') {
        if (this.term.hasSelection()) copyText(this.term.getSelection());
        return false;
      }
      if (e.ctrlKey && e.shiftKey && k === 'v') {
        this.paste();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && k === 'f') {
        this.openSearch();
        return false;
      }
      return true;
    });
    this.termHost.addEventListener('contextmenu', (e) => {
      if (!settings.rightClickPaste) return;
      e.preventDefault();
      if (this.term.hasSelection()) {
        copyText(this.term.getSelection());
        this.term.clearSelection();
      } else this.paste();
    });

    this.ro = new ResizeObserver(() => this.doFit());
    this.ro.observe(this.termInner);
    document.fonts?.ready.then(() => this.doFit());
    this.unsubs.push(
      onSettingsChange((k) => {
        if (!this.term) return;
        if (k === 'resolvedTheme' || k === 'theme') this.term.options.theme = termTheme();
        if (k === 'fontSize') {
          this.term.options.fontSize = settings.fontSize;
          this.doFit();
        }
        if (k === 'fontFamily') {
          this.term.options.fontFamily = settings.fontFamily;
          this.doFit();
        }
        if (k === 'cursorBlink') this.term.options.cursorBlink = settings.cursorBlink;
      })
    );
    this.showPane(settings.sidePane, true);
    this.doFit();
    this.connect();
  }

  doFit() {
    if (!this.term || !this.view.classList.contains('active')) return;
    try {
      this.fit.fit();
    } catch {}
  }

  activate() {
    this.view.classList.add('active');
    requestAnimationFrame(() => {
      this.doFit();
      this.term?.focus();
    });
    if (this.sideOpen) this.panes[this.activePane]?.onShow?.();
  }

  deactivate() {
    this.view.classList.remove('active');
    this.monitor.onHide();
  }

  dispose() {
    this.disposed = true;
    this.ws?.close();
    this.ro?.disconnect();
    this.monitor.onHide();
    this.commands.dispose();
    for (const u of this.unsubs) u();
    this.term?.dispose();
    this.view.remove();
  }

  /* ---------- 连接 ---------- */
  setState(state, text) {
    this.state = state;
    this.stateDot.className = `dot ${{ connecting: 'busy', ready: 'ok', closed: '', error: 'err' }[state] || ''}`;
    this.stateText.textContent = text;
    this.app.onSessionState(this);
  }

  connect(acceptFingerprint) {
    this.clearOverlay();
    this.setState('connecting', '连接中');
    this.showOverlay({ kind: 'connecting', title: '正在连接', message: this.addr });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let gotEnd = false;
    ws.onopen = () => {
      const msg = { type: 'connect', cols: this.term.cols, rows: this.term.rows, acceptFingerprint };
      if (this.host) msg.hostId = this.host.id;
      else {
        msg.target = this.target;
        msg.save = this.save;
      }
      ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.term.write(new Uint8Array(ev.data));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'status') {
        this.showOverlay({ kind: 'connecting', title: '正在连接', message: msg.message });
      } else if (msg.type === 'ready') {
        this.sessionId = msg.sessionId;
        this.fingerprint = msg.fingerprint;
        if (msg.savedHost) {
          this.host = msg.savedHost;
          this.target = null;
          this.save = false;
          this.app.reloadHosts();
          toast('已保存到主机列表', 'success');
        }
        this.clearOverlay();
        this.setState('ready', '已连接');
        this.term.focus();
        this.doFit();
        this.sendJson({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
        this.app.reloadHosts(true);
        for (const p of Object.values(this.panes)) p.onConnected?.();
      } else if (msg.type === 'error') {
        gotEnd = true;
        this.sessionId = null;
        this.setState('error', '连接失败');
        if (msg.code === 'HOSTKEY_CHANGED') this.showHostKeyChanged(msg);
        else this.showOverlay({ kind: 'error', title: '连接失败', message: msg.message });
      } else if (msg.type === 'closed') {
        gotEnd = true;
        this.onClosed(msg.message);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.disposed) return;
      if (!gotEnd) this.onClosed(this.state === 'connecting' ? '无法连接到云桥服务' : '与云桥服务的连接已断开');
    };
  }

  onClosed(message) {
    if (this.state === 'closed') return;
    this.sessionId = null;
    this.setState('closed', '已断开');
    this.term.write(`\r\n\x1b[2m—— ${message} ——\x1b[0m\r\n`);
    this.showOverlay({ kind: 'closed', title: message, message: '可以重新连接，或关闭这个标签页。', dim: true });
    this.monitor.onHide();
  }

  reconnect() {
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.sessionId = null;
    this.term.reset();
    this.connect();
  }

  sendInput(data) {
    if (this.ws?.readyState === 1 && this.state === 'ready') this.ws.send(new TextEncoder().encode(data));
  }

  sendJson(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  async paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.term.paste(text);
    } catch {
      toast('浏览器不允许读取剪贴板，请使用 Ctrl+V', 'error');
    }
  }

  /* ---------- 遮罩层 ---------- */
  clearOverlay() {
    this.overlay?.remove();
    this.overlay = null;
  }

  showOverlay({ kind, title, message, dim, extra, actions }) {
    this.clearOverlay();
    const icoName = { connecting: 'plug', error: 'alert', closed: 'wifiOff', hostkey: 'shield' }[kind];
    const icoCls = kind === 'error' ? 'danger' : kind === 'hostkey' ? 'warn' : '';
    const card = h(
      'div',
      { class: 'ov-card' },
      kind === 'connecting' ? h('div', { class: 'spinner' }) : h('div', { class: `ov-ico ${icoCls}`, html: icon(icoName, 22) }),
      h('div', { class: 'ov-title' }, title),
      message ? h('div', { class: 'ov-msg' }, message) : null,
      extra || null
    );
    if (kind !== 'connecting') {
      const row = h('div', { class: 'ov-actions' });
      const btns = actions || [
        ['关闭标签', '', () => this.app.closeTab(this)],
        ['重新连接', 'btn-primary', () => this.reconnect()],
      ];
      if (kind === 'error' && this.host && !actions) btns.splice(1, 0, ['编辑主机', '', () => this.app.editHost(this.host.id)]);
      for (const [label, cls, fn] of btns) {
        const b = h('button', { class: `btn ${cls}` }, label);
        b.addEventListener('click', fn);
        row.append(b);
      }
      card.append(row);
    }
    this.overlay = h('div', { class: `term-overlay ${dim ? 'dim' : ''}` }, card);
    this.termHost.append(this.overlay);
  }

  showHostKeyChanged(msg) {
    const extra = h('div', { class: 'ov-fp' }, h('div', {}, `上次记录：${msg.expected}`), h('div', {}, `本次收到：${msg.fingerprint}`));
    this.showOverlay({
      kind: 'hostkey',
      title: '服务器指纹已变化',
      message: msg.message,
      extra,
      actions: [
        ['关闭标签', '', () => this.app.closeTab(this)],
        [
          '信任新指纹并连接',
          'btn-primary',
          async () => {
            if (this.host) await post(`/api/hosts/${this.host.id}/trust`, { fingerprint: msg.fingerprint }).catch(() => {});
            this.term.reset();
            this.connect(msg.fingerprint);
          },
        ],
      ],
    });
  }

  /* ---------- 工具 ---------- */
  zoom(d) {
    settings.fontSize = Math.max(9, Math.min(28, settings.fontSize + d));
  }

  openSearch() {
    if (this.searchBar) {
      this.searchBar.querySelector('input').focus();
      return;
    }
    const input = h('input', { placeholder: '查找…', spellcheck: 'false' });
    const opts = { decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#0071e3', activeMatchBackground: '#0071e3', matchBackground: '#0071e344' } };
    const prev = h('button', { class: 'icon-btn sm', title: '上一个', html: icon('arrowUp', 14) });
    const next = h('button', { class: 'icon-btn sm', title: '下一个', html: icon('arrowDown', 14) });
    const close = h('button', { class: 'icon-btn sm', title: '关闭', html: icon('x', 14) });
    const doClose = () => {
      this.search.clearDecorations();
      this.searchBar.remove();
      this.searchBar = null;
      this.term.focus();
    };
    input.addEventListener('input', () => this.search.findNext(input.value, { ...opts, incremental: true }));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (e.shiftKey ? this.search.findPrevious : this.search.findNext).call(this.search, input.value, opts);
      if (e.key === 'Escape') {
        e.stopPropagation();
        doClose();
      }
    });
    prev.addEventListener('click', () => this.search.findPrevious(input.value, opts));
    next.addEventListener('click', () => this.search.findNext(input.value, opts));
    close.addEventListener('click', doClose);
    this.searchBar = h('div', { class: 'search-bar' }, iconEl('search', 14), input, prev, next, close);
    this.termHost.append(this.searchBar);
    input.focus();
  }

  /* ---------- 侧边栏 ---------- */
  showPane(name, silent) {
    if (!this.panes[name]) name = 'files';
    this.panes[this.activePane]?.onHide?.();
    this.activePane = name;
    for (const [k, p] of Object.entries(this.panes)) {
      p.el.classList.toggle('active', k === name);
      this.segBtns[k].classList.toggle('active', k === name);
    }
    if (!silent) settings.sidePane = name;
    if (this.sideOpen && this.view.classList.contains('active')) this.panes[name].onShow?.();
  }

  toggleSide(force) {
    settings.sideOpen = force ?? !this.sideOpen;
    this.app.applySideToAll();
  }

  applySide() {
    this.sideOpen = settings.sideOpen;
    this.view.classList.toggle('side-closed', !this.sideOpen);
    this.sideBtn.classList.toggle('on', this.sideOpen);
    this.side.style.width = `${settings.sideWidth}px`;
    if (this.sideOpen && this.view.classList.contains('active')) this.panes[this.activePane]?.onShow?.();
    if (!this.sideOpen) this.monitor.onHide();
    requestAnimationFrame(() => this.doFit());
  }

  bindResizer() {
    this.resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.side.getBoundingClientRect().width;
      this.resizer.classList.add('dragging');
      this.resizer.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const w = Math.max(280, Math.min(Math.round(window.innerWidth * 0.6), startW + (startX - ev.clientX)));
        this.side.style.width = `${w}px`;
      };
      const up = () => {
        this.resizer.classList.remove('dragging');
        this.resizer.removeEventListener('pointermove', move);
        settings.sideWidth = Math.round(this.side.getBoundingClientRect().width);
        this.app.applySideToAll();
      };
      this.resizer.addEventListener('pointermove', move);
      this.resizer.addEventListener('pointerup', up, { once: true });
    });
  }
}
