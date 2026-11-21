/**
 * 会话日志读取：zstd 多帧、会话目录定位、子会话发现、路径收集。
 *
 * S1 拆分自 index.js（行为零变化）。
 */

import { promises as fsp, readFileSync, statSync, createReadStream } from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { ZSTD_MAGIC } from './constants.js'

export const sessionLogCache = new Map()

/**
 * 解压一个会话日志。
 * DSH 的 session.v4.jsonl.zstd 是「多帧 zstd 拼接」（每次追加写一帧），
 * 单次 zstdDecompressSync 只能解第一帧，所以必须按魔数切开逐帧解。
 * @param fullPath - 日志文件绝对路径。
 * @returns 解压后的完整文本；失败返回空串。
 */

export async function readSessionLogText(fullPath) {
  let stat
  let buf
  try {
    stat = await fsp.stat(fullPath)
    const cacheKey = `${fullPath}|${stat.mtimeMs}|${stat.size}`
    const cached = sessionLogCache.get(fullPath)
    if (cached !== undefined && cached.key === cacheKey) return cached.text
    buf = await fsp.readFile(fullPath)
  } catch {
    return ''
  }
  const offsets = []
  let cursor = 0
  while (cursor < buf.length) {
    const hit = buf.indexOf(ZSTD_MAGIC, cursor)
    if (hit < 0) break
    offsets.push(hit)
    cursor = hit + ZSTD_MAGIC.length
  }
  if (offsets.length === 0) return ''
  const parts = []
  for (const offset of offsets) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(offset)))
    } catch {
      // 单帧损坏就跳过，不影响其余帧
    }
  }
  const text = Buffer.concat(parts).toString('utf8')
  sessionLogCache.set(fullPath, { key: `${fullPath}|${stat.mtimeMs}|${stat.size}`, text })
  // 缓存只留最近若干条，避免长跑后堆积
  if (sessionLogCache.size > 8) {
    const oldest = sessionLogCache.keys().next().value
    if (oldest !== undefined) sessionLogCache.delete(oldest)
  }
  return text
}

/** 在 ~/.dsh/sessions/<工作区分组>/<sessionId>/ 里定位某个会话目录。 */

export async function locateSessionDir(sessionsDir, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  // 防御：会话 id 只可能是 [A-Za-z0-9._-]，不许出现路径分隔符
  if (/[\\/]/.test(sessionId) || sessionId.includes('..')) return null
  let groups
  try {
    groups = await fsp.readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const candidate = path.join(sessionsDir, String(group.name), sessionId)
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isDirectory()) return candidate
    } catch {
      // 继续找下一个分组
    }
  }
  return null
}

/**
 * 找出某个会话的全部**子会话**目录（子智能体）。
 *
 * 修法 C：DSH 里子智能体是独立会话，有自己的 session 日志目录，
 * 它的 write/present 调用**不出现在主会话日志里**。
 * 所以「当前对话」必须把子会话的产出也算进去。
 *
 * 判定依据：子会话日志首行的 `parentSession` 字段指向主会话 id。
 *
 * @param sessionsDir - 会话根目录。
 * @param parentSessionId - 主会话 id。
 * @returns 子会话日志的绝对路径数组。
 */

export async function findSubSessionLogs(sessionsDir, parentSessionId) {
  const result = []
  if (typeof parentSessionId !== 'string' || parentSessionId === '') return result
  let groups
  try {
    groups = await fsp.readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    let sessions
    try {
      sessions = await fsp.readdir(path.join(sessionsDir, String(group.name)), { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const logPath = path.join(sessionsDir, String(group.name), String(s.name), 'session.v4.jsonl.zstd')
      try {
        const st = await fsp.stat(logPath)
        if (!st.isFile()) continue
      } catch {
        continue
      }
      // 读首行判断 parentSession；日志可能很大，只解第一帧就够（首行一定在第一帧）
      const headText = await readSessionLogHead(logPath)
      if (headText === '') continue
      try {
        const first = JSON.parse(headText.split('\n')[0])
        if (first?.type === 'session' && first?.parentSession === parentSessionId) {
          result.push(logPath)
        }
      } catch {
        // 首行解析失败就跳过
      }
    }
  }
  return result
}

/**
 * 只解压会话日志的第一帧，取首行（判断 parentSession 用，避免读整个 9MB 日志）。
 * @param fullPath - 日志路径。
 * @returns 首帧解出的文本；失败返回空串。
 */

export async function readSessionLogHead(fullPath) {
  let buf
  try {
    buf = await fsp.readFile(fullPath)
  } catch {
    return ''
  }
  const hit = buf.indexOf(ZSTD_MAGIC, 0)
  if (hit < 0) return ''
  try {
    return zstdDecompressSync(buf.subarray(hit)).toString('utf8')
  } catch {
    return ''
  }
}

/** 递归收集 JSON 节点里所有以盘符开头的字符串（工具的 path 参数）。 */

export function collectAbsolutePaths(node, sink) {
  if (typeof node === 'string') {
    if (/^[A-Za-z]:[\\/]/.test(node)) sink.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const entry of node) collectAbsolutePaths(entry, sink)
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) collectAbsolutePaths(node[key], sink)
  }
}

/**
 * 资产分类常量。
 *
 * 分类判据（按优先级，从高到低）：
 *   1. 被 `present` 声明过 → **最终资产**（正式交付物）
 *   2. 只被 `read_image` 看过、从未被写入 → **输入资产**（用户给的参考图/资料）
 *   3. 其余（write/edit/脚本产出/bash 提到） → **中间资产**
 *   4. 会话日志里查不到任何记录 → **未归类**（历史文件，不能冒充「输入」）
 *
 * 为什么要有 UNKNOWN：早先版本把查不到归属的文件兜底成 input，
 * 结果 4995 个历史文件全被标成「输入」，把真正的输入资产淹没了。
 * 「不知道」就老老实实说不知道，不要瞎猜。
 */
