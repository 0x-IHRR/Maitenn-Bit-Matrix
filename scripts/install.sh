#!/bin/bash
# 方正矩阵助手：检查 Node 24，然后启动只读监控面板。
# 不安装发布助手，不克隆其他麦田仓库。
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
command -v node >/dev/null || { echo "需要 Node.js 24：https://nodejs.org"; exit 1; }
node -e 'const major=Number(process.versions.node.split(".")[0]); if(!(major>=24)) { console.error("Node.js 版本是 "+process.version+"，需要 24 以上"); process.exit(1); }'
echo "启动 http://127.0.0.1:8790/  （首次运行会写入 data/config.json）"
exec npm start
