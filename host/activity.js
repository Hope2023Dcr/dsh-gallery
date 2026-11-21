/**
 * 第二档：资产「活跃度」打分与排序（2026-11-16）。
 *
 * 老板的口径（2026-11-16 上午改定）：
 *   **此刻正开着的、打过标记的，优先展示；最近标注、生成、改动、查看次之。**
 * 翻成人话：
 *   · 第一梯队 —— 「我正在看的那张」和「我打过标记的那张」，一定要顶在最前面。
 *     原因很实在：看着的那张、标过的那张，就是此刻手上的活。
 *   · 第二梯队 —— 最近标注过的 > 最近生成 / 改过的 > 手动改过标签的 > 看过几次的。
 *     这些是「可能相关」的线索，用来在同梯队里比先后。
 *
 * 分值故意做成「梯队之间必隔开」：第一梯队最低 1000 分，第二梯队全部加起来也到不了 500，
 * 所以不管下面怎么加分，「标记过的」都压不过「正在看的」，「刚标注的」也冒不过「打了标记的」。
 * 这样排序只看分数就够，不必另写一套层级比较，少一处口径不一致的机会。
 *
 * 这里只做纯计算，不读文件、不写文件 —— 数据由调用方（工具层）传进来，
 * 这样才好单独测试，也不会把「记状态」和「算排序」搅在一起。
 *
 * 分值构成：
 *   current   1000    此刻正开着的那张（第一梯队）
 *   marked     500    打过标记（approve / reject / finalize 之类，第一梯队）
 *   annotated 0~60    最近标注过：24 小时内满分，之后两天减半
 *   fresh     0~50    文件最近生成 / 改动：24 小时内满分，之后两天减半
 *   manual      20    手动改过分类（人明确表过态）
 *   viewed    0~15    看过次数（对数增长）× 时间衰减（半衰期一天）
 */

export const ACTIVITY_WEIGHTS = {
  current: 1000,
  marked: 500,
  annotated: 60,
  fresh: 50,
  manual: 20,
  viewed: 15,
}

/** 第一梯队的分界线：过了这条线的都算「优先展示」。 */
export const PRIORITY_FLOOR = ACTIVITY_WEIGHTS.marked

const HOUR = 3600_000

/** 路径归一：磁盘上存的是正斜杠，前端有时给反斜杠，比对前必须统一，否则永远匹配不上。 */
const normRel = (v) => String(v ?? '').replace(/\\/g, '/')

/** 把调用方给的路径集合也归一化，避免一边正斜杠一边反斜杠。 */
function normSet(value) {
  if (!(value instanceof Set)) return null
  const out = new Set()
  for (const v of value) out.add(normRel(v))
  return out
}

/** 最近标注时间表（relPath → 毫秒）同样要归一化键。 */
function normMap(value) {
  if (value instanceof Map) {
    const out = new Map()
    for (const [k, v] of value) out.set(normRel(k), Number(v) || 0)
    return out
  }
  if (value !== null && typeof value === 'object') {
    const out = new Map()
    for (const [k, v] of Object.entries(value)) out.set(normRel(k), Number(v) || 0)
    return out
  }
  return null
}

/** 时间新鲜度：24 小时内拉满，之后按「两天减半」快速衰减。
 * 衰减必须陡：按线性算的话「三天前」还能拿 37 分，跟「刚刚」几乎一样，
 * 就不叫「最近标注 / 最近改动优先」了。 */
function recencyPart(ts, now, weight) {
  const t = Number(ts) || 0
  if (t <= 0) return 0
  const ageH = (now - t) / HOUR
  if (ageH <= 24) return weight
  return weight * Math.pow(0.5, (ageH - 24) / 48)
}

/** 查看热度：次数对数增长（看 1 次≈8 分、4 次≈15 封顶），再按最后一次看的时间衰减。 */
function viewedPart(viewedAt, viewCount, now, weight) {
  const count = Number(viewCount) || 0
  if (count <= 0) return 0
  const at = Number(viewedAt) || 0
  const ageH = at > 0 ? (now - at) / HOUR : 999
  // 半衰期一天：今天看过不打折，一天前折半，一周前几乎为零
  const decay = Math.pow(0.5, Math.max(0, ageH) / 24)
  const base = Math.min(weight, 8 * Math.log2(1 + count))
  return base * decay
}

/** 逐项拆开算，调用方（打分 / 理由 / 判断梯队）共用同一份口径，不各算一套。 */
function partsOf(entry, opts = {}) {
  const now = Number(opts.now) || Date.now()
  const rel = normRel(entry?.relPath)
  const markedRels = normSet(opts.markedRels)
  const annotatedRels = normMap(opts.annotatedRels)
  const isCurrent = opts.currentRelPath !== undefined
    && opts.currentRelPath !== null
    && normRel(opts.currentRelPath) === rel
  const isMarked = markedRels !== null && markedRels.has(rel)
  const annotatedAt = annotatedRels !== null ? (annotatedRels.get(rel) ?? 0) : 0
  return {
    now,
    rel,
    isCurrent,
    isMarked,
    annotatedAt,
    fresh: recencyPart(entry?.mtime, now, ACTIVITY_WEIGHTS.fresh),
    annotated: recencyPart(annotatedAt, now, ACTIVITY_WEIGHTS.annotated),
    manual: entry?.categoryManual === true ? ACTIVITY_WEIGHTS.manual : 0,
    viewed: viewedPart(entry?.viewedAt, entry?.viewCount, now, ACTIVITY_WEIGHTS.viewed),
  }
}

/**
 * 给一条「最近看过」的记录打活跃度分。
 * @param {object} entry    context.js 里 recent[] 的一条
 * @param {object} opts     { now, currentRelPath, markedRels:Set, annotatedRels:Map }
 */
export function activityScore(entry, opts = {}) {
  const p = partsOf(entry, opts)
  const total = (p.isCurrent ? ACTIVITY_WEIGHTS.current : 0)
    + (p.isMarked ? ACTIVITY_WEIGHTS.marked : 0)
    + p.annotated + p.fresh + p.manual + p.viewed
  return Math.round(total * 10) / 10
}

/**
 * 是不是「优先展示」那一档（此刻正开着 / 打过标记）。
 * 渲染时用它单独标一句，模型一眼就知道为什么这张排前面。
 */
export function isPriority(entry, opts = {}) {
  const p = partsOf(entry, opts)
  return p.isCurrent || p.isMarked
}

/** 给模型看的一句话理由，比单给数字有用得多。 */
export function activityReasons(entry, opts = {}) {
  const p = partsOf(entry, opts)
  const out = []
  if (p.isCurrent) out.push('正在看')
  if (p.isMarked) out.push('打过标记')
  if (p.annotatedAt > 0) {
    const ageH = (p.now - p.annotatedAt) / HOUR
    if (ageH <= 1 / 60) out.push('刚标注过')
    else if (ageH <= 1) out.push(`${Math.max(1, Math.round(ageH * 60))} 分钟前标注过`)
    else if (ageH <= 24) out.push(`${Math.round(ageH)} 小时前标注过`)
    else if (ageH <= 24 * 7) out.push(`${Math.round(ageH / 24)} 天前标注过`)
    else if (ageH <= 24 * 30) out.push(`${Math.round(ageH / 24)} 天前标注过（旧标注）`)
    else out.push('很久以前标注过')
  }
  const mtime = Number(entry?.mtime) || 0
  if (mtime > 0) {
    const ageH = (p.now - mtime) / HOUR
    if (ageH <= 1) out.push('不到 1 小时前刚生成 / 改过')
    else if (ageH <= 24) out.push(`${Math.round(ageH)} 小时前生成 / 改过`)
    else if (ageH <= 24 * 7) out.push(`${Math.round(ageH / 24)} 天前生成 / 改过`)
  }
  if (entry?.categoryManual === true) out.push('手动改过标签')
  const count = Number(entry?.viewCount) || 0
  if (count > 1) out.push(`看过 ${count} 次`)
  return out
}

/**
 * 把「最近看过」按活跃度排好。
 *
 * 口径（老板 2026-11-16 上午定）：此刻正开着 / 打过标记的优先展示，
 * 最近标注、生成、改动、查看次之。分数里已经把梯队拉开（1000 / 500 对 60 以下），
 * 所以这里就是单纯按分数从高到低，同分再看谁最后被打开。
 * 「正在看」不再需要额外特例 —— 它本身就是最高分。
 */
export function rankRecent(recent, opts = {}) {
  const list = Array.isArray(recent) ? recent : []
  const now = Number(opts.now) || Date.now()
  const scored = list.map((entry, i) => ({
    entry,
    i,
    score: activityScore(entry, { ...opts, now }),
  }))
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const av = Number(a.entry?.viewedAt) || 0
    const bv = Number(b.entry?.viewedAt) || 0
    if (bv !== av) return bv - av
    return a.i - b.i
  })
  return scored.map((x) => ({ ...x.entry, activityScore: x.score }))
}

/** 面板状态翻成人话。 */
export function describePanel(panel) {
  if (panel === null || typeof panel !== 'object') return ''
  const scopeText = panel.scope === 'session' ? '当前对话' : '全部对话'
  const kindText = panel.kind === 'file' ? '文件' : (panel.kind === 'media' ? '音视频' : '图片')
  const cat = panel.categories ?? {}
  const off = []
  if (cat.final === false) off.push('定稿')
  if (cat.input === false) off.push('素材')
  if (cat.intermediate === false) off.push('过程稿')
  if (cat.unknown === false) off.push('未归类')
  const lines = [`视图：${scopeText} · 看的是${kindText}`]
  if (Number(panel.total) > 0) lines.push(`这个视图里一共 ${panel.total} 个资产`
    + (Number(panel.groupCount) > 0 ? `，分 ${panel.groupCount} 个对话组` : ''))
  if (off.length > 0) lines.push(`已隐藏：${off.join(' / ')}（这四类里其余的都还显示着）`)
  else lines.push('分类筛选：四类全显示，没有隐藏')
  return lines.join('\n')
}
