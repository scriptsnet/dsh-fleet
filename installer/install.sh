#!/usr/bin/env bash
# dsh-fleet agent installer for Linux (headless worker / master)
# 用法：
#   bash install.sh [<dsh-fleet 插件目录>]
# 环境变量：
#   DSH_HOME           harness 数据目录（默认 ~/.dsh）
#   DSH_FLEET_SYSTEMD  0 禁用 systemd 自启（默认 1）
#   DSH_FLEET_START    1 = 安装后立即启动（默认 0）
# 流程：Node → pnpm → @deepseek-ai/dsh → web profile + dsh-fleet 插件 → systemd 自启
set -euo pipefail

PLUGIN_SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
log() { echo "[$(date +%H:%M:%S)] $*"; }

# ---------- 1. Node.js ----------
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'process.exit(Number(process.version.slice(1).split(".")[0]) < 18)')" = "1" ]; then
  log "installing Node.js 24 (LTS) to /opt/node ..."
  curl -fsSL https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz -o /tmp/node.tar.xz
  sudo mkdir -p /opt/node
  sudo tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
  echo 'export PATH=/opt/node/bin:$PATH' | sudo tee /etc/profile.d/node.sh >/dev/null
  export PATH=/opt/node/bin:$PATH
fi
log "node: $(node -v)"

# ---------- 2. pnpm（dsh plugin add 需要） ----------
if ! command -v pnpm >/dev/null 2>&1; then
  log "installing pnpm ..."
  npm install -g pnpm
fi

# ---------- 3. DeepSeek Harness（npm 版） ----------
if ! command -v dsh >/dev/null 2>&1; then
  log "installing @deepseek-ai/dsh ..."
  npm install -g @deepseek-ai/dsh
fi
log "dsh: $(dsh -V 2>/dev/null || echo installed)"

# ---------- 4. 初始化 web profile 并安装 dsh-fleet 插件 ----------
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
if [ ! -d "$PLUGIN_SRC" ] || [ ! -f "$PLUGIN_SRC/package.json" ]; then
  log "ERROR: 插件目录无效: $PLUGIN_SRC（应包含 package.json）"
  exit 1
fi
log "installing dsh-fleet plugin from $PLUGIN_SRC"
dsh plugin --profile web add "$PLUGIN_SRC"

# 本地路径安装是 link:（符号链接），插件内部导入 @deepseek-ai/* 需能从插件目录解析。
# 把 harness 安装目录的 @deepseek-ai 依赖树软链进插件目录（发布到 npm 后不再需要）。
PLUGIN_REAL="$(readlink -f "$PLUGIN_SRC" 2>/dev/null || echo "$PLUGIN_SRC")"
if [ ! -e "$PLUGIN_REAL/node_modules/@deepseek-ai/dsh-tools" ]; then
  DSH_BIN="$(readlink -f "$(command -v dsh)")"
  ANCHOR="$(dirname "$(dirname "$DSH_BIN")")/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
  if [ -d "$ANCHOR" ]; then
    mkdir -p "$PLUGIN_REAL/node_modules"
    ln -sfn "$ANCHOR" "$PLUGIN_REAL/node_modules/@deepseek-ai"
    log "已软链依赖树: $ANCHOR"
  fi
fi

# 放行 47900（master 从内网连本机）
if command -v ufw >/dev/null 2>&1 && sudo -n ufw status 2>/dev/null | grep -q 'Status: active'; then
  sudo -n ufw allow 47900/tcp 2>/dev/null && log "已放行 47900/tcp" || true
fi

# ---------- 5. 开机自启（systemd 用户服务） ----------
if [ "${DSH_FLEET_SYSTEMD:-1}" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  SERVICE="$HOME/.config/systemd/user/dsh-fleet.service"
  mkdir -p "$(dirname "$SERVICE")"
  cat > "$SERVICE" <<EOF
[Unit]
Description=dsh-fleet (DeepSeek Harness web profile)
After=network-online.target

[Service]
Type=simple
Environment=DSH_HOME=$DSH_HOME
ExecStart=$(command -v dsh) --profile web
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable dsh-fleet.service
  if [ "${DSH_FLEET_START:-0}" = "1" ]; then
    systemctl --user start dsh-fleet.service
    log "已启动 dsh-fleet.service"
  else
    log "已启用自启，手动启动：systemctl --user start dsh-fleet"
  fi
else
  log "systemd 不可用，手动启动：dsh --profile web"
  if [ "${DSH_FLEET_START:-0}" = "1" ]; then
    nohup dsh --profile web >/tmp/dsh-fleet.log 2>&1 &
    log "已后台启动（日志 /tmp/dsh-fleet.log）"
  fi
fi

log "安装完成。"
log "  · 首次启动自动生成机器身份：$DSH_HOME/fleet/identity.json"
log "  · 监听端口 47900（被调用方）；Web UI: http://127.0.0.1:3080"
log "  · 打开 UI 后，侧边栏「算力舰队」可复制本机名片 / 组队 / 测试联通"
