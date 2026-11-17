// 服务器监控：通过一条 exec 命令读取 /proc 等信息，CPU 和网速用两次采样的差值计算。
const STATS_SCRIPT = [
  'export LC_ALL=C',
  "echo '@@OS'; (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\") || uname -s",
  "echo '@@KERNEL'; uname -sr",
  "echo '@@HOST'; hostname 2>/dev/null || uname -n",
  "echo '@@UPTIME'; cat /proc/uptime 2>/dev/null",
  "echo '@@LOAD'; cat /proc/loadavg 2>/dev/null",
  "echo '@@CPU'; head -n 1 /proc/stat 2>/dev/null",
  "echo '@@NCPU'; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null",
  "echo '@@CPUMODEL'; grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2",
  "echo '@@MEM'; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null",
  "echo '@@NET'; tail -n +3 /proc/net/dev 2>/dev/null",
  "echo '@@DISK'; df -Pk 2>/dev/null",
  "echo '@@PS'; ps -eo pid=,user=,pcpu=,pmem=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n 10",
  "echo '@@END'",
].join('\n');

const SKIP_FS = /^(tmpfs|devtmpfs|udev|none|overlay|shm|squashfs|efivarfs|cgroup|proc|sysfs|run|drvfs|C:\\|rootfs$)/i;

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) {
      cur = m[1];
      out[cur] = [];
    } else if (cur) {
      out[cur].push(line);
    }
  }
  return out;
}

function parse(text, session) {
  const s = sections(text);
  const now = Date.now();
  const first = (k) => (s[k] || []).find((l) => l.trim() !== '')?.trim() || '';

  const result = {
    supported: !!first('CPU'),
    time: now,
    os: first('OS'),
    kernel: first('KERNEL'),
    hostname: first('HOST'),
    cpuModel: first('CPUMODEL'),
    cores: Number(first('NCPU')) || 0,
    uptime: Number(first('UPTIME').split(/\s+/)[0]) || 0,
    load: first('LOAD').split(/\s+/).slice(0, 3).map(Number),
    cpu: null,
    mem: null,
    swap: null,
    net: null,
    disks: [],
    procs: [],
  };

  // CPU：/proc/stat 第一行累计时间片，两次采样求差
  const cpuParts = first('CPU').split(/\s+/).slice(1).map(Number);
  if (cpuParts.length >= 4) {
    const idle = cpuParts[3] + (cpuParts[4] || 0);
    const total = cpuParts.reduce((a, b) => a + b, 0);
    if (session.prevCpu) {
      const dt = total - session.prevCpu.total;
      const di = idle - session.prevCpu.idle;
      result.cpu = dt > 0 ? Math.max(0, Math.min(100, ((dt - di) / dt) * 100)) : 0;
    }
    session.prevCpu = { idle, total };
  }

  // 内存
  const mem = {};
  for (const l of s.MEM || []) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  if (mem.MemTotal) {
    const avail = mem.MemAvailable ?? (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0);
    result.mem = { total: mem.MemTotal, used: mem.MemTotal - avail, available: avail };
    result.swap = { total: mem.SwapTotal || 0, used: (mem.SwapTotal || 0) - (mem.SwapFree || 0) };
  }

  // 网络：汇总除 lo 以外的网卡
  let rx = 0;
  let tx = 0;
  const ifaces = [];
  for (const l of s.NET || []) {
    const m = l.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    const f = m[2].trim().split(/\s+/).map(Number);
    if (name === 'lo' || f.length < 9) continue;
    rx += f[0];
    tx += f[8];
    ifaces.push(name);
  }
  if (ifaces.length) {
    result.net = { rxTotal: rx, txTotal: tx, rxRate: 0, txRate: 0, ifaces };
    if (session.prevNet) {
      const dt = (now - session.prevNet.time) / 1000;
      if (dt > 0) {
        result.net.rxRate = Math.max(0, (rx - session.prevNet.rx) / dt);
        result.net.txRate = Math.max(0, (tx - session.prevNet.tx) / dt);
      }
    }
    session.prevNet = { rx, tx, time: now };
  }

  // 磁盘
  const seen = new Set();
  for (const l of (s.DISK || []).slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [fsName, size, used, avail] = f;
    const mount = f.slice(5).join(' ');
    if (SKIP_FS.test(fsName) || /^\/(proc|sys|dev|run|snap|boot\/efi)(\/|$)/.test(mount) || mount.startsWith('/mnt/wsl') || mount.startsWith('/usr/lib/wsl')) continue;
    if (!Number(size) || seen.has(fsName + mount)) continue;
    seen.add(fsName + mount);
    result.disks.push({ fs: fsName, mount, total: Number(size) * 1024, used: Number(used) * 1024, available: Number(avail) * 1024 });
  }
  result.disks = result.disks.slice(0, 12);

  // 进程
  for (const l of s.PS || []) {
    const f = l.trim().split(/\s+/);
    if (f.length < 6 || !/^\d+$/.test(f[0])) continue;
    result.procs.push({ pid: Number(f[0]), user: f[1], cpu: Number(f[2]), mem: Number(f[3]), rss: Number(f[4]) * 1024, command: f.slice(5).join(' ') });
  }
  return result;
}

async function collect(session) {
  const { stdout } = await session.exec(STATS_SCRIPT, { timeout: 10000 });
  return parse(stdout, session);
}

module.exports = { collect, parse };
