/**
 * 「产出台此刻什么状态」的临时记录（阶段 3 / C1，2026-11-16 第二档扩建）。
 *
 * 为什么单独一个文件：
 *   · marks / labels / frames 是持久业务数据，改过就一直生效；
 *   · feedback 是待处理消息，人处理完就清；
 *   · context 只是界面当前状态，随时可删 ——
 *     删了只是「助手不知道刚看了哪几张」，不影响任何资产与标记。
 * 绝不和上面三类混一份，重演「删一条反馈把标签也撤了」的老问题。
 *
 * 为什么不只是「最后一张」（第二档）：
 *   只记一张时，模型答不出「刚才那几张」「我连着看的那组」；也不知道
 *   面板现在是全局还是当前对话、筛掉了哪些分类。现在记两样东西：
 *   · recent[] —— 最近打开过的若干张（按打开先后，最多 MAX_RECENT 条），
 *     每张带打开次数与最后一次看的时间，供上层按「活跃度」排；
 *   · panel   —— 视图 / 类型 / 页码 / 总数 / 组数 / 四类分类开关。
 *   这里只存事实，不做打分排序（打分在 host/activity.js，纯函数好测）。
 *
 * 为什么落盘而不只放进程内存：命令行那套 DSH 是另一个进程，
 * 也要能答「我刚看的那张是什么」。文件放在 settingsFile 同目录，
 * 两套进程解析到的都是同一个位置。
 *
 * 红线：只读工具读它；写只由前端（打开大图 / 面板状态变化）触发；
 * 绝不自动发送任何消息。文件可随时删除，删了只是助手暂时不知道。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

const CONTEXT_FILENAME = 'dsh-gallery-context.json'
export const MAX_RECENT = 20
export const SCHEMA_VERSION = 2

/** 进程内写队列：左右快速切图、面板状态与打开大图同时上报时，不能互相覆盖。 */
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
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
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
    // 第二档：文件自身改动时间（活跃度要用），以及看过几次 / 最后一次看的时间
    mtime: num(item?.mtime),
    viewedAt: num(item?.viewedAt) || num(item?.updatedAt),
    viewCount: Math.max(0, Math.trunc(num(item?.viewCount))),
    updatedAt: num(item?.updatedAt) || Date.now(),
  }
}

/** 面板状态白名单：只认这几个字段，别的概不落盘。 */
export function sanitizePanel(panel) {
  if (panel === null || typeof panel !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0)
  const cat = (panel?.categories !== null && typeof panel?.categories === 'object') ? panel.categories : {}
  const scope = panel?.scope === 'session' ? 'session' : 'global'
  const kind = panel?.kind === 'file' || panel?.kind === 'media' ? panel.kind : 'image'
  return {
    scope,
    kind,
    page: num(panel?.page) || 1,
    total: num(panel?.total),
    groupCount: num(panel?.groupCount),
    categories: {
      final: cat.final !== false,
      input: cat.input !== false,
      intermediate: cat.intermediate !== false,
      unknown: cat.unknown !== false,
    },
    updatedAt: num(panel?.updatedAt) || Date.now(),
  }
}

/**
 * 读出来的东西归一到 schema 2。
 * 兼容老文件：schema 1 只有 `item`（最后打开的那一张），迁移成 recent 的第一条。
 */
export function normalizeState(parsed) {
  const recent = []
  const seen = new Set()
  const push = (raw) => {
    const clean = sanitizeContext(raw)
    if (clean.relPath === '' || seen.has(clean.relPath)) return
    seen.add(clean.relPath)
    recent.push(clean)
  }
  if (Array.isArray(parsed?.recent)) {
    for (const it of parsed.recent) {
      if (recent.length >= MAX_RECENT) break
      push(it)
    }
  } else if (parsed?.item !== null && parsed?.item !== undefined && typeof parsed?.item === 'object') {
    // schema 1 → 2：老文件只有最后一张，当成只被看过一次
    const legacy = sanitizeContext(parsed.item)
    push({
      ...legacy,
      viewedAt: legacy.viewedAt || Number(parsed?.updatedAt) || Date.now(),
      viewCount: 1,
    })
  }
  return { schema: SCHEMA_VERSION, panel: sanitizePanel(parsed?.panel), recent }
}

async function readStateFile(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return normalizeState(JSON.parse(raw))
  } catch {
    return { schema: SCHEMA_VERSION, panel: null, recent: [] }
  }
}

async function writeStateFile(file, state) {
  const record = {
    schema: SCHEMA_VERSION,
    updatedAt: Date.now(),
    panel: state.panel,
    recent: state.recent,
    // 兼容老读取方：仍保留 item 字段（= 最近打开的那一张）。
    // 万一有旧代码、或版本回滚后读这个文件，也不至于完全瞎掉。
    item: state.recent.length > 0 ? state.recent[0] : null,
  }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  await fsp.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
  await fsp.rename(tmp, file)
  return state
}

/**
 * 记「刚打开了哪一张」：同一条资产再次打开会往前挪并累加次数，不重复占位。
 * 传 null / 无 relPath 表示清空「最近看过」列表（面板状态保留）。
 */
export async function writeContext(settingsFile, item) {
  return enqueue(async () => {
    const file = contextFilePath(settingsFile)
    const state = await readStateFile(file)
    const hasItem = item !== null && typeof item === 'object' && String(item?.relPath ?? '') !== ''
    if (!hasItem) {
      state.recent = []
      await writeStateFile(file, state)
      return null
    }
    const now = Date.now()
    const clean = sanitizeContext({ ...item, updatedAt: now, viewedAt: now })
    const prevIdx = state.recent.findIndex((r) => r.relPath === clean.relPath)
    let entry
    if (prevIdx >= 0) {
      const prev = state.recent[prevIdx]
      state.recent.splice(prevIdx, 1)
      entry = {
        ...prev,
        ...clean,
        // 打开次数只增不减；文件改动时间优先用前端这次给的，没给就沿用旧的
        viewCount: (Number(prev.viewCount) || 0) + 1,
        mtime: clean.mtime > 0 ? clean.mtime : prev.mtime,
        viewedAt: now,
      }
    } else {
      entry = { ...clean, viewCount: 1, viewedAt: now }
    }
    state.recent.unshift(entry)
    state.recent = state.recent.slice(0, MAX_RECENT)
    await writeStateFile(file, state)
    return entry
  })
}

/** 记「面板现在长什么样」：视图 / 类型 / 页码 / 总数 / 组数 / 分类开关。 */
export async function writePanel(settingsFile, panel) {
  const clean = sanitizePanel(panel)
  if (clean === null) return null
  return enqueue(async () => {
    const file = contextFilePath(settingsFile)
    const state = await readStateFile(file)
    state.panel = clean
    await writeStateFile(file, state)
    return clean
  })
}

/** 读完整状态（面板 + 最近看过的列表）。文件坏了返回空状态，绝不抛错。 */
export async function readState(settingsFile) {
  return readStateFile(contextFilePath(settingsFile))
}

/**
 * 兼容旧调用方：返回「最近打开的那一张」。
 * 老行为是「只记最后一张」，改成列表后仍然给出第一张，语义不变。
 */
export async function readContext(settingsFile) {
  const state = await readStateFile(contextFilePath(settingsFile))
  return state.recent.length > 0 ? state.recent[0] : null
}
