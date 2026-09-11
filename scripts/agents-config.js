#!/usr/bin/env node
//
// agents-config.js
//
// 仓库个性化参数装载器（SSOT：仓库根 agents.config.json，tracked）。
//   - 不存在/损坏时回落内置默认（默认 = 本仓历史硬编码值，保证配置文件落地前的基线漂移期零回归）
//   - 可选特性语义：config 中无键（或显式置 null）即整体禁用——公开/多人库模板不带 glmPool 即不启用
//   - 深合并：config 可只覆盖个别键，未覆盖键沿用默认；数组整体替换不逐元素合并
//
import fs from 'node:fs';
import path from 'node:path';

// toolkit-build:defaults-begin（中性默认，构建注入）
export const DEFAULT_AGENTS_CONFIG = {
  "mcp": {
    "defaultProfile": "",
    "defaultDisabled": [],
    "keys": {},
    "requiredKeys": {},
    "glmUrlMarkers": [],
    "profiles": {}
  },
  "defaultSubscription": "",
  "providers": {},
  "glmPool": null,
  "worktree": {
    "dirPrefix": {},
    "residentSlots": [],
    "collectPaths": [
      ".claude"
    ],
    "collectSuffix": ".json",
    "mergeHints": [],
    "mainBranch": "master"
  },
  "updates": {
    "autoUpdate": true,
    "sourceUrl": "https://raw.githubusercontent.com/haitau/agent-toolkit/main"
  }
};

// toolkit-build:defaults-end

function deepMerge(base, override) {
  const baseObj = base !== null && typeof base === 'object' && !Array.isArray(base);
  const overObj = override !== null && typeof override === 'object' && !Array.isArray(override);
  if (!baseObj || !overObj) return override === undefined ? base : override;
  const out = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = k in base ? deepMerge(base[k], override[k]) : override[k];
  }
  return out;
}

export function loadAgentsConfig(rootDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir, 'agents.config.json'), 'utf-8'));
    return deepMerge(DEFAULT_AGENTS_CONFIG, raw);
  } catch {
    return DEFAULT_AGENTS_CONFIG;
  }
}
