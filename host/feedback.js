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
import { writeFileAtomic } from './atomic.js'

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

/** 默认保留 7 天的待处理反馈；settings.feedbackTtlHours 可覆盖（<=0 表示永不过期）。 */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 把配置换成毫秒 TTL；0 表示关闭过期过滤。 */
function ttlMsOf(settings) {
  const hours = Number(settings?.feedbackTtlHours)
  if (Number.isFinite(hours)) {
    if (hours <= 0) return 0
    return Math.min(hours, 24 * 365) * 3600_000
  }
  return DEFAULT_TTL_MS
}

/**
 * 一条反馈是否已过期。
 * ⚠️ 没有 markedAt（或 markedAt 不是正数）的记录**一律保留** ——
 * 老数据缺字段时宁可多留，也不该无故吞掉用户标过的意见（regions-tool R9 钉死）。
 */
function isExpired(item, ttl, now) {
  if (ttl <= 0) return false
  const at = Number(item?.markedAt)
  if (!Number.isFinite(at) || at <= 0) return false
  return now - at > ttl
}

/** 读原始全量（不做过期过滤）。只给启动清扫用，别在业务路径上调。 */
async function readFeedbackRaw(settingsFile) {
  try {
    const raw = await fsp.readFile(feedbackFilePath(settingsFile), 'utf8')
    const parsed = JSON.parse(raw)
    return (parsed !== null && typeof parsed === 'object' &&
      typeof parsed.feedback === 'object' && parsed.feedback !== null) ? parsed.feedback : {}
  } catch {
    return {}
  }
}

/**
 * 读待处理反馈。文件不存在 / 格式坏都返回空对象，绝不抛错。
 *
 * **纯读**：只过滤内存里的过期项，绝不写盘
 * （getPendingFeedback 的红线：连续两次读一致 + 落盘文件不变）。
 * 真正把过期项从盘上抹掉的是 sweepExpiredFeedback，只在插件启动时跑一次。
 *
 * @param settings - 可选；不传按默认 7 天过滤
 */
export async function readFeedback(settingsFile, settings) {
  const all = await readFeedbackRaw(settingsFile)
  const ttl = ttlMsOf(settings)
  if (ttl <= 0) return { schema: 1, feedback: all }
  const now = Date.now()
  const kept = {}
  for (const [relPath, item] of Object.entries(all)) {
    if (item === null || typeof item !== 'object') continue
    if (isExpired(item, ttl, now)) continue
    kept[relPath] = item
  }
  return { schema: 1, feedback: kept }
}

/** 原子写（见 atomic.js）：失败自动清掉 tmp，不留残留。 */
async function writeFeedback(settingsFile, feedback) {
  const file = feedbackFilePath(settingsFile)
  const payload = { schema: 1, feedback: feedback ?? {} }
  await writeFileAtomic(file, JSON.stringify(payload, null, 2))
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

/**
 * 清掉盘上已过期的反馈 —— **只在插件启动时调一次**。
 *
 * 为什么不放在读路径：读一次就改一次盘，既有测试钉死了「读操作不得改动落盘文件」。
 * 这里走写队列，和 setFeedback / ackFeedback 共用同一把串行锁，不会互相覆盖。
 */
export async function sweepExpiredFeedback(settingsFile, settings) {
  const ttl = ttlMsOf(settings)
  if (ttl <= 0) return { removed: 0 }
  return enqueue(async () => {
    const all = await readFeedbackRaw(settingsFile)
    const now = Date.now()
    const kept = {}
    let removed = 0
    for (const [relPath, item] of Object.entries(all)) {
      if (item === null || typeof item !== 'object' || isExpired(item, ttl, now)) {
        removed += 1
        continue
      }
      kept[relPath] = item
    }
    if (removed > 0) await writeFeedback(settingsFile, kept)
    return { removed }
  })
}
