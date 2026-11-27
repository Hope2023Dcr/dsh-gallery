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
import { buildGroups, buildRootSessionResolver } from './groups.js'
import { collectAbsolutePaths, findSubSessionLogs, locateSessionDir, readSessionLogText } from './session.js'
import { readHiddenList, readHiddenSessions, resolveOptions } from './settings.js'
import { readLabels, LABEL_CATEGORIES } from './labels.js'
import { readFrames } from './frames.js'
import { buildSessionIndex, readSessionStates, sessionIndexCacheFileFor } from './session-index.js'

/**
 * v0.14.7：相对路径的父目录（统一小写；空串表示文件直接躺在 root 下）。
 * 当前对话据此判断「外部图片是否和本对话用过的资产在同一目录」。
 */
export function parentDirOf(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/').toLowerCase()
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
}

/**
 * 分类的「确定性」排序。同一对话多次引用同一张图（父会话 + 子智能体会话）时，
 * 取更确定的那个 —— 不能因为子会话只看了一眼就把定稿降级成素材。
 */
const CATEGORY_RANK = { final: 3, intermediate: 2, input: 1, unknown: 0 }

/** v0.14.7：当前对话分类。日志/登记里没有的、同目录外部图片自动标「素材」(input)。 */
/**
 * 2026-11-15：同目录放宽的「新鲜度」门槛。
 *
 * 老规则：只要本对话提到过某个目录里的任意一张图，该目录下所有图片都算
 * 这个对话的素材。只读查一次图（助手回答里带了几条历史路径）就会把几百张
 * 老图抢进新对话（真实实测：3 张相关 → 217 张，其中 207 张标成素材）。
 * 现在只放行「本对话开始之后新出现或新改动」的文件：插件粘贴 / 裁剪会
 * 把 mtime 刷成当前时间，仍看得见；手工拷贝旧文件时 birthtime 也是新的。
 * 拿不到会话开始时间时一律不放宽，宁可少显示也不误抢。
 */
export function isFreshSince(stat, sessionStartMs) {
  const since = Number(sessionStartMs) || 0
  if (since <= 0 || stat == null) return false
  const newest = Math.max(Number(stat.mtimeMs) || 0, Number(stat.birthtimeMs) || 0)
  return newest >= since
}

/**
 * 2026-11-16 第一档：限流并发执行。
 * scan 阶段每个文件都要读一次 stat，串行时五千多个文件要 7 秒左右；
 * 这里用固定数量的「工人」同时干，结果按下标回填，顺序与串行完全一致。
 */
export async function mapPool(items, limit, fn) {
  const list = Array.isArray(items) ? items : []
  const out = new Array(list.length)
  if (list.length === 0) return out
  const width = Math.max(1, Math.min(Math.trunc(Number(limit) || 1), list.length))
  let cursor = 0
  const workers = []
  for (let w = 0; w < width; w += 1) {
    workers.push((async () => {
      for (;;) {
        const i = cursor
        cursor += 1
        if (i >= list.length) return
        out[i] = await fn(list[i], i)
      }
    })())
  }
  await Promise.all(workers)
  return out
}

/** 并发读 stat 的路数：本地盘 32 路收益已接近上限，再高只增加抢占。 */
export const SCAN_CONCURRENCY = 32

export function categoryForSessionAsset(autoCategory, externalAsset) {
  return autoCategory ?? (externalAsset ? ASSET_CATEGORY.INPUT : null)

}

/**
 * 登记条目自带分类（v0.16.1）。
 *
 * frames.json 原本只登记截帧，截帧一律算「过程稿」(intermediate)。v0.16.1 起
 * 粘贴 / 裁剪也登记——它们是从外部拿进来的素材或切出来的片段，必须算「素材」
 * (input)，否则界面上跟截帧混成一堆过程稿，老板分不清哪个能直接喂给工作流。
 * 未知/缺省值仍回落到 intermediate，保持截帧原有行为不变。
 */
function frameCategoryOf(frame) {
  const c = String(frame?.category ?? '')
  if (c === ASSET_CATEGORY.INPUT || c === ASSET_CATEGORY.FINAL || c === ASSET_CATEGORY.UNKNOWN) return c
  return ASSET_CATEGORY.INTERMEDIATE
}

export function extractAssetInfo(logText, sessionStartMs = 0) {
  const assets = new Map()
  if (typeof logText !== 'string' || logText === '') return assets

  const ensure = (abs) => {
    if (!assets.has(abs)) {
      assets.set(abs, { presented: false, written: false, viewed: false, bashMentioned: false, lastMs: 0 })
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
          const recMs = typeof record.time === 'number' ? record.time : 0
          if (recMs > info.lastMs) info.lastMs = recMs
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
      const recMs = typeof record.time === 'number' ? record.time : 0
      if (recMs > info.lastMs) info.lastMs = recMs
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
 * 解析宿主「分叉会话」的继承边界（2026-11-24）。
 *
 * 宿主分叉会话的日志 = 复制来源会话到分叉点为止的历史 + 之后自己的新事件：
 *   - 首行 isSeeded: true  —— 这个会话含继承来的前缀；
 *   - 一条 session/end-seed 且 data.inherited: true —— 继承段到此结束，
 *     它的 time 就是精确的分叉时刻（实测与主线会话停止写入的时间只差 2ms）。
 * 非分叉会话返回 { isFork: false, forkAtMs: 0 }。
 *
 * @param logText - 解压后的日志文本。
 */
export function parseForkBoundary(logText) {
  const result = { isFork: false, forkAtMs: 0 }
  if (typeof logText !== 'string' || logText === '') return result
  let isSeeded = false
  let forkAtMs = 0
  for (const line of logText.split('\n')) {
    if (line === '') continue
    if (!isSeeded && line.includes('"session"')) {
      try {
        const first = JSON.parse(line)
        if (first.type === 'session' && first.isSeeded === true) isSeeded = true
      } catch {
        // 首行解析失败不影响后续扫描
      }
    }
    if (!line.includes('end-seed')) continue
    try {
      const o = JSON.parse(line)
      if (o.type === 'session/end-seed' && o.data?.inherited === true && typeof o.time === 'number') {
        forkAtMs = o.time
      }
    } catch {
      // 坏行跳过
    }
  }
  return { isFork: isSeeded && forkAtMs > 0, forkAtMs }
}

/**
 * 反查「从本会话分叉出去的子会话」在分叉点之后自己产出的资产（2026-11-24）。
 *
 * 宿主在分叉时刻意不留「我派生了谁」：主线日志到分叉点就停了；
 * 子会话日志则把主线日志逐条复制过来（seq / type / time 完全一致），
 * 以 session/end-seed{inherited:true} 收尾，之后才是自己的新事件。
 * 所以反向关联靠两条证据：子会话首行的 parentSession，或继承段的记录指纹。
 *
 * 主线扫描时按这些精确路径排除（主线自己日志精确记录过的除外）：
 * 它们不在主线日志里，只靠「本对话用过的目录 + 新 mtime」放宽倒灌回主线，
 * 不拦就会出现「分叉对话的产出全跑到主线」。
 *
 * 每个 child 带两类路径：paths（分叉后新产出，主线要挡掉）与 inheritedPaths
 * （分叉前从主线继承，主线要标「共享」）。
 * @returns {{ children: Array<{id:string,forkAtMs:number,paths:string[],inheritedPaths:string[]}> }}
 */
export async function findForkedChildren(sessionsDir, parentSessionId, parentLogText) {
  const result = { children: [] }
  if (typeof parentSessionId !== 'string' || parentSessionId === '') return result
  if (typeof parentLogText !== 'string' || parentLogText === '') return result

  const ownDir = await locateSessionDir(sessionsDir, parentSessionId)
  if (ownDir === null) return result
  const groupDir = path.dirname(ownDir)

  // 主线日志的 (seq,type,time) 指纹。只比 seq / 类型 / 时间，不比内容，
  // 宿主复制日志时这三项是逐条保留的（实测 2210 条全中）。
  const parentFp = new Map()
  for (const line of parentLogText.split('\n')) {
    if (line === '') continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (typeof o?.seq === 'number') parentFp.set(o.seq, `${o.type}|${o.time}`)
  }
  if (parentFp.size < 10) return result

  let entries
  try { entries = await fsp.readdir(groupDir, { withFileTypes: true }) } catch { return result }
  for (const dirent of entries) {
    if (!dirent.isDirectory() || dirent.name === path.basename(ownDir)) continue
    const logPath = path.join(groupDir, dirent.name, 'session.v4.jsonl.zstd')
    const text = await readSessionLogText(logPath)
    if (text === '') continue
    let head = null
    try { head = JSON.parse(text.split('\n')[0]) } catch { continue }
    const fork = parseForkBoundary(text)
    if (!fork.isFork) continue

    let linked = false
    if (head?.parentSession === parentSessionId) {
      linked = true
    } else if (head?.isSeeded === true) {
      // 继承段（forkAtMs 之前）的记录应与主线逐条一致
      let same = 0
      let total = 0
      for (const line of text.split('\n')) {
        if (line === '') continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        if (typeof o?.seq !== 'number' || typeof o?.time !== 'number') continue
        if (o.time >= fork.forkAtMs) continue
        total += 1
        if (parentFp.get(o.seq) === `${o.type}|${o.time}`) same += 1
      }
      linked = total >= 10 && same / total >= 0.95
    }
    if (!linked) continue

    // 只收由 present / 写入类工具明确产出的绝对路径（bash 弱证据不收）。
    // 分叉点之后 → paths（子会话新产出，主线挡掉）；
    // 分叉点之前 → inheritedPaths（从主线带走，主线标「共享」）。
    const paths = new Set()
    const inheritedPaths = new Set()
    for (const line of text.split('\n')) {
      if (line === '' || !line.includes('tool/call')) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o?.type !== 'tool/call' || typeof o.time !== 'number') continue
      const name = o?.data?.name
      if (typeof name !== 'string') continue
      if (name !== 'present' && !OUTPUT_TOOLS.has(name)) continue
      const rawArgs = o?.data?.arguments
      if (typeof rawArgs !== 'string') continue
      let args
      try { args = JSON.parse(rawArgs) } catch { continue }
      const found = []
      if (name === 'present' && Array.isArray(args?.files)) {
        for (const f of args.files) {
          if (typeof f?.path === 'string') found.push(f.path)
        }
      } else {
        collectAbsolutePaths(args, found)
      }
      const bucket = o.time >= fork.forkAtMs ? paths : inheritedPaths
      for (const p of found) {
        try { bucket.add(path.resolve(p)) } catch { /* 坏路径跳过 */ }
      }
    }
    if (paths.size > 0 || inheritedPaths.size > 0) {
      result.children.push({
        id: String(head?.id ?? dirent.name),
        forkAtMs: fork.forkAtMs,
        paths: [...paths],
        inheritedPaths: [...inheritedPaths],
      })
    }
  }
  return result
}

/**
 * 从 bash 命令里提取「脚本直接读写的媒体目录」（2026-11-24）。
 *
 * 脚本调接口下载 / ffmpeg 处理的产物（如配音 mp3）不经过 present/write，
 * 日志里只在命令文本里以 `cd "绝对目录" + *.mp3` 的形式出现。
 * 这类目录本身要登记成「本对话用过的目录」，BFS 才会放行目录里真实存在的媒体文件。
 * 只认：命令类工具 + 命令里同时出现媒体通配符 + cd 到产出根内的绝对路径。
 *
 * @returns Map<lowercase abs, original abs>
 */
export function extractCommandMediaDirs(logText) {
  const dirs = new Map()
  if (typeof logText !== 'string' || logText === '') return dirs
  const MEDIA_GLOB = /\*\.(mp4|webm|mov|m4v|mkv|avi|ogv|mp3|wav|m4a|aac|flac|ogg|oga|opus|wma)\b/i
  const CD_RE = /\bcd\s+["']?([A-Za-z]:[\\/][^"'\s;|&]+)["']?/g
  for (const line of logText.split('\n')) {
    if (line === '' || !line.includes('tool/call')) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record?.type !== 'tool/call' || !BASH_TOOLS.has(record?.data?.name)) continue
    let args
    try { args = JSON.parse(record?.data?.arguments) } catch { continue }
    const cmd = String(args?.command ?? '')
    if (cmd === '' || !MEDIA_GLOB.test(cmd)) continue
    for (const m of cmd.matchAll(CD_RE)) {
      let dir = String(m[1] ?? '').replace(/[\\/]+$/, '')
      try { dir = path.resolve(dir) } catch { continue }
      const key = dir.toLowerCase()
      if (!dirs.has(key)) dirs.set(key, dir)
    }
  }
  return dirs
}

/** 命令结果里的媒体文件，只认「命令刚跑完时产出」的：与命令时刻相差不超过 30 分钟。 */
export const RESULT_MEDIA_WINDOW_MS = 30 * 60 * 1000

/**
 * 从「命令执行结果」里提取脚本刚产出的媒体文件（2026-11-26）。
 *
 * 11-24 的 extractCommandMediaDirs 只认命令里的 `cd 绝对目录 + *.mp3` 通配符。
 * 但 pwsh 直接跑 Python 脚本时，命令里只有 `& $py "…\02_tts.py"`，既无 cd 也无
 * 通配符；音频路径只写在脚本正文和命令输出里。实测这类输出长这样：
 *     s1   开场    5.62s  s1.mp3                       ← 裸媒体文件名（产出清单）
 *     manifest: G:\…\项目\audio\manifest.json          ← 输出目录的绝对路径
 * 把「清单路径的父目录」与「裸媒体文件名」拼起来，就是本次真实产出的精确文件。
 *
 * 收紧条件（防止把长会话里历史调试输出中的老音频一起翻出来）：
 *   ① 只处理 BASH_TOOLS 的 tool/call 所对应的 tool/result（靠 callId 精确关联）；
 *   ② 同一条结果里必须同时出现「裸媒体文件名」和「绝对路径」；
 *   ③ 只收 mtime 与命令时刻相差 RESULT_MEDIA_WINDOW_MS 内的真实媒体文件
 *      （在 resolveSessionScope 里 stat 判定），命令刚产出的才要。
 *
 * 返回精确文件路径（绝对路径 → 命令时刻 ms），**不做目录级放宽**：
 * 目录级放宽会连带上百张同目录老文件（11-15 真实事故），精确白名单从根上避开。
 *
 * @returns Map<abs, callTimeMs>
 */
export function extractResultMediaFiles(logText) {
  const files = new Map()
  if (typeof logText !== 'string' || logText === '') return files

  const MEDIA_EXT = /\.(?:mp3|wav|m4a|aac|flac|ogg|oga|opus|wma|mp4|webm|mov|m4v|mkv|avi|ogv)$/i
  const BARE_MEDIA = /(?:^|[\s"'=（(,，:：])([^\s"'\\/|&;<>]*\.(?:mp3|wav|m4a|aac|flac|ogg|oga|opus|wma|mp4|webm|mov|m4v|mkv|avi|ogv))\b/gi
  const ABS_PATH = /[A-Za-z]:[\\/][^\s"'|&;<>()*?]+/g

  // 第一遍：命令类调用的 callId → 命令时刻。把结果文本的范围钉死在「命令执行」上。
  const calls = new Map()
  for (const line of logText.split('\n')) {
    if (line === '' || !line.includes('tool/call')) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record?.type !== 'tool/call' || !BASH_TOOLS.has(record?.data?.name)) continue
    const id = String(record?.data?.callId ?? '')
    if (id === '') continue
    calls.set(id, typeof record.time === 'number' ? record.time : 0)
  }
  if (calls.size === 0) return files

  const add = (abs, callTime) => {
    let resolved
    try { resolved = path.resolve(abs) } catch { return }
    if (!files.has(resolved)) files.set(resolved, callTime)
  }

  // 第二遍：只处理能关联到命令调用的 tool/result。
  for (const line of logText.split('\n')) {
    if (line === '' || !line.includes('tool/result')) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record?.type !== 'tool/result') continue
    const msg = record?.data?.message
    const rid = String(msg?.source?.callId ?? msg?.toolCallId ?? record?.data?.toolCallId ?? '')
    if (rid === '' || !calls.has(rid)) continue
    const callTime = calls.get(rid)
    const parts = Array.isArray(msg?.content) ? msg.content : []
    let text = ''
    for (const p of parts) {
      if (p && typeof p.text === 'string') text += `${p.text}\n`
    }
    if (text === '') continue
    const bare = new Set()
    for (const m of text.matchAll(BARE_MEDIA)) bare.add(String(m[1] ?? ''))
    if (bare.size === 0) continue
    for (const m of text.matchAll(ABS_PATH)) {
      let candidate = String(m[0]).replace(/[\\/]+$/, '').replace(/[.,;:，。；：、]+$/, '')
      let dir
      if (MEDIA_EXT.test(candidate)) {
        // 路径本身就是媒体文件：要求结果文本里也列出了它的裸名，才算证据配对。
        const base = path.basename(candidate)
        let paired = bare.has(base)
        if (!paired) {
          const low = base.toLowerCase()
          for (const name of bare) { if (name.toLowerCase() === low) { paired = true; break } }
        }
        if (!paired) continue
        add(candidate, callTime)
        dir = path.dirname(candidate)
      } else {
        dir = path.extname(candidate) === '' ? candidate : path.dirname(candidate)
      }
      for (const name of bare) {
        if (name === '' || name.includes('*') || name.includes('?')) continue
        add(path.join(dir, name), callTime)
      }
    }
  }
  return files
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
  const createdAtMs = parseSessionStartMs(logText)
  // 2026-11-24：脚本直接下载的媒体（配音 mp3 等）没有 present/write 记录，
  // 只以 cd 目录 + *.mp3 出现在命令里；把这类目录登记进来，BFS 才会放行目录里的真实文件。
  const commandMediaDirs = extractCommandMediaDirs(logText)
  // 2026-11-24 分叉资产隔离：分叉会话的「有效开始时间」是分叉点，不是会话创建时间。
  // 宿主会把来源会话到分叉点的历史整段复制过来（isSeeded + end-seed inherited），
  // 若沿用 createdAt，继承段的产出会被算成「本对话」的，跟主线重复。
  // sessionStartMs 同时掌管同目录放宽的时间门槛，改这里一处两条路径都干净。
  const fork = parseForkBoundary(logText)
  const sessionStartMs = fork.isFork && fork.forkAtMs > createdAtMs ? fork.forkAtMs : createdAtMs
  // 2026-11-24：反向隔离。主线会话要认出「从它分叉出去的子会话」，
  // 把子会话分叉后的新产出按绝对路径挡在主线之外；分叉会话自己不需要这一步。
  const forkedChildren = fork.isFork
    ? { children: [] }
    : await findForkedChildren(sessionsDir, sessionId, logText)
  const allAssets = extractAssetInfo(logText, sessionStartMs)

  // 2026-11-26：pwsh 跑脚本时音频只出现在命令结果里（裸文件名 + manifest 绝对路径），
  // 11-24 的 cd + 通配符补丁认不到。把「命令刚产出的精确媒体文件」并进资产表：
  // 精确白名单，不做目录级放宽，避免连带吸进同目录的老文件。
  const resultMediaExt = new Set((opts.mediaExtensions ?? []).map((e) => String(e).toLowerCase()))
  const mergeResultMedia = (text) => {
    for (const [abs, callTime] of extractResultMediaFiles(text)) {
      if (allAssets.has(abs) || !(callTime > 0)) continue
      if (!resultMediaExt.has(path.extname(abs).toLowerCase())) continue
      let st
      try { st = statSync(abs) } catch { continue }
      if (!st.isFile()) continue
      // 只收「命令刚跑完时产出」的媒体：长会话里历史调试输出提到的老音频
      // 与命令时刻差着好几天，一律挡掉。
      if (Math.abs(st.mtimeMs - callTime) > RESULT_MEDIA_WINDOW_MS) continue
      allAssets.set(abs, {
        presented: false, written: true, viewed: false, bashMentioned: true,
        lastMs: callTime,
      })
    }
  }
  mergeResultMedia(logText)

  // 修法 C：合并所有子会话（子智能体）的产出路径
  const subLogs = await findSubSessionLogs(sessionsDir, sessionId)
  for (const subLog of subLogs) {
    const subText = await readSessionLogText(subLog)
    if (subText === '') continue
    mergeResultMedia(subText)
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
  // 2026-11-24：分叉会话里「继承自主线」的资产单独记录，不并入本分支的「当前对话」。
  const inheritedPaths = []
  const inheritedRelPaths = []
  const taskDirs = new Set()
  // v0.14.7：会话引用过的「精确目录」（相对 root、小写，空串表示 root 直属层）。
  // 外部拷进同一目录、没被日志引用的图片，也要能在「当前对话」里看到并标为素材。
  const sessionDirs = new Set()
  /**
   * v0.16.2：同一批目录的**绝对路径**（保留原始大小写）。
   *
   * 只留相对路径时，Host 拼目录只能赌「属于第一个 root」—— 本机有两个产出根
   * （G:/DSH产出、G:/DSH任务文件），会话只用了第二个时就会拼到第一个根下，
   * mkdir 造出一个空目录，粘贴的资产凭空消失。这里把根一起记下来。
   */
  const sessionDirsAbs = new Set()
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

    const rel = path.relative(ownerRoot, absolute)
    const segs = rel.split(path.sep).filter((s) => s !== '')
    const relPath = rel.split(path.sep).join('/')

    // 分叉会话：最后被日志提及的时间早于分叉边界 → 继承自主线的资产。
    // 2026-11-24 口径修正：照常进主列表（图片/文件/音视频混排），只额外记进
    // inherited*，由 scanGallery 给条目打 inherited:true；前端加「继承」角标
    // 区分来源，除删除提示外的交互与本对话产出完全一致。
    // lastMs=0（事件没带 time）保守当作本对话，宁可多显示也不误删。
    const isInherited = fork.isFork && info.lastMs > 0 && info.lastMs < fork.forkAtMs
    if (isInherited) {
      inheritedPaths.push(absolute)
      inheritedRelPaths.push(relPath)
    }

    normalized.push(absolute)
    relPaths.push(relPath)
    categoryByRel.set(relPath.toLowerCase(), info.category)
    sessionDirs.add(parentDirOf(relPath))
    sessionDirsAbs.add(path.dirname(absolute))
    // 修法 B：有子目录时取第一层；没有子目录（文件直接在 root 下）时，
    // 用空字符串占位，表示「只在根目录层匹配」，不再直接丢弃
    if (segs.length >= 2) taskDirs.add(segs[0])
  }

  // 2026-11-24：脚本直接下载的媒体目录（命令里 cd + 媒体通配符）也算会话用过的目录。
  // 只收落在产出根内的、且确实存在的绝对路径；仍受 BFS 深度与 isFreshSince 门槛约束。
  for (const absDir of commandMediaDirs.values()) {
    let ownerRoot = null
    for (const r of roots) {
      if (isInside(r, absDir)) { ownerRoot = r; break }
    }
    if (ownerRoot === null) continue
    try {
      if (!statSync(absDir).isDirectory()) continue
    } catch {
      continue
    }
    const relDir = path.relative(ownerRoot, absDir).split(path.sep).join('/')
    if (relDir === '' || relDir.startsWith('..')) continue
    sessionDirs.add(relDir.toLowerCase())
    sessionDirsAbs.add(absDir)
  }

  return {
    ok: true,
    reason: 'ok',
    // 2026-11-24：分叉会话用分叉点当「会话开始」，同时掌管下面的放宽时间门槛
    isFork: fork.isFork,
    forkAtMs: fork.forkAtMs,
    forkedChildren,
    inheritedPaths,
    inheritedRelPaths,
    // 2026-11-15：同目录放宽只收本对话开始之后新出现 / 改动的文件
    sessionStartMs,
    taskDirs: [...taskDirs],
    paths: normalized,
    relPaths,
    categoryByRel,
    sessionDirs: [...sessionDirs],
    sessionDirsAbs: [...sessionDirsAbs],
    subSessions: subLogs.length,
  }
}

/**
 * 扫描画廊候选：广度优先、深度受限、跳过批量目录、有目录/条目预算。
 * 结果按修改时间倒序，只回传 maxItems 条，另外给出 total 供「还有 N 张」。
 */

export async function scanGallery(config, kind = 'image', scope = 'global', sessionId = '', page = 1, optsOverride) {
  // 2026-11-25：第 6 个参数只给内部「按分类取全量」用，且只认 maxItems。
  // 把它抬到 5000，「按标签圈选」一次就能拿全，不必按页重扫 ——
  // 当前对话视图每扫一页都要重解一次会话日志，翻十几页会让面板卡住好几秒。
  const optsBase = resolveOptions(config)
  const opts = optsOverride !== undefined && optsOverride !== null && Number(optsOverride.maxItems) > 0
    ? { ...optsBase, maxItems: Math.max(1, Math.trunc(Number(optsOverride.maxItems))) }
    : optsBase
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
  // 2026-11-24：继承自主线的资产绝对路径集合（分叉会话才有值；global 模式为 null）
  let inheritedAbsSet = null
  // 2026-11-24：主线视图要排除的「分叉子会话分叉后新产出」绝对路径集合
  let childForkAbsSet = null
  // 2026-11-24：主线里「被分叉会话带走的共享资产」——前端加同款虚线框 +「共享」角标
  let sharedAbsSet = null
  // 截帧 / 遮罩 / 填充预览只登记在 frames.json，不在会话日志里；
  // 它们按相对路径登记，另外用相对路径集合挡一道（含 overlayRelPath）。
  let childForkRelSet = null
  // v0.14.7：会话引用过的目录集合。同目录下的外部图片也纳入「当前对话」，
  // 但不在精确路径白名单里 —— 它们会被自动标为「素材」(input)。
  let sessionDirSet = null
  let sessionStartMs = 0
  if (isSession) {
    scopeInfo = await resolveSessionScope(config, sessionId, opts.roots)
    sessionStartMs = Number(scopeInfo.sessionStartMs) || 0
    // 修法 B：用「精确相对路径」集合判定，而不是只靠第一层目录名。
    // 这样既能处理有子目录的情况，也能处理「文件直接躺在 root 根目录下」。
    sessionRelSet = new Set((scopeInfo.relPaths ?? []).map((p) => p.toLowerCase()))
    // 2026-11-24：继承自主线的资产绝对路径集合。用于给扫描条目打 inherited 标记——
    // 这类文件常落在「本对话用过的目录」里，也可能被手工拷贝改新 mtime，
    // 只有按日志算出的精确路径集合才认得准来源。
    inheritedAbsSet = new Set(
      (Array.isArray(scopeInfo.inheritedPaths) ? scopeInfo.inheritedPaths : []).map((x) => {
        try { return path.resolve(String(x)).toLowerCase() } catch { return '' }
      }),
    )
    const kids = Array.isArray(scopeInfo.forkedChildren?.children) ? scopeInfo.forkedChildren.children : []
    if (kids.length > 0) {
      childForkAbsSet = new Set()
      childForkRelSet = new Set()
      sharedAbsSet = new Set()
      const kidIds = new Set(kids.map((kid) => String(kid?.id ?? '')))
      for (const kid of kids) {
        for (const abs of (Array.isArray(kid?.paths) ? kid.paths : [])) {
          try { childForkAbsSet.add(path.resolve(String(abs)).toLowerCase()) } catch { /* 跳过 */ }
        }
        // 子会话的继承段（分叉点前）就是「从主线带走」的那批，主线侧标共享
        for (const abs of (Array.isArray(kid?.inheritedPaths) ? kid.inheritedPaths : [])) {
          try { sharedAbsSet.add(path.resolve(String(abs)).toLowerCase()) } catch { /* 跳过 */ }
        }
      }
      // 分叉会话生成的遮罩图（kind:'mask'）与半透明填充（overlayRelPath）
      // 只在 frames.json 里登记，日志没有它们的影子；按会话 id 反查一并排除。
      for (const [rel, f] of frameByRel) {
        if (!kidIds.has(String(f?.sessionId ?? ''))) continue
        childForkRelSet.add(rel)
        const overlay = String(f?.overlayRelPath ?? '').toLowerCase()
        if (overlay !== '') childForkRelSet.add(overlay)
      }
      if (childForkAbsSet.size === 0) childForkAbsSet = null
      if (childForkRelSet.size === 0) childForkRelSet = null
    }
    sessionDirSet = new Set((scopeInfo.sessionDirs ?? []).map((d) => String(d).toLowerCase()))
    // 会话日志缺失时 resolveSessionScope 可能不带分类表，补一个空的
    if (!(scopeInfo.categoryByRel instanceof Map)) scopeInfo.categoryByRel = new Map()
    // 本对话派生出来的资产（截帧 / 粘贴 / 裁剪）：让它通过范围过滤，并给一个明确标签
    for (const [rel, f] of frameByRel) {
      if (String(f.sessionId ?? '') === sessionId) {
        sessionRelSet.add(rel)
        scopeInfo.categoryByRel?.set(rel, frameCategoryOf(f))
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
      // v1.6.5：重启后复用上次的日志解析结果，避免每次开面板都全量解压 zstd。
      cacheFile: sessionIndexCacheFileFor(opts.settingsFile),
    })
  }

  // 文件绝对路径 → [{ sessionId, title, createdAt, category }]（**多值**）
  //
  // 2026-11-25：子智能体会话（parentSession 指向父会话）的产出并进**根父会话**。
  // 「当前对话」视图本来就把子会话资产合并（见 resolveSessionScope 的「修法 C」），
  // 但全局按对话分组时子会话是按 owner 单独成组的 —— 两套尺子不一致，实测就是
  // 「全局里这个对话只有 5 张，点进对话却有 35 张」，看着像资产丢了。
  //
  // 同日再改：改成**多值**。原先「一个文件只归一个对话，谁最近引用算谁的」，
  // 结果只要另一个对话贴过这张图，原对话的组里就少一张（老板实测：打开有 21 张、
  // 全局只剩 5 张）。现在凡是在日志里引用过它的对话都记下来，分组时各入各的组，
  // 两个视图才对得上账。实测全库 3527 个被引用的文件里 1523 个被多个对话引用。
  const rootSessionOf = buildRootSessionResolver(sessionIndex)
  const ownerByAbs = new Map()
  if (sessionIndex !== null) {
    for (const [sid, entry] of sessionIndex) {
      const rootId = rootSessionOf(sid)
      const rootEntry = rootId === sid ? entry : sessionIndex.get(rootId)
      const groupTitle = String(rootEntry?.title ?? entry.title ?? '')
      const groupCreatedAt = Number(rootEntry?.createdAt) || Number(entry.createdAt) || 0
      for (const [abs, cat] of entry.files) {
        let list = ownerByAbs.get(abs)
        if (list === undefined) {
          list = []
          ownerByAbs.set(abs, list)
        }
        const exist = list.find((x) => x.sessionId === rootId)
        if (exist === undefined) {
          list.push({
            sessionId: rootId,
            title: groupTitle,
            createdAt: groupCreatedAt,
            category: cat,
            // 原始产出会话：子会话时与 sessionId 不同，供诊断用
            ...(rootId === sid ? {} : { ownerSessionId: sid }),
          })
        } else if (CATEGORY_RANK[cat] > CATEGORY_RANK[exist.category]) {
          // 同一对话多次引用（父 + 子会话）时取更确定的那一档：final > intermediate > input
          exist.category = cat
        }
      }
    }
  }

  // 2026-11-25：全局分组的「产出者」索引 —— 靠「用过的目录 + 时间窗口」判定谁产出的。
  //
  // 起因（老板两次报）：全局里「DSH辅助漫剧制作流程」只剩 2 张，切进该对话却有 13 张。
  // 那 11 张在 11-24 13:25 产出，却被 11-24 20:21 才开张的同名对话 (1)「引用」走了 ——
  // 文件比它开张还早一个多小时。原规则「谁最近引用算谁的」把**看过**当成了**产出**。
  //
  // 三条约束，缺一不可：
  //   ① 目录必须是有子目录的层（根直属层在 session-index 里已排除，太宽）；
  //   ② 文件必须晚于该会话开始（isFreshSince 同一把关），老图不会被新对话吸走；
  //   ③ 同目录被多个会话用过时取「开始得最晚」的那个。
  // 优先级见下面 item 归属链：当前对话 > 截帧登记 > 本索引 > 日志精确引用。
  const dirOwnerIndex = new Map()
  if (sessionIndex !== null) {
    for (const [sid, entry] of sessionIndex) {
      const dirs = entry.dirs
      if (!(dirs instanceof Set) || dirs.size === 0) continue
      const rootId = rootSessionOf(sid)
      const rootEntry = rootId === sid ? entry : sessionIndex.get(rootId)
      const startMs = Number(entry.startMs) || Number(entry.createdAt) || 0
      if (startMs <= 0) continue
      const cand = {
        sessionId: rootId,
        title: String(rootEntry?.title ?? entry.title ?? ''),
        createdAt: Number(rootEntry?.createdAt) || Number(entry.createdAt) || 0,
        startMs,
      }
      for (const dir of dirs) {
        const item = dir === '' ? { ...cand, rootLevel: true } : cand
        const list = dirOwnerIndex.get(dir)
        if (list === undefined) dirOwnerIndex.set(dir, [item])
        else list.push(item)
      }
    }
  }
  /**
   * 目录 + 时间判定：返回**所有**命中的候选会话（开始时间从新到旧）。
   *
   * 为什么返回数组而不是只挑一个：老板对账的标准是「打开这个对话看到几张，
   * 全局这个组就该有几张」。实测 a912 与 94d7 两个对话的活跃期重叠，
   * 同一批图两边都说得通 —— 单选必然让一边少几张，看着就像资产丢了。
   * 允许「一张图同时属于用它产出过的每个对话」，两个视图就永远对得上账。
   * 实测代价：全库 6944 条里仅 266 条（3.8%）会进多个组，可接受。
   */
  const matchDirOwners = (item) => {
    if (dirOwnerIndex.size === 0) return []
    const list = dirOwnerIndex.get(parentDirOf(item.relPath))
    if (list === undefined) return []
    // 🔴 只认 mtime（最后写出时间），**不看 birthtime**。
    // 实测踩过：图卡 mtime 是产出时间，但 birthtime 因跨盘复制变成了更晚的时刻，
    // 于是被判定「更晚开张的对话也算新鲜」，归属被抢走。
    const mtime = Number(item.mtime) || 0
    if (mtime <= 0) return []
    const hits = []
    const seen = new Set()
    for (const cand of list) {
      if (mtime < cand.startMs) continue
      if (seen.has(cand.sessionId)) continue
      seen.add(cand.sessionId)
      hits.push(cand)
    }
    hits.sort((a, b) => {
      // 根直属层的最低优先：有具体子目录的判定永远排在前面
      if ((a.rootLevel === true) !== (b.rootLevel === true)) return a.rootLevel === true ? 1 : -1
      return b.startMs - a.startMs
    })
    return hits
  }

  // 2026-11-15：全局资产下置顶的「当前对话」组，必须和「当前对话」视图用同一把尺子。
  // 旧做法把归属交给全库会话索引、谁最近算谁的：本对话明明能看见的图，
  // 会被更早引用过它的老对话抢走（老板实测：全局 2 张、当前对话视图 4 张）。
  // 现在先解析本对话范围（精确路径 + 用过的目录），符合的资产一律归本对话组；
  // 其余仍按会话索引 / 登记归属，历史资产口径不变。
  let globalCurrentDirs = null
  let globalCurrentMeta = null
  let globalCurrentExactRels = null
  let globalCurrentCategory = null
  let globalCurrentStartMs = 0
  // 2026-11-24：全局视图里置顶的「当前对话」组同样不能吞进分叉子会话的新产出
  let globalCurrentChildForkAbsSet = null
  let globalCurrentChildForkRelSet = null
  let globalCurrentSharedAbsSet = null
  // 2026-11-25：全局视图里「子会话（分叉）继承自主线」的资产绝对路径集合。
  // 分叉会话在资产台（全局视图）同样要看到「继承」角标，口径与当前对话视图一致。
  let globalCurrentInheritedAbsSet = null
  if (!isSession && sessionId !== '') {
    const current = await resolveSessionScope(config, sessionId, opts.roots)
    if (current.ok) {
      globalCurrentStartMs = Number(current.sessionStartMs) || 0
      const dirs = new Set((current.sessionDirs ?? []).map((d) => String(d).toLowerCase()))
      const exactRels = new Set((current.relPaths ?? []).map((p) => String(p).toLowerCase()))
      const categoryByRel = new Map()
      for (const [rel, cat] of (current.categoryByRel instanceof Map ? current.categoryByRel : new Map())) {
        categoryByRel.set(String(rel).toLowerCase(), cat)
      }
      // 本对话截帧 / 遮罩的登记目录与精确路径也算（与 session 模式保持一致）
      for (const [rel, f] of frameByRel) {
        if (String(f.sessionId ?? '') !== sessionId) continue
        dirs.add(parentDirOf(rel))
        exactRels.add(String(rel).toLowerCase())
        categoryByRel.set(String(rel).toLowerCase(), frameCategoryOf(f))
      }
      const kidAbs = new Set()
      const kidRels = new Set()
      const sharedAbs = new Set()
      const kids = Array.isArray(current.forkedChildren?.children) ? current.forkedChildren.children : []
      const kidIds = new Set(kids.map((kid) => String(kid?.id ?? '')))
      for (const kid of kids) {
        for (const abs of (Array.isArray(kid?.paths) ? kid.paths : [])) {
          try { kidAbs.add(path.resolve(String(abs)).toLowerCase()) } catch { /* 跳过 */ }
        }
        for (const abs of (Array.isArray(kid?.inheritedPaths) ? kid.inheritedPaths : [])) {
          try { sharedAbs.add(path.resolve(String(abs)).toLowerCase()) } catch { /* 跳过 */ }
        }
      }
      if (sharedAbs.size > 0) globalCurrentSharedAbsSet = sharedAbs
      const inhAbs = new Set()
      for (const abs of (Array.isArray(current.inheritedPaths) ? current.inheritedPaths : [])) {
        try { inhAbs.add(path.resolve(String(abs)).toLowerCase()) } catch { /* 跳过 */ }
      }
      if (inhAbs.size > 0) globalCurrentInheritedAbsSet = inhAbs
      // 遮罩 / 填充预览只登记在 frames.json，按会话 id 一并排除出主线的当前对话组
      for (const [rel, f] of frameByRel) {
        if (!kidIds.has(String(f?.sessionId ?? ''))) continue
        kidRels.add(rel)
        const overlay = String(f?.overlayRelPath ?? '').toLowerCase()
        if (overlay !== '') kidRels.add(overlay)
      }
      if (kidAbs.size > 0) globalCurrentChildForkAbsSet = kidAbs
      if (kidRels.size > 0) globalCurrentChildForkRelSet = kidRels
      globalCurrentDirs = dirs
      globalCurrentExactRels = exactRels
      globalCurrentCategory = categoryByRel
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

  // 2026-11-25：当前对话本身若是子智能体会话，「当前对话组」也按根父会话算 ——
  // 否则同一个子会话的文件会在两个组里分家（目录兜底进父组、精确命中的自成一组）。
  const currentRootSid = sessionId === '' ? sessionId : rootSessionOf(sessionId)
  const currentRootMeta = currentRootSid === sessionId
    ? globalCurrentMeta
    : {
        title: String(sessionIndex?.get(currentRootSid)?.title ?? globalCurrentMeta?.title ?? ''),
        createdAt: Number(sessionIndex?.get(currentRootSid)?.createdAt) || globalCurrentMeta?.createdAt || 0,
      }

  // 已隐藏的路径：扫描时直接跳过（不移动文件，只从列表里拿掉）
  const hiddenSet = new Set(await readHiddenList(opts.settingsFile))

  const matches = []
  // 2026-11-16 第一档：两阶段扫描的候选路径暂存（先收集、再并发 stat）
  const candidates = []
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
        let looseDirHit = false
        if (sessionRelSet !== null && !sessionRelSet.has(relPath.toLowerCase())) {
          if (sessionDirSet === null || !sessionDirSet.has(parentDirOf(relPath))) continue
          looseDirHit = true
        }
        // 被隐藏的直接跳过（隐藏只影响列表展示，文件仍在磁盘上）
        if (hiddenSet.has(relPath)) continue
        // 第一阶段只登记路径，stat 留到全部收集完再统一并发读（第一档性能优化）
        candidates.push({
          fullPath,
          relPath,
          entryName,
          rootDir,
          rootIndex: opts.roots.indexOf(rootDir),
          extension: ext,
          looseDirHit,
        })
      }
    }
  }

  // 2026-11-21：深层交付文件保底。
  // BFS 受 opts.maxDepth（默认 3）限制，落在更深目录里的日志明确产出 / 交付
  // 文件（例如 .../正式成片/film/outputs/xxx.mp4 在第 6 层）根本走不到，
  // 于是「音视频」画廊里看不到 —— 但图片都在浅层，看起来就像"音视频丢了"。
  // 这里把「本对话日志 present/write 过的精确绝对路径」直接补进候选，
  // 不走 BFS 深度限制；仍照常经过下面的 stat（时间窗口 / 体积 / 隐藏）过滤。
  // 只补"日志明确记录过"的路径，不猜、不递归扫深目录，避免拖慢全库或扫进无关文件。
  if (isSession && Array.isArray(scopeInfo.paths) && scopeInfo.paths.length > 0) {
    // 已在 BFS 候选里的绝对路径（小写）不重复添加
    const have = new Set(candidates.map((c) => path.resolve(c.fullPath).toLowerCase()))
    for (const abs of scopeInfo.paths) {
      let absolute
      try { absolute = path.resolve(String(abs)) } catch { continue }
      if (have.has(absolute.toLowerCase())) continue
      let ownerRoot = null
      for (const r of opts.roots) {
        if (isInside(r, absolute)) { ownerRoot = r; break }
      }
      if (ownerRoot === null) continue
      const ext = path.extname(absolute).toLowerCase()
      if (!extSet.has(ext)) continue
      const relPath = path.relative(ownerRoot, absolute).split(path.sep).join('/')
      if (hiddenSet.has(relPath)) continue
      have.add(absolute.toLowerCase())
      candidates.push({
        fullPath: absolute,
        relPath,
        entryName: path.basename(absolute),
        rootDir: ownerRoot,
        rootIndex: opts.roots.indexOf(ownerRoot),
        extension: ext,
        looseDirHit: false,
      })
    }
  }
  // 2026-11-16 第一档：第二阶段限流并发读 stat。
  // 全库五千多个文件逐个 await 要 7 秒左右，几十路并发能压到 1 秒内；
  // 过滤条件（时间窗口 / 体积 / 隐藏 / 同目录新鲜度）与串行时完全一致，
  // 只是把「等待」叠起来做，不改变任何一条判定。
  const statted = await mapPool(candidates, SCAN_CONCURRENCY, async (c) => {
    let stat
    try {
      stat = await fsp.stat(c.fullPath)
    } catch {
      return null
    }
    // 2026-11-24：分叉子会话分叉后的新产出不能倒灌回主线。
    // 主线日志自己精确记录过的路径优先保留（那种文件本来就是主线的，
    // 子会话可能再次 present 过），其余按绝对路径硬挡。
    if ((childForkAbsSet !== null && childForkAbsSet.has(path.resolve(c.fullPath).toLowerCase())
      || (childForkRelSet !== null && childForkRelSet.has(c.relPath.toLowerCase())))
      && !sessionRelSet.has(c.relPath.toLowerCase())) return null
    // 2026-11-24：继承资产照常走下面的过滤，只在返回条目上打 inherited 标记。
    // 2026-11-15：同目录放宽只收本对话期间新出现 / 改动的图；
    // 否则只读查一次图，就会把该目录里几百张历史图全算进这个新对话。
    if (c.looseDirHit && !isFreshSince(stat, sessionStartMs)) return null
    if (stat.size <= 0 || stat.mtimeMs < cutoff) return null
    // 音视频：超过体积上限的直接跳过（视频可能几百 MB，列出来点开就卡）
    if (isMedia && stat.size > opts.maxMediaBytes) return null
    return {
      relPath: c.relPath,
      relKey: `${c.rootIndex}:${c.relPath}`,
      rootDir: c.rootDir,
      rootIndex: c.rootIndex,
      name: c.entryName,
      size: stat.size,
      mtime: stat.mtimeMs,
      // 手工拷贝旧文件时 mtime 仍是老的，但创建时间是新的；
      // 两个视图的同目录放宽判据都看它，不能只给 mtime 造成一边有一边没有。
      birthtimeMs: stat.birthtimeMs,
      extension: c.extension,
      // v0.14.7：外部素材标记，扫描阶段据此给出「素材」标签
      ...(c.looseDirHit ? { externalAsset: true } : {}),
      // 音视频区分「视频 / 音频」，客户端据此选 <video> 还是 <audio>
      ...(isMedia ? { mediaType: VIDEO_EXTS.includes(c.extension) ? 'video' : 'audio' } : {}),
      // 2026-11-24：分叉会话继承自主线的资产照常进主列表，只打标记供前端区分来源。
      ...(inheritedAbsSet !== null && inheritedAbsSet.has(path.resolve(c.fullPath).toLowerCase())
        ? { inherited: true }
        : {}),
      // 2026-11-24：主线里被分叉会话带走的文件打 shared，交互照常、只加共享标记。
      ...(sharedAbsSet !== null && sharedAbsSet.has(path.resolve(c.fullPath).toLowerCase())
        ? { shared: true }
        : {}),
    }
  })
  for (const item of statted) {
    if (item !== null) matches.push(item)
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
    } else if (frame !== undefined && (frame.kind === undefined || frame.kind === 'frame')) {
      // 只有「视频截帧」才带来源视频/时间码。粘贴 / 裁剪（v0.16.1 起也登记）
      // 没有取自哪一帧的概念，误设 frameOf 会让卡片显示「取自《…》」的假来源。
      item.frameOf = {
        videoName: String(frame.videoName ?? ''),
        videoRelPath: String(frame.videoRelPath ?? ''),
        timecode: String(frame.timecode ?? ''),
        frameMs: Number(frame.frameMs) || 0,
      }
    }
    // 登记不在会话日志里：ownerByAbs 查不到时，用登记里的会话信息补一个虚拟归属。
    // 日志里已有归属的文件（例如视频本身）一律沿用原归属，不受影响。
    const frameSid = String(frame?.sessionId ?? '')
    // 子会话截的帧同样并进根父会话（与 ownerByAbs 归一同一口径）
    const frameRootSid = frameSid === '' ? '' : rootSessionOf(frameSid)
    const virtualOwner = frame !== undefined && frameSid !== ''
      ? {
          sessionId: frameRootSid,
          title: String(frame.sessionTitle ?? '') || sessionIndex?.get(frameRootSid)?.title || '',
          createdAt: Number(frame.sessionCreatedAt) || sessionIndex?.get(frameRootSid)?.createdAt || 0,
          // 截帧 = 过程稿；粘贴 / 裁剪 = 素材（登记里带着 category，缺省回落过程稿）
          category: frameCategoryOf(frame),
        }
      : undefined
    const indexedList = ownerByAbs.get(abs) ?? []
    // 主归属：日志里「最近引用」它的那个对话（沿用原排序，保证历史行为不变）
    const indexedOwner = indexedList.length === 0
      ? undefined
      : indexedList.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
    // 2026-11-25：**产出者判定优先于「谁最近引用算谁的」**。
    //
    // 实测反例（老板 11-25 报）：a912「DSH辅助漫剧制作流程」（11-23 19:24）产出的
    // 11 张图卡，被 11-24 20:21 才开张的同名对话 94d7「引用」走了 —— 于是 a912 在
    // 全局只剩 2 张，而切进该对话能看见 13 张。两个视图用了两套尺子。
    //
    // 优先级：当前对话 > 截帧登记 > 目录 + 时间（产出者）> 日志精确引用。
    // 但**归属不止一个**：凡是认得这张图的对话，分组时各入各的组（见下面 refs）。
    const dirOwners = virtualOwner === undefined
      ? matchDirOwners({
        relPath: item.relPath,
        mtime: item.mtime,
      })
      : []
    const dirOwner = dirOwners.length > 0 ? dirOwners[0] : null
    /**
     * 这张图「属于」的对话清单（多值）。
     *
     * 老板的对账标准很朴素：**打开这个对话看到几张，全局这个组就该有几张**。
     * 原先一个文件只归一个对话，只要别的对话贴过同一张图，原对话的组就少一张
     * （实测「产线测试快速反馈」打开 21 张、全局只剩 5 张）。现在改成多归属。
     */
    const refs = []
    const refSids = new Set()
    const pushRef = (sessionId, title, createdAt, category) => {
      const sid = String(sessionId ?? '')
      if (sid === '' || refSids.has(sid)) return
      refSids.add(sid)
      refs.push({
        sessionId: sid,
        title: title ?? '',
        createdAt: Number(createdAt) || 0,
        category,
      })
    }
    // ① 日志里精确引用过它的对话 —— 最硬的证据，排最前
    for (const own of indexedList) pushRef(own.sessionId, own.title, own.createdAt, own.category)
    // ② 目录 + 时间窗：判定为产出者（分类用该对话自己的判定，没有则素材）。
    //    根直属层同样参与 —— 早年试过「有更具体归属就跳过根层」，结果 Chief 系列
    //    对话的组里各少 12 张素材（打开对话有、全局没有），对账失败。
    for (const cand of dirOwners) {
      const own = sessionIndex?.get(cand.sessionId)?.files?.get(abs)
      pushRef(cand.sessionId, cand.title, cand.createdAt,
        typeof own === 'string' ? own : ASSET_CATEGORY.INPUT)
    }
    // ③ 截帧 / 粘贴登记
    if (virtualOwner !== undefined) {
      pushRef(virtualOwner.sessionId, virtualOwner.title, virtualOwner.createdAt, virtualOwner.category)
    }
    item.absPath = abs
    if (isSession) {
      const autoCategory = scopeInfo.categoryByRel?.get(item.relPath.toLowerCase())
      // 外部放进本对话目录、日志里没引用的图 → 自动标「素材」(input)。
      // 手动改过的标签在下面仍然优先覆盖，刷新/重扫/重启都不回退。
      item.category = categoryForSessionAsset(autoCategory, item.externalAsset)
      item.sessionId = sessionId
    } else if (globalCurrentExactRels !== null
      && (globalCurrentExactRels.has(item.relPath.toLowerCase())
        || (globalCurrentDirs !== null && globalCurrentDirs.has(parentDirOf(item.relPath))
          && isFreshSince({ mtimeMs: item.mtime, birthtimeMs: item.birthtimeMs }, globalCurrentStartMs)))
      && !(globalCurrentChildForkAbsSet !== null && globalCurrentChildForkAbsSet.has(abs.toLowerCase())
        || (globalCurrentChildForkRelSet !== null && globalCurrentChildForkRelSet.has(item.relPath.toLowerCase())))) {
      // 2026-11-15：本对话日志精确引用过、或落在本对话用过的目录里的资产，
      // 一律归到全局置顶的「当前对话」组；历史会话索引不能再把它抢走。
      // 分类与「当前对话」视图完全一致：精确命中用日志判定，目录命中按外部素材标 input。
      const relKey = item.relPath.toLowerCase()
      const exact = globalCurrentExactRels.has(relKey)
      item.category = categoryForSessionAsset(globalCurrentCategory?.get(relKey), !exact)
      if (!exact) item.externalAsset = true
      item.sessionId = currentRootSid
      item.sessionTitle = currentRootMeta?.title ?? ''
      item.sessionCreatedAt = currentRootMeta?.createdAt ?? 0
      // 2026-11-24：全局「当前对话」组里的共享文件同样加共享标记
      if (globalCurrentSharedAbsSet !== null && globalCurrentSharedAbsSet.has(abs.toLowerCase())) {
        item.shared = true
      }
      // 2026-11-25：全局「当前对话」组里的继承文件同样加继承标记（分叉会话视角）
      if (globalCurrentInheritedAbsSet !== null && globalCurrentInheritedAbsSet.has(abs.toLowerCase())) {
        item.inherited = true
      }
    } else if (virtualOwner !== undefined) {
      // 截帧 / 粘贴登记：本会话当场产出的硬证据，优先级最高
      item.category = virtualOwner.category
      item.sessionId = virtualOwner.sessionId
      item.sessionTitle = virtualOwner.title
      item.sessionCreatedAt = virtualOwner.createdAt
    } else if (dirOwner !== null) {
      // 2026-11-25：目录 + 时间窗口命中 —— 文件落在本会话用过的目录里，且晚于会话开始。
      // 分类：若该文件也被这个会话在日志里精确引用过，沿用日志分类（与「当前对话」
      // 视图同源判据），否则按外部素材标 input。
      const sameOwner = indexedList.find((x) => x.sessionId === dirOwner.sessionId)
      item.category = categoryForSessionAsset(sameOwner?.category, sameOwner === undefined)
      if (sameOwner === undefined) item.externalAsset = true
      item.sessionId = dirOwner.sessionId
      item.sessionTitle = dirOwner.title
      item.sessionCreatedAt = dirOwner.createdAt
      // 供诊断：这条是靠目录 + 时间判定的产出，不是日志精确记录
      item.dirOwner = true
    } else if (indexedOwner !== undefined) {
      item.category = indexedOwner.category
      item.sessionId = indexedOwner.sessionId
      item.sessionTitle = indexedOwner.title
      item.sessionCreatedAt = indexedOwner.createdAt
      // 子智能体产出：分组并进父会话，但保留原始产出会话，诊断时能分清是谁做的
      if (indexedOwner.ownerSessionId !== undefined) item.ownerSessionId = indexedOwner.ownerSessionId
    } else {
      // 不属于任何已知对话、也不在当前对话目录里的文件：归到「历史资产」，
      // 分类记为**未归类**。不能兜底成 input —— 那会把几千个历史文件全标成「输入」
      item.category = ASSET_CATEGORY.UNKNOWN
      item.sessionId = null
    }

    // 2026-11-25：多归属表 —— 只有真的被多个对话认得才建（绝大多数条目只有一项）。
    // 主归属那条用「本分支判出来的分类」覆盖，保证置顶的当前对话组与视图完全一致。
    if (refs.length > 1) {
      const self = item.sessionId === null || item.sessionId === undefined
        ? undefined
        : refs.find((r) => r.sessionId === item.sessionId)
      if (self !== undefined) self.category = item.category
      item.sessionRefs = refs
    }

    // 手动改过的标签覆盖机器预判，且刷新 / 重扫 / 重启都不会回退。
    const manual = manualLabels[item.relPath]
    if (manual !== undefined && LABEL_CATEGORIES.includes(manual?.category)) {
      item.category = manual.category
      item.categoryManual = true
      // 2026-11-25：多归属的副本同样要跟着手动标签走，否则同一张图
      // 在「打开这个对话」里是定稿、在全局同组里却是素材（实测量过 1 张差异）。
      if (Array.isArray(item.sessionRefs)) {
        for (const ref of item.sessionRefs) ref.category = manual.category
      }
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

  // v1.6.5：已隐藏的对话（全局资产底部的「已隐藏对话」合集）。
  // 只下发 id 列表，不在后端过滤 —— 前端拿去分区，右键一点就立即生效，
  // 不必为了一次隐藏把整个扫描（全库约 6 秒）重跑一遍。
  const hiddenSessions = isSession ? [] : await readHiddenSessions(opts.settingsFile)

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
        // 阶段 2：分组明细补齐遮罩关联与「手动改过标签」，
        // 让 Agent 拿到的信息和人双击写进输入框拿到的完全一致。
        ...(item.maskOf !== undefined ? { maskOf: item.maskOf } : {}),
        categoryManual: item.categoryManual === true,
        // 音视频类型（video / audio），客户端据此选 <video> 还是 <audio>
        ...(item.mediaType !== undefined ? { mediaType: item.mediaType } : {}),
        // 截帧来源：反馈篮与草稿正文据此写清取自哪段视频的哪一帧
        ...(item.frameOf !== undefined ? { frameOf: item.frameOf } : {}),
        // 2026-11-25：来源标记必须透传给全局分组，否则资产台卡片看不到角标
        ...(item.inherited ? { inherited: true } : {}),
        ...(item.shared ? { shared: true } : {}),
        // 2026-11-25：一张图可能同时属于用它产出过的多个对话 —— 这张副归属表
        // 必须带到分组里，否则只有主归属那组有它（全局就比对话里少几张）。
        ...(Array.isArray(item.sessionRefs) ? { sessionRefs: item.sessionRefs } : {}),
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
      sessionStartMs,
      globalCurrentStartMs,
      externalDirs: sessionDirSet?.size ?? 0,
      globalExternalDirs: globalCurrentDirs?.size ?? 0,
      externalAssets: matches.reduce((n, i) => n + (i.externalAsset ? 1 : 0), 0),
      // 2026-11-24：分叉会话继承自主线的资产数（条目本身带 inherited 在 items 里）
      inheritedAssets: (inheritedAbsSet ?? globalCurrentInheritedAbsSet)?.size ?? 0,
      // 2026-11-24：主线里被分叉会话带走的共享资产数
      sharedAssets: (sharedAbsSet ?? globalCurrentSharedAbsSet)?.size ?? 0,
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
    // 2026-11-15：分类小数字按「本视图全部」算，不能只数第一页 60 张。
    // 全局视图靠 groups[].counts，当前对话视图没有 groups，前端以前只能数 items，
    // 结果与全局「当前对话」组的小标签对不上（老板 19:18 实测报的）。
    counts: (() => {
      const c = { final: 0, input: 0, intermediate: 0, unknown: 0 }
      for (const m of matches) {
        const k = String(m?.category ?? 'unknown')
        if (Object.prototype.hasOwnProperty.call(c, k)) c[k] += 1
      }
      return c
    })(),
    // 分页信息，客户端据此渲染页码条
    page: safePage,
    pageCount,
    pageSize: opts.maxItems,
    // 「还有 N 张」= 当前页之外的总数（不再只是「被截掉的」）
    hidden: Math.max(0, total - visible.length),
    // v1.6.5：全局视图下发「已隐藏对话」清单，前端据此把对应分组收进合集
    hiddenSessions,
    rootMissing,
    scan: { directories, entries, capped },
    // 全局模式额外返回：按对话分组的数据（客户端做折叠展示用）。
    // 🔴 明细一次算全（全量留在服务端缓存），不再按 120 条截断：
    // 历史组有 5000+ 张，截断后旧图永远翻不到。
    // 响应由 host/http.js 瘦身成每组 60 张，前端点「再显示」再按需取下一批。
    groups: isSession ? null : buildGroups(allItemsSummary, Number.MAX_SAFE_INTEGER, currentRootSid, sessionStates),
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
 * ⚠️ 明细一次给全（调用方传极大 maxPerGroup）：历史组有 5000+ 个文件，
 * 以前每组截断到 120 条，旧图永远翻不到。现在由前端渐进渲染控制画面里的
 * 卡片数量；单次响应约 1.5 MB，解析开销远小于「几千张卡同时进画面」。
 *
 * @param summary - 扁平资产摘要数组。
 * @param maxPerGroup - 每组最多返回多少条明细（默认 120）。
 * @param currentSessionId - 当前打开的会话 id；匹配到的组会标记 isCurrent 并置顶。
 * @returns 分组数组。
 */
