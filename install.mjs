#!/usr/bin/env node
/**
 * 产出画廊 —— 一键安装脚本
 *
 * 用法：
 *   node install.mjs                    # 自动找 DSH profile 并安装
 *   node install.mjs --profile desktop  # 指定 profile 名
 *   node install.mjs --dry-run          # 只看会做什么，不实际写入
 *
 * 它会做三件事：
 *   1. 按 package.json 的 files 白名单，把插件文件复制到
 *      <DSH_HOME>/profiles/<profile>/node_modules/dsh-gallery/
 *   2. 在 profile 的 package.json 的 bundles 数组里加入 "dsh-gallery"
 *   3. 提示你重启 DSH（Host 半部必须重启才加载）
 *
 * ⚠️ 为什么是白名单而不是整目录递归（S0 起）：
 *   仓库里还会有 src/、scripts/、tests/、docs/、packages/、.git 等开发文件，
 *   递归复制会把它们全装进用户机器。files 是唯一真源，install 与 npm pack 共用。
 *
 * 不依赖任何第三方包。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'dsh-gallery'
const PKG_DIR_NAME = 'dsh-gallery'

/** 安装后必须存在的文件（少一个插件就跑不起来） */
export const REQUIRED = [
  'package.json', 'index.js', 'client.js', 'session-index.js', 'cordis.patch.yml',
  'host/http.js', 'host/constants.js', 'host/settings.js', 'host/scan.js',
  'host/session.js', 'host/classify.js', 'host/groups.js', 'host/media.js',
  'host/fsutil.js', 'host/session-index.js', 'host/protocol.js',
]

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 展开 package.json 的 files 白名单为具体文件路径列表。
 * 支持单段通配（如 locale/*.json、host/*.js），不支持 ** 递归 —— 发布目录是扁平的。
 * 返回 { files, missing, optionalMissing, patterns }
 *   missing         : 精确声明的文件不存在 → 必须报错
 *   optionalMissing : 通配目录尚不存在（如 S1 之前的 host/）→ 允许，静默跳过
 */
export function collectFromWhitelist (root, patterns) {
  const list = patterns ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('package.json 缺少 files 白名单')
  }

  const picked = []
  const missing = []
  const optionalMissing = []

  for (const raw of list) {
    const p = String(raw).replace(/\\/g, '/')
    if (!p.includes('*')) {
      if (fs.existsSync(path.join(root, p))) picked.push(p)
      else missing.push(p)
      continue
    }
    const slash = p.lastIndexOf('/')
    const dir = slash >= 0 ? p.slice(0, slash) : ''
    const baseGlob = slash >= 0 ? p.slice(slash + 1) : p
    const dirAbs = path.join(root, dir)
    if (!fs.existsSync(dirAbs)) {
      optionalMissing.push(p)
      continue
    }
    const re = new RegExp('^' + baseGlob.split('*').map(escapeRe).join('.*') + '$')
    const hits = fs.readdirSync(dirAbs)
      .filter((name) => re.test(name) && fs.statSync(path.join(dirAbs, name)).isFile())
      .map((name) => (dir ? `${dir}/${name}` : name))
      .sort()
    if (hits.length === 0) optionalMissing.push(p)
    picked.push(...hits)
  }

  // package.json 通常不写进 files（npm 会自动带上），但 install 是「按 files 复制」，
  // 不显式补上会导致安装目录缺清单文件、DSH 加载器直接找不到插件。
  if (fs.existsSync(path.join(root, 'package.json')) && !picked.includes('package.json')) {
    picked.push('package.json')
  }

  return {
    files: [...new Set(picked)].sort(),
    missing,
    optionalMissing,
    patterns: list,
  }
}

function fail (message, hint) {
  console.error('\n✗ ' + message)
  if (hint) console.error('  ' + hint)
  process.exit(1)
}

function note (message) { console.log('  ' + message) }
function step (n, message) { console.log(`\n[${n}] ${message}`) }

function main () {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const profileArgIndex = argv.indexOf('--profile')
  const profileName = profileArgIndex >= 0 ? argv[profileArgIndex + 1] : null

  // ---------- 1. 定位 DSH_HOME ----------
  step(1, '定位 DSH 主目录')
  const home = os.homedir()
  const dshHome = process.env.DSH_HOME ?? path.join(home, '.dsh')
  if (!fs.existsSync(dshHome)) {
    fail(`找不到 DSH 主目录：${dshHome}`,
      '请确认 DSH 已安装并至少启动过一次；或用环境变量 DSH_HOME 指定主目录。')
  }
  note('DSH_HOME = ' + dshHome)

  // ---------- 2. 选 profile ----------
  step(2, '选择 profile')
  const profilesDir = path.join(dshHome, 'profiles')
  if (!fs.existsSync(profilesDir)) {
    fail(`找不到 profiles 目录：${profilesDir}`, 'DSH 可能还没初始化，先启动一次再回来。')
  }
  const available = fs.readdirSync(profilesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(profilesDir, name, 'package.json')))
  if (available.length === 0) {
    fail('profiles 目录下没有可用的 profile（每个 profile 需要有 package.json）')
  }

  let chosen
  if (profileName !== null) {
    if (!available.includes(profileName)) {
      fail(`profile "${profileName}" 不存在`, `可用的：${available.join(', ')}`)
    }
    chosen = profileName
  } else {
    chosen = available.includes('desktop') ? 'desktop' : available[0]
    if (available.length > 1) {
      note(`检测到多个 profile：${available.join(', ')}`)
      note(`默认选 "${chosen}"（可用 --profile 指定其他）`)
    }
  }
  note('使用 profile = ' + chosen)

  const profileDir = path.join(profilesDir, chosen)
  const targetDir = path.join(profileDir, 'node_modules', PKG_DIR_NAME)

  // ---------- 3. 校验源文件（按白名单） ----------
  step(3, '校验插件源文件（files 白名单）')
  const here = path.dirname(fileURLToPath(import.meta.url))
  let plan
  try {
    plan = collectFromWhitelist(here)
  } catch (error) {
    fail('无法读取 files 白名单：' + String(error?.message ?? error),
      '请在插件根目录运行本脚本（package.json 所在目录）。')
  }
  if (plan.missing.length > 0) {
    fail('白名单声明的文件缺失：' + plan.missing.join(', '))
  }
  const notInstalled = REQUIRED.filter((f) => !plan.files.includes(f))
  if (notInstalled.length > 0) {
    fail('必需文件不在白名单里：' + notInstalled.join(', '),
      '请把它们加进 package.json 的 files，否则装完插件会加载失败。')
  }
  note(`${plan.patterns.length} 条白名单 → ${plan.files.length} 个文件`)
  if (plan.optionalMissing.length > 0) {
    note('本阶段未启用的目录（跳过）：' + plan.optionalMissing.join(', '))
  }

  // ---------- 4. 复制文件 ----------
  step(4, '安装插件文件')
  if (dryRun) {
    note(`[dry-run] 将复制到：${targetDir}`)
    for (const f of plan.files) note('  + ' + f)
    note(`[dry-run] 共 ${plan.files.length} 个文件，未做任何修改`)
  } else {
    // 已存在则先清掉，避免旧文件残留（只动插件自己的安装目录）
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true })
      note('已移除旧版本')
    }
    for (const f of plan.files) {
      const src = path.join(here, ...f.split('/'))
      const dst = path.join(targetDir, ...f.split('/'))
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
    }
    note(`已复制 ${plan.files.length} 个文件到：${targetDir}`)
  }

  // ---------- 5. 注册 bundle ----------
  step(5, '在 profile 的 package.json 注册 bundle')
  const profilePkgPath = path.join(profileDir, 'package.json')
  let profilePkg
  try {
    profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
  } catch (error) {
    fail('无法解析 profile 的 package.json：' + String(error?.message ?? error))
  }
  const bundles = Array.isArray(profilePkg.bundles) ? profilePkg.bundles : []
  if (bundles.includes(PLUGIN_NAME)) {
    note('已注册过，跳过')
  } else if (dryRun) {
    note(`[dry-run] 将把 "${PLUGIN_NAME}" 加入 bundles（未写入）`)
  } else {
    const backup = profilePkgPath + '.bak-dsh-gallery'
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(profilePkgPath, backup)
      note('已备份原文件 → ' + path.basename(backup))
    }
    profilePkg.bundles = [...bundles, PLUGIN_NAME]
    fs.writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n', 'utf8')
    note(`已加入 bundles：${PLUGIN_NAME}`)
  }

  // ---------- 完成 ----------
  console.log('')
  if (dryRun) {
    console.log('✓ 检查完成（dry-run，未做任何修改）')
  } else {
    console.log('✓ 安装完成')
    console.log('')
    console.log('⚠️  下一步必须重启 DSH 才会生效')
    console.log('    （不是刷新页面 —— Host 半部只在进程启动时加载）')
    console.log('')
    console.log('重启后打开「产出画廊」面板，如果提示目录不存在，')
    console.log('点面板里的 ⚙ 设置，填入你的产出目录即可（改完立即生效）。')
  }
}

// 被 tests/ 直接 import 时不执行安装逻辑；只有作为 CLI 调用才跑 main()
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
const self = fileURLToPath(import.meta.url)
if (invoked && invoked.toLowerCase() === self.toLowerCase()) main()
