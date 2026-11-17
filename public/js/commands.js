// 快捷命令 + 命令输入框（可广播到所有会话）
import { h, toast, confirmDialog, modal, showMenu } from './ui.js';
import { icon } from './icons.js';
import { get, post, put, del } from './api.js';

// 所有标签页共享一份快捷命令列表
export const snippetStore = {
  list: [],
  loaded: false,
  listeners: new Set(),
  async load() {
    this.list = await get('/api/snippets');
    this.loaded = true;
    this.emit();
  },
  emit() {
    for (const fn of this.listeners) fn();
  },
};

export function editSnippet(snippet) {
  const name = h('input', { class: 'input', value: snippet?.name || '', placeholder: '例如：重启 Nginx' });
  const cmd = h('textarea', { class: 'input mono-sm', rows: 5, placeholder: 'sudo systemctl restart nginx', spellcheck: 'false' });
  cmd.value = snippet?.command || '';
  const auto = h('input', { type: 'checkbox' });
  auto.checked = snippet ? snippet.autoRun !== false : true;
  const err = h('div', { class: 'form-err' });
  const ok = h('button', { class: 'btn btn-primary' }, '保存');
  const cancel = h('button', { class: 'btn' }, '取消');
  const m = modal({
    title: snippet ? '编辑快捷命令' : '新建快捷命令',
    body: h(
      'div',
      { class: 'modal-body' },
      h(
        'div',
        { class: 'form' },
        h('div', { class: 'form-row' }, h('span', { class: 'form-label' }, '名称'), name),
        h('div', { class: 'form-row top' }, h('span', { class: 'form-label' }, '命令'), cmd),
        h('label', { class: 'form-check', style: { marginLeft: '88px' } }, auto, '点击后直接执行（自动回车）'),
        err
      )
    ),
    footer: h('div', { class: 'modal-footer' }, cancel, ok),
  });
  cancel.addEventListener('click', () => m.close());
  ok.addEventListener('click', async () => {
    const body = { name: name.value, command: cmd.value, autoRun: auto.checked };
    try {
      if (snippet) await put(`/api/snippets/${snippet.id}`, body);
      else await post('/api/snippets', body);
      m.close();
      await snippetStore.load();
    } catch (e) {
      err.textContent = e.message;
    }
  });
}

export class CommandsPane {
  constructor(session) {
    this.s = session;
    this.history = [];
    this.histIdx = -1;
    this.listEl = h('div', { class: 'cmds' });
    const add = h('button', { class: 'btn btn-sm btn-ghost', html: `${icon('plus', 14)}新建` });
    add.addEventListener('click', () => editSnippet());
    const head = h('div', { class: 'mon-row', style: { padding: '0 14px 0 16px', marginBottom: '4px', alignItems: 'center' } }, h('span', { class: 'mon-label' }, '快捷命令'), add);

    this.input = h('textarea', { class: 'input', placeholder: '在这里输入命令，Enter 发送，Shift+Enter 换行，↑↓ 翻历史', spellcheck: 'false' });
    this.broadcast = h('input', { type: 'checkbox' });
    const send = h('button', { class: 'btn btn-primary btn-sm', html: `${icon('send', 13)}发送` });
    send.addEventListener('click', () => this.sendCompose());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.sendCompose();
      } else if (e.key === 'ArrowUp' && !this.input.value.includes('\n') && this.history.length) {
        e.preventDefault();
        this.histIdx = Math.min(this.history.length - 1, this.histIdx + 1);
        this.input.value = this.history[this.history.length - 1 - this.histIdx];
      } else if (e.key === 'ArrowDown' && this.histIdx >= 0) {
        e.preventDefault();
        this.histIdx--;
        this.input.value = this.histIdx < 0 ? '' : this.history[this.history.length - 1 - this.histIdx];
      }
    });
    const compose = h(
      'div',
      { class: 'cmd-compose' },
      this.input,
      h('div', { class: 'cmd-compose-row' }, h('label', { class: 'form-check', title: '同时发送到所有已连接的标签页' }, this.broadcast, '发送到所有会话'), send)
    );
    this.el = h('div', { class: 'pane' }, head, this.listEl, compose);
    this.render = this.render.bind(this);
    snippetStore.listeners.add(this.render);
    if (snippetStore.loaded) this.render();
  }

  onShow() {
    if (!snippetStore.loaded) snippetStore.load().catch((e) => toast(e.message, 'error'));
  }

  targets() {
    return this.broadcast.checked ? this.s.app.tabs.filter((t) => t.state === 'ready') : [this.s];
  }

  run(text, autoRun) {
    const targets = this.targets();
    if (!targets.some((t) => t.state === 'ready')) return toast('当前会话未连接', 'error');
    const payload = text.replace(/\r?\n/g, '\r') + (autoRun ? '\r' : '');
    for (const t of targets) t.sendInput(payload);
    if (targets.length > 1) toast(`已发送到 ${targets.length} 个会话`, 'success', 1600);
    this.s.term.focus();
  }

  sendCompose() {
    const text = this.input.value;
    if (!text.trim()) return;
    this.run(text, true);
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > 100) this.history.shift();
    this.histIdx = -1;
    this.input.value = '';
    this.input.focus();
  }

  render() {
    if (!snippetStore.list.length) {
      this.listEl.replaceChildren(h('div', { class: 'fs-empty', html: `${icon('code', 32, 1.4)}<div>还没有快捷命令</div>` }));
      return;
    }
    this.listEl.replaceChildren(
      ...snippetStore.list.map((sn) => {
        const more = h('button', { class: 'icon-btn sm', title: '更多', html: icon('more', 15) });
        const item = h(
          'div',
          { class: 'cmd-item', title: sn.autoRun ? '点击执行' : '点击填入终端（不回车）' },
          h('span', { class: 'cmd-ico', html: icon(sn.autoRun ? 'play' : 'terminal', 13) }),
          h('div', { class: 'grow' }, h('div', { class: 'cmd-name' }, sn.name), h('div', { class: 'cmd-code' }, sn.command.replace(/\n/g, ' ⏎ '))),
          more
        );
        item.addEventListener('click', (e) => {
          if (e.target.closest('.icon-btn')) return;
          this.run(sn.command, sn.autoRun);
        });
        const menu = (x, y) =>
          showMenu(x, y, [
            { label: '执行', icon: 'play', onClick: () => this.run(sn.command, true) },
            { label: '填入输入框', icon: 'pencil', onClick: () => ((this.input.value = sn.command), this.input.focus()) },
            '-',
            { label: '编辑', icon: 'settings', onClick: () => editSnippet(sn) },
            {
              label: '删除',
              icon: 'trash',
              danger: true,
              onClick: async () => {
                if (!(await confirmDialog({ title: `删除“${sn.name}”？`, okText: '删除', danger: true }))) return;
                await del(`/api/snippets/${sn.id}`).catch((e) => toast(e.message, 'error'));
                snippetStore.load();
              },
            },
          ]);
        more.addEventListener('click', (e) => {
          const r = more.getBoundingClientRect();
          menu(r.left, r.bottom + 4);
          e.stopPropagation();
        });
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          menu(e.clientX, e.clientY);
        });
        return item;
      })
    );
  }

  dispose() {
    snippetStore.listeners.delete(this.render);
  }
}
