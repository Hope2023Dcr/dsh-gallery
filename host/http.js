/**
 * HTTP 路由：媒体直链（webServer + 206 Range）与 op 路由（connection.fetch）。
 *
 * S1 拆分自 index.js 的 apply()（行为零变化）。
 *
 * 两条路由的差别（这决定 P0 级 bug）：
 *   · 媒体路由走 ctx.webServer.register —— Node 原生 req/res，能返回 206
 *   · op 路由走 ctx.connection.fetch    —— Fetch API，走 /api 网关（需认证）
 */

import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { ROUTE, MEDIA_ROUTE } from './constants.js'
import { isInside } from './fsutil.js'
import { cropMediaFile } from './trim.js'
import {
  resolveOptions, readSettingsFile, readHiddenList,
  validateRootCandidate, readSettingsPayload,
} from './settings.js'
import { scanGallery, resolveSessionScope, parentDirOf } from './scan.js'
import { locateSessionDir, readSessionLogText } from './session.js'
import { extractSessionTitleFast } from './session-index.js'
import { DEFAULT_SESSIONS_DIR } from './constants.js'
import { makeDerivedName, bumpName, pngBufferFrom, tmpPathFor } from './derive.js'
import { readClipboardFilePaths, writeClipboardFilePaths, internalClipboardPaths, pasteFilesIntoDir } from './clipboard.js'

/**
 * 列表请求的短缓存 + 并发去重（加载提速，不改变返回内容与分组顺序）。
 *
 * 客户端会自动刷新，切换对话又会再发一次；旧实现每次都真扫一遍，
 * 多个请求叠在一起会把 Host CPU 占满，面板就一直停在「正在扫描…」。
 * 4 秒内的相同请求直接复用，同一时刻的相同请求只跑一次。
 */
const LIST_CACHE_MS = 4000
const listCache = new Map()
const listInflight = new Map()
import { resolveReadable, serveMedia, contentTypeFor } from './media.js'
import { MARK_ACTIONS, readMarks, writeMarks, setMark, setMarksBatch, marksFilePath } from './marks.js'
import { readFeedback, setFeedback, setFeedbackBatch, ackFeedback, clearFeedback } from './feedback.js'
// v0.16.4 A 档：把待处理反馈渲染成成稿文本（纯函数，不碰落盘数据）
import { makeFeedback, renderFeedbackText } from './feedback-text.js'
import { LABEL_CATEGORIES, readLabels, setLabel, setLabelsBatch, deleteLabels } from './labels.js'
import {
  registerFrame, deleteFrames, frameTimecode, makeFrameName, makeMaskName, maskPolygonMeta,
} from './frames.js'

/** reveal 相关的排查日志（失败/异常时便于定位，不影响功能）。 */
/**
 * 把相对路径解析到 roots 内的绝对路径（v0.13.7，删除闸门用）。
 * 解析不出 / 越界返回 null。
 */
function resolveUnderRoots(roots, relPath) {
  if (!Array.isArray(roots) || roots.length === 0) return null
  for (const root of roots) {
    if (typeof root !== "string" || root === "") continue
    const abs = path.resolve(root, relPath)
    if (!isInside(root, abs)) continue
    return abs
  }
  return null
}

function LOG_RESOLVE(label, detail) {
  if (process.env.DSH_GALLERY_DEBUG === '1') {
    try { console.info('dsh-gallery ' + label, JSON.stringify(detail)) } catch { /* 忽略 */ }
  }
}

/**
 * 把相对路径解析成绝对路径（按 roots 依次试，第一个命中的即用）。
 * 解析不出返回空串 —— 调用方自行决定要不要跳过。
 */
function absoluteOf(roots, relPath) {
  if (!Array.isArray(roots)) return ''
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue
    const abs = path.resolve(root, relPath)
    if (isInside(root, abs)) return abs
  }
  return ''
}

/**
 * v0.16.4：按条件过滤资产（后置过滤，不重扫）。
 *
 * 为什么后置：扫描本身有缓存、且要按 roots 遍历；筛选只影响「返回哪些」，
 * 放在扫描后最省。分组的 counts 会按过滤后的集合重算，保证台面显示与筛选结果一致。
 *
 * 筛选维度（AND 组合）：
 *   label / category —— 生效分类（手动标签优先，与台面显示一致）
 *   action          —— 判定动作（来自 marks）
 *   confirmed       —— 是否已确认（来自 marks 的 confirmed 字段）
 *   ext             —— 扩展名
 *   q               —— 路径模糊匹配
 */
// v0.16.4: 导出以便真跑测试（纯函数，不改行为）
export async function applyAssetFilter(value, opts) {
  const {
    filterLabel, filterCategory, filterAction, filterExt,
    filterConfirmed, filterQuery, filterLimit, settingsFile,
  } = opts

  let marks = {}
  try {
    marks = (await readMarks(settingsFile)).marks ?? {}
  } catch { marks = {} }

  const labelSet = filterLabel !== '' ? new Set([filterLabel]) : null
  const categorySet = filterCategory !== '' ? new Set([filterCategory]) : null

  const keep = (f) => {
    const category = String(f?.category ?? '')
    if (labelSet !== null && !labelSet.has(category)) return false
    if (categorySet !== null && !categorySet.has(category)) return false

    const ext = String(f?.extension ?? '')
    if (filterExt !== '' && !ext.toLowerCase().endsWith(filterExt)) return false

    if (filterQuery !== '') {
      const hay = `${f?.relPath ?? ''} ${f?.name ?? ''}`.toLowerCase()
      if (!hay.includes(filterQuery)) return false
    }

    const mark = marks[f?.relPath]
    if (filterAction !== '' && String(mark?.action ?? '') !== filterAction) return false
    if (filterConfirmed !== null && (mark?.confirmed === true) !== filterConfirmed) return false

    return true
  }

  const decorate = (f) => {
    const mark = marks[f?.relPath]
    return {
      ...f,
      confirmed: mark?.confirmed === true,
      markAction: String(mark?.action ?? ''),
    }
  }

  const out = { ...value }
  out.filtered = true

  if (Array.isArray(value?.groups)) {
    const groups = []
    for (const g of value.groups) {
      const files = (Array.isArray(g.files) ? g.files : []).filter(keep).map(decorate)
      if (files.length === 0) continue
      groups.push({
        ...g,
        files,
        counts: {
          final: files.filter((f) => f.category === 'final').length,
          input: files.filter((f) => f.category === 'input').length,
          intermediate: files.filter((f) => f.category === 'intermediate').length,
          unknown: files.filter((f) => f.category === 'unknown' || f.category === undefined).length,
        },
      })
    }
    out.groups = groups
    out.total = groups.reduce((n, g) => n + g.files.length, 0)
  }

  if (Array.isArray(value?.items)) {
    out.items = value.items.filter(keep).map(decorate).slice(0, filterLimit)
  }

  if (Array.isArray(value?.files)) {
    out.files = value.files.filter(keep).map(decorate).slice(0, filterLimit)
    out.total = out.files.length
  }

  return out
}

/** 统一 JSON 响应。 */
function json(body, status) {

  return new Response(JSON.stringify(body), {

    status: status ?? 200,

    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },

  })

}


/**
 * 注册媒体直链路由（Node 原生 req/res，支持 HTTP Range / 206）。
 */
export function registerMediaRoute(ctx, config) {
  ctx.effect(

    () => ctx.webServer.register({

      kind: 'prefix',

      path: MEDIA_ROUTE,

      handler: async (req, res) => {

        // ---- 防护 3：只读 ----

        if (req.method !== 'GET' && req.method !== 'HEAD') {

          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })

          res.end('method not allowed')

          return

        }

        // ---- 防护 2：拒绝跨站 ----

        const site = req.headers['sec-fetch-site']

        if (typeof site === 'string' && site === 'cross-site') {

          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })

          res.end('cross-site request refused')

          return

        }

        const origin = req.headers.origin

        if (typeof origin === 'string' && origin !== '') {

          let originHost = ''

          try { originHost = new URL(origin).host } catch { originHost = '' }

          const host = req.headers.host

          if (originHost !== '' && typeof host === 'string' && originHost !== host) {

            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })

            res.end('origin mismatch')

            return

          }

        }



        try {

          const url = new URL(req.url ?? '/', 'http://dsh.internal')

          const relPath = url.searchParams.get('path') ?? ''

          if (relPath === '') {

            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })

            res.end('missing path')

            return

          }

          const resolved = resolveOptions(config)

          // ---- 防护 1：路径白名单 ----

          const found = await resolveReadable(resolved.roots, relPath, resolved, resolved.maxMediaBytes)

          if (found === null) {

            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })

            res.end('not found')

            return

          }

          let stat

          try {

            stat = await fsp.stat(found.absolute)

          } catch (error) {

            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })

            res.end(String(error?.message ?? error))

            return

          }

          const type = contentTypeFor(path.extname(found.absolute).toLowerCase())

          serveMedia(req, res, found.absolute, stat.size, type)

        } catch (error) {

          if (!res.headersSent) {

            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })

            res.end(String(error?.message ?? error))

          } else {

            res.destroy()

          }

        }

      },

    }),

    'dsh-gallery: media range route',

  )
}

/**
 * 注册 op 路由（POST + op 区分动作，走 /api 网关）。
 */
export function registerOpsRoute(ctx, config) {
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

              // ── v0.16.4：检索维度 ──────────────────────────────────
              // 目标：Agent 能按条件取资产（不只是「当前选中那一张」）。
              // 全部可选、AND 组合；分类取的是**手动标签覆写后的生效值**（与台面显示一致）。
              const filterLabel = typeof body?.label === 'string' ? body.label : ''
              const filterCategory = typeof body?.category === 'string' ? body.category : ''
              const filterAction = typeof body?.action === 'string' ? body.action : ''
              const filterExt = typeof body?.ext === 'string' ? body.ext.toLowerCase() : ''
              const filterConfirmed = body?.confirmed === true ? true
                : body?.confirmed === false ? false : null
              const filterQuery = typeof body?.q === 'string' ? body.q.trim().toLowerCase() : ''
              const filterLimit = Math.max(1, Math.min(500, Math.trunc(Number(body?.limit)) || 100))
              const hasFilter = filterLabel !== '' || filterCategory !== '' || filterAction !== ''
                || filterExt !== '' || filterConfirmed !== null || filterQuery !== ''

              // 配置 / 隐藏列表写在 settingsFile 里，它的 mtime 变了就让缓存失效。
              // sessionId 必须在键里：切对话后不能复用上一会话的分组结果。
              let settingsStamp = 0
              try { settingsStamp = (await fsp.stat(resolved.settingsFile)).mtimeMs } catch { /* 文件还不存在 */ }
              const cacheKey = JSON.stringify([
                kind, scope, sessionId, body?.page ?? 1,
                resolved.roots, resolved.windowHours, resolved.maxDepth,
                resolved.maxItems, settingsStamp,
                filterLabel, filterCategory, filterAction, filterExt,
                filterConfirmed, filterQuery, filterLimit,
              ])
              const hit = listCache.get(cacheKey)
              if (hit !== undefined && Date.now() - hit.at < LIST_CACHE_MS) return json(hit.value)
              const inflight = listInflight.get(cacheKey)
              if (inflight !== undefined) return json(await inflight)

              const task = scanGallery(config, kind, scope, sessionId, body?.page)
                .then((value) => {
                  // ── v0.16.4：按条件过滤 ────────────────────────────
                  // 标记（判定 / 确认态）来自 marks 文件；手动标签已在 scan 阶段
                  // 覆写到 item.category，所以这里直接用 category 即可。
                  if (!hasFilter) {
                    listCache.set(cacheKey, { at: Date.now(), value })
                    return value
                  }
                  return applyAssetFilter(value, {
                    filterLabel, filterCategory, filterAction, filterExt,
                    filterConfirmed, filterQuery, filterLimit,
                    settingsFile: resolved.settingsFile,
                  }).then((filtered) => {
                    listCache.set(cacheKey, { at: Date.now(), value: filtered })
                    return filtered
                  })
                })
                .finally(() => { listInflight.delete(cacheKey) })
              listInflight.set(cacheKey, task)
              return json(await task)

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

            // raw 要给播放器取整个文件，必须用媒体上限（默认 200MB）。
            // 不传 byteCap 会回退到 maxImageBytes（64MB）—— 127MB 视频会被判「不可读」→ 404。
            const found = await resolveReadable(resolved.roots, body?.path, resolved, resolved.maxMediaBytes)

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

          // ---- v0.14.2 手动标签覆写（持久，与反馈篮 marks 分开）----
          if (op === 'getLabels') {
            const stored = await readLabels(resolveOptions(config).settingsFile)
            return json({ ok: true, labels: stored.labels })
          }

          if (op === 'setLabel') {
            const relPath = String(body?.path ?? '')
            if (relPath === '') {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 path' } }, 400)
            }
            const label = body?.label
            if (label !== null && label !== undefined &&
                (typeof label !== 'object' || !LABEL_CATEGORIES.includes(label.category))) {
              return json({ ok: false, error: { code: 'bad-request', message: 'category 不合法' } }, 400)
            }
            try {
              const next = await setLabel(resolveOptions(config).settingsFile, relPath,
                label === undefined ? null : label)
              // 标签变了必须让下一次 list 立刻重扫，否则 4 秒缓存里还是旧角标
              listCache.clear()
              return json({ ok: true, labels: next })
            } catch (error) {
              return json({ ok: false, error: { code: 'labels-write-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          if (op === 'setLabelsBatch') {
            const updates = Array.isArray(body?.updates) ? body.updates : null
            if (updates === null) {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 updates 数组' } }, 400)
            }
            if (updates.length > 200) {
              return json({ ok: false, error: { code: 'too-many', message: '单次最多 200 条' } }, 400)
            }
            for (const u of updates) {
              const label = u?.label
              if (label !== null && label !== undefined &&
                  (typeof label !== 'object' || !LABEL_CATEGORIES.includes(label.category))) {
                return json({ ok: false, error: { code: 'bad-request', message: 'category 不合法' } }, 400)
              }
            }
            try {
              const next = await setLabelsBatch(resolveOptions(config).settingsFile, updates)
              listCache.clear()
              return json({ ok: true, labels: next, applied: updates.length })
            } catch (error) {
              return json({ ok: false, error: { code: 'labels-write-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          // ---- v0.14.3 视频截帧：直接写进当前对话资产，不再弹系统保存框 ----
          if (op === 'saveFrame') {
            const opts = resolveOptions(config)
            const videoRel = String(body?.path ?? '').replace(/\\/g, '/')
            const data = typeof body?.data === 'string' ? body.data : ''
            const frameMs = Number(body?.frameMs)
            if (videoRel === '' || data === '') {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 path 或 data' } }, 400)
            }
            if (!Number.isFinite(frameMs) || frameMs < 0) {
              return json({ ok: false, error: { code: 'bad-request', message: 'frameMs 不合法' } }, 400)
            }

            // 源视频必须真实存在于扫描目录内；同时拿到它所属的 root 以反算 relPath。
            // 不能用 resolveUnderRoots（它取第一个匹配的 root），多目录时会串错。
            let videoAbs = null
            let ownerRoot = null
            for (const root of opts.roots) {
              if (typeof root !== 'string' || root === '') continue
              const abs = path.resolve(root, videoRel)
              if (!isInside(root, abs)) continue
              try {
                const st = await fsp.stat(abs)
                if (st.isFile()) { videoAbs = abs; ownerRoot = root; break }
              } catch { /* 换下一个 root */ }
            }
            if (videoAbs === null) {
              return json({ ok: false, error: { code: 'video-not-found', message: '源视频不在扫描目录内' } }, 404)
            }

            const buf = Buffer.from(data, 'base64')
            if (buf.length < 8 || buf.length > 24 * 1024 * 1024) {
              return json({ ok: false, error: { code: 'bad-png', message: 'PNG 数据为空或超过 24 MB' } }, 400)
            }
            // PNG 魔数：不允许把任意 base64 写进资产目录
            if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
              return json({ ok: false, error: { code: 'bad-png', message: '数据不是 PNG' } }, 400)
            }

            const dir = path.dirname(videoAbs)
            const videoName = path.basename(videoAbs)
            let name = makeFrameName(videoName, frameMs)
            let abs = path.join(dir, name)
            // 同一帧重复截：不覆盖已有文件，依次加 -2 / -3 …
            let n = 2
            while (n <= 99) {
              let exists = true
              try { await fsp.access(abs) } catch { exists = false }
              if (!exists) break
              name = makeFrameName(videoName, frameMs, `-${n}`)
              abs = path.join(dir, name)
              n += 1
            }
            if (!isInside(ownerRoot, abs)) {
              return json({ ok: false, error: { code: 'outside-roots', message: '目标路径越出扫描目录' } }, 400)
            }

            // 原子写：先落到 .tmp 再改名，避免扫描读到半截 PNG
            const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}`
            try {
              await fsp.mkdir(dir, { recursive: true })
              await fsp.writeFile(tmp, buf)
              await fsp.rename(tmp, abs)
            } catch (error) {
              try { await fsp.rm(tmp, { force: true }) } catch { /* 忽略 */ }
              return json({ ok: false, error: { code: 'frame-write-failed', message: String(error?.message ?? error) } }, 500)
            }

            const relPath = path.relative(ownerRoot, abs).split(path.sep).join('/')
            const timecode = frameTimecode(frameMs)
            try {
              await registerFrame(opts.settingsFile, {
                relPath,
                sessionId: String(body?.sessionId ?? ''),
                sessionTitle: String(body?.sessionTitle ?? ''),
                sessionCreatedAt: Number(body?.sessionCreatedAt) || 0,
                videoRelPath: videoRel,
                videoName,
                frameMs: Math.round(frameMs),
                timecode,
              })
            } catch (error) {
              return json({ ok: false, error: { code: 'frame-register-failed', message: String(error?.message ?? error) } }, 500)
            }

            // 新资产要立刻出现在列表里，不能等 4 秒缓存过期
            listCache.clear()
            return json({
              ok: true, relPath, absPath: abs, name, timecode,
              frameMs: Math.round(frameMs), videoName,
            })
          }

          // ---- v0.14.5 矩形框选批注 → ComfyUI 可用 RGBA 遮罩 ----
          // 前端已按「框内 alpha=0、框外 255、RGB 保留原图」编码好 PNG；
          // 这里只负责安全落盘 + 登记当前对话，不解析像素、不请求 ComfyUI。
          if (op === 'saveMask') {
            const opts = resolveOptions(config)
            const imageRel = String(body?.path ?? '').replace(/\\/g, '/')
            const data = typeof body?.data === 'string' ? body.data : ''
            const region = body?.region
            if (imageRel === '' || data === '') {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 path 或 data' } }, 400)
            }
            const keys = ['x', 'y', 'w', 'h']
            const validRegion = region !== null && typeof region === 'object'
              && keys.every((k) => {
                const n = Number(region[k])
                return Number.isFinite(n) && n >= 0 && n <= 1
              })
              && Number(region.w) > 0 && Number(region.h) > 0
            if (!validRegion) {
              return json({ ok: false, error: { code: 'bad-request', message: 'region 不合法' } }, 400)
            }
            const normRegion = {
              x: Number(region.x), y: Number(region.y),
              w: Number(region.w), h: Number(region.h),
            }
            // v0.14.6 右键多边形：多边形仍然保留 region bbox（兼容旧文件名与旧遮罩），
            // 额外登记顶点像素坐标 / 外接框 / 面积；顶点不合法直接 400，不落脏数据。
            const polygonMeta = body?.polygon === undefined || body?.polygon === null
              ? null
              : maskPolygonMeta(body.polygon, body?.width, body?.height)
            if (body?.polygon !== undefined && body?.polygon !== null && polygonMeta === null) {
              return json({ ok: false, error: { code: 'bad-request', message: 'polygon 不合法（需 4–20 个归一化顶点与有效原图尺寸）' } }, 400)
            }

            // 源图必须真实存在于扫描目录内；同时拿到它所属的 root 以反算 relPath。
            let imageAbs = null
            let ownerRoot = null
            for (const root of opts.roots) {
              if (typeof root !== 'string' || root === '') continue
              const abs = path.resolve(root, imageRel)
              if (!isInside(root, abs)) continue
              try {
                const st = await fsp.stat(abs)
                if (st.isFile()) { imageAbs = abs; ownerRoot = root; break }
              } catch { /* 换下一个 root */ }
            }
            if (imageAbs === null) {
              return json({ ok: false, error: { code: 'image-not-found', message: '源图不在扫描目录内' } }, 404)
            }

            const buf = Buffer.from(data, 'base64')
            if (buf.length < 8 || buf.length > 24 * 1024 * 1024) {
              return json({ ok: false, error: { code: 'bad-png', message: 'PNG 数据为空或超过 24 MB' } }, 400)
            }
            // PNG 魔数：不允许把任意 base64 写进资产目录
            if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
              return json({ ok: false, error: { code: 'bad-png', message: '数据不是 PNG' } }, 400)
            }

            // v0.14.7 彩色填充预览图：与主遮罩同样只认 PNG / 24 MB。
            // 颜色和中文标签都走白名单，避免把任意字符串拼进文件名。
            const overlayData = typeof body?.overlay === 'string' ? body.overlay : ''
            let overlayBuf = null
            const overlayColor = ['green', 'red', 'blue'].includes(String(body?.fillColor ?? ''))
              ? String(body.fillColor) : 'green'
            const overlayLabel = ['绿', '红', '蓝'].includes(String(body?.fillLabel ?? ''))
              ? String(body.fillLabel) : '绿'
            if (overlayData !== '') {
              overlayBuf = Buffer.from(overlayData, 'base64')
              const isPng = overlayBuf[0] === 0x89 && overlayBuf[1] === 0x50
                && overlayBuf[2] === 0x4e && overlayBuf[3] === 0x47
              if (overlayBuf.length < 8 || overlayBuf.length > 24 * 1024 * 1024 || !isPng) {
                return json({ ok: false, error: { code: 'bad-png', message: '预览图数据为空、不是 PNG 或超过 24 MB' } }, 400)
              }
            }

            const dir = path.dirname(imageAbs)
            const imageName = path.basename(imageAbs)
            // 多边形遮罩文件名带「多边形」，与矩形遮罩一眼可分；重复导出仍加 -2 / -3。
            const baseSuffix = polygonMeta === null ? '' : '-多边形'
            let name = makeMaskName(imageName, normRegion, baseSuffix)
            let abs = path.join(dir, name)
            // 同一个框重复导出：不覆盖旧遮罩，依次加 -2 / -3 …
            let n = 2
            while (n <= 99) {
              let exists = true
              try { await fsp.access(abs) } catch { exists = false }
              if (!exists) break
              name = makeMaskName(imageName, normRegion, `${baseSuffix}-${n}`)
              abs = path.join(dir, name)
              n += 1
            }
            if (!isInside(ownerRoot, abs)) {
              return json({ ok: false, error: { code: 'outside-roots', message: '目标路径越出扫描目录' } }, 400)
            }

            // 原子写：先落到 .tmp 再改名，避免扫描读到半截 PNG
            const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}`
            try {
              await fsp.mkdir(dir, { recursive: true })
              await fsp.writeFile(tmp, buf)
              await fsp.rename(tmp, abs)
            } catch (error) {
              try { await fsp.rm(tmp, { force: true }) } catch { /* 忽略 */ }
              return json({ ok: false, error: { code: 'mask-write-failed', message: String(error?.message ?? error) } }, 500)
            }

            const relPath = path.relative(ownerRoot, abs).split(path.sep).join('/')

            // v0.14.7 彩色填充预览：与主遮罩同目录、独立文件，不登记成遮罩帧。
            // 它会按「同目录外部素材」规则自动出现在当前对话并标为素材，方便目视核对选区。
            let overlayRelPath = ''
            let overlayNameFinal = ''
            if (overlayBuf !== null) {
              const stem = name.replace(/\.png$/i, '')
              let oName = `${stem}_${overlayLabel}填充预览.png`
              let oAbs = path.join(dir, oName)
              let k = 2
              while (k <= 99) {
                let exists = true
                try { await fsp.access(oAbs) } catch { exists = false }
                if (!exists) break
                oName = `${stem}_${overlayLabel}填充预览-${k}.png`
                oAbs = path.join(dir, oName)
                k += 1
              }
              if (isInside(ownerRoot, oAbs)) {
                const oTmp = `${oAbs}.tmp-${process.pid}-${Date.now().toString(36)}`
                try {
                  await fsp.writeFile(oTmp, overlayBuf)
                  await fsp.rename(oTmp, oAbs)
                  overlayNameFinal = oName
                  overlayRelPath = path.relative(ownerRoot, oAbs).split(path.sep).join('/')
                } catch {
                  try { await fsp.rm(oTmp, { force: true }) } catch { /* 忽略 */ }
                  // 预览图是附加产物，写失败不影响主遮罩成功
                }
              }
            }

            try {
              await registerFrame(opts.settingsFile, {
                kind: 'mask',
                relPath,
                sessionId: String(body?.sessionId ?? ''),
                sessionTitle: String(body?.sessionTitle ?? ''),
                sessionCreatedAt: Number(body?.sessionCreatedAt) || 0,
                sourceRelPath: imageRel,
                sourceName: imageName,
                region: normRegion,
                ...(polygonMeta ?? {}),
                ...(overlayRelPath !== '' ? { overlayRelPath, fillColor: overlayColor } : {}),
              })
            } catch (error) {
              return json({ ok: false, error: { code: 'mask-register-failed', message: String(error?.message ?? error) } }, 500)
            }

            // 新资产要立刻出现在列表里，不能等 4 秒缓存过期
            listCache.clear()
            return json({
              ok: true, relPath, absPath: abs, name, region: normRegion,
              ...(polygonMeta ?? {}),
              ...(overlayRelPath !== '' ? { overlayRelPath, overlayName: overlayNameFinal } : {}),
            })
          }

          // ---- 标记（S3-a）----
          if (op === 'getMarks') {
            const settingsFile = resolveOptions(config).settingsFile
            const stored = await readMarks(settingsFile)
            return json({ ok: true, marks: stored.marks })
          }

          if (op === 'setFeedback') {
            /**
             * 记一条待处理反馈（用户做判定时调）。
             * 落盘 dsh-gallery-feedback.json —— 插件重启也不丢。
             */
            const relPath = String(body?.path ?? '')
            if (relPath === '') {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 path' } }, 400)
            }
            const item = body?.item
            if (item !== null && item !== undefined && typeof item !== 'object') {
              return json({ ok: false, error: { code: 'bad-request', message: 'item 不合法' } }, 400)
            }
            try {
              const settingsFile = resolveOptions(config).settingsFile
              const next = await setFeedback(settingsFile, relPath, item ?? null)
              return json({ ok: true, count: Object.keys(next).length, feedback: next })
            } catch (error) {
              return json({ ok: false, error: { code: 'feedback-write-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          if (op === 'setFeedbackBatch') {
            /**
             * 批量记待处理反馈（v0.16.4）：一次读改写 + 一次原子写。
             * 改标签可能一次动几十张图，逐条发请求会拖慢且互相覆盖。
             */
            const updates = Array.isArray(body?.updates) ? body.updates : null
            if (updates === null) {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 updates' } }, 400)
            }
            try {
              const settingsFile = resolveOptions(config).settingsFile
              const next = await setFeedbackBatch(settingsFile, updates)
              return json({ ok: true, count: Object.keys(next).length, feedback: next })
            } catch (error) {
              return json({ ok: false, error: { code: 'feedback-write-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          if (op === 'getPendingFeedback') {
            /**
             * 取待处理反馈（**纯读**）。
             *
             * A 档：Agent 主动来拉。
             * ⚠️ 这里**不**标记已读 —— Agent 拉走 ≠ 人处理完了。
             * 清零的时机是「人点发送」或「人点清空反馈篮」，走 ackFeedback。
             */
            try {
              const settingsFile = resolveOptions(config).settingsFile
              const fb = await readFeedback(settingsFile)
              const marks = (await readMarks(settingsFile)).marks ?? {}
              /**
               * v0.16.5：一条落盘记录可能带**多条框选批注**（annotations 数组）。
               *
               * 原来一条记录只对应一处 region，同一张图框两处时后写的把先写的覆盖了。
               * 现在落盘按整组存，读取时展开成「一处理解一条 item」——
               * 这样 Agent 拿到的条数与人在图上框的处数一致，
               * 也和前端草稿里 `Annotation N` 的编号一一对应。
               *
               * 按图分组排序：同一张图的条目必须连续，不能被别的图的判定插进来，
               * 否则草稿读起来是断的。排序键取该图第一条的时间。
               */
              const buckets = []
              for (const entry of Object.entries(fb.feedback)) {
                const relPath = entry[0]
                const item = entry[1] ?? {}
                const mark = marks[relPath]
                const base = {
                  relPath,
                  absolute: absoluteOf(resolved.roots, relPath),
                  reason: String(item.reason ?? ''),
                  changeOnly: Array.isArray(item.changeOnly) ? item.changeOnly : [],
                  keep: Array.isArray(item.keep) ? item.keep : [],
                  preserve: Array.isArray(item.preserve) ? item.preserve : [],
                  region: item.region ?? null,
                  markedAt: Number(item.markedAt) || 0,
                  // v0.16.4：带上分类与归属会话 —— Agent 拿到就能判断该改哪个文件、归哪条对话
                  category: String(item.category ?? 'unknown'),
                  sessionId: String(item.sessionId ?? ''),
                  confirmed: mark?.confirmed === true,
                }
                const flatAction = String(item.action ?? '')
                const annots = Array.isArray(item.annotations)
                  ? item.annotations.filter((a) => a !== null && typeof a === 'object' && a.region)
                  : []
                const group = []
                if (annots.length === 0) {
                  // 旧格式 / 纯标记：一条记录就是一条
                  group.push({ ...base, action: flatAction })
                } else {
                  // 该图还有一条独立判定（如「交付不合格」）时，先出这一条
                  if (flatAction !== '' && flatAction !== 'annotate') {
                    group.push({ ...base, action: flatAction })
                  }
                  for (const a of annots) {
                    group.push({
                      ...base,
                      action: 'annotate',
                      reason: typeof a.note === 'string' ? a.note : '',
                      // 批注只管「这块改成什么」，不继承整图判定的只改 / 锁死
                      changeOnly: [],
                      keep: [],
                      preserve: [],
                      region: a.region,
                      markedAt: Number(a.markedAt) || base.markedAt,
                      annotId: String(a.id ?? ''),
                    })
                  }
                }
                buckets.push(group)
              }
              buckets.sort((x, y) => ((x[0]?.markedAt ?? 0) - (y[0]?.markedAt ?? 0)))
              const items = buckets.flat()
              /**
               * draft：把待处理条目渲染成**可直接粘进 composer 的成稿文本**。
               * Agent 不必自己拼格式；人也能直接拿去用。
               * 渲染是纯函数，不影响落盘数据，也不触发任何发送。
               */
              let draft = ''
              try {
                const locale = body?.locale === 'en' ? 'en' : 'zh'
                draft = renderFeedbackText(makeFeedback({ sessionId: '', items }), { locale })
              } catch { draft = '' }
              return json({ ok: true, schema: 1, count: items.length, items, draft })
            } catch (error) {
              return json({ ok: false, error: { code: 'feedback-read-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          if (op === 'ackFeedback') {
            /**
             * 确认已处理 —— **人**点发送 / 人点清空反馈篮时调。
             * 移除给定路径的待处理反馈；不传 paths 表示清空全部。
             */
            try {
              const settingsFile = resolveOptions(config).settingsFile
              const paths = Array.isArray(body?.paths)
                ? body.paths.map((p) => String(p ?? '')).filter((p) => p !== '')
                : null
              const next = paths === null
                ? await clearFeedback(settingsFile)
                : await ackFeedback(settingsFile, paths)
              return json({ ok: true, count: Object.keys(next).length })
            } catch (error) {
              return json({ ok: false, error: { code: 'feedback-ack-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          if (op === 'marks') {
            const relPath = String(body?.path ?? '')
            if (relPath === '') {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 path' } }, 400)
            }
            // mark 为 null 表示清除；否则校验 action 合法性
            const mark = body?.mark
            if (mark !== null && mark !== undefined) {
              if (typeof mark !== 'object' || !MARK_ACTIONS.includes(mark.action)) {
                return json({ ok: false, error: { code: 'bad-request', message: 'action 不合法' } }, 400)
              }
            }
            try {
              const settingsFile = resolveOptions(config).settingsFile
              const next = await setMark(settingsFile, relPath, mark === undefined ? null : mark)
              return json({ ok: true, marks: next })
            } catch (error) {
              return json({ ok: false, error: { code: 'marks-write-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          if (op === 'marksBatch') {
            /**
             * 批量设 / 清标记（v0.13.7）。
             *
             * 一次写入搞定多个卡片，避免「批量确认 20 张 → 20 次读改写」。
             * 仍然是**只改标记文件、绝不改写自动分类**（数据边界）。
             *
             * body: { updates: [{ path, mark }] }  mark 为 null 表示清除
             */
            const updates = Array.isArray(body?.updates) ? body.updates : null
            if (updates === null) {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 updates 数组' } }, 400)
            }
            if (updates.length > 200) {
              return json({ ok: false, error: { code: 'too-many', message: '单次最多 200 条' } }, 400)
            }
            for (const u of updates) {
              if (typeof u?.path !== 'string' || u.path === '') {
                return json({ ok: false, error: { code: 'bad-request', message: 'updates 里有非法 path' } }, 400)
              }
              const m = u.mark
              if (m !== null && m !== undefined) {
                if (typeof m !== 'object' || !MARK_ACTIONS.includes(m.action)) {
                  return json({ ok: false, error: { code: 'bad-request', message: 'action 不合法：' + String(m?.action) } }, 400)
                }
              }
            }
            try {
              const settingsFile = resolveOptions(config).settingsFile
              const next = await setMarksBatch(settingsFile, updates)
              return json({ ok: true, marks: next, applied: updates.length })
            } catch (error) {
              return json({ ok: false, error: { code: 'marks-write-failed', message: String(error?.message ?? error) } }, 500)
            }
          }

          if (op === 'deleteDiscarded') {
            /**
             * 清掉废稿（v0.13.7）—— **永久删除、不进回收站、不可逆**。
             *
             * 安全闸门（缺一不可）：
             *   1. 两阶段：先 dryRun 拿清单，人看完再 confirm 真删
             *   2. 清单一致性：真删时用 digest 校验「删的就是刚才看过的那批」
             *   3. 每批上限 10 个（超过由前端分批，服务端再兜一层）
             *   4. 只删 roots 内的普通文件
             *   5. 绝不删插件自己的数据文件（settings / marks）
             *   6. 删完同步清掉对应 marks，并返回被清的路径供前端清反馈篮
             *
             * body: { paths: string[], dryRun?: boolean, confirm?: boolean, digest?: string }
             */
            const paths = Array.isArray(body?.paths) ? body.paths : null
            if (paths === null || paths.length === 0) {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 paths 数组' } }, 400)
            }
            if (paths.length > 10) {
              return json({
                ok: false,
                error: { code: 'batch-too-large', message: '单批最多 10 个，请分批处理', count: paths.length },
              }, 400)
            }

            const opts = resolveOptions(config)
            const settingsFile = opts.settingsFile
            const marksFile = marksFilePath(settingsFile)
            const forbidden = new Set([settingsFile, marksFile, settingsFile + '.tmp', marksFile + '.tmp'])

            // ---- 逐个解析并校验 ----
            const entries = []
            const rejected = []
            for (const p of paths) {
              const relPath = String(p ?? '')
              if (relPath === '') { rejected.push({ path: relPath, reason: 'empty-path' }); continue }
              let abs
              try {
                abs = path.isAbsolute(relPath) ? relPath : resolveUnderRoots(opts.roots, relPath)
              } catch {
                rejected.push({ path: relPath, reason: 'outside-roots' }); continue
              }
              if (abs === null || abs === undefined) {
                rejected.push({ path: relPath, reason: 'outside-roots' }); continue
              }
              // 插件自身数据文件一律拒绝
              if (forbidden.has(abs)) {
                rejected.push({ path: relPath, reason: 'plugin-data-file' }); continue
              }
              let st
              try {
                st = await fsp.stat(abs)
              } catch {
                rejected.push({ path: relPath, reason: 'not-found' }); continue
              }
              if (!st.isFile()) {
                rejected.push({ path: relPath, reason: 'not-a-file' }); continue
              }
              entries.push({ relPath, absolute: abs, size: st.size })
            }

            // 清单指纹：路径排序后 hash，确保「确认的就是看过的」
            const digestOf = (list) => {
              const h = createHash('sha1')
              for (const e of [...list].map((x) => x.absolute).sort()) h.update(e)
              return h.digest('hex')
            }
            const digest = digestOf(entries)

            // ---- dryRun：只列清单，不动磁盘 ----
            if (body?.dryRun === true) {
              return json({
                ok: true,
                dryRun: true,
                count: entries.length,
                digest,
                files: entries.map((e) => ({ path: e.relPath, absolute: e.absolute, size: e.size })),
                rejected,
              })
            }

            // ---- 真删：必须显式 confirm + digest 一致 ----
            if (body?.confirm !== true) {
              return json({ ok: false, error: { code: 'confirm-required', message: '缺少 confirm 标记' } }, 400)
            }
            if (typeof body?.digest !== 'string' || body.digest !== digest) {
              return json({
                ok: false,
                error: { code: 'digest-mismatch', message: '文件清单已变化（可能被重新扫描或改动），请重新确认' },
              }, 409)
            }

            // ---- 执行删除（任一批失败立即停，不自动重试）----
            const deleted = []
            const failed = []
            for (const e of entries) {
              try {
                await fsp.unlink(e.absolute)
                deleted.push(e.relPath)
              } catch (error) {
                failed.push({ path: e.relPath, reason: String(error?.message ?? error) })
              }
            }

            // ---- 同步清掉这些路径的 marks ----
            let marksLeft = {}
            if (deleted.length > 0) {
              try {
                const cur = await readMarks(settingsFile)
                const next = { ...cur.marks }
                for (const rp of deleted) delete next[rp]
                await writeMarks(settingsFile, next)
                marksLeft = next
              } catch (error) {
                return json({
                  ok: false,
                  error: {
                    code: 'marks-cleanup-failed',
                    message: '文件已删但标记清理失败：' + String(error?.message ?? error),
                    deleted,
                  },
                }, 500)
              }
            }

            // 文件删了，手动标签覆写与截帧登记一并清掉（失败不影响删除结果）
            if (deleted.length > 0) {
              try { await deleteLabels(settingsFile, deleted) } catch { /* 忽略 */ }
              try { await deleteFrames(settingsFile, deleted) } catch { /* 忽略 */ }
            }

            return json({
              ok: failed.length === 0,
              deleted,
              failed,
              rejected,
              marks: marksLeft,
              note: `永久删除 ${deleted.length} 个文件（不进回收站）`,
            })
          }

          if (op === 'reveal') {
            /**
             * 在资源管理器里定位 / 用系统程序打开。
             *
             * ⚠️ 历史坑（v0.13.5 及以前，「打开所在文件夹」一律打开「文档」）：
             *   旧实现 spawn('cmd.exe', ['/c','start','','explorer.exe', `/select,"${abs}"`])
             *   手写的双引号经 Node spawn 的自动 quoting + cmd start 两层转义后
             *   **残留在路径里**，explorer 实际收到 `/select,"G:\...png"` —— 引号成了字面字符，
             *   解析失败 → 回退打开默认位置「文档」。与文件名/类型/空格无关，三类资产全中。
             *
             * 修法：**不再手工加引号、不经 cmd 中转**，直接 spawn 目标程序，
             *   让 Node 自己处理空格与中文的 quoting（实测 argv 干净）。
             *
             * 另：不再用退出码当「已定位到」的证据 ——
             *   explorer 参数无效时 cmd 照样退出 0，那是**假成功**。
             *   现在语义是「命令已发出」，返回体带 absolute / via / platform 供排查。
             */
            LOG_RESOLVE('reveal: 开始', { path: body?.path, mode: body?.mode })

            // 定位文件不该受大小限制 —— 只校验存在 + 是否文件 + 路径越界。
            // 传 Infinity 让 resolveReadable 的 size 检查失效（它只跳过 size > cap 的项）。
            const found = await resolveReadable(resolved.roots, body?.path, resolved, Number.MAX_SAFE_INTEGER)
            if (found === null) {
              return json({ ok: false, error: { code: 'not-readable', message: '文件不存在或不可读' } }, 404)
            }

            // mode: 'select' 在文件夹里选中文件；'play' 用默认程序打开（对媒体更直接）
            const mode = body?.mode === 'play' ? 'play' : 'select'
            const absolute = found.absolute

            try {
              const { spawn } = await import('node:child_process')
              let child
              let via
              let command

              if (process.platform === 'win32') {
                if (mode === 'play') {
                  // 直接 spawn 文件本身，由 shell 按文件关联打开 —— 不经 cmd start。
                  // detached:true 让宿主不等待；shell 会交给关联程序。
                  via = 'win32-file-association'
                  command = absolute
                  // 同样不要 windowsHide（否则播放器窗口也可能不显示）
                  child = spawn(absolute, [], {
                    detached: true, stdio: 'ignore',
                  })
                } else {
                  // explorer /select：**路径不加引号**，交给 Node 的 spawn 自动 quoting。
                  // argv 实测为 `/select,G:\DSH产出\...\x.png`（干净，无字面引号）。
                  via = 'win32-explorer-select'
                  command = `explorer.exe /select,${absolute}`
                  // ⚠️ **不要加 windowsHide**：实测它会抑制 explorer 的窗口显示
                  // （变量隔离：windowsHide:true → 窗口 0→0 不开；false/不设 → 0→1 正常）。
                  // reveal 的目的就是让用户看见窗口，隐藏它等于没做。
                  child = spawn('explorer.exe', [`/select,${absolute}`], {
                    detached: true, stdio: 'ignore',
                  })
                }
              } else if (process.platform === 'darwin') {
                if (mode === 'play') {
                  via = 'darwin-open'
                  command = `open ${absolute}`
                  child = spawn('open', [absolute], { detached: true, stdio: 'ignore' })
                } else {
                  // macOS 用 -R 才能真正在 Finder 里选中文件（xdg/open 目录做不到选中）
                  via = 'darwin-open-reveal'
                  command = `open -R ${absolute}`
                  child = spawn('open', ['-R', absolute], { detached: true, stdio: 'ignore' })
                }
              } else {
                // Linux: 没有通用的「选中文件」协议，只能打开所在目录
                via = mode === 'play' ? 'linux-xdg-open-file' : 'linux-xdg-open-dir'
                const target = mode === 'play' ? absolute : path.dirname(absolute)
                command = `xdg-open ${target}`
                child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' })
              }

              // 观察 800ms 内的 spawn 错误；**不拿退出码当成功证据**
              const outcome = await new Promise((resolve) => {
                let settled = false
                const done = (payload) => {
                  if (settled) return
                  settled = true
                  resolve(payload)
                }
                child.on('error', (error) => done({
                  ok: false,
                  code: 'spawn-error',
                  message: String(error?.message ?? error),
                }))
                child.on('exit', (code, signal) => {
                  // 退出码只作为附加信息回报；explorer/cmd/open 都会把活交出去后立即退出，
                  // 退出码并不能证明「已定位到文件」。真正的验证由真机做（看窗口）。
                  done({ ok: true, exitCode: code, signal })
                })
                setTimeout(() => done({ ok: true, note: 'assumed-dispatched-after-800ms' }), 800)
              })

              if (child !== undefined && typeof child.unref === 'function') {
                try { child.unref() } catch { /* 忽略 */ }
              }

              if (!outcome.ok) {
                return json({
                  ok: false,
                  error: {
                    code: outcome.code ?? 'reveal-failed',
                    message: outcome.message ?? '命令未发出',
                    mode, via, command, absolute,
                  },
                }, 500)
              }

              // 成功语义 = 命令已发出；把 absolute / via / command 一并返回便于排查
              return json({
                ok: true,
                mode,
                via,
                platform: process.platform,
                absolute,
                basename: path.basename(absolute),
                dirname: path.dirname(absolute),
                command,
                detail: outcome,
              })
            } catch (error) {
              return json({
                ok: false,
                error: {
                  code: 'reveal-failed',
                  message: String(error?.message ?? error),
                  mode,
                },
                absolute,
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

              // 单文件删除：同步清掉截帧登记，避免残留孤儿记录
              try { await deleteFrames(opts.settingsFile, [rel]) } catch { /* 忽略 */ }

              return json({ ok: true, deleted: found.absolute })

            } catch (error) {

              return json({ ok: false, error: { code: 'delete-failed', message: String(error?.message ?? error) } }, 500)

            }

          }



          // ---- v0.16.0 粘贴 / 裁剪：把外部素材或派生资产落进当前对话目录 ----

          /**
           * 按绝对路径找它所属的产出根（多根环境必备）。
           *
           * 以前一律取 `roots[0]` 算 relPath：粘贴目标在第二个根（G:/DSH任务文件）时，
           * 算出来的相对路径会变成 `../DSH任务文件/xxx`，登记与列表全都对不上。
           * 找不到返回空串，调用方按「无法归属」处理。
           */
          function rootOfAbs(roots, abs) {
            const list = Array.isArray(roots) ? roots : []
            // 两侧都归一成平台路径再比：配置里常写正斜杠，落盘路径是反斜杠，
            // isInside 只做字符串前缀判断，不归一就会把同一条路径判成根外。
            const target = path.resolve(abs)
            for (const r of list) {
              if (typeof r === 'string' && r !== '' && isInside(path.resolve(r), target)) return r
            }
            return ''
          }

          /**
           * 由 sessionId 解析「这次要落进去的对话目录」（绝对路径），拿不到返回 null。
           *
           * v0.16.2 起调用方不一定传当前对话：全局视图里在别组的资产区粘贴/裁剪，
           * 前端会把**那个组**的 sessionId 传进来，这里就落到它的工作目录。
           *
           * 目录选择顺序（都很保守，宁可返回 null 也不凭空造目录）：
           *   ① `sessionDirsAbs` 里**已存在**的目录（带 root，跨产出根不会拼错）；
           *   ② 相对路径 + 本 root 拼出来的目录（旧行为，会话目录被清掉时靠 mkdir 恢复）。
           */
          async function resolveSessionDir(config, sessionId) {
            if (typeof sessionId !== 'string' || sessionId === '') return null
            const opts = resolveOptions(config)
            let scope
            try { scope = await resolveSessionScope(config, sessionId, opts.roots) } catch { return null }
            if (!scope?.ok) return null
            const roots = (opts.roots ?? []).filter((r) => typeof r === 'string' && r !== '')
            if (roots.length === 0) return null
            const absDirs = (scope.sessionDirsAbs ?? [])
              .map((d) => String(d ?? ''))
              .filter((d) => d !== '')
              .map((d) => path.resolve(d))
              // 同上：正/反斜杠混用时 isInside 会误判，两侧都先归一
              .filter((d) => roots.some((r) => isInside(path.resolve(r), d)))
            for (const abs of absDirs) {
              try { if ((await fsp.stat(abs)).isDirectory()) return abs } catch { /* 目录不在，试下一个 */ }
            }
            const dirs = (scope.sessionDirs ?? []).map((d) => String(d)).filter((d) => d !== '')
            if (dirs.length === 0) return null
            const root = roots[0]
            const abs = path.resolve(root, dirs[0])
            if (!isInside(root, abs)) return null
            return abs
          }

          /**
           * 读会话标题 / 创建时间（派生资产登记用）。
           *
           * 为什么 Host 自己读、不靠前端传：粘贴走 document 级监听、裁剪走
           * MediaPlayer 内部按钮，两处拿「当前对话组」的上下文方式不同，
           * 前端每处都传一遍容易漏；这里按 sessionId 统一兜底，
           * 前端传了就更优先（个别对话日志缺失时仍能正确归组）。
           *
           * 读不到就返回空标题 / 0，不抛错 —— 归组只靠 sessionId，
           * 标题缺失最多退化成 sessionId 前 8 位，绝不能因此让粘贴失败。
           */
          async function sessionMetaOf(config, sessionId) {
            const meta = { title: '', createdAt: 0 }
            if (typeof sessionId !== 'string' || sessionId === '') return meta
            const sessionsDir = typeof config?.sessionsDir === 'string' && config.sessionsDir !== ''
              ? path.resolve(config.sessionsDir)
              : DEFAULT_SESSIONS_DIR
            try {
              const dir = await locateSessionDir(sessionsDir, sessionId)
              if (dir === null) return meta
              try { meta.createdAt = (await fsp.stat(dir)).birthtimeMs || 0 } catch { /* 忽略 */ }
              // v4 会话日志是 zstd 分帧，readSessionLogText 逐帧解压 + 按 mtime 缓存。
              // 解压后实测 390 万字符，标题事件位置不固定（本次在第 9.8 万字符处），
              // 所以用不 split 全文的 extractSessionTitleFast，别在粘贴热路径上白烧内存。
              const text = await readSessionLogText(path.join(dir, 'session.v4.jsonl.zstd'))
              meta.title = extractSessionTitleFast(text)
            } catch { /* 会话目录不可读就当没有标题 */ }
            return meta
          }

          /**
           * 登记派生资产（粘贴 / 裁剪）到 frames.json，让它挂回产出它的对话。
           *
           * 🔴 不登记会发生什么（2026-11-13 老板实测）：文件确实落盘了，但全局资产
           * 视图按「会话日志里出现过的路径」分组，日志里没有这条 → 掉进「未归类」
           * （5000+ 条的历史池底部），界面上等于「粘贴/裁剪没生成」。同一份登记
           * 同时解决「归到当前对话」和「自动标素材(input)」两件事。
           *
           * 登记失败不回滚文件：宁可归组不准，也不能让老板刚粘的素材凭空消失。
           */
          async function registerDerivedAsset(opts, entry) {
            try {
              await registerFrame(opts.settingsFile, {
                relPath: entry.relPath,
                kind: entry.kind,
                // 粘贴进来的外部素材、裁剪出的片段一律算「素材」(input)
                category: 'input',
                sessionId: entry.sessionId,
                sessionTitle: entry.sessionTitle ?? '',
                sessionCreatedAt: entry.sessionCreatedAt ?? 0,
                sourceRelPath: entry.sourceRelPath ?? '',
                sourceName: entry.sourceName ?? '',
                savedAt: Date.now(),
              })
              return true
            } catch { return false }
          }


          /** 探测本机 ffmpeg；优先固定安装路径，其次 PATH；都没有返回 null。 */
          async function findFfmpeg() {
            const candidates = [
              'G:/Program Files/ffmpeg/bin/ffmpeg.exe',
              'G:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe',
            ]
            for (const c of candidates) {
              try {
                const abs = path.resolve(c)
                await fsp.access(abs, 0)
                return abs
              } catch { /* 换下一个 */ }
            }
            return 'ffmpeg'
          }

          /** 跑一次 ffmpeg，收集 stderr 便于失败定位；非 0 退出码视为失败。 */
          function runFfmpeg(ffmpeg, args) {
            return new Promise((resolve, reject) => {
              let child
              try { child = spawn(ffmpeg, args, { windowsHide: true }) } catch (err) { reject(err); return }
              let stderr = ''
              child.stderr?.on('data', (d) => { stderr += String(d) })
              child.on('error', (err) => reject(err))
              child.on('close', (code) => {
                if (code === 0) resolve()
                else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-800)))
              })
            })
          }

          async function resolveSourceUnderRoots(opts, relPath) {
            for (const root of opts.roots) {
              if (typeof root !== 'string' || root === '') continue
              const abs = path.resolve(root, relPath)
              if (!isInside(root, abs)) continue
              try { const st = await fsp.stat(abs); if (st.isFile()) return { abs, ownerRoot: root } } catch { /* 换下一个 */ }
            }
            return null
          }

          /** 在目标目录里找一个不重名的名字（重复时加 -n）。 */
          async function uniqueName(dir, base) {
            let name = base
            let abs = path.join(dir, name)
            let n = 2
            while (n <= 999) {
              let exists = true
              try { await fsp.access(abs) } catch { exists = false }
              if (!exists) break
              name = bumpName(base, n)
              abs = path.join(dir, name)
              n += 1
            }
            return { name, abs }
          }

          // ---- 粘贴图片（剪贴板里的位图 / 截图，统一 PNG） ----
          if (op === 'pasteImage') {
            const opts = resolveOptions(config)
            const sessionId = String(body?.sessionId ?? '')
            const data = typeof body?.data === 'string' ? body.data : ''
            const ext = (typeof body?.ext === 'string' && body.ext !== '') ? body.ext : 'png'
            if (data === '') {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少图片数据' } }, 400)
            }
            const buf = pngBufferFrom(data)
            if (buf === null) {
              return json({ ok: false, error: { code: 'bad-png', message: '图片数据为空、超过 24 MB 或非 PNG' } }, 400)
            }
            const dir = await resolveSessionDir(config, sessionId)
            if (dir === null) {
              return json({ ok: false, error: { code: 'no-session-dir', message: '无法确定当前对话目录' } }, 400)
            }
            const { name, abs } = await uniqueName(dir, makeDerivedName('粘贴', ext))
            const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}`
            try {
              await fsp.mkdir(dir, { recursive: true })
              await fsp.writeFile(tmp, buf)
              await fsp.rename(tmp, abs)
            } catch (error) {
              try { await fsp.rm(tmp, { force: true }) } catch { /* 忽略 */ }
              return json({ ok: false, error: { code: 'paste-write-failed', message: String(error?.message ?? error) } }, 500)
            }
            // v0.16.2：按落盘位置找所属根，多根环境不能赌 roots[0]
            const root = rootOfAbs(opts.roots, abs)
            const relPath = root === '' ? '' : path.relative(root, abs).split(path.sep).join('/')
            // 登记归属，否则全局资产会把这张图扔进 5000+ 条的「未归类」池底部
            const meta = await sessionMetaOf(config, sessionId)
            const registered = await registerDerivedAsset(opts, {
              relPath, kind: 'paste', sessionId,
              sessionTitle: String(body?.sessionTitle ?? '') || meta.title,
              sessionCreatedAt: Number(body?.sessionCreatedAt) || meta.createdAt,
            })
            listCache.clear()
            return json({ ok: true, relPath, absPath: abs, name, registered })
          }

          // ---- 粘贴文件（剪贴板里复制的文件，Electron 给真实路径） ----
          if (op === 'pasteFile') {
            const opts = resolveOptions(config)
            const sessionId = String(body?.sessionId ?? '')
            const src = String(body?.srcPath ?? '').replace(/\\/g, '/')
            const hint = typeof body?.name === 'string' && body.name !== '' ? body.name : null
            if (src === '') {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少源文件路径' } }, 400)
            }
            const srcAbs = path.resolve(src)
            let srcStat
            try { srcStat = await fsp.stat(srcAbs) } catch {
              return json({ ok: false, error: { code: 'src-not-found', message: '源文件不存在' } }, 404)
            }
            if (!srcStat.isFile()) {
              return json({ ok: false, error: { code: 'bad-request', message: '源路径不是文件' } }, 400)
            }
            if (srcStat.size > 2 * 1024 * 1024 * 1024) {
              return json({ ok: false, error: { code: 'too-large', message: '文件超过 2 GB，粘贴被拒绝' } }, 400)
            }
            const dir = await resolveSessionDir(config, sessionId)
            if (dir === null) {
              return json({ ok: false, error: { code: 'no-session-dir', message: '无法确定当前对话目录' } }, 400)
            }
            const base = (hint ?? path.basename(srcAbs)).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim() || 'file'
            const { name, abs } = await uniqueName(dir, base)
            try {
              await fsp.mkdir(dir, { recursive: true })
              await fsp.copyFile(srcAbs, abs)
              // 🔴 与 pasteFiles 同口径：Windows CopyFile 保留源 mtime，画廊按时间窗过滤，
              // 不刷新会让刚粘进来的旧素材在 global 视图里「消失」。粘贴 = 现在进入本对话。
              try { const now = new Date(); await fsp.utimes(abs, now, now) } catch { /* 忽略 */ }
            } catch (error) {
              return json({ ok: false, error: { code: 'paste-write-failed', message: String(error?.message ?? error) } }, 500)
            }
            // v0.16.2：按落盘位置找所属根，多根环境不能赌 roots[0]
            const root = rootOfAbs(opts.roots, abs)
            const relPath = root === '' ? '' : path.relative(root, abs).split(path.sep).join('/')
            // 与 pasteImage 同口径：登记归属，否则全局资产看不到这条粘贴
            const meta = await sessionMetaOf(config, sessionId)
            const registered = await registerDerivedAsset(opts, {
              relPath, kind: 'paste', sessionId,
              sessionTitle: String(body?.sessionTitle ?? '') || meta.title,
              sessionCreatedAt: Number(body?.sessionCreatedAt) || meta.createdAt,
            })
            listCache.clear()
            return json({ ok: true, relPath, absPath: abs, name, registered })
          }

          // ---- v0.16.0 复制资产到系统剪贴板（单文件右键 / 批量选择共用） ----
          // 只接收 roots 内的相对路径，由 Host 解析绝对路径，前端不拼路径、防穿越。
          if (op === 'copyAssets') {
            const opts = resolveOptions(config)
            const rels = Array.isArray(body?.paths) ? body.paths : []
            const absList = []
            const missed = []
            for (const rp of rels.slice(0, 200)) {
              const rel = String(rp ?? '').replace(/\\/g, '/')
              if (rel === '') continue
              const found = await resolveSourceUnderRoots(opts, rel)
              if (found === null) missed.push(rel)
              else absList.push(found.abs)
            }
            if (absList.length === 0) {
              return json({ ok: false, error: { code: 'copy-no-source', message: '选中的文件都不在扫描根目录内' } }, 400)
            }
            const result = await writeClipboardFilePaths(absList)
            return json({ ok: true, count: result.count, mode: result.mode, missed })
          }

          // ---- v0.16.0 读系统剪贴板里的文件列表（音视频 / 任意文件粘贴用） ----
          // Chromium 的 paste 事件拿不到「资源管理器复制的文件」，只能从这里补。
          // 系统剪贴板没有文件列表时，退回插件内部剪贴板（复制→粘贴仍闭环）。
          if (op === 'clipboardFiles') {
            let paths = await readClipboardFilePaths()
            let mode = 'system'
            if (paths.length === 0) {
              paths = internalClipboardPaths()
              mode = 'internal'
            }
            const files = []
            for (const p of paths.slice(0, 200)) {
              const abs = path.resolve(String(p ?? '').replace(/\\/g, '/'))
              try {
                const st = await fsp.stat(abs)
                if (!st.isFile()) continue
                files.push({ path: abs, name: path.basename(abs), size: st.size })
              } catch { /* 剪贴板可能残留已删除的路径，跳过 */ }
            }
            return json({ ok: true, files, mode })
          }

          // ---- v0.16.0 批量把外部文件复制进当前对话目录（任意类型，含音视频） ----
          // 与 pasteFile 同口径：2GB 上限、重名自增、原子目标不覆盖原件、自动标「素材」。
          if (op === 'pasteFiles') {
            const opts = resolveOptions(config)
            const sessionId = String(body?.sessionId ?? '')
            const srcs = Array.isArray(body?.srcPaths) ? body.srcPaths : []
            const dir = await resolveSessionDir(config, sessionId)
            if (dir === null) {
              return json({ ok: false, error: { code: 'no-session-dir', message: '无法确定当前对话目录' } }, 400)
            }
            // v0.16.2：粘贴目标可能是别组、也可能是另一个产出根，按目录找根
            const root = rootOfAbs(opts.roots, dir)
            const { files: okFiles, failed } = await pasteFilesIntoDir(srcs, dir, root)
            if (okFiles.length > 0) {
              // 每个落盘文件都要单独登记（批量粘贴可能一次进来十几个）
              const meta = await sessionMetaOf(config, sessionId)
              const sessionTitle = String(body?.sessionTitle ?? '') || meta.title
              const sessionCreatedAt = Number(body?.sessionCreatedAt) || meta.createdAt
              for (const f of okFiles) {
                f.registered = await registerDerivedAsset(opts, {
                  relPath: f.relPath, kind: 'paste', sessionId, sessionTitle, sessionCreatedAt,
                })
              }
              listCache.clear()
            }
            if (okFiles.length === 0) {
              return json({
                ok: false,
                error: { code: 'paste-files-failed', message: failed[0]?.message ?? '没有可粘贴的文件' },
                files: [], failed,
              }, 500)
            }
            return json({ ok: true, files: okFiles, failed })
          }

          // ---- 裁剪图片（前端已按框裁好 PNG，写源同目录） ----
          if (op === 'cropImage') {
            const opts = resolveOptions(config)
            const imageRel = String(body?.path ?? '').replace(/\\/g, '/')
            const data = typeof body?.data === 'string' ? body.data : ''
            if (imageRel === '' || data === '') {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 path 或 data' } }, 400)
            }
            const buf = pngBufferFrom(data)
            if (buf === null) {
              return json({ ok: false, error: { code: 'bad-png', message: '图片数据为空、超过 24 MB 或非 PNG' } }, 400)
            }
            const src = await resolveSourceUnderRoots(opts, imageRel)
            if (src === null) {
              return json({ ok: false, error: { code: 'image-not-found', message: '源图不在扫描目录内' } }, 404)
            }
            const dir = path.dirname(src.abs)
            const imageName = path.basename(src.abs)
            const { name, abs } = await uniqueName(dir, makeDerivedName('裁剪-' + imageName.replace(/\.[^.]+$/, ''), 'png'))
            const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}`
            try {
              await fsp.mkdir(dir, { recursive: true })
              await fsp.writeFile(tmp, buf)
              await fsp.rename(tmp, abs)
            } catch (error) {
              try { await fsp.rm(tmp, { force: true }) } catch { /* 忽略 */ }
              return json({ ok: false, error: { code: 'crop-write-failed', message: String(error?.message ?? error) } }, 500)
            }
            const relPath = path.relative(src.ownerRoot, abs).split(path.sep).join('/')
            // 登记归属：裁剪产物同样不在会话日志里，不登记会掉进「未归类」
            const sessionId = String(body?.sessionId ?? '')
            const meta = await sessionMetaOf(config, sessionId)
            const registered = await registerDerivedAsset(opts, {
              relPath, kind: 'crop', sessionId,
              sessionTitle: String(body?.sessionTitle ?? '') || meta.title,
              sessionCreatedAt: Number(body?.sessionCreatedAt) || meta.createdAt,
              sourceRelPath: imageRel,
              sourceName: imageName,
            })
            listCache.clear()
            return json({ ok: true, relPath, absPath: abs, name, registered })
          }

          // ---- 裁剪音视频（Host 调 ffmpeg 流拷贝切段，落源同目录） ----
          if (op === 'cropMedia') {
            const opts = resolveOptions(config)
            const mediaRel = String(body?.path ?? '').replace(/\\/g, '/')
            const start = Number(body?.start)
            const end = Number(body?.end)
            const kind = String(body?.kind ?? 'video')
            if (mediaRel === '' || !Number.isFinite(start) || !Number.isFinite(end)) {
              return json({ ok: false, error: { code: 'bad-request', message: '缺少 path 或起止时间' } }, 400)
            }
            if (start < 0 || end <= start) {
              return json({ ok: false, error: { code: 'bad-request', message: '起止时间不合法（结束须大于开始）' } }, 400)
            }
            const src = await resolveSourceUnderRoots(opts, mediaRel)
            if (src === null) {
              return json({ ok: false, error: { code: 'media-not-found', message: '源音视频不在扫描目录内' } }, 404)
            }
            const ffmpeg = await findFfmpeg()
            if (ffmpeg === null) {
              return json({ ok: false, error: { code: 'ffmpeg-missing', message: '未找到 ffmpeg，无法裁剪音视频' } }, 500)
            }
            const mediaName = path.basename(src.abs)
            const srcExt = path.extname(mediaName).replace(/^\./, '').toLowerCase()
            const outExt = srcExt || (kind === 'audio' ? 'mp3' : 'mp4')
            const { name, abs: outAbs } = await uniqueName(path.dirname(src.abs), makeDerivedName('裁剪-' + mediaName.replace(/\.[^.]+$/, ''), outExt))
            // 🔴 临时文件**必须保留扩展名**：ffmpeg 靠扩展名推断输出容器，
            // 写成 `xxx.mp4.tmp-123` 会报 "Unable to choose an output format" → HTTP 500。
            // 命名规则抽到 derive.tmpPathFor，测试直接打真函数，防止再次漂移。
            const tmpAbs = tmpPathFor(outAbs)
            let mode = 'copy'
            try {
              await fsp.mkdir(path.dirname(outAbs), { recursive: true })
              // 核心策略在 host/trim.js：先流拷贝，再用 ffprobe 校验时长，偏差 > 0.5s 才重编码。
              // 抽出去是为了能对真 ffmpeg 做集成测试（copy 只认关键帧这点必须实测才发现）。
              const result = await cropMediaFile({
                ffmpeg, src: src.abs, start, end, out: tmpAbs, outExt, kind,
              })
              mode = result.mode
              await fsp.rename(tmpAbs, outAbs)
            } catch (error) {
              try { await fsp.rm(tmpAbs, { force: true }) } catch { /* 忽略 */ }
              return json({ ok: false, error: { code: 'crop-failed', message: String(error?.message ?? error) } }, 500)
            }
            const relPath = path.relative(src.ownerRoot, outAbs).split(path.sep).join('/')
            // 与 cropImage 同口径：音视频片段也要挂回产出它的对话
            const sessionId = String(body?.sessionId ?? '')
            const meta = await sessionMetaOf(config, sessionId)
            const registered = await registerDerivedAsset(opts, {
              relPath, kind: 'crop', sessionId,
              sessionTitle: String(body?.sessionTitle ?? '') || meta.title,
              sessionCreatedAt: Number(body?.sessionCreatedAt) || meta.createdAt,
              sourceRelPath: mediaRel,
              sourceName: mediaName,
            })
            listCache.clear()
            return json({ ok: true, relPath, absPath: outAbs, name, start, end, mode, registered })
          }

          return json({ ok: false, error: { code: 'unknown-op', message: `未知操作：${op}` } }, 400)

        },

      }),

    'dsh-gallery: api route',

  )
}
