#!/bin/sh
# agent-toolkit POSIX 安装薄壳：确保 node/pnpm 存在（缺则 nvm→node→pnpm 自动构建）后委托 install.mjs
# 用法：curl -fsSL <raw>/install.sh | sh    （TOOLKIT_RAW 环境变量可自定义源）
set -e

TOOLKIT_RAW="${TOOLKIT_RAW:-https://raw.githubusercontent.com/ustc.shawn/agent-toolkit/main}"

if ! command -v node >/dev/null 2>&1; then
  echo "[agent-toolkit] 未检测到 Node，按 nvm → node 链路自动构建…"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | sh
  . "$HOME/.nvm/nvm.sh"
  nvm install --lts
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[agent-toolkit] 未检测到 pnpm，独立安装（get.pnpm.io，不绑 corepack）…"
  curl -fsSL https://get.pnpm.io/install.sh | sh -
  PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
  case ":$PATH:" in
    *":$PNPM_HOME:"*) ;;
    *) PATH="$PNPM_HOME:$PATH" ;;
  esac
  export PATH
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TOOLKIT_RAW/install.mjs" -o "$TMP/install.mjs"
exec node "$TMP/install.mjs" --source "$TOOLKIT_RAW" "$@"
