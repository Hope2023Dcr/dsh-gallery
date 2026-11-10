/**
 * 手动标签覆写（v0.14.2）：独立文件 dsh-gallery-labels.json。
 *
 * 为什么要和 marks.json（反馈篮）分开：
 *   · 标签是**持久状态** —— 手动改过就一直生效，刷新 / 重启 / 重扫都不回退；
 *   · 反馈篮条目是**一次性消息** —— 生成草稿、人工合并发送后清空。
 *   若共用一份，用户从反馈篮删掉一条，会把已经定好的标签一起撤销，语义就错了。
 *
 * 数据形态：
 * {
 *   "schema": 1,
 *   "labels": {
 *     "<relPath>": { "category": "input|intermediate|final",
 *                    "from": "机器原判", "adjustedAt": 1700000000000 }
 *   }
 * }
 *
 * 键用 relPath（与 marks 一致），文件被移动/改名后不会误命中；孤儿记录不影响扫描。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** 允许手动指定的标签；与 classify.js 的 ASSET_CATEGORY 对齐（不含 unknown）。 */
export const LABEL_CATEGORIES = ['input', 'intermediate', 'final']

const LABELS_FILENAME = 'dsh-gallery-labels.json'

/** 进程内写队列，与 marks.js 同策略：把「读-改-写」串起来，避免并发互相覆盖。 */
let writeChain = Promise.resolve()

function enqueue(fn) {
  const next = writeChain.then(fn, fn)
  writeChain = next.catch(() => {})
  return next
}

export function labelsFilePath(settingsFile) {
  return path.join(path.dirname(settingsFile), LABELS_FILENAME)
}

/** 读标签覆写。文件不存在 / 格式坏都返回空对象，绝不抛错。 */
export async function readLabels(settingsFile) {
  try {
    const raw = await fsp.readFile(labelsFilePath(settingsFile), 'utf8')
    const parsed = JSON.parse(raw)
    const labels = (parsed !== null && typeof parsed === 'object' &&
      typeof parsed.labels === 'object' && parsed.labels !== null) ? parsed.labels : {}
    return { schema: 1, labels }
  } catch {
    return { schema: 1, labels: {} }
  }
}

/** 原子写（tmp → rename），tmp 名带 pid + 随机数，并发不互踩。 */
async function writeLabels(settingsFile, labels) {
  const file = labelsFilePath(settingsFile)
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const payload = { schema: 1, labels: labels ?? {} }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2))
  await fsp.rename(tmp, file)
}

/** 设 / 清一条标签覆写；label 为 null 表示「恢复自动判定」。 */
export async function setLabel(settingsFile, relPath, label) {
  return enqueue(async () => {
    const current = await readLabels(settingsFile)
    const next = { ...current.labels }
    if (label === null || label === undefined) delete next[relPath]
    else next[relPath] = { ...label, adjustedAt: label.adjustedAt ?? Date.now() }
    await writeLabels(settingsFile, next)
    return next
  })
}

/** 批量设 / 清，一次读改写 + 一次原子写。 */
export async function setLabelsBatch(settingsFile, updates) {
  return enqueue(async () => {
    const current = await readLabels(settingsFile)
    const next = { ...current.labels }
    for (const u of updates) {
      const relPath = String(u?.path ?? '')
      if (relPath === '') continue
      const label = u?.label
      if (label === null || label === undefined) delete next[relPath]
      else next[relPath] = { ...label, adjustedAt: label.adjustedAt ?? Date.now() }
    }
    await writeLabels(settingsFile, next)
    return next
  })
}

/** 文件被删除后清掉对应覆写，避免留孤儿记录。 */
export async function deleteLabels(settingsFile, relPaths) {
  if (!Array.isArray(relPaths) || relPaths.length === 0) return {}
  return setLabelsBatch(settingsFile, relPaths.map((p) => ({ path: p, label: null })))
}
