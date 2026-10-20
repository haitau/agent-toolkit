#!/usr/bin/env node
//
// agents-gitignore.js — .gitignore 运行时防线的三档渲染器（一次性初始化命令）
//
// 用法：
//   node scripts/agent/agents-gitignore.js <public|team|private> [--root <dir>]
//
// 档位（与步骤 0 仓库类型问答一一对应）：
//   public  — GitHub 公开开源：技能/权限基线/hook 纯属作者个人环境，一律不入库；密钥防线全开
//   team    — 多人协作/公司（默认档）：项目自有技能与 Claude 权限基线/hook 入库共享，
//             仅安装引导包 agent-env-init 与密钥/本机运行时忽略
//   private — 个人私密：快照（含 Key）、项目 MCP、技能、权限基线全部入库双机漫游，
//             仅忽略槽位专属渲染产物、本机软链与依赖
//
// 幂等：以 "# >>> agent-toolkit runtime" / "# <<< agent-toolkit runtime" 标记对管理区块，
// 重复执行只替换块内、块外用户内容不动；兼容 v20261020.3 及更早的单标记旧块（旧块恒在文件尾，整段迁移）。
//
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BEGIN = '# >>> agent-toolkit runtime';
const END = '# <<< agent-toolkit runtime';
const LEGACY_BEGIN = '# agent-toolkit local runtime';

// 三档共同忽略：本机渲染产物（含槽位专属 Key）、AGENTS_REGISTRY 派生软链、依赖
const COMMON = [
  '.claude/settings.local.json',
  '.machine-state.json',
  '.mcp-state.json',
  '.agent-toolkit.defaults-snapshot.json',
  '.agents/plugins/**/mcp_config.json',
  'opencode.jsonc',
  '.codebuddy/models.json',
  '.codebuddy/settings.local.json',
  '.codex/',
  '.pi/',
  '.claude/rules',
  '.claude/skills',
  '.codebuddy/rules',
  '.codebuddy/skills',
  '.trae/rules',
  '.trae/skills',
  '.trae/mcp.json',
  'node_modules/',
];

// 密钥/订阅快照防线（public/team deny-by-default；private 快照直存入库存漫游）
const SNAPSHOT_GUARD = [
  '.claude/settings.*.secrets.json',
  '.claude/settings.*.json',
  '!.claude/settings.sample.json',
  '.mcp.json',
  '.agents/mcp_config.json',
];

const PROFILES = {
  public: {
    alias: ['public'],
    header: 'public 档（公开开源）：密钥防线全开；技能/Claude 权限基线/hook 属作者个人环境不入库',
    extra: [
      ...SNAPSHOT_GUARD,
      '.agents/skills/',
      '.claude/hooks/',
      '.claude/settings.json',
    ],
  },
  team: {
    alias: ['team', 'multi'],
    header: 'team 档（多人协作/公司）：项目自有技能与权限基线/hook 入库共享；密钥与引导包不入库',
    extra: [
      ...SNAPSHOT_GUARD,
      '.agents/skills/agent-env-init/',
    ],
  },
  private: {
    alias: ['private'],
    header: 'private 档（个人私密）：快照/项目 MCP/技能/权限基线全部入库漫游；仅本机运行时与软链忽略',
    extra: [],
  },
};

function log(msg) { console.log(`[agents-gitignore] ${msg}`); }
function die(msg) { console.error(`[agents-gitignore] ✗ ${msg}`); process.exit(1); }

function resolveProfile(arg) {
  for (const [name, p] of Object.entries(PROFILES)) {
    if (p.alias.includes(arg)) return name;
  }
  return null;
}

function renderBlock(profile) {
  const p = PROFILES[profile];
  const lines = [`${BEGIN}（${p.header}；换档重跑本命令，勿手改块内）`, ...COMMON, ...p.extra, END, ''];
  return lines.join('\n');
}

function upsertBlock(gitignore, block) {
  // 新格式：标记对整块替换
  const paired = new RegExp(`^${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?^${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'm');
  if (paired.test(gitignore)) return gitignore.replace(paired, block);
  // 旧格式（v20261020.3 及更早单标记，块恒追加于文件尾）：整段迁移
  const legacyIdx = gitignore.indexOf(LEGACY_BEGIN);
  if (legacyIdx >= 0) {
    return gitignore.slice(0, legacyIdx).replace(/\s*$/, '\n\n') + block;
  }
  // 无标记：尾部追加
  return gitignore.replace(/\s*$/, '\n\n') + block;
}

function main() {
  const args = process.argv.slice(2);
  const profileArg = args.find((a) => !a.startsWith('--'));
  const rootIdx = args.indexOf('--root');
  const dirOverride = rootIdx >= 0 ? args[rootIdx + 1] : '';
  if (!profileArg) {
    die('缺少档位参数：node scripts/agent/agents-gitignore.js <public|team|private>');
  }
  const profile = resolveProfile(profileArg);
  if (!profile) die(`未知档位 [${profileArg}]，可选：public / team / private`);

  let root = dirOverride;
  if (!root) {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' });
    root = r.status === 0 ? r.stdout.trim() : process.cwd();
  }
  const giPath = path.join(root, '.gitignore');
  const before = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf-8') : '';
  const after = upsertBlock(before, renderBlock(profile));
  if (after === before) {
    log(`✓ .gitignore 已是 ${profile} 档防线，无变更`);
  } else {
    fs.writeFileSync(giPath, after, 'utf-8');
    const migrated = before.includes(LEGACY_BEGIN) && !before.includes(BEGIN) ? '（旧版单标记块已迁移）' : '';
    log(`✓ .gitignore ${profile} 档运行时防线已就位${migrated} → ${giPath}`);
  }
  const hints = {
    public: '技能包、.claude/hooks/、.claude/settings.json 均不入库；clone 者跑 install.sh 本地生成',
    team: '项目自有技能、.claude/hooks/、.claude/settings.json 随仓共享；agent-env-init 引导包与密钥不入库',
    private: '快照/项目 MCP/技能全部入库；确认 .claude/settings.*.json 等未被其他规则忽略',
  };
  log(`  ${hints[profile]}`);
}

main();
