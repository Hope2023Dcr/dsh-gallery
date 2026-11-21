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
// 第二档：扩成「面板现状 + 最近看过的若干张」
import { readState } from './context.js'
import { readMarks } from './marks.js'
import { rankRecent, activityReasons, describePanel, isPriority } from './activity.js'
// 原图 / 预览图反查配套主遮罩（与前端双击、拖图同一口径）
import { buildLinkedMaskIndex } from './frames.js'
// 区域感知（2026-11-16）：把「人在这张图上框了哪儿」直接告诉模型。
// 起因是实测：用户框选后说「把框里的字母改掉」，模型拿不到框的位置，
// 只能翻 frames.json / 临时目录满地找，光找就花了 97 秒。
import { readFeedback } from './feedback.js'
import { annotationsFor, latestAnnotationAt, materializeRegions, materializeMaskRegion } from './regions.js'

const TOOL_NAME = 'gallery_find'
const CONTEXT_TOOL_NAME = 'gallery_context'
const REGIONS_TOOL_NAME = 'gallery_regions'
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20
// 第二档：gallery_context 一次列多少张「最近看过的」。
// 固定值不给参数：这个工具要的是「报现状」，多一个参数只会多占模型上下文。
const CONTEXT_LIST_LIMIT = 12

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
      // 第一档：过滤阶段不再截断。旧值 500 会把宽词命中的真正头名挡在外面；
      // 实际返回条数仍由 limit 控制，这里只影响「按相关性挑前 N 条」的候选池。
      filterLimit: 200000,
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
    // 排序用过滤阶段实际生效的词（可能是模糊兜底的两字组），否则会打 0 分退化成按时间排
    const orderTerms = Array.isArray(filtered?.queryTerms) && filtered.queryTerms.length > 0
      ? filtered.queryTerms : q
    const ordered = q !== ''
      ? sortByRelevance(rows, orderTerms, (r) => String(maskIndex.get(r.relPath)?.sourceName ?? ''))
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

/** 第二档：把「面板现状 + 最近看过的几张」写成模型直接看得懂的文字。 */
function renderContext(args, value) {
  // execute 已经把完整文本算好放进 text 时直接透传，不再重拼一遍
  const preset = typeof value?.text === 'string' ? value.text : ''
  if (preset !== '') return [{ type: 'text', text: preset }]
  const lines = []
  const panelText = typeof value?.panelText === 'string' ? value.panelText : ''
  if (panelText !== '') {
    lines.push('产出台此刻的状态：')
    lines.push(panelText)
    lines.push('')
  }
  // 「此刻正开着的那张」单独写一行：排序按活跃度走，正在看不一定排第一，
  // 靠这行文字让模型永远分得清「我这张图」指的是哪一张。
  const current = value?.current
  if (current !== null && current !== undefined && String(current?.relPath ?? '') !== '') {
    lines.push(`用户此刻正开着的是：${current.name || current.relPath}`)
    lines.push(`   路径：${current.absPath || current.relPath}`)
    // 已经手动画好遮罩的图，必须在这里就点明「现成可用」。
    // 不点明的话，模型会怀疑这只是一张预览图，然后自己写脚本去量像素（实测耗掉三分半钟）。
    const curMask = String(current?.maskAbsPath ?? '')
    if (curMask !== '') {
      lines.push(`   这张图已经有用户手动画好的遮罩：${curMask}`)
      lines.push('   （现成可用，直接拿去重绘；要它盖住哪一块、或要一张裁剪小图，调 gallery_regions）')
    }
    lines.push('')
  }
  // 框选批注：这条过去完全没有出口，模型只能自己翻文件找（实测花了 97 秒）。
  // 有就明说，并且直接指向 gallery_regions —— 不要让模型再摸黑试。
  const annots = Array.isArray(value?.annotations) ? value.annotations : []
  if (annots.length > 0) {
    lines.push(`用户在「此刻开着的那张图」上框了 ${annots.length} 处区域：`)
    annots.forEach((a) => {
      const shapeText = a.shape === 'polygon'
        ? `不规则区域 ${a.pointCount} 点`
        : '矩形区域'
      const noteText = a.note !== '' ? ` ｜ 说明：${a.note}` : ''
      lines.push(`   ${a.index}. ${shapeText} · 左 ${a.xPct}% 上 ${a.yPct}% 宽 ${a.wPct}% 高 ${a.hPct}%${noteText}`)
    })
    lines.push('   → 要看框里到底是什么、要现成的裁剪小图或遮罩，直接调 gallery_regions。')
    lines.push('     不要再去翻 feedback.json / frames.json / 临时目录，也不要自己写脚本反解坐标。')
    lines.push('')
  }
  const items = Array.isArray(value?.items) ? value.items : []
  if (items.length === 0) {
    lines.push('产出台里还没记下用户打开过哪张图（需要用户先在产出台点开一张大图）。')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  lines.push(`用户最近在产出台里打开过这 ${items.length} 张，按活跃度排`
    + '（此刻正开着、打过标记的优先展示；其次才是最近标注、最近生成 / 改动的，看过次数排最后）：')
  items.forEach((it, i) => {
    const reasons = Array.isArray(it.reasons)
      ? it.reasons.filter((x) => typeof x === 'string' && x !== '') : []
    const tag = reasons.length > 0 ? ` ｜ ${reasons.join(' · ')}` : ''
    lines.push(`${i + 1}. ${it.name || it.relPath}${tag}`)
    lines.push(`   路径：${it.absPath || it.relPath}`)
    const meta = [`分类：${it.category}${it.categoryManual ? '（手动改过）' : ''}`]
    if (it.sessionTitle) meta.push(`会话「${it.sessionTitle}」`)
    lines.push(`   ${meta.join(' ｜ ')}`)
    if (it.maskAbsPath) lines.push(`   主遮罩：${it.maskAbsPath}`)
  })
  // 标记过、却不在这份清单里的图：点个名，免得用户以为「我标过的那张怎么没出现」。
  const marksNotListed = Array.isArray(value?.marksNotListed) ? value.marksNotListed : []
  if (marksNotListed.length > 0) {
    const nowMs = Date.now()
    lines.push('')
    lines.push('另外，用户还标记过下面这几张，但它们不在上面这份「最近看过」清单里：')
    for (const m of marksNotListed) {
      const days = Math.max(0, Math.round((nowMs - (Number(m.markedAt) || 0)) / 86400000))
      const when = days <= 0 ? '今天' : `${days} 天前`
      lines.push(`   · ${m.relPath}（${when}标记）`)
    }
    lines.push('   要它们的绝对路径就用 gallery_find 按文件名查，别自己拼目录。')
    lines.push('')
  }
  lines.push('以上均为绝对路径；做局部重绘时用「图 + 主遮罩」成对取用。')
  lines.push('这只是「用户最近看过的几张」和面板现状，不是全库清单；要找具体资产、或按关键词定位，请用 gallery_find。')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 导出给测试真跑：不依赖 DSH 运行时。 */
export function buildContextToolDefinition(config) {
  return {
    name: CONTEXT_TOOL_NAME,
    description: '查产出台此刻的状态：面板停在哪个视图、筛掉了哪几类、一共多少资产、分几个对话组，'
      + '以及用户最近打开看过哪几张图（按活跃度排：此刻正开着 / 打过标记的优先展示，'
      + '其次按最近标注、最近生成改动、看过次数）。'
      + '当用户说「这张图」「我刚看的那张」「刚才那几张」「我连着看的那组」'
      + '「产出台里现在有什么 / 还剩多少」时都用本工具，不要让用户重新报文件名。'
      + '返回完整绝对路径与关联主遮罩。只读，不发送任何消息。'
      + '这是「最近看过的几张」而不是全库；要找具体某张、或按关键词定位，用 gallery_find。',
    // 不给参数：这个工具就是「报一下现状 + 最近看过的几张」，多一个参数只会多占上下文
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
          items: {
            type: 'array',
            description: '最近看过的图，按活跃度从高到低',
            items: {
              type: 'object',
              properties: {
                relPath: { type: 'string' }, absPath: { type: 'string' },
                name: { type: 'string' }, category: { type: 'string' },
                categoryManual: { type: 'boolean' },
                sessionTitle: { type: 'string' },
                maskAbsPath: { type: 'string' },
                activityScore: { type: 'number', description: '活跃度分，越高越可能是用户此刻要找的' },
                priority: { type: 'boolean', description: '是否属于优先展示那一档（此刻正开着 / 打过标记）' },
                reasons: {
                  type: 'array',
                  description: '为什么排在前面：正在看 / 打过标记 / 刚标注过 / 刚生成改过 / 看过几次',
                  items: { type: 'string' },
                },
              },
              required: ['relPath', 'absPath'],
            },
          },
          panel: {
            type: 'object',
            description: '面板现状；用户还没打开过面板时数字可能为 0',
            properties: {
              scope: { type: 'string', description: 'global=全部对话 / session=当前对话' },
              kind: { type: 'string', description: 'image / file / media' },
              page: { type: 'number' },
              total: { type: 'number', description: '当前视图里的资产总数' },
              groupCount: { type: 'number', description: '分几个对话组' },
            },
            required: [],
          },
          text: { type: 'string' },
          annotationCount: { type: 'number', description: '此刻开着的那张图上有几处框选批注' },
          annotations: {
            type: 'array',
            description: '此刻开着的那张图上的框选区域，坐标是相对整图的百分比',
            items: {
              type: 'object',
              properties: {
                index: { type: 'number' },
                shape: { type: 'string', description: 'rect=矩形 / polygon=不规则区域' },
                xPct: { type: 'number', description: '左边距，百分比 0–100' },
                yPct: { type: 'number' },
                wPct: { type: 'number' },
                hPct: { type: 'number' },
                note: { type: 'string', description: '用户给这块写的说明，可能为空' },
                pointCount: { type: 'number', description: '不规则区域的顶点数' },
              },
              required: ['index', 'shape'],
            },
          },
          marksNotListed: {
            type: 'array',
            description: '打过标记、但不在 items 清单里的图；只有相对路径，定位用 gallery_find',
            items: {
              type: 'object',
              properties: {
                relPath: { type: 'string' },
                markedAt: { type: 'number' },
                action: { type: 'string' },
              },
              required: ['relPath'],
            },
          },
        },
        required: ['found', 'item'],
      },
      render: renderContext,
    },
    async execute() {
      try {
        const opts = resolveOptions(config)
        const state = await readState(opts.settingsFile)
        // 标记（approve / reject / finalize…）也是活跃度的一部分：人表过态的更可能是目标
        let marks = {}
        try { marks = (await readMarks(opts.settingsFile)).marks ?? {} } catch { marks = {} }
        const markedRels = new Set(Object.keys(marks))
        const currentRel = state.recent.length > 0 ? String(state.recent[0].relPath ?? '') : ''
        // 批注只读一次，两处都用得上：
        //   ① 每张图「最后一次标注」的时间 —— 排序里排在生成 / 改动之前（老板 11-16 口径）；
        //   ② 当前这张图的批注明细 —— 模型不用再翻文件找框在哪儿。
        let feedback = {}
        try { feedback = (await readFeedback(opts.settingsFile)).feedback ?? {} } catch { feedback = {} }
        const rankOpts = {
          currentRelPath: currentRel,
          markedRels,
          annotatedRels: latestAnnotationAt(feedback),
        }
        const ranked = rankRecent(state.recent, rankOpts)
        const items = ranked.slice(0, CONTEXT_LIST_LIMIT).map((it) => ({
          ...it,
          // 第一梯队（此刻正开着 / 打过标记）单独标出来，渲染时另起一段，模型一眼看得清
          priority: isPriority(it, rankOpts),
          reasons: activityReasons(it, rankOpts),
        }))
        const panel = state.panel
        // 打过标记、但不在「最近看过」里的图：这份列表覆盖不到它们。
        // 不补这一句，用户会以为「我标过的那张怎么没出现」。
        // 只提文件名与日期，不给绝对路径 —— 标记记录里只有相对路径，多根目录时硬拼会拼错，
        // 让模型用 gallery_find 去定位，宁可少给也不给错。
        const recentSet = new Set(state.recent.map((r) => String(r.relPath ?? '').replace(/\\/g, '/')))
        const marksNotListed = Object.entries(marks)
          .map(([rel, m]) => ({
            relPath: String(rel).replace(/\\/g, '/'),
            markedAt: Number(m?.markedAt) || 0,
            action: String(m?.action ?? ''),
          }))
          .filter((m) => m.markedAt > 0 && !recentSet.has(m.relPath))
          .sort((a, b) => b.markedAt - a.markedAt)
          .slice(0, 3)
        // 当前图上有没有人刚框的区域 —— 这是模型最需要、过去却完全拿不到的一条事实。
        // 拿不到它，模型只能自己翻 feedback.json / frames.json / 临时目录，
        // 实测一次要 97 秒。这里直接给摘要，细节留给 gallery_regions。
        let annotations = []
        try { annotations = annotationsFor(feedback, currentRel) } catch { annotations = [] }
        const annotationBrief = annotations.map((a, i) => ({
          index: i + 1,
          shape: a.shape,
          xPct: Math.round(a.x * 1000) / 10,
          yPct: Math.round(a.y * 1000) / 10,
          wPct: Math.round(a.w * 1000) / 10,
          hPct: Math.round(a.h * 1000) / 10,
          note: a.note,
          pointCount: Array.isArray(a.polygon) ? a.polygon.length : 0,
        }))
        const value = {
          found: items.length > 0,
          item: items[0] ?? { relPath: '', absPath: '' },
          items,
          // 最近打开的那一张（不管它排第几，都单独告诉模型「此刻正开着的是这张」）
          current: state.recent.length > 0 ? state.recent[0] : null,
          panel: panel ?? { scope: '', kind: '', page: 0, total: 0, groupCount: 0 },
          panelText: describePanel(panel),
          // 此刻正开着的那张图上有几条框选批注（0 = 没框）
          annotationCount: annotationBrief.length,
          annotations: annotationBrief,
          // 标记过但不在「最近看过」清单里的图（只给名字，定位走 gallery_find）
          marksNotListed,
          text: '',
        }
        value.text = renderContext({}, value)[0].text
        return value
      } catch (error) {
        const text = `产出台当前状态读取失败：${String(error?.message ?? error)}`
        return { found: false, item: { relPath: '', absPath: '' }, items: [], text }
      }
    },
  }
}
/**
 * 区域工具的文字输出。
 * 铁律：裁剪图的**绝对路径必须写在正文里** —— 模型只会照着正文里的路径去 read_image，
 * 藏在结构化字段里它看不见（这一条在查图工具上已经吃过一次）。
 */
function renderRegions(args, value) {
  if (value?.error) return [{ type: 'text', text: `产出台区域查询失败：${value.error}` }]
  const regions = Array.isArray(value?.regions) ? value.regions : []
  if (regions.length === 0) {
    return [{ type: 'text', text: value?.hint || '这张图上没有任何框选批注。' }]
  }
  const size = value?.image ?? { width: 0, height: 0 }
  const byMask = value?.source === 'mask'
  const lines = []
  lines.push(`图：${value.absPath}`)
  lines.push(`尺寸：${size.width} × ${size.height} 像素`)
  if (byMask) {
    lines.push('')
    lines.push('用户已经手动画好遮罩了，遮罩文件是现成的 —— 直接用，不要再自己算坐标，也不要重新生成遮罩：')
    lines.push(`   遮罩文件 ${value.maskAbsPath}`)
    lines.push('   （全尺寸；选区里透明、其余保留原图。边界是用户自己画的，以它为准。）')
  }
  if (value?.degraded) lines.push(`注意：${value.degraded}`)
  lines.push('')
  regions.forEach((r) => {
    const shapeText = r.shape === 'mask'
      ? '遮罩覆盖范围'
      : (r.shape === 'polygon' ? `不规则区域（${r.pointCount} 点）` : '矩形区域')
    lines.push(`区域 ${r.index}：${shapeText}`)
    lines.push(`   整图位置：左 ${r.px.x}px 上 ${r.px.y}px 宽 ${r.px.w}px 高 ${r.px.h}px`
      + `（即 左 ${r.xPct}% 上 ${r.yPct}% 宽 ${r.wPct}% 高 ${r.hPct}%）`)
    if (r.note !== '') lines.push(`   用户说明：${r.note}`)
    if (r.cropPath) {
      const cb = r.cropBox ?? {}
      lines.push(`   裁剪图（已外扩一圈便于看清上下文）：${r.cropPath}`)
      lines.push(`      裁剪范围 左 ${cb.x}px 上 ${cb.y}px 宽 ${cb.w}px 高 ${cb.h}px`)
    }
    if (r.maskPath && r.shape !== 'mask') {
      lines.push(`   临时遮罩（全尺寸，框内 alpha=0、框外保留原图）：${r.maskPath}`)
    }
  })
  lines.push('')
  if (byMask) {
    lines.push('用法：遮罩已经就位，直接拿「图 + 上面那个遮罩文件」提交重绘。')
    lines.push('要确认框住的是哪个字，看一眼上面的裁剪图就够了 —— 不要再去量透明像素数、算覆盖率、画框放大、生成诊断图。')
    lines.push('结果出来后立刻交付给用户看，最多整体比一眼，不要逐像素反复验收 —— 好坏由用户判断。')
  } else {
    lines.push('用法：先用 read_image 看一眼上面的裁剪图，确认框里到底是什么，再动手。')
    lines.push('看一眼就够；结果出来后立刻交付给用户，不要自己反复量化验收。')
  }
  lines.push('这些裁剪图和临时遮罩都在系统临时目录，只供本次使用；要正式存进产出台，让用户在那里导出遮罩。')
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 区域感知工具（2026-11-16）：把「用户在这张图上框了哪儿」一次给全。
 *
 * 存在的理由（实测数据）：用户框选后说「把框里的字母改掉」，模型拿不到框位置，
 * 翻 frames.json / feedback.json / 临时目录找了 7 次、花了 97 秒才发现框在哪，
 * 又花 150 秒自己写 PIL 反解坐标。这个工具把这些全部前置。
 */
export function buildRegionsToolDefinition(config) {
  return {
    name: REGIONS_TOOL_NAME,
    description: '取产出台里「用户此刻开着的那张图」上要处理的那块区域。两种情况都会答：'
      + '① 用户已经画好遮罩（右键逐点填充后导出的遮罩文件）→ 直接把现成遮罩的绝对路径、'
      + '覆盖范围、外扩后的裁剪小图报回来，照用即可；'
      + '② 用户只在反馈篮里框了区域 → 报每块区域的整图像素位置、外扩裁剪图、可选临时遮罩。'
      + '凡是用户说「这张图」「框选的这块」「我圈的地方」「把框里的 X 改成 Y」「按这个遮罩重绘」时，'
      + '第一个动作就调本工具，不要自己去找 feedback.json / frames.json / 临时目录，'
      + '也不要自己写脚本量透明像素、算覆盖率、画包围盒或反解归一化坐标 —— 那些又慢又容易找错。'
      + '拿到区域后不要再反复校验遮罩是否「合格」：边界是用户画的，以它为准。'
      + '两者都没有时本工具会直接说明，此时再按整图处理。'
      + '只读：不改资产、不写反馈、不发送消息；裁剪图只落系统临时目录。',
    parameters: {
      type: 'object',
      properties: {
        relPath: { type: 'string', description: '要查的资产相对路径；留空＝用户此刻开着的那张' },
        withMask: { type: 'boolean', description: '要不要顺手生成临时 RGBA 遮罩；做局部重绘时填 true' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean', description: '这张图上有没有框选批注，或有没有用户画好的遮罩' },
          source: { type: 'string', description: 'mask=用户已画好的遮罩文件（现成可用） / annotation=反馈篮里的框选批注 / none=都没有' },
          maskAbsPath: { type: 'string', description: '用户画好的遮罩绝对路径（有就是现成的，直接用）' },
          absPath: { type: 'string', description: '图本身的绝对路径' },
          image: {
            type: 'object',
            properties: { width: { type: 'number' }, height: { type: 'number' } },
            required: [],
          },
          regions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'number' },
                shape: { type: 'string' },
                px: {
                  type: 'object',
                  description: '整图像素矩形',
                  properties: {
                    x: { type: 'number' }, y: { type: 'number' },
                    w: { type: 'number' }, h: { type: 'number' },
                  },
                  required: [],
                },
                xPct: { type: 'number' }, yPct: { type: 'number' },
                wPct: { type: 'number' }, hPct: { type: 'number' },
                note: { type: 'string' },
                pointCount: { type: 'number' },
                cropPath: { type: 'string', description: '外扩后的裁剪小图绝对路径' },
                maskPath: { type: 'string', description: '临时遮罩绝对路径（未要求时为空）' },
                pixelCount: { type: 'number', description: '遮罩里被选中的像素数（仅参考，不要拿它做验收）' },
              },
              required: ['index', 'shape'],
            },
          },
          degraded: { type: 'string', description: '降级说明；正常时为空' },
          hint: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['found', 'regions'],
      },
      render: renderRegions,
    },
    async execute(args) {
      try {
        const opts = resolveOptions(config)
        const state = await readState(opts.settingsFile)
        const wanted = String(args?.relPath ?? '').replace(/\\/g, '/')
        let relPath = wanted
        let absPath = ''
        let entry = null
        if (relPath === '') {
          entry = state.recent.length > 0 ? state.recent[0] : null
          relPath = String(entry?.relPath ?? '')
          absPath = String(entry?.absPath ?? '')
        } else {
          // 用户点名了某张：顺带取回它的主遮罩（可能是他自己画好导出的）
          entry = state.recent.find(
            (r) => String(r?.relPath ?? '').replace(/\\/g, '/') === relPath,
          ) ?? null
        }
        if (relPath === '') {
          return {
            found: false, regions: [], absPath: '',
            image: { width: 0, height: 0 },
            hint: '产出台还没记下用户打开过哪张图；请让用户先在产出台点开要处理的那张。',
          }
        }
        if (absPath === '') {
          // 只给了 relPath：按产出根还原绝对路径，绝不拼任意路径
          for (const root of opts.roots) {
            if (typeof root !== 'string' || root === '') continue
            const abs = path.resolve(root, relPath)
            if (!abs.startsWith(path.resolve(root) + path.sep)) continue
            try {
              const st = statSync(abs)
              if (st.isFile()) { absPath = abs; break }
            } catch { /* 换下一个根 */ }
          }
        }
        if (absPath === '') {
          return {
            found: false, regions: [], absPath: '',
            image: { width: 0, height: 0 },
            hint: `找不到这张资产：${relPath}`,
          }
        }
        const fb = await readFeedback(opts.settingsFile)
        const annotations = annotationsFor(fb.feedback, relPath)
        // 用户还有一条更常用的路：右键逐点填充 → 导出遮罩文件，遮罩已经躺在产出目录里。
        // 这种情况根本没有批注，但现成的遮罩比批注更准 —— 必须优先把它报出来，
        // 否则模型会以为「用户没框过」，然后自己从头量像素（实测耗掉三分半钟）。
        const maskAbsPath = String(entry?.maskAbsPath ?? '')
        const hasMask = maskAbsPath !== '' && path.isAbsolute(maskAbsPath)

        if (annotations.length > 0) {
          const out = await materializeRegions({
            absPath,
            annotations,
            withCrop: args?.withCrop !== false,
            withMask: args?.withMask === true,
          })
          return {
            found: out.regions.length > 0,
            source: 'annotation',
            absPath,
            relPath,
            maskAbsPath: hasMask ? maskAbsPath : '',
            image: out.image,
            regions: out.regions,
            degraded: out.degraded ?? '',
            hint: '',
          }
        }

        if (hasMask) {
          const out = await materializeMaskRegion({ absPath, maskPath: maskAbsPath, withCrop: true })
          if (out.region === null) {
            return {
              found: false, source: 'mask', absPath, relPath,
              maskAbsPath, image: out.image, regions: [], degraded: out.degraded ?? '',
              hint: `这张图有一份用户画好的遮罩（${maskAbsPath}），可以直接用于重绘；`
                + `只是这次没能读出它的覆盖范围（${out.degraded || '原因未知'}）。`,
            }
          }
          return {
            found: true,
            source: 'mask',
            absPath,
            relPath,
            maskAbsPath,
            image: out.image,
            regions: [{
              index: 1,
              shape: 'mask',
              px: out.region.px,
              xPct: out.region.xPct,
              yPct: out.region.yPct,
              wPct: out.region.wPct,
              hPct: out.region.hPct,
              note: '',
              pointCount: 0,
              pixelCount: out.region.pixelCount,
              cropPath: out.region.cropPath,
              cropBox: out.region.cropBox,
              maskPath: maskAbsPath,
            }],
            degraded: out.degraded ?? '',
            hint: '',
          }
        }

        return {
          found: false, source: 'none', regions: [], absPath, relPath,
          image: { width: 0, height: 0 }, maskAbsPath: '',
          hint: `这张图上既没有框选批注，也没有用户存好的遮罩（${relPath}）。`
            + '用户确实没在这张图上框过，请按整张图处理。',
        }
      } catch (error) {
        return {
          found: false, regions: [], absPath: '', image: { width: 0, height: 0 },
          error: String(error?.message ?? error),
        }
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
  const definitions = [
    buildToolDefinition(config),
    buildContextToolDefinition(config),
    buildRegionsToolDefinition(config),
  ]
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

export { TOOL_NAME, CONTEXT_TOOL_NAME, REGIONS_TOOL_NAME, rootOf, toRow, renderRows, renderContext, renderRegions }
