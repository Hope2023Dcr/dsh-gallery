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
  /**
   * 一张资产进某个组时的卡片字段。
   *
   * 2026-11-25：sessionId / sessionTitle 改由调用方传入 —— 同一张图可能同时属于
   * 多个「用它产出过」的对话（见 scan.js 的 matchDirOwners）。原先写死取 item 上的
   * 值，只能单选归属，于是「打开对话看到 13 张、全局这个组只有 2 张」。
   */
  const fileOf = (item, sessionId, sessionTitle, category) => ({
    absPath: item.absPath,
    relPath: item.relPath,
    // 多归属时每个对话对同一张图可能有自己的分类判定，由调用方传入
    category: category ?? item.category,
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
    // 2026-11-25：继承 / 共享来源标记透传给卡片（资产台只看全局分组）
    ...(item.inherited ? { inherited: true } : {}),
    ...(item.shared ? { shared: true } : {}),
    // 阶段 2：与双击写进输入框同一套信息，别让 Agent 拿到少一截
    ...(item.maskOf !== undefined ? { maskOf: item.maskOf } : {}),
    categoryManual: item.categoryManual === true,
    // 目录 + 时间判定的产出（不是日志精确记录），供排查与后续功能使用
    ...(item.dirOwner ? { dirOwner: true } : {}),
    sessionId: sessionId ?? null,
    sessionTitle: sessionTitle ?? '',
  })

  for (const item of summary) {
    // 多归属：一张图同时进「用它产出过的每个对话」的组；绝大多数条目只有一项
    const refs = Array.isArray(item.sessionRefs) && item.sessionRefs.length > 0
      ? item.sessionRefs
      : [{ sessionId: item.sessionId, title: item.sessionTitle, createdAt: item.sessionCreatedAt }]
    for (const ref of refs) {
      const sid = ref.sessionId ?? null
      const key = sid ?? '__unassigned__'
      if (!groups.has(key)) {
        groups.set(key, {
          sessionId: sid,
          title: sid === null ? '' : (ref.title || sid.slice(0, 8)),
          createdAt: Number(ref.createdAt) || 0,
          files: [],
        })
      }
      const g = groups.get(key)
      g.files.push(fileOf(item, sid, ref.title, ref.category))
      if (sid === null && item.mtime > g.createdAt) g.createdAt = item.mtime
    }
  }

  /**
   * v1.6.4：一张图同时属于哪几个对话。
   *
   * 老板 11-25 定的口径 —— 两个对话都真用过同一张图时**不合并、不去重**，
   * 但要让界面能把「归属」标出来。这里先算出全量的归属集合，
   * 再落到每个组上（`sharedCount` / `sharedPeers`）。
   *
   * 必须在 `slice(0, maxPerGroup)` **之前**、在**全量** files 上算：
   * 前端经 slimGroups 每组只拿到 60 条，自己数会把大组的共用数严重低估。
   * 「历史资产」池（sessionId === null）不是真实归属，排除 —— 否则
   * 大批没主的图会被误标成「共用」。
   */
  const ownersByRel = new Map()
  for (const g of groups.values()) {
    if (g.sessionId === null) continue
    for (const f of g.files) {
      const owners = ownersByRel.get(f.relPath)
      if (owners === undefined) ownersByRel.set(f.relPath, new Set([g.sessionId]))
      else owners.add(g.sessionId)
    }
  }

  const out = []
  for (const g of groups.values()) {
    g.files.sort((a, b) => b.mtime - a.mtime)
    const counts = { final: 0, input: 0, intermediate: 0, unknown: 0 }
    for (const f of g.files) {
      if (counts[f.category] !== undefined) counts[f.category] += 1
    }
    // v1.6.4：本组里有多少张是「别的对话也在用」的同一个文件，以及是谁
    const sharedRels = new Set()
    const peerSids = new Set()
    if (g.sessionId !== null) {
      for (const f of g.files) {
        const owners = ownersByRel.get(f.relPath)
        if (owners === undefined || owners.size < 2) continue
        sharedRels.add(f.relPath)
        // v1.6.5：逐条打标 —— 老板要「列表里能看出哪几张是被共用的」，
        // 只给组头一个总数不够。数字是「这张图一共被几个对话记着」（含自己）。
        f.sharedWith = owners.size
        for (const sid of owners) {
          if (sid !== g.sessionId) peerSids.add(sid)
        }
      }
    }
    const sharedCount = sharedRels.size
    const sharedPeers = [...peerSids].map((sid) => groups.get(sid)?.title ?? String(sid).slice(0, 8))
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
      // v1.6.4：跨对话共用（同一文件被多个对话引用）。0 表示这一组没有共用件。
      sharedCount,
      ...(sharedPeers.length > 0 ? { sharedPeers } : {}),
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
 * 子智能体会话 → 根父会话的归一函数（2026-11-25）。
 *
 * 为什么需要：`resolveSessionScope` 的「修法 C」把子智能体（子会话）的产出
 * **合并进父会话**的当前对话视图；但全局按对话分组时，子会话是按 owner 单独成组的。
 * 两套尺子不一致，老板实测就出现「全局里这个对话只有 5 张，点进对话却有 35 张」——
 * 看着就像资产丢了（实际是被分到了标题为任务描述的另一个组里）。
 *
 * 规则：
 *   - 只有父会话**确实进了索引**（自己也有产出）时才归一；
 *     否则会把子会话挂到一个不存在的空组，比现在更糟。
 *   - 多级父子（子→孙）一路走到根，最多 16 层防环。
 *
 * @param index - buildSessionIndex() 的结果（Map<sessionId, { parentSession, ... }>）。
 * @returns (sessionId) => 根父会话 id；不认识的一律原样返回。
 */
export function buildRootSessionResolver(index) {
  const parentOf = new Map()
  if (index !== null && index !== undefined && typeof index.get === 'function') {
    for (const [sid, entry] of index) {
      const pid = String(entry?.parentSession ?? '')
      if (pid !== '' && pid !== sid && index.has(pid)) parentOf.set(sid, pid)
    }
  }
  return function rootSessionOf(sid) {
    if (typeof sid !== 'string' || sid === '') return sid
    let cur = sid
    for (let i = 0; i < 16; i += 1) {
      const p = parentOf.get(cur)
      if (p === undefined) break
      cur = p
    }
    return cur
  }
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
