/**
 * 会话索引 —— 把「所有会话产出了哪些文件」建成一张表。
 *
 * 用途：让「全局资产」能按对话分组展示，而不是一堆乱七八糟的文件。
 *
 * 为什么需要缓存：
 *   全量扫描 108 个会话日志（80 MB）实测耗时 1639 ms，
 *   而画廊每 5 秒刷新一次 → 不可能每次都全量解压。
 *   用「目录 mtime + 会话数」做键，没事就不重扫。
 *
 * 为什么用目录 mtime 而不是逐个文件：
 *   108 个文件各 stat 一次也有开销；会话目录增多或日志追加时，
 *   目录 mtime 会变，足够触发重扫。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** 会话索引缓存：键是 sessionsDir，值是 { key, index }。 */
const sessionIndexCache = new Map()

/**
 * 扫出一个会话目录里的全部会话（含子会话）。
 * @param sessionsDir - 会话根目录。
 * @returns 会话目录信息数组。
 */
async function listSessionDirs(sessionsDir) {
  const dirs = []
  let groups
  try {
    groups = await fsp.readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return dirs
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const gdir = path.join(sessionsDir, String(group.name))
    let sessions
    try {
      sessions = await fsp.readdir(gdir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const sdir = path.join(gdir, String(s.name))
      const logPath = path.join(sdir, 'session.v4.jsonl.zstd')
      try {
        const st = await fsp.stat(logPath)
        if (!st.isFile()) continue
        dirs.push({
          sessionId: String(s.name),
          group: String(group.name),
          sessionDir: sdir,
          logPath,
          logMtime: st.mtimeMs,
          logSize: st.size,
        })
      } catch {
        // 没有日志就跳过
      }
    }
  }
  return dirs
}

/**
 * 从会话日志里提取标题。DSH 会写 `session/title` 事件。
 * @param logText - 解压后的日志文本。
 * @returns 标题字符串；没有则空串。
 */
function extractSessionTitle(logText) {
  if (typeof logText !== 'string' || logText === '') return ''
  // 取最后一个 title（用户可能改过标题）
  let title = ''
  for (const line of logText.split('\n')) {
    if (!line.includes('session/title')) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o?.type !== 'session/title') continue
    const t = o?.data?.title
    if (typeof t === 'string' && t.trim() !== '') title = t.trim()
  }
  return title
}

/**
 * 从会话日志首行读元信息（创建时间、cwd、父会话）。
 * @param logText - 解压后的日志文本。
 * @returns { createdAt, cwd, parentSession }
 */
function extractSessionMeta(logText) {
  const fallback = { createdAt: 0, cwd: '', parentSession: '' }
  if (typeof logText !== 'string' || logText === '') return fallback
  const firstLine = logText.split('\n')[0]
  let o
  try { o = JSON.parse(firstLine) } catch { return fallback }
  return {
    createdAt: typeof o?.createdAt === 'number' ? o.createdAt : 0,
    cwd: typeof o?.cwd === 'string' ? o.cwd : '',
    parentSession: typeof o?.parentSession === 'string' ? o.parentSession : '',
  }
}

/**
 * 建立（或复用）会话索引。
 *
 * @param sessionsDir - 会话根目录。
 * @param opts - resolveOptions 的结果（要用到 roots / readSessionLogText / extractAssetInfo）。
 * @param deps - 依赖注入 { readSessionLogText, extractAssetInfo }。
 * @returns Map<sessionId, { sessionId, title, createdAt, cwd, parentSession, files: Map<abs, category>, maxMtime }>
 */
export async function buildSessionIndex(sessionsDir, opts, deps) {
  const { readSessionLogText, extractAssetInfo } = deps

  // 缓存键：会话目录的 mtime + 当前会话数
  let dirKey
  try {
    const allDirs = await listSessionDirs(sessionsDir)
    dirKey = `${allDirs.length}|${allDirs.reduce((a, d) => Math.max(a, d.logMtime), 0)}`
    const cached = sessionIndexCache.get(sessionsDir)
    if (cached !== undefined && cached.key === dirKey) return cached.index

    const index = new Map()

    for (const d of allDirs) {
      const logText = await readSessionLogText(d.logPath)
      if (logText === '') continue

      const meta = extractSessionMeta(logText)
      const title = extractSessionTitle(logText)
      // 传会话开始时间：用于区分「用户素材」和「会话期间产出」的分类
      const assets = extractAssetInfo(logText, meta.createdAt)

      // 只看落在扫描目录内的路径
      const files = new Map()
      let maxMtime = meta.createdAt
      for (const [abs, info] of assets) {
        let ownerRoot = null
        for (const r of opts.roots) {
          if (isInsidePath(r, abs)) { ownerRoot = r; break }
        }
        if (ownerRoot === null) continue
        files.set(abs, info.category)
        try {
          const st = await fsp.stat(abs)
          if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs
        } catch {
          // 文件已删除就跳过
        }
      }

      if (files.size === 0) continue

      index.set(d.sessionId, {
        sessionId: d.sessionId,
        title,
        createdAt: meta.createdAt,
        cwd: meta.cwd,
        parentSession: meta.parentSession,
        files,
        maxMtime,
        logMtime: d.logMtime,
      })
    }

    sessionIndexCache.set(sessionsDir, { key: dirKey, index })
    return index
  } catch {
    return new Map()
  }
}

/** 路径是否在 root 内（避免循环依赖，这里内联一份最小实现）。 */
function isInsidePath(root, abs) {
  const r = path.resolve(root)
  const a = path.resolve(abs)
  if (a === r) return true
  return a.startsWith(r + path.sep)
}

/**
 * 清空会话索引缓存（配置变化时调用）。
 */
export function clearSessionIndexCache() {
  sessionIndexCache.clear()
}
