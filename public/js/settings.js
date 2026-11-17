// 浏览器本地偏好设置（主题、终端字号等）
const KEY = 'yq.settings';
const DEFAULTS = {
  theme: 'system', // system | light | dark
  fontSize: 14,
  fontFamily: "'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'Courier New', monospace",
  cursorBlink: true,
  copyOnSelect: false,
  rightClickPaste: true,
  scrollback: 5000,
  sideWidth: 380,
  sideOpen: true,
  sidePane: 'files',
  showHidden: false,
  collapsedGroups: [],
};

let state = { ...DEFAULTS };
try {
  state = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
} catch {}

const listeners = new Set();

export const settings = new Proxy(state, {
  set(target, k, v) {
    target[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(target));
    } catch {}
    for (const fn of listeners) fn(k, v);
    return true;
  },
});

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const mq = matchMedia('(prefers-color-scheme: dark)');
export function isDark() {
  return settings.theme === 'dark' || (settings.theme === 'system' && mq.matches);
}
export function applyTheme() {
  document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';
  for (const fn of listeners) fn('resolvedTheme', isDark());
}
mq.addEventListener('change', () => settings.theme === 'system' && applyTheme());
