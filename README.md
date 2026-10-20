# agent-toolkit

多 Agent 项目环境工具链：以 `agents.config.json` 为参数 SSOT 的多端配置渲染引擎（Claude Code 出厂必管；OpenCode 免链开箱；CodeBuddy / Codex / Antigravity / Pi / Trae 存在即接管）+ git worktree 多槽位并行开发协作 + 外部来源技能上游跟踪。

## 安装

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/haitau/agent-toolkit/main/install.sh | sh
```

Windows（PowerShell）：

```powershell
iwr -useb https://raw.githubusercontent.com/haitau/agent-toolkit/main/install.ps1 | iex
```

安装器完成四件事：装 skill 到项目 `.agents/skills/agent-env-init/` 并强制建 `.agents/rules/`、bootstrap rules/skills 链接（`.claude` 必链；`.codebuddy/.trae` 仅目录已存在时补，安装对应 Agent 后下次 sync 自动接管）、写入最严 public 档 .gitignore 防线、落地 Claude Code 权限基线（本地生效）。初始化问答确认仓库类型后，`node scripts/agent/agents-gitignore.js public|team|private` 三档切换：公开仓技能/hook/权限基线全部本地化不提交，团队档入库共享，私人档快照随仓漫游。装完对 agent 说「初始化多agent环境」，按问答完成项目接入。

## 权限基线（低弹窗）

黑名单反转模式：Bash 默认放行，仅危险命令设门——`sudo` / `rm -rf` / `git push` / `git reset --hard` 前置确认（ask），`git clean` 硬拦（deny）；项目根外读写默认放行。Claude Code 侧在安装时写入 `.claude/settings.json`（已存在则跳过、绝不覆盖手维护配置）；OpenCode 侧随 `opencode.template.jsonc` 渲染，并自动解除误触发的读取护栏（`blockReadsOutsideWorkingDirectories`）。

## 团队协作模型

```text
tracked（团队共享，改一处人人生效）：scripts/agent/ + agents.config.json + settings.<name>.json（无 key 结构）+ *.sample
个人（gitignored，永不提交）    ：settings.<name>.secrets.json（仅 token）
运行时（gitignored，各自渲染）  ：settings.local.json / .mcp.json / opencode.jsonc / .codebuddy/models.json / .codex/config.toml / .pi/settings.json
```

同事接入三步：`git clone` → 照 `*.sample` 填自己的 token → `node scripts/agent/agents-sync.js`。不需要知道本仓库存在。

可选：`agents.config.json` 的 `keyPool` 声明多订阅账号池，worktree 各槽位自动轮换绑定独立 Key，防并发配额争抢；未声明即整体禁用，回落单 Key。

## 初始化完成后：脚本命令速查

所有脚本零依赖、可直接 `node scripts/agent/<脚本>` 运行；初始化时在 `package.json` 注册过别名的（步骤 6）也可用 `pnpm <别名>`。`<name>` 一律指订阅快照名，即 `.claude/settings.<name>.json` 的中段。

| 命令（node 直跑 / pnpm 别名） | 什么时候跑 |
| :-- | :-- |
| `agents-sync.js` / `pnpm agents:sync` | **日常总刷新**：改了 `agents.config.json`、订阅快照、根 `.mcp.json` 后；新同事填完 token 后。重渲染各 Agent 运行时配置（Claude/OpenCode/CodeBuddy/Codex/Pi）、聚合项目 MCP 全量广播、补 rules/skills 软链，并向所有 worktree 槽位同构扩散。无密钥时安全降级为"仅补链模式"，退出码 0 |
| `model-switch.js <name>` / `pnpm model:switch <name>` | 切换当前槽位 Claude Code 端点（写 `settings.local.json`，本机 permissions 保留） |
| `model-switch.js --all <name>` | 一次性广播切换主仓 + 全部 worktree 槽位 |
| `worktree-init.js <槽位名> [--base <branch>]` / `pnpm worktree:init` | 派生并发工作区 `../<仓库名>-<槽位名>`，自动装链接与运行时配置 |
| `worktree-sync.js` / `pnpm worktree:sync` | 在主仓统一合并各槽位分支（冲突按 A+B 无损叠加）、基线反推下发。**默认只合并不 push**；`WORKTREE_SYNC_PUSH=true` 带 push gate，`WORKTREE_SYNC_SMOKE="<cmd>"` 可注入构建校验 |
| `agents-gitignore.js <public\|team\|private>` | 仅初始化按仓库类型跑一次；日后调整入库策略时重跑（幂等，只动标记块） |
| `toolkit-update.js` | 手动升级引擎；正常无需手跑——见下方[升级](#升级) |
| `skills-update.js ...` / `pnpm skills:check` | 外部技能上游跟踪，见下节 |

铁律：槽位工作区**物理禁 push**，所有交付在主仓合并推送；`agents-sync` 只碰 gitignored 运行时文件，任何 tracked 文件的增删改走 `worktree-sync` 的 Git 标准流转。

## 典型工作流

```sh
# 1) 日常改了配置（快照 / agents.config.json / 根 .mcp.json 加自定义 server）
node scripts/agent/agents-sync.js

# 2) 多 Agent 并发：开两个槽位各干各的，回主仓收口
node scripts/agent/worktree-init.js claude
node scripts/agent/worktree-init.js opencode
# ... 在 ../仓库-claude、../仓库-opencode 里分别开发 ...
node scripts/agent/worktree-sync.js          # 主仓合并；确认无误后 WORKTREE_SYNC_PUSH=true 再跑一次

# 3) 切换订阅端点（name = 快照文件名中段，如 settings.my-sub.json → my-sub）
node scripts/agent/model-switch.js my-sub
```

## 升级

引擎随仓库分发（`scripts/agent/` 是项目资产），升级**不需要重跑安装器**：

- **自动（默认）**：安装时挂 `post-merge` 钩子（husky 项目写 `.husky/post-merge`，无 hooks 管理器时用 `.githooks`，绝不夺权既有管理器），`git pull` 后自动检测远程 VERSION 并键级无损升级；离线/脏工作区自动退提示，不阻塞 pull。
- **手动**：`node scripts/agent/toolkit-update.js`。
- `agents.config.json` 升级时只做键级合并（保留定制、新键补默认）；`raw.githubusercontent.com` 有约 5 分钟 CDN 缓存，紧贴发布时升级可能读到旧版，稍后重跑即可。

## 外部技能上游跟踪（可选）

项目 `.agents/skills/` 里混有外部来源技能（GitHub 直装 / npm / PyPI / 本地 clone）时，用一份注册表跟踪上游更新：

```sh
node scripts/agent/skills-update.js --init      # 只读扫描，输出候选条目骨架（不写文件）
node scripts/agent/skills-update.js --check      # 巡检：有新版 / 本地漂移 / 未登记外部技能
node scripts/agent/skills-update.js <name> --update          # 具名升级（先展示差异再确认）
node scripts/agent/skills-update.js --all --yes --update     # 仅升级 follow-upstream 策略且确认有新版的技能
```

注册表默认 `scripts/skills-sources.json`（`agents.config.json` 的 `skills.registryPath` 可改），每仓一份、内容各不相同。**注册表必须与 AI 对话生成**——渠道与升级策略是人的判断，跑 `--init` 取证后逐条确认再写入（详见 `SKILL.md` 步骤 8）。未建注册表时 `--check` 只打印启用引导，不会报错。

## 安全边界

- `agents.config.json` 永远不含 token——密钥只进 gitignored secrets 文件与渲染产物
- `.gitignore` 防线三档渲染（`agents-gitignore.js`）：安装默认 public 最严档（技能/hook/权限基线全本地化），初始化按仓库类型切 team/private；含密钥渲染产物、本机软链、`node_modules/` 三档恒忽略
- 公开仓构建含私词守卫：产物出现内部代号/订阅名即拦截构建

## 依赖

零 npm 依赖，仅需 Node.js ≥ 18（远程安装模式用到内置 fetch）。默认 pnpm 口径，缺失时 POSIX 安装壳自动构建 nvm → node → pnpm 链路；Windows 壳只检测并给 nvm-windows 指引。

## License

MIT
