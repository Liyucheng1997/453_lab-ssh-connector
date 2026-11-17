#!/usr/bin/env bash
# 安装到服务器 /usr/local/bin/deploy-ssh
# 由 GitHub Actions 通过受限 SSH 钥匙调用：stdin 为打包好的程序（tar.gz）
set -Eeuo pipefail
APP=/opt/apps/ssh
PORT=4453
exec 9>/home/ubuntu/.ssh-deploy.lock
if ! flock -n 9; then echo 'Another ssh deployment is already running' >&2; exit 1; fi

STAGE=$(mktemp -d /home/ubuntu/.ssh-stage.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
tar -xz -C "$STAGE"
[ -f "$STAGE/server/index.js" ] && [ -f "$STAGE/package-lock.json" ] || { echo 'bad bundle' >&2; exit 1; }

# 1. 替换程序文件，保留 data/（服务器上的数据）、node_modules/、.env
mkdir -p "$APP/data"
for d in server public deploy; do rm -rf "${APP:?}/$d"; cp -a "$STAGE/$d" "$APP/$d"; done
cp -a "$STAGE"/package.json "$STAGE"/package-lock.json "$STAGE"/README.md "$APP"/
cp -a "$STAGE/.deploy-rev" "$APP/" 2>/dev/null || true
[ -f "$APP/.env" ] || printf 'HOST=127.0.0.1\nPORT=%s\n' "$PORT" > "$APP/.env"

# 2. 依赖有变化才重新安装
if ! cmp -s "$APP/package-lock.json" "$APP/node_modules/.deploy-lock.json"; then
  (cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
  cp "$APP/package-lock.json" "$APP/node_modules/.deploy-lock.json"
fi

# 3. 重启并检查
sudo -n systemctl restart app-ssh.service
for _ in {1..20}; do
  if curl --fail --silent -o /dev/null "http://127.0.0.1:$PORT/api/auth/status"; then
    echo "deployed $(cat "$APP/.deploy-rev" 2>/dev/null || echo '?')"
    exit 0
  fi
  sleep 1
done
echo 'ssh health check failed after deployment' >&2
systemctl status app-ssh.service --no-pager -l >&2 || true
exit 1
