/**
 * 交付清单组装内核（v1.5.0）
 *
 * 一个内核、两个出口：
 *   · 出口 1 —— op `exportManifest`：落盘成 CSV / JSON，给人看、进 Excel 做物料表
 *   · 出口 2 —— 工具 `gallery_manifest`：直接回给 Agent，驱动下一轮
 * 两边都调这里，保证「您看到的清单」和「我读到的清单」永远是同一份数字。
 *
 * 三条硬约束：
 *   1. **只读**：本模块绝不写盘。落盘由 http.js 的 op 负责（走 atomic.js）。
 *   2. **不猜**：拿不到尺寸就留空，不写 0，免得客户以为图是 0×0。
 *   3. **截断必须说出来**：超上限如实置 truncated，不静默少给。
 *
 * 为什么尺寸要自己读文件头：扫描结果里没有宽高（`context.json` 实测字段无 width/height），
 * 而整图解码来拿尺寸代价太大。`regions.js` 的 `imageSizeOf()` 只解析文件头（零依赖，
 * 不用任何图像库），读一次 open 同时取 stat，IO 只走一趟。
 */

import { promises as fsp } from 'node:fs'

import { imageSizeOf } from './regions.js'
import { mapPool, SCAN_CONCURRENCY } from './scan.js'
// 时间码格式复用截帧那一套（`00-02-17-892`，用「-」而非「:」因为文件名不许冒号），
// 不在这里另写一份，免得清单上的时间码和文件名里的对不上。
import { frameTimecode } from './frames.js'

/** 清单格式版本：将来加列/改语义就升这个数，读的人能判断兼容性。 */
export const MANIFEST_SCHEMA = 1

/** 分类的中文名，CSV 里给人看的就是这几个字 */
export const CATEGORY_TEXT = {
  final: '定稿',
  input: '素材',
  intermediate: '过程稿',
  unknown: '未归类',
}

export const MANIFEST_CATEGORIES = ['final', 'input', 'intermediate', 'unknown']

/**
 * 读文件头用的字节数。JPEG 的 SOF 段前面可能挂着 EXIF 缩略图，
 * 64 字节常常看不到宽高，所以一次读 8 KB（只读头部，不读整图）。
 */
const HEAD_BYTES = 8192

/**
 * 需要读盘的条目上限。**只统计「扫描条目里缺 width/height/size」的那些** ——
 * 扫描结果实测自带 width / height / size（见 scan.js 产出），绝大多数条目根本不用读盘。
 * 真正要读盘的是老缓存、文件类资产这些，数量有限；超了就让它们留空，不硬扛。
 */
const SIZE_PROBE_MAX = 4000

/** 单份清单的条目上限：全库实测 6930 条，留足余量又不至于把响应撑爆。 */
const MANIFEST_MAX_ITEMS = 20000

/** 路径统一成斜杠形态（与 labels / frames 的键口径一致，否则永远查不中）。 */
export function normalizeRelPath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 取一个「大于 0 的有限数」，拿不到一律回 0。
 *
 * 🔴 必须用这个而不是 `Number(x) || y`：扫描条目里 width/height 可能是 null，
 * `Number(null)` 是 0 但兜底到 frames 的 undefined 就成了 NaN，
 * 而 **NaN 参与任何比较都是 false**（`NaN <= 0` 为 false），
 * 会让「缺宽高就去读盘」的判断静默失效 —— 实测 2024 条一条都没补上。
 */
function positiveNum(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 本地时间 `2026-11-25 10:43`；拿不到就留空，别写 1970。 */
export function formatLocalTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 人类可读体积：给客户看的是「1.2 MB」而不是 1258291。 */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * CSV 单元格转义（RFC 4180）。
 * 逗号、引号、换行都必须整格包引号，内部引号写成两个 ——
 * 少做一步，Excel 就会把一格拆成两列，客户拿到的清单是错位的。
 */
export function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value)
  if (s === '') return ''
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * 读一个文件的体积 + 宽高（一次 open 同时拿 stat 和文件头）。
 * hint 是 frames 里已经记过的 imageWidth/imageHeight，有就不必再读头。
 */
async function probeFile(absPath, hint) {
  if (!absPath) return null
  let handle = null
  try {
    handle = await fsp.open(absPath, 'r')
    const st = await handle.stat()
    if (!st.isFile()) return null
    let size = null
    if (hint && Number(hint.width) > 0 && Number(hint.height) > 0) {
      size = { width: Number(hint.width), height: Number(hint.height), format: '' }
    } else {
      const buf = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0)
      if (bytesRead >= 24) size = imageSizeOf(buf.subarray(0, bytesRead))
    }
    return { bytes: st.size, width: size?.width ?? 0, height: size?.height ?? 0, format: size?.format ?? '' }
  } catch {
    // 文件被移走 / 没权限都走这里：清单里这一格留空，不编数
    return null
  } finally {
    if (handle !== null) {
      try { await handle.close() } catch { /* 关不掉不影响结果 */ }
    }
  }
}

/** 从 frames 登记里取「这条资产是从哪个视频的哪一刻截出来的」。 */
function sourceOfFrame(frame) {
  if (frame === null || typeof frame !== 'object') return null
  const videoName = String(frame.videoName ?? frame.sourceName ?? '')
  const videoRelPath = String(frame.videoRelPath ?? frame.sourceRelPath ?? '')
  const frameMs = Number(frame.frameMs)
  const hasMs = Number.isFinite(frameMs) && frameMs > 0
  // 老登记没有 timecode 字段只有 frameMs，这时按同一套规则补出来
  const timecode = String(frame.timecode ?? '') || (hasMs ? frameTimecode(frameMs) : '')
  if (videoName === '' && videoRelPath === '' && timecode === '') return null
  return {
    videoName,
    videoRelPath,
    timecode,
    frameMs: hasMs ? frameMs : 0,
  }
}

/** 反馈篮里对这条资产的备注（结构开放，认不出就当没有）。 */
function noteOf(record) {
  if (record === null || typeof record !== 'object') return { note: '', annotationCount: 0 }
  const note = typeof record.text === 'string' ? record.text
    : typeof record.note === 'string' ? record.note
      : typeof record.comment === 'string' ? record.comment : ''
  const regions = Array.isArray(record.regions) ? record.regions
    : Array.isArray(record.annotations) ? record.annotations
      : Array.isArray(record.region) ? record.region : []
  return { note: String(note).slice(0, 300), annotationCount: regions.length }
}

/**
 * 组装交付清单。**只读，不落盘。**
 *
 * @param options.entries     扫描出来的条目（一定要带 relPath）
 * @param options.relPaths    只要这些（批量选中时传）；空 = 不限
 * @param options.categories  只要这几类；空 = 不限
 * @param options.frames      frames.json 的 frames 映射（补来源视频与时间码）
 * @param options.labels      labels.json 的 labels 映射（判断是否人工改过）
 * @param options.feedback    feedback.json 的 feedback 映射（补备注）
 * @param options.masks        relPath → 配套遮罩的相对路径（buildLinkedMaskIndex 产出）
 * @param options.includeSize 是否补宽高与体积（默认 true；条目自带就不读盘，只在缺字段时读文件头）
 * @param options.includeNotes 是否带反馈备注（默认 false，导出交付件时才开）
 * @param options.maxItems    硬上限，超出置 truncated
 */
export async function buildManifest(options = {}) {
  const entries = Array.isArray(options.entries) ? options.entries : []
  const frames = options.frames !== null && typeof options.frames === 'object' ? options.frames : {}
  const labels = options.labels !== null && typeof options.labels === 'object' ? options.labels : {}
  const feedback = options.feedback !== null && typeof options.feedback === 'object' ? options.feedback : {}
  // masks：relPath -> 遮罩相对路径（由 frames.js 的 buildLinkedMaskIndex 建，http.js 传进来）
  const masks = options.masks !== null && typeof options.masks === 'object' ? options.masks : {}
  const includeSize = options.includeSize !== false
  const includeNotes = options.includeNotes === true
  const maxItems = Math.max(1, Math.min(MANIFEST_MAX_ITEMS, Math.trunc(Number(options.maxItems)) || 2000))
  const wantPaths = Array.isArray(options.relPaths) && options.relPaths.length > 0
    ? new Set(options.relPaths.map(normalizeRelPath).filter((p) => p !== ''))
    : null
  const wantCats = Array.isArray(options.categories) && options.categories.length > 0
    ? new Set(options.categories.map((c) => String(c ?? '')).filter((c) => MANIFEST_CATEGORIES.includes(c)))
    : null

  // 去重 + 过滤。同一张图可能同时出现在 items 与 groups[].files 里。
  const picked = []
  const seen = new Set()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const relPath = normalizeRelPath(entry.relPath)
    if (relPath === '' || seen.has(relPath)) continue
    // 分叉隔离：分叉会话继承来的资产默认不进交付清单（它们不属于本次产出）
    if (entry.inherited === true || entry.shared === true) {
      if (options.includeInherited !== true) continue
    }
    if (wantPaths !== null && !wantPaths.has(relPath)) continue
    const manual = labels[relPath]
    const category = String(entry.category ?? (manual?.category ?? 'unknown')) || 'unknown'
    if (wantCats !== null && !wantCats.has(category)) continue
    seen.add(relPath)
    picked.push({ entry, relPath, category, manual: manual !== null && typeof manual === 'object' })
  }

  // 稳定顺序：按相对路径升序，同一份数据导两次的序号能对上账
  picked.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))

  const truncated = picked.length > maxItems
  const sliced = truncated ? picked.slice(0, maxItems) : picked

  // 扫描条目本身自带 width / height / size（实测字段），能用就直接用，一次盘都不读。
  // 只有缺这些字段的（老缓存、文件类资产、视频）才去读文件头。
  const needProbe = []
  if (includeSize) {
    for (let i = 0; i < sliced.length; i += 1) {
      const { entry, relPath } = sliced[i]
      const fr = frames[relPath]
      const w = positiveNum(entry.width) || positiveNum(fr?.imageWidth)
      const h = positiveNum(entry.height) || positiveNum(fr?.imageHeight)
      const size = positiveNum(entry.size)
      // 写成 !(w > 0) 而不是 w <= 0：NaN 会让后者恒为 false，缺尺寸的条目会被整体漏掉
      if ((!(w > 0) || !(h > 0) || !(size > 0)) && String(entry.absPath ?? '') !== '') needProbe.push(i)
    }
  }
  const probes = new Map()
  if (needProbe.length > 0 && needProbe.length <= SIZE_PROBE_MAX) {
    const results = await mapPool(needProbe, SCAN_CONCURRENCY, (i) => {
      const { entry, relPath } = sliced[i]
      const fr = frames[relPath]
      return probeFile(String(entry.absPath ?? ''), {
        width: positiveNum(entry.width) || positiveNum(fr?.imageWidth),
        height: positiveNum(entry.height) || positiveNum(fr?.imageHeight),
      })
    })
    for (let k = 0; k < needProbe.length; k += 1) probes.set(needProbe[k], results[k])
  }

  // summary 必须基于**截断前**的 picked：total 是「筛选后一共多少条」，
  // 不是「这次返回了多少条」。否则模型看到「共 8 条」会以为清单只有 8 条。
  const byCategory = { final: 0, input: 0, intermediate: 0, unknown: 0 }
  let withMask = 0
  let fromVideo = 0
  let totalBytes = 0
  for (const { entry, relPath, category } of picked) {
    if (Object.prototype.hasOwnProperty.call(byCategory, category)) byCategory[category] += 1
    else byCategory.unknown += 1
    if (normalizeRelPath(entry.maskPath ?? masks[relPath] ?? '') !== '') withMask += 1
    if (sourceOfFrame(frames[relPath]) !== null) fromVideo += 1
    totalBytes += positiveNum(entry.size)
  }

  const items = []
  for (let i = 0; i < sliced.length; i += 1) {
    const { entry, relPath, category, manual } = sliced[i]
    const probe = probes.get(i) ?? null
    const fr = frames[relPath]
    const frame = sourceOfFrame(fr)
    const fb = includeNotes ? noteOf(feedback[relPath]) : { note: '', annotationCount: 0 }
    // 扫描条目里**没有** maskPath 字段（实测过），遮罩只能靠 frames 的关联索引反查：
    // 索引的键是原图/预览图的相对路径，值是配套遮罩图。不传索引就是空的。
    const maskPath = normalizeRelPath(entry.maskPath ?? masks[relPath] ?? '')
    const name = String(entry.name ?? relPath.split('/').pop() ?? '')
    const width = positiveNum(probe?.width) || positiveNum(entry.width) || positiveNum(fr?.imageWidth)
    const height = positiveNum(probe?.height) || positiveNum(entry.height) || positiveNum(fr?.imageHeight)
    const bytes = positiveNum(probe?.bytes) || positiveNum(entry.size)

    items.push({
      index: i + 1,
      name,
      relPath,
      absPath: String(entry.absPath ?? ''),
      category,
      categoryText: CATEGORY_TEXT[category] ?? CATEGORY_TEXT.unknown,
      categoryManual: manual,
      width,
      height,
      format: probe?.format ?? '',
      bytes,
      bytesText: formatBytes(bytes),
      mtime: Number(entry.mtime) || 0,
      mtimeText: formatLocalTime(entry.mtime),
      sessionId: String(entry.sessionId ?? ''),
      sessionTitle: String(entry.sessionTitle ?? ''),
      maskPath,
      videoName: frame?.videoName ?? '',
      videoRelPath: frame?.videoRelPath ?? '',
      timecode: frame?.timecode ?? '',
      frameMs: frame?.frameMs ?? 0,
      note: fb.note,
      annotationCount: fb.annotationCount,
    })
  }

  return {
    schema: MANIFEST_SCHEMA,
    generatedAt: Date.now(),
    generatedAtText: formatLocalTime(Date.now()),
    scope: String(options.scope ?? ''),
    kind: String(options.kind ?? ''),
    summary: {
      total: picked.length,
      returned: items.length,
      byCategory,
      withMask,
      fromVideo,
      totalBytes,
      totalBytesText: formatBytes(totalBytes),
      probedCount: needProbe.length,
    },
    truncated,
    items,
  }
}

/** CSV 的列名（中文，给客户看的）。 */
const CSV_COLUMNS = [
  '序号', '文件名', '相对路径', '分类', '尺寸', '体积',
  '修改时间', '来源对话', '来源视频', '时间码', '遮罩', '备注',
]

/**
 * 序列化成 CSV。
 *
 * **BOM 不能省**：Excel 双击打开 CSV 时不会探测 UTF-8，没有 `EF BB BF`
 * 就按系统 ANSI（中文环境是 GBK）解析，中文全变乱码。
 */
export function manifestToCsv(manifest, options = {}) {
  const items = Array.isArray(manifest?.items) ? manifest.items : []
  const withNotes = options.withNotes === true
  const columns = withNotes ? CSV_COLUMNS : CSV_COLUMNS.slice(0, -1)
  const lines = [columns.join(',')]
  for (const it of items) {
    const size = it.width > 0 && it.height > 0 ? `${it.width}×${it.height}` : ''
    const cells = [
      it.index, it.name, it.relPath, it.categoryText, size, it.bytesText,
      it.mtimeText, it.sessionTitle, it.videoName, it.timecode,
      it.maskPath === '' ? '' : '有',
    ]
    if (withNotes) cells.push(it.note)
    lines.push(cells.map(csvCell).join(','))
  }
  // 行尾用 CRLF：RFC 4180 的要求，也是 Excel 最保险的形态
  return `\ufeff${lines.join('\r\n')}\r\n`
}

/** 序列化成 JSON。**不加 BOM** —— 加了 JSON.parse 会直接拒收。 */
export function manifestToJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * 生成落盘文件名（不含扩展名）：`交付清单_20261125-1043_定稿_8张`。
 * 只保留 Windows 允许的字符；分类用中文名，客户一眼能看懂。
 */
export function manifestFileBase(manifest, options = {}) {
  const at = Number(manifest?.generatedAt) || Date.now()
  const d = new Date(at)
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `-${pad2(d.getHours())}${pad2(d.getMinutes())}`
  const cats = Array.isArray(options.categories) ? options.categories : []
  let catText = '全部'
  if (cats.length === 1) catText = CATEGORY_TEXT[cats[0]] ?? '全部'
  else if (cats.length > 1 && cats.length < 4) catText = cats.map((c) => CATEGORY_TEXT[c] ?? c).join('+')
  const count = Array.isArray(manifest?.items) ? manifest.items.length : 0
  const raw = `交付清单_${stamp}_${catText}_${count}张`
  return raw.replace(/[\\/:*?"<>|\r\n]/g, '_')
}
