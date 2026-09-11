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
import { execSync } from 'node:child_process';
import { loadAgentsConfig } from './agents-config.js';

const SNAPSHOT_KEYS = ['env', 'model', 'effortLevel', 'hasCompletedOnboarding'];


function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function loadGlmKeys(rootDir) {
  // 私仓专属特性：GLM 多订阅账号池。agents.config.json 未声明 glmPool（或置 null）即整体禁用；
  // 池文档缺失/正则无命中同样回落空池，上层自然落回单 Key，不阻断（与 project-sync.js 保持同构）
  const pool = loadAgentsConfig(rootDir).glmPool;
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
function loadSnapshotWithSecrets(name) {
  const base = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.claude', `settings.${name}.json`), 'utf-8'));
  const secretsPath = path.join(process.cwd(), '.claude', `settings.${name}.secrets.json`);
  if (fs.existsSync(secretsPath)) {
    const secretsEnv = JSON.parse(fs.readFileSync(secretsPath, 'utf-8')).env;
    if (secretsEnv) base.env = { ...(base.env || {}), ...secretsEnv };
  }
  return base;
}

const name = process.argv[2];
if (!name) {
  const snapshots = fs
    .readdirSync(path.join(process.cwd(), '.claude'))
    .filter((f) => /^settings\..+\.json$/.test(f) && !f.includes('example'))
    .map((f) => f.replace(/^settings\./, '').replace(/\.json$/, ''));
  console.error(`用法: pnpm model:switch <name>\n可用端点: ${snapshots.join(' | ')}`);
  process.exit(1);
}

const snapshotPath = path.join(process.cwd(), '.claude', `settings.${name}.json`);
if (!fs.existsSync(snapshotPath)) {
  console.error(`[ModelSwitch Error] 快照不存在: .claude/settings.${name}.json`);
  process.exit(1);
}

const localPath = path.join(process.cwd(), '.claude', 'settings.local.json');
const snapshot = loadSnapshotWithSecrets(name);

// 基线 = 现有 local（保留 permissions 等）或空对象；快照键覆盖，其余本机键保留
let local = {};
if (fs.existsSync(localPath)) {
  local = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
}
const merged = { ...local };
for (const key of SNAPSHOT_KEYS) {
  if (key in snapshot) {
    merged[key] = typeof snapshot[key] === 'object' && snapshot[key] !== null
      ? { ...snapshot[key] }
      : snapshot[key];
  }
}

// 槽位专属 GLM API Key 动态感知注入（对齐 MCP 架构，隔离各工位配额）；
// 触发标记与账号池路径均来自 agents.config.json，无标记/无池键即整体回落单 Key
let boundAccountMsg = '';
const rootDir = run('git rev-parse --show-toplevel') || process.cwd();
const glmMarkers = loadAgentsConfig(rootDir).mcp.glmUrlMarkers || [];
if (glmMarkers.some((m) => snapshot.env?.ANTHROPIC_BASE_URL?.includes(m))) {
  const glmKeyMap = loadGlmKeys(rootDir);

  // .mcp.json 不持有 GLM Key，槽位 Key 直接从账号池随机选取（池来自 agents.config.json glmPool）
  let slotKey = '';
  let accountName = '';
  const accounts = Object.keys(glmKeyMap);
  if (accounts.length > 0) {
    accountName = accounts[Math.floor(Math.random() * accounts.length)];
    slotKey = glmKeyMap[accountName];
  }

  if (slotKey) {
    if (!merged.env) merged.env = {};
    merged.env.ANTHROPIC_AUTH_TOKEN = slotKey;
    boundAccountMsg = `（已绑定工位专属账号 ${accountName || '随机分配'}）`;
  }
}

fs.writeFileSync(localPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(
  `[ModelSwitch] ✓ 已切换到 ${name} ${boundAccountMsg}（baseURL: ${merged.env?.ANTHROPIC_BASE_URL ?? 'N/A'}）` +
    `${local.permissions ? '，permissions 已保留' : ''}`
);
