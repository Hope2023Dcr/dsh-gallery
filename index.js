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
import { promises as fsp, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 路由：一个 POST 通道，op 区分 list / raw / reveal / settings。exact Fetch 路由必须以 / 开头。 */
export const ROUTE = '/api/dsh-gallery'

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
 * 只认写文件/改文件/声明交付这三类；读文件不算产出。
 */
const OUTPUT_TOOLS = new Set([
  'write',
  'edit',
  'present',
  'dsh_im_return_file',
  'ops_write_file',
  'ops_edit_file',
])

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

  // 5. 遍历可用盘符（Windows）：依次尝试每个盘根下的「DSH产出」，不写死任何字母
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

const DEFAULTS = {
  // root 不在默认值里写死，由 resolveOptions 三级优先推导
  windowHours: 24,
  maxItems: 60,
  maxDepth: 3,
  extensions: ['.png', '.jpg', '.jpeg', '.webp'],
  /**
   * 文件画廊：只放「产出文件」——文档、代码、数据、压缩包、链接。
   * 不收任何图片格式（图片归图片画廊），也不收音视频（体积大且非文档产出）。
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
 * 解析最终配置。root 的优先级（高 → 低）：
 *   1. 运行时配置文件里的 root（用户在面板内改的）
 *   2. cordis.patch.yml 里显式配的 root（部署者通过 YAML 指定）
 *   3. 自动探测（detectDefaultRoot）
 *
 * 注意：YAML 里如果把 root 写成本机的固定盘符路径，就会盖过自动探测。
 * 开源版发布的 patch.yml 故意不写 root，让自动探测生效。
 */
function resolveOptions(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  const settingsFile = String(merged.settingsFile ?? DEFAULT_SETTINGS_FILE)
  const stored = readSettingsFile(settingsFile)

  // root 三级优先：运行时设置 > YAML 配置 > 自动探测
  const storedRoot = typeof stored.root === 'string' ? stored.root.trim() : ''
  const configuredRoot = typeof merged.root === 'string' ? merged.root.trim() : ''
  let chosenRoot
  let rootSource
  if (storedRoot !== '') {
    chosenRoot = storedRoot
    rootSource = 'settings'
  } else if (configuredRoot !== '') {
    chosenRoot = configuredRoot
    rootSource = 'config'
  } else {
    chosenRoot = detectDefaultRoot()
    rootSource = 'auto-detect'
  }

  return {
    root: path.resolve(chosenRoot),
    rootSource,
    settingsFile,
    windowHours: numberOr(merged.windowHours, DEFAULTS.windowHours, 1, 24 * 30),
    maxItems: numberOr(merged.maxItems, DEFAULTS.maxItems, 1, 500),
    maxDepth: numberOr(merged.maxDepth, DEFAULTS.maxDepth, 0, 8),
    extensions: arrayOfStrings(merged.extensions, DEFAULTS.extensions).map((e) => e.toLowerCase()),
    fileExtensions: arrayOfStrings(merged.fileExtensions, DEFAULTS.fileExtensions).map((e) => e.toLowerCase()),
    skipDirs: arrayOfStrings(merged.skipDirs, DEFAULTS.skipDirs).map((e) => e.toLowerCase()),
    maxDirectories: numberOr(merged.maxDirectories, DEFAULTS.maxDirectories, 1, 200000),
    maxEntries: numberOr(merged.maxEntries, DEFAULTS.maxEntries, 1, 1000000),
    maxImageBytes: numberOr(merged.maxImageBytes, DEFAULTS.maxImageBytes, 1, 512 * 1024 * 1024),
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
  let exists = false
  try {
    exists = (await fsp.stat(opts.root)).isDirectory()
  } catch {
    exists = false
  }
  return {
    root: opts.root,
    rootSource: opts.rootSource,
    rootExists: exists,
    settingsFile: opts.settingsFile,
    windowHours: opts.windowHours,
    maxItems: opts.maxItems,
    maxDepth: opts.maxDepth,
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
 * 从会话日志里读出「本对话产出过的绝对路径」。
 * 只取 write / edit / present 这类真正产生文件的工具调用。
 * @param logText - 解压后的日志文本（每行一个 JSON）。
 * @returns 绝对路径的 Set。
 */
function extractOutputPaths(logText) {
  const paths = new Set()
  if (typeof logText !== 'string' || logText === '') return paths
  const lines = logText.split('\n')
  for (const line of lines) {
    if (line === '') continue
    // 只快速预筛含写类工具名的行，避免全量 JSON.parse
    if (!line.includes('tool/call')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.type !== 'tool/call') continue
    const name = record?.data?.name
    if (typeof name !== 'string' || !OUTPUT_TOOLS.has(name)) continue
    const rawArgs = record?.data?.arguments
    if (typeof rawArgs !== 'string') continue
    let args
    try {
      args = JSON.parse(rawArgs)
    } catch {
      continue
    }
    const found = []
    collectAbsolutePaths(args, found)
    for (const entry of found) paths.add(entry)
  }
  return paths
}

/**
 * 算出「本对话」产出过的任务目录。
 * 以产出根目录为基准，取路径第一层目录（也就是一次任务的产出目录）。
 * @param config - 用户配置。
 * @param sessionId - 当前会话 id。
 * @returns { taskDirs, paths, ok, reason }
 */
async function resolveSessionScope(config, sessionId) {
  const opts = resolveOptions(config)
  const sessionsDir = typeof config?.sessionsDir === 'string' && config.sessionsDir !== ''
    ? path.resolve(config.sessionsDir)
    : DEFAULT_SESSIONS_DIR
  const sessionDir = await locateSessionDir(sessionsDir, sessionId)
  if (sessionDir === null) {
    return { ok: false, reason: 'session-not-found', taskDirs: [], paths: [] }
  }
  const logPath = path.join(sessionDir, 'session.v4.jsonl.zstd')
  const logText = await readSessionLogText(logPath)
  if (logText === '') {
    return { ok: false, reason: 'log-empty', taskDirs: [], paths: [] }
  }
  const allPaths = extractOutputPaths(logText)
  const normalized = []
  for (const entry of allPaths) {
    const absolute = path.resolve(entry)
    if (!isInside(opts.root, absolute)) continue
    normalized.push(absolute)
  }
  // 第一层目录 = 一次任务的产出目录
  const taskDirs = new Set()
  for (const absolute of normalized) {
    const rel = path.relative(opts.root, absolute)
    const segs = rel.split(path.sep).filter((s) => s !== '')
    if (segs.length >= 2) taskDirs.add(segs[0])
  }
  return { ok: true, reason: 'ok', taskDirs: [...taskDirs], paths: normalized }
}

/**
 * 扫描画廊候选：广度优先、深度受限、跳过批量目录、有目录/条目预算。
 * 结果按修改时间倒序，只回传 maxItems 条，另外给出 total 供「还有 N 张」。
 */
export async function scanGallery(config, kind = 'image', scope = 'global', sessionId = '') {
  const opts = resolveOptions(config)
  const now = Date.now()
  const cutoff = now - opts.windowHours * 3600_000
  const isFile = kind === 'file'
  const isSession = scope === 'session'
  // 图片格式永远排除在文件画廊之外；防止用户配置误把图片塞进来
  const extraImageEx = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.avif', '.ico'])
  const rawExts = isFile ? opts.fileExtensions : opts.extensions
  const extSet = new Set(rawExts.filter((e) => !(isFile && extraImageEx.has(e))))
  const skipSet = new Set(opts.skipDirs)

  // 当前对话范围：先解析会话日志，得到「本对话产出过的任务目录」
  let scopeInfo = { ok: true, reason: 'global', taskDirs: [], paths: [] }
  let taskDirSet = null
  if (isSession) {
    scopeInfo = await resolveSessionScope(config, sessionId)
    taskDirSet = new Set(scopeInfo.taskDirs.map((d) => d.toLowerCase()))
  }

  const dirQueue = [{ dir: opts.root, depth: 0 }]
  const matches = []
  let directories = 0
  let entries = 0
  let capped = false
  let rootMissing = false

  try {
    const st = await fsp.stat(opts.root)
    if (!st.isDirectory()) rootMissing = true
  } catch {
    rootMissing = true
  }

  if (!rootMissing) {
    while (dirQueue.length > 0) {
      if (directories >= opts.maxDirectories || entries >= opts.maxEntries) {
        capped = true
        break
      }
      const { dir, depth } = dirQueue.shift()
      directories += 1
      // 当前对话范围：只下探本对话产出过的任务目录，其余目录整体跳过
      if (taskDirSet !== null && depth > 0) {
        const rel = path.relative(opts.root, dir)
        const top = rel.split(path.sep)[0] ?? ''
        if (!taskDirSet.has(top.toLowerCase())) continue
      }
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
        let stat
        try {
          stat = await fsp.stat(fullPath)
        } catch {
          continue
        }
        if (stat.size <= 0 || stat.mtimeMs < cutoff) continue
        matches.push({
          relPath: path.relative(opts.root, fullPath).split(path.sep).join('/'),
          name: entryName,
          size: stat.size,
          mtime: stat.mtimeMs,
          extension: ext,
        })
      }
    }
  }

  matches.sort((a, b) => b.mtime - a.mtime)
  const total = matches.length
  const visible = matches.slice(0, opts.maxItems)

  await Promise.all(visible.map(async (item) => {
    if (isFile) {
      // 文件画廊不解析图片尺寸
      item.width = null
      item.height = null
      return
    }
    const measured = measureImage(
      await readHead(path.join(opts.root, ...item.relPath.split('/')), 65536),
      item.extension,
    )
    item.width = measured?.width ?? null
    item.height = measured?.height ?? null
  }))

  return {
    kind,
    scope: isSession ? 'session' : 'global',
    scopeInfo: {
      ok: scopeInfo.ok,
      reason: scopeInfo.reason,
      taskDirs: scopeInfo.taskDirs.length,
      paths: scopeInfo.paths.length,
    },
    root: opts.root,
    windowHours: opts.windowHours,
    maxItems: opts.maxItems,
    maxDepth: opts.maxDepth,
    generatedAt: now,
    items: visible,
    total,
    hidden: Math.max(0, total - visible.length),
    rootMissing,
    scan: { directories, entries, capped },
  }
}

/** 把一个相对路径解析成根目录内的绝对路径；越界或不存在返回 null。 */
async function resolveReadable(root, relPath, opts) {
  if (typeof relPath !== 'string' || relPath === '') return null
  const normalized = relPath.replace(/\\/g, '/')
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) return null
  const absolute = path.resolve(root, ...normalized.split('/'))
  if (!isInside(root, absolute)) return null
  try {
    const stat = await fsp.stat(absolute)
    if (!stat.isFile() || stat.size <= 0 || stat.size > opts.maxImageBytes) return null
    return { absolute, stat }
  } catch {
    return null
  }
}

function contentTypeFor(ext) {
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
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
              const kind = body?.kind === 'file' ? 'file' : 'image'
              const scope = body?.scope === 'session' ? 'session' : 'global'
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
              return json(await scanGallery(config, kind, scope, sessionId))
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

          // 修改产出根目录：校验 → 写入运行时配置 → 立即生效
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
              await writeSettingsFile(opts.settingsFile, { root: check.root })
              return json({ ok: true, settings: await readSettingsPayload(config) })
            } catch (error) {
              return json({ ok: false, error: { code: 'write-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          if (op === 'raw') {
            const found = await resolveReadable(resolved.root, body?.path, resolved)
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
            const found = await resolveReadable(resolved.root, body?.path, resolved)
            if (found === null) return json({ ok: false, error: { code: 'not-readable', message: '文件不存在或不可读' } }, 404)
            try {
              const { spawn } = await import('node:child_process')
              if (process.platform === 'win32') {
                spawn('explorer.exe', [`/select,${found.absolute}`], { detached: true, stdio: 'ignore' }).unref()
              } else {
                spawn('xdg-open', [path.dirname(found.absolute)], { detached: true, stdio: 'ignore' }).unref()
              }
              return json({ ok: true })
            } catch (error) {
              return json({ ok: false, error: { code: 'reveal-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          return json({ ok: false, error: { code: 'unknown-op', message: `未知操作：${op}` } }, 400)
        },
      }),
    'dsh-gallery: api route',
  )
}
