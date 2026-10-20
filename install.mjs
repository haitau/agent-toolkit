#!/usr/bin/env node
//
// install.mjs — agent-toolkit 单源安装核心（install.sh / install.ps1 薄壳委托至此）
//
// 用法：
//   node install.mjs [--global] [--source <raw-url>]
//     - git 仓库内：装 skill 至 .agents/skills/agent-env-init/ + 强制建 .agents/rules
//       + bootstrap 软链（.claude 必链；.codebuddy/.trae 仅项目已有其目录时补，存在即接管）
//       + Claude 自愈 hook + .gitignore 防线
//     - 非 git 目录（或 --global）：装至 ~/.agents/skills/ 并软链 ~/.claude/skills
//       （~/.codebuddy 仅在已存在时补链）
//     - --source <raw-url>：远程 raw 模式（curl/iwr 一键安装路径），文件按 MANIFEST 拉取
//
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'agent-env-init';

const MANIFEST = [
  'SKILL.md',
  'scripts/agents-config.js',
  'scripts/agents-registry.js',
  'scripts/agents-sync.js',
  'scripts/worktree-init.js',
  'scripts/worktree-sync.js',
  'scripts/model-switch.js',
  'scripts/skills-update.js',
  'scripts/package.json',
  'scripts/toolkit-update.js',
  'templates/agents.config.private.json',
  'templates/agents.config.public.json',
  'templates/agents.config.multi.json',
  'templates/skills-sources.sample.json',
  'templates/settings.sample.json',
  'templates/settings.secrets.sample.json',
  'templates/claude-settings.template.json',
  'templates/opencode.template.jsonc',
  'templates/models.template.json',
  'hooks/ensure-skills-link.sh',
];

// 保守默认：deny-by-default（公开/多人档直接适用）——快照默认全部不入库，仅白名单放行无密钥结构层。
// 私档需「结构+密钥同层」快照入库时，由 SKILL 步骤4 在确认档位后引导手工移除这两行（见 SKILL.md 步骤4）。
const GITIGNORE_BLOCK = `# agent-toolkit local runtime（密钥渲染产物/本机软链/依赖/安装引导包，严禁提交）
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
.pi/
.claude/rules
.claude/skills
.codebuddy/rules
.codebuddy/skills
.trae/rules
.trae/skills
.trae/mcp.json

# Node 依赖（步骤6 注册 package.json 后 pnpm install 产物，任何档位均不入库）
node_modules/
# 安装引导 skill 包：一次性初始化说明书，引擎 SSOT scripts/agent/ 入库后即冗余。
# 纯个人私密漫游档需要技能包随仓分发时，删除本行（见 SKILL.md 步骤5 档位收口）
.agents/skills/agent-env-init/`;

const args = process.argv.slice(2);
const sourceIdx = args.indexOf('--source');
const sourceUrl = sourceIdx >= 0 ? args[sourceIdx + 1] : '';
const dirIdx = args.indexOf('--dir');
const dirOverride = dirIdx >= 0 ? args[dirIdx + 1] : '';
const forceGlobal = args.includes('--global');

function log(msg) { console.log(`[agent-toolkit] ${msg}`); }
function die(msg) { console.error(`[agent-toolkit] ✗ ${msg}`); process.exit(1); }

async function readSkillFile(rel) {
  if (!sourceUrl) {
    return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf-8');
  }
  const res = await fetch(`${sourceUrl}/${rel}`);
  if (!res.ok) die(`远程拉取失败 ${rel}: HTTP ${res.status}`);
  return res.text();
}

function gitToplevel() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// 目录软链（win32 用 junction 免管理员）
function ensureLink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let st = null;
  try { st = fs.lstatSync(linkPath); } catch {}
  if (st) {
    try {
      const a = fs.realpathSync(linkPath);
      const b = fs.realpathSync(targetPath);
      if (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b) return;
    } catch {}
    if (st.isSymbolicLink()) {
      fs.rmSync(linkPath, { force: true, recursive: true });
    } else {
      log(`  ⚠ ${linkPath} 为真实目录而非软链，跳过覆盖以保护本地数据`);
      return;
    }
  }
  fs.symlinkSync(path.resolve(targetPath), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

async function main() {
  const files = {};
  for (const rel of MANIFEST) files[rel] = await readSkillFile(rel);

  const top = dirOverride || gitToplevel();
  const globalMode = forceGlobal || !top;
  const skillDir = globalMode
    ? path.join(os.homedir(), '.agents', 'skills', SKILL_NAME)
    : path.join(top, '.agents', 'skills', SKILL_NAME);

  log(`安装 skill → ${skillDir}`);
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(skillDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf-8');
  }
  fs.chmodSync(path.join(skillDir, 'hooks', 'ensure-skills-link.sh'), 0o755);

  if (globalMode) {
    ensureLink(path.join(os.homedir(), '.claude', 'skills', SKILL_NAME), skillDir);
    if (fs.existsSync(path.join(os.homedir(), '.codebuddy'))) {
      ensureLink(path.join(os.homedir(), '.codebuddy', 'skills', SKILL_NAME), skillDir);
      log('✓ 全局模式：~/.agents/skills/ + claude/codebuddy 全局软链就绪');
    } else {
      log('✓ 全局模式：~/.agents/skills/ + claude 全局软链就绪（无 ~/.codebuddy，跳过；装 CodeBuddy 后重跑安装）');
    }
    log('下一步：进任意 git 项目对 agent 说「初始化多agent环境」');
    return;
  }

  // .agents/rules 强制就位（skills 已随本 skill 落地）：补链目标必须真实存在，杜绝死链
  fs.mkdirSync(path.join(top, '.agents', 'rules'), { recursive: true });

  // bootstrap 软链：agents:sync 接管前的鸡生蛋解法（agy/opencode 原生感知 .agents/ 免链）。
  // Claude 出厂必链；CodeBuddy/Trae 存在即接管——未安装对应 Agent 不主动建目录，
  // 用户日后安装并打开本项目，目录自建，下次 agents:sync 自动补链。
  for (const dir of ['.claude', '.codebuddy', '.trae']) {
    if (dir !== '.claude' && !fs.existsSync(path.join(top, dir))) {
      log(`  ℹ 未检测到 ${dir}/，跳过 rules/skills 软链（安装对应 Agent 后 agents:sync 自动接管）`);
      continue;
    }
    for (const sub of ['rules', 'skills']) {
      ensureLink(path.join(top, dir, sub), path.join(top, '.agents', sub));
    }
  }
  log('✓ bootstrap 链接就绪（.claude 必链；.codebuddy/.trae 存在即接管）');

  // Claude 自愈 hook（tracked，随 git 分发；会话启动幂等补建 .claude/skills）
  const hookPath = path.join(top, '.claude', 'hooks', 'ensure-skills-link.sh');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, files['hooks/ensure-skills-link.sh'], 'utf-8');
  fs.chmodSync(hookPath, 0o755);

  // Claude Code 权限基线（tracked，随 git 分发；仓库已有 .claude/settings.json 则跳过，绝不覆盖手维护配置）
  const ccSettingsPath = path.join(top, '.claude', 'settings.json');
  if (!fs.existsSync(ccSettingsPath)) {
    fs.mkdirSync(path.dirname(ccSettingsPath), { recursive: true });
    fs.writeFileSync(ccSettingsPath, files['templates/claude-settings.template.json'], 'utf-8');
    log('✓ Claude Code 权限基线已落地（.claude/settings.json）——黑名单反转：Bash 默认放行，sudo/rm -rf/git push 等危险门 ask 前置确认，git clean 硬拦');
  } else {
    log('ℹ .claude/settings.json 已存在，跳过权限基线写入以保护既有配置');
  }

  // .gitignore 防线（幂等标记）
  const giPath = path.join(top, '.gitignore');
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf-8') : '';
  if (!gi.includes('# agent-toolkit local runtime')) {
    fs.writeFileSync(giPath, gi.replace(/\n*$/, '\n') + '\n' + GITIGNORE_BLOCK + '\n', 'utf-8');
    log('✓ .gitignore 已追加本地运行时防线');
  } else {
    log('ℹ .gitignore 防线已存在，跳过');
  }

  log('🎉 安装完成。下一步：对 agent 说「初始化多agent环境」，按问答完成项目接入');
}

main().catch((e) => die(e.message));
