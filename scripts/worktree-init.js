#!/usr/bin/env node
//
// worktree-init.js（pnpm worktree:init）
//
// 用途：为当前项目创建一个 git worktree 功能开发区，用于多 Agent 并行开发。
//       自动完成：创建 worktree+分支、pnpm install + uv sync、Agent 配置与 rules/skills 链接补齐、
//       打印槽位红线铁律。
//
// 用法：
//   pnpm worktree:init <worktree-name> [--base <branch>]
//
// 约定：
//   - worktree 创建在主仓同级目录：../<主仓名>-<worktree-name>（前缀映射见 agents.config.json worktree.dirPrefix）
//   - 分支名：feature/<worktree-name>（kebab-case）
//   - 默认基于 master 分支切出
//
// 退出码：
//   0 - 成功
//   1 - 失败（路径已存在 / git worktree add 失败 / 依赖缺失）
//   2 - 参数错误
//
// 历史：自公司项目内部版演进而来，差异（文档仓无服务端运行时）：
//   - 裁剪 .env.local/.env.test 槽位专属库生成与 dev 端口分配（本仓无 DB / dev server）
//   - 裁剪 codegraph 索引重建（本仓未启用 codegraph）
//   - 依赖装配增加 uv sync（本仓 pnpm + uv 双工具链）
//
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { loadAgentsConfig } from './agents-config.js';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

function printUsage() {
  console.log(`用法: pnpm worktree:init <worktree-name> [--base <branch>]

参数:
  <worktree-name>   worktree 名称（kebab-case），分支自动派生为 feature/<name>
  --base <branch>   基线分支，默认 master

示例:
  pnpm worktree:init feat-pdf
  pnpm worktree:init feat-pdf --base master`);
}

function parseArgs(argv) {
  const opts = { name: '', base: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      opts.base = argv[++i];
      if (opts.base === undefined) fail('缺少 --base 的值', 2);
    } else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      fail(`未知参数: ${arg}`, 2);
    } else if (opts.name === '') {
      opts.name = arg;
    } else {
      fail(`多余参数: ${arg}`, 2);
    }
  }
  return opts;
}

function fail(msg, code = 1) {
  console.error(`${RED}✗ ${msg}${RESET}`);
  process.exit(code);
}

async function main() {
  // 主仓定位
  let mainRepo;
  try {
    mainRepo = run('git rev-parse --show-toplevel');
  } catch {
    fail('不在 git 仓库内');
  }
  const worktreeParent = path.dirname(mainRepo);
  const projectName = path.basename(mainRepo);

  const { name, base } = parseArgs(process.argv.slice(2));
  if (name === '') {
    printUsage();
    fail('缺少 worktree-name', 2);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    fail(`名称须为 kebab-case（小写字母/数字/短横线）: ${name}`, 2);
  }

  const branch = `feature/${name}`;
  const wtCfg = loadAgentsConfig(mainRepo).worktree;
  const dirPrefix = wtCfg.dirPrefix?.[projectName] || projectName;
  const worktreePath = path.join(worktreeParent, `${dirPrefix}-${name}`);

  if (fs.existsSync(worktreePath)) {
    fail(`worktree 路径已存在: ${worktreePath}`);
  }

  // 基线分支：默认 master（优先 origin/HEAD）
  let baseBranch = base;
  if (!baseBranch) {
    try {
      baseBranch = run('git symbolic-ref refs/remotes/origin/HEAD').replace(/^refs\/remotes\/origin\//, '');
    } catch {
      baseBranch = 'master';
    }
  }

  console.log(`${CYAN}➜ 创建 worktree${RESET}`);
  console.log(`  路径: ${worktreePath}`);
  console.log(`  分支: ${branch} (基于 ${baseBranch})`);
  console.log('');

  try {
    execSync(`git worktree add "${worktreePath}" -b "${branch}" "${baseBranch}"`, { stdio: 'inherit' });
  } catch {
    fail('git worktree add 失败');
  }

  // 依赖装配：仅 Node 项目（有 package.json）跑 pnpm install；非 Node 项目跳过（文档仓/纯脚本项目零依赖）
  if (fs.existsSync(path.join(worktreePath, 'package.json'))) {
    console.log(`${CYAN}➜ pnpm install${RESET}`);
    try {
      run('pnpm --version');
    } catch {
      fail('pnpm 未安装，请先 corepack enable（或 npm i -g pnpm）');
    }
    execSync('pnpm install --silent', { cwd: worktreePath, stdio: 'inherit' });
  } else {
    console.log(`${CYAN}➜ 非 Node 项目（无 package.json），跳过 pnpm install${RESET}`);
  }

  // uv sync（Python 工具链，尽力而为：仅项目自带 pyproject.toml 时执行，防向上爬到外层仓误同步）
  if (fs.existsSync(path.join(worktreePath, 'pyproject.toml'))) {
    console.log(`${CYAN}➜ uv sync${RESET}`);
    const uv = spawnSync('uv sync', { cwd: worktreePath, encoding: 'utf-8', shell: true });
    if (uv.status === 0) {
      console.log('  ✓ Python 依赖已安装');
    } else {
      console.log(`${YELLOW}  ⚠ uv sync 失败或未安装，可稍后手动 uv sync${RESET}`);
    }
  } else {
    console.log(`${CYAN}➜ 非 Python 项目（无 pyproject.toml），跳过 uv sync${RESET}`);
  }

  // 同步 Agent 配置与链接（rules/skills 补链；兼容本仓 scripts/ 与 toolkit 项目 scripts/agent/ 两种布局）
  console.log(`${CYAN}➜ 同步 Agent 链接与配置（project:sync）${RESET}`);
  const syncScript = [
    path.join(mainRepo, 'scripts', 'agent', 'project-sync.js'),
    path.join(mainRepo, 'scripts', 'project-sync.js'),
  ].find((p) => fs.existsSync(p));
  if (syncScript) {
    const result = spawnSync(process.execPath, [syncScript], { encoding: 'utf-8' });
    if (result.status === 0) {
      console.log('  ✓ Agent 链接与配置已同步');
    } else {
      console.log(`${YELLOW}  ⚠ project-sync.js 执行警告: ${(result.stderr || '').trim()}${RESET}`);
    }
  }

  // 项目级可选后置初始化（主仓 package.json "worktreeInit": ["<cmd>", ...]）
  // 声明了才执行：MCP / 工具链每项目不同（如 codegraph），启用与否由项目声明决定，
  // 脚本不硬编码任何工具名——杜绝"本机全局装了就给不需要的项目建索引"的反向漏洞；
  // 未声明 → 整段跳过；执行失败（含本机未安装）仅警告不阻断。
  console.log(`${CYAN}➜ 项目级可选初始化（worktreeInit）${RESET}`);
  let postInit = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(mainRepo, 'package.json'), 'utf-8'));
    postInit = Array.isArray(pkg.worktreeInit) ? pkg.worktreeInit : [];
  } catch {
    // package.json 缺失/损坏按未声明处理
  }
  if (postInit.length === 0) {
    console.log('  ℹ 未声明 worktreeInit，跳过（本项目无可选初始化命令）');
  } else {
    for (const cmd of postInit) {
      const r = spawnSync(cmd, { cwd: worktreePath, encoding: 'utf-8', shell: true });
      if (r.status === 0) console.log(`  ✓ ${cmd}`);
      else console.log(`${YELLOW}  ⚠ ${cmd} 失败（本机未安装或环境不满足），不阻断${RESET}`);
    }
  }

  // -----------------------------------------------------------------------------
  // 完成 + 操作指引
  // -----------------------------------------------------------------------------
  console.log('');
  console.log(`${GREEN}✓ worktree 初始化就绪！${RESET}`);
  console.log('');
  console.log(`${YELLOW}══════════════════ 槽位红线（与 AGENTS.md 一致） ══════════════════${RESET}`);
  console.log(`  ${RED}✗ 子槽位物理禁 push${RESET}：提交保留在本地分支，统一由主仓 pnpm worktree:sync 合并（Push Gate 需显式授权）`);
  console.log(`  ${RED}✗ 外科手术式提交${RESET}：只 git add 本任务文件，严禁 git add . / commit -a`);
  console.log(`  ${GREEN}✓ 临时槽位用完立即回收${RESET}：git worktree remove + git branch -D，回收前禁跑 pnpm worktree:sync`);
  const residentSlots = wtCfg.residentSlots || [];
  if (residentSlots.length > 0) {
    console.log(`  ${GREEN}✓ 常驻槽位${RESET}（${residentSlots.join(' / ')}）物理禁删除 Worktree 或分支`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(`${RED}✗ ${err.message}${RESET}`);
  process.exit(1);
});
