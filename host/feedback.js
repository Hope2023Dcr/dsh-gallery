/**
 * 待处理反馈存储（v0.16.4）：独立文件 dsh-gallery-feedback.json。
 *
 * 为什么单独一个文件（和 marks.json / labels.js 都分开）：
 *   · marks.json   —— 判定标记，**持久状态**（改过就一直生效）
 *   · labels.json  —— 手动标签，**持久状态**
 *   · feedback.json —— 待处理反馈，**一次性消息**（人处理完就没了）
 *
 * 生命周期不同就不能放同一份：用户从反馈篮删掉一条反馈，
 * 不该把已经定好的标签/标记也一起撤销（labels.js 里已记过这个教训）。
 *
 * 为什么需要落盘（v0.16.4 之前没有）：
 *   反馈草稿原先只存在内存 `draftRef` 里，插件一重启反馈就没了。
 *   A 档要「Agent 能主动拉反馈」，Agent 拉到的必须是**落盘的那份**，
 *   否则重启一次，用户已经标过的意见就没了。
 *
 * 数据形态：
 * {
 *   "schema": 1,
 *   "feedback": {
 *     "<relPath>": {
 *       "action": "approve|reject|finalize|...",
 *       "reason": "...",              // 可选
 *       "changeOnly": ["色调"],        // 可选
 *       "keep": ["构图", "人物位置"],   // 可选
 *       "preserve": ["..."],          // 可选
 *       "region": { ... },            // 可选（圈选批注的几何）
 *       "markedAt": 1700000000000
 *     }
 *   }
 * }
 *
 * 键用 relPath（与 marks / labels 一致）：文件被改名/移动后不会误命中，孤儿记录不影响扫描。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

const FEEDBACK_FILENAME = 'dsh-gallery-feedback.json'

/** 进程内写队列，与 marks.js / labels.js 同策略：把「读-改-写」串起来，避免并发互相覆盖。 */
let writeChain = Promise.resolve()

function enqueue(fn) {
  const next = writeChain.then(fn, fn)
  writeChain = next.catch(() => {})
  return next
}

export function feedbackFilePath(settingsFile) {
  return path.join(path.dirname(settingsFile), FEEDBACK_FILENAME)
}

/** 读待处理反馈。文件不存在 / 格式坏都返回空对象，绝不抛错。 */
export async function readFeedback(settingsFile) {
  try {
    const raw = await fsp.readFile(feedbackFilePath(settingsFile), 'utf8')
    const parsed = JSON.parse(raw)
    const feedback = (parsed !== null && typeof parsed === 'object' &&
      typeof parsed.feedback === 'object' && parsed.feedback !== null) ? parsed.feedback : {}
    return { schema: 1, feedback }
  } catch {
    return { schema: 1, feedback: {} }
  }
}

/** 原子写（tmp → rename），tmp 名带 pid + 随机数，并发不互踩。 */
async function writeFeedback(settingsFile, feedback) {
  const file = feedbackFilePath(settingsFile)
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const payload = { schema: 1, feedback: feedback ?? {} }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2))
  await fsp.rename(tmp, file)
}

/**
 * 记一条待处理反馈（用户做判定时调）。
 * 同一路径再次判定会**覆盖**旧的那条 —— 一个资产当前只有一条有效意见，
 * 反复标记同一张图不该攒出多条互相矛盾的反馈。
 */
export async function setFeedback(settingsFile, relPath, item) {
  return enqueue(async () => {
    const current = await readFeedback(settingsFile)
    const next = { ...current.feedback }
    if (item === null || item === undefined) {
      delete next[relPath]
    } else {
      next[relPath] = { ...item, markedAt: item.markedAt ?? Date.now() }
    }
    await writeFeedback(settingsFile, next)
    return next
  })
}

/** 批量记（一次读改写 + 一次原子写）。 */
export async function setFeedbackBatch(settingsFile, updates) {
  return enqueue(async () => {
    const current = await readFeedback(settingsFile)
    const next = { ...current.feedback }
    for (const u of updates) {
      const relPath = String(u?.path ?? '')
      if (relPath === '') continue
      const item = u?.item
      if (item === null || item === undefined) delete next[relPath]
      else next[relPath] = { ...item, markedAt: item.markedAt ?? Date.now() }
    }
    await writeFeedback(settingsFile, next)
    return next
  })
}

/**
 * 确认已处理 —— 人点发送 / 人点清空反馈篮后调，把这些条从待处理里移除。
 *
 * 注意：**Agent 拉取不调用这个**。
 * Agent 拉走反馈只代表「Agent 看到了」，不代表「人处理完了」——
 * 两者混同的话，Agent 看一眼就会把用户的意见吞掉。
 */
export async function ackFeedback(settingsFile, relPaths) {
  return enqueue(async () => {
    const current = await readFeedback(settingsFile)
    const next = { ...current.feedback }
    for (const relPath of relPaths) {
      delete next[relPath]
    }
    await writeFeedback(settingsFile, next)
    return next
  })
}

/** 清空全部待处理反馈（人点「清空反馈篮」时调）。 */
export async function clearFeedback(settingsFile) {
  return enqueue(async () => {
    await writeFeedback(settingsFile, {})
    return {}
  })
}
