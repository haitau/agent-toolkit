#!/usr/bin/env node
//
// model-switch.js（pnpm model:switch <name>）
//
// 用途：切换本机 Claude Code 端点配置。将 .claude/settings.<name>.json 快照的
//   env / model / effortLevel / hasCompletedOnboarding 写入 .claude/settings.local.json，
//   并保留本机运行时累积的 permissions 段（切换不丢权限）。
//
// 设计：settings.local.json 已 gitignored（不入库），各机各自切换互不干扰。
//   可用端点快照 = .claude/ 下 settings.*.json（随仓库订阅而定，注册见 agents.config.json providers）。
//   以运行目录（process.cwd()）的 .claude/ 为准，主仓与各 worktree 槽位通用。
//
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadAgentsConfig } from './agents-config.js';
import { loadMcpState, writeMachineState } from './agents-registry.js';

const SNAPSHOT_KEYS = ['env', 'model', 'effortLevel', 'hasCompletedOnboarding'];


function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function loadSlotKeys(rootDir) {
  // 私仓专属特性：多订阅账号池。agents.config.json 未声明 keyPool（或置 null）即整体禁用；
  // 池文档缺失/正则无命中同样回落空池，上层自然落回单 Key，不阻断（与 project-sync.js 保持同构）
  const pool = loadAgentsConfig(rootDir).keyPool;
  if (!pool?.docPath || !pool?.pattern) return {};
  const docPath = path.join(rootDir, pool.docPath);
  const map = {};
  if (fs.existsSync(docPath)) {
    const content = fs.readFileSync(docPath, 'utf-8');
    const matches = content.matchAll(new RegExp(pool.pattern, 'g'));
    for (const m of matches) {
      map[m[1]] = m[2];
    }
  }
  return map;
}

// multi 档双层：快照结构 ⊕ 个人 secrets（settings.<name>.secrets.json 仅 token 字段），无 secrets 文件时为 no-op
function loadSnapshotWithSecrets(dir, name) {
  const snapPath = path.join(dir, '.claude', `settings.${name}.json`);
  if (!fs.existsSync(snapPath)) return null;
  const base = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
  const secretsPath = path.join(dir, '.claude', `settings.${name}.secrets.json`);
  if (fs.existsSync(secretsPath)) {
    try {
      const secretsEnv = JSON.parse(fs.readFileSync(secretsPath, 'utf-8')).env;
      if (secretsEnv) base.env = { ...(base.env || {}), ...secretsEnv };
    } catch {}
  }
  return base;
}

function listWorktrees(defaultRoot) {
  try {
    const raw = run('git worktree list --porcelain');
    const out = [];
    let cur = {};
    const flush = () => {
      if (cur.path) out.push({ ...cur });
      cur = {};
    };
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        cur.path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        cur.branch = line.replace('branch refs/heads/', '').trim();
      }
    }
    flush();
    return out.length > 0 ? out : [{ path: defaultRoot, branch: 'master' }];
  } catch {
    return [{ path: defaultRoot, branch: 'master' }];
  }
}

const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith('--'));
const isGlobal = argv.includes('--global');
const isAll = argv.includes('--all');

if (!name) {
  const snapshots = fs
    .readdirSync(path.join(process.cwd(), '.claude'))
    .filter((f) => /^settings\..+\.json$/.test(f) && !f.includes('example') && !f.includes('sample') && !f.endsWith('.secrets.json') && f !== 'settings.local.json')
    .map((f) => f.replace(/^settings\./, '').replace(/\.json$/, ''));
  console.error(
    `用法: pnpm model:switch <name>             切换当前槽位端点（写当前 .claude/settings.local.json）\n` +
    `      pnpm model:switch --all <name>       切换所有槽位端点（主仓 + 全部 Worktree 槽位）\n` +
    `可用端点: ${snapshots.join(' | ')}`
  );
  process.exit(1);
}


const rootDir = run('git rev-parse --show-toplevel') || process.cwd();
const slotMarkers = loadAgentsConfig(rootDir).mcp.slotUrlMarkers || [];
const slotKeyMap = loadSlotKeys(rootDir);

function switchOneSlot(wtPath, subName) {
  const localPath = path.join(wtPath, '.claude', 'settings.local.json');
  // 优先从本工作区读快照，若无则从主根目录读
  const snapshot = loadSnapshotWithSecrets(wtPath, subName) || loadSnapshotWithSecrets(rootDir, subName);
  if (!snapshot) {
    throw new Error(`快照不存在: .claude/settings.${subName}.json`);
  }

  let local = {};
  if (fs.existsSync(localPath)) {
    try {
      local = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    } catch {}
  }
  const merged = { ...local };
  for (const key of SNAPSHOT_KEYS) {
    if (key in snapshot) {
      merged[key] = typeof snapshot[key] === 'object' && snapshot[key] !== null
        ? { ...snapshot[key] }
        : snapshot[key];
    }
  }

  let boundAccountMsg = '';
  if (slotMarkers.some((m) => snapshot.env?.ANTHROPIC_BASE_URL?.includes(m))) {
    let slotKey = '';
    let accountName = '';
    const accounts = Object.keys(slotKeyMap);
    if (accounts.length > 0) {
      accountName = accounts[Math.floor(Math.random() * accounts.length)];
      slotKey = slotKeyMap[accountName];
    }
    if (slotKey) {
      if (!merged.env) merged.env = {};
      merged.env.ANTHROPIC_AUTH_TOKEN = slotKey;
      boundAccountMsg = `（已绑定工位专属账号 ${accountName || '随机分配'}）`;
    }
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, `${JSON.stringify(merged, null, 2)}\n`);
  return { merged, boundAccountMsg, hasPermissions: !!local.permissions };
}

if (isAll) {
  const worktrees = listWorktrees(rootDir);
  console.log(`[ModelSwitch] ➜ 正在广播切换所有槽位端点至 [${name}]（共 ${worktrees.length} 个工作区）...`);
  for (const wt of worktrees) {
    try {
      const { merged, boundAccountMsg, hasPermissions } = switchOneSlot(wt.path, name);
      const slotLabel = path.relative(path.dirname(rootDir), wt.path) || path.basename(wt.path);
      console.log(
        `  ✓ [${slotLabel}] 已切换到 ${name} ${boundAccountMsg}（baseURL: ${merged.env?.ANTHROPIC_BASE_URL ?? 'N/A'}）` +
          `${hasPermissions ? '，permissions 已保留' : ''}`
      );
    } catch (e) {
      console.error(`  ✗ [${wt.path}] 切换失败: ${e.message}`);
    }
  }
  console.log(`[ModelSwitch] 🎉 所有槽位端点已全量切换至 ${name}！`);
} else {
  const { merged, boundAccountMsg, hasPermissions } = switchOneSlot(process.cwd(), name);
  console.log(
    `[ModelSwitch] ✓ 当前槽位已切换到 ${name} ${boundAccountMsg}（baseURL: ${merged.env?.ANTHROPIC_BASE_URL ?? 'N/A'}）` +
      `${hasPermissions ? '，permissions 已保留' : ''}`
  );
}
