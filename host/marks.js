/**
 * 标记存储（S3-a）：独立的 dsh-gallery-marks.json，与 settings 分离。
 *
 * 为什么独立：主插件里有两个写者 —— 设置（roots / hidden）和标记（用户对卡片的判定）。
 * 放同一文件会互相覆盖：A 读 → B 读 → A 写 → B 写，A 的改动就被 B 的旧快照冲掉。
 * 拆成两个文件后，两个写者各管一份，配合 tmp → rename 原子写，不会丢写。
 *
 * 文件形态：
 * {
 *   "schema": 1,
 *   "marks": {
 *     "<relPath>": {
 *       "action": "approve|reject|finalize|redo-one-dim|regenerate-selected|set-reference",
 *       "reason": "...",              // 可选
 *       "changeOnly": ["色调"],        // 可选：只改这些
 *       "keep": ["构图", "人物"],      // 可选：这些锁死
 *       "preserve": ["..."] ,          // 可选：额外保留项
 *       "markedAt": 1700000000000
 *     }
 *   }
 * }
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

/**
 * 进程内写队列：把「读-改-写」串起来，避免并发 setMark 互相覆盖。
 * 每个写操作追加到链尾，前一个失败也不阻断后续。
 */
let writeChain = Promise.resolve()

function enqueue(fn) {
  const next = writeChain.then(fn, fn)
  // 吞掉失败，避免一个拒绝让整条链断掉
  writeChain = next.catch(() => {})
  return next
}

/** 允许的动作（与 src/shared/feedback-text.js 的 ACTIONS 保持一致）。 */
export const MARK_ACTIONS = [
  'approve',
  'reject',
  'finalize',
  'redo-one-dim',
  'regenerate-selected',
  'set-reference',
]

const MARKS_FILENAME = 'dsh-gallery-marks.json'

/** marks 文件的绝对路径（与 settings 同目录）。 */
export function marksFilePath(settingsFile) {
  return path.join(path.dirname(settingsFile), MARKS_FILENAME)
}

/**
 * 读 marks。文件不存在 / 格式坏都返回空对象（不抛错，避免首次使用就报错）。
 * @returns {Promise<{schema:number, marks:Object}>}
 */
export async function readMarks(settingsFile) {
  const file = marksFilePath(settingsFile)
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    const marks = (parsed !== null && typeof parsed === 'object' && typeof parsed.marks === 'object' && parsed.marks !== null)
      ? parsed.marks
      : {}
    return { schema: 1, marks }
  } catch {
    return { schema: 1, marks: {} }
  }
}

/**
 * 写 marks —— 原子写（tmp → rename），避免半截文件。
 * 使用独立 tmp 名（带 pid），并发写不会互相踩。
 */
export async function writeMarks(settingsFile, marks) {
  const file = marksFilePath(settingsFile)
  // tmp 名必须唯一：并发写者若共用同一 tmp，第二个会撞上已被重命名的路径 → EPERM。
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const payload = { schema: 1, marks: marks ?? {} }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2))
  await fsp.rename(tmp, file)
}

/**
 * 设/清一条标记。
 * @param relPath - 卡片对应的相对路径（唯一键）。
 * @param mark - 标记对象；传 null 表示清除。
 * @returns 更新后的 marks
 */
export async function setMark(settingsFile, relPath, mark) {
  // 串行化：并发调用按顺序执行，后一个能读到前一个的写入结果
  return enqueue(async () => {
    const current = await readMarks(settingsFile)
    const next = { ...current.marks }
    if (mark === null || mark === undefined) {
      delete next[relPath]
    } else {
      next[relPath] = { ...mark, markedAt: mark.markedAt ?? Date.now() }
    }
    await writeMarks(settingsFile, next)
    return next
  })
}

/**
 * 批量设 / 清标记（v0.13.7）—— 一次读改写 + 一次原子写。
 *
 * 为什么批量：批量确认 20 张卡时，逐个 setMark 会触发 20 次「读文件 → 改 → 写」，
 * 既慢又增加并发写窗口。这里串行化一次搞定。
 *
 * @param updates - [{ path: string, mark: object|null }]  mark=null 表示清除
 * @returns 更新后的 marks 对象
 */
export async function setMarksBatch(settingsFile, updates) {
  return enqueue(async () => {
    const current = await readMarks(settingsFile)
    const next = { ...current.marks }
    for (const u of updates) {
      const relPath = String(u?.path ?? "")
      if (relPath === "") continue
      const mark = u?.mark
      if (mark === null || mark === undefined) {
        delete next[relPath]
      } else {
        next[relPath] = { ...mark, markedAt: mark.markedAt ?? Date.now() }
      }
    }
    await writeMarks(settingsFile, next)
    return next
  })
}
