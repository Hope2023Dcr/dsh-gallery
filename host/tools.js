/**
 * 产出台 · Agent 工具（阶段 1 / B1）
 *
 * 为什么需要这一层：插件的 op 路由挂在 DSH 的 `/api` 网关上，需要进程内
 * 随机签名 cookie，对话框里的 Agent 拿不到；`window.dshGallerySeam` 又只
 * 存在于 renderer。让模型「主动调用」的正规通道是 Host 侧的
 * `ctx.tools.register` —— 注册后 schema 自动进每轮请求。
 *
 * 本文件零外部依赖：只用本插件自己的模块与 Node 内置模块。
 * `ctx.tools.register` 接受裸定义对象（不强制 defineTool），宿主实测校验：
 *   · output 必须是对象，且 output.render 必须是函数
 *   · output.schema 属于支持的 JSON Schema 子集
 *     （type / oneOf / properties / required / additionalProperties /
 *      items / enum / const + 注解）
 *   · timeoutMs 若给，必须是正有限数；名字不能是保留的 run_code
 *   · 同名 tool 在同一层重复注册会抛错 —— 未捕获会让整个插件不激活，
 *     所以注册必须包 try/catch（deep-view 源码注释里踩过这个坑）
 *
 * 红线：本工具**只读**。不改资产、不写反馈、不替用户发送任何东西。
 */
import path from 'node:path'
import { statSync } from 'node:fs'
import { scanGallery } from './scan.js'
import { applyAssetFilter, sortByRelevance } from './http.js'
import { resolveOptions } from './settings.js'
// 阶段 3 / C1：读「人正在看哪张图」（另一份临时状态，只读）
import { readContext } from './context.js'
// 原图 / 预览图反查配套主遮罩（与前端双击、拖图同一口径）
import { buildLinkedMaskIndex } from './frames.js'

const TOOL_NAME = 'gallery_find'
const CONTEXT_TOOL_NAME = 'gallery_context'
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20

/**
 * 短时复用扫描结果（2026-11-15）：同一轮里模型反复查同一批资产时，
 * 不再每次重扫全库（本机实测一次约 7 秒）。
 * 键里带上标签 / 遮罩登记 / 标记 / 反馈篮的时间戳：人改了标签或刚生成新图
 * 立刻失效；最长也只复用 12 秒，不会把新资产藏太久。过滤每轮仍重做。
 */
const SCAN_TTL_MS = 12_000
const scanCache = new Map()
function scanCacheKey(config, kind, scope, sid, opts) {
  let stamp = ""
  try {
    const home = path.dirname(String(opts.settingsFile ?? ""))
    const names = ["dsh-gallery.json", "dsh-gallery-labels.json", "dsh-gallery-frames.json",
      "dsh-gallery-marks.json", "dsh-gallery-feedback.json"]
    for (const name of names) {
      try { stamp += `${statSync(path.join(home, name)).mtimeMs}|` } catch { stamp += "0|" }
    }
  } catch { stamp = "" }
  return [kind, scope, sid, JSON.stringify(config ?? {}), stamp].join("~")
}
async function scanWithShortCache(config, kind, scope, sid, opts) {
  const key = scanCacheKey(config, kind, scope, sid, opts)
  const now = Date.now()
  const hit = scanCache.get(key)
  if (hit !== undefined && now - hit.at < SCAN_TTL_MS) return hit.value
  const value = await scanGallery(config, kind, scope, sid, 1)
  if (scanCache.size >= 6) scanCache.clear()
  scanCache.set(key, { at: now, value })
  return value
}

/** 找绝对路径所属的最长产出根；跨多根时不能赌 roots[0]。 */
function rootOf(roots, abs) {
  const a = path.resolve(String(abs ?? ''))
  let best = ''
  for (const r of roots) {
    const rr = path.resolve(String(r ?? ''))
    if ((a === rr || a.startsWith(rr + path.sep)) && rr.length > best.length) best = rr
  }
  return best
}

/**
 * 把 scan 出来的资产压成给模型的行。
 * groups 分支缺 maskOf / sessionTitle，用扁平 items 建的索引补齐。
 */
function toRow(f, roots, maskIndex, linkedIndex) {
  const relPath = String(f?.relPath ?? '')
  const absPath = String(f?.absPath ?? '')
  const mask = f?.maskOf ?? maskIndex.get(relPath) ?? null
  // 原图 / 预览图自己没有 maskOf，按登记反查配套主遮罩（与双击、拖图一致）
  const maskRel = String(mask?.relPath ?? '') || String(linkedIndex.get(relPath) ?? '')
  const root = rootOf(roots, absPath)
  return {
    relPath,
    absPath,
    name: String(f?.name ?? relPath.split('/').pop() ?? ''),
    category: String(f?.category ?? 'unknown'),
    categoryManual: f?.categoryManual === true,
    sessionId: String(f?.sessionId ?? ''),
    sessionTitle: String(f?.sessionTitle ?? ''),
    maskPath: maskRel,
    maskAbsPath: maskRel !== '' && root !== '' ? path.resolve(root, maskRel) : '',
    mtime: Number(f?.mtime ?? 0),
  }
}

/** render 的返回值就是模型与用户看到的内容 —— 路径必须直接写在文本里。 */
function renderRows(args, value) {
  if (value?.error) return [{ type: 'text', text: `产出台查询失败：${value.error}` }]
  const items = Array.isArray(value?.items) ? value.items : []
  if (items.length === 0) return [{ type: 'text', text: '产出台里没有符合条件的资产。' }]
  const q = String(args?.query ?? '').trim()
  // 2026-11-15：明确告诉模型「不填关键词＝按时间从新到旧」，
  // 否则问「最后三张」时模型会以为必须调大 limit 重查一次才能确认排序。
  const orderNote = q === ''
    ? '已按文件修改时间从新到旧排列，第一条就是最新的一张'
    : '已按关键词相关性排列'
  const lines = [`共 ${value.total} 个资产符合条件，这里列出${q === '' ? '最近的' : '最相关的'} ${items.length} 条`
    + `（${orderNote}；一次默认最多 ${DEFAULT_LIMIT} 条；本清单即最终依据，直接据此作答）：`]
  // 问「最后三张」时把结论摆在最前面，省得模型自己再跑脚本排序核对。
  if (q === '' && items.length > 0) {
    const top = items.slice(0, 3)
    lines.push(`最新 ${top.length} 张：${top.map((it, i) => `${i + 1}. ${it.name}`).join('；')}`)
  }
  for (const it of items) {
    lines.push(`· ${it.relPath} ｜ ${it.category}${it.sessionTitle ? ` ｜ 会话「${it.sessionTitle}」` : ''}`)
    lines.push(`    图：${it.absPath}`)
    if (it.maskAbsPath) lines.push(`    主遮罩：${it.maskAbsPath}`)
  }
  lines.push('以上均为绝对路径；做局部重绘时用「图 + 主遮罩」成对取用。'
    + (q === ''
      ? '问「最后几张 / 最近几张」直接取上面的前几条即可，不必重查；'
      : '')
    + '结果已核对完毕，禁止再用命令行 / 脚本 / 读取源码重复扫描，也不要再次调用本工具确认排序；'
    + '只有用户明确要求看更多张时才把 limit 调大后再查一次。')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 真查一次：进程内复用 scanGallery + applyAssetFilter，不走 /api 网关。 */
async function findAssets(args, exec, config) {
  const a = args ?? {}
  try {
    const opts = resolveOptions(config)
    const roots = Array.isArray(opts.roots) ? opts.roots : []
    const kind = a.kind === 'file' || a.kind === 'media' ? a.kind : 'image'
    const execSessionId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : ''
    const scope = a.scope === 'session' && execSessionId !== '' ? 'session' : 'global'
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number(a.limit)) || DEFAULT_LIMIT))

    const value = await scanWithShortCache(config, kind, scope, execSessionId, opts)
    const filtered = await applyAssetFilter(value, {
      filterLabel: '',
      filterCategory: typeof a.category === 'string' ? a.category : '',
      filterAction: '',
      filterExt: '',
      filterQuery: typeof a.query === 'string' ? a.query.trim().toLowerCase() : '',
      filterLimit: 500,
      settingsFile: opts.settingsFile,
    })

    // groups[].files 不带 maskOf；用扁平 items 建索引，按 relPath 回查补齐
    const flat = [
      ...(Array.isArray(filtered.items) ? filtered.items : []),
      ...(Array.isArray(filtered.files) ? filtered.files : []),
    ]
    const maskIndex = new Map()
    for (const f of flat) {
      if (f?.relPath && f.maskOf) maskIndex.set(String(f.relPath), f.maskOf)
    }
    const linkedIndex = await buildLinkedMaskIndex(opts.settingsFile)

    const rows = []
    const seen = new Set()
    const add = (f) => {
      const rel = String(f?.relPath ?? '')
      if (rel === '' || seen.has(rel)) return
      seen.add(rel)
      rows.push(toRow(f, roots, maskIndex, linkedIndex))
    }
    flat.forEach(add)
    if (Array.isArray(filtered.groups)) {
      for (const g of filtered.groups) {
        if (Array.isArray(g?.files)) g.files.forEach(add)
      }
    }
    // 有关键词时按相关性排（与清单接口同一套打分）；没关键词时仍按时间倒序。
    const q = typeof a.query === 'string' ? a.query.trim().toLowerCase() : ''
    const ordered = q !== ''
      ? sortByRelevance(rows, q, (r) => String(maskIndex.get(r.relPath)?.sourceName ?? ''))
      : rows.slice().sort((x, y) => y.mtime - x.mtime)

    return { total: ordered.length, items: ordered.slice(0, limit), error: '' }
  } catch (error) {
    // 查询出错也不能让 tool 调用抛异常，否则模型这一轮直接废掉
    return { total: 0, items: [], error: String(error?.message ?? error) }
  }
}

/** 生成注册用的裸定义对象（导出给测试真跑，不依赖 DSH 运行时）。 */
export function buildToolDefinition(config) {
  return {
    name: TOOL_NAME,
    description: '查找本机「产出台」里的资产（图片 / 文件 / 音视频）。'
      + '返回每条资产的绝对路径、分类、所属会话标题与关联主遮罩的绝对路径。'
      + '当用户问「这轮产出了什么」「把定稿图拿来」「门头那张图在哪」「有哪些素材」时用本工具，'
      + '不要让用户自己报文件名。一次默认最多返回 20 条；除非用户明确要求更多张，否则不要调大 limit。'
      + '不填关键词时结果按文件修改时间从新到旧排列，第一条就是最新的一张；'
      + '用户问「最后几张 / 最近几张 / 最新几张」时直接取返回的前几条回答，保持默认 limit 即可。'
      + '本工具结果就是最终依据：直接用它作答，禁止再运行命令行 / 脚本 / 读取源码去重复扫描或核对，'
      + '也不要为了确认排序再次调用本工具（重查要重扫全库，实测会多花一两分钟）。'
      + '只读，不会修改任何资产，也不会发送任何消息。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，匹配文件名与相对路径（不区分大小写）；留空=不限' },
        category: { type: 'string', description: '标签过滤：final=定稿 / input=素材 / intermediate=过程稿 / unknown=未归类；留空=不限' },
        kind: { type: 'string', description: '资产类型：image / file / media；默认 image' },
        scope: { type: 'string', description: 'global=全部对话 / session=当前对话；默认 global' },
        limit: { type: 'number', description: `最多返回条数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}；问「最后几张 / 最近几张」保持默认即可，除非用户明确要更多张，否则不要调大` },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'number', description: '过滤后的资产总数' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                relPath: { type: 'string' },
                absPath: { type: 'string' },
                name: { type: 'string' },
                category: { type: 'string' },
                categoryManual: { type: 'boolean' },
                sessionId: { type: 'string' },
                sessionTitle: { type: 'string' },
                maskPath: { type: 'string' },
                maskAbsPath: { type: 'string' },
                mtime: { type: 'number' },
              },
              required: ['relPath', 'absPath', 'category'],
            },
          },
          error: { type: 'string', description: '查询失败原因；成功时为空串' },
        },
        required: ['total', 'items'],
      },
      render: renderRows,
    },
    async execute(args, exec) {
      return findAssets(args, exec, config)
    },
  }
}

/** 阶段 3 / C1：把「人正在看哪张」写成模型直接看得懂的文字。 */
function renderContext(args, value) {
  const it = value?.item
  if (value?.found !== true || it === null || it === undefined || String(it?.relPath ?? '') === '') {
    return [{ type: 'text', text: typeof value?.text === 'string' && value.text !== ''
      ? value.text : '产出台里还没记下用户打开过哪张图（需要用户先在产出台点开一张大图）。' }]
  }
  const lines = ['用户最近在产出台里打开看的资产：']
  lines.push(`· 文件名：${it.name || it.relPath}`)
  lines.push(`· 完整路径：${it.absPath || it.relPath}`)
  lines.push(`· 分类：${it.category}${it.categoryManual ? '（手动改过）' : ''}`)
  if (it.sessionTitle) lines.push(`· 所属对话：${it.sessionTitle}`)
  if (it.maskAbsPath) lines.push(`· 主遮罩：${it.maskAbsPath}`)
  lines.push('以上均为绝对路径；做局部重绘时用「图 + 主遮罩」成对取用。')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 导出给测试真跑：不依赖 DSH 运行时。 */
export function buildContextToolDefinition(config) {
  return {
    name: CONTEXT_TOOL_NAME,
    description: '查用户此刻（或最近一次）在产出台里点开看的是哪一件资产。'
      + '当用户说「我刚看的那张」「这张图」「当前打开的图」时用本工具，'
      + '不要让用户重新报文件名。返回完整绝对路径与关联主遮罩。只读，不发送任何消息。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean', description: '有没有记下用户看过的图' },
          item: {
            type: 'object',
            properties: {
              relPath: { type: 'string' }, absPath: { type: 'string' },
              name: { type: 'string' }, category: { type: 'string' },
              categoryManual: { type: 'boolean' },
              maskPath: { type: 'string' }, maskAbsPath: { type: 'string' },
              sessionId: { type: 'string' }, sessionTitle: { type: 'string' },
              updatedAt: { type: 'number' },
            },
            required: ['relPath', 'absPath'],
          },
          text: { type: 'string' },
        },
        required: ['found', 'item'],
      },
      render: renderContext,
    },
    async execute() {
      try {
        const opts = resolveOptions(config)
        const item = await readContext(opts.settingsFile)
        if (item === null) {
          const text = '产出台里还没记下用户打开过哪张图（需要用户先在产出台点开一张大图）。'
          return { found: false, item: { relPath: '', absPath: '' }, text }
        }
        const text = renderContext({}, { found: true, item })[0].text
        return { found: true, item, text }
      } catch (error) {
        const text = `产出台当前状态读取失败：${String(error?.message ?? error)}`
        return { found: false, item: { relPath: '', absPath: '' }, text }
      }
    },
  }
}
/**
 * 在插件 apply() 里调用。
 * 返回 disposer；任何失败都吞掉并记日志 —— 绝不能因为 tool 注册失败
 * 让整个产出台插件不激活（拖累既有的资产台与全部 op）。
 */
export function registerTools(ctx, config) {
  const definitions = [buildToolDefinition(config), buildContextToolDefinition(config)]
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    ctx?.logger?.warn?.('dsh-gallery: ctx.tools 不可用，Agent 工具未注册')
    return () => {}
  }
  const disposers = []
  // 每个工具单独 try/catch：一个注册失败不能拖垮另一个，更不能让整个插件不激活。
  for (const def of definitions) {
    try {
      const dispose = ctx.tools.register(def)
      ctx?.logger?.info?.('dsh-gallery: tool %s 已注册', def.name)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      ctx?.logger?.warn?.('dsh-gallery: tool %s 未注册（%s）', def.name, error?.message ?? error)
    }
  }
  return () => { for (const d of disposers) { try { d() } catch { /* 忽略 */ } } }
}

export { TOOL_NAME, CONTEXT_TOOL_NAME, rootOf, toRow, renderRows, renderContext }
