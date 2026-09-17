#!/usr/bin/env sh
# 简历速取 - 本地服务（macOS / Linux / Git Bash）
# 用法：./start.sh            或            ./start.sh --port 6000

set -e
cd "$(dirname "$0")"

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
printf '  数据文件：data/resume.json\n\n'
printf '  正在启动，浏览器会自动打开页面。\n'
printf '  ── 按 Ctrl+C 停止服务 ──\n\n'

# ---- 3. 启动（参数原样透传，例如：./start.sh --port 6000）----
exec node server.js "$@"
