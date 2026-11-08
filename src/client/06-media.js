    function MediaCard({ item, t, absPath, onPlay, onContextMenu }) {
      const isVideo = item.mediaType === 'video'
      const [thumb, setThumb] = React.useState(null)
      const nodeRef = React.useRef(null)
      const startedRef = React.useRef(false)

      React.useEffect(() => {
        if (!isVideo) return undefined
        const node = nodeRef.current
        const run = () => { void makeFirstFrame() }
        if (node === null || typeof IntersectionObserver !== 'function') {
          run()
          return undefined
        }
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            observer.disconnect()
            run()
          }
        }, { rootMargin: '120px' })
        observer.observe(node)
        return () => observer.disconnect()

        async function makeFirstFrame() {
          if (startedRef.current) return
          startedRef.current = true
          setThumb({ status: 'pending' })
          // 缩略图只取首帧，不需要 seek —— 用直链即可（blob 只用于播放器那侧）。
          const url = mediaUrlOf(item.relPath, item.mtime)
              const video = document.createElement('video')
          video.muted = true
          video.playsInline = true
          video.preload = 'metadata'
          let settled = false
          let timer = null
          const cleanup = () => {
            video.removeAttribute('src')
            try { video.load() } catch {}
          }
          const fail = (reason) => {
            if (settled) return
            settled = true
            if (timer !== null) clearTimeout(timer)
            cleanup()
            setThumb({ status: 'failed', message: reason })
          }
          const finish = () => {
            if (settled) return
            settled = true
            if (timer !== null) clearTimeout(timer)
            try {
              const w = video.videoWidth
              const h = video.videoHeight
              if (w === 0 || h === 0) throw new Error('empty-frame')
              const maxEdge = 320
              const scale = Math.min(1, maxEdge / Math.max(w, h))
              const cw = Math.max(1, Math.round(w * scale))
              const ch = Math.max(1, Math.round(h * scale))
              const canvas = document.createElement('canvas')
              canvas.width = cw
              canvas.height = ch
              const c2d = canvas.getContext('2d')
              if (c2d === null) throw new Error('no-2d-context')
              c2d.drawImage(video, 0, 0, cw, ch)
              setThumb({ status: 'ready', url: canvas.toDataURL('image/jpeg', 0.8) })
            } catch (error) {
              setThumb({ status: 'failed', message: String(error?.message ?? error) })
            } finally {
              cleanup()
            }
          }
          timer = setTimeout(() => fail('timeout'), 12000)
          video.onloadeddata = () => {
            try {
              video.currentTime = Math.min(0.5, (video.duration || 1) * 0.15)
            } catch { finish() }
          }
          video.onseeked = () => finish()
          video.onerror = () => fail('decode-error')
          video.src = url
        }
        // 兜底：makeFirstFrame 是 async，任何未捕获异常都会变成 unhandledrejection，
        // 那会污染整页的控制台（实测每次卡片进视口抛一次）。统一在此吞掉并标记失败。
        void makeFirstFrame().catch((error) => {
          console.warn('dsh-gallery: 首帧抽取失败', error)
          setThumb({ status: 'failed', message: String(error?.message ?? error) })
        })
      }, [item.relPath, item.mtime, isVideo])

      const badge = (item.extension ?? '').replace(/^\./, '').toUpperCase().slice(0, 4)
      const meta = `${formatBytes(item.size)} · ${formatTime(item.mtime)}`

      return h('div', {
        ref: nodeRef,
        className: `dg-card dg-mediaCard${isVideo ? ' dg-mediaVideo' : ' dg-mediaAudio'}`,
        role: 'button',
        tabIndex: 0,
        title: `${item.name}\n${absPath}\n${t('mediaOpenHint')}`,
        'data-gallery-media': item.relPath,
        'data-gallery-media-type': item.mediaType ?? '',
        onClick: () => onPlay(item),
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (typeof onContextMenu === 'function') onContextMenu(item, absPath, event)
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onPlay(item)
          }
        },
      }, [
        h('div', { className: 'dg-mediaThumb', key: 'thumb' }, (
          thumb !== null && thumb.status === 'ready'
            ? h('img', { src: thumb.url, alt: item.name, key: 'img', loading: 'lazy' })
            : h('span', {
                className: `dg-mediaPlaceholder${thumb !== null && thumb.status === 'failed' ? ' dg-mediaFail' : ''}`,
                key: 'ph',
              }, thumb === null ? (isVideo ? '🎞' : '♪')
                : thumb.status === 'pending' ? t('mediaThumbPending')
                  : (isVideo ? '🎞' : '♪'))
        )),
        h('span', { className: 'dg-mediaPlayIco', key: 'play' }, '▶'),
        h('span', { className: 'dg-mediaBadge', key: 'badge' }, badge),
        h('div', { className: 'dg-mediaMeta', key: 'meta' }, [
          h('span', { className: 'dg-mediaName', key: 'n' }, item.name),
          h('span', { className: 'dg-mediaSub', key: 's' }, meta),
        ]),
      ])
    }

    /**
     * 面板内媒体播放器（弹层）。
     * 视频 <video>、音频 <audio>，都指向 MEDIA_ROUTE 的 GET 直链（支持 Range，可拖进度）。
     */
    /**
     * 面板内媒体播放器（v0.10.3 分档方案）。
     *
     * 背景：DSH 的 exact fetch 层不支持 HTTP 206 / content-range（已实证：官方 /api/file 也只返 200）。
     * 没有 Range，`<video src=URL>` 就无法拖动进度条。
     *
     * 所以分两档：
     *   ≤ BLOB_MAX_BYTES（60MB）：用 POST raw 把完整文件取成 Blob，再 createObjectURL。
     *      blob 是完整数据在内存里，浏览器原生支持任意拖动，**不需要 Range**。
     *   > BLOB_MAX_BYTES：文件太大，不塞进内存；提示改用系统播放器（走 reveal op）。
     *
     * 这样「能播 + 能拖」在常规大小的产出上都成立，超大文件也不至于把面板搞崩。
     */
    /**
     * 面板内媒体播放器（v0.11.0：真 Range）。
     *
     * Host 侧现在用 ctx.webServer.register 注册了支持 206 的路由，
     * 所以 <video src=URL> 直接就能：
     *   - 拖进度条（浏览器发 Range，宿主按 206 分片回）
     *   - 边下边播（不预先载入整个文件）
     *   - 内存占用恒定（流式，不占文件大小的内存）
     *
     * 因此不再需要 blob 方案，也不再需要 60MB 分档 —— 任意大小都能播。
     */
    function MediaPlayer({ item, t, onClose }) {
      const isVideo = item.mediaType === 'video'
      const videoRef = React.useRef(null)
      const blobUrlRef = React.useRef(null)
      /**
       * 播放源状态。
       *
       * 为什么不用 mediaUrlOf 直链？—— DSH 桌面宿主转发响应时会剥掉
       * content-length（lib/main.js 的 WITHHELD_RESPONSE_HEADERS），
       * Chromium 拿不到总大小 → <video>.seekable 恒为 [0,0] → 进度条拖不动。
       * 实测：4 个视频（含 212s / 127MB）全部复现，而同一 URL 用 fetch 带 Range
       * 能拿到 206 + Content-Range，说明 Host 路由没问题，是协议层丢了长度。
       *
       * 改用 blob：POST op:'raw' 取完整字节（走 /api 网关，不经 dsh-app 媒体管线），
       * createObjectURL 后作为 src —— 完整数据在内存，seekable 覆盖全长。
       */
      const [source, setSource] = React.useState({ status: 'loading', url: null, pct: -1, message: '' })
      const [failed, setFailed] = React.useState(false)
      const [dims, setDims] = React.useState(null)
      // 截帧结果提示（成功/失败），2.5 秒自动消失
      const [grabNotice, setGrabNotice] = React.useState(null)

      // 取回完整文件为 blob 并建 URL（支持 seek 的唯一可靠路径）
      React.useEffect(() => {
        let alive = true
        const controller = new AbortController()
        setSource({ status: 'loading', url: null, pct: -1, message: '' })

        fetchRaw(item.relPath, controller.signal, (loaded, total) => {
          if (!alive) return
          const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : -1
          setSource((cur) => (cur.status === 'loading' ? { ...cur, pct } : cur))
        })
          .then((blob) => {
            if (!alive) return
            if (blob.size === 0) throw new Error('empty file')
            const url = URL.createObjectURL(blob)
            blobUrlRef.current = url
            setSource({ status: 'ready', url, pct: 100, message: '' })
          })
          .catch((error) => {
            if (!alive) return
            if (error?.name === 'AbortError') return
            setSource({ status: 'failed', url: null, pct: -1, message: String(error?.message ?? error) })
          })

        return () => {
          alive = false
          controller.abort()
          if (blobUrlRef.current !== null) {
            URL.revokeObjectURL(blobUrlRef.current)
            blobUrlRef.current = null
          }
        }
      }, [item.relPath, item.mtime])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const openExternal = React.useCallback(() => {
        setGrabNotice({ kind: 'pending', text: '正在打开…' })
        void callHost('reveal', { path: item.relPath, mode: 'play' }).then((resp) => {
          if (resp !== null && resp.ok === false) {
            setGrabNotice({
              kind: 'failed',
              text: format(t('mediaOpenFailed'), { message: resp.error?.code ?? 'unknown' }),
            })
            return
          }
          setGrabNotice({ kind: 'ok', text: t('mediaOpenOk') })
        }).catch((error) => {
          setGrabNotice({
            kind: 'failed',
            text: format(t('mediaOpenFailed'), { message: String(error?.message ?? error) }),
          })
        })
      }, [item.relPath, t])

      const openFolder = React.useCallback(() => {
        setGrabNotice({ kind: 'pending', text: '正在定位…' })
        void callHost('reveal', { path: item.relPath, mode: 'select' }).then((resp) => {
          if (resp !== null && resp.ok === false) {
            setGrabNotice({
              kind: 'failed',
              text: format(t('mediaOpenFailed'), { message: resp.error?.code ?? 'unknown' }),
            })
            return
          }
          setGrabNotice({ kind: 'ok', text: t('mediaOpenOk') })
        }).catch((error) => {
          setGrabNotice({
            kind: 'failed',
            text: format(t('mediaOpenFailed'), { message: String(error?.message ?? error) }),
          })
        })
      }, [item.relPath, t])

      /**
       * 截取当前帧存成 PNG。
       * 同一来源（同协议同端口）才能 canvas toBlob，否则 canvas 被 taint。
       * 我们的媒体路由与页面同源，所以可用。
       */
      const grabFrame = React.useCallback(() => {
        const v = videoRef.current
        if (v === null) {
          setGrabNotice({ kind: 'failed', text: format(t('mediaGrabFrameFailed'), { message: t('mediaGrabFrameNoVideo') }) })
          return
        }
        try {
          const w = v.videoWidth
          const h = v.videoHeight
          if (w === 0 || h === 0) throw new Error('video not ready')
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const c2d = canvas.getContext('2d')
          if (c2d === null) throw new Error('no 2d context')
          c2d.drawImage(v, 0, 0, w, h)

          const sec = Math.floor(v.currentTime || 0)
          const hh = String(Math.floor(sec / 3600)).padStart(2, '0')
          const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
          const ss = String(sec % 60).padStart(2, '0')
          const base = (item.name ?? 'frame').replace(/\.[^.]+$/, '')
          const fname = `${base}_${hh}-${mm}-${ss}.png`

          canvas.toBlob((blob) => {
            if (blob === null) {
              setGrabNotice({ kind: 'failed', text: format(t('mediaGrabFrameFailed'), { message: 'toBlob null' }) })
              return
            }
            const u = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = u
            a.download = fname
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(u), 1000)
            setGrabNotice({ kind: 'ok', text: format(t('mediaGrabFrameOk'), { name: fname }) })
          }, 'image/png')
        } catch (error) {
          setGrabNotice({ kind: 'failed', text: format(t('mediaGrabFrameFailed'), { message: String(error?.message ?? error) }) })
        }
      }, [item.name, t])

      React.useEffect(() => {
        if (grabNotice === null) return undefined
        const timer = setTimeout(() => setGrabNotice(null), 2500)
        return () => clearTimeout(timer)
      }, [grabNotice])

      return h('div', {
        className: 'dg-mediaLayer',
        key: 'mediaLayer',
        'data-gallery-player': item.relPath,
        onClick: onClose,
      }, h('div', {
        className: `dg-mediaPanel${isVideo ? ' dg-mediaPanelVideo' : ' dg-mediaPanelAudio'}`,
        key: 'panel',
        onClick: (event) => event.stopPropagation(),
      }, [
        h('div', { className: 'dg-mediaBar', key: 'bar' }, [
          h('span', { className: 'dg-mediaPTitle', key: 'title', title: item.relPath }, item.name),
          isVideo && !failed
            ? h('button', {
                type: 'button',
                className: 'dg-btn dg-mediaGrabBtn',
                key: 'grab',
                'data-gallery-grab-frame': item.relPath,
                title: t('mediaGrabFrameHint'),
                'aria-label': t('mediaGrabFrame'),
                onClick: (event) => { event.stopPropagation(); grabFrame() },
              }, ['📷 ', t('mediaGrabFrame')])
            : null,
          h('button', {
            type: 'button', className: 'dg-btn', key: 'close',
            title: t('mediaCloseHint'), 'aria-label': t('mediaCloseHint'),
            onClick: onClose,
          }, '✕'),
        ]),
        h('div', { className: 'dg-mediaStage', key: 'stage' }, (
          source.status === 'failed'
            ? h('div', { className: 'dg-mediaTooBig', key: 'loadFailed' }, [
                h('div', { className: 'dg-mediaTooBigIco', key: 'ico' }, '⚠'),
                h('div', { className: 'dg-mediaTooBigTitle', key: 't1' }, t('mediaLoadFailed')),
                h('div', { className: 'dg-mediaTooBigHint', key: 't2' }, source.message),
                h('div', { className: 'dg-mediaActionRow', key: 'actions' }, [
                  h('button', {
                    type: 'button', className: 'dg-mediaActBtn dg-mediaActPrimary', key: 'ext',
                    'data-gallery-open-external': item.relPath,
                    onClick: (event) => { event.stopPropagation(); openExternal() },
                  }, ['▶ ', t('mediaOpenExternal')]),
                  h('button', {
                    type: 'button', className: 'dg-mediaActBtn', key: 'folder',
                    'data-gallery-open-folder': item.relPath,
                    onClick: (event) => { event.stopPropagation(); openFolder() },
                  }, ['📂 ', t('mediaOpenFolder')]),
                ]),
              ])
            : source.status === 'loading'
              ? h('div', { className: 'dg-mediaLoading', key: 'loading' }, [
                  h('div', { className: 'dg-mediaTooBigIco', key: 'ico' }, isVideo ? '🎬' : '🎵'),
                  h('div', { className: 'dg-mediaLoadingText', key: 'txt' }, source.pct >= 0
                    ? format(t('mediaBlobLoading'), { pct: source.pct })
                    : t('mediaBlobLoadingIndeterminate')),
                  source.pct >= 0
                    ? h('div', { className: 'dg-mediaProgressBar', key: 'bar' },
                        h('div', { className: 'dg-mediaProgressFill', key: 'fill', style: { width: source.pct + '%' } }))
                    : null,
                  h('div', { className: 'dg-mediaTooBigHint', key: 'hint' }, t('mediaBlobSeekHint')),
                ])
              : failed
                ? h('div', { className: 'dg-mediaTooBig', key: 'decodeFailed' }, [
                    h('div', { className: 'dg-mediaTooBigIco', key: 'ico' }, '⚠'),
                    h('div', { className: 'dg-mediaTooBigTitle', key: 't1' }, t('mediaNoPreview')),
                    h('div', { className: 'dg-mediaTooBigHint', key: 't2' }, t('mediaBinaryHint')),
                    h('div', { className: 'dg-mediaActionRow', key: 'actions' }, [
                      h('button', {
                        type: 'button', className: 'dg-mediaActBtn dg-mediaActPrimary', key: 'ext',
                        'data-gallery-open-external': item.relPath,
                        onClick: (event) => { event.stopPropagation(); openExternal() },
                      }, ['▶ ', t('mediaOpenExternal')]),
                      h('button', {
                        type: 'button', className: 'dg-mediaActBtn', key: 'folder',
                        'data-gallery-open-folder': item.relPath,
                        onClick: (event) => { event.stopPropagation(); openFolder() },
                      }, ['📂 ', t('mediaOpenFolder')]),
                    ]),
                  ])
                : isVideo
                  ? h('video', {
                      ref: videoRef,
                      src: source.url ?? undefined,
                      controls: true,
                      autoPlay: true,
                      preload: 'metadata',
                      key: 'v',
                      'data-gallery-video': item.relPath,
                      onError: () => setFailed(true),
                      onLoadedMetadata: (event) => {
                        const v = event.currentTarget
                        if (v.videoWidth > 0) setDims({ w: v.videoWidth, h: v.videoHeight })
                      },
                    })
                  : h('audio', {
                      src: source.url ?? undefined,
                      controls: true,
                      autoPlay: true,
                      preload: 'metadata',
                      key: 'a',
                      'data-gallery-audio': item.relPath,
                      onError: () => setFailed(true),
                    })
        )),
        h('div', { className: 'dg-mediaFoot', key: 'foot' }, [
          h('span', { className: 'dg-mediaFootName', key: 'name', title: item.relPath }, item.name),
          h('span', { className: 'dg-mediaFootMeta', key: 'meta' },
            `${formatBytes(item.size)} · ${formatTime(item.mtime)}`
            + (dims !== null ? ` · ${dims.w} × ${dims.h}` : '')
            + (source.status === 'ready'
              ? ' · 已载入，可拖动进度条'
              : source.status === 'failed'
                ? ' · 载入失败'
                : ' · 载入中'))
        ]),
        grabNotice === null
          ? null
          : h('div', {
              className: 'dg-mediaNotice dg-mediaNotice'
                + (grabNotice.kind === 'ok' ? 'Ok' : grabNotice.kind === 'pending' ? 'Pending' : 'Fail'),
              key: 'notice',
              'data-gallery-grab-notice': grabNotice.kind,
            }, grabNotice.text),
      ]))
    }

    /**
     * 媒体直链：GET /api/dsh-gallery/media?path=<relPath>
     * 带 mtime 作为缓存破坏参数（文件被覆盖后浏览器不会用旧缓存）。
     */
