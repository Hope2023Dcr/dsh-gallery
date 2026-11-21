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

/**
 * 单个会话日志的解析缓存：logPath → { key, entry }。
 *
 * 旧版用「所有日志里最新的 mtime」当整表缓存键，只要当前对话还在写日志，
 * 这个键每次都变 → 每 5 秒自动刷新都把 100 MB 日志全量解压一遍（实测 3.6 秒）。
 * 改成按日志逐条缓存后，活跃会话只重解它自己那一个日志（约几十毫秒）。
 */
const sessionEntryCache = new Map()
/** 当前缓存对应的扫描目录指纹；用户改了根目录就整体失效。 */
let indexRootsKey = ''

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
export function extractSessionTitle(logText) {
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
 * 同上的省内存版：不 split 全文，只按 `session/title` 命中位置切片。
 *
 * 为什么要它：单个会话日志解压后实测 390 万字符（约 4 MB 字符串），
 * `split('\n')` 会造出十几万个小字符串，在「粘贴一次就读一次标题」这种
 * 热路径上纯属白烧内存。标题事件的位置也不固定（实测出现在第 98121 字符，
 * 既不在开头也不在末尾），所以不能靠截头尾。
 *
 * 语义与 extractSessionTitle 一致：取最后一次出现的标题。
 */
export function extractSessionTitleFast(logText) {
  if (typeof logText !== 'string' || logText === '') return ''
  const MARK = 'session/title'
  let title = ''
  let pos = 0
  while (pos < logText.length) {
    const hit = logText.indexOf(MARK, pos)
    if (hit < 0) break
    const lineStart = logText.lastIndexOf('\n', hit) + 1
    let lineEnd = logText.indexOf('\n', hit)
    if (lineEnd < 0) lineEnd = logText.length
    pos = lineEnd + 1
    // 一整个会话序列化成一行时该行可能极大，直接跳过，避免解析几 MB 的单行
    if (lineEnd - lineStart > 8192) continue
    let o
    try { o = JSON.parse(logText.slice(lineStart, lineEnd)) } catch { continue }
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
  try {
    // 列目录 + stat 115 个日志文件很便宜（约 10 ms），每次都做；
    // 贵的「解压 + 逐行解析」只发生在 mtime/size 变了的那些日志上。
    const allDirs = await listSessionDirs(sessionsDir)
    // 扫描目录变了（面板里改 root）→ 旧缓存里的文件归属是按旧目录算的，必须全部重算
    const rootsKey = (opts.roots ?? []).map((r) => path.resolve(r).toLowerCase()).join('|')
    if (rootsKey !== indexRootsKey) {
      sessionEntryCache.clear()
      indexRootsKey = rootsKey
    }
    const index = new Map()
    const livePaths = new Set()

    for (const d of allDirs) {
      livePaths.add(d.logPath)
      const key = `${d.logMtime}|${d.logSize}`
      const cached = sessionEntryCache.get(d.logPath)
      if (cached !== undefined && cached.key === key) {
        if (cached.entry !== null) index.set(d.sessionId, cached.entry)
        continue
      }

      const logText = await readSessionLogText(d.logPath)
      if (logText === '') {
        sessionEntryCache.set(d.logPath, { key, entry: null })
        continue
      }

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

      if (files.size === 0) {
        sessionEntryCache.set(d.logPath, { key, entry: null })
        continue
      }

      const entry = {
        sessionId: d.sessionId,
        title,
        createdAt: meta.createdAt,
        cwd: meta.cwd,
        parentSession: meta.parentSession,
        files,
        maxMtime,
        logMtime: d.logMtime,
      }
      index.set(d.sessionId, entry)
      sessionEntryCache.set(d.logPath, { key, entry })
    }

    // 日志目录被删掉时把对应缓存也清掉，避免常驻进程里无限堆积
    for (const p of sessionEntryCache.keys()) {
      if (!livePaths.has(p)) sessionEntryCache.delete(p)
    }
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
  sessionEntryCache.clear()
  indexRootsKey = ''
}

/**
 * 会话状态注册表 —— 宿主官方字段，不是私有会话日志。
 *
 * 文件：<DSH_HOME>/storages/workspace.json
 *   · global.archivedSessionIds  —— 宿主「归档会话」写这里（宿主 zod schema 实证）
 *   · tables.workspaces[*].sessionIds —— 每个工作区挂载的少量会话，**不是全量会话表**；
 *     本机实测仅 15 个，而会话日志有 115 个，因此它只能读、绝不能用来推断「已删除」。
 *
 * 为什么需要它：画廊是按会话日志分组的，日志目录不会因为归档而消失，
 * 于是「资产还在、对话已归档」的分组需要一个明确标注。
 * 这里只做只读判定：不写宿主任何文件，也不改变分组原有的时间排序。
 */
const sessionStateCache = new Map()

/** @returns {{ok:boolean, archived:Set<string>, known:Set<string>}} */
export async function readSessionStates(dshHome) {
  const file = path.join(dshHome, 'storages', 'workspace.json')
  try {
    const st = await fsp.stat(file)
    const key = `${st.mtimeMs}|${st.size}`
    const cached = sessionStateCache.get(file)
    if (cached !== undefined && cached.key === key) return cached.states
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
    const archived = new Set(
      Array.isArray(raw?.global?.archivedSessionIds) ? raw.global.archivedSessionIds : [],
    )
    const known = new Set()
    for (const w of Object.values(raw?.tables?.workspaces ?? {})) {
      if (Array.isArray(w?.sessionIds)) for (const id of w.sessionIds) known.add(id)
    }
    const states = { ok: true, archived, known }
    sessionStateCache.set(file, { key, states })
    return states
  } catch {
    // 读不到就全部当 active：标注功能降级，但绝不影响扫描
    return { ok: false, archived: new Set(), known: new Set() }
  }
}

/**
 * 单个会话的状态。
 *   active     —— 默认；没有反证就当可打开，绝不预先禁用「打开对话」
 *   archived   —— 命中宿主官方 global.archivedSessionIds（唯一可信的归档证据）
 *   unassigned —— 历史资产，本来就查不到归属会话，不加标注
 *
 * ⚠️ 2026-11-10 修复（老板报的 bug）：
 *   旧版把「不在 tables.workspaces[*].sessionIds 里」直接判成 deleted，
 *   但本机实测该注册表只有 15 个会话，而会话日志有 115 个 —— 左侧列表里
 *   正常开着的会话几乎全被误标成「会话已删除」，连「打开对话」都被禁用。
 *   宿主没有 deletedSessionIds 这类官方字段，删除状态无法离线可靠推断，
 *   因此这里只保留官方归档字段；真正打不开的交给客户端点击时实测标注。
 *
 * 只用于「标注」，绝不参与分组排序。
 */
export function stateOfSession(sessionId, states) {
  if (sessionId === null || sessionId === undefined || sessionId === '') return 'unassigned'
  if (states?.archived?.has(sessionId)) return 'archived'
  return 'active'
}
