#!/usr/bin/env node
//
// skills-update.js（pnpm skills:check / skills:update [name|--all] [--yes]）
//
// 用途：外部来源技能的上游更新引擎，注册表 scripts/skills-sources.json 为机器 SSOT。
//   - check（默认）只读检查：repo-copy 比 clone HEAD 新提交（installed_ref..HEAD）+ 本地定制
//     （本地 vs **安装基线**installed_ref 树；基线未定时退回工作树并在文案中显式标注）；
//     github-direct/cli 比 git ls-remote tags；npm 比 registry latest；uv-tool 比 PyPI；
//     末尾反向扫描 .agents/skills 中疑似未登记的外部技能
//   - update 逐技能升级：repo-copy 展示 diff 后 rsync 覆盖（不删除本地多余文件，
//     .agents/skills 受 git 追踪可回滚）；github-direct 浅克隆 tag 后按 include/exclude 裁剪覆盖；
//     uv-tool 走 uv tool upgrade；npm/cli/manual 打印升级指引
//   - update_policy 三策略（注册表逐技能声明）：follow-upstream 紧跟上游（--all --yes
//     无阻断自动升级）；keep-local 保持本地定制（永不自动覆盖，具名也拦）；manual 仅人工
//     （--all 跳过，具名升级仍可）
//   - 升级后回写注册表版本/基线，并尽力同步 docs/skills.md 来源行版本（人读账本）
//
// 设计要点：
//   - 只报不动手是默认态：check 不写任何文件（唯一例外：repo-copy 首次基线回填）
//   - 盲覆盖必炸（archify 裁剪、paper-search 补丁、本地定制）→ 一切写入前确认，
//     破坏性最小化：rsync 覆盖保留本地多余文件，绝不 --delete（孤儿文件改为报告出来，见 reportOrphans）；
//     一律带 --checksum：默认 size+mtime 快查会漏掉「等字节数 + 同秒 mtime」的真实内容变更
//   - 网络全走原生 git ls-remote / fetch + Node fetch（npm registry / PyPI JSON），零依赖
//
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadAgentsConfig } from './agents-config.js';

// 仓库根解析：从脚本位置逐级向上（≤5 层）找 .git 或 agents.config.json，失败回落 cwd。
// 兼容两种布局：本仓 scripts/（根=上一级）与 agent-toolkit 下游 scripts/agent/（根=上两级）。
function resolveRepoRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'agents.config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const ROOT = resolveRepoRoot();
const SKILLS_DIR = path.join(ROOT, '.agents', 'skills');
const SCRIPT_REL = path.relative(ROOT, fileURLToPath(import.meta.url));

const CFG = loadAgentsConfig(ROOT);
const REGISTRY_PATH = path.join(ROOT, CFG.skills?.registryPath || path.join('scripts', 'skills-sources.json'));
// 账本回写为可选能力：docsLedgerPath 未配置（下游默认）或文件不存在即整体静默跳过
const DOCS_PATH = CFG.skills?.docsLedgerPath ? path.join(ROOT, CFG.skills.docsLedgerPath) : null;

const args = process.argv.slice(2);
const MODE = args.includes('--init') ? 'init'
  : args.includes('--check') || args.length === 0 ? 'check'
  : args.includes('--update') ? 'update'
  : args.includes('--list') ? 'list' : null;
const YES = args.includes('--yes') || process.env.YES === '1';
const targetName = (() => {
  const i = args.findIndex(a => !a.startsWith('--') && a !== 'update');
  return i >= 0 ? args[i] : null;
})();
const ALL = args.includes('--all');

if (!MODE) {
  console.error('用法: pnpm skills:check | pnpm skills:update [name|--all] [--yes] | pnpm skills:list | pnpm skills:check --init');
  process.exit(1);
}

// ---------- 基础工具 ----------

const sh = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { encoding: 'utf-8', timeout: 30_000, ...opts });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
};

// git 网络操作：TUN 代理对 github.com:443 偶发 TLS 重置（SSL_ERROR_SYSCALL），重试 + 退避
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shRetry = async (cmd, argv, opts = {}, tries = 4) => {
  let r = sh(cmd, argv, opts);
  for (let i = 1; i < tries && !r.ok; i++) {
    await sleep(1500 * i);
    r = sh(cmd, argv, opts);
  }
  return r;
};

const expandHome = (p) => p.replace(/^~(?=\/|$)/, os.homedir());

const normVer = (v) => String(v).replace(/^[vV]/, '').trim();

const verCmp = (a, b) => {
  const pa = normVer(a).split('.'), pb = normVer(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0', y = pb[i] ?? '0';
    const c = /^\d+$/.test(x) && /^\d+$/.test(y) ? +x - +y : x.localeCompare(y);
    if (c !== 0) return c > 0 ? 1 : -1;
  }
  return 0;
};

const fetchJson = async (url) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
};

async function confirm(question) {
  if (YES) return true;
  if (!process.stdin.isTTY) {
    console.log(`   ⏭️  非交互环境未执行（加 --yes 确认）：${question}`);
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((r) => rl.question(`   ${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

// ---------- 注册表 ----------

const REGISTRY_REL = path.relative(ROOT, REGISTRY_PATH);
const REGISTRY_EXISTS = fs.existsSync(REGISTRY_PATH);

// 冷启动引导：注册表缺失不是异常，而是「能力未启用」——引导与 AI 对话生成，不吐栈回溯
function coldStartNotice() {
  console.log('-'.repeat(70));
  console.log(`ⓘ 未找到技能上游注册表（${REGISTRY_REL}）`);
  console.log('  本机制跟踪外部来源技能的上游更新（GitHub / npm / PyPI / 本地 clone）。');
  console.log('  启用：与 AI 对话说「生成技能注册表」，按引导确认每个技能的渠道与升级策略；');
  console.log(`  或先只读扫描候选条目骨架：node ${SCRIPT_REL} --init`);
  console.log('-'.repeat(70));
}

if (!REGISTRY_EXISTS && MODE !== 'init') {
  coldStartNotice();
  process.exit(MODE === 'update' ? 1 : 0);
}

const registry = REGISTRY_EXISTS ? JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')) : { version: 1, skills: [] };
const SKILLS = registry.skills || [];
// 可空字段入口归一化（省略与 '' 语义等价）：一次处理，杜绝下游各渠道模板里内插出字符串 undefined
// （实测：省略 tag_prefix 的条目报「上游 undefinedv1.13.0」；.replace 直接崩）
for (const e of SKILLS) {
  if (e.tag_prefix === undefined) e.tag_prefix = '';
  if (e.source_subdir === undefined) e.source_subdir = '';
  if (e.installed_ref === undefined) e.installed_ref = null;
}
let registryDirty = false;

function saveRegistry() {
  if (!registryDirty) return;
  registry.updated_at = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
  registryDirty = false;
  console.log('   📝 注册表已回写 scripts/skills-sources.json');
}

// ---------- 渠道检查 ----------

// 导出某 ref 的目录树快照到临时目录——漂移必须对照「安装基线」，不能对照工作树 HEAD，
// 否则「本地落后上游」会被误报成「本地被定制」（operator 无法分辨该升哪条、升了会不会丢定制）。
// 返回 { root, dir }：root 用于整体清理，dir 为 source_subdir 对应的比较根。
function exportRef(clone, ref, subdir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-ref-'));
  const spec = subdir || '.';
  const cmd = `git -C ${JSON.stringify(clone)} archive ${JSON.stringify(ref)} -- ${JSON.stringify(spec)} | tar -x -C ${JSON.stringify(tmp)}`;
  const r = sh('bash', ['-c', cmd], { timeout: 120_000 });
  if (!r.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return null;
  }
  return { root: tmp, dir: path.join(tmp, subdir || '') };
}

// 逐项 diff：include 白名单条目只比较白名单内的路径（否则本地未安装的上游杂物会被算成漂移）。
// 未配置 include 时整体比较（items = ['']）。
function diffAgainst(localDir, cmpDir, items) {
  const list = items && items.length ? items : [''];
  const lines = [];
  for (const item of list) {
    const l = item ? path.join(localDir, item) : localDir;
    const c = item ? path.join(cmpDir, item) : cmpDir;
    if (!fs.existsSync(l) || !fs.existsSync(c)) {
      lines.push(`结构差异: ${item || '.'}（本地${fs.existsSync(l) ? '有' : '无'} / 基线${fs.existsSync(c) ? '有' : '无'}）`);
      continue;
    }
    const d = sh('diff', ['-rq', l, c, '-x', '.git', '-x', '.DS_Store'], { timeout: 60_000 });
    if (d.out.trim()) lines.push(...d.out.trim().split('\n').filter(Boolean));
  }
  return lines;
}

// repo-copy：上游前进（installed_ref..HEAD）+ 本地定制（本地 vs installed_ref 树）
async function checkRepoCopy(entry) {
  const clone = expandHome(entry.clone_path);
  if (!fs.existsSync(path.join(clone, '.git'))) {
    return { status: 'WARN', msg: `clone 不存在: ${entry.clone_path}` };
  }
  const src = path.join(clone, entry.source_subdir || '');
  if (!fs.existsSync(src)) {
    return { status: 'WARN', msg: `clone 内源目录不存在: ${entry.source_subdir}` };
  }
  await shRetry('git', ['-C', clone, 'fetch', 'origin', '--prune', '--quiet'], { timeout: 60_000 });
  const head = sh('git', ['-C', clone, 'rev-parse', '--short', 'HEAD']).stdout.trim();
  const headDate = sh('git', ['-C', clone, 'log', '-1', '--format=%cs']).stdout.trim();

  let newCommits = null;
  if (entry.installed_ref) {
    const rc = sh('git', ['-C', clone, 'rev-list', '--count', `${entry.installed_ref}..HEAD`]);
    newCommits = rc.ok ? parseInt(rc.stdout.trim(), 10) : null;
  }

  const local = path.join(SKILLS_DIR, entry.name);
  const baseline = entry.installed_ref ? exportRef(clone, entry.installed_ref, entry.source_subdir) : null;
  let drift;
  try {
    drift = diffAgainst(local, baseline ? baseline.dir : src, entry.include);
  } finally {
    if (baseline) fs.rmSync(baseline.root, { recursive: true, force: true });
  }
  const driftIsBaseline = !!baseline;

  // 首次运行：无漂移则回填基线（本地即 clone HEAD 快照）；有漂移保留 null 待人工裁决
  if (!entry.installed_ref && drift.length === 0) {
    entry.installed_ref = head;
    registryDirty = true;
    newCommits = 0;
  }

  const parts = [`clone@${head} (${headDate})`];
  if (newCommits === null) {
    parts.push(entry.installed_ref ? '新提交数未知' : '基线未定，漂移含上游前进');
  } else {
    parts.push(newCommits > 0 ? `上游新提交 ${newCommits} 个 🚀` : '上游无新提交');
  }
  if (drift.length === 0) {
    parts.push(driftIsBaseline ? `与基线@${entry.installed_ref}一致` : '与 clone 一致');
  } else {
    parts.push(driftIsBaseline ? `本地定制 ${drift.length} 处 ⚠️` : `疑似漂移 ${drift.length} 处（基线未定，含上游前进）⚠️`);
  }

  const hasNew = newCommits !== null && newCommits > 0;
  const status = drift.length > 0 && hasNew ? 'DRIFT+NEW' : drift.length > 0 ? 'DRIFT'
    : hasNew ? 'NEW' : 'OK';
  return { status, msg: parts.join(' | '), drift, head, hasNew, driftIsBaseline };
}

// git ls-remote 最新 tag（排除 ^{} 去重行与含 - 的预发布 tag；TUN 抖动重试）
async function latestTags(repo, prefix) {
  const r = await shRetry('git', ['ls-remote', '--tags', '--sort=-v:refname', repo], { timeout: 30_000 });
  if (!r.ok) return null;
  return r.stdout.trim().split('\n')
    .map((l) => (l.split('refs/tags/')[1] || '').trim())
    .filter((t) => t && !t.endsWith('^{}') && !t.includes('-'))
    .filter((t) => !prefix || t.startsWith(prefix))
    .map((t) => (prefix ? t.slice(prefix.length) : t));
}

// GitHub 最新版本三路探测：releases API → tags API（Node fetch 通道，不受 git TLS 抖动影响）→ ls-remote 兜底
async function githubLatest(repo, prefix = '') {
  const m = repo.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  const strip = (t) => (prefix ? t.slice(prefix.length) : t);
  if (m) {
    try {
      const rel = await fetchJson(`https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`);
      const tag = rel?.tag_name;
      if (tag && (!prefix || tag.startsWith(prefix))) return { latest: strip(tag), via: 'release' };
    } catch {}
    try {
      const tags = await fetchJson(`https://api.github.com/repos/${m[1]}/${m[2]}/tags?per_page=100`);
      const names = (Array.isArray(tags) ? tags : [])
        .map((t) => t?.name).filter((t) => t && !t.includes('-') && (!prefix || t.startsWith(prefix)));
      if (names.length) {
        names.sort((a, b) => verCmp(strip(a), strip(b)));
        return { latest: strip(names[names.length - 1]), via: 'tags-api' };
      }
    } catch {}
  }
  const tags = await latestTags(repo, prefix);
  if (tags && tags.length) return { latest: tags[0], via: 'ls-remote' };
  return null;
}

async function checkGithubDirect(entry) {
  const res = await githubLatest(entry.repo);
  if (!res) return { status: 'WARN', msg: '上游无 tag/release，无法自动比版（手动跟进）' };
  const latest = res.latest;
  const cmp = verCmp(latest, entry.version);
  return {
    status: cmp > 0 ? 'NEW' : 'OK',
    msg: cmp > 0 ? `已装 ${entry.version} → 最新 ${latest} 🚀` : `已装 ${entry.version}，上游最新 ${latest}`,
    latest,
    hasNew: cmp > 0,
  };
}

async function checkNpm(entry) {
  try {
    const data = await fetchJson(`https://registry.npmjs.org/${entry.package}`);
    const latest = data?.['dist-tags']?.latest;
    if (!latest) throw new Error('registry 无 latest');
    const cmp = verCmp(latest, entry.version);
    return {
      status: cmp > 0 ? 'NEW' : 'OK',
      msg: cmp > 0 ? `已装 ${entry.version} → latest ${latest} 🚀（升级方式见上游 README，按其说明重装）` : `已装 ${entry.version}，registry latest ${latest}`,
      latest,
      hasNew: cmp > 0,
    };
  } catch (e) {
    return { status: 'ERROR', msg: `npm registry 查询失败: ${e.message}` };
  }
}

function checkUvTool(entry, latest) {
  const installed = sh('uv', ['tool', 'list']);
  const m = new RegExp(`^${entry.package} v(\\S+)$`, 'm').exec(installed.stdout);
  if (!m) return { status: 'WARN', msg: 'uv tool list 未找到已装条目' };
  const cur = m[1];
  const cmp = latest ? verCmp(latest, cur) : 0;
  return {
    status: latest && cmp > 0 ? 'NEW' : 'OK',
    msg: latest ? (cmp > 0 ? `已装 ${cur} → PyPI ${latest} 🚀` : `已装 ${cur}，PyPI 最新 ${latest}`) : `已装 ${cur}（PyPI 查询失败）`,
    installed: cur,
    latest,
    hasNew: latest ? cmp > 0 : false,
  };
}

async function checkCli(entry) {
  const res = await githubLatest(entry.repo, entry.tag_prefix);
  const cur = entry.version.replace(entry.tag_prefix || '', '');
  if (!res) return { status: 'WARN', msg: '无法获取上游版本（tag/release 均无）' };
  const cmp = verCmp(res.latest, cur);
  return {
    status: cmp > 0 ? 'NEW' : 'OK',
    msg: cmp > 0
      ? `已装 ${entry.version} → 上游 ${entry.tag_prefix}${res.latest} 🚀（专有 CLI：需手动升级）`
      : `已装 ${entry.version}，上游最新 ${entry.tag_prefix}${res.latest}`,
    hasNew: cmp > 0,
  };
}

// 单技能全渠道检查统一入口
async function checkEntry(entry) {
  switch (entry.channel) {
    case 'repo-copy': return { channel: 'repo-copy', ...(await checkRepoCopy(entry)) };
    case 'github-direct': return { channel: 'github', ...(await checkGithubDirect(entry)) };
    case 'npm': return { channel: 'npm', ...(await checkNpm(entry)) };
    case 'uv-tool': {
      let latest = null;
      try { latest = (await fetchJson(`https://pypi.org/pypi/${entry.package}/json`))?.info?.version; } catch {}
      return { channel: 'uv-tool', ...checkUvTool(entry, latest) };
    }
    case 'cli': return { channel: 'cli', ...(await checkCli(entry)) };
    default: return { channel: 'manual', status: 'SKIP', msg: entry.notes || '手动渠道' };
  }
}

// ---------- 升级动作 ----------

function postUpdateReminders(entry) {
  if (entry.post_update) console.log(`   ${entry.post_update}`);
  // 标准后续命令各仓通用（下游亦注册 project:sync）；人读账本仅在启用时提示
  const ledger = DOCS_PATH && fs.existsSync(DOCS_PATH) ? '；人读账本补一行修订说明' : '';
  console.log(`   ▶ 后续：pnpm project:sync 补链 + 重启会话生效${ledger}`);
}

function bumpDocsVersion(entry, newTagNum) {
  // 账本回写为可选能力：未配置 docsLedgerPath（下游默认）或文件不存在 → 静默跳过，非异常
  if (!DOCS_PATH || !fs.existsSync(DOCS_PATH)) return { ok: false, skip: true, msg: '未启用账本回写' };
  // docs_version 形如 v2.15 / V3.7.1 / cli-v0.1.11 —— 只替换尾部数字段，保留前缀
  if (!entry.docs_version) return { ok: false, msg: '注册表无 docs_version，请手动更新账本来源行' };
  const oldDocs = entry.docs_version;
  const newDocs = /\d+(\.\d+)*$/.test(oldDocs) ? oldDocs.replace(/\d+(\.\d+)*$/, newTagNum) : null;
  let md;
  try { md = fs.readFileSync(DOCS_PATH, 'utf-8'); } catch {
    return { ok: false, msg: '账本读取失败，请手动更新版本行' };
  }
  const secRe = new RegExp(`^### \\d+\\. ${entry.name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:[\\s(].*)?$`, 'm');
  const sec = md.match(secRe);
  if (!sec) return { ok: false, msg: `账本未找到 ${entry.name} 章节，请手动更新版本行` };
  const start = sec.index + sec[0].length;
  const nextIdx = md.slice(start).search(/^### /m);
  const end = nextIdx === -1 ? md.length : start + nextIdx;
  const section = md.slice(start, end);
  const lineRe = /^(\| \*\*来源\*\* \|.*)$/m;
  if (!lineRe.test(section)) return { ok: false, msg: '账本该章节无来源行，请手动补' };
  if (!newDocs) return { ok: false, msg: `docs_version 格式异常（${oldDocs}），请手动更新` };
  const replaced = section.replace(lineRe, (line) => line.includes(oldDocs) ? line.replace(oldDocs, newDocs) : line);
  if (replaced === section) return { ok: false, msg: `来源行未含旧版本 ${oldDocs}，请手动核对更新` };
  fs.writeFileSync(DOCS_PATH, md.slice(0, start) + replaced + md.slice(end));
  return { ok: true, msg: `账本来源行已更新 ${oldDocs} → ${newDocs}`, newDocs };
}

// 账本回写结果输出：skip（未启用）时静默，避免下游噪音
function reportDocsBump(bump) {
  if (bump.skip) return;
  console.log(`   ${bump.ok ? '📝' : '⚠️'} ${bump.msg}`);
}

// rsync 覆盖不删除本地多余文件（防误删本地定制），但「上游已移除、本地仍留」的孤儿文件必须报告出来，
// 否则越积越多且无人察觉。scope 限定在本次安装范围内（include 白名单时只报白名单路径内的孤儿）。
function listOrphans(dstDir, srcDir, ignore = [], scope = null) {
  if (!fs.existsSync(dstDir) || !fs.existsSync(srcDir)) return [];
  const rels = [];
  const walk = (dir, base = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignore.includes(e.name)) continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else rels.push(rel);
    }
  };
  walk(dstDir);
  return rels.filter((rel) => {
    if (scope && !scope(rel)) return false;
    return !fs.existsSync(path.join(srcDir, rel));
  });
}

function reportOrphans(entry, dst, src) {
  const inScope = entry.include
    ? (rel) => entry.include.some((i) => rel === i || rel.startsWith(`${i.replace(/\/$/, '')}/`))
    : null;
  const orphans = listOrphans(dst, src, ['.git', '.DS_Store'], inScope);
  if (orphans.length === 0) return;
  console.log(`   🧹 上游已无但本地保留 ${orphans.length} 个文件（rsync 不删除，未自动清理）：`);
  for (const rel of orphans.slice(0, 10)) console.log(`      ${rel}`);
  if (orphans.length > 10) console.log(`      ... 其余 ${orphans.length - 10} 个`);
  console.log('      确认无需保留后可手工删除（.agents/skills 受 git 追踪，可回滚）');
}

// include 白名单逐项同步：目录项必须两侧都带尾斜杠，否则「目标已存在同名目录」时 rsync 会嵌套成 dst/a/a/。
// （文件项则需先建好父目录，否则 rsync 无法创建中间路径。）
// --checksum：rsync 默认按 size+mtime 快查，而 clone 检出的 mtime 是「刚刚」，本地同秒 + 等字节数
// （版本号 1→2 这类等长改动）会被静默跳过 → 内容陈旧。技能目录很小，用校验和换取正确性。
function rsyncIncludeItem(src, dst, item, excludes) {
  const s = path.join(src, item);
  if (!fs.existsSync(s)) return { ok: true, skipped: true };
  const d = path.join(dst, item);
  const isDir = fs.statSync(s).isDirectory();
  fs.mkdirSync(isDir ? d : path.dirname(d), { recursive: true });
  const r = sh('rsync', ['-a', '--checksum', ...excludes, ...(isDir ? [`${s}/`, `${d}/`] : [s, d])], { timeout: 120_000 });
  return { ...r, skipped: false };
}

async function updateRepoCopy(entry) {
  const res = await checkRepoCopy(entry);
  if (res.status === 'WARN' || res.status === 'ERROR') { console.log(`   ❌ ${res.msg}`); return false; }
  if (res.drift.length > 0) {
    console.log(`   📋 ${res.driftIsBaseline ? `本地 vs 安装基线@${entry.installed_ref}` : '本地 vs clone（基线未定）'}差异（${res.drift.length} 处，覆盖会丢本地定制，git 可回滚）：`);
    for (const l of res.drift.slice(0, 30)) console.log(`      ${l.replace(path.join(ROOT), '.')}`);
    if (res.drift.length > 30) console.log(`      ... 其余 ${res.drift.length - 30} 处`);
  }
  const src = path.join(expandHome(entry.clone_path), entry.source_subdir || '');
  const dst = path.join(SKILLS_DIR, entry.name);
  const ok = await confirm(`用 ${entry.clone_path}${entry.source_subdir ? '/' + entry.source_subdir : ''}${entry.include ? ` 按 include 白名单（${entry.include.length} 项）` : ''} 覆盖本地 ${entry.name}？`);
  if (!ok) { console.log('   ⏭️  已跳过'); return false; }
  const excludes = ['--exclude', '.git', '--exclude', '.DS_Store', ...(entry.exclude || []).flatMap((e) => ['--exclude', e])];
  let r = { ok: true, out: '' };
  if (entry.include) {
    // 裁剪安装是白名单语义（与 github-direct 同构）：只同步登记的路径，避免把上游整仓杂物带进来
    for (const item of entry.include) {
      const r2 = rsyncIncludeItem(src, dst, item, excludes);
      if (r2.skipped) { console.log(`   ⚠️  clone 内无 ${item}（跳过）`); continue; }
      r = r2;
      if (!r.ok) break;
    }
  } else {
    r = sh('rsync', ['-a', '--checksum', ...excludes, src + '/', dst + '/'], { timeout: 120_000 });
  }
  if (!r.ok) { console.log(`   ❌ rsync 失败: ${r.out.split('\n')[0]}`); return false; }
  entry.installed_ref = res.head;
  registryDirty = true;
  console.log(`   ✅ 已覆盖更新（基线回填 ${res.head}，本地多余文件保留）`);
  reportOrphans(entry, dst, src);
  postUpdateReminders(entry);
  return true;
}

async function updateGithubDirect(entry) {
  const res = await checkGithubDirect(entry);
  if (!res.hasNew) { console.log(`   ✅ 已是最新（${entry.version}）`); return false; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-update-'));
  const src = path.join(tmp, 'src');
  console.log(`   ⬇️  浅克隆 ${entry.repo} @ ${res.latest} ...`);
  const clone = await shRetry('git', ['clone', '--depth', '1', '--branch', res.latest, entry.repo, src], { timeout: 300_000 });
  if (!clone.ok) { console.log(`   ❌ 克隆失败: ${clone.out.split('\n')[0]}`); fs.rmSync(tmp, { recursive: true, force: true }); return false; }
  const ok = await confirm(`用 ${res.latest} 按 ${entry.include ? `include 白名单（${entry.include.length} 项）` : 'exclude 裁剪'}覆盖 ${entry.name}？`);
  if (!ok) { console.log('   ⏭️  已跳过'); fs.rmSync(tmp, { recursive: true, force: true }); return false; }
  const dst = path.join(SKILLS_DIR, entry.name);
  let rsync = { ok: true, out: '' };
  if (entry.include) {
    // 裁剪安装是白名单语义：仅同步登记的路径（exclude 仍生效，如 examples/*.html）
    for (const item of entry.include) {
      const r = rsyncIncludeItem(src, dst, item, (entry.exclude || []).flatMap((e) => ['--exclude', e]));
      if (r.skipped) { console.log(`   ⚠️ 上游无 ${item}（跳过）`); continue; }
      if (!r.ok) { rsync = r; break; }
    }
  } else {
    rsync = sh('rsync', ['-a', '--checksum', ...(entry.exclude || []).flatMap((e) => ['--exclude', e]), src + '/', dst + '/'], { timeout: 120_000 });
  }
  // 孤儿统计必须在删除临时 clone 之前做（src 被删后无从比对）
  const orphans = listOrphans(dst, src, ['.git', '.DS_Store'],
    entry.include ? (rel) => entry.include.some((i) => rel === i || rel.startsWith(`${i.replace(/\/$/, '')}/`)) : null);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!rsync.ok) { console.log(`   ❌ rsync 失败: ${rsync.out.split('\n')[0]}`); return false; }
  entry.version = res.latest;
  registryDirty = true;
  console.log(`   ✅ 已升级到 ${res.latest}`);
  if (orphans.length > 0) {
    console.log(`   🧹 上游已无但本地保留 ${orphans.length} 个文件（rsync 不删除，未自动清理）：`);
    for (const rel of orphans.slice(0, 10)) console.log(`      ${rel}`);
    if (orphans.length > 10) console.log(`      ... 其余 ${orphans.length - 10} 个`);
    console.log('      确认无需保留后可手工删除（.agents/skills 受 git 追踪，可回滚）');
  }
  const bump = bumpDocsVersion(entry, normVer(res.latest));
  reportDocsBump(bump);
  if (bump.ok) { entry.docs_version = bump.newDocs; registryDirty = true; }
  postUpdateReminders(entry);
  return true;
}

async function updateUvTool(entry) {
  let latest = null;
  try { latest = (await fetchJson(`https://pypi.org/pypi/${entry.package}/json`))?.info?.version; } catch {}
  const res = checkUvTool(entry, latest);
  console.log(`   ${res.msg}`);
  if (!res.hasNew) return false;
  const ok = await confirm(`执行 uv tool upgrade ${entry.package}？`);
  if (!ok) { console.log('   ⏭️  已跳过'); return false; }
  const r = sh('uv', ['tool', 'upgrade', entry.package], { timeout: 180_000 });
  if (!r.ok) { console.log(`   ❌ 升级失败: ${r.out.split('\n').slice(-2).join(' ').trim()}`); return false; }
  const after = checkUvTool(entry, null);
  if (after.installed) { entry.version = after.installed; registryDirty = true; }
  console.log(`   ✅ 已升级${after.installed ? `到 ${after.installed}` : ''}`);
  const bump = bumpDocsVersion(entry, after.installed || '');
  reportDocsBump(bump);
  postUpdateReminders(entry);
  return true;
}

async function updateEntry(entry, auto = false) {
  console.log(`\n🔄 ${entry.name} [${entry.channel}]`);
  // 策略闸门：keep-local 永不自动覆盖（具名也不行，防手滑）；manual 在 --all 下跳过（具名仍可人工升）
  if (entry.update_policy === 'keep-local') {
    console.log(`   🛡️  策略 keep-local：${entry.name} 为本地定制，永不自动覆盖（确需同步请改注册表 update_policy 或逐文件 cherry-pick）`);
    return false;
  }
  if (auto && entry.update_policy === 'manual') {
    console.log(`   ⚙️  策略 manual：${entry.notes || entry.post_update || '仅人工升级，--all 自动模式跳过'}`);
    return false;
  }
  switch (entry.channel) {
    case 'repo-copy': return updateRepoCopy(entry);
    case 'github-direct': return updateGithubDirect(entry);
    case 'uv-tool': return updateUvTool(entry);
    case 'npm':
      console.log(`   ⚙️  npm 渠道升级走 CLI 重装（${entry.package}，见上游 README），相关技能目录一起更新后重跑 pnpm project:sync`);
      console.log(`   ${entry.notes || ''}`);
      return false;
    case 'cli':
      console.log(`   ⚙️  ${entry.notes || '专有 CLI 手动升级'}`);
      return false;
    default:
      console.log(`   ⚙️  ${entry.notes || '手动渠道，无自动升级'}`);
      return false;
  }
}

// ---------- 外部来源扫描（check 找未登记项 / --init 生成候选骨架 共用） ----------

// 启发式：SKILL.md 头部含 license: 行或 github.com 链接 → 疑似外部来源（自建技能无这些标记，不误报）
function scanExternalSkills() {
  const out = [];
  if (!fs.existsSync(SKILLS_DIR)) return out;
  for (const d of fs.readdirSync(SKILLS_DIR)) {
    const skillMd = path.join(SKILLS_DIR, d, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const head = fs.readFileSync(skillMd, 'utf-8').split('\n').slice(0, 40);
    const license = head.slice(0, 20).some((l) => /^license:/i.test(l));
    // 判定口径与旧版逐字一致（任意行含 github.com 即算外部）；URL 提取仅用于展示证据
    const hitLine = head.find((l) => l.includes('github.com')) || '';
    const url = (hitLine.match(/https?:\/\/(?:www\.)?github\.com\/[^\s)"'<>|]+/) || [''])[0];
    if (license || hitLine) out.push({ name: d, license, url });
  }
  return out;
}

const registeredNames = () => new Set(SKILLS.flatMap((e) => [e.name, ...(e.skill_dirs || [])]));

// ---------- 主流程 ----------

async function main() {
  if (MODE === 'init') {
    const all = fs.existsSync(SKILLS_DIR)
      ? fs.readdirSync(SKILLS_DIR).filter((d) => fs.existsSync(path.join(SKILLS_DIR, d, 'SKILL.md'))) : [];
    const candidates = scanExternalSkills();
    const registered = registeredNames();
    const pending = candidates.filter((s) => !registered.has(s.name));

    console.log('🔎 候选注册表条目（只读扫描，未写任何文件）\n');
    console.log(`扫描范围: .agents/skills/ 共 ${all.length} 个技能目录；外部来源嫌疑 ${candidates.length} 个`);
    if (REGISTRY_EXISTS) console.log(`已登记: ${SKILLS.length} 条（${REGISTRY_REL}）`);
    else console.log(`注册表: 尚未创建（${REGISTRY_REL}）`);
    console.log();

    if (pending.length === 0) {
      console.log(candidates.length === 0
        ? '未检出外部来源技能 → 本级无需注册表（自建技能无需跟踪上游）'
        : '全部外部来源技能均已登记 → 无需补充');
      return;
    }

    for (const s of pending) {
      console.log(`  [${s.name}]`);
      console.log(`      证据: license 行=${s.license ? '是' : '否'} | 上游链接=${s.url || '(未检出)'}`);
    }

    const skeleton = {
      version: 1,
      updated_at: new Date().toISOString().slice(0, 10),
      description: '外部来源技能上游注册表（机器 SSOT）。channel: repo-copy=本地 clone 复制 | github-direct=GitHub 直装无 clone | npm=npm CLI 安装 | uv-tool=uv tool 全局 | cli=专有 CLI | manual=手动跟进。update_policy: follow-upstream=紧跟上游(--all 自动升级) | keep-local=保持本地定制(永不自动覆盖) | manual=仅人工',
      skills: pending.map((s) => ({ name: s.name, channel: null, update_policy: 'manual', repo: s.url || '', notes: '' })),
    };
    console.log(`\n${'-'.repeat(70)}\n以下骨架供 AI 填表后写入 ${REGISTRY_REL}：\n`);
    console.log(JSON.stringify(skeleton, null, 2));
    console.log(`\n${'-'.repeat(70)}`);
    console.log('下一步（与 AI 对话完成，勿凭猜测填）：');
    console.log('  1. 逐条确认 channel：repo-copy（有本地 clone 目录）/ github-direct / npm / uv-tool / cli / manual');
    console.log('  2. 确认 update_policy：follow-upstream 紧跟上游 / keep-local 本地深度定制永不覆盖 / manual 仅人工');
    console.log('  3. repo-copy 需补 clone_path 与 source_subdir；github-direct/npm/uv-tool 需补 repo 或 package 与当前 version');
    console.log(`  4. 写入后验证：node ${SCRIPT_REL} --check`);
    return;
  }

  if (MODE === 'list') {
    console.log(`技能上游注册表（${SKILLS.length} 条）— ${REGISTRY_REL}\n`);
    for (const e of SKILLS) {
      const where = e.channel === 'repo-copy' ? `${e.clone_path}${e.source_subdir ? '/' + e.source_subdir : ''}`
        : e.channel === 'github-direct' || e.channel === 'cli' ? e.repo
        : e.channel === 'npm' || e.channel === 'uv-tool' ? e.package : '—';
      console.log(`  ${e.name.padEnd(32)} [${e.channel}] ${where}${e.version || e.installed_ref ? ` @ ${e.version || e.installed_ref}` : ''}`);
    }
    return;
  }

  if (MODE === 'update') {
    const targets = ALL || !targetName ? SKILLS : SKILLS.filter((e) => e.name === targetName);
    if (!ALL && !targetName) { console.error('用法: pnpm skills:update <name> | --all [--yes]'); process.exit(1); }
    if (ALL) console.log('⚡ --all 模式：仅对「确认有新版」的技能逐个确认升级\n');
    const done = [];
    for (const e of targets) {
      if (e.update_policy === 'keep-local') { console.log(`🛡️  ${e.name}：策略 keep-local，跳过（本地定制保持本地）`); continue; }
      if (ALL) {
        const chk = await checkEntry(e);
        if (!chk.hasNew) { console.log(`⏭️  ${e.name}：无新版（${chk.msg}）`); continue; }
      }
      const r = await updateEntry(e, ALL);
      if (r) done.push(e.name);
    }
    saveRegistry();
    console.log(`\n${'='.repeat(70)}\n本次升级: ${done.length ? done.join(', ') : '无'}${done.length ? '\n后续: git diff 复核 → pnpm project:sync → 外科手术式提交' : ''}`);
    return;
  }

  // check 模式
  console.log('='.repeat(70));
  console.log('🔍 外部来源技能上游检查（只读，注册表 scripts/skills-sources.json）');
  console.log('='.repeat(70));
  const summary = { NEW: 0, DRIFT: 0, 'DRIFT+NEW': 0, OK: 0, WARN: 0, ERROR: 0, SKIP: 0 };
  const news = [], drifts = [], errors = [];
  for (const e of SKILLS) {
    const chk = await checkEntry(e);
    summary[chk.status] = (summary[chk.status] || 0) + 1;
    const icon = { NEW: '🚀', 'DRIFT+NEW': '🚀', DRIFT: '⚠️ ', OK: '✅', WARN: '❗', ERROR: '❌', SKIP: '⏭️ ' }[chk.status] || '  ';
    const policyTag = e.update_policy === 'keep-local' ? '  ←策略:保持本地' : '';
    console.log(`${icon} ${e.name.padEnd(32)} [${chk.channel}] ${chk.msg}${policyTag}`);
    if (chk.hasNew) news.push(e.name);
    if (chk.status === 'DRIFT' || chk.status === 'DRIFT+NEW') {
      drifts.push(chk.driftIsBaseline === false ? `${e.name}（基线未定）` : `${e.name}(${chk.drift.length}处)`);
    }
    if (chk.status === 'ERROR' || chk.status === 'WARN') errors.push(e.name);
  }

  // 反向扫描：.agents/skills 中疑似外部来源但未登记的技能（启发式见 scanExternalSkills）
  const registered = registeredNames();
  const unregistered = scanExternalSkills().filter((s) => !registered.has(s.name)).map((s) => s.name);
  saveRegistry();
  console.log('\n' + '-'.repeat(70));
  console.log(`有新版 ${news.length} | 本地定制 ${drifts.length} | 最新 ${summary.OK} | 异常 ${errors.length} | 手动 ${summary.SKIP}`);
  if (news.length) console.log(`\n[🚀 有新版]: ${news.join(', ')}\n     升级: pnpm skills:update <name> | 全自动: pnpm skills:update --all --yes（仅 follow-upstream 策略技能）`);
  if (drifts.length) console.log(`[⚠️  本地定制(本地 ≠ 安装基线)]: ${drifts.join(', ')}\n     处置: pnpm skills:update <name> 查看差异清单；标「基线未定」者为疑似漂移（含上游前进），需人工裁决`);
  if (unregistered.length) console.log(`[🆕 疑似未登记外部技能]: ${unregistered.join(', ')}\n     外部来源请在 ${REGISTRY_REL} 补条目（候选骨架: node ${SCRIPT_REL} --init）；自建技能误报可忽略`);
  if (errors.length) console.log(`[❗ 异常]: ${errors.join(', ')}`);
}

main().catch((e) => { console.error(`致命错误: ${e.message}`); process.exit(1); });
