/** 格式化 / 图片压缩 / 并发限流工具。 */

    /**
     * 焦点是否落在可输入控件里。
     * 查看器的全局快捷键（左右切图 / 数字缩放 / o 切原图 / Esc 退出）必须给打字让位，
     * 否则在批注输入框里按方向键或输入字母就会切图、缩放、关掉大图。
     */
    function isTypingTarget(target) {
      if (target === null || target === undefined) return false
      if (typeof target.closest !== 'function') return false
      return target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null
    }

    /** 极简模板替换：字典里只有 {name} 占位。 */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => {
        const value = values?.[key]
        return value === undefined ? whole : String(value)
      })
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      const kb = bytes / 1024
      if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
      const mb = kb / 1024
      return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms)) return '—'
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** POST 到 Host 私有路由，统一把失败转成可展示的错误。 */
    async function callHost(op, payload, signal) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...(payload ?? {}) }),
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /**
     * 拉取一张原图的 Blob；超时即放弃，让调用方显示占位符。
     * `onProgress(loaded, total)` 可选：有 Content-Length 时按字节回报进度（total=-1 表示不确定）。
     * 原图可能是几十 MB，前端需要进度反馈，否则用户以为卡死。
     */
    async function fetchRaw(relPath, signal, onProgress) {
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), RAW_TIMEOUT_MS)
      const merged = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
      try {
        const response = await fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'raw', path: relPath }),
          signal: merged,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        if (typeof onProgress !== 'function') return await response.blob()

        // 有可读的 body 流且知道总字节数时，边读边报进度；否则退回整块读取
        const total = Number(response.headers.get('content-length') ?? '') || 0
        if (total === 0 || response.body === null || typeof response.body.getReader !== 'function') {
          onProgress(-1, -1)
          return await response.blob()
        }
        const reader = response.body.getReader()
        const chunks = []
        let loaded = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            loaded += value.length
            onProgress(loaded, total)
          }
        } catch (error) {
          try { await reader.cancel() } catch {}
          throw error
        }
        return new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' })
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * 把原图按最长边 maxEdge 压成 JPEG data URL 或 object URL。
     * 选项 `preferObjectUrl` 为 true 时返回 Blob URL（缩略图用），否则返回 data URL。
     * 用 createImageBitmap + OffscreenCanvas；不可用时不阻断，抛错由调用方显示占位符。
     */
    async function makeScaled(blob, maxEdge, preferObjectUrl) {
      const bitmap = await createImageBitmap(blob)
      try {
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
        const width = Math.max(1, Math.round(bitmap.width * scale))
        const height = Math.max(1, Math.round(bitmap.height * scale))

        let canvas
        if (typeof OffscreenCanvas === 'function') {
          canvas = new OffscreenCanvas(width, height)
        } else {
          canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
        }
        const context = canvas.getContext('2d')
        if (context === null) throw new Error('canvas 2d context unavailable')
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
        context.drawImage(bitmap, 0, 0, width, height)

        const quality = preferObjectUrl ? 0.82 : 0.9
        if (typeof canvas.convertToBlob === 'function') {
          const out = await canvas.convertToBlob({ type: 'image/jpeg', quality })
          return {
            url: preferObjectUrl ? URL.createObjectURL(out) : null,
            blob: preferObjectUrl ? null : out,
            dataUrl: preferObjectUrl ? null : await toDataUrl(out),
            width: bitmap.width,
            height: bitmap.height,
          }
        }
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        return { url: null, blob: null, dataUrl, width: bitmap.width, height: bitmap.height }
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close()
      }
    }

    /** Blob → data URL（仅给放大视图用，避免额外 object URL 生命周期）。 */
    function toDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(blob)
      })
    }

    /**
     * 读图片真实像素尺寸。优先用 host 已解析好的 item.width/height（零成本）；
     * 缺失时才解码一次图像测 naturalWidth/Height（大图解码有开销，能免则免）。
     */
    async function readImageSize(url, item) {
      if (typeof item?.width === 'number' && typeof item?.height === 'number'
          && item.width > 0 && item.height > 0) {
        return { w: item.width, h: item.height }
      }
      return await new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 })
        img.onerror = () => resolve({ w: 0, h: 0 })
        img.src = url
      })
    }


    /** 全局并发闸门：缩略图同一时刻只解压这么多个。 */
    function createLimiter(max) {
      let active = 0
      const waiting = []
      const release = () => {
        active -= 1
        const next = waiting.shift()
        if (next !== undefined) next()
      }
      return async function run(task) {
        if (active >= max) await new Promise((resolve) => waiting.push(resolve))
        active += 1
        try {
          return await task()
        } finally {
          release()
        }
      }
    }

    /** 面板内的样式：只用宿主 theme token，深色/浅色自动跟随。 */
