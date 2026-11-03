#!/usr/bin/env node
/**
 * AI 桌面宠物 —— 一键发版脚本
 *
 * 流程：升版本 → 提交 → 打 annotated tag → 推送 → 可选盯 GitHub Actions。
 *
 * 版本号同时更新以下文件（应用后端固定读取项目根 package.json 的 version）：
 *   - package.json                  （根目录，应用读取的版本来源）
 *   - frontend/package.json         （Electron 应用版本）
 *   - frontend/package-lock.json    （锁文件根包的版本）
 *   - backend/pyproject.toml        （Python 后端包版本）
 *   - backend/__init__.py           （运行期 __version__，用于 WS 握手）
 *
 * 用法：
 *   node deploy/release.mjs --patch --yes --note "发布说明" --no-watch
 *   node deploy/release.mjs --minor --yes
 *   node deploy/release.mjs --major --yes --no-push
 *   node deploy/release.mjs              （手动运行：交互询问并确认）
 *
 * 参数：
 *   --patch / --minor / --major  指定升哪一位
 *   --yes                        跳过确认（非交互模式必须加）
 *   --note "..."                 发布说明（写入 commit 与 annotated tag）
 *   --no-push                    只提交 + 打 tag，不推送、不盯 CI
 *   --no-watch                   正常推送，但不轮询 CI
 *   --branch <名字>              允许在非 main 分支发版（须与当前分支一致）
 *   --help                       显示帮助
 *
 * 退出码：0 = 成功；1 = 失败。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PROJECT_ROOT);

const LEVELS = ['patch', 'minor', 'major'];
const MAIN_BRANCH = 'main';

/** 需要同步版本号的文件。root package.json 是应用读取版本号的硬契约。 */
const VERSION_TARGETS = [
  { rel: 'package.json', kind: 'json', required: true },
  { rel: 'frontend/package.json', kind: 'json', required: false },
  { rel: 'frontend/package-lock.json', kind: 'lock', required: false },
  { rel: 'backend/pyproject.toml', kind: 'toml', required: false },
  { rel: 'backend/__init__.py', kind: 'python', required: false },
];

function log(message = '') {
  console.log(message);
}

function warn(message) {
  console.error(`[警告] ${message}`);
}

function fail(message) {
  console.error(`[错误] ${message}`);
  process.exit(1);
}

function runGit(args, extra = {}) {
  return spawnSync('git', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    ...extra,
  });
}

function gitOrFail(args, errorMessage) {
  const result = runGit(args);
  if (result.error) {
    fail(`${errorMessage}：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`${errorMessage}${detail ? `\n${detail}` : ''}`);
  }
  return (result.stdout || '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = {
    level: null,
    yes: false,
    note: null,
    noPush: false,
    noWatch: false,
    branch: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--patch':
      case '--minor':
      case '--major': {
        const level = arg.slice(2);
        if (options.level && options.level !== level) {
          fail('只能指定一个升版位：--patch / --minor / --major');
        }
        options.level = level;
        break;
      }
      case '--yes':
        options.yes = true;
        break;
      case '--note': {
        if (i + 1 >= argv.length) fail('--note 缺少发布说明参数');
        options.note = argv[i + 1];
        i += 1;
        break;
      }
      case '--no-push':
        options.noPush = true;
        break;
      case '--no-watch':
        options.noWatch = true;
        break;
      case '--branch': {
        if (i + 1 >= argv.length) fail('--branch 缺少分支名参数');
        options.branch = argv[i + 1];
        i += 1;
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        fail(`未知参数：${arg}\n可用参数：--patch --minor --major --yes --note "..." --no-push --no-watch --branch <名字> --help`);
    }
  }

  if (options.noPush && options.noWatch) {
    // 允许同时传，语义一致：不推送也不盯 CI。
  }

  return options;
}

function printHelp() {
  log(`AI 桌面宠物 一键发版脚本

用法：
  node deploy/release.mjs --patch --yes --note "发布说明" --no-watch
  node deploy/release.mjs --minor --yes
  node deploy/release.mjs --major --yes --no-push
  node deploy/release.mjs              # 手动交互

参数：
  --patch / --minor / --major  指定升哪一位
  --yes                        跳过确认（非交互模式必须加）
  --note "..."                 发布说明（写入 commit 与 annotated tag）
  --no-push                    只提交 + 打 tag，不推送、不盯 CI
  --no-watch                   正常推送，但不轮询 CI
  --branch <名字>              允许在非 main 分支发版（须与当前分支一致）
  --help                       显示本帮助`);
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    fail(`根 package.json 的 version 不是合法的 SemVer（a.b.c）：${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function bumpVersion(version, level) {
  const current = parseVersion(version);
  let next;
  switch (level) {
    case 'major':
      next = { major: current.major + 1, minor: 0, patch: 0 };
      break;
    case 'minor':
      next = { major: current.major, minor: current.minor + 1, patch: 0 };
      break;
    case 'patch':
      next = { major: current.major, minor: current.minor, patch: current.patch + 1 };
      break;
    default:
      fail(`未知的升版位：${level}`);
  }
  return `${next.major}.${next.minor}.${next.patch}`;
}

function readRootVersion() {
  const file = path.join(PROJECT_ROOT, 'package.json');
  if (!existsSync(file)) {
    fail('项目根缺少 package.json（应用固定读取它的 version）。请先创建只含 name/version 的 package.json。');
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`无法解析根 package.json：${error.message}`);
  }
  if (typeof data.version !== 'string' || !data.version.trim()) {
    fail('根 package.json 缺少 version 字段');
  }
  return data.version.trim();
}

function currentBranchOrFail() {
  const branch = gitOrFail(['rev-parse', '--abbrev-ref', 'HEAD'], '无法读取当前分支');
  if (!branch || branch === 'HEAD') {
    fail('当前处于游离 HEAD 状态，无法发版');
  }
  return branch;
}

function validateRepository() {
  const inside = runGit(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    fail('当前目录不是 git 仓库');
  }

  const status = gitOrFail(
    ['status', '--porcelain', '--untracked-files=no'],
    '无法检查工作区状态',
  );
  if (status) {
    fail(`工作区有未提交的改动，请先处理后再发版：\n${status}`);
  }

  const branch = currentBranchOrFail();
  return branch;
}

function validateBranch(branch, requestedBranch) {
  if (branch !== MAIN_BRANCH && !requestedBranch) {
    fail(`当前分支为 ${branch}，默认只允许在 ${MAIN_BRANCH} 分支发版。\n如确需在此分支发版，请加 --branch ${branch}`);
  }
  if (requestedBranch && requestedBranch !== branch) {
    fail(`--branch ${requestedBranch} 与当前分支 ${branch} 不一致`);
  }
}

function resolveTagExists(tag) {
  const local = runGit(['tag', '-l', tag]);
  if (local.status === 0 && local.stdout.trim()) {
    fail(`本地已存在 tag ${tag}，请换一个版本号或先确认该 tag 是否已发布`);
  }

  const remoteUrlResult = runGit(['remote', 'get-url', 'origin']);
  if (remoteUrlResult.status !== 0 || !remoteUrlResult.stdout.trim()) {
    return { hasRemote: false };
  }

  const remote = runGit(['ls-remote', '--tags', 'origin', tag], { timeout: 15000 });
  if (remote.error && remote.error.code === 'ETIMEDOUT') {
    return { hasRemote: true, checkFailed: '查询远端 tag 超时' };
  }
  if (remote.status !== 0) {
    return {
      hasRemote: true,
      checkFailed: (remote.stderr || remote.stdout || 'git ls-remote 执行失败').trim(),
    };
  }
  const found = (remote.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => line.endsWith(`refs/tags/${tag}`));
  if (found) {
    fail(`远端已存在 tag ${tag}，不能覆盖已发布版本`);
  }
  return { hasRemote: true };
}

function findLastVersionTag() {
  const result = runGit(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return null;
}

function buildDefaultNote(tag) {
  const lastTag = findLastVersionTag();
  let subject = '';
  if (lastTag) {
    const result = runGit(['log', '-1', '--pretty=%s', `${lastTag}..HEAD`]);
    if (result.status === 0) subject = result.stdout.trim();
  }
  if (!subject) {
    const result = runGit(['log', '-1', '--pretty=%s']);
    if (result.status === 0) subject = result.stdout.trim();
  }
  return subject || `${tag} 发布`;
}

function replaceTomlProjectVersion(text, version) {
  const lines = text.split('\n');
  let inProject = false;
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (section) {
      inProject = section[1].trim() === 'project';
      continue;
    }
    if (inProject && /^\s*version\s*=\s*"[^"]*"\s*$/.test(lines[i])) {
      lines[i] = lines[i].replace(/^(\s*version\s*=\s*")[^"]*(")/, `$1${version}$2`);
      replaced = true;
      break;
    }
  }
  return replaced ? lines.join('\n') : null;
}

function updateVersionFiles(nextVersion) {
  const changed = [];

  for (const target of VERSION_TARGETS) {
    const absolute = path.join(PROJECT_ROOT, target.rel);
    if (!existsSync(absolute)) {
      if (target.required) {
        fail(`缺少必需文件：${target.rel}`);
      }
      continue;
    }

    const before = readFileSync(absolute, 'utf8');
    let after = before;

    if (target.kind === 'json' || target.kind === 'lock') {
      let data;
      try {
        data = JSON.parse(before);
      } catch (error) {
        fail(`无法解析 ${target.rel}：${error.message}`);
      }
      data.version = nextVersion;
      if (target.kind === 'lock' && data.packages && data.packages['']) {
        data.packages[''].version = nextVersion;
      }
      after = `${JSON.stringify(data, null, 2)}\n`;
    } else if (target.kind === 'toml') {
      const replaced = replaceTomlProjectVersion(before, nextVersion);
      if (replaced === null) {
        warn(`${target.rel} 中未找到 [project] version，已跳过`);
        continue;
      }
      after = replaced;
    } else if (target.kind === 'python') {
      if (!/__version__\s*=\s*['"][^'"]*['"]/.test(before)) {
        warn(`${target.rel} 中未找到 __version__，已跳过`);
        continue;
      }
      after = before.replace(
        /(__version__\s*=\s*)(['"])[^'"]*\2/,
        (_all, prefix, quote) => `${prefix}${quote}${nextVersion}${quote}`,
      );
    }

    if (after !== before) {
      writeFileSync(absolute, after, 'utf8');
      changed.push(target.rel);
    }
  }

  if (changed.length === 0) {
    fail('没有需要更新的版本文件（检查 package.json 是否缺少 version）');
  }

  // 根 package.json 是应用读取版本号的硬契约，更新后再校验一次。
  const rootVersion = readRootVersion();
  if (rootVersion !== nextVersion) {
    fail(`根 package.json 版本更新失败：期望 ${nextVersion}，实际 ${rootVersion}`);
  }
  return changed;
}

function ensureExecutableTagMessage(tag, note) {
  const normalized = String(note).replace(/\r\n?/g, '\n').trim();
  return `${tag}：${normalized}`;
}

async function askQuestions(options, currentVersion, makePreview) {
  if (!input.isTTY) {
    if (!options.level) {
      fail('非交互模式必须指定 --patch/--minor/--major');
    }
    fail('非交互模式必须加 --yes（避免脚本等待确认输入）');
  }
  const rl = createInterface({ input, output });
  try {
    let level = options.level;
    if (!level) {
      while (true) {
        const answer = (
          await rl.question(`当前版本 ${currentVersion}，升哪一位？(patch/minor/major，回车=patch) `)
        )
          .trim()
          .toLowerCase();
        if (!answer) {
          level = 'patch';
          break;
        }
        if (LEVELS.includes(answer)) {
          level = answer;
          break;
        }
        log('请输入 patch / minor / major。');
      }
    }

    const nextVersion = bumpVersion(currentVersion, level);
    const tag = `v${nextVersion}`;
    let note = options.note === null ? '' : options.note.trim();
    if (!note) {
      const defaultNote = buildDefaultNote(tag);
      const answer = await rl.question(`发布说明（回车使用「${defaultNote}」）：`);
      note = answer.trim() || defaultNote;
    }

    const preview = makePreview({ level, nextVersion, tag, note });
    log('\n即将执行：');
    log(preview);

    if (!options.yes) {
      const answer = (await rl.question('\n确认发版？(y/N) ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        log('已取消发版。');
        process.exit(0);
      }
    }

    return { level, nextVersion, tag, note };
  } finally {
    rl.close();
  }
}

function resolveNonInteractive(options, currentVersion) {
  if (!options.level) {
    fail('非交互模式必须指定 --patch/--minor/--major');
  }
  if (!options.yes) {
    fail('非交互模式必须加 --yes（避免脚本等待确认输入）');
  }
  const nextVersion = bumpVersion(currentVersion, options.level);
  const tag = `v${nextVersion}`;
  const note = options.note === null ? buildDefaultNote(tag) : options.note.trim();
  return {
    level: options.level,
    nextVersion,
    tag,
    note: note || buildDefaultNote(tag),
  };
}

function commitAndTag({ tag, note, changedFiles, noPush }) {
  const message = ensureExecutableTagMessage(tag, note);

  log(`\n· 更新版本文件：${changedFiles.join('、')}`);
  gitOrFail(['add', '--', ...changedFiles], 'git add 失败');
  gitOrFail(['commit', '-m', message], 'git commit 失败');
  log(`· 已提交：${message}`);

  gitOrFail(['tag', '-a', tag, '-m', message], `创建 annotated tag ${tag} 失败`);
  log(`· 已创建 annotated tag：${tag}`);

  if (noPush) {
    log('\n--no-push：已停止，未推送、未盯 CI。');
    return;
  }

  log('\n· 推送提交与 tag（git push --follow-tags）…');
  gitOrFail(['push', '--follow-tags'], 'git push 失败');
  log('· 推送完成。');
}

function parseGitHubRepo(remoteUrl) {
  if (!remoteUrl) return null;
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
}

async function watchCi(sha) {
  if (typeof fetch !== 'function') {
    warn('当前 Node.js 不支持 fetch，跳过 CI 监视');
    return 0;
  }

  const remoteUrl = runGit(['remote', 'get-url', 'origin']);
  const repo = remoteUrl.status === 0 ? parseGitHubRepo(remoteUrl.stdout) : null;
  if (!repo) {
    warn('未识别出 GitHub 仓库地址，跳过 CI 监视');
    return 0;
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ai-desktop-pet-release-script',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const startedAt = Date.now();
  const startDeadline = startedAt + 2 * 60 * 1000;
  const overallDeadline = startedAt + 10 * 60 * 1000;
  let run = null;

  log(`\n· 正在等待 GitHub Actions 启动（仓库 ${repo}）…`);
  while (!run && Date.now() < startDeadline) {
    await sleep(10000);
    let response;
    try {
      response = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=10`,
        { headers },
      );
    } catch (error) {
      warn(`查询 GitHub Actions 失败：${error.message}，跳过监视`);
      return 0;
    }
    if (!response.ok) {
      warn(`查询 GitHub Actions 失败（HTTP ${response.status}），跳过监视`);
      return 0;
    }
    const data = await response.json();
    run = (data.workflow_runs || []).find((item) => item.head_sha === sha) || null;
    if (!run) log('  暂未发现运行记录，继续等待…');
  }

  if (!run) {
    warn('未发现与本次提交关联的 Actions 运行（可能尚未配置 workflow），跳过监视');
    return 0;
  }

  log(`· 已找到 CI 运行：${run.html_url}`);
  const statusNames = {
    queued: '排队中',
    in_progress: '运行中',
    completed: '已完成',
    waiting: '等待中',
    requested: '已请求',
    pending: '待处理',
  };
  const conclusionNames = {
    success: '成功',
    failure: '失败',
    cancelled: '已取消',
    skipped: '已跳过',
    timed_out: '超时',
    neutral: '中性',
    action_required: '需要处理',
    stale: '已过期',
  };

  while (Date.now() < overallDeadline) {
    let response;
    try {
      response = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs/${run.id}`,
        { headers },
      );
    } catch (error) {
      warn(`查询 CI 状态失败：${error.message}，跳过监视`);
      return 0;
    }
    if (!response.ok) {
      warn(`查询 CI 状态失败（HTTP ${response.status}），跳过监视`);
      return 0;
    }
    const data = await response.json();
    if (data.status === 'completed') {
      const conclusion = data.conclusion || 'unknown';
      const label = conclusionNames[conclusion] || conclusion;
      if (conclusion === 'success') {
        log(`\n✅ CI 已完成：${label}`);
        return 0;
      }
      console.error(`\n❌ CI 已完成：${label}（${data.html_url}）`);
      return 1;
    }
    log(`  CI 状态：${statusNames[data.status] || data.status}`);
    await sleep(15000);
  }

  warn('等待 CI 超时（10 分钟），请到 GitHub Actions 页面查看结果');
  return 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }

  log('== AI 桌面宠物 一键发版 ==');

  const branch = validateRepository();
  validateBranch(branch, options.branch);
  log(`· 当前分支：${branch}`);

  const currentVersion = readRootVersion();
  log(`· 当前版本：${currentVersion}`);

  const makePreview = ({ level, nextVersion, tag, note }) => {
    const message = ensureExecutableTagMessage(tag, note);
    const lines = [
      `  升版位：${level}`,
      `  版本：${currentVersion} → ${nextVersion}`,
      `  更新文件：根 package.json、frontend/package.json、frontend/package-lock.json、backend/pyproject.toml、backend/__init__.py`,
      `  git commit -m "${message}"`,
      `  git tag -a ${tag} -m "${message}"`,
    ];
    if (options.noPush) {
      lines.push('  不推送（--no-push）');
    } else {
      lines.push('  git push --follow-tags');
      lines.push(options.noWatch ? '  不盯 CI（--no-watch）' : '  轮询 GitHub Actions');
    }
    return lines.join('\n');
  };

  let selection;
  if (options.level && options.yes) {
    selection = resolveNonInteractive(options, currentVersion);
  } else {
    selection = await askQuestions(options, currentVersion, makePreview);
  }

  const { tag, note, nextVersion } = selection;
  if (!note) fail('发布说明不能为空');

  // 推送前必须确认 tag 不存在；--no-push 时远端查询失败只警告。
  const remoteCheck = resolveTagExists(tag);
  if (remoteCheck.checkFailed) {
    if (options.noPush) {
      warn(`无法确认远端是否已有 tag ${tag}：${remoteCheck.checkFailed}`);
    } else {
      fail(`无法确认远端 tag 是否已存在，已中止：${remoteCheck.checkFailed}`);
    }
  }
  if (!remoteCheck.hasRemote) {
    if (options.noPush) {
      warn('未配置 origin 远端，跳过远端 tag 检查');
    } else {
      fail('未配置 origin 远端，无法推送');
    }
  }

  const changedFiles = updateVersionFiles(nextVersion);
  commitAndTag({ tag, note, changedFiles, noPush: options.noPush });

  if (!options.noPush && !options.noWatch) {
    const sha = gitOrFail(['rev-parse', 'HEAD'], '无法读取提交 SHA');
    return watchCi(sha);
  }

  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(`[错误] ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  });
