---
name: agent-env-init
description: 初始化或升级多 Agent 项目环境：渲染各 Agent 运行时配置（Claude Code/OpenCode/CodeBuddy/Antigravity/Pi）、MCP 档位管理、git worktree 多槽位并行开发。触发词：初始化多agent环境、搭建 agent 工具链、升级 agent-toolkit、同事怎么获得 agent 配置。当用户要在 git 项目里建立多 Agent 并行开发环境、或升级已初始化项目的工具链脚本时使用。
---

# agent-env-init：多 Agent 项目环境初始化/升级

## 定位

本 skill = 一次性安装器 + 长期纪律说明书。安装产物（`scripts/agent/` + `agents.config.json`）是项目自包含资产，同事 clone 即得，无需本 skill。

**硬红线（违反即泄露）**：
1. `agents.config.json` 永远不含 token/key——密钥只进 gitignored 的 secrets 文件或渲染产物
2. 多人库 tracked 的 `settings.<name>.json` 只放结构（baseURL/模型名/槽位），token 字段留空占位
3. 渲染产物与软链永不提交（.gitignore 清单见步骤 4）

## 步骤 0：交互问答（缺一不执行）

问清三件事，逐条确认后才进入执行：
1. **仓库类型**：私人单机 / 公开个人 / 多人团队（决定用哪档模板）
2. **密钥位置**：私仓快照直存 / 本机 secrets 文件（多人库必选后者）
3. **要哪些 Agent**：Claude Code / OpenCode / CodeBuddy / Antigravity / Pi（至少一个）。链接策略差异：前三家需 rules/skills 软链（install 已建）；Antigravity 与 Pi 原生感知 `.agents/` 目录免链，其中 Pi 不读 rules（AGENTS.md 是其唯一规约入口）

🛑 CHECKPOINT：把「仓库类型 / 密钥位置 / Agent 清单 / 用哪档模板」四项复述给用户，明确确认后才继续——答错档位会把多人库的密钥结构写错层。

## 失败模式与异常处理

- 若用户回答"随便"/"你定" → 按默认（multi 档 + secrets 分层 + 全部 Agent）复述确认；若确认失败（仍含糊）→ 中止初始化，不得静默假设
- 若project:sync执行失败（非零退出）→ 停止交付，先排查agents.config.json语法错误与路径，修复后重跑再继续
- 若agents.config.json解析异常 → 指引用户按模板逐键重写，不代猜字段
- 若无密钥场景未出现"仅补链模式"降级日志 → 视为引擎异常，停止交付先排查
- 若项目已有 `scripts/agent/` → 转"升级模式"；整目录盲覆盖属失败操作，严禁
- 若 .gitignore 已含 agent-toolkit 标记块 → 跳过追加（幂等兜底），不得重复写
- 若git status发现secrets或渲染产物被暂存 → 立即 `git restore --staged <file>` 退回并提醒用户——这是泄露前最后一道闸

## 步骤 1：装脚本

将本 skill 目录下 `scripts/` 全部文件复制到项目 `scripts/agent/`。已初始化过的项目走"升级模式"（见下），不得整目录盲覆盖。

## 步骤 2：写 agents.config.json

从 `templates/agents.config.<档位>.json` 复制到项目根，按用户实际改：
- `mcp.profiles`：server 定义（http/stdio 两型），支持 `${var}` 插值，变量来自 `mcp` 节其它键 + 运行时密钥（`mcp.keys` 映射到订阅快照）
- `updates`：`sourceUrl` 指向 toolkit 来源（内网镜像改这里）、`autoUpdate` 默认开；并写入 `toolkitVersion` = 安装来源 VERSION
- `worktree`：槽位前缀映射 / 收纳范围 / 冲突提示

反例：把真实 token 写进 `mcp.profiles.*.token`——该字段只允许 `${var}` 引用，写死即违反硬红线 1。

## 步骤 3：写订阅快照

- **multi 档双层**：tracked `.claude/settings.<name>.json`（结构完整、token 留 `""`，照 `templates/settings.example.json`）+ 个人 gitignored `.claude/settings.<name>.secrets.json`（只放 env 里的 token 字段，照 `templates/settings.secrets.example.json`）。团队换模型只改 tracked 结构一处，各人重跑 project:sync。
- **私人档**：可跳过分层，快照直接含 key（仓库本身私密 tracked）。
- **外来快照（从其它项目拷贝）**：deny-by-default 已挡 `settings.*.json`，拷入后不会入库；但未在 `agents.config.json providers` 注册的快照处于**休眠态**——project:sync 每次打跳过警告、不渲染进任何 Agent 配置。激活需三步：①providers 注册一行；②token 按档位拆层（multi 档拆到 `.secrets.json`，私档可留快照内）；③**中性化检查**——文件名含内部代号者改中性名、baseURL 含内部域名须改公网可达地址，否则即便忽略入库也会把内部信息写进渲染产物。

## 步骤 4：写 .gitignore 防线与升级钩子

install.mjs 已按保守默认写入 deny-by-default 块（快照默认全部不入库）。本步骤按**已确认的档位**收口：

**公开 / 多人档**：install.mjs 写入的块直接适用，无需改动——

```gitignore
# agent-toolkit local runtime（含密钥渲染产物与本机软链，严禁提交）
.claude/settings.local.json
.claude/settings.*.secrets.json
.claude/settings.*.json
!.claude/settings.main.json
.machine-state.json
.mcp-state.json
.agent-toolkit.defaults-snapshot.json
.mcp.json
.agents/mcp_config.json
.agents/plugins/**/mcp_config.json
opencode.jsonc
.codebuddy/models.json
.codebuddy/settings.local.json
.workbuddy/models.json
.claude/rules
.claude/skills
.codebuddy/rules
.codebuddy/skills
.trae/rules
.trae/skills
```

**私人单机档**：快照需「结构+密钥同层」入库（agents.config.private.json 设计本意），从 install.mjs 写入的块中**移除**以下两行（其余保留）：

```gitignore
.claude/settings.*.json
!.claude/settings.main.json
```

升级钩子（同事 `git pull` 后自动升级）：写 `.githooks/post-merge`（内容为 `exec node scripts/agent/toolkit-update.js --post-merge`）并执行 `git config core.hooksPath .githooks`；toolkit-update.js 会在升级时自愈这两项，缺省可接受。

## 步骤 5：package.json 与 Agent 骨架模板

- **Claude Code 权限基线（install 已自动落地，无需本步操作）**：`install.sh` 在目标项目 `.claude/settings.json` 缺失时写入基线（低风险 Bash 宽匹配 `ls/cat/grep/find/mv/cp/...` + MCP 档位开关）；删除文件等危险操作**不授权、仍每次确认**；仓库已有 `settings.json` 则跳过不覆盖。
- **package.json（仅 Node 项目）**：scripts 段追加 `project:sync` / `worktree:init` / `worktree:sync` / `model:switch` 四条，均指向 `node scripts/agent/<脚本>`。非 Node 项目不创建 package.json，文档口径用裸 `node scripts/agent/<script>.js`。
- **Agent 骨架模板（按步骤 0 选定的 Agent）**：
  - 选了 CodeBuddy → 复制 `templates/models.template.json` 到项目 `.codebuddy/models.template.json`
  - 选了 OpenCode → 复制 `templates/opencode.template.jsonc` 到项目根 `opencode.template.jsonc`
  - 模板只含占位符（`{{SUBSCRIPTION_MODELS}}` 等），订阅内容全部由 project:sync 从快照渲染注入，**手改渲染产物会被下次 sync 覆盖，定制只改模板**

## 步骤 6：验证并交付

1. 跑 `pnpm project:sync`（或 `node scripts/agent/project-sync.js`）——无密钥变量时必须降级为"仅补链模式"并警告，不得非零退出
2. multi 档：指导用户填 secrets → 重跑 → 确认渲染产物生成
3. AGENTS.md 追加一段工具链用法说明（尊重项目原有结构，追加不重写）
4. 交付清单打印给用户：
   - **提交**：`scripts/agent/`、`agents.config.json`、`.claude/settings.<name>.json`（multi 结构版）、`*.example`、`.gitignore`、package.json（如有）、AGENTS.md 追加段
   - **永不提交**：secrets、全部渲染产物、软链

🛑 CHECKPOINT：交付前把"提交清单 / 永不提交清单"逐项念给用户确认，`git status` 无一多余文件才收尾。

## 升级模式（检测到 `scripts/agent/` 已存在）

- 日常升级走 `.githooks/post-merge` 自动触发（toolkit-update.js，档 B）；手动升级跑 `node scripts/agent/toolkit-update.js`
- 只覆盖 `scripts/agent/` 下脚本
- `agents.config.json` 键级合并：保留用户已填值、新增键补默认、废弃键经 defaults-snapshot 比对后移除（定制过的保留提示）并打印变更摘要
- 反例：整文件覆盖 config——用户密钥映射与档位定义被清空 = 事故

## 验收自检（交付前逐条过）

- [ ] `grep -iE "token|key|secret" agents.config.json` 无真值命中（只有 `${var}` 与空串）
- [ ] `git status` 无 secrets / 渲染产物 / 软链进入暂存区
- [ ] project:sync 在无密钥状态下不非零退出
- [ ] 多人库同事视角口述走查：clone → 照 example 填 secrets → project:sync 三步可用
