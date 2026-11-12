/**
 * 产出扫描：提取资产、扫描目录、分页。
 *
 * S1 拆分自 index.js（行为零变化）。
 */

import { promises as fsp, readFileSync, statSync, createReadStream } from 'node:fs'
import path from 'node:path'
import { ASSET_CATEGORY, classifyAsset } from './classify.js'
import { BASH_TOOLS, DEFAULT_SESSIONS_DIR, DSH_HOME, OUTPUT_TOOLS, VIDEO_EXTS, VIEW_IMAGE_EXTS, VIEW_TOOLS } from './constants.js'
import { isInside, measureImage, readHead } from './fsutil.js'
import { buildGroups } from './groups.js'
import { collectAbsolutePaths, findSubSessionLogs, locateSessionDir, readSessionLogText } from './session.js'
import { readHiddenList, resolveOptions } from './settings.js'
import { readLabels, LABEL_CATEGORIES } from './labels.js'
import { readFrames } from './frames.js'
import { buildSessionIndex, readSessionStates } from './session-index.js'

/**
 * v0.14.7：相对路径的父目录（统一小写；空串表示文件直接躺在 root 下）。
 * 当前对话据此判断「外部图片是否和本对话用过的资产在同一目录」。
 */
export function parentDirOf(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/').toLowerCase()
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
}

/** v0.14.7：当前对话分类。日志/登记里没有的、同目录外部图片自动标「素材」(input)。 */
export function categoryForSessionAsset(autoCategory, externalAsset) {
  return autoCategory ?? (externalAsset ? ASSET_CATEGORY.INPUT : null)
}

export function extractAssetInfo(logText, sessionStartMs = 0) {
  const assets = new Map()
  if (typeof logText !== 'string' || logText === '') return assets

  const ensure = (abs) => {
    if (!assets.has(abs)) {
      assets.set(abs, { presented: false, written: false, viewed: false, bashMentioned: false })
    }
    return assets.get(abs)
  }

  for (const line of logText.split('\n')) {
    if (line === '') continue
    // 快速预筛：只处理含 tool/call 的行，避免全量 JSON.parse
    if (!line.includes('tool/call')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.type !== 'tool/call') continue
    const name = record?.data?.name
    if (typeof name !== 'string') continue

    const rawArgs = record?.data?.arguments
    if (typeof rawArgs !== 'string') continue
    let args
    try {
      args = JSON.parse(rawArgs)
    } catch {
      continue
    }

    // ---- bash / pwsh：命令文本里提到的路径，只作为「非输入」的弱证据 ----
    if (BASH_TOOLS.has(name)) {
      const cmdText = `${args?.command ?? ''} ${args?.script_path ?? ''}`
      const re = /[A-Za-z]:[\\/][^\s"'|&;<>()*?]+/g
      for (const m of cmdText.matchAll(re)) {
        const candidate = m[0].replace(/[\\/]+$/, '')
        const ext = path.extname(candidate).toLowerCase()
        // 只接受看起来像文件的路径（有扩展名）
        if (ext === '') continue
        try {
          const info = ensure(path.resolve(candidate))
          info.bashMentioned = true
        } catch {
          // 解析失败就跳过
        }
      }
      continue
    }

    const isWriter = OUTPUT_TOOLS.has(name)
    const isViewer = VIEW_TOOLS.has(name)
    const isPresenter = name === 'present'
    if (!isWriter && !isViewer && !isPresenter) continue

    // present 的参数结构是 { files: [{ path, description }]}
    let found = []
    if (isPresenter && Array.isArray(args?.files)) {
      found = args.files.map((f) => f?.path).filter((p) => typeof p === 'string')
    } else {
      collectAbsolutePaths(args, found)
    }

    for (const entry of found) {
      if (isViewer) {
        // 查看类工具只认图片：避免把 read_image 参数里偶尔出现的
        // 目录、配置等非图片路径当成产出
        const ext = path.extname(entry).toLowerCase()
        if (!VIEW_IMAGE_EXTS.has(ext)) continue
      }
      const info = ensure(path.resolve(entry))
      if (isPresenter) info.presented = true
      else if (isViewer) info.viewed = true
      else info.written = true
    }
  }

  // ---- 归类 ----
  for (const [abs, info] of assets) {
    classifyAsset(abs, info, sessionStartMs)
  }

  return assets
}

/**
 * 从会话日志首行解析会话开始时间（createdAt）。
 * @param logText - 解压后的日志文本。
 * @returns 毫秒时间戳；解析失败返回 0。
 */

export function parseSessionStartMs(logText) {
  if (typeof logText !== 'string' || logText === '') return 0
  const firstLine = logText.split('\n')[0]
  try {
    const first = JSON.parse(firstLine)
    return typeof first?.createdAt === 'number' ? first.createdAt : 0
  } catch {
    return 0
  }
}

/**
 * 给单个资产定分类。**唯一**的分类入口，别在别处复制这套判据。
 *
 * 规则（按优先级）：
 *   1. present 过 → 最终
 *   2. 「只被 read_image 看过」是候选输入，但必须能证明它早于会话开始就存在：
 *      - mtime < 会话开始 → 输入（用户预先提供的素材）
 *      - mtime >= 会话开始 → 中间（会话期间生成的，脚本产出常见这种）
 *   3. 其余 → 中间
 *
 * 为什么必须看时间：「被 read_image 看过」既可能是用户素材，也可能是脚本产出的图，
 * Agent 两者都会打开看。实测反例：
 *   - architecture.png：write 写的是脚本，file_path 不是它，只在 read_image 出现
 *   - 缩略图尺寸对比.png：文件名写在 bash 的 python 代码里，不是绝对路径
 * 这两类旧判据都会误判成「输入」。
 *
 * @param abs - 文件绝对路径。
 * @param info - extractAssetInfo 收集到的动作标记（会被写入 category）。
 * @param sessionStartMs - 会话开始时间；0 表示未知（此时不做输入判定）。
 */

export function extractOutputPaths(logText) {
  return new Set(extractAssetInfo(logText).keys())
}

/**
 * 算出「本对话」产出过的路径与任务目录。
 *
 * 支持多扫描目录（roots）：逐个判断路径落在哪个 root 下。
 * 修法 B：文件**直接躺在 root 根目录下**（没有子目录）时也要能匹配，
 * 原实现只取「第一层目录」并要求至少两段，导致根目录文件全部判为 0。
 *
 * @param config - 用户配置。
 * @param sessionId - 当前会话 id。
 * @param allRoots - 已解析的扫描目录列表（不传则内部再解析一次）。
 * @returns { ok, reason, taskDirs, paths, relPaths }
 */

export async function resolveSessionScope(config, sessionId, allRoots) {
  const opts = resolveOptions(config)
  const roots = Array.isArray(allRoots) && allRoots.length > 0 ? allRoots : opts.roots
  const sessionsDir = typeof config?.sessionsDir === 'string' && config.sessionsDir !== ''
    ? path.resolve(config.sessionsDir)
    : DEFAULT_SESSIONS_DIR
  const sessionDir = await locateSessionDir(sessionsDir, sessionId)
  if (sessionDir === null) {
    return { ok: false, reason: 'session-not-found', taskDirs: [], paths: [], relPaths: [], subSessions: 0 }
  }
  const logPath = path.join(sessionDir, 'session.v4.jsonl.zstd')
  const logText = await readSessionLogText(logPath)
  if (logText === '') {
    return { ok: false, reason: 'log-empty', taskDirs: [], paths: [], relPaths: [], subSessions: 0 }
  }
  // 会话开始时间：用于区分「用户素材」与「会话期间产出」
  const sessionStartMs = parseSessionStartMs(logText)
  const allAssets = extractAssetInfo(logText, sessionStartMs)

  // 修法 C：合并所有子会话（子智能体）的产出路径
  const subLogs = await findSubSessionLogs(sessionsDir, sessionId)
  for (const subLog of subLogs) {
    const subText = await readSessionLogText(subLog)
    if (subText === '') continue
    for (const [abs, info] of extractAssetInfo(subText, sessionStartMs)) {
      const existing = allAssets.get(abs)
      if (existing) {
        // 合并标记：任一处 present 就算最终
        existing.presented = existing.presented || info.presented
        existing.written = existing.written || info.written
        existing.viewed = existing.viewed || info.viewed
        existing.bashMentioned = existing.bashMentioned || info.bashMentioned
      } else {
        allAssets.set(abs, info)
      }
    }
  }

  // 合并后重新归类（因为 presented/written 可能变了）。
  // 统一走 classifyAsset，避免两处判据分叉 —— v0.8.1 就是这里漏改导致分类不准。
  for (const [abs, info] of allAssets) {
    classifyAsset(abs, info, sessionStartMs)
  }

  const normalized = []
  const relPaths = []
  const taskDirs = new Set()
  // v0.14.7：会话引用过的「精确目录」（相对 root、小写，空串表示 root 直属层）。
  // 外部拷进同一目录、没被日志引用的图片，也要能在「当前对话」里看到并标为素材。
  const sessionDirs = new Set()
  // relPath(小写) → 分类，供扫描时标注
  const categoryByRel = new Map()

  for (const [abs, info] of allAssets) {
    const absolute = path.resolve(abs)
    // 找出该路径属于哪个 root
    let ownerRoot = null
    for (const r of roots) {
      if (isInside(r, absolute)) { ownerRoot = r; break }
    }
    if (ownerRoot === null) continue
    normalized.push(absolute)

    const rel = path.relative(ownerRoot, absolute)
    const segs = rel.split(path.sep).filter((s) => s !== '')
    const relPath = rel.split(path.sep).join('/')
    relPaths.push(relPath)
    categoryByRel.set(relPath.toLowerCase(), info.category)
    sessionDirs.add(parentDirOf(relPath))
    // 修法 B：有子目录时取第一层；没有子目录（文件直接在 root 下）时，
    // 用空字符串占位，表示「只在根目录层匹配」，不再直接丢弃
    if (segs.length >= 2) taskDirs.add(segs[0])
  }

  return {
    ok: true,
    reason: 'ok',
    taskDirs: [...taskDirs],
    paths: normalized,
    relPaths,
    categoryByRel,
    sessionDirs: [...sessionDirs],
    subSessions: subLogs.length,
  }
}

/**
 * 扫描画廊候选：广度优先、深度受限、跳过批量目录、有目录/条目预算。
 * 结果按修改时间倒序，只回传 maxItems 条，另外给出 total 供「还有 N 张」。
 */

export async function scanGallery(config, kind = 'image', scope = 'global', sessionId = '', page = 1) {
  const opts = resolveOptions(config)
  const now = Date.now()
  const cutoff = now - opts.windowHours * 3600_000
  const isFile = kind === 'file'
  const isMedia = kind === 'media'
  const isSession = scope === 'session'
  // 页码从 1 开始；非法值一律回到第 1 页
  const currentPage = Math.max(1, Math.trunc(Number(page) || 1))
  // 图片格式永远排除在文件画廊之外；防止用户配置误把图片塞进来
  const extraImageEx = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.avif', '.ico'])
  // 音视频同样不能混进文件画廊（v0.10.1）：音视频有自己的画廊
  const mediaEx = new Set(opts.mediaExtensions)
  let rawExts
  if (isFile) rawExts = opts.fileExtensions
  else if (isMedia) rawExts = opts.mediaExtensions
  else rawExts = opts.extensions
  const extSet = new Set(rawExts.filter((e) => !(
    (isFile && extraImageEx.has(e))
    || (isFile && mediaEx.has(e))
    || (isMedia && extraImageEx.has(e))
  )))
  const skipSet = new Set(opts.skipDirs)

  // 截帧登记（v0.14.3）：新截出来的 PNG 不在任何会话日志里，
  // 靠这份只读登记把它挂回产出它的对话，否则会掉进「历史资产」组。
  const frameByRel = new Map()
  try {
    const stored = await readFrames(opts.settingsFile)
    for (const [rel, f] of Object.entries(stored.frames ?? {})) {
      if (f !== null && typeof f === 'object') frameByRel.set(String(rel).toLowerCase(), f)
    }
  } catch { /* 读不到就不登记，不影响正常扫描 */ }

  // 当前对话范围：先解析会话日志（含子智能体会话），得到「本对话产出过的路径」
  let scopeInfo = { ok: true, reason: 'global', taskDirs: [], paths: [], relPaths: [], subSessions: 0 }
  let sessionRelSet = null
  // v0.14.7：会话引用过的目录集合。同目录下的外部图片也纳入「当前对话」，
  // 但不在精确路径白名单里 —— 它们会被自动标为「素材」(input)。
  let sessionDirSet = null
  if (isSession) {
    scopeInfo = await resolveSessionScope(config, sessionId, opts.roots)
    // 修法 B：用「精确相对路径」集合判定，而不是只靠第一层目录名。
    // 这样既能处理有子目录的情况，也能处理「文件直接躺在 root 根目录下」。
    sessionRelSet = new Set((scopeInfo.relPaths ?? []).map((p) => p.toLowerCase()))
    sessionDirSet = new Set((scopeInfo.sessionDirs ?? []).map((d) => String(d).toLowerCase()))
    // 会话日志缺失时 resolveSessionScope 可能不带分类表，补一个空的
    if (!(scopeInfo.categoryByRel instanceof Map)) scopeInfo.categoryByRel = new Map()
    // 本对话截出来的帧：让它通过范围过滤，并给一个明确标签
    for (const [rel, f] of frameByRel) {
      if (String(f.sessionId ?? '') === sessionId) {
        sessionRelSet.add(rel)
        scopeInfo.categoryByRel?.set(rel, ASSET_CATEGORY.INTERMEDIATE)
        sessionDirSet.add(parentDirOf(rel))
      }
    }
  }

  // 会话索引：建立「文件 → 所属对话 + 分类」的映射，供全局按对话分组用
  const sessionsDir = typeof config?.sessionsDir === 'string' && config.sessionsDir !== ''
    ? path.resolve(config.sessionsDir)
    : DEFAULT_SESSIONS_DIR
  let sessionIndex = null
  // 全局模式才需要索引（当前对话模式已有自己的 scopeInfo）
  if (!isSession) {
    sessionIndex = await buildSessionIndex(sessionsDir, opts, {
      readSessionLogText,
      extractAssetInfo,
    })
  }

  // 文件绝对路径 → { sessionId, title, category }
  const ownerByAbs = new Map()
  if (sessionIndex !== null) {
    for (const [sid, entry] of sessionIndex) {
      for (const [abs, cat] of entry.files) {
        // 同一个文件被多个对话产出时，取最近的那个对话
        const prev = ownerByAbs.get(abs)
        if (prev === undefined || entry.createdAt > prev.createdAt) {
          ownerByAbs.set(abs, {
            sessionId: sid,
            title: entry.title || '',
            createdAt: entry.createdAt,
            category: cat,
          })
        }
      }
    }
  }

  // v0.14.8：全局资产下「当前对话」组也要认出外部素材。
  // 旧逻辑只在 scope=session 算 sessionDirs；全局模式只认会话日志 / frames.json
  // 精确引用过的文件，同目录里外部放进来、没被引用过的图全掉进「历史资产」
  // 并标「未归类」——界面上就表现为「当前对话」组只有几张过程稿、素材数为 0。
  // 这里复用与「当前对话」视图完全相同的目录判定，把无归属的同目录图片
  // 挂回当前对话组并标 input（素材）；其它对话 / 历史资产一律不动。
  let globalCurrentDirs = null
  let globalCurrentMeta = null
  if (!isSession && sessionId !== '') {
    const current = await resolveSessionScope(config, sessionId, opts.roots)
    if (current.ok) {
      const dirs = new Set((current.sessionDirs ?? []).map((d) => String(d).toLowerCase()))
      // 本对话截帧 / 遮罩的登记目录也算（与 session 模式保持一致）
      for (const [rel, f] of frameByRel) {
        if (String(f.sessionId ?? '') === sessionId) dirs.add(parentDirOf(rel))
      }
      globalCurrentDirs = dirs
      // 会话索引里可能没有该会话（日志里没有落在扫描目录内的产出），
      // 这时组名会退化成 sessionId 前 8 位。frames.json 的登记带会话标题，补上。
      const indexed = sessionIndex?.get(sessionId) ?? null
      let title = String(indexed?.title ?? '')
      let createdAt = Number(indexed?.createdAt) || 0
      for (const [, f] of frameByRel) {
        if (String(f.sessionId ?? '') !== sessionId) continue
        if (title === '') title = String(f.sessionTitle ?? '')
        if (createdAt === 0) createdAt = Number(f.sessionCreatedAt) || 0
        if (title !== '' && createdAt !== 0) break
      }
      globalCurrentMeta = { title, createdAt }
    }
  }

  // 已隐藏的路径：扫描时直接跳过（不移动文件，只从列表里拿掉）
  const hiddenSet = new Set(await readHiddenList(opts.settingsFile))

  const matches = []
  let directories = 0
  let entries = 0
  let capped = false
  let anyRootExists = false
  const missingRoots = []

  // 遍历所有扫描目录（多目录支持）
  for (const rootDir of opts.roots) {
    if (directories >= opts.maxDirectories || entries >= opts.maxEntries) {
      capped = true
      break
    }
    let rootOk = false
    try {
      const st = await fsp.stat(rootDir)
      rootOk = st.isDirectory()
    } catch {
      rootOk = false
    }
    if (!rootOk) {
      missingRoots.push(rootDir)
      continue
    }
    anyRootExists = true

    const dirQueue = [{ dir: rootDir, depth: 0 }]
    while (dirQueue.length > 0) {
      if (directories >= opts.maxDirectories || entries >= opts.maxEntries) {
        capped = true
        break
      }
      const { dir, depth } = dirQueue.shift()
      directories += 1
      let dirents
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirent of dirents) {
        entries += 1
        if (entries >= opts.maxEntries) {
          capped = true
          break
        }
        const entryName = String(dirent.name)
        const fullPath = path.join(dir, entryName)
        if (dirent.isDirectory()) {
          if (depth + 1 > opts.maxDepth) continue
          if (skipSet.has(entryName.toLowerCase())) continue
          dirQueue.push({ dir: fullPath, depth: depth + 1 })
          continue
        }
        if (!dirent.isFile()) continue
        const ext = path.extname(entryName).toLowerCase()
        if (!extSet.has(ext)) continue
        // 当前对话范围：按精确相对路径判定（支持根目录文件与多层子目录）
        const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/')
        // 当前对话：精确路径白名单优先；不在白名单但落在「本对话用过的目录」里，
        // 视作外部放进来的素材放行（v0.14.7）。其它目录一律不进当前对话。
        let externalAsset = false
        if (sessionRelSet !== null && !sessionRelSet.has(relPath.toLowerCase())) {
          if (sessionDirSet === null || !sessionDirSet.has(parentDirOf(relPath))) continue
          externalAsset = true
        }
        let stat
        try {
          stat = await fsp.stat(fullPath)
        } catch {
          continue
        }
        if (stat.size <= 0 || stat.mtimeMs < cutoff) continue
        // 音视频：超过体积上限的直接跳过（视频可能几百 MB，列出来点开就卡）
        if (isMedia && stat.size > opts.maxMediaBytes) continue
        // 被隐藏的直接跳过（隐藏只影响列表展示，文件仍在磁盘上）
        if (hiddenSet.has(relPath)) continue
        matches.push({
          relPath,
          relKey: `${opts.roots.indexOf(rootDir)}:${relPath}`,
          rootDir,
          rootIndex: opts.roots.indexOf(rootDir),
          name: entryName,
          size: stat.size,
          mtime: stat.mtimeMs,
          extension: ext,
          // v0.14.7：外部素材标记，扫描阶段据此给出「素材」标签
          ...(externalAsset ? { externalAsset: true } : {}),
          // 音视频区分「视频 / 音频」，客户端据此选 <video> 还是 <audio>
          ...(isMedia ? { mediaType: VIDEO_EXTS.includes(ext) ? 'video' : 'audio' } : {}),
        })
      }
    }
  }

  const rootMissing = !anyRootExists

  // v0.14.2：手动标签覆写优先于机器预判的产出状态。
  // 覆写落在扫描阶段而不是客户端，分组计数 / 顶部筛选 / 组头统计才会一起跟着变。
  let manualLabels = {}
  try {
    manualLabels = (await readLabels(opts.settingsFile)).labels ?? {}
  } catch { /* 读不到就老老实实用机器标签，不阻断扫描 */ }

  // 给每个条目附加「分类」和「所属对话」
  for (const item of matches) {
    const abs = path.join(item.rootDir, ...item.relPath.split('/'))
    const frame = frameByRel.get(item.relPath.toLowerCase())
    // 帧 / 遮罩来源元数据透传到卡片 / 反馈篮，草稿里才能写清来源。
    // 遮罩是「由某张原图的框选区域生成」的新资产（kind:'mask'），
    // 原图的反馈条目靠 maskOf.sourceRelPath 反查到它，路径随草稿带出、零自动发送。
    if (frame?.kind === 'mask') {
      item.maskOf = {
        relPath: String(item.relPath ?? ''),
        sourceRelPath: String(frame.sourceRelPath ?? ''),
        sourceName: String(frame.sourceName ?? ''),
        region: frame.region ?? null,
        // v0.14.6 右键多边形：像素级位置信息透传到反馈草稿
        polygon: Array.isArray(frame.polygon) ? frame.polygon : null,
        polygonPx: Array.isArray(frame.polygonPx) ? frame.polygonPx : null,
        bboxPx: Array.isArray(frame.bboxPx) ? frame.bboxPx : null,
        areaPx: Number(frame.areaPx) || 0,
        imageWidth: Number(frame.imageWidth) || 0,
        imageHeight: Number(frame.imageHeight) || 0,
        // v0.14.7 彩色填充预览图路径 + 颜色，随草稿带出（工作流仍用主遮罩）
        overlayRelPath: String(frame.overlayRelPath ?? ''),
        fillColor: String(frame.fillColor ?? ''),
      }
    } else if (frame !== undefined) {
      item.frameOf = {
        videoName: String(frame.videoName ?? ''),
        videoRelPath: String(frame.videoRelPath ?? ''),
        timecode: String(frame.timecode ?? ''),
        frameMs: Number(frame.frameMs) || 0,
      }
    }
    // 截帧不在会话日志里：ownerByAbs 查不到时，用登记里的会话信息补一个虚拟归属。
    // 日志里已有归属的文件（例如视频本身）一律沿用原归属，不受影响。
    const frameSid = String(frame?.sessionId ?? '')
    const virtualOwner = frame !== undefined && frameSid !== ''
      ? {
          sessionId: frameSid,
          title: String(frame.sessionTitle ?? '') || sessionIndex?.get(frameSid)?.title || '',
          createdAt: Number(frame.sessionCreatedAt) || sessionIndex?.get(frameSid)?.createdAt || 0,
          category: ASSET_CATEGORY.INTERMEDIATE,
        }
      : undefined
    const owner = ownerByAbs.get(abs) ?? virtualOwner
    item.absPath = abs
    if (isSession) {
      const autoCategory = scopeInfo.categoryByRel?.get(item.relPath.toLowerCase())
      // 外部放进本对话目录、日志里没引用的图 → 自动标「素材」(input)。
      // 手动改过的标签在下面仍然优先覆盖，刷新/重扫/重启都不回退。
      item.category = categoryForSessionAsset(autoCategory, item.externalAsset)
      item.sessionId = sessionId
    } else if (owner !== undefined) {
      item.category = owner.category
      item.sessionId = owner.sessionId
      item.sessionTitle = owner.title
      item.sessionCreatedAt = owner.createdAt
    } else if (globalCurrentDirs !== null && globalCurrentDirs.has(parentDirOf(item.relPath))) {
      // v0.14.8 全局模式：外部放进本对话目录、日志与登记都没引用的图片。
      // 与「当前对话」视图同一口径：挂回当前对话组 + 自动标「素材」(input)。
      // 只对「不属于任何已知对话」的条目生效，绝不抢别的对话已引用的文件。
      item.category = ASSET_CATEGORY.INPUT
      item.externalAsset = true
      item.sessionId = sessionId
      item.sessionTitle = globalCurrentMeta?.title ?? ''
      item.sessionCreatedAt = globalCurrentMeta?.createdAt ?? 0
    } else {
      // 不属于任何已知对话、也不在当前对话目录里的文件：归到「历史资产」，
      // 分类记为**未归类**。不能兜底成 input —— 那会把几千个历史文件全标成「输入」
      item.category = ASSET_CATEGORY.UNKNOWN
      item.sessionId = null
    }

    // 手动改过的标签覆盖机器预判，且刷新 / 重扫 / 重启都不会回退。
    const manual = manualLabels[item.relPath]
    if (manual !== undefined && LABEL_CATEGORIES.includes(manual?.category)) {
      item.category = manual.category
      item.categoryManual = true
    } else {
      item.categoryManual = false
    }
  }

  matches.sort((a, b) => b.mtime - a.mtime)
  const total = matches.length
  // 分页：每页 maxItems 条，保留 total 供页码条使用
  // 全局分组模式下不分页（客户端自己分组折叠），所有条目都返回摘要
  const pageCount = isSession
    ? Math.max(1, Math.ceil(total / opts.maxItems))
    : Math.max(1, Math.ceil(total / opts.maxItems))
  const safePage = Math.min(currentPage, pageCount)
  const offset = (safePage - 1) * opts.maxItems
  const visible = matches.slice(offset, offset + opts.maxItems)

  await Promise.all(visible.map(async (item) => {
    if (isFile || isMedia) {
      // 文件/音视频画廊不解析图片尺寸
      item.width = null
      item.height = null
      return
    }
    // 多目录：用该条目自己所属的 rootDir 拼绝对路径
    const measured = measureImage(
      await readHead(path.join(item.rootDir, ...item.relPath.split('/')), 65536),
      item.extension,
    )
    item.width = measured?.width ?? null
    item.height = measured?.height ?? null
  }))

  // 会话状态只读判定：只给分组加标注，不改排序、不改显示范围（0.14.1 原样）
  const sessionStates = isSession ? null : await readSessionStates(DSH_HOME)

  // 全量统计：供「全局按对话分组」使用（不受分页限制）
  const allItemsSummary = []
  if (!isSession) {
    for (const item of matches) {
      allItemsSummary.push({
        absPath: item.absPath,
        relPath: item.relPath,
        sessionId: item.sessionId,
        sessionTitle: item.sessionTitle ?? '',
        sessionCreatedAt: item.sessionCreatedAt ?? 0,
        category: item.category,
        mtime: item.mtime,
        width: item.width ?? null,
        height: item.height ?? null,
        size: item.size,
        name: item.name,
        extension: item.extension,
        // 音视频类型（video / audio），客户端据此选 <video> 还是 <audio>
        ...(item.mediaType !== undefined ? { mediaType: item.mediaType } : {}),
        // 截帧来源：反馈篮与草稿正文据此写清取自哪段视频的哪一帧
        ...(item.frameOf !== undefined ? { frameOf: item.frameOf } : {}),
      })
    }
  }

  return {
    kind,
    scope: isSession ? 'session' : 'global',
    scopeInfo: {
      ok: scopeInfo.ok,
      reason: scopeInfo.reason,
      taskDirs: scopeInfo.taskDirs.length,
      paths: scopeInfo.paths.length,
      relPaths: (scopeInfo.relPaths ?? []).length,
      // 子智能体会话数：> 0 表示已纳入它们的产出
      subSessions: scopeInfo.subSessions ?? 0,
      // v0.14.7：本对话用过的目录数 / 自动纳入的外部素材数（诊断用）
      // v0.14.8：全局模式另给一份目录数，两种视图口径是否一致一眼可查
      externalDirs: sessionDirSet?.size ?? 0,
      globalExternalDirs: globalCurrentDirs?.size ?? 0,
      externalAssets: matches.reduce((n, i) => n + (i.externalAsset ? 1 : 0), 0),
    },
    root: opts.root,
    roots: opts.roots,
    rootSource: opts.rootSource,
    missingRoots,
    windowHours: opts.windowHours,
    maxItems: opts.maxItems,
    maxDepth: opts.maxDepth,
    generatedAt: now,
    items: visible,
    total,
    // 分页信息，客户端据此渲染页码条
    page: safePage,
    pageCount,
    pageSize: opts.maxItems,
    // 「还有 N 张」= 当前页之外的总数（不再只是「被截掉的」）
    hidden: Math.max(0, total - visible.length),
    rootMissing,
    scan: { directories, entries, capped },
    // 全局模式额外返回：按对话分组的数据（客户端做折叠展示用）
    groups: isSession ? null : buildGroups(allItemsSummary, 120, sessionId, sessionStates),
  }
}

/**
 * 把扁平的资产列表按「所属对话」分组。
 *
 * 分组规则：
 *   - 属于某个已知对话的文件 → 归到该对话（标题用会话标题）
 *   - 其余（日志里查不到归属的历史文件）→ 统一归到「历史资产」组
 *
 * 排序（v0.8.2 调整）：
 *   1. **当前对话永远置顶** —— 用户打开「全局资产」最想先看自己这次做了什么，
 *      按时间倒序会把它压到中间（当前对话可能很早创建、但一直在用）。
 *   2. 其余对话按创建时间倒序。
 *   3. 「历史资产」永远最后。
 *
 * ⚠️ 体积控制：每组只返回前 maxPerGroup 条明细 + 完整总数。
 * 为什么必须截断：历史组有 4995 个文件，全量返回会让单次响应达到 1.3 MB，
 * 前端解析/渲染都会卡，面板看起来「只显示两组」。
 *
 * @param summary - 扁平资产摘要数组。
 * @param maxPerGroup - 每组最多返回多少条明细（默认 120）。
 * @param currentSessionId - 当前打开的会话 id；匹配到的组会标记 isCurrent 并置顶。
 * @returns 分组数组。
 */
