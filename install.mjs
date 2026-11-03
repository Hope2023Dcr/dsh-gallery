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
 *   1. 把当前目录的插件文件复制到 <DSH_HOME>/profiles/<profile>/node_modules/dsh-gallery/
 *   2. 在 profile 的 package.json 的 bundles 数组里加入 "dsh-gallery"
 *   3. 提示你重启 DSH（Host 半部必须重启才加载）
 *
 * 不依赖任何第三方包。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'dsh-gallery'
const PKG_DIR_NAME = 'dsh-gallery'

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const profileArgIndex = argv.indexOf('--profile')
const profileName = profileArgIndex >= 0 ? argv[profileArgIndex + 1] : null

function fail (message, hint) {
  console.error('\n✗ ' + message)
  if (hint) console.error('  ' + hint)
  process.exit(1)
}

function note (message) { console.log('  ' + message) }
function step (n, message) { console.log(`\n[${n}] ${message}`) }

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
  // 优先 desktop，其次第一个
  chosen = available.includes('desktop') ? 'desktop' : available[0]
  if (available.length > 1) {
    note(`检测到多个 profile：${available.join(', ')}`)
    note(`默认选 "${chosen}"（可用 --profile 指定其他）`)
  }
}
note('使用 profile = ' + chosen)

const profileDir = path.join(profilesDir, chosen)
const targetDir = path.join(profileDir, 'node_modules', PKG_DIR_NAME)

// ---------- 3. 校验源文件 ----------
step(3, '校验插件源文件')

// 用 fileURLToPath 处理 Windows 盘符与中文路径，比手写正则可靠
const here = path.dirname(fileURLToPath(import.meta.url))
const required = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml']
const missing = required.filter((f) => !fs.existsSync(path.join(here, f)))
if (missing.length > 0) {
  fail('缺少必要文件：' + missing.join(', '),
    '请在插件根目录运行本脚本（package.json 所在目录）。')
}
note('源文件齐全：' + required.join(', '))

// ---------- 4. 复制文件 ----------
step(4, '安装插件文件')

if (dryRun) {
  note(`[dry-run] 将复制到：${targetDir}`)
} else {
  // 已存在则先清掉，避免旧文件残留
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true })
    note('已移除旧版本')
  }
  fs.mkdirSync(targetDir, { recursive: true })

  const skip = new Set(['install.mjs', 'node_modules', '.git', 'releases'])
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const src = path.join(from, entry.name)
      const dst = path.join(to, entry.name)
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true })
        copy(src, dst)
      } else {
        fs.copyFileSync(src, dst)
      }
    }
  }
  copy(here, targetDir)
  note('已复制到：' + targetDir)
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
} else {
  if (dryRun) {
    note(`[dry-run] will add "${PLUGIN_NAME}" to bundles`)
  } else {
    // 备份一次，方便回滚
    const backup = profilePkgPath + '.bak-dsh-gallery'
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(profilePkgPath, backup)
      note('已备份原文件 → ' + path.basename(backup))
    }
    profilePkg.bundles = [...bundles, PLUGIN_NAME]
    fs.writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n', 'utf8')
    note(`已加入 bundles：${PLUGIN_NAME}`)
  }
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
