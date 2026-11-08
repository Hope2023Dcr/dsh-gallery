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
import path from 'node:path'

import { ROUTE, MEDIA_ROUTE } from './constants.js'
import { isInside } from './fsutil.js'
import {
  resolveOptions, readSettingsFile, readHiddenList,
  validateRootCandidate, readSettingsPayload,
} from './settings.js'
import { scanGallery } from './scan.js'
import { resolveReadable, serveMedia, contentTypeFor } from './media.js'
import { MARK_ACTIONS, readMarks, writeMarks, setMark } from './marks.js'

/** reveal 相关的排查日志（失败/异常时便于定位，不影响功能）。 */
function LOG_RESOLVE(label, detail) {
  if (process.env.DSH_GALLERY_DEBUG === '1') {
    try { console.info('dsh-gallery ' + label, JSON.stringify(detail)) } catch { /* 忽略 */ }
  }
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

          // ---- 标记（S3-a）----
          if (op === 'getMarks') {
            const settingsFile = resolveOptions(config).settingsFile
            const stored = await readMarks(settingsFile)
            return json({ ok: true, marks: stored.marks })
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
