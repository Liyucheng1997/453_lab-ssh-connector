// 通用界面工具：元素创建、提示、对话框、右键菜单、格式化
import { icon } from './icons.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function iconEl(name, size, sw) {
  const t = document.createElement('template');
  t.innerHTML = icon(name, size, sw);
  return t.content.firstChild;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------- 提示 ---------- */
export function toast(message, type = 'info', ms = 2600) {
  const host = document.getElementById('toasts');
  const t = h('div', { class: `toast toast-${type}` }, message);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 350);
  }, ms);
}

/* ---------- 对话框 ---------- */
const openModals = [];

export function modal({ title, body, footer, wide = false, className = '', onClose, closeOnOverlay = true }) {
  const overlay = h('div', { class: 'modal-overlay' });
  const closeBtn = h('button', { class: 'modal-x', title: '关闭', html: icon('x', 14, 2) });
  const header = title != null ? h('div', { class: 'modal-header' }, typeof title === 'string' ? h('span', {}, title) : title, closeBtn) : null;
  const box = h('div', { class: `modal ${wide ? 'wide' : ''} ${className}`, role: 'dialog' }, header, body, footer);
  overlay.append(box);
  let closed = false;
  const api = {
    el: box,
    overlay,
    close(result) {
      if (closed) return;
      closed = true;
      overlay.remove();
      openModals.splice(openModals.indexOf(api), 1);
      onClose?.(result);
    },
  };
  closeBtn.addEventListener('click', () => api.close());
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay && closeOnOverlay) api.close();
  });
  openModals.push(api);
  document.body.append(overlay);
  setTimeout(() => box.querySelector('[autofocus], input:not([type=hidden]), textarea, button.btn-primary')?.focus(), 30);
  return api;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openModals.length) {
    e.stopPropagation();
    openModals[openModals.length - 1].close();
  }
});

export function confirmDialog({ title, message = '', okText = '确定', cancelText = '取消', danger = false, iconName }) {
  return new Promise((resolve) => {
    const ok = h('button', { class: `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}` }, okText);
    const cancel = h('button', { class: 'btn' }, cancelText);
    const body = h(
      'div',
      { class: 'confirm' },
      h('div', { class: `ov-ico ${danger ? 'danger' : ''}`, html: icon(iconName || (danger ? 'trash' : 'alert'), 22) }),
      h('div', { class: 'ov-title' }, title),
      message ? h('div', { class: 'ov-msg' }, message) : null,
      h('div', { class: 'confirm-btns' }, cancel, ok)
    );
    const m = modal({ title: null, body, onClose: (r) => resolve(!!r) });
    ok.addEventListener('click', () => m.close(true));
    cancel.addEventListener('click', () => m.close(false));
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') m.close(true);
    });
    setTimeout(() => ok.focus(), 30);
  });
}

export function promptDialog({ title, label = '', value = '', placeholder = '', okText = '确定', mono = false, validate, selectBase = false }) {
  return new Promise((resolve) => {
    const input = h('input', { class: `input ${mono ? 'mono-sm' : ''}`, value, placeholder, spellcheck: 'false' });
    const err = h('div', { class: 'form-err' });
    const ok = h('button', { class: 'btn btn-primary' }, okText);
    const cancel = h('button', { class: 'btn' }, '取消');
    const body = h('div', { class: 'modal-body' }, h('div', { class: 'form' }, label ? h('div', { class: 'form-label' }, label) : null, input, err));
    const footer = h('div', { class: 'modal-footer' }, cancel, ok);
    const m = modal({ title, body, footer, onClose: (r) => resolve(r ?? null) });
    const submit = () => {
      const v = input.value.trim();
      const msg = validate?.(v);
      if (msg) {
        err.textContent = msg;
        return;
      }
      m.close(v);
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => m.close(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    setTimeout(() => {
      input.focus();
      if (selectBase && value.lastIndexOf('.') > 0) input.setSelectionRange(0, value.lastIndexOf('.'));
      else input.select();
    }, 40);
  });
}

/* ---------- 右键菜单 ---------- */
let currentMenu = null;
export function closeMenu() {
  currentMenu?.remove();
  currentMenu = null;
}

/** items: [{label, icon, onClick, danger, disabled, shortcut} | '-'] */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'popover menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      menu.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    const row = h(
      'div',
      { class: `menu-item ${it.disabled ? 'disabled' : ''}`, style: it.danger ? { color: 'var(--danger)' } : null },
      h('span', { class: 'menu-icon', html: it.icon ? icon(it.icon, 15) : '' }),
      h('span', { class: 'menu-label' }, it.label),
      it.shortcut ? h('span', { class: 'menu-shortcut' }, it.shortcut) : null
    );
    if (!it.disabled) {
      row.addEventListener('click', () => {
        closeMenu();
        it.onClick?.();
      });
    }
    menu.append(row);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  currentMenu = menu;
}
document.addEventListener('mousedown', (e) => {
  if (currentMenu && !currentMenu.contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

/* ---------- 格式化 ---------- */
export function fmtBytes(n, digits = 1) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : digits)} ${u[i]}`;
}

export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtAgo(ms) {
  if (!ms) return '从未连接';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return fmtTime(ms);
}

export function fmtDuration(sec) {
  sec = Math.floor(sec || 0);
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  if (d) return `${d} 天 ${hh} 小时`;
  if (hh) return `${hh} 小时 ${mm} 分`;
  return `${mm} 分钟`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制', 'success', 1400);
}
