#!/usr/bin/env node
/**
 * dsh-gallery · 本地目录安装脚本（幂等、非交互、跨平台）
 *
 *   node install.mjs                    # 自动选 profile 并安装
 *   node install.mjs --profile desktop  # 指定 profile
 *   node install.mjs --dry-run          # 只打印将要做什么，不写任何文件
 *
 * 行为：定位 DSH_HOME（默认 ~/.dsh）→ 选 profile → 校验源文件 →
 * 复制插件文件 → 在 <profile>/package.json 的 dsh.profile.bundles 注册 →
 * 首次注册前备份 package.json。装完必须完全重启 DSH。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const SOURCE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const flagValue = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const wantedProfile = flagValue('--profile')

const fail = (message) => {
  console.error('[dsh-gallery 安装失败] ' + message)
  process.exit(1)
}
const log = (message) => console.log((dryRun ? '[预演] ' : '') + message)

const home = process.env.DSH_HOME
  ? path.resolve(process.env.DSH_HOME)
  : path.join(os.homedir(), '.dsh')
const profilesDir = path.join(home, 'profiles')

if (!fs.existsSync(profilesDir)) fail('找不到 profiles 目录：' + profilesDir)
const profiles = fs.readdirSync(profilesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
if (profiles.length === 0) fail('profiles 目录是空的：' + profilesDir)

const profile = wantedProfile
  ?? (profiles.length === 1 ? profiles[0] : (profiles.includes('desktop') ? 'desktop' : profiles[0]))
if (!profiles.includes(profile)) {
  fail('profile「' + profile + '」不存在。可用：' + profiles.join('、'))
}

const profileDir = path.join(profilesDir, profile)
const profilePkgPath = path.join(profileDir, 'package.json')
const targetDir = path.join(profileDir, 'node_modules', 'dsh-gallery')
if (!fs.existsSync(profilePkgPath)) fail('profile 缺少 package.json：' + profilePkgPath)

// 源侧必需文件
const requiredFiles = [
  'index.js', 'client.js', 'session-index.js', 'package.json',
  'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE', 'CHANGELOG.md',
]
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(SOURCE, file))) fail('源文件缺失：' + file)
}
for (const dir of ['host', 'locale']) {
  if (!fs.existsSync(path.join(SOURCE, dir))) fail('源目录缺失：' + dir + '/')
}

// 复制清单：根文件 + 整个 host/ + locale/ + 可选 docs/screenshots/
const entries = [
  ...requiredFiles.map((file) => ({ from: path.join(SOURCE, file), to: path.join(targetDir, file), kind: 'file' })),
  { from: path.join(SOURCE, 'host'), to: path.join(targetDir, 'host'), kind: 'dir' },
  { from: path.join(SOURCE, 'locale'), to: path.join(targetDir, 'locale'), kind: 'dir' },
]
const shots = path.join(SOURCE, 'docs', 'screenshots')
if (fs.existsSync(shots)) {
  entries.push({ from: shots, to: path.join(targetDir, 'docs', 'screenshots'), kind: 'dir' })
}

// 注册位置：dsh.profile.bundles（不是顶层 bundles）
const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
const bundles = profilePkg.dsh?.profile?.bundles
const alreadyRegistered = Array.isArray(bundles) && bundles.includes('dsh-gallery')
const backupPath = path.join(profileDir, 'package.json.bak-dsh-gallery')
const dep = profilePkg.dependencies?.['dsh-gallery']

log('DSH 主目录：' + home)
log('profile：' + profile + '（' + profileDir + '）')
log('安装目标：' + targetDir)
log('复制：' + entries.length + ' 项（' + requiredFiles.join('、') + '、host/、locale/' + (fs.existsSync(shots) ? '、docs/screenshots/' : '') + '）')
log('注册：' + (alreadyRegistered ? '已注册，跳过' : '写入 dsh.profile.bundles'))
log('备份：' + (fs.existsSync(backupPath) ? '已存在，保留不覆盖' : '首次注册前备份 → ' + backupPath))

if (dep && String(dep).startsWith('file:')) {
  console.warn('[提醒] profile 依赖里 dsh-gallery 是 file: 本地路径（' + dep + '）。')
  console.warn('       如果它指向的不是本脚本所在目录，重启 DSH 时包管理器可能把这里的文件覆盖掉。')
  console.warn('       建议改成 npm 版本，或确认 file: 路径一致。')
}

if (dryRun) {
  console.log('[预演结束] 未写入任何文件。')
  process.exit(0)
}

function copyEntry(entry) {
  if (entry.kind === 'file') {
    fs.mkdirSync(path.dirname(entry.to), { recursive: true })
    fs.copyFileSync(entry.from, entry.to)
    return 1
  }
  let count = 0
  fs.mkdirSync(entry.to, { recursive: true })
  for (const item of fs.readdirSync(entry.from, { withFileTypes: true })) {
    const from = path.join(entry.from, item.name)
    const to = path.join(entry.to, item.name)
    count += copyEntry({ from, to, kind: item.isDirectory() ? 'dir' : 'file' })
  }
  return count
}

// 先备份，再复制，最后注册 —— 任一步失败，原 package.json 都留有回退点
if (!fs.existsSync(backupPath)) fs.copyFileSync(profilePkgPath, backupPath)

let copied = 0
for (const entry of entries) copied += copyEntry(entry)
log('已复制 ' + copied + ' 个文件')

if (!alreadyRegistered) {
  profilePkg.dsh ??= {}
  profilePkg.dsh.profile ??= {}
  profilePkg.dsh.profile.bundles ??= []
  profilePkg.dsh.profile.bundles.push('dsh-gallery')
  fs.writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n', 'utf8')
  log('已写入 dsh.profile.bundles')
}

console.log('[dsh-gallery] 安装完成。请完全退出 DSH 再打开（刷新页面不够）。')
