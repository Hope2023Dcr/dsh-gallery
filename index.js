/**
 * 产出画廊 —— Host 半部。
 *
 * 负责三件事：
 *  1. 解析「产出根目录」：运行时配置 > YAML 配置 > 自动探测（三级优先，见 resolveOptions）；
 *  2. 扫描根目录下最近 N 小时的图片 / 文件（深度受限、跳过批量目录、有扫描预算）；
 *  3. 通过 /api 的 exact Fetch 路由把「列表」「原始字节」「设置」交给浏览器半部。
 *
 * 缩略图压缩在客户端用 canvas 完成（本文件不生成缩略图，只给原始字节）。
 */
import { promises as fsp, readFileSync, statSync, createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { zstdDecompressSync } from 'node:zlib'
import { buildSessionIndex, clearSessionIndexCache } from './session-index.js'

/** 路由：一个 POST 通道，op 区分 list / raw / reveal / settings。exact Fetch 路由必须以 / 开头。 */
export const ROUTE = '/api/dsh-gallery'

/** 音视频直链（GET）：给 <video>/<audio> 用，支持 Range。 */
export const MEDIA_ROUTE = '/api/dsh-gallery/media'

/** 媒体直链的分块阈值：小于它整块返回，大于它走 Range 分块（避免大视频读满内存）。 */
const STREAM_THRESHOLD = 8 * 1024 * 1024

/** DSH 主目录：优先环境变量，回退 ~/.dsh。 */
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** 会话日志根目录（DSH 主目录下的 sessions）。 */
const DEFAULT_SESSIONS_DIR = path.join(DSH_HOME, 'sessions')

/**
 * 运行时配置文件的默认位置。
 * 用户可在面板内直接改产出根目录，改动写这里；
 * 它的优先级高于 cordis.patch.yml，低于用户显式传入的 root。
 */
const DEFAULT_SETTINGS_FILE = path.join(DSH_HOME, 'dsh-gallery.json')

/**
 * 会话日志里，哪些工具调用的参数算「本对话的产出」。
 *
 * 分三类：
 * 1. **直接写文件**：write / edit / present 等 —— 路径一定是产出。
 * 2. **脚本产出**：Python/命令行脚本跑出来的图，不在 write 调用里，
 *    但 Agent 一定会用 read_image 打开它看效果 —— 所以「看过的图」也算产出。
 *    这是「过程中即时可见」的关键：不然脚本生成的中间图和成品图都看不见。
 * 3. **不看文件**：read / grep / glob 等纯读取，不算产出（避免把别人的文件算进来）。
 */
const OUTPUT_TOOLS = new Set([
  'write',
  'edit',
  'present',
  'dsh_im_return_file',
  'ops_write_file',
  'ops_edit_file',
])

/**
 * 「Agent 看过的图片」也算本对话产出。
 * 只对图片生效（read_image 的参数就是图片路径），风险低：
 * Agent 不会无缘无故打开一张与任务无关的图。
 */
const VIEW_TOOLS = new Set(['read_image'])

/** 只从 VIEW_TOOLS 里接受的图片扩展名。 */
const VIEW_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif', '.tif', '.tiff'])

/**
 * 命令执行类工具。它参数里的路径只作为「弱证据」：
 * 出现在命令文本里 → 该文件是被处理过的，不算「纯输入」。
 */
const BASH_TOOLS = new Set(['ops_bash', 'pwsh', 'bash'])

/** zstd 帧起始魔数（小端 0x28B52FFD）。一个 .zstd 文件可能由多帧拼接而成。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 自动探测产出根目录（当用户既没配 root、也没有运行时配置时使用）。
 *
 * 策略：先找相对用户主目录的常见位置，再遍历可用盘符找 \DSH产出。
 * 关键点：**代码里不出现任何写死的盘符**（是用循环遍历 A-Z 探测），
 * 所以发布到别人机器上不会指向一个必然存在的错误路径，同时又能自动找到
 * 装在其他盘上的产出目录。
 *
 * 探测结果会缓存 —— detectDefaultRoot 在每次请求的 resolveOptions 里都会被调用，
 * 而遍历盘符涉及多次 stat，没必要每次都做。
 */
let defaultRootCache = null

function detectDefaultRoot() {
  if (defaultRootCache !== null) return defaultRootCache

  const home = os.homedir()
  const candidates = [
    // 1. 用户主目录下
    path.join(home, 'DSH产出'),
    path.join(home, 'DSH-outputs'),
    // 2. 文档下
    path.join(home, 'Documents', 'DSH产出'),
    path.join(home, 'Documents', 'DSH-outputs'),
    // 3. 桌面下
    path.join(home, 'Desktop', 'DSH产出'),
    // 4. 下载目录下
    path.join(home, 'Downloads', 'DSH产出'),
  ]

  // 5. 遍历可用盘符（Windows）：C:\DSH产出、D:\DSH产出 …… 不写死任何字母
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {   // C(67) → Z(90)
      const drive = String.fromCharCode(code) + ':'
      candidates.push(path.join(drive + path.sep, 'DSH产出'))
    }
  }

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) {
        defaultRootCache = candidate
        return candidate
      }
    } catch {
      // 不存在就试下一个
    }
  }

  // 全都不存在：返回第一个候选，让面板显示「目录不存在」并给出修改入口
  defaultRootCache = candidates[0]
  return defaultRootCache
}

/** 视频扩展名（与 DEFAULTS.mediaExtensions 里的音频部分相对）。 */
const VIDEO_EXTS = new Set([
  '.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv',
])

const DEFAULTS = {
  // 扫描时间窗口（小时）。默认一年：全局资产要能覆盖历史对话，
  // 否则「按对话分组」看不到旧成果。24 小时会把历史全滤掉。
  windowHours: 24 * 365,
  maxItems: 60,
  maxDepth: 3,
  extensions: ['.png', '.jpg', '.jpeg', '.webp'],
  /**
   * 音视频画廊（v0.10.1）：视频 + 音频，独立一个 kind。
   * 用浏览器原生 <video>/<audio> 播放，不引入 ffmpeg 等后端转码，保持零依赖。
   * 体积大的片子先不进列表（见 maxMediaBytes），避免一次性拉几十 MB 把面板卡死。
   */
  mediaExtensions: [
    // 视频
    '.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv',
    // 音频
    '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wma',
  ],
  /** 单个音视频文件的大小上限（字节）。超过就不列，避免加载卡顿。 */
  maxMediaBytes: 200 * 1024 * 1024,
  /**
   * 文件画廊：只放「产出文件」——文档、代码、数据、压缩包、链接。
   * 不收任何图片格式（图片归图片画廊），也不收音视频（音视频有独立画廊）。
   */
  fileExtensions: [
    '.md', '.markdown', '.txt', '.log',
    '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.xml', '.toml',
    '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.rtf', '.odt',
    '.html', '.htm', '.mht',
    '.zip', '.7z', '.rar', '.tar', '.gz',
    '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.ps1', '.sh', '.bat', '.cmd', '.sql', '.ipynb',
    '.url', '.lnk', '.webloc',
    '.dxf', '.dwg', '.skp', '.3dm',
  ],
  skipDirs: [
    'library_merged',
    'node_modules',
    '.git',
    '.svn',
    '$RECYCLE.BIN',
    'System Volume Information',
    '__pycache__',
    '.venv',
    'venv',
    '.cache',
  ],
  maxDirectories: 4000,
  maxEntries: 60000,
  maxImageBytes: 64 * 1024 * 1024,
}

/** 读取运行时配置文件（<DSH_HOME>/dsh-gallery.json）；不存在或损坏返回空对象。 */
function readSettingsFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 读取「已隐藏」的相对路径集合。
 * 隐藏只记录路径，不移动/删除文件；列表扫描时按此过滤。
 * @param settingsFile - 配置文件路径。
 * @returns 规范化（正斜杠）后的相对路径数组。
 */
async function readHiddenList(settingsFile) {
  const stored = readSettingsFile(settingsFile)
  if (!Array.isArray(stored.hidden)) return []
  return stored.hidden
    .filter((p) => typeof p === 'string' && p !== '')
    .map((p) => p.replace(/\\/g, '/'))
}

/**
 * 解析最终配置。扫描目录（roots）的优先级（高 → 低）：
 *   1. 运行时配置文件的 roots 数组（面板内可加多个目录）
 *   2. 运行时配置文件的 root（旧版单目录写法，兼容保留）
 *   3. cordis.patch.yml 里配的 root / roots
 *   4. 自动探测（detectDefaultRoot）
 *
 * 为什么支持多目录：DSH 一个会话一个 cwd，产出可能写在任意工作区下
 * （例如 G:\DSH任务文件\xxx），不一定落在 G:\DSH产出。只配一个目录必然漏。
 */
function resolveOptions(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  const settingsFile = String(merged.settingsFile ?? DEFAULT_SETTINGS_FILE)
  const stored = readSettingsFile(settingsFile)

  // 收集所有候选目录
  const collected = []
  const pushRoot = (value) => {
    if (typeof value === 'string' && value.trim() !== '') collected.push(value.trim())
  }
  const pushList = (value) => {
    if (Array.isArray(value)) for (const v of value) pushRoot(v)
  }

  pushList(stored.roots)   // 1. 设置里的多目录
  pushRoot(stored.root)    // 2. 设置里的单目录（旧格式）
  pushList(merged.roots)   // 3. YAML 多目录
  pushRoot(merged.root)    // 4. YAML 单目录

  // 去重（Windows 路径大小写不敏感）
  const deduped = []
  const seenRoots = new Set()
  const candidates = collected.length > 0 ? collected : [detectDefaultRoot()]
  for (const r of candidates) {
    const abs = path.resolve(r)
    const key = abs.toLowerCase()
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    deduped.push(abs)
  }

  const resolvedRoots = deduped.length > 0 ? deduped : [path.resolve(detectDefaultRoot())]
  const rootSource = collected.length === 0
    ? 'auto-detect'
    : (typeof stored.root === 'string' || (Array.isArray(stored.roots) && stored.roots.length > 0) ? 'settings' : 'config')

  return {
    root: resolvedRoots[0],
    roots: resolvedRoots,
    rootSource,
    settingsFile,
    windowHours: numberOr(merged.windowHours, DEFAULTS.windowHours, 1, 24 * 366),
    maxItems: numberOr(merged.maxItems, DEFAULTS.maxItems, 1, 500),
    maxDepth: numberOr(merged.maxDepth, DEFAULTS.maxDepth, 0, 8),
    extensions: arrayOfStrings(merged.extensions, DEFAULTS.extensions).map((e) => e.toLowerCase()),
    fileExtensions: arrayOfStrings(merged.fileExtensions, DEFAULTS.fileExtensions).map((e) => e.toLowerCase()),
    mediaExtensions: arrayOfStrings(merged.mediaExtensions, DEFAULTS.mediaExtensions).map((e) => e.toLowerCase()),
    skipDirs: arrayOfStrings(merged.skipDirs, DEFAULTS.skipDirs).map((e) => e.toLowerCase()),
    maxDirectories: numberOr(merged.maxDirectories, DEFAULTS.maxDirectories, 1, 200000),
    maxEntries: numberOr(merged.maxEntries, DEFAULTS.maxEntries, 1, 1000000),
    maxImageBytes: numberOr(merged.maxImageBytes, DEFAULTS.maxImageBytes, 1, 512 * 1024 * 1024),
    maxMediaBytes: numberOr(merged.maxMediaBytes, DEFAULTS.maxMediaBytes, 1, 1024 * 1024 * 1024),
  }
}

function numberOr(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

function arrayOfStrings(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const cleaned = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
  return cleaned.length > 0 ? cleaned : [...fallback]
}

/** Windows 路径比较统一小写；用于「必须在根目录内」的判定。 */
function isInside(root, target) {
  const a = root.toLowerCase().replace(/[\\/]+$/, '')
  const b = target.toLowerCase().replace(/[\\/]+$/, '')
  return b === a || b.startsWith(a + '\\') || b.startsWith(a + '/')
}

/** 只读图片头部若干字节，用于解析尺寸；失败返回 null。 */
async function readHead(fullPath, byteLimit) {
  let handle
  try {
    handle = await fsp.open(fullPath, 'r')
    const size = (await handle.stat()).size
    const want = Math.min(byteLimit, size)
    const buffer = Buffer.alloc(want)
    const { bytesRead } = await handle.read(buffer, 0, want, 0)
    return buffer.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

/** PNG：IHDR 在固定偏移。 */
function pngSize(buf) {
  if (buf.length < 24) return null
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** JPEG：顺序找 SOF 段。 */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let p = 2
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) {
      p += 1
      continue
    }
    let marker = buf[p + 1]
    while (marker === 0xff && p + 1 < buf.length) {
      p += 1
      marker = buf[p + 1]
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = buf.readUInt16BE(p + 2)
    if (length < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = buf.readUInt16BE(p + 5)
      const width = buf.readUInt16BE(p + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    p += 2 + length
  }
  return null
}

/** WebP：RIFF 容器，VP8 / VP8L / VP8X 三种尺寸布局。 */
function webpSize(buf) {
  if (buf.length < 32) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') {
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8L') {
    const b0 = buf[21]
    const b1 = buf[22]
    const b2 = buf[23]
    const b3 = buf[24]
    const width = 1 + (((b0 & 0xff) | ((b1 & 0x3f) << 8)) & 0x3fff)
    const height = 1 + ((((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) & 0x3fff)
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8X') {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
    return width > 0 && height > 0 ? { width, height } : null
  }
  return null
}

/** 按扩展名挑选解析器；返回 {width,height} 或 null。 */
function measureImage(buf, ext) {
  try {
    if (buf === null) return null
    if (ext === '.png') return pngSize(buf)
    if (ext === '.jpg' || ext === '.jpeg') return jpegSize(buf)
    if (ext === '.webp') return webpSize(buf)
    return pngSize(buf) ?? jpegSize(buf) ?? webpSize(buf)
  } catch {
    return null
  }
}

/**
 * 校验用户想设的产出根目录：必须是绝对路径、必须存在、必须是目录。
 * @param candidate - 用户输入的路径。
 * @returns { ok, root?, reason? } —— 通过时 root 是规范化后的绝对路径。
 */
export async function validateRootCandidate(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, reason: 'empty' }
  }
  const raw = candidate.trim()
  // 只接受绝对路径（盘符或 UNC），相对路径无法确定含义
  if (!path.isAbsolute(raw)) return { ok: false, reason: 'not-absolute' }
  const resolved = path.resolve(raw)
  try {
    const st = await fsp.stat(resolved)
    if (!st.isDirectory()) return { ok: false, reason: 'not-directory' }
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  return { ok: true, root: resolved }
}

/**
 * 把设置写进运行时配置文件。
 * 只覆盖传入的字段，其余保留——避免把 windowHours 之类顺手清掉。
 * @param settingsFile - 配置文件路径。
 * @param patch - 要合并进去的部分设置。
 */
export async function writeSettingsFile(settingsFile, patch) {
  const current = readSettingsFile(settingsFile)
  const next = { ...current, ...patch }
  await fsp.mkdir(path.dirname(settingsFile), { recursive: true })
  await fsp.writeFile(settingsFile, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * 返回设置面板需要的全部信息。
 * @param config - 插件配置。
 */
async function readSettingsPayload(config) {
  const opts = resolveOptions(config)
  // 逐个检查每个 root 是否存在
  const rootsInfo = []
  for (const r of opts.roots) {
    let exists = false
    try {
      exists = (await fsp.stat(r)).isDirectory()
    } catch {
      exists = false
    }
    rootsInfo.push({ path: r, exists })
  }
  const exists = rootsInfo.length > 0 ? rootsInfo[0].exists : false
  // 已隐藏条数：供设置面板显示「已隐藏 N 个 · 全部恢复」
  const hidden = await readHiddenList(opts.settingsFile)
  return {
    root: opts.root,
    roots: opts.roots,
    rootsInfo,
    rootSource: opts.rootSource,
    rootExists: exists,
    settingsFile: opts.settingsFile,
    windowHours: opts.windowHours,
    maxItems: opts.maxItems,
    maxDepth: opts.maxDepth,
    hiddenCount: hidden.length,
    // 前若干条隐藏项，供面板预览（不返回全部，避免配置很大时拖慢）
    hiddenSample: hidden.slice(0, 10),
    defaults: {
      // 给前端「恢复默认」用：自动探测的结果
      root: path.resolve(detectDefaultRoot()),
    },
    home: os.homedir(),
    platform: process.platform,
  }
}

/**
 * 会话日志解压结果的缓存。
 * 自动刷新每 5 秒一次，而一个活跃会话的日志解压后有 9MB 以上；
 * 用「路径 + mtime + size」做键，日志没变就复用上次的解析结果。
 */
const sessionLogCache = new Map()

/**
 * 解压一个会话日志。
 * DSH 的 session.v4.jsonl.zstd 是「多帧 zstd 拼接」（每次追加写一帧），
 * 单次 zstdDecompressSync 只能解第一帧，所以必须按魔数切开逐帧解。
 * @param fullPath - 日志文件绝对路径。
 * @returns 解压后的完整文本；失败返回空串。
 */
async function readSessionLogText(fullPath) {
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
async function locateSessionDir(sessionsDir, sessionId) {
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
async function findSubSessionLogs(sessionsDir, parentSessionId) {
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
async function readSessionLogHead(fullPath) {
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
function collectAbsolutePaths(node, sink) {
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
const ASSET_CATEGORY = {
  INPUT: 'input',
  INTERMEDIATE: 'intermediate',
  FINAL: 'final',
  UNKNOWN: 'unknown',
}

/** 中文/英文标签映射（客户端也可自行翻译，这里只给分类值）。 */
const CATEGORY_ORDER = ['final', 'input', 'intermediate']

/**
 * 从会话日志里读出「本对话产出过的绝对路径 + 分类」。
 *
 * 覆盖两类来源：
 * 1. `write` / `edit` / `present` 等直接写文件的调用 —— 路径必是产出。
 * 2. `read_image` 打开过的图片 —— 脚本（Python 等）生成的图不在 write 调用里，
 *    但 Agent 一定会打开看效果。不纳入这一条，「过程中生成的图」在
 *    「当前对话」里就完全看不见（只有全局资产能看到）。
 *
 * @param logText - 解压后的日志文本（每行一个 JSON）。
 * @param sessionStartMs - 本会话开始时间（毫秒时间戳）。
 *   用于区分「用户提供的素材」和「会话期间生成的产物」：
 *   前者必定早于会话开始就存在。传 0 表示拿不到，此时不做输入判定。
 * @returns Map<绝对路径, { category, presented, written, viewed, bashMentioned }>
 */
function extractAssetInfo(logText, sessionStartMs = 0) {
  const assets = new Map()
  if (typeof logText !== 'string' || logText === '') return assets

  const ensure = (abs) => {
    if (!assets.has(abs)) {
      assets.set(abs, { presented: false, written: false, viewed: false, bashMentioned: false })
    }
    return assets.get(abs)
  }

  for (const line of logText.split('\n')) {
    if (line === '') continue
    // 快速预筛：只处理含 tool/call 的行，避免全量 JSON.parse
    if (!line.includes('tool/call')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.type !== 'tool/call') continue
    const name = record?.data?.name
    if (typeof name !== 'string') continue

    const rawArgs = record?.data?.arguments
    if (typeof rawArgs !== 'string') continue
    let args
    try {
      args = JSON.parse(rawArgs)
    } catch {
      continue
    }

    // ---- bash / pwsh：命令文本里提到的路径，只作为「非输入」的弱证据 ----
    if (BASH_TOOLS.has(name)) {
      const cmdText = `${args?.command ?? ''} ${args?.script_path ?? ''}`
      const re = /[A-Za-z]:[\\/][^\s"'|&;<>()*?]+/g
      for (const m of cmdText.matchAll(re)) {
        const candidate = m[0].replace(/[\\/]+$/, '')
        const ext = path.extname(candidate).toLowerCase()
        // 只接受看起来像文件的路径（有扩展名）
        if (ext === '') continue
        try {
          const info = ensure(path.resolve(candidate))
          info.bashMentioned = true
        } catch {
          // 解析失败就跳过
        }
      }
      continue
    }

    const isWriter = OUTPUT_TOOLS.has(name)
    const isViewer = VIEW_TOOLS.has(name)
    const isPresenter = name === 'present'
    if (!isWriter && !isViewer && !isPresenter) continue

    // present 的参数结构是 { files: [{ path, description }]}
    let found = []
    if (isPresenter && Array.isArray(args?.files)) {
      found = args.files.map((f) => f?.path).filter((p) => typeof p === 'string')
    } else {
      collectAbsolutePaths(args, found)
    }

    for (const entry of found) {
      if (isViewer) {
        // 查看类工具只认图片：避免把 read_image 参数里偶尔出现的
        // 目录、配置等非图片路径当成产出
        const ext = path.extname(entry).toLowerCase()
        if (!VIEW_IMAGE_EXTS.has(ext)) continue
      }
      const info = ensure(path.resolve(entry))
      if (isPresenter) info.presented = true
      else if (isViewer) info.viewed = true
      else info.written = true
    }
  }

  // ---- 归类 ----
  for (const [abs, info] of assets) {
    classifyAsset(abs, info, sessionStartMs)
  }

  return assets
}

/**
 * 从会话日志首行解析会话开始时间（createdAt）。
 * @param logText - 解压后的日志文本。
 * @returns 毫秒时间戳；解析失败返回 0。
 */
function parseSessionStartMs(logText) {
  if (typeof logText !== 'string' || logText === '') return 0
  const firstLine = logText.split('\n')[0]
  try {
    const first = JSON.parse(firstLine)
    return typeof first?.createdAt === 'number' ? first.createdAt : 0
  } catch {
    return 0
  }
}

/**
 * 给单个资产定分类。**唯一**的分类入口，别在别处复制这套判据。
 *
 * 规则（按优先级）：
 *   1. present 过 → 最终
 *   2. 「只被 read_image 看过」是候选输入，但必须能证明它早于会话开始就存在：
 *      - mtime < 会话开始 → 输入（用户预先提供的素材）
 *      - mtime >= 会话开始 → 中间（会话期间生成的，脚本产出常见这种）
 *   3. 其余 → 中间
 *
 * 为什么必须看时间：「被 read_image 看过」既可能是用户素材，也可能是脚本产出的图，
 * Agent 两者都会打开看。实测反例：
 *   - architecture.png：write 写的是脚本，file_path 不是它，只在 read_image 出现
 *   - 缩略图尺寸对比.png：文件名写在 bash 的 python 代码里，不是绝对路径
 * 这两类旧判据都会误判成「输入」。
 *
 * @param abs - 文件绝对路径。
 * @param info - extractAssetInfo 收集到的动作标记（会被写入 category）。
 * @param sessionStartMs - 会话开始时间；0 表示未知（此时不做输入判定）。
 */
function classifyAsset(abs, info, sessionStartMs) {
  info.path = abs

  if (info.presented) {
    info.category = ASSET_CATEGORY.FINAL
    return
  }

  const looksLikeInput = info.viewed === true && info.written !== true && info.bashMentioned !== true
  if (!looksLikeInput) {
    info.category = ASSET_CATEGORY.INTERMEDIATE
    return
  }

  let mtimeMs = null
  try {
    mtimeMs = statSync(abs).mtimeMs
  } catch {
    mtimeMs = null
  }

  if (mtimeMs !== null && sessionStartMs > 0 && mtimeMs < sessionStartMs) {
    info.category = ASSET_CATEGORY.INPUT
  } else {
    // 会话开始后才出现（或文件已不存在）→ 归中间，不冒充用户素材
    info.category = ASSET_CATEGORY.INTERMEDIATE
  }
}

/**
 * 从会话日志里读出「本对话产出过的绝对路径」。
 * @param logText - 解压后的日志文本（每行一个 JSON）。
 * @returns 绝对路径的 Set。
 */
function extractOutputPaths(logText) {
  return new Set(extractAssetInfo(logText).keys())
}

/**
 * 算出「本对话」产出过的路径与任务目录。
 *
 * 支持多扫描目录（roots）：逐个判断路径落在哪个 root 下。
 * 修法 B：文件**直接躺在 root 根目录下**（没有子目录）时也要能匹配，
 * 原实现只取「第一层目录」并要求至少两段，导致根目录文件全部判为 0。
 *
 * @param config - 用户配置。
 * @param sessionId - 当前会话 id。
 * @param allRoots - 已解析的扫描目录列表（不传则内部再解析一次）。
 * @returns { ok, reason, taskDirs, paths, relPaths }
 */
async function resolveSessionScope(config, sessionId, allRoots) {
  const opts = resolveOptions(config)
  const roots = Array.isArray(allRoots) && allRoots.length > 0 ? allRoots : opts.roots
  const sessionsDir = typeof config?.sessionsDir === 'string' && config.sessionsDir !== ''
    ? path.resolve(config.sessionsDir)
    : DEFAULT_SESSIONS_DIR
  const sessionDir = await locateSessionDir(sessionsDir, sessionId)
  if (sessionDir === null) {
    return { ok: false, reason: 'session-not-found', taskDirs: [], paths: [], relPaths: [], subSessions: 0 }
  }
  const logPath = path.join(sessionDir, 'session.v4.jsonl.zstd')
  const logText = await readSessionLogText(logPath)
  if (logText === '') {
    return { ok: false, reason: 'log-empty', taskDirs: [], paths: [], relPaths: [], subSessions: 0 }
  }
  // 会话开始时间：用于区分「用户素材」与「会话期间产出」
  const sessionStartMs = parseSessionStartMs(logText)
  const allAssets = extractAssetInfo(logText, sessionStartMs)

  // 修法 C：合并所有子会话（子智能体）的产出路径
  const subLogs = await findSubSessionLogs(sessionsDir, sessionId)
  for (const subLog of subLogs) {
    const subText = await readSessionLogText(subLog)
    if (subText === '') continue
    for (const [abs, info] of extractAssetInfo(subText, sessionStartMs)) {
      const existing = allAssets.get(abs)
      if (existing) {
        // 合并标记：任一处 present 就算最终
        existing.presented = existing.presented || info.presented
        existing.written = existing.written || info.written
        existing.viewed = existing.viewed || info.viewed
        existing.bashMentioned = existing.bashMentioned || info.bashMentioned
      } else {
        allAssets.set(abs, info)
      }
    }
  }

  // 合并后重新归类（因为 presented/written 可能变了）。
  // 统一走 classifyAsset，避免两处判据分叉 —— v0.8.1 就是这里漏改导致分类不准。
  for (const [abs, info] of allAssets) {
    classifyAsset(abs, info, sessionStartMs)
  }

  const normalized = []
  const relPaths = []
  const taskDirs = new Set()
  // relPath(小写) → 分类，供扫描时标注
  const categoryByRel = new Map()

  for (const [abs, info] of allAssets) {
    const absolute = path.resolve(abs)
    // 找出该路径属于哪个 root
    let ownerRoot = null
    for (const r of roots) {
      if (isInside(r, absolute)) { ownerRoot = r; break }
    }
    if (ownerRoot === null) continue
    normalized.push(absolute)

    const rel = path.relative(ownerRoot, absolute)
    const segs = rel.split(path.sep).filter((s) => s !== '')
    const relPath = rel.split(path.sep).join('/')
    relPaths.push(relPath)
    categoryByRel.set(relPath.toLowerCase(), info.category)
    // 修法 B：有子目录时取第一层；没有子目录（文件直接在 root 下）时，
    // 用空字符串占位，表示「只在根目录层匹配」，不再直接丢弃
    if (segs.length >= 2) taskDirs.add(segs[0])
  }

  return {
    ok: true,
    reason: 'ok',
    taskDirs: [...taskDirs],
    paths: normalized,
    relPaths,
    categoryByRel,
    subSessions: subLogs.length,
  }
}

/**
 * 扫描画廊候选：广度优先、深度受限、跳过批量目录、有目录/条目预算。
 * 结果按修改时间倒序，只回传 maxItems 条，另外给出 total 供「还有 N 张」。
 */
export async function scanGallery(config, kind = 'image', scope = 'global', sessionId = '', page = 1) {
  const opts = resolveOptions(config)
  const now = Date.now()
  const cutoff = now - opts.windowHours * 3600_000
  const isFile = kind === 'file'
  const isMedia = kind === 'media'
  const isSession = scope === 'session'
  // 页码从 1 开始；非法值一律回到第 1 页
  const currentPage = Math.max(1, Math.trunc(Number(page) || 1))
  // 图片格式永远排除在文件画廊之外；防止用户配置误把图片塞进来
  const extraImageEx = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.avif', '.ico'])
  // 音视频同样不能混进文件画廊（v0.10.1）：音视频有自己的画廊
  const mediaEx = new Set(opts.mediaExtensions)
  let rawExts
  if (isFile) rawExts = opts.fileExtensions
  else if (isMedia) rawExts = opts.mediaExtensions
  else rawExts = opts.extensions
  const extSet = new Set(rawExts.filter((e) => !(
    (isFile && extraImageEx.has(e))
    || (isFile && mediaEx.has(e))
    || (isMedia && extraImageEx.has(e))
  )))
  const skipSet = new Set(opts.skipDirs)

  // 当前对话范围：先解析会话日志（含子智能体会话），得到「本对话产出过的路径」
  let scopeInfo = { ok: true, reason: 'global', taskDirs: [], paths: [], relPaths: [], subSessions: 0 }
  let sessionRelSet = null
  if (isSession) {
    scopeInfo = await resolveSessionScope(config, sessionId, opts.roots)
    // 修法 B：用「精确相对路径」集合判定，而不是只靠第一层目录名。
    // 这样既能处理有子目录的情况，也能处理「文件直接躺在 root 根目录下」。
    sessionRelSet = new Set((scopeInfo.relPaths ?? []).map((p) => p.toLowerCase()))
  }

  // 会话索引：建立「文件 → 所属对话 + 分类」的映射，供全局按对话分组用
  const sessionsDir = typeof config?.sessionsDir === 'string' && config.sessionsDir !== ''
    ? path.resolve(config.sessionsDir)
    : DEFAULT_SESSIONS_DIR
  let sessionIndex = null
  // 全局模式才需要索引（当前对话模式已有自己的 scopeInfo）
  if (!isSession) {
    sessionIndex = await buildSessionIndex(sessionsDir, opts, {
      readSessionLogText,
      extractAssetInfo,
    })
  }

  // 文件绝对路径 → { sessionId, title, category }
  const ownerByAbs = new Map()
  if (sessionIndex !== null) {
    for (const [sid, entry] of sessionIndex) {
      for (const [abs, cat] of entry.files) {
        // 同一个文件被多个对话产出时，取最近的那个对话
        const prev = ownerByAbs.get(abs)
        if (prev === undefined || entry.createdAt > prev.createdAt) {
          ownerByAbs.set(abs, {
            sessionId: sid,
            title: entry.title || '',
            createdAt: entry.createdAt,
            category: cat,
          })
        }
      }
    }
  }

  // 已隐藏的路径：扫描时直接跳过（不移动文件，只从列表里拿掉）
  const hiddenSet = new Set(await readHiddenList(opts.settingsFile))

  const matches = []
  let directories = 0
  let entries = 0
  let capped = false
  let anyRootExists = false
  const missingRoots = []

  // 遍历所有扫描目录（多目录支持）
  for (const rootDir of opts.roots) {
    if (directories >= opts.maxDirectories || entries >= opts.maxEntries) {
      capped = true
      break
    }
    let rootOk = false
    try {
      const st = await fsp.stat(rootDir)
      rootOk = st.isDirectory()
    } catch {
      rootOk = false
    }
    if (!rootOk) {
      missingRoots.push(rootDir)
      continue
    }
    anyRootExists = true

    const dirQueue = [{ dir: rootDir, depth: 0 }]
    while (dirQueue.length > 0) {
      if (directories >= opts.maxDirectories || entries >= opts.maxEntries) {
        capped = true
        break
      }
      const { dir, depth } = dirQueue.shift()
      directories += 1
      let dirents
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirent of dirents) {
        entries += 1
        if (entries >= opts.maxEntries) {
          capped = true
          break
        }
        const entryName = String(dirent.name)
        const fullPath = path.join(dir, entryName)
        if (dirent.isDirectory()) {
          if (depth + 1 > opts.maxDepth) continue
          if (skipSet.has(entryName.toLowerCase())) continue
          dirQueue.push({ dir: fullPath, depth: depth + 1 })
          continue
        }
        if (!dirent.isFile()) continue
        const ext = path.extname(entryName).toLowerCase()
        if (!extSet.has(ext)) continue
        // 当前对话范围：按精确相对路径判定（支持根目录文件与多层子目录）
        const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/')
        if (sessionRelSet !== null && !sessionRelSet.has(relPath.toLowerCase())) continue
        let stat
        try {
          stat = await fsp.stat(fullPath)
        } catch {
          continue
        }
        if (stat.size <= 0 || stat.mtimeMs < cutoff) continue
        // 音视频：超过体积上限的直接跳过（视频可能几百 MB，列出来点开就卡）
        if (isMedia && stat.size > opts.maxMediaBytes) continue
        // 被隐藏的直接跳过（隐藏只影响列表展示，文件仍在磁盘上）
        if (hiddenSet.has(relPath)) continue
        matches.push({
          relPath,
          relKey: `${opts.roots.indexOf(rootDir)}:${relPath}`,
          rootDir,
          rootIndex: opts.roots.indexOf(rootDir),
          name: entryName,
          size: stat.size,
          mtime: stat.mtimeMs,
          extension: ext,
          // 音视频区分「视频 / 音频」，客户端据此选 <video> 还是 <audio>
          ...(isMedia ? { mediaType: VIDEO_EXTS.has(ext) ? 'video' : 'audio' } : {}),
        })
      }
    }
  }

  const rootMissing = !anyRootExists

  // 给每个条目附加「分类」和「所属对话」
  for (const item of matches) {
    const abs = path.join(item.rootDir, ...item.relPath.split('/'))
    const owner = ownerByAbs.get(abs)
    item.absPath = abs
    if (isSession) {
      item.category = (scopeInfo.categoryByRel?.get(item.relPath.toLowerCase())) ?? null
      item.sessionId = sessionId
    } else if (owner !== undefined) {
      item.category = owner.category
      item.sessionId = owner.sessionId
      item.sessionTitle = owner.title
      item.sessionCreatedAt = owner.createdAt
    } else {
      // 不属于任何已知对话的文件：归到「历史资产」，分类记为**未归类**
      // 不能兜底成 input —— 那会把 4995 个历史文件全标成「输入」
      item.category = ASSET_CATEGORY.UNKNOWN
      item.sessionId = null
    }
  }

  matches.sort((a, b) => b.mtime - a.mtime)
  const total = matches.length
  // 分页：每页 maxItems 条，保留 total 供页码条使用
  // 全局分组模式下不分页（客户端自己分组折叠），所有条目都返回摘要
  const pageCount = isSession
    ? Math.max(1, Math.ceil(total / opts.maxItems))
    : Math.max(1, Math.ceil(total / opts.maxItems))
  const safePage = Math.min(currentPage, pageCount)
  const offset = (safePage - 1) * opts.maxItems
  const visible = matches.slice(offset, offset + opts.maxItems)

  await Promise.all(visible.map(async (item) => {
    if (isFile || isMedia) {
      // 文件/音视频画廊不解析图片尺寸
      item.width = null
      item.height = null
      return
    }
    // 多目录：用该条目自己所属的 rootDir 拼绝对路径
    const measured = measureImage(
      await readHead(path.join(item.rootDir, ...item.relPath.split('/')), 65536),
      item.extension,
    )
    item.width = measured?.width ?? null
    item.height = measured?.height ?? null
  }))

  // 全量统计：供「全局按对话分组」使用（不受分页限制）
  const allItemsSummary = []
  if (!isSession) {
    for (const item of matches) {
      allItemsSummary.push({
        absPath: item.absPath,
        relPath: item.relPath,
        sessionId: item.sessionId,
        sessionTitle: item.sessionTitle ?? '',
        sessionCreatedAt: item.sessionCreatedAt ?? 0,
        category: item.category,
        mtime: item.mtime,
        width: item.width ?? null,
        height: item.height ?? null,
        size: item.size,
        name: item.name,
        extension: item.extension,
        // 音视频类型（video / audio），客户端据此选 <video> 还是 <audio>
        ...(item.mediaType !== undefined ? { mediaType: item.mediaType } : {}),
      })
    }
  }

  return {
    kind,
    scope: isSession ? 'session' : 'global',
    scopeInfo: {
      ok: scopeInfo.ok,
      reason: scopeInfo.reason,
      taskDirs: scopeInfo.taskDirs.length,
      paths: scopeInfo.paths.length,
      relPaths: (scopeInfo.relPaths ?? []).length,
      // 子智能体会话数：> 0 表示已纳入它们的产出
      subSessions: scopeInfo.subSessions ?? 0,
    },
    root: opts.root,
    roots: opts.roots,
    rootSource: opts.rootSource,
    missingRoots,
    windowHours: opts.windowHours,
    maxItems: opts.maxItems,
    maxDepth: opts.maxDepth,
    generatedAt: now,
    items: visible,
    total,
    // 分页信息，客户端据此渲染页码条
    page: safePage,
    pageCount,
    pageSize: opts.maxItems,
    // 「还有 N 张」= 当前页之外的总数（不再只是「被截掉的」）
    hidden: Math.max(0, total - visible.length),
    rootMissing,
    scan: { directories, entries, capped },
    // 全局模式额外返回：按对话分组的数据（客户端做折叠展示用）
    groups: isSession ? null : buildGroups(allItemsSummary, 120, sessionId),
  }
}

/**
 * 把扁平的资产列表按「所属对话」分组。
 *
 * 分组规则：
 *   - 属于某个已知对话的文件 → 归到该对话（标题用会话标题）
 *   - 其余（日志里查不到归属的历史文件）→ 统一归到「历史资产」组
 *
 * 排序（v0.8.2 调整）：
 *   1. **当前对话永远置顶** —— 用户打开「全局资产」最想先看自己这次做了什么，
 *      按时间倒序会把它压到中间（当前对话可能很早创建、但一直在用）。
 *   2. 其余对话按创建时间倒序。
 *   3. 「历史资产」永远最后。
 *
 * ⚠️ 体积控制：每组只返回前 maxPerGroup 条明细 + 完整总数。
 * 为什么必须截断：历史组有 4995 个文件，全量返回会让单次响应达到 1.3 MB，
 * 前端解析/渲染都会卡，面板看起来「只显示两组」。
 *
 * @param summary - 扁平资产摘要数组。
 * @param maxPerGroup - 每组最多返回多少条明细（默认 120）。
 * @param currentSessionId - 当前打开的会话 id；匹配到的组会标记 isCurrent 并置顶。
 * @returns 分组数组。
 */
function buildGroups(summary, maxPerGroup = 120, currentSessionId = '') {
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
    out.push({
      sessionId: g.sessionId,
      isHistory: g.sessionId === null,
      // 当前打开的会话：客户端据此置顶并默认展开
      isCurrent: currentSessionId !== '' && g.sessionId === currentSessionId,
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
async function resolveReadable(roots, relPath, opts, byteCap) {
  const list = Array.isArray(roots) ? roots : [roots]
  if (typeof relPath !== 'string' || relPath === '') return null
  const cap = typeof byteCap === 'number' && byteCap > 0 ? byteCap : opts.maxImageBytes
  const normalized = relPath.replace(/\\/g, '/')
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) return null
  for (const root of list) {
    const absolute = path.resolve(root, ...normalized.split('/'))
    if (!isInside(root, absolute)) continue
    try {
      const stat = await fsp.stat(absolute)
      if (!stat.isFile() || stat.size <= 0 || stat.size > cap) continue
      return { absolute, stat, root }
    } catch {
      // 换下一个 root
    }
  }
  return null
}

function contentTypeFor(ext) {
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  // 音视频（v0.10.1）：让浏览器 <video>/<audio> 能直接解码
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.ogv') return 'video/ogg'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.mkv') return 'video/x-matroska'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a' || ext === '.aac') return 'audio/mp4'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg'
  if (ext === '.opus') return 'audio/opus'
  return 'application/octet-stream'
}

/** 统一 JSON 响应。 */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Host 插件入口。仅依赖 connection（exact Fetch 路由）；缺失时插件不激活而不是抛错。
 */
export const inject = ['connection']

export function apply(ctx, config) {
  /**
   * 音视频的 GET 直链（v0.10.1）。
   * <video src> / <audio src> 需要一个浏览器能直接请求的 URL：
   * POST 路由不行（媒体元素不会发 POST），所以这里单独注册一个 GET 路径。
   * 支持 Range，浏览器才能拖进度条、边播边下。
   */
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: MEDIA_ROUTE,
        // 必须同时支持 HEAD（与官方 /api/file 一致）：浏览器加载媒体前会先发 HEAD 探测，
        // 只给 GET 会让 <video>/<audio> 直接判定「无法解码」。
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: async (request) => {
          // 媒体直链：GET / HEAD，**只用 200 + 流式**，不用 206。
          //
          // 实测结论（2026-11-08）：
          //  - 小文件（1.1MB, 200 整块）能播；
          //  - 大文件（127MB, 206 Range）报「浏览器无法解码」；
          //  → 说明 DSH 的 exact fetch 层不透传 206 / content-range，或对 Range 响应有兼容问题。
          //  所以统一返回 200 + Content-Length + 流式 body（内存占用恒定，不读满 127MB）。
          const resolved = resolveOptions(config)
          const isHead = request.method === 'HEAD'
          const baseHeaders = {
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            'accept-ranges': 'none',
          }
          let relPath = ''
          try {
            relPath = new URL(request.url).searchParams.get('path') ?? ''
          } catch {
            relPath = ''
          }
          if (relPath === '') {
            return new Response(isHead ? null : 'missing path', { status: 400, headers: baseHeaders })
          }
          // 媒体用 maxMediaBytes（200MB），不是图片的 64MB —— 否则大视频会被判不可读
          const found = await resolveReadable(resolved.roots, relPath, resolved, resolved.maxMediaBytes)
          if (found === null) {
            return new Response(isHead ? null : 'not found', { status: 404, headers: baseHeaders })
          }
          let stat
          try {
            stat = await fsp.stat(found.absolute)
          } catch (error) {
            return new Response(isHead ? null : String(error?.message ?? error), { status: 500, headers: baseHeaders })
          }
          const type = contentTypeFor(path.extname(found.absolute).toLowerCase())
          const totalSize = stat.size
          const headers = {
            ...baseHeaders,
            'content-type': type,
            'content-length': String(totalSize),
          }
          if (isHead) {
            return new Response(null, { status: 200, headers })
          }
          // 流式返回：createReadStream → Readable.toWeb，内存占用与文件大小无关
          try {
            const stream = createReadStream(found.absolute)
            return new Response(Readable.toWeb(stream), { status: 200, headers })
          } catch (error) {
            return new Response(String(error?.message ?? error), { status: 500, headers: baseHeaders })
          }
        },
      }),
    [],
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            body = {}
          }
          const op = typeof body?.op === 'string' ? body.op : ''
          // 每次请求都重新解析配置：这样用户在面板里改 root 后无需重启即生效
          const resolved = resolveOptions(config)

          if (op === 'list') {
            try {
              // 三种画廊：图片 / 文件 / 音视频（v0.10.1）
              const kind = body?.kind === 'file' ? 'file'
                : body?.kind === 'media' ? 'media'
                  : 'image'
              const scope = body?.scope === 'session' ? 'session' : 'global'
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
              return json(await scanGallery(config, kind, scope, sessionId, body?.page))
            } catch (error) {
              return json({ ok: false, error: { code: 'scan-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          // 读取当前设置（含 root 来源、是否存在）
          if (op === 'settings') {
            try {
              return json({ ok: true, settings: await readSettingsPayload(config) })
            } catch (error) {
              return json({ ok: false, error: { code: 'settings-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          // 修改产出根目录（单值，保留兼容）：会覆盖 roots，只留这一个
          if (op === 'setRoot') {
            const candidate = body?.root
            const check = await validateRootCandidate(candidate)
            if (check.ok !== true) {
              const messages = {
                empty: '目录不能为空',
                'not-absolute': '必须是绝对路径，例如 /Users/you/outputs 或 D:\\产出',
                'not-directory': '该路径不是目录',
                'not-found': '目录不存在',
              }
              return json({
                ok: false,
                error: { code: check.reason, message: messages[check.reason] ?? '目录无效' },
              }, 400)
            }
            try {
              const opts = resolveOptions(config)
              // 写 roots 数组，并把旧的单值 root 清掉，避免重复
              const current = readSettingsFile(opts.settingsFile)
              delete current.root
              await fsp.mkdir(path.dirname(opts.settingsFile), { recursive: true })
              await fsp.writeFile(
                opts.settingsFile,
                JSON.stringify({ ...current, roots: [check.root] }, null, 2),
                'utf8',
              )
              return json({ ok: true, settings: await readSettingsPayload(config) })
            } catch (error) {
              return json({ ok: false, error: { code: 'write-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          // 追加一个扫描目录（多目录支持）
          if (op === 'addRoot') {
            const check = await validateRootCandidate(body?.root)
            if (check.ok !== true) {
              const messages = {
                empty: '目录不能为空',
                'not-absolute': '必须是绝对路径',
                'not-directory': '该路径不是目录',
                'not-found': '目录不存在',
              }
              return json({ ok: false, error: { code: check.reason, message: messages[check.reason] ?? '目录无效' } }, 400)
            }
            try {
              const opts = resolveOptions(config)
              const current = readSettingsFile(opts.settingsFile)
              const list = Array.isArray(current.roots) && current.roots.length > 0
                ? current.roots.slice()
                : opts.roots.slice()
              // 去重（大小写不敏感）
              if (!list.some((r) => path.resolve(r).toLowerCase() === check.root.toLowerCase())) {
                list.push(check.root)
              }
              delete current.root
              await fsp.mkdir(path.dirname(opts.settingsFile), { recursive: true })
              await fsp.writeFile(opts.settingsFile, JSON.stringify({ ...current, roots: list }, null, 2), 'utf8')
              return json({ ok: true, settings: await readSettingsPayload(config) })
            } catch (error) {
              return json({ ok: false, error: { code: 'write-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          // 移除一个扫描目录
          if (op === 'removeRoot') {
            const target = typeof body?.root === 'string' ? body.root.trim() : ''
            if (target === '') {
              return json({ ok: false, error: { code: 'empty', message: '缺少要移除的目录' } }, 400)
            }
            try {
              const opts = resolveOptions(config)
              const current = readSettingsFile(opts.settingsFile)
              const list = (Array.isArray(current.roots) && current.roots.length > 0
                ? current.roots.slice()
                : opts.roots.slice()
              ).filter((r) => path.resolve(r).toLowerCase() !== path.resolve(target).toLowerCase())
              if (list.length === 0) {
                return json({ ok: false, error: { code: 'last-root', message: '至少要保留一个扫描目录' } }, 400)
              }
              delete current.root
              await fsp.mkdir(path.dirname(opts.settingsFile), { recursive: true })
              await fsp.writeFile(opts.settingsFile, JSON.stringify({ ...current, roots: list }, null, 2), 'utf8')
              return json({ ok: true, settings: await readSettingsPayload(config) })
            } catch (error) {
              return json({ ok: false, error: { code: 'write-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          if (op === 'raw') {
            const found = await resolveReadable(resolved.roots, body?.path, resolved)
            if (found === null) return json({ ok: false, error: { code: 'not-readable', message: '文件不存在或不可读' } }, 404)
            let bytes
            try {
              bytes = await fsp.readFile(found.absolute)
            } catch (error) {
              return json({ ok: false, error: { code: 'read-failed', message: String(error?.message ?? error) } }, 500)
            }
            return new Response(bytes, {
              status: 200,
              headers: {
                'content-type': contentTypeFor(path.extname(found.absolute).toLowerCase()),
                'content-length': String(bytes.byteLength),
                'cache-control': 'no-store',
              },
            })
          }

          // 在文件管理器中定位该文件（仅 Windows）
          if (op === 'reveal') {
            // reveal 要能定位大文件，所以用媒体上限（这里取两者较大值）
            const capForReveal = Math.max(resolved.maxImageBytes, resolved.maxMediaBytes)
            const found = await resolveReadable(resolved.roots, body?.path, resolved, capForReveal)
            if (found === null) {
              return json({ ok: false, error: { code: 'not-readable', message: '文件不存在或不可读' } }, 404)
            }
            // mode: 'select' 在文件夹里选中文件；'play' 尝试用默认程序打开（对媒体更直接）
            const mode = body?.mode === 'play' ? 'play' : 'select'
            try {
              const { spawn } = await import('node:child_process')
              let child
              if (process.platform === 'win32') {
                if (mode === 'play') {
                  // cmd start：让 shell 按文件关联打开。空字符串是窗口标题占位，
                  // 不占位的话中文路径会被当作窗口标题。
                  child = spawn('cmd.exe', ['/c', 'start', '', found.absolute], {
                    detached: true, stdio: 'ignore', windowsHide: true,
                  })
                } else {
                  // explorer /select 在直接 spawn 时对含中文的路径会以退出码 1 失败（已实测）。
                  // 改走 cmd /c start "" explorer.exe /select,"<path>"：让 cmd 负责引号与编码，
                  // 这是 Windows 上打开并选中中文路径文件的稳定写法。
                  child = spawn('cmd.exe', [
                    '/c', 'start', '',
                    'explorer.exe', `/select,"${found.absolute}"`,
                  ], {
                    detached: true, stdio: 'ignore', windowsHide: true,
                  })
                }
              } else {
                child = spawn('xdg-open', [mode === 'play' ? found.absolute : path.dirname(found.absolute)], {
                  detached: true, stdio: 'ignore',
                })
              }
              // 不要 unref 立即丢：先观察 800ms 内的错误与退出码，异常时报给前端
              const outcome = await new Promise((resolve) => {
                let settled = false
                const done = (payload) => {
                  if (settled) return
                  settled = true
                  resolve(payload)
                }
                child.on('error', (error) => done({
                  ok: false, code: 'spawn-error', message: String(error?.message ?? error),
                }))
                child.on('exit', (code, signal) => {
                  // explorer 成功时通常很快退出（它把活交给已有 explorer 进程）
                  if (mode === 'play') {
                    // cmd start 退出码 0 表示已交给关联程序
                    done(code === 0 || code === null
                      ? { ok: true, exitCode: code, signal }
                      : { ok: false, code: 'exit-nonzero', message: `exit ${code}`, exitCode: code })
                  } else {
                    // 现在 select 也走 cmd start，退出码 0 表示命令已被接受
                    done(code === 0 || code === null
                      ? { ok: true, exitCode: code, signal }
                      : { ok: false, code: 'select-exit-nonzero', message: `cmd start 退出码 ${code}`, exitCode: code })
                  }
                })
                setTimeout(() => done({ ok: true, note: 'assumed-ok-after-800ms' }), 800)
              })
              if (child !== undefined && typeof child.unref === 'function' && outcome.ok) {
                try { child.unref() } catch {}
              }
              if (!outcome.ok) {
                return json({ ok: false, error: { code: outcome.code, message: outcome.message, mode }, detail: outcome }, 500)
              }
              return json({ ok: true, mode, detail: outcome })
            } catch (error) {
              return json({
                ok: false,
                error: { code: 'reveal-failed', message: String(error?.message ?? error), mode },
              }, 500)
            }
          }

          // ---------- 隐藏 / 取消隐藏 ----------
          // 隐藏只记路径，不动文件；列表扫描时过滤掉。
          if (op === 'hide' || op === 'unhide') {
            const rel = body?.path
            if (typeof rel !== 'string' || rel === '') {
              return json({ ok: false, error: { code: 'invalid-path', message: '缺少文件路径' } }, 400)
            }
            const normalized = rel.replace(/\\/g, '/')
            if (normalized.split('/').some((s) => s === '..' || s === '')) {
              return json({ ok: false, error: { code: 'invalid-path', message: '路径非法' } }, 400)
            }
            try {
              const opts = resolveOptions(config)
              const hidden = new Set(await readHiddenList(opts.settingsFile))
              if (op === 'hide') hidden.add(normalized)
              else hidden.delete(normalized)
              await fsp.mkdir(path.dirname(opts.settingsFile), { recursive: true })
              // 只改 hidden 字段，其余设置保留
              const current = readSettingsFile(opts.settingsFile)
              const next = { ...current, hidden: [...hidden] }
              await fsp.writeFile(opts.settingsFile, JSON.stringify(next, null, 2), 'utf8')
              return json({ ok: true, hidden: hidden.size })
            } catch (error) {
              return json({ ok: false, error: { code: 'hide-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          // ---------- 全部恢复（清空隐藏列表）----------
          if (op === 'clearHidden') {
            try {
              const opts = resolveOptions(config)
              const current = readSettingsFile(opts.settingsFile)
              const before = Array.isArray(current.hidden) ? current.hidden.length : 0
              await fsp.mkdir(path.dirname(opts.settingsFile), { recursive: true })
              await fsp.writeFile(
                opts.settingsFile,
                JSON.stringify({ ...current, hidden: [] }, null, 2),
                'utf8',
              )
              return json({ ok: true, cleared: before })
            } catch (error) {
              return json({ ok: false, error: { code: 'clear-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          // ---------- 删除文件（不可逆，前端必须二次确认）----------
          if (op === 'delete') {
            const found = await resolveReadable(resolved.roots, body?.path, resolved)
            if (found === null) return json({ ok: false, error: { code: 'not-readable', message: '文件不存在或不可读' } }, 404)
            // 双保险：前端未明确确认则拒绝执行
            if (body?.confirm !== true) {
              return json({ ok: false, error: { code: 'need-confirm', message: '需要确认后才能删除' } }, 400)
            }
            try {
              await fsp.rm(found.absolute, { force: true })
              // 删除后从隐藏列表里清掉，避免残留
              const opts = resolveOptions(config)
              const hidden = new Set(await readHiddenList(opts.settingsFile))
              const rel = body?.path.replace(/\\/g, '/')
              if (hidden.has(rel)) {
                hidden.delete(rel)
                const current = readSettingsFile(opts.settingsFile)
                await fsp.writeFile(opts.settingsFile, JSON.stringify({ ...current, hidden: [...hidden] }, null, 2), 'utf8')
              }
              return json({ ok: true, deleted: found.absolute })
            } catch (error) {
              return json({ ok: false, error: { code: 'delete-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          return json({ ok: false, error: { code: 'unknown-op', message: `未知操作：${op}` } }, 400)
        },
      }),
    'dsh-gallery: api route',
  )
}
