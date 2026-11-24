# 方正矩阵助手 · Windows 启动
# 检查 Node.js 24，然后在本仓库启动只读监控面板。
# 不安装发布助手，不克隆其他仓库。
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Say($t) { Write-Host "`n== $t" -ForegroundColor Green }

Say '检查 Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要 Node.js 24：https://nodejs.org' }
$major = [int]((node -v) -replace 'v','').Split('.')[0]
if ($major -lt 24) { throw "Node.js $(node -v) 太旧，需要 24 以上" }
Write-Host "  Node.js $(node -v)"
Say '启动只读监控 http://127.0.0.1:8790/'
npm start
