window.__ModuleLoader__.load({
  id: 'dsh-gallery',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 与 Host 半部一致的路由（exact Fetch 路由的 path）。 */
    const ROUTE = '/api/dsh-gallery'
    /** tab 类型的身份；也是正文与标题在 keyed slot 里的 key。 */
    const KIND = 'gallery'
    const ID = 'dsh-gallery'
    /** 缩略图最长边（像素）——客户端压缩目标。 */
    const THUMB_SIZE = 200
    /** 放大视图最长边；仍然是 canvas 缩放结果，不把原图直接塞进 <img>。 */
    const VIEW_SIZE = 1600
    /** 单图请求超时，避免一张卡死的图拖住整面板。 */
    const RAW_TIMEOUT_MS = 15000
    /** 同一时刻最多几个缩略图在解码，避免一次性拉扯大量原图。 */
    const MAX_CONCURRENT = 4

    /** 查看器缩放上限与单次滚轮步进。 */
    const MAX_ZOOM = 8
    const ZOOM_STEP = 0.35

    /** 自动刷新间隔（毫秒）：产出落盘后无需手动点刷新。 */
    const AUTO_REFRESH_MS = 5000

    /** 文本预览最大字符数：超出截断，避免超大日志卡死面板。 */
    const MAX_TEXT_CHARS = 200000

    const NS = 'dshGallery'

    /** 插件自己的 context；侧栏入口按钮需要它来开 tab。 */
    const ctxRef = { current: null }

    const zh = {
      'type.label': '产出画廊',
      'guide.title': '产出画廊',
      'guide.description': '最近 24 小时的产出图片',
      loading: '正在扫描…',
      refreshing: '刷新中…',
      refresh: '刷新',
      preview: '预览',
      previewInSidebar: '在 DSH 右侧栏预览该文件',
      copy: '复制路径',
      copyPath: '复制该文件的绝对路径',
      copied: '已复制',
      openFolder: '打开所在文件夹',
      kindImage: '图片',
      kindFile: '文件',
      scopeGlobal: '全局资产',
      scopeSession: '当前对话',
      scopeGlobalHint: 'G 盘全部产出，按产出时间倒序',
      scopeSessionHint: '仅本对话产出过的文件',
      scopeUnknown: '未记录本对话产出',
      scopeNotFound: '找不到本对话的会话记录',
      scopeLogEmpty: '本对话的会话记录为空',
      subCount: '{shown} / {total} 条',
      // 设置面板
      settingsTitle: '设置产出根目录',
      rootLabel: '产出根目录',
      rootHint: '当前来源：{source}',
      rootExists: '✓ 目录存在',
      rootMissingShort: '✗ 目录不存在，请修改',
      settingsFileAt: '设置保存在：{path}',
      rootSourceSettings: '面板内设置（优先级最高）',
      rootSourceConfig: 'cordis.patch.yml 配置',
      rootSourceAuto: '自动探测',
      save: '保存并生效',
      saving: '保存中…',
      resetDefault: '恢复默认',
      cancel: '取消',
      savedImmediately: '✓ 已保存，立即生效（无需重启）',
      binaryHint: '该格式不支持内联预览，请用文件管理器打开',
      empty: '最近 24 小时没有新图片',
      emptyFile: '最近 24 小时没有新文件',
      emptySession: '本对话还没产出过文件',
      errorTitle: '扫描失败',
      retry: '重试',
      rootMissing: '目录不存在：{root}',
      changeRoot: '修改产出根目录',
      rootEmptyHint: '当前目录下没有符合条件的产出，可换个目录或在设置里调整',
      dgStatusAction: '',
      more: '还有 {count} 张',
      thumbFailed: '无法加载',
      dims: '{w} × {h}',
      dimsUnknown: '尺寸未知',
      close: '关闭',
      prev: '上一张',
      next: '下一张',
      zoomed: '放大查看',
      meta: '{size} · {time}',
      scanned: '已扫描 {dirs} 个目录',
      capped: '已达扫描上限，结果可能不完整',
    }

    const en = {
      'type.label': 'Output Gallery',
      'guide.title': 'Output Gallery',
      'guide.description': 'Images from the last 24 hours',
      loading: 'Scanning…',
      refreshing: 'Refreshing…',
      refresh: 'Refresh',
      preview: 'Preview',
      previewInSidebar: 'Preview this file in the DSH sidebar',
      copy: 'Copy path',
      copyPath: 'Copy the absolute path of this file',
      copied: 'Copied',
      openFolder: 'Open containing folder',
      kindImage: 'Images',
      kindFile: 'Files',
      scopeGlobal: 'All assets',
      scopeSession: 'This chat',
      scopeGlobalHint: 'Every output on the G drive, newest first',
      scopeSessionHint: 'Only files produced in this chat',
      scopeUnknown: 'No outputs recorded for this chat',
      scopeNotFound: 'Cannot find this chat’s session log',
      scopeLogEmpty: 'This chat’s session log is empty',
      subCount: '{shown} of {total}',
      // Settings panel
      settingsTitle: 'Output root folder',
      rootLabel: 'Output root',
      rootHint: 'Current source: {source}',
      rootExists: '✓ Folder exists',
      rootMissingShort: '✗ Folder missing, please change it',
      settingsFileAt: 'Saved in: {path}',
      rootSourceSettings: 'Set in panel (highest priority)',
      rootSourceConfig: 'cordis.patch.yml',
      rootSourceAuto: 'Auto-detected',
      save: 'Save and apply',
      saving: 'Saving…',
      resetDefault: 'Reset to default',
      cancel: 'Cancel',
      savedImmediately: '✓ Saved and applied immediately (no restart needed)',
      binaryHint: 'This format cannot be previewed inline; open it in your file manager',
      empty: 'No new images in the last 24 hours',
      emptyFile: 'No new files in the last 24 hours',
      emptySession: 'Nothing has been produced in this chat yet',
      errorTitle: 'Scan failed',
      retry: 'Retry',
      rootMissing: 'Folder not found: {root}',
      changeRoot: 'Change output root',
      rootEmptyHint: 'Nothing matches in this folder. Pick another folder or adjust settings.',
      dgStatusAction: '',
      more: '{count} more',
      thumbFailed: 'Cannot load',
      dims: '{w} × {h}',
      dimsUnknown: 'Size unknown',
      close: 'Close',
      prev: 'Previous',
      next: 'Next',
      zoomed: 'Enlarged view',
      meta: '{size} · {time}',
      scanned: 'Scanned {dirs} folders',
      capped: 'Scan limit reached; results may be incomplete',
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

    /** 拉取一张原图的 Blob；超时即放弃，让调用方显示占位符。 */
    async function fetchRaw(relPath, signal) {
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
        return await response.blob()
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
    const CSS = `
.dg-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 13px;
  position: relative;
}
.dg-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  flex: 0 0 auto;
  flex-wrap: wrap;
}
.dg-headerInfo { flex: 1 1 96px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dg-switch { flex: 0 0 auto; display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; overflow: hidden; }
.dg-seg { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; padding: 4px 9px; cursor: pointer; }
.dg-seg:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dg-segActive { background: var(--dsw-alias-interactive-bg-selected); color: var(--dsw-alias-label-primary); font-weight: 600; }
/* 分类开关：全局资产 / 当前对话 */
.dg-scopeSwitch {
  flex: 0 0 auto;
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
}
.dg-scopeBtn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 5px 10px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  transition: color .15s ease, background .15s ease;
}
.dg-scopeBtn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dg-scopeActive {
  color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary);
  font-weight: 600;
}
.dg-scopeActive:hover {
  color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent);
}
.dg-scopeBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dg-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dg-sub { color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dg-btn {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  flex: 0 0 auto;
}
.dg-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.dg-btn:disabled { opacity: .55; cursor: default; }
.dg-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dg-btnIcon { min-width: 30px; padding: 4px 8px; font-size: 14px; line-height: 18px; }

/* ===== 设置面板 ===== */
.dg-settingsLayer {
  position: absolute; inset: 0; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 72%, transparent);
}
.dg-settings {
  width: 100%; max-width: 460px; max-height: 100%;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,.22);
  overflow: hidden;
}
.dg-settingsHead {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.dg-settingsTitle { flex: 1 1 auto; font-size: 13px; font-weight: 600; }
.dg-settingsBody { padding: 12px; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
.dg-field { display: flex; flex-direction: column; gap: 6px; }
.dg-fieldLabel { font-size: 12px; font-weight: 600; }
.dg-fieldHint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dg-input {
  width: 100%; box-sizing: border-box;
  padding: 7px 10px;
  font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
}
.dg-input:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
}
.dg-settingsMeta {
  display: flex; flex-direction: column; gap: 3px;
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  word-break: break-all;
}
.dg-settingsActions { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 2px; }
.dg-primaryBtn {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
}
.dg-primaryBtn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
}
.dg-ok { color: var(--dsw-alias-brand-primary); }
.dg-statusAction { padding-top: 0; }
.dg-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 10px; }
.dg-status { color: var(--dsw-alias-label-secondary); padding: 16px 4px; text-align: center; }
.dg-error { color: var(--dsw-alias-state-error-primary); }
.dg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 10px;
}
.dg-card {
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1);
  padding: 0;
  cursor: zoom-in;
  appearance: none;
  text-align: left;
  color: inherit;
  font: inherit;
}
.dg-card:hover { border-color: var(--dsw-alias-border-l2); }
.dg-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dg-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1 / 1;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
}
.dg-thumb img { max-width: 100%; max-height: 100%; display: block; object-fit: contain; }
.dg-placeholder {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  padding: 8px;
  text-align: center;
  line-height: 1.5;
}
.dg-placeholder code { color: var(--dsw-alias-label-primary); word-break: break-all; }
.dg-meta { padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dg-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dg-dim { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dg-more {
  margin: 12px 0 4px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  text-align: center;
  font-size: 12px;
}
.dg-viewer {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-overlay);
}
.dg-viewerBar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  flex: 0 0 auto;
}
.dg-viewerTitle { flex: 1 1 auto; min-width: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dg-viewerBody { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 10px; }
.dg-viewerBody img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.dg-viewerLayer { position: absolute; inset: 0; z-index: 30; background: var(--dsw-specific-sidebar-fill, #111); display: flex; flex-direction: column; }
.dg-viewerLayer .dg-viewer { flex: 1 1 auto; min-height: 0; }
.dg-viewerBody { touch-action: none; }
.dg-textBody { display: block; overflow: auto; padding: 12px 14px; user-select: text; touch-action: auto; }

/* ===== 文件卡片 v2：三段式 ===== */
.dg-fileCard2 {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; text-align: left;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; cursor: pointer;
  transition: border-color .15s ease, background .15s ease, box-shadow .15s ease;
}
.dg-fileCard2:hover {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 2px 10px rgba(0,0,0,.08);
}
.dg-fileCard2:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }

/* ① 头部 */
.dg-fcHead { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dg-fcBadge {
  flex: 0 0 auto; min-width: 42px; height: 28px; padding: 0 8px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; letter-spacing: .06em;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
}
.dg-fcName {
  flex: 1 1 auto; min-width: 0;
  font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ② 操作行 */
.dg-fcActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dg-fcBtn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 30px; padding: 0 12px;
  font: inherit; font-size: 12px; line-height: 1;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px; cursor: pointer;
  transition: color .15s ease, border-color .15s ease, background .15s ease;
}
.dg-fcBtn:hover {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dg-fcBtnPrimary {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
}
.dg-fcBtnPrimary:hover {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
}
.dg-fcBtnOk { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dg-fcBtnIcon { flex: 0 0 auto; min-width: 34px; padding: 0 8px; font-size: 13px; }
.dg-fcIco { font-size: 12px; line-height: 1; opacity: .9; }

/* ③ 底部 */
.dg-fcFoot {
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  padding-top: 2px; border-top: 1px solid var(--dsw-alias-border-l1);
}
.dg-textPre { margin: 0; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary); user-select: text; }
.dg-fileBody { padding-top: 4px; }
.dg-fileGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.dg-fileCard2 { cursor: pointer; }  /* 覆盖 .dg-card 的 zoom-in 与 overflow/padding */
.dg-fileCard2 { overflow: visible; padding: 12px 14px; }
.dg-copyBtn { flex: 0 0 auto; font-size: 11px; padding: 3px 8px; white-space: nowrap; }
.dg-previewBtn { border-color: var(--dsw-alias-interactive-border-accent, var(--dsw-alias-border-l1)); }
.dg-fileCardClickable { cursor: pointer; }
.dg-fileCardClickable:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dg-fileCardClickable:focus-visible { outline: 2px solid var(--dsw-alias-border-accent, #4b9eff); outline-offset: 1px; }
.dg-copied { color: var(--dsw-alias-label-primary); font-weight: 600; opacity: .85; }
.dg-viewerFoot { flex: 0 0 auto; padding: 6px 10px 10px; color: var(--dsw-alias-label-secondary); font-size: 11px; word-break: break-all; }
.dg-open { white-space: nowrap; }
.dg-openCompact { padding: 2px 6px; line-height: 16px; font-size: 12px; }
`

    /**
     * 复制文本到剪贴板。优先 Clipboard API，失败回退 execCommand。
     * @param text - 要复制的内容。
     * @returns 是否成功。
     */
    /**
     * 用根目录与相对路径拼出 Windows 绝对路径。
     * 全程用 split/join，不用正则，避免转义歧义。
     * @param root - 根目录（可能以 \ 或 / 结尾）。
     * @param relPath - 相对路径（以 / 分隔）。
     * @returns 绝对路径。
     */
    /**
     * 构造 DSH 原生资源地址（session 作用域）。
     * 文档预览的 canOpen 只认 scope=session，故必须用 session 形式，不能用 absolute。
     * @param sessionId - 当前会话 id（slot props.sessionId）。
     * @param absPath - 文件绝对路径。
     * @returns dsh-resource://file/session/<sessionId>/<path>
     */
    function sessionFileAddressOf(sessionId, absPath) {
      const norm = String(absPath).split(String.fromCharCode(92)).join('/').replace(/^\.\//, '')
      const segs = norm.split('/').filter((s) => s !== '')
      const encoded = segs.map((s) => encodeURIComponent(s).replace(/%3A/gi, ':')).join('/')
      return 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + encoded
    }

    function buildAbsPath(root, relPath) {
      const BS = String.fromCharCode(92)   // 反斜杠
      const cleanedRoot = String(root).split('/').join(BS).split(BS).filter((s) => s !== '').join(BS)
      const parts = String(relPath).split('/').filter((s) => s !== '')
      return cleanedRoot + BS + parts.join(BS)
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard !== undefined && navigator.clipboard !== null) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (error) {
        console.warn('dsh-gallery: clipboard API 失败，回退', error)
      }
      try {
        const host = document.createElement('textarea')
        host.value = text
        host.style.position = 'fixed'
        host.style.opacity = '0'
        document.body.appendChild(host)
        host.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(host)
        return ok
      } catch (error) {
        console.error('dsh-gallery: 复制失败', error)
        return false
      }
    }

    /**
     * 文件卡片：三段式布局。
     *   ① 头部：类型图标 + 文件名 + 简介（悬停展开，此处用大小/时间）
     *   ② 中部：三个操作按钮（侧边预览 / 复制路径 / 打开本地位置）
     *   ③ 底部：元信息
     */
    function FileCard({ item, t, absPath, onOpenFolder, onPreview }) {
      const ext = (item.extension ?? '').replace(/^\./, '').toLowerCase()
      const badge = (ext === '' ? 'FILE' : ext).slice(0, 4).toUpperCase()
      const [copied, setCopied] = React.useState(false)

      React.useEffect(() => {
        if (copied === false) return undefined
        const timer = setTimeout(() => setCopied(false), 1600)
        return () => clearTimeout(timer)
      }, [copied])

      const onCopy = async (event) => {
        event.stopPropagation()
        const ok = await copyText(absPath)
        setCopied(ok)
      }
      const onEye = (event) => {
        event.stopPropagation()
        onPreview(absPath)
      }
      const onFolder = (event) => {
        event.stopPropagation()
        onOpenFolder(absPath)
      }

      return h('div', {
        className: 'dg-card dg-fileCard2',
        role: 'button',
        tabIndex: 0,
        title: `${item.name}
${absPath}
点击在 DSH 右侧栏预览`,
        onClick: () => onPreview(absPath),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onPreview(absPath)
          }
        },
        'data-gallery-file': item.relPath,
      }, [
        // ① 头部
        h('div', { className: 'dg-fcHead', key: 'head' }, [
          h('span', { className: 'dg-fcBadge', key: 'badge' }, badge),
          h('span', { className: 'dg-fcName', key: 'name' }, item.name),
        ]),
        // ② 中部操作行
        h('div', { className: 'dg-fcActions', key: 'actions' }, [
          h('button', {
            type: 'button', key: 'eye',
            className: 'dg-fcBtn dg-fcBtnPrimary',
            'data-gallery-preview': item.relPath,
            title: t('previewInSidebar'),
            onClick: onEye,
          }, [h('span', { className: 'dg-fcIco', key: 'i' }, '👁'), h('span', { key: 'l' }, t('preview'))]),
          h('button', {
            type: 'button', key: 'copy',
            className: `dg-fcBtn${copied ? ' dg-fcBtnOk' : ''}`,
            'data-gallery-copy': item.relPath,
            title: t('copyPath'),
            onClick: onCopy,
          }, [h('span', { className: 'dg-fcIco', key: 'i' }, copied ? '✓' : '⧉'), h('span', { key: 'l' }, copied ? t('copied') : t('copy'))]),
          h('button', {
            type: 'button', key: 'folder',
            className: 'dg-fcBtn dg-fcBtnIcon',
            title: t('openFolder'),
            onClick: onFolder,
          }, '📂'),
        ]),
        // ③ 底部元信息
        h('div', { className: 'dg-fcFoot', key: 'foot' },
          `${formatBytes(item.size)} · ${formatTime(item.mtime)}`),
      ])
    }

    /** 单张缩略图卡片：独立加载、独立失败，互不影响。 */
    function Card({ item, t, onOpen, limiter }) {
      const [state, setState] = React.useState({ status: 'pending' })
      const [node, setNode] = React.useState(null)

      React.useEffect(() => {
        if (node === null) return undefined
        let cancelled = false
        let started = false
        let sourceUrl = null
        const controller = new AbortController()

        const run = () => {
          if (started) return
          started = true
          setState({ status: 'pending' })
          limiter(async () => {
            const blob = await fetchRaw(item.relPath, controller.signal)
            const thumb = await makeScaled(blob, THUMB_SIZE, true)
            if (cancelled) {
              if (thumb.url !== null) URL.revokeObjectURL(thumb.url)
              return
            }
            sourceUrl = thumb.url
            setState({ status: 'ready', url: thumb.url })
          }).catch((error) => {
            if (cancelled || controller.signal.aborted) return
            setState({ status: 'failed', message: String(error?.message ?? error) })
          })
        }

        // 环境不支持 IntersectionObserver 时直接加载，保证可用性。
        if (typeof IntersectionObserver !== 'function') {
          run()
          return () => {
            cancelled = true
            controller.abort()
            if (sourceUrl !== null) URL.revokeObjectURL(sourceUrl)
          }
        }

        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            observer.disconnect()
            run()
          }
        }, { rootMargin: '120px' })
        observer.observe(node)

        return () => {
          cancelled = true
          observer.disconnect()
          controller.abort()
          if (sourceUrl !== null) URL.revokeObjectURL(sourceUrl)
        }
      }, [node, item.relPath, limiter])

      const dims = item.width !== null && item.height !== null
        ? format(t('dims'), { w: item.width, h: item.height })
        : t('dimsUnknown')

      return h('button', {
        type: 'button',
        ref: setNode,
        className: 'dg-card',
        title: item.relPath,
        'data-gallery-card': item.relPath,
        onClick: (event) => onOpen(item, event.currentTarget),
      }, [
        h('div', { className: 'dg-thumb', key: 'thumb' },
          state.status === 'ready'
            ? h('img', {
                src: state.url,
                alt: item.name,
                decoding: 'async',
                loading: 'lazy',
                width: THUMB_SIZE,
                height: THUMB_SIZE,
              })
            : h('div', { className: 'dg-placeholder', 'data-gallery-placeholder': state.status },
                state.status === 'failed'
                  ? [h('div', { key: 'msg' }, t('thumbFailed')), h('code', { key: 'name' }, item.name)]
                  : t('loading')),
        ),
        h('div', { className: 'dg-meta', key: 'meta' }, [
          h('span', { className: 'dg-name', key: 'name' }, item.name),
          h('span', { className: 'dg-dim', key: 'dim' }, dims),
          h('span', { className: 'dg-dim', key: 'time' }, formatTime(item.mtime)),
        ]),
      ])
    }

    /** 文本类扩展名（仅用于判断，不再在插件内渲染）。 */
    const TEXT_EXTS = new Set([
      '.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.csv', '.tsv',
      '.yaml', '.yml', '.xml', '.toml', '.ini', '.cfg', '.conf',
      '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
      '.ps1', '.sh', '.bat', '.cmd', '.sql', '.ipynb',
      '.html', '.htm', '.css', '.scss', '.url',
    ])

    /** 判断某个文件是否可按文本预览（保留给需要提示的场景）。 */
    function isTextLike(ext) {
      return TEXT_EXTS.has(String(ext ?? '').toLowerCase())
    }

    /**
     * 面板内放大查看（**仅图片**）。
     * 交互：左键点图退出、滚轮缩放、中键拖动平移。
     * 文件不走这里——文件点击直接交给 DSH 自带侧栏预览。
     */
    function Viewer({ items, index, onClose, onStep, t }) {
      const item = items[index]
      // 文件预览已改走 DSH 原生侧栏（session 地址）；此处 Viewer 仅处理图片，isText 恒 false，
      // 下面的文本分支保留为死代码，供 v0.2 若需插件内预览时复用
      const isText = false
      const [state, setState] = React.useState({ status: 'pending' })
      const [zoom, setZoom] = React.useState(1)
      const [pan, setPan] = React.useState({ x: 0, y: 0 })
      const [dragging, setDragging] = React.useState(false)
      const bodyRef = React.useRef(null)
      const dragRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        const controller = new AbortController()
        setState({ status: 'pending' })
        // 既不是文本、也不是图片的二进制文件（pdf/docx/zip 等）不做内联解码
        const ext = String(item.extension ?? '').toLowerCase()
        const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)
        if (!isText && !isImage) {
          setState({ status: 'binary' })
          return () => { alive = false }
        }
        fetchRaw(item.relPath, controller.signal)
          .then(async (blob) => {
            if (isText) {
              // 文本预览：按大小截断，避免超大日志卡死面板
              const text = await blob.text()
              const capped = text.length > MAX_TEXT_CHARS
                ? text.slice(0, MAX_TEXT_CHARS) + `\n\n…（已截断，原文 ${text.length} 字符）`
                : text
              if (!alive) return
              setState({ status: 'ready', text: capped, truncated: text.length > MAX_TEXT_CHARS })
              return
            }
            const scaled = await makeScaled(blob, VIEW_SIZE, false)
            if (!alive) return
            setState({ status: 'ready', url: scaled.dataUrl ?? (scaled.url ?? '') })
          })
          .catch((error) => {
            if (!alive || controller.signal.aborted) return
            setState({ status: 'failed', message: String(error?.message ?? error) })
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [item.relPath, isText])

      // 切换图片时重置缩放与平移
      React.useEffect(() => {
        setZoom(1)
        setPan({ x: 0, y: 0 })
        setDragging(false)
        dragRef.current = null
      }, [item.relPath])

      // 滚轮缩放：仅图片模式生效。文本预览用原生滚动，不拦截滚轮。
      React.useEffect(() => {
        const node = bodyRef.current
        if (node === null || state.status !== 'ready' || isText) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const delta = event.deltaY < 0 ? 1 : -1
          setZoom((current) => {
            const next = Math.min(MAX_ZOOM, Math.max(1, current + delta * ZOOM_STEP))
            if (next === 1) setPan({ x: 0, y: 0 })
            return next
          })
        }
        node.addEventListener('wheel', onWheel, { passive: false })
        return () => node.removeEventListener('wheel', onWheel)
      }, [state.status, isText])

      /**
       * 拖拽平移：仅放大超出预览框时生效，**按住鼠标中键（滚轮）拖动**。
       * 左键保留给「点击退出」，避免两种手势打架。
       */
      const onPointerDown = (event) => {
        if (zoom <= 1) return
        // 只认中键（button === 1）。中键默认会触发浏览器自动滚动，必须拦截。
        if (event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
        dragRef.current = { x: event.clientX, y: event.clientY, ox: pan.x, oy: pan.y }
        setDragging(true)
      }
      const onPointerMove = (event) => {
        const d = dragRef.current
        if (d === null) return
        event.preventDefault()
        setPan({ x: d.ox + (event.clientX - d.x), y: d.oy + (event.clientY - d.y) })
      }
      const endDrag = () => {
        if (dragRef.current === null) return
        dragRef.current = null
        setDragging(false)
      }
      // 中键按下时阻止浏览器默认的自动滚动
      const onMouseDown = (event) => {
        if (event.button === 1) event.preventDefault()
      }
      // 点击退出：左键单击，且没有正在拖拽时触发
      const onClickBody = (event) => {
        if (dragRef.current !== null) return
        event.preventDefault()
        onClose()
      }

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            onStep(-1)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            onStep(1)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose, onStep])

      const dims = item.width !== null && item.height !== null
        ? format(t('dims'), { w: item.width, h: item.height })
        : t('dimsUnknown')

      return h('div', {
        className: 'dg-viewer',
        role: 'dialog',
        'aria-modal': false,
        'aria-label': t('zoomed'),
        'data-gallery-viewer': item.relPath,
      }, [
        h('div', { className: 'dg-viewerBar', key: 'bar' }, [
          h('span', { className: 'dg-viewerTitle', key: 'title' }, item.name),
          h('button', { type: 'button', className: 'dg-btn', key: 'prev', onClick: () => onStep(-1), 'aria-label': t('prev') }, '‹'),
          h('button', { type: 'button', className: 'dg-btn', key: 'next', onClick: () => onStep(1), 'aria-label': t('next') }, '›'),
          h('button', { type: 'button', className: 'dg-btn', key: 'close', onClick: onClose, 'aria-label': t('close') }, '✕'),
        ]),
        h('div', {
          className: `dg-viewerBody${isText ? ' dg-textBody' : ''}`,
          key: 'body',
          ref: bodyRef,
          'data-gallery-zoom': isText ? 1 : zoom,
          'data-gallery-text': isText ? true : undefined,
          style: isText
            ? { overflow: 'auto', cursor: 'default' }
            : {
                overflow: zoom > 1 ? 'hidden' : 'auto',
                cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-out',
              },
          onClick: isText ? undefined : onClickBody,
          onMouseDown: isText ? undefined : onMouseDown,
          onPointerDown: isText ? undefined : onPointerDown,
          onPointerMove: isText ? undefined : onPointerMove,
          onPointerUp: isText ? undefined : endDrag,
          onPointerLeave: isText ? undefined : endDrag,
          onPointerCancel: isText ? undefined : endDrag,
          onAuxClick: isText ? undefined : (event) => { if (event.button === 1) event.preventDefault() },
        },
          state.status === 'ready'
            ? (isText
                ? h('pre', { className: 'dg-textPre', key: 'text' }, state.text)
                : h('img', {
                    src: state.url,
                    alt: item.name,
                    decoding: 'async',
                    draggable: false,
                    style: {
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                      transition: dragRef.current === null ? 'transform 120ms ease-out' : 'none',
                      userSelect: 'none',
                      pointerEvents: 'none',
                    },
                  }))
            : state.status === 'binary'
              ? h('div', { className: 'dg-placeholder', key: 'bin' }, t('binaryHint'))
            : h('div', { className: state.status === 'failed' ? 'dg-placeholder dg-error' : 'dg-placeholder' },
                state.status === 'failed' ? `${t('thumbFailed')}：${item.name}` : t('loading')),
        ),
        h('div', { className: 'dg-viewerFoot', key: 'foot' }, `${dims} · ${formatBytes(item.size)} · ${formatTime(item.mtime)}`),
      ])
    }

    /**
     * 设置面板：修改「产出根目录」。
     * 用户填一个绝对路径 → Host 校验 → 写入运行时配置 → 立即生效（不重启）。
     * 也可以点「恢复默认」，回到自动探测的结果。
     */
    function SettingsPanel({ t, onClose, onSaved }) {
      const [loading, setLoading] = React.useState(true)
      const [info, setInfo] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [error, setError] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [saved, setSaved] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        callHost('settings')
          .then((payload) => {
            if (!alive) return
            if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
            const s = payload.settings
            setInfo(s)
            setDraft(s.root)
            setLoading(false)
          })
          .catch((e) => {
            if (!alive) return
            setError(String(e?.message ?? e))
            setLoading(false)
          })
        return () => { alive = false }
      }, [t])

      const save = React.useCallback(async (nextRoot) => {
        setSaving(true)
        setError(null)
        setSaved(false)
        try {
          const payload = await callHost('setRoot', { root: nextRoot })
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
          setInfo(payload.settings)
          setDraft(payload.settings.root)
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
          if (typeof onSaved === 'function') onSaved()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setSaving(false)
        }
      }, [t, onSaved])

      const sourceLabel = React.useMemo(() => {
        if (info === null) return ''
        if (info.rootSource === 'settings') return t('rootSourceSettings')
        if (info.rootSource === 'config') return t('rootSourceConfig')
        return t('rootSourceAuto')
      }, [info, t])

      return h('div', { className: 'dg-settingsLayer', key: 'settingsLayer' }, [
        h('div', {
          className: 'dg-settings',
          key: 'panel',
          role: 'dialog',
          'aria-modal': true,
          'aria-label': t('settingsTitle'),
          'data-gallery-settings-panel': true,
        }, [
          h('div', { className: 'dg-settingsHead', key: 'head' }, [
            h('span', { className: 'dg-settingsTitle', key: 'title' }, t('settingsTitle')),
            h('button', {
              type: 'button', className: 'dg-btn', key: 'close',
              'aria-label': t('close'),
              onClick: onClose,
            }, '✕'),
          ]),

          loading
            ? h('p', { className: 'dg-status', key: 'loading' }, t('loading'))
            : h('div', { className: 'dg-settingsBody', key: 'body' }, [
                h('label', { className: 'dg-field', key: 'root' }, [
                  h('span', { className: 'dg-fieldLabel', key: 'l' }, t('rootLabel')),
                  h('input', {
                    type: 'text',
                    className: 'dg-input',
                    key: 'i',
                    value: draft,
                    spellCheck: false,
                    'data-gallery-root-input': true,
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && saving === false) { event.preventDefault(); void save(draft) }
                    },
                  }),
                  h('span', { className: 'dg-fieldHint', key: 'h' },
                    info === null ? '' : format(t('rootHint'), { source: sourceLabel })),
                ]),

                info === null ? null : h('div', { className: 'dg-settingsMeta', key: 'meta' }, [
                  h('span', { key: 'status' },
                    info.rootExists ? t('rootExists') : t('rootMissingShort')),
                  h('span', { key: 'file' },
                    format(t('settingsFileAt'), { path: info.settingsFile })),
                ]),

                error === null ? null : h('p', { className: 'dg-status dg-error', key: 'err' }, error),
                saved ? h('p', { className: 'dg-status dg-ok', key: 'ok' }, t('savedImmediately')) : null,

                h('div', { className: 'dg-settingsActions', key: 'actions' }, [
                  h('button', {
                    type: 'button', className: 'dg-btn dg-primaryBtn', key: 'save',
                    disabled: saving || draft.trim() === '',
                    'data-gallery-root-save': true,
                    onClick: () => { void save(draft) },
                  }, saving ? t('saving') : t('save')),
                  h('button', {
                    type: 'button', className: 'dg-btn', key: 'reset',
                    disabled: saving || info === null,
                    onClick: () => { if (info !== null) { setDraft(info.defaults.root); void save(info.defaults.root) } },
                  }, t('resetDefault')),
                  h('button', {
                    type: 'button', className: 'dg-btn', key: 'cancel',
                    disabled: saving,
                    onClick: onClose,
                  }, t('cancel')),
                ]),
              ]),
        ]),
      ])
    }

    /** 画廊正文：Header（刷新）+ 网格 + 面板内放大。 */
    function GalleryBody(props) {
      const { t, sessionId } = props
      const [view, setView] = React.useState({ status: 'loading' })
      const [refreshing, setRefreshing] = React.useState(false)
      const [viewer, setViewer] = React.useState(null)
      const limiter = React.useRef(null)
      if (limiter.current === null) limiter.current = createLimiter(MAX_CONCURRENT)

      const load = React.useCallback(async (signal, kind = 'image', scope = 'global') => {
        const payload = await callHost('list', { kind, scope, sessionId }, signal)
        if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
        return payload
      }, [t, sessionId])

      const [kind, setKind] = React.useState('image')
      // 分类：全局资产（整个 G 盘产出）/ 当前对话（仅本对话产出过的）
      // 从「当前对话」切回「全局」时保留上次选择，但不持久化，避免误导。
      const [scope, setScope] = React.useState('global')
      // 设置面板开关（改产出根目录）
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      // 网格滚动位置：打开查看器前记录，关闭后恢复，让视图停在原缩略图处
      const bodyScrollRef = React.useRef(null)
      const savedScrollRef = React.useRef(null)

      /** 打开某张图：先记住当前滚动位置。 */
      const openViewer = React.useCallback((index, anchorEl) => {
        const scroller = bodyScrollRef.current
        if (scroller !== null) {
          savedScrollRef.current = {
            top: scroller.scrollTop,
            // 记录被点中的卡片相对滚动容器的偏移，用于精确回位
            offset: anchorEl !== null && anchorEl !== undefined
              ? anchorEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
              : null,
          }
        }
        setViewer({ index })
      }, [])

      /** 关闭查看器：恢复到原来那张缩略图的位置。 */
      const closeViewer = React.useCallback(() => {
        setViewer(null)
        const saved = savedScrollRef.current
        if (saved === null) return
        // 等覆盖层卸载、网格重新可见后再滚
        requestAnimationFrame(() => {
          const scroller = bodyScrollRef.current
          if (scroller === null) return
          const top = saved.offset !== null && saved.offset !== undefined ? saved.offset : saved.top
          scroller.scrollTop = Math.max(0, top)
          savedScrollRef.current = null
        })
      }, [])

      const refresh = React.useCallback(async () => {
        setRefreshing(true)
        try {
          setView({ status: 'ready', data: await load(undefined, kind, scope) })
        } catch (error) {
          if (error?.name === 'AbortError') return
          setView({ status: 'failed', message: String(error?.message ?? error) })
        } finally {
          setRefreshing(false)
        }
      }, [load, kind, scope])

      React.useEffect(() => {
        let alive = true
        const controller = new AbortController()
        load(controller.signal, kind, scope)
          .then((data) => {
            if (alive) setView({ status: 'ready', data })
          })
          .catch((error) => {
            if (alive && error?.name !== 'AbortError') setView({ status: 'failed', message: String(error?.message ?? error) })
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [load, kind, scope])

      // 自动刷新：定时拉取最新列表；查看器打开时暂停，避免打断放大查看
      React.useEffect(() => {
        if (viewer !== null) return undefined
        let alive = true
        const timer = setInterval(() => {
          if (!alive) return
          load(undefined, kind, scope)
            .then((data) => { if (alive) setView({ status: 'ready', data }) })
            .catch(() => { /* 自动刷新失败保持现有列表，避免闪错 */ })
        }, AUTO_REFRESH_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load, kind, scope, viewer])

      React.useEffect(() => {
        if (viewer === null) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setViewer(null)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [viewer])

      const data = view.status === 'ready' ? view.data : null
      const items = data?.items ?? []
      const step = React.useCallback((delta) => {
        setViewer((current) => current === null ? null : {
          index: (current.index + delta + items.length) % items.length,
        })
      }, [items.length])

      // 分类开关：全局资产 / 当前对话
      const scopeSwitch = h('div', { className: 'dg-scopeSwitch', key: 'scope' }, [
        h('button', {
          type: 'button',
          key: 'global',
          className: `dg-scopeBtn${scope === 'global' ? ' dg-scopeActive' : ''}`,
          'data-gallery-scope': 'global',
          title: t('scopeGlobalHint'),
          onClick: () => { if (scope !== 'global') { setScope('global'); setViewer(null) } },
        }, t('scopeGlobal')),
        h('button', {
          type: 'button',
          key: 'session',
          className: `dg-scopeBtn${scope === 'session' ? ' dg-scopeActive' : ''}`,
          'data-gallery-scope': 'session',
          title: t('scopeSessionHint'),
          onClick: () => { if (scope !== 'session') { setScope('session'); setViewer(null) } },
        }, t('scopeSession')),
      ])

      // 设置按钮：打开产出根目录设置面板
      const settingsBtn = h('button', {
        type: 'button',
        key: 'settings',
        className: 'dg-btn dg-btnIcon',
        'data-gallery-settings': true,
        title: t('settingsTitle'),
        onClick: () => setSettingsOpen(true),
      }, '⚙')

      const header = h('div', { className: 'dg-header', key: 'header' }, [
        h('div', { className: 'dg-headerInfo', key: 'info' }, [
          h('span', { className: 'dg-title', key: 'title' },
            scope === 'session' ? t('scopeSession') : t('scopeGlobal')),
          h('span', { className: 'dg-sub', key: 'sub' },
            data === null
              ? (view.status === 'failed' ? t('errorTitle') : t('loading'))
              : format(t('subCount'), { shown: items.length, total: data.total })),
        ]),
        scopeSwitch,
        // 图片 / 文件 双画廊切换
        h('div', { className: 'dg-switch', key: 'switch' }, [
          h('button', {
            type: 'button',
            key: 'img',
            className: `dg-seg${kind === 'image' ? ' dg-segActive' : ''}`,
            'data-gallery-kind': 'image',
            onClick: () => { setKind('image'); setViewer(null) },
          }, t('kindImage')),
          h('button', {
            type: 'button',
            key: 'file',
            className: `dg-seg${kind === 'file' ? ' dg-segActive' : ''}`,
            'data-gallery-kind': 'file',
            onClick: () => { setKind('file'); setViewer(null) },
          }, t('kindFile')),
        ]),
        settingsBtn,
        h('button', {
          type: 'button',
          className: 'dg-btn',
          key: 'refresh',
          'data-gallery-refresh': true,
          disabled: refreshing,
          onClick: () => { void refresh() },
        }, refreshing ? t('refreshing') : t('refresh')),
      ])

      let body
      if (view.status === 'loading') {
        body = h('div', { className: 'dg-body', key: 'body' }, h('p', { className: 'dg-status' }, t('loading')))
      } else if (view.status === 'failed') {
        body = h('div', { className: 'dg-body', key: 'body' }, [
          h('p', { className: 'dg-status dg-error', key: 'msg' }, `${t('errorTitle')}：${view.message}`),
          h('p', { className: 'dg-status', key: 'retry' },
            h('button', { type: 'button', className: 'dg-btn', onClick: () => { void refresh() } }, t('retry'))),
        ])
      } else if (data !== null && data.rootMissing) {
        // 目录不存在是最常见的「装上打不开」原因：直接给出改目录入口
        body = h('div', { className: 'dg-body', key: 'body' }, [
          h('p', { className: 'dg-status', key: 'msg' },
            format(t('rootMissing'), { root: data.root })),
          h('p', { className: 'dg-status dg-statusAction', key: 'fix' },
            h('button', {
              type: 'button',
              className: 'dg-btn dg-primaryBtn',
              'data-gallery-fix-root': true,
              onClick: () => setSettingsOpen(true),
            }, t('changeRoot'))),
        ])
      } else if (items.length === 0) {
        // 当前对话为空时，要区分：会话记录没找到 / 日志空 / 找到了但确实没产出
        // 全局为空时，按画廊类型给不同文案（图片 / 文件）
        let emptyText = kind === 'file' ? t('emptyFile') : t('empty')
        if (scope === 'session' && data !== null) {
          const info = data.scopeInfo ?? {}
          if (info.ok === false) {
            emptyText = info.reason === 'session-not-found' ? t('scopeNotFound') : t('scopeLogEmpty')
          } else if (info.taskDirs === 0) {
            emptyText = t('scopeUnknown')
          } else {
            emptyText = t('emptySession')
          }
        }
        body = h('div', { className: 'dg-body', key: 'body' },
          h('p', { className: 'dg-status' }, emptyText))
      } else {
        const gridChildren = items.map((item) => kind === 'file'
          ? h(FileCard, {
              key: item.relPath,
              item,
              t,
              absPath: buildAbsPath(data.root, item.relPath),
              onOpenFolder: (abs) => { void callHost('reveal', { path: item.relPath }).catch((e) => console.error('dsh-gallery: reveal 失败', e)) },
              onPreview: (abs) => {
                const address = sessionFileAddressOf(sessionId, abs)
                try {
                  ctxRef.current.sidebarRight.openResource(address, { kind: 'text' })
                } catch (error) {
                  console.error('dsh-gallery: 侧栏预览失败', error, address)
                  // 兜底：至少把路径复制给用户
                  void copyText(abs)
                }
              },
            })
          : h(Card, {
              key: item.relPath,
              item,
              t,
              limiter: limiter.current,
              onOpen: (opened, anchorEl) => openViewer(items.indexOf(opened), anchorEl),
            }))
        body = h('div', { className: `dg-body${kind === 'file' ? ' dg-fileBody' : ''}`, key: 'body', 'data-gallery-body': true, ref: bodyScrollRef }, [
          h('div', { className: `dg-grid${kind === 'file' ? ' dg-fileGrid' : ''}`, key: 'grid' }, gridChildren),
          data.hidden > 0
            ? h('div', { className: 'dg-more', key: 'more', 'data-gallery-more': data.hidden },
                format(t('more'), { count: data.hidden }))
            : null,
          data.scan.capped
            ? h('div', { className: 'dg-more', key: 'capped' }, t('capped'))
            : null,
        ])
      }

      // 查看器作为覆盖层叠在网格上：网格保持挂载，滚动位置不丢
      const viewerLayer = viewer !== null && items.length > 0
        ? h('div', { className: 'dg-viewerLayer', key: 'viewerLayer' },
            h(Viewer, {
              items,
              index: viewer.index,
              t,
              onClose: closeViewer,
              onStep: step,
            }))
        : null

      // 设置面板：覆盖在整块之上
      const settingsLayer = settingsOpen
        ? h(SettingsPanel, {
            key: 'settingsPanel',
            t,
            onClose: () => setSettingsOpen(false),
            onSaved: () => { void refresh() },
          })
        : null

      return h('div', { className: 'dg-root', 'data-gallery-root': true }, [
        header,
        body,
        viewerLayer,
        settingsLayer,
      ])
    }

    /** tab 标题（chip / 浮动面板标题）。 */
    function GalleryTitle({ t }) {
      return h('span', { className: 'dg-title' }, t('type.label'))
    }

    /** 侧栏脚部入口按钮：点击打开画廊 tab。 */
    function OpenButton({ t, wide }) {
      return h('button', {
        type: 'button',
        className: 'dg-btn dg-open',
        'data-gallery-open': true,
        title: t('type.label'),
        'aria-label': t('type.label'),
        onClick: () => {
          try {
            ctxRef.current?.sidebarRight.openTab(KIND)
          } catch (error) {
            console.error('dsh-gallery: open failed', error)
          }
        },
      }, wide ? t('type.label') : '▦')
    }

    /** 对话区入口：编辑框右侧的紧凑按钮。 */
    function ComposerButton({ t }) {
      return h('button', {
        type: 'button',
        className: 'dg-btn dg-openCompact',
        'data-gallery-open-composer': true,
        title: t('type.label'),
        'aria-label': t('type.label'),
        onClick: () => {
          try {
            ctxRef.current?.sidebarRight.openTab(KIND)
          } catch (error) {
            console.error('dsh-gallery: open failed', error)
          }
        },
      }, '▦')
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ctxRef.current = ctx
        ctx.effect(() => () => { ctxRef.current = null }, 'dsh-gallery: context handle')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-gallery: dictionaries')

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-gallery'
          tag.dataset.pluginCss = 'dsh-gallery/gallery'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'dsh-gallery: styles')

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          priority: 'extension',
          // 正文保活：点文件/图片预览会切到另一个 tab，若不保活，画廊正文会被卸载，
          // 切回来时 kind 重置为图片、滚动位置归零 —— 关闭预览就回不到原来那张缩略图。
          // 声明 keepMounted 后，切 tab / 切会话 / 收起面板期间正文保持挂载，
          // 当前画廊类型、网格滚动位置、最近查看的卡片都原样保留。
          keepMounted: true,
          title: () => t('type.label'),
          guide: [{
            id: 'gallery',
            order: 20,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
          }],
        }), 'dsh-gallery: tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          locale: NS,
        }, GalleryBody)), 'dsh-gallery: tab body')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: ID,
          locale: NS,
        }, GalleryTitle)), 'dsh-gallery: tab title')

        // 入口一：左侧边栏脚部（宽态显示文字，窄态显示图标）。
        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-gallery-open',
          order: 20,
          label: () => t('type.label'),
          locale: NS,
        }, OpenButton)), 'dsh-gallery: sidebar entry')

        // 入口二：对话编辑框右侧的紧凑按钮。
        ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-gallery-open',
          order: 30,
          label: () => t('type.label'),
          locale: NS,
        }, ComposerButton)), 'dsh-gallery: composer entry')
      },
    }
  },
})
