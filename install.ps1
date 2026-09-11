# agent-toolkit Windows 安装薄壳：检测 node（缺则给 nvm-windows 指引，不静默提权安装）后委托 install.mjs
# 用法：iwr -useb <raw>/install.ps1 | iex    （$env:TOOLKIT_RAW 可自定义源）
$ErrorActionPreference = 'Stop'
$raw = if ($env:TOOLKIT_RAW) { $env:TOOLKIT_RAW } else { 'https://raw.githubusercontent.com/ustc.shawn/agent-toolkit/main' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[agent-toolkit] 未检测到 Node.js。请先安装 nvm-windows 后重试（不代你静默安装）：" -ForegroundColor Yellow
  Write-Host "  https://github.com/coreybutler/nvm-windows/releases"
  Write-Host "  安装后执行：nvm install lts; nvm use lts"
  exit 1
}

$tmp = Join-Path $env:TEMP 'agent-toolkit-install'
New-Item -ItemType Directory -Force $tmp | Out-Null
Invoke-WebRequest -UseBasicParsing "$raw/install.mjs" -OutFile (Join-Path $tmp 'install.mjs')
node (Join-Path $tmp 'install.mjs') --source $raw @args
