/**
 * 设置读写、根目录探测与校验、配置解析。
 *
 * S1 拆分自 index.js（行为零变化）。
 */

import { promises as fsp, readFileSync, statSync, createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS, DEFAULT_SETTINGS_FILE } from './constants.js'
import { arrayOfStrings, numberOr } from './fsutil.js'

/**
 * detectDefaultRoot 的探测结果缓存。
 * 拆分注意点：这是模块级可变状态，必须与使用它的函数放在同一模块，
 * 否则会报 `xxx is not defined`（S1 首次实测就踩了这个）。
 */
let defaultRootCache = null

export function detectDefaultRoot() {
  if (defaultRootCache !== null) return defaultRootCache

  const home = os.homedir()
  const candidates = [
    // 1. 用户主目录下
    path.join(home, 'DSH产出'),
    path.join(home, 'DSH-outputs'),
    // 2. 文档下
    path.join(home, 'Documents', 'DSH产出'),
    path.join(home, 'Documents', 'DSH-outputs'),
    // 3. 桌面下
    path.join(home, 'Desktop', 'DSH产出'),
    // 4. 下载目录下
    path.join(home, 'Downloads', 'DSH产出'),
  ]

  // 5. 遍历可用盘符（Windows）：C:\DSH产出、D:\DSH产出 …… 不写死任何字母
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {   // C(67) → Z(90)
      const drive = String.fromCharCode(code) + ':'
      candidates.push(path.join(drive + path.sep, 'DSH产出'))
    }
  }

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) {
        defaultRootCache = candidate
        return candidate
      }
    } catch {
      // 不存在就试下一个
    }
  }

  // 全都不存在：返回第一个候选，让面板显示「目录不存在」并给出修改入口
  defaultRootCache = candidates[0]
  return defaultRootCache
}

/** 视频扩展名（与 DEFAULTS.mediaExtensions 里的音频部分相对）。 */

export function readSettingsFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 读取「已隐藏」的相对路径集合。
 * 隐藏只记录路径，不移动/删除文件；列表扫描时按此过滤。
 * @param settingsFile - 配置文件路径。
 * @returns 规范化（正斜杠）后的相对路径数组。
 */

export async function readHiddenList(settingsFile) {
  const stored = readSettingsFile(settingsFile)
  if (!Array.isArray(stored.hidden)) return []
  return stored.hidden
    .filter((p) => typeof p === 'string' && p !== '')
    .map((p) => p.replace(/\\/g, '/'))
}

/**
 * 解析最终配置。扫描目录（roots）的优先级（高 → 低）：
 *   1. 运行时配置文件的 roots 数组（面板内可加多个目录）
 *   2. 运行时配置文件的 root（旧版单目录写法，兼容保留）
 *   3. cordis.patch.yml 里配的 root / roots
 *   4. 自动探测（detectDefaultRoot）
 *
 * 为什么支持多目录：DSH 一个会话一个 cwd，产出可能写在任意工作区下
 * （例如 G:\DSH任务文件\xxx），不一定落在 G:\DSH产出。只配一个目录必然漏。
 */

export function resolveOptions(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  const settingsFile = String(merged.settingsFile ?? DEFAULT_SETTINGS_FILE)
  const stored = readSettingsFile(settingsFile)

  // 收集所有候选目录
  const collected = []
  const pushRoot = (value) => {
    if (typeof value === 'string' && value.trim() !== '') collected.push(value.trim())
  }
  const pushList = (value) => {
    if (Array.isArray(value)) for (const v of value) pushRoot(v)
  }

  pushList(stored.roots)   // 1. 设置里的多目录
  pushRoot(stored.root)    // 2. 设置里的单目录（旧格式）
  pushList(merged.roots)   // 3. YAML 多目录
  pushRoot(merged.root)    // 4. YAML 单目录

  // 去重（Windows 路径大小写不敏感）
  const deduped = []
  const seenRoots = new Set()
  const candidates = collected.length > 0 ? collected : [detectDefaultRoot()]
  for (const r of candidates) {
    const abs = path.resolve(r)
    const key = abs.toLowerCase()
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    deduped.push(abs)
  }

  const resolvedRoots = deduped.length > 0 ? deduped : [path.resolve(detectDefaultRoot())]
  const rootSource = collected.length === 0
    ? 'auto-detect'
    : (typeof stored.root === 'string' || (Array.isArray(stored.roots) && stored.roots.length > 0) ? 'settings' : 'config')

  return {
    root: resolvedRoots[0],
    roots: resolvedRoots,
    rootSource,
    settingsFile,
    windowHours: numberOr(merged.windowHours, DEFAULTS.windowHours, 1, 24 * 366),
    maxItems: numberOr(merged.maxItems, DEFAULTS.maxItems, 1, 500),
    maxDepth: numberOr(merged.maxDepth, DEFAULTS.maxDepth, 0, 8),
    extensions: arrayOfStrings(merged.extensions, DEFAULTS.extensions).map((e) => e.toLowerCase()),
    fileExtensions: arrayOfStrings(merged.fileExtensions, DEFAULTS.fileExtensions).map((e) => e.toLowerCase()),
    mediaExtensions: arrayOfStrings(merged.mediaExtensions, DEFAULTS.mediaExtensions).map((e) => e.toLowerCase()),
    skipDirs: arrayOfStrings(merged.skipDirs, DEFAULTS.skipDirs).map((e) => e.toLowerCase()),
    maxDirectories: numberOr(merged.maxDirectories, DEFAULTS.maxDirectories, 1, 200000),
    maxEntries: numberOr(merged.maxEntries, DEFAULTS.maxEntries, 1, 1000000),
    maxImageBytes: numberOr(merged.maxImageBytes, DEFAULTS.maxImageBytes, 1, 512 * 1024 * 1024),
    maxMediaBytes: numberOr(merged.maxMediaBytes, DEFAULTS.maxMediaBytes, 1, 1024 * 1024 * 1024),
  }
}

export async function validateRootCandidate(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, reason: 'empty' }
  }
  const raw = candidate.trim()
  // 只接受绝对路径（盘符或 UNC），相对路径无法确定含义
  if (!path.isAbsolute(raw)) return { ok: false, reason: 'not-absolute' }
  const resolved = path.resolve(raw)
  try {
    const st = await fsp.stat(resolved)
    if (!st.isDirectory()) return { ok: false, reason: 'not-directory' }
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  return { ok: true, root: resolved }
}

/**
 * 把设置写进运行时配置文件。
 * 只覆盖传入的字段，其余保留——避免把 windowHours 之类顺手清掉。
 * @param settingsFile - 配置文件路径。
 * @param patch - 要合并进去的部分设置。
 */

export async function writeSettingsFile(settingsFile, patch) {
  const current = readSettingsFile(settingsFile)
  const next = { ...current, ...patch }
  await fsp.mkdir(path.dirname(settingsFile), { recursive: true })
  const tmp = settingsFile + '.tmp-' + String(process.pid)
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2))
  await fsp.rename(tmp, settingsFile)
  return next
}

/**
 * 返回设置面板需要的全部信息。
 * @param config - 插件配置。
 */

export async function readSettingsPayload(config) {
  const opts = resolveOptions(config)
  // 逐个检查每个 root 是否存在
  const rootsInfo = []
  for (const r of opts.roots) {
    let exists = false
    try {
      exists = (await fsp.stat(r)).isDirectory()
    } catch {
      exists = false
    }
    rootsInfo.push({ path: r, exists })
  }
  const exists = rootsInfo.length > 0 ? rootsInfo[0].exists : false
  // 已隐藏条数：供设置面板显示「已隐藏 N 个 · 全部恢复」
  const hidden = await readHiddenList(opts.settingsFile)
  return {
    root: opts.root,
    roots: opts.roots,
    rootsInfo,
    rootSource: opts.rootSource,
    rootExists: exists,
    settingsFile: opts.settingsFile,
    windowHours: opts.windowHours,
    maxItems: opts.maxItems,
    maxDepth: opts.maxDepth,
    hiddenCount: hidden.length,
    // 前若干条隐藏项，供面板预览（不返回全部，避免配置很大时拖慢）
    hiddenSample: hidden.slice(0, 10),
    defaults: {
      // 给前端「恢复默认」用：自动探测的结果
      root: path.resolve(detectDefaultRoot()),
    },
    home: os.homedir(),
    platform: process.platform,
  }
}

/**
 * 会话日志解压结果的缓存。
 * 自动刷新每 5 秒一次，而一个活跃会话的日志解压后有 9MB 以上；
 * 用「路径 + mtime + size」做键，日志没变就复用上次的解析结果。
 */
