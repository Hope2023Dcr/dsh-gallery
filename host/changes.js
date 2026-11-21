/**
 * 资产变动追踪（增量刷新用）—— 2026-11-16
 *
 * 目标：任何进程以任何方式在产出根里新增/修改/删除资产，都能被感知，
 *       并**只让前端刷新受影响的那个对话组**，不整表重绘。
 *
 * 为什么用 fs.watch 而不是 DSH 的 tools/post-execute 事件：
 *   tools/post-execute 只覆盖 Agent 的工具调用；用户在资源管理器里拷文件进来、
 *   ComfyUI 直接写盘、下载器落盘，这些它都看不到。只有文件系统监听能全覆盖。
 *
 * 关键纪律：
 *   · 不扫盘 —— watch 直接给路径，不需要重新遍历几千个文件
 *   · 防抖 300ms —— 一次跑图连写 20 个文件要算一批
 *   · 忽略临时件 —— .tmp / .part / .crdownload 等
 *   · 只记「哪个会话变了」，不把资产明细塞进状态里
 */

import { promises as fsp, watch } from 'node:fs'
import path from 'node:path'
import { isInside } from './fsutil.js'

/** 与扫描器一致的资产扩展名（只关心这些，避免 node_modules 之类疯狂触发） */
const ASSET_EXTS = new Set([
  // 图片
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif', '.tif', '.tiff', '.heic', '.ico',
  // 音视频
  '.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wma',
  // 文件
  '.md', '.markdown', '.txt', '.log',
  '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.xml', '.toml',
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.rtf', '.odt',
  '.html', '.htm', '.mht',
  '.zip', '.7z', '.rar', '.tar', '.gz',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.ps1', '.sh', '.bat', '.cmd', '.sql', '.ipynb',
  '.url', '.lnk', '.webloc',
  '.dxf', '.dwg', '.skp', '.3dm',
])

/** 临时件后缀（下载中 / 写入中 / 插件自己的原子写中间文件） */
const TEMP_SUFFIX = /\.(tmp|part|partial|crdownload|download|swp)$/i
const TEMP_NAME = /\.tmp[-.]|~$|^\.#|^#.*#$/

/** 跳过的目录名（与扫描器 skipDirs 保持一致） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '$recycle.bin', 'system volume information',
  '__pycache__', '.venv', 'venv', '.cache', 'library_merged',
])

const DEBOUNCE_MS = 300

export function createChangeTracker({ roots = [], sessionOfPath = null } = {}) {
  /** 单调递增版本号：前端凭它判断「有没有新东西」 */
  let version = 0
  /**
   * 未消费的变动，按 sessionId 聚合。
   *   key   : sessionId（'' 表示还不知道归属）
   *   value : { added:Set<relPath>, removed:Set<relPath>, at:number }
   */
  const pending = new Map()
  /** 监听器句柄 */
  const watchers = []
  /** 防抖定时器 */
  let timer = null
  /** 递归扫描根时的初始快照，用来判断「是不是真新增」 */
  let stopped = false

  /** 路径是否该忽略 */
  function shouldIgnore(abs) {
    const base = path.basename(abs)
    if (base === '' ) return true
    if (base.startsWith('.')) return true
    if (TEMP_SUFFIX.test(base) || TEMP_NAME.test(base)) return true
    const parts = abs.split(path.sep).map((s) => s.toLowerCase())
    for (const seg of parts) {
      if (SKIP_DIRS.has(seg)) return true
    }
    const ext = path.extname(base).toLowerCase()
    if (!ASSET_EXTS.has(ext)) return true
    return false
  }

  /** 找出 abs 属于哪个 root，返回相对路径（统一用 /） */
  function relOf(abs) {
    for (const r of roots) {
      try {
        if (isInside(path.resolve(r), abs)) {
          return path.relative(path.resolve(r), abs).split(path.sep).join('/')
        }
      } catch { /* 忽略 */ }
    }
    return null
  }

  /** 记一条变动 */
  function mark(abs, kind) {
    if (stopped) return
    if (shouldIgnore(abs)) return
    const rel = relOf(abs)
    if (rel === null || rel === '') return

    let sid = ''
    try {
      if (typeof sessionOfPath === 'function') sid = String(sessionOfPath(rel) ?? '')
    } catch { /* 查不到归属就归到 '' */ }

    const key = sid
    let slot = pending.get(key)
    if (slot === undefined) {
      slot = { added: new Set(), removed: new Set(), at: Date.now() }
      pending.set(key, slot)
    }
    slot.at = Date.now()
    if (kind === 'removed') {
      slot.removed.add(rel)
      slot.added.delete(rel)
    } else {
      slot.added.add(rel)
      slot.removed.delete(rel)
    }
    version += 1
    scheduleFlush()
  }

  /** 防抖：把连续变动合并成一批 */
  function scheduleFlush() {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      // 什么都不做 —— 版本号已经递增，前端下次轮询就能看到
      // 这里留空是为了将来要接「主动推送」时有落点
    }, DEBOUNCE_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 开始监听 */
  function start() {
    stopped = false
    for (const root of roots) {
      const abs = path.resolve(String(root ?? ''))
      if (abs === '') continue
      try {
        const w = watch(abs, { recursive: true }, (eventType, filename) => {
          if (!filename) return
          const full = path.join(abs, String(filename))
          // eventType: 'rename'（增/删/改名）或 'change'（内容变）
          // fs.watch 不区分增删，只能按「文件现在在不在」判断
          fsp.stat(full).then(
            () => mark(full, eventType === 'rename' ? 'added' : 'changed'),
            () => mark(full, 'removed'),
          ).catch(() => { /* 忽略 */ })
        })
        w.on('error', () => { /* 根被删/权限变了，静默 */ })
        if (typeof w.unref === 'function') w.unref()
        watchers.push(w)
      } catch { /* 根不存在或权限不足，跳过 */ }
    }
    return watchers.length
  }

  /** 停止监听 */
  function stop() {
    stopped = true
    for (const w of watchers) {
      try { w.close() } catch { /* 忽略 */ }
    }
    watchers.length = 0
    if (timer !== null) { clearTimeout(timer); timer = null }
  }

  /**
   * 前端轮询入口。
   * @param since - 前端上次看到的版本号
   * @returns { version, changed, unchanged }
   *
   * 返回体刻意极小：只有「哪个会话变了、增减多少」，不含任何资产明细。
   * 前端据此对某个组单独重取 groupMore，其它组不动。
   */
  function take(since) {
    const s = Number(since) || 0
    if (s >= version) {
      return { version, changed: [], unchanged: true }
    }
    const changed = []
    for (const [sessionId, slot] of pending.entries()) {
      if (slot.added.size === 0 && slot.removed.size === 0) continue
      changed.push({
        sessionId,
        added: slot.added.size,
        removed: slot.removed.size,
        at: slot.at,
      })
    }
    return { version, changed, unchanged: changed.length === 0 }
  }

  /** 前端消费掉变动后调用（可选；不清也能工作，只是 changed 会一直重复报） */
  function ack(since) {
    const s = Number(since) || 0
    if (s < version) {
      pending.clear()
    }
    return { version }
  }

  /** 新增资产时手动递增（插件自己的写操作走这条，不依赖 fs.watch 时序） */
  function bump(rel, kind = 'added') {
    const fake = rel
    if (fake === '') { version += 1; return version }
    let sid = ''
    try {
      if (typeof sessionOfPath === 'function') sid = String(sessionOfPath(String(fake)) ?? '')
    } catch { /* 忽略 */ }
    let slot = pending.get(sid)
    if (slot === undefined) {
      slot = { added: new Set(), removed: new Set(), at: Date.now() }
      pending.set(sid, slot)
    }
    slot.at = Date.now()
    if (kind === 'removed') { slot.removed.add(String(fake)); slot.added.delete(String(fake)) }
    else { slot.added.add(String(fake)); slot.removed.delete(String(fake)) }
    version += 1
    return version
  }

  return {
    start,
    stop,
    take,
    ack,
    bump,
    get version() { return version },
    get watching() { return watchers.length },
  }
}
