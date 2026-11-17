// 服务器实时监控面板：面板可见时每 3 秒采样一次
import { h, toast, confirmDialog, fmtBytes, fmtDuration } from './ui.js';
import { icon } from './icons.js';
import { get, post } from './api.js';

const HISTORY = 60;
const INTERVAL = 3000;

function spark(series, max, second) {
  const w = 100;
  const hgt = 30;
  const n = HISTORY - 1;
  const top = Math.max(max || 0, ...series, ...(second || []), 1e-9);
  const pts = (arr) => arr.map((v, i) => [((HISTORY - arr.length + i) / n) * w, hgt - (v / top) * (hgt - 2) - 1]);
  const toPath = (p) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('');
  const p1 = pts(series);
  let svg = `<svg class="spark" viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none">`;
  if (p1.length > 1) {
    svg += `<path class="area" d="${toPath(p1)}L${p1[p1.length - 1][0]},${hgt}L${p1[0][0]},${hgt}Z"/>`;
    svg += `<path class="line" d="${toPath(p1)}"/>`;
  }
  if (second && second.length > 1) svg += `<path class="line2" d="${toPath(pts(second))}"/>`;
  return svg + '</svg>';
}

const level = (pct) => (pct >= 90 ? 'danger' : pct >= 80 ? 'warn' : '');
const rate = (b) => `${fmtBytes(b)}/s`;

export class MonitorPane {
  constructor(session) {
    this.s = session;
    this.timer = null;
    this.cpuHist = [];
    this.memHist = [];
    this.rxHist = [];
    this.txHist = [];
    this.data = null;
    this.content = h('div', { class: 'mon' }, h('div', { class: 'mon-msg' }, '连接成功后显示服务器状态'));
    this.el = h('div', { class: 'pane' }, this.content);
  }

  onConnected() {
    this.cpuHist = [];
    this.memHist = [];
    this.rxHist = [];
    this.txHist = [];
    if (this.el.classList.contains('active') && this.s.sideOpen && this.s.view.classList.contains('active')) this.onShow();
  }

  onShow() {
    if (this.timer || !this.s.sessionId) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), INTERVAL);
  }

  onHide() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (!this.s.sessionId) return this.onHide();
    if (this.busy) return;
    this.busy = true;
    try {
      const d = await get(`/api/sessions/${this.s.sessionId}/stats`);
      this.push(d);
      this.render(d);
    } catch (e) {
      this.content.replaceChildren(h('div', { class: 'mon-msg' }, e.message));
      if (e.status === 410) this.onHide();
    } finally {
      this.busy = false;
    }
  }

  push(d) {
    const add = (arr, v) => {
      arr.push(v);
      if (arr.length > HISTORY) arr.shift();
    };
    if (d.cpu != null) add(this.cpuHist, d.cpu);
    if (d.mem) add(this.memHist, (d.mem.used / d.mem.total) * 100);
    if (d.net && this.data?.net) {
      add(this.rxHist, d.net.rxRate);
      add(this.txHist, d.net.txRate);
    }
    this.data = d;
  }

  render(d) {
    if (!d.supported) {
      this.content.replaceChildren(h('div', { class: 'mon-msg', html: `${icon('activity', 32, 1.4)}<p>暂时只支持 Linux 服务器的监控。<br>这台服务器：${d.kernel || d.os || '未知系统'}</p>` }));
      return;
    }
    const cpu = d.cpu == null ? null : d.cpu;
    const memPct = d.mem ? (d.mem.used / d.mem.total) * 100 : 0;
    const swapPct = d.swap?.total ? (d.swap.used / d.swap.total) * 100 : 0;
    const blocks = [];

    blocks.push(
      h(
        'div',
        { class: 'mon-block' },
        h(
          'dl',
          { class: 'mon-sys', style: { margin: 0 } },
          h('dt', {}, '主机名'),
          h('dd', { title: d.hostname }, d.hostname || '—'),
          h('dt', {}, '系统'),
          h('dd', { title: d.os }, d.os || '—'),
          h('dt', {}, '内核'),
          h('dd', { title: d.kernel }, d.kernel || '—'),
          h('dt', {}, '处理器'),
          h('dd', { title: d.cpuModel }, `${d.cores} 核 · ${d.cpuModel || '未知型号'}`),
          h('dt', {}, '运行时间'),
          h('dd', {}, fmtDuration(d.uptime))
        )
      )
    );

    blocks.push(
      h(
        'div',
        { class: 'mon-grid2' },
        h(
          'div',
          { class: 'mon-block' },
          h('div', { class: 'mon-label', html: `${icon('cpu', 14)} CPU` }),
          h('div', { class: 'mon-val', html: cpu == null ? '…' : `${cpu.toFixed(1)}<small>%</small>` }),
          h('div', { html: spark(this.cpuHist, 100) }),
          h('div', { class: 'mon-note' }, h('span', {}, `负载 ${d.load.map((x) => (isNaN(x) ? '—' : x.toFixed(2))).join(' / ')}`))
        ),
        h(
          'div',
          { class: 'mon-block' },
          h('div', { class: 'mon-label', html: `${icon('memory', 14)} 内存` }),
          h('div', { class: 'mon-val', html: `${memPct.toFixed(1)}<small>%</small>` }),
          h('div', { html: spark(this.memHist, 100) }),
          h('div', { class: 'mon-note' }, h('span', {}, `${fmtBytes(d.mem?.used)} / ${fmtBytes(d.mem?.total)}`))
        )
      )
    );

    if (d.swap?.total) {
      blocks.push(
        h(
          'div',
          { class: 'mon-block' },
          h('div', { class: 'mon-row' }, h('span', { class: 'mon-label' }, '交换分区'), h('span', { class: 'mon-note', style: { margin: 0 } }, `${fmtBytes(d.swap.used)} / ${fmtBytes(d.swap.total)}`)),
          h('div', { class: `bar ${level(swapPct)}` }, h('i', { style: { width: `${swapPct}%` } }))
        )
      );
    }

    if (d.net) {
      blocks.push(
        h(
          'div',
          { class: 'mon-block' },
          h(
            'div',
            { class: 'mon-row', style: { marginBottom: 0 } },
            h('span', { class: 'mon-label', html: `${icon('network', 14)} 网络` }),
            h('span', { class: 'net-legend' }, h('span', { html: `${icon('arrowDown', 12)} ${rate(d.net.rxRate)}` }), h('span', { class: 'muted', html: `${icon('arrowUp', 12)} ${rate(d.net.txRate)}` }))
          ),
          h('div', { html: spark(this.rxHist, 0, this.txHist) }),
          h('div', { class: 'mon-note' }, h('span', {}, `累计 ↓ ${fmtBytes(d.net.rxTotal)}  ↑ ${fmtBytes(d.net.txTotal)}`), h('span', { class: 'ellipsis' }, d.net.ifaces.join(', ')))
        )
      );
    }

    if (d.disks.length) {
      const box = h('div', { class: 'mon-block' }, h('div', { class: 'mon-row' }, h('span', { class: 'mon-label', html: `${icon('disk', 14)} 磁盘` })));
      for (const k of d.disks) {
        const pct = k.total ? (k.used / k.total) * 100 : 0;
        box.append(
          h(
            'div',
            { class: 'disk' },
            h('div', { class: 'disk-top' }, h('span', { class: 'ellipsis mono', title: `${k.fs} → ${k.mount}` }, k.mount), h('span', {}, `${fmtBytes(k.used)} / ${fmtBytes(k.total)} · ${pct.toFixed(0)}%`)),
            h('div', { class: `bar ${level(pct)}` }, h('i', { style: { width: `${pct}%` } }))
          )
        );
      }
      blocks.push(box);
    }

    if (d.procs.length) {
      const tbody = h('tbody');
      for (const p of d.procs) {
        const kill = h('button', { class: 'icon-btn', title: `结束进程 ${p.pid}`, html: icon('x', 13) });
        kill.addEventListener('click', () => this.kill(p));
        tbody.append(
          h(
            'tr',
            {},
            h('td', { class: 'mono', title: p.command }, p.command),
            h('td', { class: 'r' }, p.pid),
            h('td', { class: 'r' }, `${p.cpu.toFixed(1)}%`),
            h('td', { class: 'r' }, fmtBytes(p.rss, 0)),
            h('td', { class: 'r' }, kill)
          )
        );
      }
      blocks.push(
        h(
          'div',
          { class: 'mon-block' },
          h('div', { class: 'mon-row' }, h('span', { class: 'mon-label', html: `${icon('list', 14)} 进程（按 CPU）` })),
          h(
            'table',
            { class: 'proc-table' },
            h('colgroup', {}, h('col'), h('col', { style: { width: '54px' } }), h('col', { style: { width: '52px' } }), h('col', { style: { width: '62px' } }), h('col', { style: { width: '26px' } })),
            h('thead', {}, h('tr', {}, h('th', {}, '命令'), h('th', { class: 'r' }, 'PID'), h('th', { class: 'r' }, 'CPU'), h('th', { class: 'r' }, '内存'), h('th'))),
            tbody
          )
        )
      );
    }

    const scroll = this.content.scrollTop;
    this.content.replaceChildren(...blocks);
    this.content.scrollTop = scroll;
  }

  async kill(p) {
    const ok = await confirmDialog({ title: `结束进程 ${p.pid}？`, message: `${p.command}（用户 ${p.user}）\n将发送 SIGTERM 信号。`, okText: '结束进程', danger: true, iconName: 'zap' });
    if (!ok) return;
    try {
      await post(`/api/sessions/${this.s.sessionId}/kill`, { pid: p.pid });
      toast('已发送结束信号', 'success');
      setTimeout(() => this.tick(), 600);
    } catch (e) {
      toast(e.message, 'error');
    }
  }
}
