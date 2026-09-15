---
name: agent-env-init
description: 初始化或升级多 Agent 项目环境：渲染各 Agent 运行时配置（Claude Code/OpenCode/CodeBuddy/Codex/Antigravity/Pi）、项目自定义 MCP 全 Agent 自动聚合广播、Claude Code 端点快速切换、git worktree 多槽位并发开发管线、外部来源技能上游跟踪（技能注册表生成与升级）。触发词：初始化多agent环境、搭建 agent 工具链、升级 agent-toolkit、同事怎么获得 agent 配置、多agent怎么同步配置、添加自定义mcp、项目级mcp怎么共享、worktree并发怎么配、切换模型端点、生成技能注册表、外部技能怎么跟踪上游、skill 怎么升级。当用户要在 git 项目里建立多 Agent 并行开发环境、接入新 Agent、配置/共享 MCP 工具、跟踪外部技能上游更新、或升级已初始化项目的工具链脚本时使用。
---

# agent-env-init：多 Agent 项目环境初始化与治理

## 一、定位与入库哲学

本 skill = 一次性安装器 + 长期规范说明书。安装产物（`scripts/agent/` + `agents.config.json`）是项目自包含资产，同事 clone 仓库后运行初始化或同步即可得，无需本 skill。

### 两种仓库入库哲学的根本分水岭

在执行任何初始化操作前，必须首先明确目标仓库的定位：

| 维度 | 公开开源 / 多人团队项目（默认档） | 私人私密数字资产项目（单人私密档） |
| :--- | :--- | :--- |
| **安全哲学** | **Deny-by-default（绝对防泄密）** | **受控入库与双机漫游（Zero Setup on Checkout）** |
| **快照入库策略** | 快照**拆双层**：tracked 结构版（token 留空） + gitignored 本地 `.secrets.json` | 快照**直接带 Key 入库**追踪，换机 checkout 即开箱可用 |
| **项目 MCP 策略** | `.mcp.json` 与 `.agents/mcp_config.json` 进 `.gitignore`（防 token 泄露） | `.mcp.json` 与 `.agents/mcp_config.json` **入库追踪**，实现项目 MCP 全局漫游 |
| **`.gitignore` 目标** | 阻断任何含密钥的配置、本地运行时产物外流 | **仅用于隔离多工位配额争抢与合并冲突**（如各槽位专属 Key 运行时文件） |

### 三大核心红线（违反即泄密或破坏版本库）

1. **`agents.config.json` 永远不含真实密钥**：该文件为团队共享配置，密钥只允许通过 `${var}` 插值从本地快照/secrets 注入。
2. **本地同构软链接绝不入库**：所有客户端目录下（如 `.claude/rules`、`.codebuddy/skills`、`.trae/mcp.json`）的软链纯属 `project:sync` 运行时动态生成的本地快捷映射，单一真相源在 `.agents/` 与根目录，**软链 100% 进 `.gitignore`，严禁提交**。
3. **两套同步管线各司其职，严禁越界**：
   - **`project:sync`** 仅负责 **Git Ignored（本地运行时配置与软链）** 的同构渲染，**严禁物理删除或修改任何 Git Tracked 受控版本文件**；
   - **`worktree:sync`** 全权负责 **Git Tracked（版本受控树）** 的多分支合并与基线反推。

---

## 二、步骤 0：交互问答（缺一不执行）

问清五件事，逐条确认后才进入执行：
1. **仓库类型**：公开开源 / 多人团队 / 私人私密单机（决定使用哪档模板与入库策略）。
2. **密钥管理方式**：本机 secrets 分层文件（团队库必选）/ 私仓快照直存（私密仓可选）。
3. **要接入哪些 Agent**：Claude Code / OpenCode / CodeBuddy / Codex / Antigravity / Pi（至少一个）。
   - **Claude Code**：读取 `.claude/settings.json`（权限与 MCP 开关，安装器写入黑名单反转基线）与 `.claude/settings.local.json`（本地 env，gitignored）；
   - **Antigravity (AGY)**：唯一项目级 MCP 标准位为 `.agents/mcp_config.json`（原生读取，无需插件目录，杜绝双重加载）；
   - **OpenCode**：由根目录 `opencode.template.jsonc` 渲染出 `opencode.jsonc`（含专属 Key 与全量 MCP，gitignored；权限为黑名单反转模式）；
   - **CodeBuddy**：读取 `.codebuddy/models.json`（模型池，gitignored）与 `.codebuddy/settings.local.json`（启停清单，gitignored）；
   - **Codex**：项目级 `.codex/config.toml`（仅 MCP 段，gitignored；模型/provider 由用户全局 `~/.codex/config.toml` 提供，项目层官方忽略模型键，首次使用需在 Codex 内 trust 项目）；
   - **Pi**：原生读取根目录 `.mcp.json` 或全局 MCP，模型由全局镜像同步。
4. **软链接策略**：Claude Code、CodeBuddy、Trae 需要 rules/skills 软链（由 install 与 project:sync 动态补齐）；Antigravity 与 Pi 原生感知根目录 `.agents/` 免链。
5. **外部技能上游跟踪**：项目 `.agents/skills/` 中是否存在外部来源技能（GitHub 直装 / npm / PyPI / 本地 clone）需要跟踪上游更新？
   - **需要** → **必须先把状态同步给用户**：本能力依赖一份注册表，且注册表内容只能由「与 AI 对话」逐条确认后生成（渠道与升级策略是人的判断，严禁凭空填写）。执行方式见**步骤 8**；本项目当前无注册表时引擎只打印启用引导，不会报错。
   - **不需要**（外部技能 ≤3 个且几乎不更新）→ 明确跳过，不引入该机制。

🛑 **CHECKPOINT 0**：把「仓库类型 / 密钥位置 / 目标 Agent 清单 / 选用模板档位 / 是否启用外部技能跟踪」复述给用户，明确确认后才继续。其中第 5 项若答案为「需要」，须同时告知用户：需要在 AI 对话中说「生成技能注册表」完成注册表生成（见步骤 8）。

---

## 三、失败模式与异常处理

- **若用户回答"随便"/"你定"**：按默认（multi 档 + secrets 分层 + 全部 Agent）复述确认；若确认仍含糊 → **中止初始化，不得静默做主**。
- **若 `project:sync` 执行失败（非零退出）**：停止交付，先排查 `agents.config.json` JSON 语法与路径有效性，修复后重跑。
- **若未提供密钥且未出现"仅补链模式"降级提示**：视为引擎异常，停止交付排查。
- **若项目已有 `scripts/agent/`**：自动转入"升级模式"（见后文），**严禁整目录盲目覆盖**。
- **若 `.gitignore` 已含 agent-toolkit 标记块**：跳过追加（保证幂等），不得重复拼接。
- **若 `git status` 发现 secrets 或动态软链接进入暂存区**：立即执行 `git restore --staged <file>` 退回，并修正 `.gitignore`。

---

## 四、步骤 1：安装/升级脚本

将本 skill 目录下 `scripts/` 全部文件复制到项目 `scripts/agent/`：
- `agents-config.js`：配置解析与规范校验；
- `agents-registry.js`：全系 Agent 协议转换与异构抹平引擎；
- `project-sync.js`：项目级配置渲染、自定义 MCP 聚合与同构广播；
- `worktree-init.js`：多槽位 Worktree 初始化与环境装配；
- `worktree-sync.js`：并发工作区合并、基线反推与冲突无损叠加；
- `model-switch.js`：Claude Code 端点与模型快速切换；
- `skills-update.js`：外部来源技能上游跟踪（可选能力，见步骤 8；未建注册表时仅打印启用引导，不报错）。

---

## 五、步骤 2：配置 agents.config.json

从 `templates/agents.config.<档位>.json` 复制到项目根目录，按项目实际调整：
- `mcp.profiles`：项目级托管 MCP 服务定义（支持 http/stdio 两型与 `${var}` 插值）；
- `mcp.keys`：将变量名映射到订阅快照名；
- `updates`：`sourceUrl` 指向 toolkit 来源、`toolkitVersion` 记录当前版本；
- `worktree`：槽位前缀映射与多工位冲突隔离配置；
- `skills`（可选）：`registryPath` 指定外部技能上游注册表位置（默认 `scripts/skills-sources.json`）、`docsLedgerPath` 指定人读账本（留空即关闭账本回写，公开/团队档建议留空）。

---

## 六、步骤 3：配置订阅快照

- **公开 / 多人团队档（双层分层）**：
  - Tracked 结构版：从 `templates/settings.sample.json` 复制为 `.claude/settings.sample.json`（或 `.claude/settings.<name>.json`，包含 baseURL/模型名/槽位配置，token 留 `""`）；
  - Gitignored 本地版：从 `templates/settings.secrets.sample.json` 复制为 `.claude/settings.<name>.secrets.json`（仅放真实 token，由开发者本地维护）。
- **私人私密档**：
  - 可跳过拆分，快照直接包含真实 Key 入库追踪，保障换机无感漫游。
- **外来快照导入**：
  - 拷贝进项目后，须在 `agents.config.json` 的 `providers` 显式注册一行方可激活。

---

## 七、步骤 4：项目级 MCP 治理与全系自动聚合扩散

### 1. 项目自定义 MCP 的单一真相源（根目录 `.mcp.json`）
用户或原有项目既有的 MCP 服务，直接在项目根目录 `.mcp.json` 中配置即可：
- **自动聚合**：`project:sync` 运行时，会首先读取根 `.mcp.json` 中的自定义 server，与当前托管档位（profile）的 server 自动合并为单一权威集合；
- **跨 Agent 同构广播**：引擎会自动抹平协议差异（如 command 数组/字符串转换、env/environment 兼容、http/sse/serverUrl 转换），全量广播至：
  - OpenCode：注入 `opencode.jsonc` 的 `"mcp"` 字段；
  - Antigravity：渲染至 `.agents/mcp_config.json`；
  - CodeBuddy：自动校准 `settings.local.json` 的启停清单。

### 2. 托管档位与更新生效
- **托管 Profiles**：定义在 `agents.config.json` 的 `mcp.profiles` 中，由 `mcp.defaultProfile` 决定激活档位；
- **单管线刷新**：无论是修改了 `agents.config.json` 中的托管 server，还是在根目录 `.mcp.json` 中添加/修改了自定义 server，直接运行 `pnpm project:sync`（或 `node scripts/agent/project-sync.js`），即可一键重渲染并广播至主仓及所有槽位。

---

## 八、步骤 5：.gitignore 防线与动态软链绝对不入库

`install.mjs` 会自动在项目 `.gitignore` 注入如下保护块：

```gitignore
# agent-toolkit local runtime（含密钥渲染产物与本机软链，严禁提交）
.claude/settings.local.json
.claude/settings.*.secrets.json
.claude/settings.*.json
!.claude/settings.sample.json
.machine-state.json
.mcp-state.json
.agent-toolkit.defaults-snapshot.json
.mcp.json
.agents/mcp_config.json
.agents/plugins/**/mcp_config.json
opencode.jsonc
.codebuddy/models.json
.codebuddy/settings.local.json
.codex/
.claude/rules
.claude/skills
.codebuddy/rules
.codebuddy/skills
.trae/rules
.trae/skills
.trae/mcp.json
```

- **公开/多人团队档**：上述配置直接适用，严禁精简；
- **私人私密单机档**：若希望双机漫游，从上述块中移除 `.claude/settings.*.json`、`.mcp.json` 与 `.agents/mcp_config.json`（保留其余本地运行时隔离项与全部软链忽略）。

---

## 九、步骤 6：package.json 命令矩阵与模板落地

在 Node 项目 `package.json` 的 `scripts` 段注册 4 条标准治理命令：
```json
{
  "scripts": {
    "project:sync": "node scripts/agent/project-sync.js",
    "worktree:init": "node scripts/agent/worktree-init.js",
    "worktree:sync": "node scripts/agent/worktree-sync.js",
    "model:switch": "node scripts/agent/model-switch.js",
    "skills:check": "node scripts/agent/skills-update.js --check",
    "skills:update": "node scripts/agent/skills-update.js --update"
  }
}
```

> `skills:check` / `skills:update` 仅在启用步骤 8 的外部技能跟踪时有意义；未建注册表时 `skills:check` 只打印启用引导并正常退出（不报错）。

落地 Agent 骨架模板：
- 选用 Claude Code（公开/团队档）→ 复制 `templates/settings.sample.json` 到 `.claude/settings.sample.json`；
- 选用 CodeBuddy → 复制 `templates/models.template.json` 到 `.codebuddy/models.template.json`；
- 选用 OpenCode → 复制 `templates/opencode.template.jsonc` 到根目录 `opencode.template.jsonc`。

---

## 十、多 Worktree 并发开发铁律（三不原则）

使用 `pnpm worktree:init <name>` 派生子槽位（如 `../project-feature`）进行多 Agent 并发开发时，必须遵守以下纪律：

1. **槽位物理禁 push**：各常驻槽位物理禁止直接向远端 push，所有交付统一在主工作区（`master`）合并后提交推送。
2. **`project:sync` 不碰版本树**：`project:sync` 只用于跨槽位分发运行时配置（`.claude/settings.local.json`、`opencode.jsonc` 等）与同构软链。**任何被 Git 追踪的文件，一律严禁在 `project:sync` 中物理删除或覆盖**。
3. **`worktree:sync` 统一合并与反推**：所有代码变动在主仓通过 `pnpm worktree:sync` 进行逐支合并（冲突按 A+B 无损叠加解决），并通过基线反推下发至各槽位。

---

## 十一、步骤 7：验证与交付

1. 运行 `pnpm project:sync`：
   - 验证无密钥时能够安全降级为"仅补链模式"且退出码为 0；
   - 验证提供密钥后各 Agent 运行时文件生成且协议格式合法；
   - 验证在根 `.mcp.json` 中手加自定义 server 能被自动扩散到 OpenCode 与 Antigravity。
2. 检查 `git status`：
   - **应提交**：`scripts/agent/`、`agents.config.json`、模板文件、`.gitignore`、`package.json`（如有）；
   - **绝对严禁暂存**：secrets 文件、各类运行时渲染产物、所有以 `.rules`/`.skills`/`mcp.json` 结尾的软链接。

🛑 **CHECKPOINT 1**：交付前对照暂存区逐项过目，确保无一多余或敏感文件。

---

## 十二、步骤 8：外部技能上游注册表（按需启用）

项目 `.agents/skills/` 里若混有外部来源技能（GitHub 直装 / npm / PyPI / 本地 clone），它们的上游会持续更新。本步骤用一份**注册表**（机器 SSOT）把「哪个技能来自哪里、要不要跟上游」固定下来，之后一条命令即可查新版、定向升级。

### 何时启用（YAGNI 边界）

| 仓库情况 | 处置 |
| :--- | :--- |
| 外部来源技能 ≤ 3 个、且基本不更新 | **不启用**。需要时手工 `git -C ~/github/<repo> pull` + rsync 两条命令足够 |
| 外部来源技能数量多（十几二十个）或需持续跟版 | **启用**。手工比对必然漏版，机制回本 |

### 🛑 前置红线：注册表必须由「与 AI 对话」生成

**严禁**凭空手写或凭猜测填注册表——每个技能的**渠道**与**升级策略**是人的判断，填错会导致「本地定制被上游覆盖」或「永远查不到新版」。正确姿势：

1. **先取证**（只读，不写任何文件）：
   ```sh
   node scripts/agent/skills-update.js --init
   ```
   引擎按三层启发式列出外部来源嫌疑技能——①`SKILL.md` 头 20 行含 `license:` 行；②`SKILL.md` 任意行含 `github.com`；③目录含 `package.json`（须有 name+version 或远程 repository，`npx skills add` 整仓安装类技能的出处只在这里）或 `LICENSE` 文件——并输出候选条目骨架 JSON（含可提取的上游 repo 与版本）。
2. **与 AI 对话逐条确认**（可批量复述后确认）：
   - **渠道 `channel`**：`repo-copy`（本机有 clone 目录）/ `github-direct`（GitHub 直装，无 clone）/ `npm` / `uv-tool` / `cli` / `manual`；
   - **升级策略 `update_policy`**：
     - `follow-upstream` — 紧跟上游（`--all --yes` 自动升级范围内）；
     - `keep-local` — 本地深度定制，**永不自动覆盖**（具名升级也会被拦）；
     - `manual` — 仅人工（`--all` 跳过，具名仍可）。
3. **补全渠道必需字段**：
   - `repo-copy` → `clone_path`（`~/` 可用）+ `source_subdir`；
   - `github-direct` / `cli` → `repo`（+ 可选 `tag_prefix`，**可省略，默认空**；仓库 tag 自带 `v` 时无需填）+ 当前 `version`；
   - `npm` / `uv-tool` → `package` + 当前 `version`。
4. **写入注册表**：默认 `scripts/skills-sources.json`（路径由 `agents.config.json` 的 `skills.registryPath` 决定；也可从 `templates/skills-sources.sample.json` 起手）。
5. **验证**：
   ```sh
   node scripts/agent/skills-update.js --check    # 首次会把 repo-copy 技能的基线回填为 clone HEAD
   ```

### 日常使用

```sh
node scripts/agent/skills-update.js --check              # 只读巡检：有新版 / 本地漂移 / 未登记外部技能
node scripts/agent/skills-update.js --list               # 列出注册表条目
node scripts/agent/skills-update.js <name> --update      # 具名升级（升级前展示差异清单并确认）
node scripts/agent/skills-update.js --all --yes --update # 仅对 follow-upstream 且确认有新版的技能自动升级
```

- 覆盖前必展示差异清单并二次确认；`rsync` **不带 `--delete`**，本地多余文件保留（`.agents/skills` 受 git 追踪，可回滚）；
- 升级后按提示跑 `pnpm project:sync` 补链并重启会话；
- **未建注册表时**：`--check` 只打印启用引导并 exit 0，`--update` exit 1（写入动作缺注册表属显式失败），均不会吐栈回溯。

---

## 十三、升级模式（已存在 `scripts/agent/`）

- 手动升级：执行 `node scripts/agent/toolkit-update.js`；
- 仅覆盖 `scripts/agent/` 下的核心脚本（含 `skills-update.js`，升级不会触碰你的注册表——注册表是项目数据，非引擎文件）；
- `agents.config.json` 执行键级无损合并：保留用户已定制内容，仅补齐新增配置键；
- **自举自愈**（无需人工干预）：①升级引擎发现自身有新版本时先自我刷新再用新引擎重跑；②版本号已是最新但缺少出厂脚本时自动补齐（覆盖「上游引擎清单扩容」与「本地误删」两种情形，补齐不改写版本号）。两条保护都要求工作区干净，脏区会提示先 commit/stash。
- **技能包内副本同步刷新**：升级会按远端 `install.mjs` 的 `MANIFEST` 一并刷新 `.agents/skills/agent-env-init/{scripts,templates,hooks}`（引擎 + 模板 + 自愈 hook）。该目录是 AI 按步骤 1 复制到 `scripts/agent/` 的源头，滞留旧版会导致「文档说新能力、实际拿到旧引擎」。
- **绝不夺 `core.hooksPath`**：宿主已有 hooks 管理器（husky 等）时，post-merge 自动升级钩子写入该管理器的入口（husky → `.husky/post-merge`），既有 `pre-commit`/`pre-push` 不受影响；仅当项目本无 `hooksPath` 时才接管为 `.githooks`。曾被旧版夺权的仓库会在下次升级时自动还原宿主配置。若目标 hook 文件已存在且非本工具生成，则跳过并提示（不覆盖你的钩子）。
- **发布传播延迟**：`raw.githubusercontent.com` 有约 5 分钟 CDN 缓存（实测发布后 `x-cache: HIT` 仍回旧 VERSION，加查询参数亦不能绕过）。若升级时机紧贴上游发布，可能读到旧版本并提示「已是最新」或按旧引擎行为执行——**稍后重跑即可**，不是引擎故障。
- **`agents.config.json` 只做真实变更**：键级合并保持原键顺序（新键追加末尾），并按模板既有风格序列化（小对象/短数组保持内联），升级 diff 只含真实改动，不做整体重排。

---

## 十四、反模式与黑名单（Anti-Patterns）

- ❌ **反模式 1：在 `agents.config.json` 中写死真实 Token**（必须通过 `${var}` 动态插值）；
- ❌ **反模式 2：将客户端目录下的软链接提交入库**（软链易引发跨平台断链，且单一真相源在 `.agents/`）；
- ❌ **反模式 3：在 `project:sync` 中物理 `rm` 受 Git 追踪的文件**（必须由 `worktree:sync` 走 Git 标准流转）；
- ❌ **反模式 4：在常驻 Worktree 槽位直接执行 `git push`**（破坏主干管理，甚至引发远端分支覆盖）；
- ❌ **反模式 5：升级时整文件盲覆盖 `agents.config.json`**（导致团队定制配置被清空）；
- ❌ **反模式 6：凭空手写技能上游注册表**（渠道与策略必须经与 AI 对话确认；把本地深度定制的技能登记为 `follow-upstream` 会被上游覆盖，登记为 `repo-copy` 却写错 `clone_path` 会静默查不到新版）；
- ❌ **反模式 7：在共享/团队项目里把 `skills.docsLedgerPath` 指向不存在的人读账本**（账本回写是可选能力，留空即关闭；指向不存在文件只会产生噪音）。
