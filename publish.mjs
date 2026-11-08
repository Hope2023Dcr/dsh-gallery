#!/usr/bin/env node
/**
 * GitHub 发布助手
 *
 * 用法：
 *   node publish.mjs              # 交互式：检查环境 → 初始化仓库 → 提交 → 提示推送
 *   node publish.mjs --check      # 只检查，不改动任何东西
 *
 * 会做的事：
 *   1. 检查本机 git 可用、GitHub 可达
 *   2. 初始化 git 仓库（如果还没有）
 *   3. 检查 .gitignore 覆盖了不该提交的东西
 *   4. 检查没有敏感信息（本机路径、token、密码）
 *   5. 创建首次提交
 *   6. 打印后续推送步骤（不自动推送，避免误操作）
 *
 * 不自动 push —— 推送需要你的 GitHub 凭据，请手动确认后执行脚本打印出的命令。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'Hope2023Dcr/dsh-gallery'
const REMOTE = `https://github.com/${REPO}.git`
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
}
const ok = (m) => console.log(`  ${C.green}✓${C.reset} ${m}`)
const bad = (m) => console.log(`  ${C.red}✗${C.reset} ${m}`)
const warn = (m) => console.log(`  ${C.yellow}!${C.reset} ${m}`)
const info = (m) => console.log(`  ${C.dim}${m}${C.reset}`)
const step = (n, m) => console.log(`\n${C.bold}${C.blue}[${n}]${C.reset} ${C.bold}${m}${C.reset}`)

function run (cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: HERE, encoding: 'utf8', ...opts }).trim()
}

function tryRun (cmd, args, opts = {}) {
  try {
    return { ok: true, out: run(cmd, args, opts) }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status }
  }
}

let failures = 0
const fail = (m) => { bad(m); failures++ }

console.log(`${C.bold}${C.cyan}产出画廊 · GitHub 发布助手${C.reset}`)
console.log(`${C.dim}仓库：${REPO}${C.reset}`)
if (checkOnly) console.log(`${C.yellow}（检查模式：不会改动任何文件）${C.reset}`)

// ---------- 1. 环境检查 ----------
step(1, '环境检查')

const git = tryRun('git', ['--version'])
if (git.ok) ok(`git 可用：${git.out}`)
else fail('找不到 git，请先安装 Git')

const ghReach = tryRun('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', 'https://github.com'])
if (ghReach.ok && ghReach.out.startsWith('2')) ok('github.com 可达')
else warn('github.com 可能不可达（推送时若失败，按仓库里配置的镜像方案处理）')

// ---------- 2. 必需文件 ----------
step(2, '必需文件检查')

const REQUIRED = [
  'README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md',
  '.gitignore', 'package.json', 'index.js', 'client.js', 'session-index.js',
  'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'install.mjs',
]
for (const f of REQUIRED) {
  if (fs.existsSync(path.join(HERE, f))) ok(f)
  else fail(`缺少 ${f}`)
}

const OPTIONAL = [
  'docs/architecture.png', 'RELEASE.md',
  '.github/workflows/check.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/pull_request_template.md',
]
for (const f of OPTIONAL) {
  if (fs.existsSync(path.join(HERE, f))) ok(f)
  else warn(`建议补充 ${f}`)
}

// ---------- 3. 敏感信息扫描 ----------
step(3, '敏感信息扫描')

const SKIP_DIRS = new Set(['.git', 'node_modules'])
function walk (dir, base, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, base, out)
    else out.push(full)
  }
  return out
}

const TEXT_EXT = new Set(['.md', '.js', '.mjs', '.json', '.yml', '.yaml', '.svg', '.txt', '.py'])
const files = walk(HERE, HERE).filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()))

const SECRETS = [
  { name: 'GitHub Token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: '通用 Token 字段', re: /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}/i },
  { name: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '本机用户名路径', re: /C:[\\/]+Users[\\/]+(?!Public|Default)[A-Za-z0-9_-]+/ },
  { name: '本机盘符产出目录', re: /[A-Z]:[\\/]+DSH产出/ },
]

let secrets = 0
for (const f of files) {
  const rel = path.relative(HERE, f)
  // .gitignore 里的示例、README/CONTRIBUTING 里的说明，允许出现
  const isDoc = /^(README|CHANGELOG|CONTRIBUTING|RELEASE)\.md$/.test(rel) || rel === '.gitignore'
  // 本脚本自身含检测用的正则字面量，扫自己会自指误报，跳过
  if (path.basename(f) === 'publish.mjs') continue
  const text = fs.readFileSync(f, 'utf8')
  text.split('\n').forEach((line, i) => {
    for (const s of SECRETS) {
      if (s.re.test(line)) {
        // 文档里作为「反面示例」出现是允许的（那一行通常带 ❌ 或「错误」字样）
        const isExample = isDoc && /❌|错误|不要|禁止|示例|例如|✅/.test(line)
        if (!isExample) {
          bad(`${rel}:${i + 1} 疑似 ${s.name}`)
          info(line.trim().slice(0, 90))
          secrets++
        }
      }
    }
  })
}
if (secrets === 0) ok('未发现敏感信息')

// ---------- 4. git 仓库状态 ----------
step(4, 'git 仓库状态')

const isRepo = fs.existsSync(path.join(HERE, '.git'))
if (isRepo) {
  ok('已是 git 仓库')
} else if (checkOnly) {
  warn('尚未初始化 git 仓库（正式运行时会自动初始化）')
} else {
  const init = tryRun('git', ['init', '-b', 'main'])
  if (init.ok) ok('已初始化 git 仓库（分支 main）')
  else fail('git init 失败')
}

if (isRepo || (!checkOnly && fs.existsSync(path.join(HERE, '.git'))) ) {
  const st = tryRun('git', ['status', '--porcelain'])
  if (st.ok) {
    const changed = st.out.split('\n').filter(Boolean)
    info(`待提交变更：${changed.length} 个文件`)
    // 检查会把不该提交的东西带进来
    const suspicious = changed.filter((l) => /node_modules|\/releases\/|\.zip$|gallery\.json/.test(l))
    if (suspicious.length > 0) {
      fail('以下文件本不该提交，请检查 .gitignore：')
      for (const s of suspicious.slice(0, 10)) info('  ' + s)
    } else if (changed.length > 0) {
      ok('.gitignore 生效，没有混入不该提交的文件')
    }
  }
}

// ---------- 5. 远端配置 ----------
step(5, '远端配置')

if (isRepo || (!checkOnly && fs.existsSync(path.join(HERE, '.git'))) ) {
  const remotes = tryRun('git', ['remote', '-v'])
  if (remotes.ok && remotes.out.includes('origin')) {
    ok('已配置 origin')
    info(remotes.out.split('\n')[0])
  } else if (!checkOnly) {
    const add = tryRun('git', ['remote', 'add', 'origin', REMOTE])
    if (add.ok) ok(`已添加 origin → ${REMOTE}`)
    else { warn('添加 origin 失败（可能已存在）') }
  } else {
    warn('尚未配置 origin')
  }
}

// ---------- 6. 首次提交 ----------
step(6, '首次提交')

if (checkOnly) {
  info('检查模式，跳过提交')
} else if (!fs.existsSync(path.join(HERE, '.git'))) {
  warn('仓库未初始化，跳过')
} else {
  const hasCommits = tryRun('git', ['rev-parse', '--verify', 'HEAD'])
  if (hasCommits.ok) {
    info('已有提交历史，跳过首次提交')
  } else {
    const add = tryRun('git', ['add', '-A'])
    if (!add.ok) fail('git add 失败')
    else {
      const commit = tryRun('git', [
        'commit', '-m',
        '初始提交：产出画廊 v0.4.0\n\n' +
        'DSH 右侧栏产出画廊插件。图片自动刷新 / 缩放拖动 / 文件原生侧栏预览 /\n' +
        '全局资产与当前对话分类 / 产出根目录可配置（三级优先 + 面板内直接改）。\n' +
        '零第三方依赖。'
      ])
      if (commit.ok) {
        ok('已创建首次提交')
        info(run('git', ['log', '--oneline', '-1']))
      } else if (/nothing to commit/.test(commit.out)) {
        info('没有待提交内容')
      } else {
        // 可能是没配 user.name / user.email
        if (/Please tell me who you are|user\.email|user\.name/.test(commit.out)) {
          fail('git 未配置作者信息，请先执行：')
          info('  git config --global user.name "你的名字"')
          info('  git config --global user.email "你的邮箱"')
        } else {
          fail('git commit 失败')
          info(commit.out.split('\n').slice(0, 3).join('\n  '))
        }
      }
    }
  }
}

// ---------- 7. 后续步骤 ----------
step(7, '后续步骤')

const branch = (() => {
  if (!fs.existsSync(path.join(HERE, '.git'))) return 'main'
  const r = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.ok ? r.out : 'main'
})()

console.log('')
info(`当前分支：${branch}`)
console.log('')
console.log(`${C.bold}如果 GitHub 上还没建仓库：${C.reset}`)
info(`1. 打开 https://github.com/new`)
info(`2. 仓库名填 dsh-gallery`)
info(`3. 选 Public（公开）`)
info(`4. 不要勾选 "Add a README"（本地已有）`)
info(`5. 创建`)

console.log('')
console.log(`${C.bold}如果还没配推送凭据（二选一）：${C.reset}`)
info('A. 用 PAT（推荐，跨平台稳定）')
info('   1) 打开 https://github.com/settings/tokens')
info('   2) Generate new token (classic) → 勾选 repo 权限 → 生成并复制')
info('   3) 推送时用户名填 GitHub 用户名，密码粘贴 PAT')
info('B. 用 SSH')
info('   ssh-keygen -t ed25519 -C "你的邮箱"')
info('   然后把 ~/.ssh/id_ed25519.pub 内容加到 https://github.com/settings/keys')
info(`   git remote set-url origin git@github.com:${REPO}.git`)

console.log('')
console.log(`${C.bold}推送：${C.reset}`)
info(`git push -u origin ${branch}`)

console.log('')
console.log(`${C.bold}推送后去发 Release：${C.reset}`)
info(`1. 打包：按 package.json 的 files 白名单 + install.mjs 打成一个 zip（务必含 session-index.js）`)
info(`2. 打开 https://github.com/${REPO}/releases/new`)
info(`3. Tag 填 v${VERSION}（取自 package.json，别再写死 v0.4.0）`)
info(`4. 上传 zip`)
info(`5. 把 RELEASE.md 的内容粘进发布说明`)

// ---------- 结果 ----------
console.log('')
if (failures === 0) {
  console.log(`${C.green}${C.bold}✓ 准备就绪${C.reset} ${C.dim}（${checkOnly ? '检查完成，未改动文件' : '可以推送了'}）${C.reset}`)
} else {
  console.log(`${C.red}${C.bold}✗ 有 ${failures} 个问题需要先解决${C.reset}`)
  process.exit(1)
}
