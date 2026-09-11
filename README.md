# agent-toolkit

多 Agent 项目环境工具链：以 `agents.config.json` 为参数 SSOT 的多端配置渲染引擎（Claude Code / OpenCode / CodeBuddy / Antigravity）+ git worktree 多槽位并行开发协作。

## 安装

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/ustc.shawn/agent-toolkit/main/install.sh | sh
```

Windows（PowerShell）：

```powershell
iwr -useb https://raw.githubusercontent.com/ustc.shawn/agent-toolkit/main/install.ps1 | iex
```

安装器完成三件事：装 skill 到项目 `.agents/skills/agent-env-init/`、bootstrap 各 Agent 的 rules/skills 链接、写入 .gitignore 密钥防线。装完对 agent 说「初始化多agent环境」，按问答完成项目接入。

## 团队协作模型

```text
tracked（团队共享，改一处人人生效）：scripts/agent/ + agents.config.json + settings.<name>.json（无 key 结构）+ *.example
个人（gitignored，永不提交）    ：settings.<name>.secrets.json（仅 token）
运行时（gitignored，各自渲染）  ：settings.local.json / .mcp.json / opencode.jsonc / models.json
```

同事接入三步：`git clone` → 照 `*.example` 填自己的 token → `node scripts/agent/project-sync.js`。不需要知道本仓库存在。

## 安全边界

- `agents.config.json` 永远不含 token——密钥只进 gitignored secrets 文件与渲染产物
- 安装时自动写入 .gitignore 防线（含密钥渲染产物 + 本机软链）

## 依赖

零 npm 依赖，仅需 Node.js ≥ 18（远程安装模式用到内置 fetch）。默认 pnpm 口径，缺失时 POSIX 安装壳自动构建 nvm → node → pnpm 链路；Windows 壳只检测并给 nvm-windows 指引。

## License

MIT
