#!/usr/bin/env node
//
// project-sync.js（pnpm project:sync）
//
// 用途：项目层与 Worktree 槽位同构配置同步核心引擎。
//   1. 以主仓 .claude/settings.*.json 端点快照为 SSOT，渲染多 Agent 运行时配置：
//      - Claude Code: .claude/settings.local.json
//      - OpenCode: opencode.jsonc
//      - CodeBuddy / WorkBuddy: .codebuddy/models.json & .workbuddy/models.json
//   2. 项目级 MCP 统一驱动（.mcp.json，档位与启停自 agents.config.json 的 mcp 节校准）
//   3. rules / skills 声明式补链（SSOT: .agents/，根据 AGENTS_REGISTRY 对齐）
//   4. 槽位同构扩散广播：若存在多 Git Worktree 槽位，自动发现并全量扩散配置，
//      并在智谱直连场景下随机分配独立 API Key（防工位并发配额争抢）。
//
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AGENTS_REGISTRY,
  MCP_PROFILES,
  loadMcpState,
  generateMcpJson,
  renderOpenCodeMcp,
} from './agents-registry.js';
import { loadAgentsConfig } from './agents-config.js';

const IS_WIN = process.platform === 'win32';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

function log(msg) {
  console.log(`[ProjectSync] ${msg}`);
}

function resolvesTo(linkPath, targetPath) {
  try {
    const a = fs.realpathSync(linkPath);
    const b = fs.realpathSync(targetPath);
    return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

function ensureLink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let existing = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch {}
  if (existing) {
    if (resolvesTo(linkPath, targetPath)) return;
    if (existing.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      log(`  ⚠ [Link Warning] 目标 ${linkPath} 为真实目录而非软链，跳过覆盖以保护本地数据`);
      return;
    }
  }
  fs.symlinkSync(path.resolve(targetPath), linkPath, IS_WIN ? 'junction' : 'dir');
}

function ensureFileLink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let existing = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch {}
  if (existing) {
    if (resolvesTo(linkPath, targetPath)) return;
    if (existing.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      log(`  ⚠ [Link Warning] 目标 ${linkPath} 为真实文件而非软链，跳过覆盖以保护本地数据`);
      return;
    }
  }
  const relTarget = path.relative(path.dirname(linkPath), targetPath);
  try {
    fs.symlinkSync(relTarget, linkPath, 'file');
  } catch {
    fs.copyFileSync(targetPath, linkPath);
  }
}

// 补链矩阵：根据 AGENTS_REGISTRY 动态生成
const LINK_MAP = {};
for (const [key, agent] of Object.entries(AGENTS_REGISTRY)) {
  if (agent.projectDir && agent.projectLinks?.length > 0) {
    LINK_MAP[agent.projectDir] = agent.projectLinks;
  }
}
// 兼容性声明：若有 .trae 项目目录则补充
LINK_MAP['.trae'] = ['rules', 'skills'];

const KNOWN_AGENT_DIRS = ['.claude', '.codebuddy', '.opencode', '.trae', '.omp', '.workbuddy'];

function cleanupStaleLinks(wtPath) {
  for (const agent of KNOWN_AGENT_DIRS) {
    const keep = LINK_MAP[agent] || [];
    const agentDir = path.join(wtPath, agent);
    let entries;
    try {
      entries = fs.readdirSync(agentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (keep.includes(e.name)) continue;
      const p = path.join(agentDir, e.name);
      let target;
      try {
        target = fs.readlinkSync(p);
      } catch {
        continue;
      }
      const resolved = path.resolve(agentDir, target);
      const rulesSrc = path.join(wtPath, '.agents', 'rules');
      const skillsSrc = path.join(wtPath, '.agents', 'skills');
      if (resolved === rulesSrc || resolved === skillsSrc) {
        fs.rmSync(p, { recursive: true, force: true });
        log(`  ↧ 清理冗余链接 ${agent}/${e.name}（原生读 .agents/ 或死配置）`);
      }
    }
  }
}

// 运行时密钥变量装配：mcp.keys 声明 变量名→订阅快照名；.machine-state.json 的 glmKey 手工覆盖位优先
function buildMcpKeys(cfg, mcpState, subscriptions) {
  const keys = {};
  for (const [varName, subName] of Object.entries(cfg.mcp.keys || {})) {
    keys[varName] = subscriptions.find(s => s.name === subName)?.token || '';
  }
  if (mcpState.glmKey) keys.glmKey = mcpState.glmKey;
  return keys;
}

function shuffleArray(arr) {
  const res = [...arr];
  for (let i = res.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [res[i], res[j]] = [res[j], res[i]];
  }
  return res;
}

function loadGlmKeys(rootDir) {
  // 私仓专属特性：GLM 多订阅账号池。agents.config.json 未声明 glmPool（或置 null）即整体禁用；
  // 池文档缺失/正则无命中同样回落空池，上层自然落回单 Key，不阻断
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

// 订阅接入方式已数据化至 agents.config.json 的 providers 节（npm/headers 缺省
// '@ai-sdk/anthropic' + anthropic-version 头；urlSuffix=OpenCode 端点后缀，cbUrlSuffix=CodeBuddy 覆盖）
const MODEL_LIMITS = {
  'max':                      { context: 1000000, output: 131072 },
  'pro':                      { context: 1000000, output: 128000 },
  'flash':                    { context: 200000,  output: 131072 },
  'glm-5.3':                  { context: 1000000, output: 131072 },
  'glm-5.3-flash':            { context: 1000000, output: 131072 },
  'glm-5.2':                  { context: 1000000, output: 131072 },
  'glm-5.1':                  { context: 1000000, output: 131072 },
  'glm-4.7':                  { context: 200000,  output: 131072 },
  'ark-code-latest':          { context: 1048576, output: 393216 },
  'tc-code-latest':           { context: 1000000, output: 131072 },
  'deepseek-v4-flash':        { context: 1048576, output: 393216 },
  'deepseek-v4-pro':          { context: 1048576, output: 393216 },
  'deepseek-v4-flash-202605': { context: 1048576, output: 393216 },
  'deepseek-v4-pro-202606':   { context: 1048576, output: 393216 },
  'kimi-k3':                  { context: 1048576, output: 393216 },
};
const UNKNOWN_LIMIT = { context: 200000, output: 131072 };

function loadSubscriptions(rootDir) {
  const claudeDir = path.join(rootDir, '.claude');
  const providers = loadAgentsConfig(rootDir).providers || {};
  const subs = [];
  const unknownModels = new Set();
  for (const file of fs.readdirSync(claudeDir)) {
    if (!file.startsWith('settings.') || !file.endsWith('.json')) continue;
    const name = file.slice('settings.'.length, -'.json'.length);
    if (!name || name === 'local' || name.endsWith('.secrets') || name.includes('example')) continue; // .secrets 为个人密钥层非独立订阅
    const providerName = name.replaceAll('.', '-');
    // 拷入即生效：未在 providers 登记的快照按默认接入形状自动纳入分发（消掉「拷了却静默休眠」footgun）；
    // 显式登记可覆盖默认（urlSuffix / cbUrlSuffix / keyPlaceholder / npm / headers）。
    const access = providers[name] || {};
    if (!providers[name]) {
      log(`  ℹ 订阅 [${name}] 未在 providers 登记，按默认接入形状自动纳入（需自定义 urlSuffix/npm/占位符时再登记）`);
    }
    let env;
    try {
      env = JSON.parse(fs.readFileSync(path.join(claudeDir, file), 'utf-8')).env;
      // multi 档双层：tracked 无 key 结构 ⊕ 个人 secrets（settings.<name>.secrets.json 仅 token 字段）；
      // 本仓单层快照模式无 secrets 文件，此处为 no-op
      const secretsPath = path.join(claudeDir, `settings.${name}.secrets.json`);
      if (fs.existsSync(secretsPath)) {
        try {
          const secretsEnv = JSON.parse(fs.readFileSync(secretsPath, 'utf-8')).env;
          if (secretsEnv) env = { ...env, ...secretsEnv };
        } catch (e) {
          log(`  ⚠ 订阅 [${name}] secrets 文件解析失败，忽略：${e.message}`);
        }
      }
    } catch (e) {
      log(`  ⚠ 订阅 [${name}] 快照解析失败，跳过：${e.message}`);
      continue;
    }
    const token = env.ANTHROPIC_AUTH_TOKEN;
    const baseURL = env.ANTHROPIC_BASE_URL;
    if (!token || !baseURL) {
      log(`  ⚠ 订阅 [${name}] 缺 token/baseURL，跳过`);
      continue;
    }

    const stripWin = id => (id || '').replace(/\[1m\]$/i, '');
    const slotKeys = ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
    const models = [];
    for (const k of slotKeys) {
      const id = stripWin(env[k]);
      if (id && !models.some(m => m.id === id)) {
        if (!MODEL_LIMITS[id]) unknownModels.add(id);
        models.push({ id, limit: MODEL_LIMITS[id] || UNKNOWN_LIMIT, known: !!MODEL_LIMITS[id] });
      }
    }
    subs.push({
      name,
      providerName,
      npm: access.npm || '@ai-sdk/anthropic',
      headers: access.headers || { 'anthropic-version': '2023-06-01' },
      // ?? 而非 ||：urlSuffix/cbUrlSuffix 合法值含空串 ''（baseURL 已含版本段时直接复用），falsy 短路会拿不到。
      // 默认 ''：快照 baseURL 是 Claude Code 原样使用的完整端点（多含 /v1），默认不拼接；需拼接时显式登记（如 ark 的 /v3）
      urlSuffix: access.urlSuffix ?? '',
      cbUrlSuffix: access.cbUrlSuffix ?? null,
      keyPlaceholder: access.keyPlaceholder || null,
      token, baseURL, models,
      slots: {
        haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      },
      slotsBase: {
        haiku: stripWin(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
        sonnet: stripWin(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
        opus: stripWin(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
      },
    });
  }
  for (const m of unknownModels) log(`  ⚠ 模型 [${m}] 不在 MODEL_LIMITS 表，limit 用保守默认（请补表）`);
  return subs;
}

function buildLocalFromSnapshot(sub) {
  return {
    hasCompletedOnboarding: true,
    env: {
      ANTHROPIC_AUTH_TOKEN: sub.token,
      ANTHROPIC_BASE_URL: sub.baseURL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: sub.slots.haiku,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sub.slots.sonnet,
      ANTHROPIC_DEFAULT_OPUS_MODEL: sub.slots.opus,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      API_TIMEOUT_MS: '600000',
    },
    model: 'opus',
    effortLevel: 'high',
  };
}

const MCP_FILE_LINKS = ['.trae/mcp.json'];
const STALE_MCP_LINKS = ['.codebuddy/mcp.json', '.omp/mcp.json', '.workbuddy/mcp.json'];

function syncMcpConfigs(wt, state, keys, mcpCfg) {
  const regTotal = Object.keys(MCP_PROFILES[state.profile] || MCP_PROFILES[mcpCfg?.defaultProfile] || {}).length;
  const missing = (mcpCfg?.requiredKeys?.[state.profile] || []).filter((v) => !keys[v]);
  if (missing.length > 0) {
    log(`  ⚠ 档位 [${state.profile}] 缺密钥变量 ${missing.join('/')}（订阅快照与状态文件均未提供），跳过 MCP 同步`);
    return;
  }

  const mcpJsonPath = path.join(wt.path, '.mcp.json');
  const mcpData = generateMcpJson(state, keys);
  const mcpContent = JSON.stringify(mcpData, null, 2) + '\n';
  const oldContent = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, 'utf-8') : '';
  if (oldContent !== mcpContent) {
    fs.writeFileSync(mcpJsonPath, mcpContent, 'utf-8');
  }

  for (const rel of MCP_FILE_LINKS) {
    ensureFileLink(path.join(wt.path, rel), mcpJsonPath);
  }

  for (const rel of STALE_MCP_LINKS) {
    const p = path.join(wt.path, rel);
    try {
      const resolved = path.resolve(path.dirname(p), fs.readlinkSync(p));
      if (resolved === mcpJsonPath) {
        fs.rmSync(p, { force: true });
        log(`  ↧ 清理死链 ${rel}（该工具原生读根 .mcp.json）`);
      }
    } catch {}
  }

  log(`  ✓ MCP 档位 [${state.profile}] 已渲染（启用 ${Object.keys(mcpData.mcpServers).length}/${regTotal}，同源软链就绪）`);
}

function renderOpenCodeProviders(subs) {
  const blocks = [];
  for (const sub of subs) {
    const models = sub.models.map(m =>
      `        "${m.id}": {\n` +
      `          "name": "${m.id} (${sub.name})",\n` +
      `          "limit": {\n            "context": ${m.limit.context},\n            "output": ${m.limit.output}\n          }\n        }`
    ).join(',\n');
    const token = sub.keyPlaceholder ? `{{${sub.keyPlaceholder}}}` : sub.token;
    const url = sub.baseURL.replace(/\/$/, '') + sub.urlSuffix;
    const headers = Object.entries({ Authorization: `Bearer ${token}`, ...sub.headers })
      .map(([k, v]) => `"${k}": "${v}"`).join(',\n            ');
    blocks.push(
      `    // 订阅 ${sub.name}（自动生成自 .claude/settings.${sub.name}.json，勿手改）\n` +
      `    "${sub.providerName}": {\n` +
      `      "npm": "${sub.npm}",\n` +
      `      "name": "${sub.name}",\n` +
      `      "options": {\n` +
      `        "baseURL": "${url}",\n` +
      `        "apiKey": "${token}",\n` +
      `        "headers": {\n            ${headers}\n        }\n` +
      `      },\n` +
      `      "models": {\n${models}\n      }\n` +
      `    }`
    );
  }
  return blocks.join(',\n') + ',\n';
}

function renderCodeBuddyModels(subs) {
  const idCount = new Map();
  for (const sub of subs) for (const m of sub.models) idCount.set(m.id, (idCount.get(m.id) || 0) + 1);
  const entries = [];
  for (const sub of subs) {
    const apiKey = sub.keyPlaceholder ? `{{${sub.keyPlaceholder}}}` : sub.token;
    // ?? 而非 ||：cbUrlSuffix 合法值含空串 ''（baseURL 已含 /v1 时直接复用）
    const url = sub.baseURL.replace(/\/$/, '') + (sub.cbUrlSuffix ?? sub.urlSuffix);
    for (const m of sub.models) {
      const modelId = idCount.get(m.id) > 1 ? `${m.id}@${sub.name}` : m.id;
      entries.push(
        `    {\n` +
        `      "id": "${modelId}",\n` +
        `      "name": "${m.id} (${sub.name})",\n` +
        `      "vendor": "user",\n` +
        `      "url": "${url}",\n` +
        `      "apiKey": "${apiKey}",\n` +
        `      "supportsToolCall": true,\n` +
        `      "supportsImages": false,\n` +
        `    }`
      );
    }
  }
  return entries.join(',\n') + ',\n';
}

function syncOpenCodeConfig(wt, rootDir, subs, glmKey, mcpState, mcpKeys, cfg) {
  const tplPath = path.join(rootDir, 'opencode.template.jsonc');
  const targetPath = path.join(wt.path, 'opencode.jsonc');
  const legacyJson = path.join(wt.path, 'opencode.json');

  if (fs.existsSync(legacyJson)) {
    try { fs.rmSync(legacyJson, { force: true }); } catch {}
  }
  if (!fs.existsSync(tplPath)) return;

  const primary = subs.find(s => s.name === cfg.defaultSubscription) || subs[0];
  if (!primary) return;
  let rendered = fs.readFileSync(tplPath, 'utf-8');
  const vars = {
    '{{SUBSCRIPTION_PROVIDERS}}': renderOpenCodeProviders(subs),
    '{{OPENCODE_MODEL}}': `${primary.providerName}/${primary.slotsBase.sonnet}`,
    '{{OPENCODE_SMALL_MODEL}}': `${primary.providerName}/${primary.slotsBase.haiku}`,
    '{{OPENCODE_SMALL_MODEL_REF}}': `${primary.providerName}/${primary.slotsBase.haiku}`,
    '{{MCP_OPENCODE_BLOCK}}': renderOpenCodeMcp(mcpState, mcpKeys),
  };
  for (const [k, v] of Object.entries(vars)) rendered = rendered.replaceAll(k, v);
  if (glmKey) rendered = rendered.replaceAll('{{GLM_API_KEY}}', glmKey);

  const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : '';
  if (existing !== rendered) fs.writeFileSync(targetPath, rendered, 'utf-8');
  log(`  ✓ OpenCode 配置 opencode.jsonc 已就绪（智谱直连绑定 ${glmKey ? '槽位专属' : '默认'} Key）`);
}

function syncCodeBuddyModels(wt, rootDir, subs, glmKey) {
  const tplPath = path.join(rootDir, '.codebuddy', 'models.template.json');
  const targetPath = path.join(wt.path, '.codebuddy', 'models.json');
  if (!fs.existsSync(tplPath)) return;

  let rendered = fs.readFileSync(tplPath, 'utf-8').replace(/^\s*\/\/.*$/gm, '');
  rendered = rendered.replaceAll('{{SUBSCRIPTION_MODELS}}', renderCodeBuddyModels(subs));
  if (glmKey) rendered = rendered.replaceAll('{{GLM_API_KEY}}', glmKey);
  const jsonOnly = rendered.replace(/,(\s*[}\]])/g, '$1');

  const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : '';
  if (existing !== jsonOnly) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, jsonOnly, 'utf-8');
  }

  const wbPath = path.join(wt.path, '.workbuddy', 'models.json');
  const wbExisting = fs.existsSync(wbPath) ? fs.readFileSync(wbPath, 'utf-8') : '';
  if (wbExisting !== jsonOnly) {
    fs.mkdirSync(path.dirname(wbPath), { recursive: true });
    fs.writeFileSync(wbPath, jsonOnly, 'utf-8');
  }
  log(`  ✓ CodeBuddy/WorkBuddy 模型池 models.json 已就绪（智谱直连绑定 ${glmKey ? '槽位专属' : '默认'} Key）`);
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
    // 非 Git Worktree 环境（普通单仓）
    return [{ path: defaultRoot, branch: 'master' }];
  }
}

function main() {
  const cwd = process.cwd();
  const worktrees = listWorktrees(cwd);
  const rootDir = worktrees.find(w => !w.branch || w.branch === 'master')?.path || worktrees[0].path;

  log(`以主工作区 [${rootDir}] 为母本启动项目层与槽位同构扩散同步...`);

  const cfg = loadAgentsConfig(rootDir);
  const glmKeyMap = loadGlmKeys(rootDir);
  const subscriptions = loadSubscriptions(rootDir);
  const hasSubs = subscriptions.length > 0;
  if (hasSubs) {
    log(`订阅快照解析：${subscriptions.map(s => s.name).join(', ')}`);
  } else {
    log('⚠ 未解析到任何订阅快照（settings.*.json），降级为仅补链模式（多人库照 *.example 建快照后重跑）');
  }

  const mcpState = loadMcpState(rootDir);
  const mcpKeys = buildMcpKeys(cfg, mcpState, subscriptions);
  log(`MCP 档位：${mcpState.profile}（禁用：${mcpState.disabled.join('/') || '无'}）`);

  log(`检测到 ${worktrees.length} 个工作区槽位:`);
  for (const wt of worktrees) log(`  - ${wt.path}${wt.branch ? ` (${wt.branch})` : ''}`);
  console.log('');

  const availableAccounts = shuffleArray(Object.keys(glmKeyMap));
  if (availableAccounts.length === 0) {
    log('⚠ 智谱 GLM 账号池为空，跳过槽位专属 Key 注入');
  }

  for (let i = 0; i < worktrees.length; i++) {
    const wt = worktrees[i];
    log(`➜ 正在补链与广播配置: ${wt.path}`);
    const agentsRoot = path.join(wt.path, '.agents');
    if (!fs.existsSync(path.join(agentsRoot, 'rules')) && !fs.existsSync(path.join(agentsRoot, 'skills'))) {
      log('  ⚠ 缺少 .agents/ SSOT（rules/skills），跳过本槽位，先完成基线同步');
      continue;
    }

    for (const [dir, subs] of Object.entries(LINK_MAP)) {
      for (const sub of subs) {
        if (!fs.existsSync(path.join(agentsRoot, sub))) continue; // 该 SSOT 子目录缺失（如新项目无 rules）则跳过其链接
        ensureLink(path.join(wt.path, dir, sub), path.join(agentsRoot, sub));
      }
    }
    cleanupStaleLinks(wt.path);
    log('  ✓ rules/skills 链接已就绪');
    if (!hasSubs) {
      log('  ⚠ 无订阅快照，跳过本槽位配置渲染（仅补链）');
      continue;
    }

    const accountName = availableAccounts.length > 0
      ? availableAccounts[i % availableAccounts.length]
      : '';
    const slotGlmKey = accountName ? glmKeyMap[accountName] : '';

    syncMcpConfigs(wt, mcpState, mcpKeys, cfg.mcp);

    const localSettings = path.join(wt.path, '.claude', 'settings.local.json');
    const snapshotByName = Object.fromEntries(subscriptions.map(s => [s.name, s]));
    try {
      let localCfg = fs.existsSync(localSettings)
        ? JSON.parse(fs.readFileSync(localSettings, 'utf-8'))
        : null;
      if (!localCfg) {
        const defaultSub = snapshotByName[cfg.defaultSubscription];
        if (defaultSub) {
          localCfg = buildLocalFromSnapshot(defaultSub);
          fs.mkdirSync(path.dirname(localSettings), { recursive: true });
          fs.writeFileSync(localSettings, JSON.stringify(localCfg, null, 2) + '\n', 'utf-8');
          log(`  ✓ settings.local.json 缺失，已从默认订阅 [${cfg.defaultSubscription}] 快照自愈生成`);
        }
      } else {
        const currentUrl = localCfg.env?.ANTHROPIC_BASE_URL || '';
        const matched = currentUrl
          ? subscriptions.find(s => currentUrl.startsWith(s.baseURL.replace(/\/$/, '')))
          : null;
        const glmSubName = cfg.mcp.keys?.glmKey || '';
        const glmMarkers = cfg.mcp.glmUrlMarkers || [];
        if ((matched && matched.name === glmSubName) || (!matched && glmMarkers.some((m) => currentUrl.includes(m)))) {
          if (slotGlmKey && localCfg.env?.ANTHROPIC_AUTH_TOKEN !== slotGlmKey) {
            localCfg.env.ANTHROPIC_AUTH_TOKEN = slotGlmKey;
            fs.writeFileSync(localSettings, JSON.stringify(localCfg, null, 2) + '\n', 'utf-8');
            log(`  ✓ settings.local.json 已校准为槽位专属 GLM Key（绑定账号 ${accountName}）`);
          }
        } else if (matched || currentUrl === '') {
          const sub = matched || snapshotByName[cfg.defaultSubscription];
          const freshEnv = buildLocalFromSnapshot(sub).env;
          if (JSON.stringify(localCfg.env) !== JSON.stringify(freshEnv)) {
            localCfg.env = freshEnv;
            fs.writeFileSync(localSettings, JSON.stringify(localCfg, null, 2) + '\n', 'utf-8');
            log(`  ✓ settings.local.json env 块已刷新对齐 ${sub.name} 快照（本地 permissions 保留）`);
          }
        }
      }
    } catch (e) {
      log(`  ⚠ settings.local.json 校准解析跳过：${e.message}`);
    }

    const cbLocalSettings = path.join(wt.path, '.codebuddy', 'settings.local.json');
    const regNames = Object.keys(MCP_PROFILES[mcpState.profile]);
    let cbLocal = { enabledMcpjsonServers: [], disabledMcpjsonServers: [] };
    if (fs.existsSync(cbLocalSettings)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cbLocalSettings, 'utf-8'));
        cbLocal = {
          ...parsed,
          enabledMcpjsonServers: Array.isArray(parsed.enabledMcpjsonServers) ? parsed.enabledMcpjsonServers : [],
          disabledMcpjsonServers: Array.isArray(parsed.disabledMcpjsonServers) ? parsed.disabledMcpjsonServers : [],
        };
      } catch (e) {
        log(`  ⚠ CodeBuddy settings.local.json 解析失败，重建启停清单：${e.message}`);
      }
    }
    const regEnabled = regNames.filter(n => !mcpState.disabled.includes(n));
    const regDisabled = mcpState.disabled.filter(n => regNames.includes(n));
    const newEnabled = [...cbLocal.enabledMcpjsonServers.filter(n => !regNames.includes(n)), ...regEnabled];
    const newDisabled = [...cbLocal.disabledMcpjsonServers.filter(n => !regNames.includes(n)), ...regDisabled];
    if (JSON.stringify(cbLocal.enabledMcpjsonServers) !== JSON.stringify(newEnabled) ||
        JSON.stringify(cbLocal.disabledMcpjsonServers) !== JSON.stringify(newDisabled)) {
      cbLocal.enabledMcpjsonServers = newEnabled;
      cbLocal.disabledMcpjsonServers = newDisabled;
      fs.mkdirSync(path.dirname(cbLocalSettings), { recursive: true });
      fs.writeFileSync(cbLocalSettings, JSON.stringify(cbLocal, null, 2) + '\n');
      log(`  ✓ CodeBuddy MCP 启停清单已校准（enabled: ${newEnabled.join('/') || '无'}；disabled: ${newDisabled.join('/') || '无'}）`);
    }

    const ccSettings = path.join(wt.path, '.claude', 'settings.json');
    try {
      const ccCfg = JSON.parse(fs.readFileSync(ccSettings, 'utf-8'));
      if (JSON.stringify(ccCfg.disabledMcpjsonServers || []) !== JSON.stringify(regDisabled)) {
        ccCfg.disabledMcpjsonServers = regDisabled;
        fs.writeFileSync(ccSettings, JSON.stringify(ccCfg, null, 2) + '\n');
        log(`  ✓ Claude Code disabledMcpjsonServers 已对齐（${regDisabled.join('/') || '空'}）`);
      }
    } catch (e) {
      log(`  ⚠ Claude Code settings.json 校准跳过：${e.message}`);
    }

    syncOpenCodeConfig(wt, rootDir, subscriptions, slotGlmKey, mcpState, mcpKeys, cfg);
    syncCodeBuddyModels(wt, rootDir, subscriptions, slotGlmKey);
  }

  console.log('');
  log('🎉 所有项目工作区与 Worktree 槽位的 Agent 链接与同构配置已全量补齐！');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`[ProjectSync Error] ${err.message}`);
    process.exit(1);
  }
}

export {
  main,
  listWorktrees,
  loadSubscriptions,
  loadGlmKeys,
  syncMcpConfigs,
  MCP_PROFILES,
  loadMcpState,
};
