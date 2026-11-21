/**
 * 「人此刻（或最近一次）正在看哪张图」的临时状态（阶段 3 / C1）。
 *
 * 为什么单独一个文件：
 *   · marks / labels / frames 是持久业务数据，改过就一直生效；
 *   · feedback 是待处理消息，人处理完就清；
 *   · context 只是界面当前状态，只记最后打开的那一张，随时可删 ——
 *     删了只是「助手不知道刚看了哪张」，不影响任何资产与标记。
 * 绝不和上面三类混一份，重演「删一条反馈把标签也撤了」的老问题。
 *
 * 为什么落盘而不只放进程内存：命令行那套 DSH 是另一个进程，
 * 也要能答「我刚看的那张是什么」。文件放在 settingsFile 同目录，
 * 两套进程解析到的都是同一个位置。
 *
 * 红线：只读工具读它；写只由前端打开大图触发；绝不自动发送任何消息。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

const CONTEXT_FILENAME = 'dsh-gallery-context.json'

/** 进程内写队列：左右快速切图时也不能让两次写互相覆盖。 */
let writeChain = Promise.resolve()

function enqueue(fn) {
  const next = writeChain.then(fn, fn)
  writeChain = next.catch(() => {})
  return next
}

export function contextFilePath(settingsFile) {
  return path.join(path.dirname(String(settingsFile ?? '')), CONTEXT_FILENAME)
}

/** 只留展示所需字段：绝不把整个 scan 项写进去，也不接收任意嵌套对象。 */
export function sanitizeContext(item) {
  const s = (v) => (typeof v === 'string' ? v.slice(0, 2000) : '')
  // 状态文件是两套 DSH 共用的：万一写进来的是 G://a//b 这种歪路径，
  // 也不能原样报给模型。只在非空时归一，空串必须保持空串。
  const cleanAbs = (v) => {
    const raw = s(v)
    if (raw === '') return ''
    try { return path.normalize(raw) } catch { return raw }
  }
  const mask = (item?.maskOf !== null && typeof item?.maskOf === 'object') ? item.maskOf : null
  return {
    relPath: s(item?.relPath),
    absPath: cleanAbs(item?.absPath),
    name: s(item?.name),
    category: s(item?.category) || 'unknown',
    categoryManual: item?.categoryManual === true,
    maskPath: s(item?.maskPath) || s(mask?.relPath),
    maskAbsPath: cleanAbs(item?.maskAbsPath),
    sessionId: s(item?.sessionId),
    sessionTitle: s(item?.sessionTitle),
    updatedAt: Number(item?.updatedAt) || Date.now(),
  }
}

/** 写「当前看的这张」；传 null / 无 relPath 表示清空记录。 */
export async function writeContext(settingsFile, item) {
  const clean = (item !== null && typeof item === 'object' && String(item?.relPath ?? '') !== '')
    ? sanitizeContext({ ...item, updatedAt: Date.now() })
    : null
  const record = { schema: 1, updatedAt: Date.now(), item: clean }
  return enqueue(async () => {
    const file = contextFilePath(settingsFile)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    await fsp.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
    await fsp.rename(tmp, file)
    return clean
  })
}

/** 读「当前看的这张」；文件不存在 / 格式坏 / 空记录都返回 null，绝不抛错。 */
export async function readContext(settingsFile) {
  try {
    const raw = await fsp.readFile(contextFilePath(settingsFile), 'utf8')
    const parsed = JSON.parse(raw)
    const it = parsed?.item
    if (it === null || typeof it !== 'object' || String(it?.relPath ?? '') === '') return null
    return sanitizeContext(it)
  } catch {
    return null
  }
}
