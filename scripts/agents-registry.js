#!/usr/bin/env node
//
// agents-registry.js
//
// 声明式 Agent 适配器与配置注册表（SSOT）：
//   1. AGENTS_REGISTRY: 各 Agent 的全局 Prompt / 全局 MCP / 项目级软链与配置映射
//   2. MCP_PROFILES: 项目级 MCP 档位注册表（数据驱动，自 agents.config.json 的 mcp.profiles 构建）
//   4. MCP 状态与数据转换标准流水线
//
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadAgentsConfig } from './agents-config.js';

const HOME_DIR = os.homedir();

// 仓库个性化参数（SSOT：agents.config.json，缺省回落内置默认 = 本仓历史硬编码值；
// 各 worktree 槽位 checkout 的配置内容一致，模块级按 cwd 加载即可）
const MCP_CFG = loadAgentsConfig(process.cwd()).mcp;

// ============ 1. 声明式 Agent 适配器矩阵 ============
export const AGENTS_REGISTRY = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    // 全局 Prompt 路径与转换（纯 Markdown）
    getGlobalPromptPath: (home = HOME_DIR) => path.join(home, '.claude', 'CLAUDE.md'),
    renderGlobalPrompt: (raw) => raw,
    // 全局 MCP 路径与类型（顶层 mcpServers 键，注册即启用）
    getGlobalMcpPath: (home = HOME_DIR) => path.join(home, '.claude.json'),
    globalMcpFormat: 'top-level-mcpServers',
    // 项目级目录与软链需求
    projectDir: '.claude',
    projectLinks: ['rules', 'skills'],
    linkStrategy: 'symlink',
  },
  agy: {
    id: 'agy',
    name: 'Antigravity (AGY)',
    // 全局 Prompt 路径（~/.gemini/GEMINI.md）
    getGlobalPromptPath: (home = HOME_DIR) => path.join(home, '.gemini', 'GEMINI.md'),
    renderGlobalPrompt: (raw) => raw,
    // 全局 MCP 路径（~/.gemini/config/mcp_config.json）
    getGlobalMcpPath: (home = HOME_DIR) => path.join(home, '.gemini', 'config', 'mcp_config.json'),
    globalMcpFormat: 'mcpServers-serverUrl',
    // 项目级原生感知 .agents/rules 和 .agents/skills，无需软链
    projectDir: null,
    projectLinks: [],
    linkStrategy: 'native',
  },
  codebuddy: {
    id: 'codebuddy',
    name: 'CodeBuddy',
    // 全局 Prompt 需 YAML Frontmatter 头（MDC 规范）
    getGlobalPromptPath: (home = HOME_DIR) => path.join(home, '.codebuddy', 'rules', 'Global.mdc'),
    renderGlobalPrompt: (raw) => {
      const now = new Date().toISOString();
      return `---
description: 全局 AI 协作规范 (Shawn/CTO)
alwaysApply: true
enabled: true
updatedAt: ${now}
---

${raw}`;
    },
    // 全局 MCP 路径与类型（mcp.json，每个条目有 disabled 布尔值）
    getGlobalMcpPath: (home = HOME_DIR) => path.join(home, '.codebuddy', 'mcp.json'),
    globalMcpFormat: 'mcpServers-disabled-bool',
    // 项目级软链需求
    projectDir: '.codebuddy',
    projectLinks: ['rules', 'skills'],
    linkStrategy: 'symlink',
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    // 全局 Prompt 路径（~/.config/opencode/AGENTS.md）
    getGlobalPromptPath: (home = HOME_DIR) => path.join(home, '.config', 'opencode', 'AGENTS.md'),
    renderGlobalPrompt: (raw) => raw,
    // 全局 MCP 路径与类型（opencode.jsonc 的 mcp 键，enabled 布尔值，http=remote / stdio=local）
    getGlobalMcpPath: (home = HOME_DIR) => path.join(home, '.config', 'opencode', 'opencode.jsonc'),
    globalMcpFormat: 'opencode-mcp-enabled-bool',
    // 项目级：原生感知 .agents/skills，rules 经 instructions 注入，死配置不建链
    projectDir: '.opencode',
    projectLinks: [],
    linkStrategy: 'native-skills-only',
  },
  pi: {
    id: 'pi',
    name: 'Pi',
    // 全局 Prompt 路径（~/.pi/agent/AGENTS.md）
    getGlobalPromptPath: (home = HOME_DIR) => path.join(home, '.pi', 'agent', 'AGENTS.md'),
    renderGlobalPrompt: (raw) => raw,
    // 全局 MCP 路径与类型（~/.pi/agent/mcp.json，经 pi-mcp-adapter 驱动，支持 disabled 布尔值）
    getGlobalMcpPath: (home = HOME_DIR) => path.join(home, '.pi', 'agent', 'mcp.json'),
    globalMcpFormat: 'mcpServers-disabled-bool',
    // 项目级：原生感知 .agents/skills（cwd 至 git 根向上），经 pi-mcp-adapter 原生读取根目录 .mcp.json，无需软链
    projectDir: null,
    projectLinks: [],
    linkStrategy: 'native-skills-only',
  },
};

// ============ 2. 项目级 MCP 档位注册表（数据驱动：agents.config.json 的 mcp.profiles） ============
// 形状与旧硬编码版一致：profile → { server: (keys) => serverCfg }，mcp-manage 等枚举方零改动。
// server 定义支持 ${var} 插值，变量域 = mcp 配置节（网关地址等）+ 运行时密钥（mcp.keys 声明的变量名，如 mainToken 等）。
function interpolate(tpl, vars) {
  return tpl.replace(/\$\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function buildProfilesFromConfig(mcpCfg) {
  const profiles = {};
  for (const [profileName, servers] of Object.entries(mcpCfg.profiles || {})) {
    const factories = {};
    for (const [serverName, def] of Object.entries(servers)) {
      factories[serverName] = (keys) => {
        const vars = { ...mcpCfg, ...keys };
        if (def.type === 'stdio') {
          const cfg = { type: 'stdio', command: def.command, args: (def.args || []).map((a) => interpolate(a, vars)) };
          if (def.env) cfg.env = Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, interpolate(v, vars)]));
          return cfg;
        }
        const cfg = { type: 'http', url: interpolate(def.url, vars) };
        if (def.token) cfg.headers = { Authorization: `Bearer ${interpolate(def.token, vars)}` };
        return cfg;
      };
    }
    profiles[profileName] = factories;
  }
  return profiles;
}

export const MCP_PROFILES = buildProfilesFromConfig(MCP_CFG);
const FALLBACK_PROFILE = MCP_CFG.defaultProfile && MCP_PROFILES[MCP_CFG.defaultProfile]
  ? MCP_CFG.defaultProfile
  : Object.keys(MCP_PROFILES)[0];

// ============ 4. 机器状态加载与数据转换 ============
// 机器级状态文件（gitignored，本机概念）：MCP 档位/启停 + Claude 全局模型端点，随网络位置走。
// 2026-09-12 由 .mcp-state.json 更名——原名只涵盖 MCP，却已容纳模型端点，名实不符。
// 读取兼容旧名、写入落新名并清理旧文件：下游未同步迁移也能用，toolkit-update 后自然收敛。
export const STATE_FILE = '.machine-state.json';
export const LEGACY_STATE_FILE = '.mcp-state.json';

function readMachineStateRaw(rootDir) {
  for (const f of [STATE_FILE, LEGACY_STATE_FILE]) {
    const p = path.join(rootDir, f);
    if (!fs.existsSync(p)) continue;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

// 写新名并清理旧名残留（迁移）。两处写入口（mcp-manage / model-switch --global）共用，防路径漂移
export function writeMachineState(rootDir, state) {
  fs.writeFileSync(path.join(rootDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  const legacy = path.join(rootDir, LEGACY_STATE_FILE);
  if (fs.existsSync(legacy)) fs.rmSync(legacy, { force: true });
}

export function loadMcpState(rootDir) {
  // 全局层不随 toolkit 分发：globalDisabled 恒为空（仅本仓 mcp-manage 消费）
  const globalDisabledDefault = [];
  const s = readMachineStateRaw(rootDir);
  if (!s) {
    return { profile: FALLBACK_PROFILE, disabled: MCP_CFG.defaultDisabled || [], glmKey: '', globalDisabled: globalDisabledDefault };
  }
  return {
    profile: MCP_PROFILES[s.profile] ? s.profile : FALLBACK_PROFILE,
    disabled: Array.isArray(s.disabled) ? s.disabled : (MCP_CFG.defaultDisabled || []),
    glmKey: typeof s.glmKey === 'string' ? s.glmKey : '',
    globalDisabled: Array.isArray(s.globalDisabled) ? s.globalDisabled : globalDisabledDefault,
  };
}

export function resolveMcpServers(state, keys) {
  const profile = MCP_PROFILES[state.profile] || MCP_PROFILES[FALLBACK_PROFILE] || {};
  const servers = {};
  for (const [name, make] of Object.entries(profile)) {
    if (state.disabled.includes(name)) continue;
    servers[name] = make(keys);
  }
  return servers;
}

export function generateMcpJson(state, keys) {
  return { mcpServers: resolveMcpServers(state, keys) };
}

export function renderOpenCodeMcp(state, keys) {
  const servers = resolveMcpServers(state, keys);
  const blocks = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.type === 'stdio') {
      const envLines = Object.entries(cfg.env || {}).map(([k, v]) => `"${k}": "${v}"`).join(',\n            ');
      blocks.push(
        `"${name}": {\n` +
        `            "type": "local",\n` +
        `            "command": [${[cfg.command, ...(cfg.args || [])].map(x => `"${x}"`).join(', ')}],\n` +
        `            "environment": {\n` +
        `              ${envLines}\n` +
        `            }\n` +
        `          }`
      );
    } else if (cfg.type === 'http') {
      const headerLines = Object.entries(cfg.headers || {}).map(([k, v]) => `"${k}": "${v}"`).join(',\n            ');
      blocks.push(
        `"${name}": {\n` +
        `            "type": "remote",\n` +
        `            "url": "${cfg.url}",\n` +
        `            "headers": {\n` +
        `              ${headerLines}\n` +
        `            }\n` +
        `          }`
      );
    }
  }
  return blocks.length ? blocks.join(',\n          ') + ',' : '';
}
