#!/usr/bin/env node
//
// toolkit-update.js — agent-toolkit 下游升级引擎（运行于目标项目 scripts/agent/ 内）
//
// 用法：
//   node scripts/agent/toolkit-update.js               # 手动升级：检查远程版本并执行
//   node scripts/agent/toolkit-update.js --post-merge  # git post-merge hook 调用（档 B 全自动）
//
// 档 B 语义：
//   - 读 agents.config.json 的 toolkitVersion 与 updates 段（autoUpdate / sourceUrl）
//   - 取远程 VERSION（手动 30s×3 / post-merge 8s×2，容忍高延迟抖动网络；post-merge 失败静默 exit 0——不打扰离线/内网隔离的同事）
//   - 远程更新且工作区干净 → 自动覆盖 scripts/agent/ 引擎与 skill 本体；agents.config.json
//     键级合并：用户已填值保留、新键补默认、废弃键经 defaults-snapshot 比对后移除（定制过的保留并提示）
//   - 脏区 / autoUpdate 关闭 → 退回提示；sourceUrl 支持本地目录（内网镜像 / file 挂载）
//
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'agents.config.json');
const SNAPSHOT_PATH = path.join(ROOT, '.agent-toolkit.defaults-snapshot.json');
const SNAPSHOT_GITIGNORE_LINE = '.agent-toolkit.defaults-snapshot.json';

const ENGINE_FILES = [
  'agents-config.js', 'agents-registry.js', 'project-sync.js',
  'worktree-init.js', 'worktree-sync.js', 'model-switch.js',
  'skills-update.js', 'toolkit-update.js',
];
const POST_MERGE_HOOK = [
  '#!/bin/sh',
  '# agent-toolkit post-merge 自动升级（档 B）：离线/脏区自动退提示，不打扰',
  'exec node scripts/agent/toolkit-update.js --post-merge',
  '',
].join('\n');

function log(msg) { console.log(`[agent-toolkit] ${msg}`); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

// ---- 纯函数（导出供单元验证） ----

// 'YYYYMMDD.N' 比较：-1 落后 / 0 相同或不可比 / 1 领先
export function compareVersions(local, remote) {
  const pa = String(local || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(remote || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 2; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

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

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}
function deepEqual(a, b) { return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b)); }
function getPath(obj, keys) {
  return keys.reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
}
function delPath(obj, keys) {
  const parent = keys.slice(0, -1).reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
  if (parent && parent[keys[keys.length - 1]] !== undefined) delete parent[keys[keys.length - 1]];
}

// 键级合并：defaults 为底、用户值覆盖（深合并）；新增键补默认；废弃键（旧默认有、新默认无）
// 仅当用户值 === 旧默认（未定制）才移除，定制过的保留并在 keptCustom 中提示
export function mergeConfig(userCfg, newDefaults, oldDefaults) {
  const added = [], removed = [], keptCustom = [];
  const merged = deepMerge(newDefaults, userCfg);

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // 新增键：旧默认有则不算新增（仅下钻）；无旧默认时退化为"用户未显式设置"口径
  const walkAdd = (nd, uc, od, prefix) => {
    for (const k of Object.keys(nd || {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (od && k in od) {
        if (isObj(nd[k]) && isObj(od[k])) walkAdd(nd[k], uc?.[k], od[k], p);
      } else if (uc && k in uc) {
        if (isObj(nd[k])) walkAdd(nd[k], uc[k], null, p);
      } else {
        added.push(p);
      }
    }
  };
  walkAdd(newDefaults, userCfg, oldDefaults, '');

  // 废弃键：配置中已不存在（未定制即未携带）或值仍等于旧默认 → 移除；被定制 → 保留提示
  const walkRemove = (od, nd, prefix) => {
    for (const k of Object.keys(od || {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!nd || !(k in nd)) {
        const val = getPath(merged, p.split('.'));
        if (val === undefined || deepEqual(val, od[k])) {
          delPath(merged, p.split('.'));
          removed.push(p);
        } else {
          keptCustom.push(p);
        }
      } else if (isObj(od[k]) && isObj(nd[k])) {
        walkRemove(od[k], nd[k], p);
      }
    }
  };
  if (oldDefaults) walkRemove(oldDefaults, newDefaults, '');

  return { merged, added, removed, keptCustom };
}

// ---- 配置序列化：与 templates/*.json 的既有手写风格对齐 ----
// 背景：模板里小对象/短数组是内联写的（如 `"keys": { "token": "x" }`），而旧版升级器一律用
// JSON.stringify(x, null, 2) 全展开 → 每次升级把宿主文件重排一遍（真实反馈的样式 churn）。
// 规则：纯量且单行不超阈值的 object/array 保持内联，其余展开；写盘前做往返语义校验，不一致即 die。
const INLINE_MAX = 80;

function stringifyJsonStyled(value, indent = 2) {
  const pad = (n) => ' '.repeat(n);
  const isScalar = (v) => v === null || typeof v !== 'object';
  // 递归尝试整段内联（模板里存在「一层嵌套也内联」的写法，如 profiles.<name>.<server> 全在一行）
  const renderInline = (v) => {
    if (isScalar(v)) return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const parts = v.map(renderInline);
      return parts.some((p) => p === null) ? null : `[${parts.join(', ')}]`;
    }
    const entries = Object.entries(v);
    if (entries.length === 0) return '{}';
    const parts = entries.map(([k, x]) => {
      const r = renderInline(x);
      return r === null ? null : `${JSON.stringify(k)}: ${r}`;
    });
    return parts.some((p) => p === null) ? null : `{ ${parts.join(', ')} }`;
  };
  const tryInline = (v) => {
    if (isScalar(v)) return JSON.stringify(v);
    const r = renderInline(v);
    return r !== null && r.length <= INLINE_MAX ? r : null;
  };
  const walk = (v, depth) => {
    const oneLine = tryInline(v);
    if (oneLine !== null) return oneLine;
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return `[\n${v.map((x) => pad((depth + 1) * indent) + walk(x, depth + 1)).join(',\n')}\n${pad(depth * indent)}]`;
    }
    const entries = Object.entries(v);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([k, x]) => `${pad((depth + 1) * indent)}${JSON.stringify(k)}: ${walk(x, depth + 1)}`).join(',\n')}\n${pad(depth * indent)}}`;
  };
  return walk(value, 0);
}

// 写盘用的安全版：往返解析必须与原对象语义一致，否则宁可 die 也不落盘损坏配置
function writeJsonStyled(p, obj) {
  const text = `${stringifyJsonStyled(obj)}\n`;
  const back = JSON.parse(text);
  if (JSON.stringify(sortKeys(back)) !== JSON.stringify(sortKeys(obj))) {
    throw new Error(`配置序列化往返校验失败（${path.relative(ROOT, p)}）——已中止写入以免损坏配置`);
  }
  fs.writeFileSync(p, text, 'utf-8');
}

// 键顺序沿用原文件：已存在的键保持原位，新键追加末尾（避免 $comment 等用户键被挪位产生无意义 diff）
export function orderLikePrevious(prev, merged) {
  if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return merged;
  const out = {};
  for (const k of Object.keys(prev)) if (k in merged) out[k] = merged[k];
  for (const k of Object.keys(merged)) if (!(k in out)) out[k] = merged[k];
  return out;
}

// ---- IO 与执行 ----

// 网络策略：跨境访问 raw.githubusercontent.com 的 RT 抖动极大（实测 1s ~ 16s+），原 3s 单次超时几乎必失败。
// 手动升级可等 → 给足预算；post-merge 须快速返回不阻塞 git pull → 短预算少重试（失败静默跳过，可事后手动补跑）。
const NET_POLICY = process.argv.includes('--post-merge')
  ? { timeoutMs: 8000, retries: 1 }
  : { timeoutMs: 30000, retries: 2 };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchOnce(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), NET_POLICY.timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function readRemote(sourceUrl, rel) {
  if (/^https?:/.test(sourceUrl)) {
    const url = `${sourceUrl}/${rel}`;
    let lastErr;
    for (let attempt = 0; attempt <= NET_POLICY.retries; attempt++) {
      try {
        return await fetchOnce(url);
      } catch (e) {
        lastErr = e;
        if (attempt < NET_POLICY.retries) await sleep(600 * 2 ** attempt); // 指数退避 600ms / 1200ms
      }
    }
    throw lastErr;
  }
  // 本地目录模式（内网镜像 / 离线环境 / 源码直测）
  return fs.readFileSync(path.join(sourceUrl, rel), 'utf-8');
}

function gitDirty() {
  try {
    return execSync('git status --porcelain', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

// post-merge 自愈 hook 安装：**绝不夺权**其它 hooks 管理器（husky 等）。
// 夺 core.hooksPath 会让宿主的 pre-commit / pre-push（lint-staged、smoke 等）静默失效——本函数旧版正是此坑。
// 分派规则：
//   A. 未设置 hooksPath           → 用本工具目录 .githooks 并接管（默认态，安全）
//   B. hooksPath = .githooks      → 直接写入（可能是我们，也可能是宿主自己的选择；不改配置）
//   C. husky（.husky/_）          → 写 <root>/.husky/post-merge（husky 的 _ 目录会 source 它），配置一律不动
//   D. 其它既有 hooksPath         → 写入该目录，但若已有非本工具生成的 post-merge 则跳过并提示
// 迁移自愈：曾被旧版夺权（hooksPath=.githooks）而宿主装有 husky 时，还原 hooksPath 并改用 husky 入口。
function ensurePostMergeHook() {
  let cur = '';
  try { cur = execSync('git config core.hooksPath', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch {}
  const norm = cur.replace(/\/+$/, '');
  const huskyEntry = path.join(ROOT, '.husky');

  // 迁移：旧版夺权留下的 .githooks + 宿主本有 husky → 还原宿主，改走 husky 入口
  if (norm === '.githooks' && fs.existsSync(path.join(huskyEntry, '_'))) {
    const stray = fs.readdirSync(path.join(ROOT, '.githooks')).filter((f) => f !== 'post-merge');
    if (stray.length === 0) {
      try { execSync('git config core.hooksPath .husky/_', { stdio: ['pipe', 'pipe', 'pipe'] }); } catch {}
      log('⚠ 检测到旧版曾接管 core.hooksPath（宿主有 husky）→ 已还原为 .husky/_，post-merge 改写入 .husky/');
      cur = '.husky/_';
    } else {
      log(`⚠ core.hooksPath=.githooks 且该目录含非本工具文件（${stray.join(', ')}）→ 保持现状，仅写 post-merge`);
    }
  }

  const norm2 = cur.replace(/\/+$/, '');
  let targetDir;
  let takeover = false;
  if (!norm2) {
    targetDir = path.join(ROOT, '.githooks');
    takeover = true;
  } else if (norm2 === '.githooks') {
    targetDir = path.join(ROOT, '.githooks');
  } else if (norm2 === '.husky/_' || norm2 === '.husky') {
    targetDir = huskyEntry;  // husky 的 _ 生成目录会 source .husky/<hook>
  } else {
    targetDir = path.resolve(ROOT, norm2);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const hookPath = path.join(targetDir, 'post-merge');
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (!existing.includes('toolkit-update.js')) {
      log(`⚠ ${path.relative(ROOT, hookPath)} 已存在且非本工具生成 → 跳过写入（如需自动升级请手工加入 exec node scripts/agent/toolkit-update.js --post-merge）`);
      return null;
    }
  }
  fs.writeFileSync(hookPath, POST_MERGE_HOOK, 'utf-8');
  fs.chmodSync(hookPath, 0o755);
  if (takeover) {
    try { execSync('git config core.hooksPath .githooks', { stdio: ['pipe', 'pipe', 'pipe'] }); } catch {}
  }
  return path.relative(ROOT, hookPath);
}

// 仅在内容变化时落盘：避免无谓的 mtime churn（技能包内副本每次都被重写会让宿主 git 状态抖动）
function writeIfChanged(p, content) {
  try {
    if (fs.readFileSync(p, 'utf-8') === content) return false;
  } catch {}
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return true;
}

// 技能包内副本清单：以远端 install.mjs 的 MANIFEST 为唯一真相源（随版本分发，杜绝两处清单漂移）；
// 解析失败则回落内置清单（与当前 MANIFEST 同构；toolkit-build.js 构建时有守卫校验两者一致）
export const FALLBACK_SKILL_FILES = [
  'SKILL.md',
  ...ENGINE_FILES.map((f) => `scripts/${f}`),
  'templates/agents.config.private.json', 'templates/agents.config.public.json', 'templates/agents.config.multi.json',
  'templates/settings.sample.json', 'templates/settings.secrets.sample.json', 'templates/claude-settings.template.json',
  'templates/opencode.template.jsonc', 'templates/models.template.json', 'templates/skills-sources.sample.json',
  'hooks/ensure-skills-link.sh',
];

function parseManifest(src) {
  const m = /const MANIFEST = \[([\s\S]*?)\];/.exec(src || '');
  if (!m) return null;
  const files = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
  return files.length ? files : null;
}

// 刷新技能包内副本（.agents/skills/agent-env-init/{scripts,templates,hooks}）——旧版只刷 SKILL.md，
// 导致该目录滞留旧引擎与旧模板（宿主 AI 按 SKILL.md 从该目录复制到 scripts/agent/，等于拿到过期件）。
async function refreshSkillDir(sourceUrl) {
  const skillDir = path.join(ROOT, '.agents', 'skills', 'agent-env-init');
  let files = null;
  try { files = parseManifest(await readRemote(sourceUrl, 'install.mjs')); } catch {}
  if (!files) {
    log('⚠ 远端 install.mjs 清单解析失败 → 使用内置清单（可能与新版有差异）');
    files = FALLBACK_SKILL_FILES;
  }
  let changed = 0;
  for (const rel of files) {
    const content = await readRemote(sourceUrl, rel);
    if (writeIfChanged(path.join(skillDir, rel), content)) changed++;
  }
  const hookSh = path.join(skillDir, 'hooks', 'ensure-skills-link.sh');
  if (fs.existsSync(hookSh)) fs.chmodSync(hookSh, 0o755);
  return { total: files.length, changed };
}

function ensureSnapshotIgnored() {
  const giPath = path.join(ROOT, '.gitignore');
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf-8') : '';
  if (!gi.split('\n').includes(SNAPSHOT_GITIGNORE_LINE)) {
    fs.writeFileSync(giPath, gi.replace(/\n*$/, '\n') + SNAPSHOT_GITIGNORE_LINE + '\n', 'utf-8');
  }
}

async function main() {
  const postMerge = process.argv.includes('--post-merge');
  if (!fs.existsSync(CONFIG_PATH)) {
    if (postMerge) return;
    console.error('[agent-toolkit] ✗ 未找到 agents.config.json（项目未初始化？）');
    process.exit(1);
  }
  const cfg = readJson(CONFIG_PATH);
  const updates = cfg.updates || {};
  const sourceUrl = updates.sourceUrl;
  if (!sourceUrl) {
    if (postMerge) return;
    console.error('[agent-toolkit] ✗ agents.config.json 缺 updates.sourceUrl（toolkit 来源地址），无法检查升级');
    process.exit(1);
  }

  let remoteVersion = '';
  try {
    remoteVersion = (await readRemote(sourceUrl, 'VERSION')).trim();
  } catch (e) {
    // 离线 / 内网隔离 / 源不可达：post-merge 静默跳过（Q12 定案），手动模式显式警告
    if (postMerge) return;
    console.error(`[agent-toolkit] ⚠ 远程 VERSION 获取失败：${e.message}`);
    process.exit(1);
  }

  // 自举自愈（一）：本文件也可能已过期——先把远端升级引擎自身拉下来比对，内容有变则替换并用新引擎重跑。
  // 必要性：内联的 ENGINE_FILES 是「本进程编译期」清单，旧版引擎不认识上游新增的出厂脚本；
  // 若先由旧引擎跑完并写下新版本号，版本闸将短路，新文件永远到不了已装项目。
  // 子进程带 AGENT_TOOLKIT_SELF_REFRESHED 防递归。
  const selfPath = fileURLToPath(import.meta.url);
  try {
    const remoteUpdater = await readRemote(sourceUrl, 'scripts/toolkit-update.js');
    if (remoteUpdater !== fs.readFileSync(selfPath, 'utf-8')) {
      if (process.env.AGENT_TOOLKIT_SELF_REFRESHED) {
        log('⚠ 升级引擎自刷新后仍与远端不一致（防递归，跳过自刷新）');
      } else {
        fs.writeFileSync(selfPath, remoteUpdater, 'utf-8');
        log('升级引擎自身有新版本 → 已刷新，改用新引擎重跑');
        const r = spawnSync(process.execPath, [selfPath, ...process.argv.slice(2)], {
          stdio: 'inherit',
          env: { ...process.env, AGENT_TOOLKIT_SELF_REFRESHED: '1' },
        });
        process.exit(r.status ?? 1);
      }
    }
  } catch (e) {
    // 自刷新是增强路径：失败不阻断主流程（post-merge 静默，手动模式给提示）
    if (!postMerge) log(`⚠ 升级引擎自刷新检查跳过：${e.message}`);
  }

  const local = cfg.toolkitVersion || '';
  const engineDir = path.join(ROOT, 'scripts', 'agent');
  // 缺失文件自愈：版本号相同也必须补齐——覆盖「上游引擎清单扩容」与「本地误删」两种情形。
  // 关键：本文件内联的 ENGINE_FILES 是「本进程编译期」清单，旧版引擎不认识上游新增脚本，
  // 若不看缺失就直接改版本号，新文件将永远到不了已装项目（实测 shawnblog 从 .7 升 .10 时踩中）。
  const missing = ENGINE_FILES.filter((f) => !fs.existsSync(path.join(engineDir, f)));
  if (compareVersions(local, remoteVersion) >= 0 && missing.length === 0) {
    log(`已是最新（${local || '未标记'} ≥ ${remoteVersion}）`);
    return;
  }

  if (missing.length > 0) {
    // 版本已最新但缺文件：只补齐，不改写版本号
    if (compareVersions(local, remoteVersion) >= 0) {
      if (gitDirty()) {
        log(`⚠ 工作区不干净，跳过补齐缺失引擎文件（${missing.join(', ')}）。commit / stash 后重跑`);
        process.exit(postMerge ? 0 : 1);
      }
      log(`版本已最新但缺 ${missing.length} 个引擎文件 → 补齐：${missing.join(', ')}`);
      for (const f of missing) {
        fs.mkdirSync(engineDir, { recursive: true });
        writeIfChanged(path.join(engineDir, f), await readRemote(sourceUrl, `scripts/${f}`));
      }
      const skillHeal = await refreshSkillDir(sourceUrl);
      const healHook = ensurePostMergeHook();
      log(`✓ 已补齐 ${missing.length} 个缺失引擎文件 + 技能包 ${skillHeal.total} 文件（更新 ${skillHeal.changed} 个）${healHook ? ` + post-merge hook ${healHook}` : ''}（版本保持 v${local}），请 review 后提交`);
      return;
    }
    log(`补齐缺失引擎文件 ${missing.length} 个：${missing.join(', ')}`);
  }

  if (postMerge && updates.autoUpdate === false) {
    log(`v${local || '?'} → v${remoteVersion} 可升级（autoUpdate 已关，不自动执行）：node scripts/agent/toolkit-update.js`);
    return;
  }

  const dirty = gitDirty();
  if (dirty) {
    log(`⚠ 工作区不干净，跳过自动升级（v${local || '?'} → v${remoteVersion}）。commit / stash 后重跑：node scripts/agent/toolkit-update.js`);
    process.exit(postMerge ? 0 : 1);
  }

  log(`升级 ${local || '(未标记)'} → ${remoteVersion} ...`);
  for (const f of ENGINE_FILES) {
    fs.mkdirSync(engineDir, { recursive: true });
    writeIfChanged(path.join(engineDir, f), await readRemote(sourceUrl, `scripts/${f}`));
  }
  const skill = await refreshSkillDir(sourceUrl);
  const hookPath = path.join(ROOT, '.claude', 'hooks', 'ensure-skills-link.sh');
  writeIfChanged(hookPath, await readRemote(sourceUrl, 'hooks/ensure-skills-link.sh'));
  fs.chmodSync(hookPath, 0o755);

  // config 键级合并（引擎刷新后再读新默认，保证 schema 同版本）
  const { DEFAULT_AGENTS_CONFIG } = await import('./agents-config.js');
  const oldDefaults = fs.existsSync(SNAPSHOT_PATH) ? readJson(SNAPSHOT_PATH) : null;
  const { merged, added, removed, keptCustom } = mergeConfig(cfg, DEFAULT_AGENTS_CONFIG, oldDefaults);
  merged.toolkitVersion = remoteVersion;
  // 排版保护：键顺序沿用原文件 + 与模板同风格的紧凑序列化，升级 diff 只含真实变更（不再整体重排）
  let prevCfg = null;
  try { prevCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  writeJsonStyled(CONFIG_PATH, prevCfg ? orderLikePrevious(prevCfg, merged) : merged);
  writeJsonStyled(SNAPSHOT_PATH, DEFAULT_AGENTS_CONFIG);
  ensureSnapshotIgnored();
  const hookRel = ensurePostMergeHook();

  log(`✓ 引擎 ${ENGINE_FILES.length} 文件 + 技能包 ${skill.total} 文件（本次更新 ${skill.changed} 个）+ 自愈 hook 已刷新到 v${remoteVersion}`);
  log(`  config 合并：新增 ${added.length} 键 / 移除 ${removed.length} 键${keptCustom.length ? ` / 废弃但已定制保留 ${keptCustom.length} 键` : ''}`);
  for (const k of added) log(`  + ${k}`);
  for (const k of removed) log(`  - ${k}`);
  for (const k of keptCustom) log(`  ≈ ${k}（上游已废弃，本地有定制，保留请自行裁决）`);
  if (hookRel) log(`  post-merge 自愈 hook: ${hookRel}`);
  log(`请 review 后提交：git add scripts/agent .agents/skills/agent-env-init agents.config.json .gitignore${hookRel ? ` ${path.dirname(hookRel)}` : ''}`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    await main();
  } catch (e) {
    console.error(`[agent-toolkit] ✗ ${e.message}`);
    process.exit(1);
  }
}
