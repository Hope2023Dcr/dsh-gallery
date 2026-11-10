/**
 * 按对话分组（scan 依赖它，所以必须在前）。
 *
 * S1 拆分自 index.js（行为零变化）。
 */
import { stateOfSession } from './session-index.js'

/**
 * @param states - readSessionStates() 的结果；只用于给分组加状态标注，不参与排序。
 */
export function buildGroups(summary, maxPerGroup = 120, currentSessionId = '', states = null) {
  if (!Array.isArray(summary) || summary.length === 0) return []

  const groups = new Map()
  for (const item of summary) {
    const key = item.sessionId ?? '__unassigned__'
    if (!groups.has(key)) {
      groups.set(key, {
        sessionId: item.sessionId,
        title: item.sessionId === null ? '' : (item.sessionTitle || item.sessionId.slice(0, 8)),
        createdAt: item.sessionCreatedAt || 0,
        files: [],
      })
    }
    const g = groups.get(key)
    g.files.push({
      absPath: item.absPath,
      relPath: item.relPath,
      category: item.category,
      mtime: item.mtime,
      width: item.width ?? null,
      height: item.height ?? null,
      size: item.size ?? 0,
      name: item.name ?? item.relPath.split('/').pop(),
      // 客户端卡片要靠这两个字段判断渲染类型（v0.10.1）
      extension: item.extension ?? ('.' + item.relPath.split('/').pop().split('.').pop().toLowerCase()),
      ...(item.mediaType !== undefined ? { mediaType: item.mediaType } : {}),
      // 截帧来源（v0.14.3）：反馈篮据此显示「取自《视频》00-01-00-500 帧」
      ...(item.frameOf !== undefined ? { frameOf: item.frameOf } : {}),
    })
    if (item.sessionId === null && item.mtime > g.createdAt) g.createdAt = item.mtime
  }

  const out = []
  for (const g of groups.values()) {
    g.files.sort((a, b) => b.mtime - a.mtime)
    const counts = { final: 0, input: 0, intermediate: 0, unknown: 0 }
    for (const f of g.files) {
      if (counts[f.category] !== undefined) counts[f.category] += 1
    }
    // 只回传前 maxPerGroup 条明细（客户端滚动到底再按需请求）
    const returned = g.files.slice(0, maxPerGroup)
    // 当前打开的会话：客户端据此置顶并默认展开（0.14.1 原行为，不动）
    const isCurrent = currentSessionId !== '' && g.sessionId === currentSessionId
    out.push({
      sessionId: g.sessionId,
      isHistory: g.sessionId === null,
      isCurrent,
      // 只作展示：归档 / 已删除时客户端取消「打开对话」并改成状态标注。
      // 当前对话永远算 active，避免注册表尚未落盘时被误标成已删除。
      sessionState: isCurrent ? 'active' : stateOfSession(g.sessionId, states),
      title: g.title,
      createdAt: g.createdAt,
      fileCount: g.files.length,
      returnedCount: returned.length,
      truncated: g.files.length > returned.length,
      counts,
      files: returned,
      latestMtime: g.files.length > 0 ? g.files[0].mtime : 0,
    })
  }

  // 组排序：
  //   1. 当前对话永远第一（按时间倒序会把它压到中间）
  //   2. 其余对话按创建时间倒序
  //   3. 「历史资产」永远最后
  out.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    if (a.isHistory && !b.isHistory) return 1
    if (b.isHistory && !a.isHistory) return -1
    return b.createdAt - a.createdAt
  })

  return out
}

/**
 * 把一个相对路径解析成根目录内的绝对路径；越界或不存在返回 null。
 * 多目录支持：第一个 root 找不到就逐个试其余 root。
 * @param roots - 扫描目录列表（或单个 root 字符串，兼容旧调用）。
 */
/**
 * 把「相对路径」解析成一个可读文件。
 *
 * @param roots - 允许的根目录。
 * @param relPath - 相对 root 的路径（用 / 分隔）。
 * @param opts - 配置。
 * @param byteCap - 体积上限（字节）。**图片和媒体上限不同**：
 *   图片用 maxImageBytes（默认 64MB），音视频用 maxMediaBytes（默认 200MB）。
 *   不传时退回 maxImageBytes。以前这里固定用 maxImageBytes，
 *   导致 127MB 的视频被判「不可读」→ 前端收到 404。
 */
