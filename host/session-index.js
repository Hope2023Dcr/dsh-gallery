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
 * 为什么用「逐条日志 mtime|size」而不是整表时间戳：
 *   只要当前对话还在写日志，整表键每次都变，会把 100 MB 日志全量重解压。
 *   逐条缓存后，活跃会话只重解它自己那一个日志（几十毫秒）。
 *
 * v1.6.5：这份缓存还会落盘（见下方 DISK_CACHE_VERSION），重启后直接复用，
 *   不再每次重开面板都付一遍 7 秒的解压费。
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
 * v1.6.5 卡顿根治：会话日志「解析结果」的磁盘缓存。
 *
 * 实测（本机 115 份日志 / 6940 张资产）：冷启动全库扫描 7189 ms，
 * 同进程热缓存只要 136 ms —— 差的 7 秒全在反复解压 zstd 日志并重跑
 * extractAssetInfo / extractSessionTitle。进程内 sessionEntryCache 重启必丢，
 * 所以每次重开面板都要再付一次。
 *
 * 这里把解析结果按 logPath + (mtime|size) 落到 <settings 同目录>，
 * 重启后直接读回来：日志没变就绝不解压、绝不重解析；日志一变只重算那一份。
 * 判据仍是 mtime（与全项目一致），没有「快照陈旧」问题。
 *
 * - 只在生产链路启用：scan.js 通过 deps.cacheFile 传入；测试直调不传，
 *   行为与旧版逐字一致，不会往测试环境写文件。
 * - 缓存文件绝不放扫描根内，否则下次刷新会把它自己扫成资产。
 */
const DISK_CACHE_VERSION = 1

/** 缓存文件路径：设置文件同目录（DSH_HOME 下）。 */
export function sessionIndexCacheFileFor(settingsFile) {
  return path.join(path.dirname(String(settingsFile)), 'gallery-session-index.json')
}

let diskLoaded = false
let diskRootsKey = ''
let diskLoadPromise = null
/** clearSessionIndexCache() 之后别把刚清掉的旧盘又灌回来，等这轮重算重写。 */
let skipNextDiskLoad = false

/** Map/Set 转成可 JSON 化结构。 */
function packEntry(entry) {
  if (entry === null || entry === undefined) return null
  return {
    sessionId: entry.sessionId,
    title: entry.title,
    createdAt: entry.createdAt,
    startMs: entry.startMs,
    cwd: entry.cwd,
    parentSession: entry.parentSession,
    files: entry.files instanceof Map ? [...entry.files] : [],
    dirs: entry.dirs instanceof Set ? [...entry.dirs] : [],
    maxMtime: entry.maxMtime,
    logMtime: entry.logMtime,
  }
}

/** 反解；结构坏了返回 undefined，让那一条重新解析（不整表作废）。 */
function unpackEntry(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') return undefined
  if (!Array.isArray(raw.files) || !Array.isArray(raw.dirs)) return undefined
  const files = new Map()
  for (const pair of raw.files) {
    if (Array.isArray(pair) && typeof pair[0] === 'string') {
      files.set(pair[0], typeof pair[1] === 'string' ? pair[1] : 'unknown')
    }
  }
  return {
    sessionId: String(raw.sessionId ?? ''),
    title: String(raw.title ?? ''),
    createdAt: Number(raw.createdAt) || 0,
    startMs: Number(raw.startMs) || 0,
    cwd: String(raw.cwd ?? ''),
    parentSession: String(raw.parentSession ?? ''),
    files,
    dirs: new Set(raw.dirs.filter((d) => typeof d === 'string')),
    maxMtime: Number(raw.maxMtime) || 0,
    logMtime: Number(raw.logMtime) || 0,
  }
}

/** tmp + rename 原子写；失败只吞，缓存是加速器，绝不拖垮扫描。 */
async function flushDiskCache(file, rootsKey) {
  let tmp = ''
  try {
    const body = JSON.stringify({
      v: DISK_CACHE_VERSION,
      at: Date.now(),
      rootsKey,
      entries: [...sessionEntryCache.entries()].map(([p, c]) => [
        p, { key: c.key, entry: packEntry(c.entry) },
      ]),
    })
    await fsp.mkdir(path.dirname(file), { recursive: true })
    tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await fsp.writeFile(tmp, body, 'utf8')
    await fsp.rename(tmp, file)
    tmp = ''
  } catch {
    if (tmp !== '') { try { await fsp.unlink(tmp) } catch { /* 忽略 */ } }
  }
}

/** 重启后把上次解析结果读回内存；版本 / roots 不符一律整表作废。 */
async function loadDiskCache(file, rootsKey) {
  let raw
  try { raw = JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return }
  if (raw === null || typeof raw !== 'object') return
  if (raw.v !== DISK_CACHE_VERSION || raw.rootsKey !== rootsKey) return
  if (!Array.isArray(raw.entries)) return
  for (const pair of raw.entries) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue
    const c = pair[1]
    if (c === null || typeof c !== 'object' || typeof c.key !== 'string') continue
    const entry = unpackEntry(c.entry)
    if (entry === undefined) continue
    sessionEntryCache.set(pair[0], { key: c.key, entry })
  }
}

/** 懒加载一次；并发调用共用同一个 Promise，避免重复读盘。 */
async function ensureDiskLoaded(file, rootsKey) {
  if (diskLoaded && diskRootsKey === rootsKey) return
  if (diskLoadPromise !== null) { await diskLoadPromise; return }
  diskLoadPromise = (async () => {
    if (diskLoaded && diskRootsKey !== rootsKey) {
      // roots 变了：旧缓存的 files/dirs 按旧 root 算，必须全部重算
      sessionEntryCache.clear()
    } else if (!skipNextDiskLoad) {
      await loadDiskCache(file, rootsKey)
    }
    diskLoaded = true
    diskRootsKey = rootsKey
    skipNextDiskLoad = false
  })()
  try { await diskLoadPromise } finally { diskLoadPromise = null }
}

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
  // 只有生产链路（scan.js）传 cacheFile；测试直调不传 → 行为与旧版完全一致。
  const cacheFile = typeof deps?.cacheFile === 'string' && deps.cacheFile !== ''
    ? deps.cacheFile : ''
  try {
    // 列目录 + stat 115 个日志文件很便宜（约 10 ms），每次都做；
    // 贵的「解压 + 逐行解析」只发生在 mtime/size 变了的那些日志上。
    const allDirs = await listSessionDirs(sessionsDir)
    // 扫描目录变了（面板里改 root）→ 旧缓存里的文件归属是按旧目录算的，必须全部重算
    const rootsKey = (opts.roots ?? []).map((r) => path.resolve(r).toLowerCase()).join('|')
    if (cacheFile !== '') {
      await ensureDiskLoaded(cacheFile, rootsKey)
    } else if (rootsKey !== indexRootsKey) {
      sessionEntryCache.clear()
      indexRootsKey = rootsKey
    }
    const index = new Map()
    // 有新的解析结果 / 删掉过期条目时才回写盘，热扫描一次磁盘写入都不做
    let dirty = false
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
        dirty = true
        continue
      }

      const meta = extractSessionMeta(logText)
      const title = extractSessionTitle(logText)
      // 传会话开始时间：用于区分「用户素材」和「会话期间产出」的分类
      const assets = extractAssetInfo(logText, meta.createdAt)

      // 只看落在扫描目录内的路径
      const files = new Map()
      // 2026-11-25：本对话「用过的目录」（相对扫描根、小写），供全局分组做目录兜底。
      //
      // 起因：老板在全局资产里看到「DSH辅助漫剧制作流程」只剩 2 张，切进该对话却是 12 张。
      // 那 10 张日志里没有精确路径，只有「当前对话」视图靠「目录 + 时间窗口」兜得住；
      // 全局分组只认精确路径，它们就掉进「历史资产」了。这里把目录也记进索引。
      //
      // 只收有子目录的层 + 根直属层（空串）—— 后者单列，由 scan 侧当作**最低优先**的
      // 兜底：一个会话只要在根层产过文件，就会认得根层之后的所有新图，很容易过度归属，
      // 所以它只在「没有任何更具体的归属」时才生效（实测「新项目调研」缺的 5 张就在根层）。
      const dirs = new Set()
      let maxMtime = meta.createdAt
      for (const [abs, info] of assets) {
        let ownerRoot = null
        for (const r of opts.roots) {
          if (isInsidePath(r, abs)) { ownerRoot = r; break }
        }
        if (ownerRoot === null) continue
        files.set(abs, info.category)
        const relDir = path.relative(ownerRoot, path.dirname(path.resolve(abs)))
          .split(path.sep).join('/')
        if (!relDir.startsWith('..')) dirs.add(relDir.toLowerCase())
        try {
          const st = await fsp.stat(abs)
          if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs
        } catch {
          // 文件已删除就跳过
        }
      }

      // 2026-11-25：files 为空也**不再丢弃**这条记录。
      // 原因：子会话可能只把产出落在扫描根外（日志里没路径），父会话条目却是
      // 子会话归并的依据 —— 丢掉它，buildRootSessionResolver 就找不到父链，
      // 子会话会单独成组，父组永远少几张（实测「尺间空间IP品牌重塑」少 59 张）。
      // 空条目对 ownerByAbs / dirOwnerIndex 都是空循环，不产生副作用。

      const entry = {
        sessionId: d.sessionId,
        title,
        createdAt: meta.createdAt,
        // 目录兜底的时间门槛：文件必须「晚于本对话开始」才算它的产出，
        // 与 resolveSessionScope 的 isFreshSince 同一把关，避免把老图抢进新对话。
        startMs: meta.createdAt,
        cwd: meta.cwd,
        parentSession: meta.parentSession,
        files,
        dirs,
        maxMtime,
        logMtime: d.logMtime,
      }
      index.set(d.sessionId, entry)
      sessionEntryCache.set(d.logPath, { key, entry })
      dirty = true
    }

    // 日志目录被删掉时把对应缓存也清掉，避免常驻进程里无限堆积
    for (const p of sessionEntryCache.keys()) {
      if (!livePaths.has(p)) { sessionEntryCache.delete(p); dirty = true }
    }
    if (cacheFile !== '' && dirty) await flushDiskCache(cacheFile, rootsKey)
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
  diskLoaded = false
  skipNextDiskLoad = true
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
