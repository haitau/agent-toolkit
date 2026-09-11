#!/usr/bin/env bash
# SessionStart hook: 幂等建立 .claude/skills -> ../.agents/skills 符号链接
# 让 Claude Code 原生发现 .agents/skills/ 下的共享技能。
# 链接本身保持 gitignore（本地对象），不随 git 分发；此 hook 负责在每个
# worktree / 会话启动时自动补建，根治"新建 worktree 漏建链接"问题。
# 跨平台：仅在 Linux/macOS 执行，Windows 跳过（避免 mklink / 权限差异）。

case "$(uname -s 2>/dev/null)" in
  Linux|Darwin) ;;
  *) exit 0 ;;
esac

# 已存在（实体或符号链接）则不重复建，保证幂等
[ -e .claude/skills ] && exit 0
[ -L .claude/skills ] && exit 0

# 源目录存在才建链接；失败静默，绝不阻断会话启动
[ -d .agents/skills ] && ln -s ../.agents/skills .claude/skills 2>/dev/null
exit 0
