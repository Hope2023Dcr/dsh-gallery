/**
 * 删除回收区（v1.6.0）：删除不再直接 rm，先把文件搬进
 * `<settingsFile 同目录>/gallery-trash/<批次>/`，搬回来就是撤销。
 *
 * 🔴 为什么不能让「删除」保持 rm：
 *   老板要的是 Ctrl+Z。rm 之后文件字节就没了，任何撤销都只能是假的
 *   （要么假装成功、要么从别处复制一份）。唯一可靠的做法是**删除时先不真删**。
 *
 * 🔴 为什么回收区在 ~/.dsh 而不在产出根里：
 *   扫描会认 .csv/.json/.md 等扩展名，回收区若落在产出根内，
 *   被删的文件会以「新资产」的身份重新出现在资产台里 —— 越删越多。
 *
 * 🔴 跨盘：资产常在 G 盘、回收区在 C 盘，rename 会报 EXDEV。
 *   这里必须退回「复制 + 删源」，且**复制失败绝不动源文件**（顺序不能反）。
 *
 * 目录结构（每批一个目录，相对路径原样保留，避免同名互撞）：
 *   gallery-trash/20261125-193012-a1b2c3d4/
 *     batch.json         批次元数据（含被一并清掉的 marks/labels/frames 快照）
 *     files/<relPath>    原文件
 *
 * 这层只管「搬文件 + 记账」，不碰 marks/labels/frames ——
 * 状态恢复由调用方（http.js）按 batch.json 的 state 去做，职责分开好测。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeFileAtomic } from './atomic.js'

export const TRASH_DIRNAME = 'gallery-trash'
export const TRASH_SCHEMA = 1
const BATCH_FILE = 'batch.json'
const FILES_DIR = 'files'

/** 回收区根目录：跟着 settingsFile 走（桌面版与命令行版解析到同一处）。 */
export function trashRootDir(settingsFile) {
  return path.join(path.dirname(String(settingsFile ?? '')), TRASH_DIRNAME)
}

/**
 * 相对路径归一：只用正斜杠、不许绝对路径、不许 `..` 段。
 * 返回空串表示这条不能用（调用方按失败处理，绝不硬拼）。
 */
export function safeRelPath(raw) {
  const s = String(raw ?? '').replace(/\\/g, '/').trim()
  if (s === '') return ''
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return ''
  const segs = s.split('/').filter((seg) => seg !== '' && seg !== '.')
  if (segs.length === 0) return ''
  if (segs.some((seg) => seg === '..')) return ''
  return segs.join('/')
}

/** 批次号：时间可读 + 随机后缀（同一毫秒内连删两批也不会撞）。 */
function makeToken(now = Date.now()) {
  const d = new Date(now)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}-${randomBytes(4).toString('hex')}`
}

/** token 只允许这批字符，杜绝 `../` 之类拼进路径。 */
export function isSafeToken(token) {
  return typeof token === 'string' && /^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/.test(token)
}

/**
 * 搬一个文件：优先 rename（同盘瞬间完成），跨盘退回复制 + 删源。
 * 复制失败时源文件**原样保留**，异常抛给调用方记失败。
 */
async function moveFile(srcAbs, dstAbs) {
  await fsp.mkdir(path.dirname(dstAbs), { recursive: true })
  try {
    await fsp.rename(srcAbs, dstAbs)
    return 'rename'
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await fsp.copyFile(srcAbs, dstAbs)
    await fsp.unlink(srcAbs)
    return 'copy'
  }
}

/**
 * 把一批文件搬进回收区。
 *
 * @param settingsFile 状态文件（用它的目录定位回收区）
 * @param items [{ relPath, absPath, root }]  root 是产出根绝对路径，撤销时要靠它拼回原位
 * @param state 可选：删除时一并清掉的登记快照 { marks, labels, frames }
 * @returns { ok, token, batchDir, moved:[], failed:[], bytes }
 */
export async function moveToTrash(settingsFile, items, state = null) {
  const now = Date.now()
  const token = makeToken(now)
  const batchDir = path.join(trashRootDir(settingsFile), token)
  const filesDir = path.join(batchDir, FILES_DIR)
  const moved = []
  const failed = []
  let bytes = 0

  for (const item of Array.isArray(items) ? items : []) {
    const rel = safeRelPath(item?.relPath)
    const abs = String(item?.absPath ?? '')
    if (rel === '' || abs === '') {
      failed.push({ path: String(item?.relPath ?? ''), reason: 'invalid-path' })
      continue
    }
    let size = 0
    let mtime = 0
    try {
      const st = await fsp.stat(abs)
      if (!st.isFile()) {
        failed.push({ path: rel, reason: 'not-a-file' })
        continue
      }
      size = Number(st.size) || 0
      mtime = Number(st.mtimeMs) || 0
    } catch (error) {
      failed.push({ path: rel, reason: String(error?.code ?? error?.message ?? error) })
      continue
    }
    try {
      await moveFile(abs, path.join(filesDir, ...rel.split('/')))
      bytes += size
      moved.push({
        relPath: rel,
        root: String(item?.root ?? ''),
        size,
        mtime,
      })
    } catch (error) {
      failed.push({ path: rel, reason: String(error?.code ?? error?.message ?? error) })
    }
  }

  if (moved.length === 0) {
    // 一个都没搬成：把空目录收掉，别留一堆空批次
    try { await fsp.rm(batchDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    return { ok: false, token: '', batchDir: '', moved: [], failed, bytes: 0 }
  }

  const record = {
    schema: TRASH_SCHEMA,
    token,
    createdAt: now,
    items: moved,
    state: state === null || typeof state !== 'object'
      ? { marks: {}, labels: {}, frames: {} }
      : {
        marks: (state.marks !== null && typeof state.marks === 'object') ? state.marks : {},
        labels: (state.labels !== null && typeof state.labels === 'object') ? state.labels : {},
        frames: (state.frames !== null && typeof state.frames === 'object') ? state.frames : {},
      },
  }
  await writeFileAtomic(path.join(batchDir, BATCH_FILE), JSON.stringify(record, null, 2))
  return { ok: true, token, batchDir, moved, failed, bytes }
}

/** 读一批。token 非法 / 目录不在 / 文件坏了都返回 null，绝不抛错。 */
export async function readBatch(settingsFile, token) {
  if (!isSafeToken(token)) return null
  try {
    const raw = await fsp.readFile(path.join(trashRootDir(settingsFile), token, BATCH_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const items = Array.isArray(parsed.items) ? parsed.items : []
    return {
      schema: TRASH_SCHEMA,
      token,
      createdAt: Number(parsed.createdAt) || 0,
      items: items.filter((it) => safeRelPath(it?.relPath) !== ''),
      state: (parsed.state !== null && typeof parsed.state === 'object')
        ? {
          marks: (parsed.state.marks !== null && typeof parsed.state.marks === 'object') ? parsed.state.marks : {},
          labels: (parsed.state.labels !== null && typeof parsed.state.labels === 'object') ? parsed.state.labels : {},
          frames: (parsed.state.frames !== null && typeof parsed.state.frames === 'object') ? parsed.state.frames : {},
        }
        : { marks: {}, labels: {}, frames: {} },
    }
  } catch {
    return null
  }
}

/** 列最近的批次（新的在前），供「还能撤销什么」展示与排障。 */
export async function listTrash(settingsFile, limit = 20) {
  const root = trashRootDir(settingsFile)
  let names = []
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!isSafeToken(name)) continue
    const batch = await readBatch(settingsFile, name)
    if (batch === null) continue
    out.push({
      token: batch.token,
      createdAt: batch.createdAt,
      count: batch.items.length,
      bytes: batch.items.reduce((sum, it) => sum + (Number(it.size) || 0), 0),
    })
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out.slice(0, Math.max(1, Math.trunc(Number(limit) || 20)))
}

/**
 * 撤销一批：把文件搬回原位。
 *
 * 三条规矩：
 *   1. **绝不覆盖已有文件** —— 原位已经又生成了同名文件（例如重新导出了一张），
 *      那份新的比被删的那份更可能是当前的，冲突就报出来让人处理；
 *   2. 单个失败不影响其余，最后如实回报；
 *   3. 全部还原完成后由调用方决定是否丢批次（见 discardBatch）。
 */
export async function restoreBatch(settingsFile, token) {
  const batch = await readBatch(settingsFile, token)
  if (batch === null) return { ok: false, error: 'batch-not-found' }
  const filesDir = path.join(trashRootDir(settingsFile), batch.token, FILES_DIR)
  const restored = []
  const failed = []
  const conflicts = []

  for (const item of batch.items) {
    const rel = safeRelPath(item.relPath)
    const src = path.join(filesDir, ...rel.split('/'))
    const root = String(item.root ?? '')
    if (root === '') {
      failed.push({ path: rel, reason: 'root-unknown' })
      continue
    }
    const dst = path.join(root, ...rel.split('/'))
    // 防越界：拼出来的目标必须还在原根内
    const relCheck = path.relative(path.resolve(root), path.resolve(dst))
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      failed.push({ path: rel, reason: 'outside-root' })
      continue
    }
    try {
      if ((await fsp.stat(dst).catch(() => null)) !== null) {
        conflicts.push({ path: rel, reason: 'exists' })
        continue
      }
      await moveFile(src, dst)
      restored.push({
        relPath: rel,
        absPath: dst,
        root,
        size: Number(item.size) || 0,
        mtime: Number(item.mtime) || 0,
      })
    } catch (error) {
      failed.push({ path: rel, reason: String(error?.code ?? error?.message ?? error) })
    }
  }

  return {
    ok: restored.length > 0,
    token: batch.token,
    restored,
    failed,
    conflicts,
    state: batch.state,
  }
}

/** 撤销成功后清掉这一批的残留目录（失败不抛错）。 */
export async function discardBatch(settingsFile, token) {
  if (!isSafeToken(token)) return false
  try {
    await fsp.rm(path.join(trashRootDir(settingsFile), token), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 按 TTL 清回收区（只在插件启动时跑一次）。
 *
 * 只删「超过 TTL 的整批目录」，不删单个文件 —— 半批残留等于把一次撤销弄成半截。
 * 没有 batch.json 的目录按目录自身 mtime 判断（异常中断留下的，同样是垃圾）。
 * TTL <= 0 直接不动。
 */
export async function sweepTrash(settingsFile, ttlHours) {
  const hours = Number(ttlHours)
  if (!Number.isFinite(hours) || hours <= 0) return { removed: 0, kept: 0, bytes: 0 }
  const root = trashRootDir(settingsFile)
  let entries = []
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return { removed: 0, kept: 0, bytes: 0 }
  }
  const cutoff = Date.now() - hours * 3600 * 1000
  let removed = 0
  let kept = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    let stamp = 0
    let size = 0
    const batch = isSafeToken(entry.name) ? await readBatch(settingsFile, entry.name) : null
    if (batch !== null) {
      stamp = batch.createdAt
      size = batch.items.reduce((sum, it) => sum + (Number(it.size) || 0), 0)
    } else {
      try { stamp = Number((await fsp.stat(dir)).mtimeMs) || 0 } catch { continue }
    }
    if (!(stamp > 0) || stamp >= cutoff) { kept += 1; continue }
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      removed += 1
      bytes += size
    } catch { kept += 1 }
  }
  return { removed, kept, bytes }
}
