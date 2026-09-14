# agent-toolkit

多 Agent 项目环境工具链：以 `agents.config.json` 为参数 SSOT 的多端配置渲染引擎（Claude Code / OpenCode / CodeBuddy / Codex / Antigravity / Pi，Trae 走链接层）+ git worktree 多槽位并行开发协作。

## 安装

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/haitau/agent-toolkit/main/install.sh | sh
```

Windows（PowerShell）：

```powershell
iwr -useb https://raw.githubusercontent.com/haitau/agent-toolkit/main/install.ps1 | iex
```

安装器完成四件事：装 skill 到项目 `.agents/skills/agent-env-init/`、bootstrap 各 Agent 的 rules/skills 链接、写入 .gitignore 密钥防线、落地 Claude Code 权限基线。装完对 agent 说「初始化多agent环境」，按问答完成项目接入。

## 权限基线（低弹窗）

黑名单反转模式：Bash 默认放行，仅危险命令设门——`sudo` / `rm -rf` / `git push` / `git reset --hard` 前置确认（ask），`git clean` 硬拦（deny）；项目根外读写默认放行。Claude Code 侧在安装时写入 `.claude/settings.json`（已存在则跳过、绝不覆盖手维护配置）；OpenCode 侧随 `opencode.template.jsonc` 渲染，并自动解除误触发的读取护栏（`blockReadsOutsideWorkingDirectories`）。

## 团队协作模型

```text
tracked（团队共享，改一处人人生效）：scripts/agent/ + agents.config.json + settings.<name>.json（无 key 结构）+ *.sample
个人（gitignored，永不提交）    ：settings.<name>.secrets.json（仅 token）
运行时（gitignored，各自渲染）  ：settings.local.json / .mcp.json / opencode.jsonc / .codebuddy/models.json / .codex/config.toml
```

同事接入三步：`git clone` → 照 `*.sample` 填自己的 token → `node scripts/agent/project-sync.js`。不需要知道本仓库存在。

可选：`agents.config.json` 的 `keyPool` 声明多订阅账号池，worktree 各槽位自动轮换绑定独立 Key，防并发配额争抢；未声明即整体禁用，回落单 Key。

## 安全边界

- `agents.config.json` 永远不含 token——密钥只进 gitignored secrets 文件与渲染产物
- 安装时自动写入 .gitignore 防线（含密钥渲染产物 + 本机软链，deny-by-default）
- 公开仓构建含私词守卫：产物出现内部代号/订阅名即拦截构建

## 依赖

零 npm 依赖，仅需 Node.js ≥ 18（远程安装模式用到内置 fetch）。默认 pnpm 口径，缺失时 POSIX 安装壳自动构建 nvm → node → pnpm 链路；Windows 壳只检测并给 nvm-windows 指引。

## License

MIT
