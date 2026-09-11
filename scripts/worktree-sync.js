import { execSync } from 'child_process';
import path from 'path';
import { loadAgentsConfig } from './agents-config.js';

//
// worktree-sync.js（pnpm worktree:sync）
//
// 六步机制（对齐基准仓 rmp-hr-kpi scripts/worktree-sync.js，私有仓差异见各步注释）：
//   0. 主分支强校验 → 0.5 主区脏区自动收纳 → 1. 动态发现子槽位 → 2. 逐支合并（冲突走 A+B 无损叠加 SOP）
//   → 3. 合并门禁（本仓无 smoke，可选 WORKTREE_SYNC_SMOKE 自定义）→ 4/5. Push Gate（默认不推）
//   → 6. 基线反推各槽位
//
function run(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
  } catch (err) {
    if (options.ignoreError) return null;
    throw new Error(`Command failed: ${cmd}\nError: ${err.stderr || err.message}`);
  }
}

function log(msg) {
  console.log(`[WorktreeSync] ${msg}`);
}

async function main() {
  const wtCfg = loadAgentsConfig(process.cwd()).worktree;
  log('开始检查 Worktree 并发工作区合并与同步...');

  // 0. 确认在主工作区运行（主分支工作区）
  const currentBranch = run('git branch --show-current');
  const mainBranch = process.env.MAIN_BRANCH || wtCfg.mainBranch || 'master';
  if (currentBranch !== mainBranch) {
    throw new Error(`必须在主分支 [${mainBranch}] 工作区运行，当前分支: ${currentBranch}`);
  }

  // 0.4 stash 残留提醒（2026-08-18 事故教训：一条 6 月的 rebase autostash 遗物静默滞留两个多月无人察觉，
  //     误 pop 后与远端删除的文件冲突）。stash 是全仓库共享栈，各工位 WIP 都可能停在这里，必须显式可见。
  const stashList = run('git stash list', { ignoreError: true }) || '';
  const stashLines = stashList.split('\n').filter(Boolean);
  if (stashLines.length > 0) {
    log(`⚠ 检测到 ${stashLines.length} 条 stash 残留（内容未丢失，但可能已过期）：`);
    for (const line of stashLines) log(`   ${line}`);
    log('   查看: git stash show -p stash@{0}；恢复: git stash pop（冲突按无损叠加解决）；确认作废: git stash drop');
  }

  // 0.5 确认主工作区干净（merge 需要 clean tree）
  //     自动收纳 tracked 的 .claude/*.json（私有仓策略全入库，worktree 权限共享导致频繁变脏）。
  //     用 git ls-files 枚举 + 逐文件查脏，避免解析 porcelain 状态位（各状态列宽不一，切片易错）
  const dirty = run('git status --porcelain');
  if (dirty && dirty.trim().length > 0) {
    log('⚠️ 主工作区有未提交改动，尝试自动收纳...');
    const collectSpec = (wtCfg.collectPaths || []).map((p) => `"${p}"`).join(' ');
    const agentJsons = collectSpec
      ? run(`git ls-files ${collectSpec}`).split('\n').filter(Boolean).filter((f) => f.endsWith(wtCfg.collectSuffix || '.json'))
      : [];
    for (const f of agentJsons) {
      const fDirty = run(`git status --porcelain -- ${f}`, { ignoreError: true });
      if (fDirty && fDirty.trim().length > 0) {
        try {
          run(`git add ${f}`);
          run(`git commit -m "chore: 同步 ${f} (sync 自动收纳)" --only ${f}`);
          log(`✓ 已自动收纳 ${f}`);
        } catch (e) {
          log(`⚠ 自动收纳 ${f} 失败：${e.message}`);
        }
      }
    }
    // 再次检查是否还有其他脏文件
    const stillDirty = run('git status --porcelain');
    if (stillDirty && stillDirty.trim().length > 0) {
      throw new Error(`主工作区仍有未提交改动（非 Agent 配置），请先 commit 或 stash：\n${stillDirty}`);
    }
  }

  // 1. 获取当前 worktree 列表
  const rawList = run('git worktree list --porcelain');
  const worktrees = [];
  let currentEntry = {};

  rawList.split('\n').forEach((line) => {
    if (line.startsWith('worktree ')) {
      currentEntry.path = line.replace('worktree ', '').trim();
    } else if (line.startsWith('branch ')) {
      currentEntry.branch = line.replace('branch refs/heads/', '').trim();
    } else if (line === '') {
      if (currentEntry.path && currentEntry.branch) {
        worktrees.push({ ...currentEntry });
      }
      currentEntry = {};
    }
  });
  if (currentEntry.path && currentEntry.branch) {
    worktrees.push(currentEntry);
  }

  if (worktrees.length === 0) {
    throw new Error('未检测到有效的 Git Worktree 环境');
  }

  const masterEntry = worktrees.find((w) => w.branch === mainBranch);
  if (!masterEntry) {
    throw new Error(`未找到主分支 [${mainBranch}] 工作区`);
  }

  const childWorktrees = worktrees.filter((w) => w.branch !== mainBranch);
  if (childWorktrees.length === 0) {
    log(`主分支为 [${mainBranch}]，未检测到子 Worktree 槽位。`);
    return;
  }
  log(`主分支为 [${mainBranch}]，检测到 ${childWorktrees.length} 个子常驻工作区: ${childWorktrees.map((w) => `${w.branch} (${path.basename(w.path)})`).join(', ')}`);

  let mergedCount = 0;

  // 2. 遍历各子 Worktree 并合并新 commit 到主分支
  for (const wt of childWorktrees) {
    const aheadLog = run(`git log ${mainBranch}..${wt.branch} --oneline`, { ignoreError: true });
    if (aheadLog && aheadLog.length > 0) {
      log(`分支 [${wt.branch}] 有新提交，正在合并到 [${mainBranch}]...`);
      try {
        run(`git merge ${wt.branch} --no-edit`);
        log(`✓ 成功合并分支 [${wt.branch}]`);
        mergedCount++;
      } catch (err) {
        log(`❌ 分支 [${wt.branch}] 合并存在冲突！`);
        log(`   请遵循无损叠加（A + B）原则手动解决冲突：`);
        log(`   1. 在主工作区打开冲突文件`);
        log(`   2. 同时保留双方的修改`);
        let hintStep = 3;
        for (const hint of wtCfg.mergeHints || []) log(`   ${hintStep++}. ${hint}`);
        log(`   ${hintStep}. git commit 后重新运行 pnpm worktree:sync`);
        process.exit(1);
      }
    } else {
      log(`分支 [${wt.branch}] 无新提交，跳过合并`);
    }
  }

  // 3. 合并后门禁（本仓无 typecheck/lint/test:unit 构建链，默认跳过；
  //     可选 WORKTREE_SYNC_SMOKE="<cmd>" 注入自定义校验命令）
  if (mergedCount > 0) {
    const smokeCmd = process.env.WORKTREE_SYNC_SMOKE;
    if (smokeCmd) {
      log(`正在执行合并门禁: ${smokeCmd}...`);
      try {
        run(smokeCmd);
        log('✓ 门禁通过');
      } catch (err) {
        log(`❌ 门禁失败！错误: ${err.message}`);
        process.exit(1);
      }
    } else {
      log('ℹ 文档仓无构建链，跳过 smoke 门禁（如需注入: WORKTREE_SYNC_SMOKE="<cmd>"）');
    }
  }

  // 4. 同步远端
  log(`正在同步远端 origin/${mainBranch}...`);
  run('git fetch origin', { ignoreError: true });

  const unpushed = run(`git log origin/${mainBranch}..HEAD --oneline`, { ignoreError: true });
  const unpushedCount = unpushed ? unpushed.split('\n').filter(Boolean).length : 0;

  // 5. Push 需要用户显式授权 —— 默认不自动 push
  const shouldPush = process.env.WORKTREE_SYNC_PUSH === 'true';
  if (unpushedCount > 0) {
    if (shouldPush) {
      log(`正在执行 git rebase origin/${mainBranch}...`);
      run(`git rebase origin/${mainBranch}`);
      log(`正在推送最新 [${mainBranch}] 到远端...`);
      run(`git push origin ${mainBranch}`);
      log(`✓ 成功推送到远端 ${mainBranch}！`);
    } else {
      log(`📋 主分支有 ${unpushedCount} 个提交待推送（本轮合并 ${mergedCount} 个）。推送需显式授权：`);
      log(`   WORKTREE_SYNC_PUSH=true pnpm worktree:sync`);
      log(`   或手动: git push origin ${mainBranch}`);
    }
  } else {
    log('远端已是最新，无需推送');
  }

  // 6. 反向更新各常驻 Worktree 分支基线到最新主分支
  //    失败常见因：槽位脏区 / rebase 冲突 / 已停在 rebase 中间态——必须显式暴露，静默吞掉会造成
  //    "master 已合并但槽位基线落后"的环境漂移，且日志误报成功
  for (const wt of childWorktrees) {
    const name = path.basename(wt.path);
    const ok = run(`git -C "${wt.path}" rebase ${mainBranch}`, { ignoreError: true });
    if (ok !== null) {
      log(`✓ 已更新工位 [${name}] 的基线到最新 ${mainBranch}`);
      continue;
    }
    const midRebase = run(`git -C "${wt.path}" rev-parse -q --verify REBASE_HEAD`, { ignoreError: true });
    if (midRebase !== null) {
      log(`⚠ 工位 [${name}] rebase 冲突，已停在中间态：进入 ${wt.path} 解决冲突后 git rebase --continue，或 git rebase --abort 回退后重跑`);
    } else {
      log(`⚠ 工位 [${name}] 基线反推失败（多为未提交脏区）：commit / stash 后重跑 pnpm worktree:sync`);
    }
  }

  log('🎉 Worktree 合并与基线同步完成！常驻槽位保持完好。');
}

main().catch((err) => {
  console.error(`[WorktreeSync Error] ${err.message}`);
  process.exit(1);
});
