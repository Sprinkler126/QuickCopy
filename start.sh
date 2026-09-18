#!/usr/bin/env sh
# 简历速取 - 本地服务（macOS / Linux / Git Bash）
# 用法：./start.sh            或            ./start.sh --port 6000

set -e
cd "$(dirname "$0")"

# ---- 启动设置（改这两行）----
# PORT   : 服务监听端口
# CONFIG : 默认配置文件。注意服务现在监听所有网卡，
#          同一局域网的人能读到这个文件的内容，所以默认用示例数据。
PORT=18437
CONFIG="data/resume.example.json"

printf '\n  简历速取 - 本地服务\n  ----------------------------------------\n\n'

# ---- 1. 检查 Node.js ----
if ! command -v node >/dev/null 2>&1; then
  printf '  [x] 没有检测到 Node.js\n\n'
  printf '      请先安装 Node.js 18 或更高版本：https://nodejs.org/\n\n'
  exit 1
fi

# ---- 2. 检查版本 ----
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then
  printf '  [!] Node 版本过低：%s\n' "$(node -v)"
  printf '      本工具需要 18 或更高版本，请升级后再试。\n\n'
  exit 1
fi

printf '  Node 版本：%s\n' "$(node -v)"
printf '  端口：%s\n  默认配置：%s\n\n' "$PORT" "$CONFIG"
printf '  正在启动，浏览器会自动打开页面。\n'
printf '  ── 按 Ctrl+C 停止服务 ──\n\n'

# ---- 3. 启动（后面的参数会覆盖上面的默认值，例如：./start.sh --port 6000）----
exec node server.js --port "$PORT" --data "$CONFIG" "$@"
