window.__ModuleLoader__.load({
  id: 'dsh-gallery',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 与 Host 半部一致的路由（exact Fetch 路由的 path）。 */
    const ROUTE = '/api/dsh-gallery'
    /** 音视频直链（GET，支持 Range）——给 <video>/<audio> 用 */
    const MEDIA_ROUTE = '/api/dsh-gallery/media'
    /** tab 类型的身份；也是正文与标题在 keyed slot 里的 key。 */
    const KIND = 'gallery'
    const ID = 'dsh-gallery'
    /** 缩略图最长边（像素）——客户端压缩目标。 */
    const THUMB_SIZE = 200
    /** 放大视图最长边；仍然是 canvas 缩放结果，不把原图直接塞进 <img>。 */
    const VIEW_SIZE = 1600
    /** 可内联解码的图片扩展名（缩略图/查看器/原图模式共用一份定义）。 */
    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']
    /** 视频扩展名（客户端判断 mediaType 兜底用，与 Host 的 VIDEO_EXTS 保持一致）。 */
    const VIDEO_EXTS_CLIENT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv'])
    /** blob 播放的文件上限：超过就改用系统播放器（避免把 127MB 塞进浏览器内存）。 */
    const BLOB_MAX_BYTES = 60 * 1024 * 1024
    /** 判断某条目是否是图片（大小写不敏感）。 */
    function isImageItem(it) {
      const ext = String(it?.extension ?? '').toLowerCase()
      if (IMAGE_EXTS.includes(ext)) return true
      // extension 缺失时退回看 relPath 的扩展名
      if (ext === '') {
        const rel = String(it?.relPath ?? '')
        const dot = rel.lastIndexOf('.')
        if (dot >= 0) return IMAGE_EXTS.includes(rel.slice(dot).toLowerCase())
      }
      return false
    }
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
      scopeGlobalHint: '按对话分组的全部产出',
      scopeSessionHint: '仅本对话产出过的文件',
      scopeUnknown: '未记录本对话产出',
      scopeNotFound: '找不到本对话的会话记录',
      scopeLogEmpty: '本对话的会话记录为空',
      subCount: '{shown} / {total} 条',
      // ===== 资产分类（三色边框）=====
      catFinal: '最终',
      catInput: '输入',
      catIntermediate: '中间',
      catUnknown: '未归类',
      catLegendFinal: '最终交付物',
      catLegendInput: '输入素材',
      catLegendIntermediate: '中间产物',
      catLegendUnknown: '未归类',
      catLegendHint: '边框颜色代表资产类型；「未归类」是会话记录里查不到归属的历史文件',
      // ===== 全局按对话分组 =====
      groupCount: '{count} 个',
      groupFinal: '最终 {n}',
      groupInput: '输入 {n}',
      groupIntermediate: '中间 {n}',
      groupUnknown: '未归类 {n}',
      groupTruncated: '仅显示最近 {shown} 个，共 {total} 个',
      groupHistoryTitle: '历史资产',
      groupCurrentBadge: '当前对话',
      groupHistoryHint: '这些文件在会话记录里查不到归属对话',
      groupUnassigned: '未归属对话',
      groupFiles: '{n} 个文件',
      groupExpand: '展开',
      groupCollapse: '收起',
      groupEmpty: '没有资产',
      groupShowIntermediate: '显示中间产物 {n}',
      groupHideIntermediate: '隐藏中间产物 {n}',
      // 设置面板
      settingsTitle: '设置产出根目录',
      rootLabel: '产出根目录',
      rootsLabel: '扫描目录（{count} 个）',
      rootAddPlaceholder: '输入要新增的目录绝对路径，如 D:\\输出',
      addRoot: '添加目录',
      addingRoot: '添加中…',
      removeRootHint: '从扫描列表移除（不会删除文件）',
      rootsTip: '可加多个目录：DSH 每个会话有独立工作目录，产出不一定落在同一个目录下。',
      done: '完成',
      resetDefaultHint: '改为自动探测到的默认目录（会替换整个列表）',
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
      dragHint: '拖动右侧滑块或直接拖图平移',
      panUpHint: '向上移动图片',
      panDownHint: '向下移动图片',
      trackHint: '点击此位置跳转',
      zoomInHint: '放大（也可按 +）',
      zoomOutHint: '缩小（也可按 -）',
      zoomResetHint: '恢复原始大小（也可按 0）',
      // 右键菜单
      ctxHint: '右键更多操作',
      ctxHide: '隐藏（不再列出）',
      ctxUnhide: '取消隐藏',
      ctxReveal: '打开所在文件夹',
      ctxCopy: '复制路径',
      ctxDelete: '删除文件',
      ctxDeleteConfirm: '确认删除？此操作不可恢复',
      ctxDeleteYes: '确认删除',
      ctxDeleteNo: '取消',
      ctxHiddenDone: '已隐藏，可在设置里恢复',
      ctxDeleting: '删除中…',
      ctxDeleteFailed: '删除失败',
      // 音视频画廊（v0.10.1）
      kindMedia: '音视频',
      emptyMedia: '这段时间没有音视频产出',
      mediaPlay: '播放',
      mediaOpenExternal: '用系统播放器打开',
      mediaOpenFolder: '打开所在文件夹',
      mediaOpenFolderHint: '在资源管理器里选中该文件',
      mediaOpenFailed: '打开失败：{message}',
      mediaOpenOk: '已交给系统处理',
      mediaBinaryHint: '这类文件浏览器无法直接解码，用上面的按钮外部打开。',
      mediaDuration: '时长',
      mediaBlobLoading: '正在载入文件 {pct}%（载入后可拖动进度条）',
      mediaBlobLoadingIndeterminate: '正在载入文件…（载入后可拖动进度条）',
      mediaTooBigTitle: '文件较大，不载入面板',
      mediaTooBigHint: '该文件 {size}，超过面板内播放上限。用系统播放器打开可立即拖动查看。',
      mediaBlobReady: '已载入，可拖动进度条',
      mediaGrabFrame: '截取当前帧',
      mediaGrabFrameHint: '把当前播放位置的画面存成 PNG 图片',
      mediaGrabFrameOk: '已保存：{name}',
      mediaGrabFrameFailed: '截帧失败：{message}',
      mediaGrabFrameNoVideo: '只有视频可以截帧',
      mediaNoPreview: '浏览器无法解码该格式',
      mediaLoadFailed: '加载失败',
      mediaThumbPending: '生成首帧中…',
      mediaThumbFailed: '无法生成首帧',
      mediaOpenHint: '点击在面板内播放；右键可用系统播放器打开',
      mediaCloseHint: '关闭播放器',
      mediaPlaying: '播放中',
      // 原图（原尺寸查看）
      ctxOpenOriginal: '查看原图（原尺寸细节）',
      ctxOpenOriginalHint: '按原图像素打开，适合看细节；大图加载会慢一些',
      viewerToOriginal: '原图',
      viewerToPreview: '预览',
      viewerOriginalLoading: '正在加载原图 {pct}%',
      viewerOriginalLoadingIndeterminate: '正在加载原图…',
      viewerOriginalReady: '原图 {w} × {h}',
      viewerOriginalFailed: '原图加载失败',
      viewerSwapHint: '右键或按 O 切换原图对比',
      viewerSwappedToOriginal: '已切换原图，细节更清楚',
      viewerSwappedToPreview: '已切回预览图',
      // 已隐藏管理
      hiddenCount: '已隐藏 {count} 个',
      hiddenClear: '全部恢复',
      hiddenClearing: '恢复中…',
      hiddenClearHint: '让所有被隐藏的文件重新出现在列表里（不会删除文件）',
      hiddenCleared: '已全部恢复',
      hiddenMore: '还有 {count} 个未显示',
      pagerRange: '第 {start}–{end} 条 · 共 {total} 条',
      pageTip: '跳到第 {page} 页',
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
      scopeGlobalHint: 'All outputs, grouped by conversation',
      scopeSessionHint: 'Only files produced in this chat',
      scopeUnknown: 'No outputs recorded for this chat',
      scopeNotFound: 'Cannot find this chat’s session log',
      scopeLogEmpty: 'This chat’s session log is empty',
      subCount: '{shown} of {total}',
      // Asset categories (colored borders)
      catFinal: 'Final',
      catInput: 'Input',
      catIntermediate: 'Interim',
      catUnknown: 'Unclassified',
      catLegendFinal: 'Final deliverable',
      catLegendInput: 'Input material',
      catLegendIntermediate: 'Interim product',
      catLegendUnknown: 'Unclassified',
      catLegendHint: 'Border color shows the asset type; “Unclassified” means the session logs have no record of it',
      // Grouped by conversation (global view)
      groupCount: '{count} files',
      groupFinal: 'Final {n}',
      groupInput: 'Input {n}',
      groupIntermediate: 'Interim {n}',
      groupUnknown: 'Unclassified {n}',
      groupTruncated: 'Showing latest {shown} of {total}',
      groupHistoryTitle: 'Older assets',
      groupCurrentBadge: 'This chat',
      groupHistoryHint: 'These files have no conversation recorded in the session logs',
      groupUnassigned: 'No conversation',
      groupFiles: '{n} files',
      groupExpand: 'Expand',
      groupCollapse: 'Collapse',
      groupEmpty: 'No assets',
      groupShowIntermediate: 'Show interim files ({n})',
      groupHideIntermediate: 'Hide interim files ({n})',
      // Settings panel
      settingsTitle: 'Output root folder',
      rootLabel: 'Output root',
      rootsLabel: 'Scan folders ({count})',
      rootAddPlaceholder: 'Absolute path to add, e.g. D:\\outputs',
      addRoot: 'Add folder',
      addingRoot: 'Adding…',
      removeRootHint: 'Remove from scan list (files are not deleted)',
      rootsTip: 'Multiple folders allowed: each DSH session has its own working directory, so outputs may land outside one root.',
      done: 'Done',
      resetDefaultHint: 'Switch to the auto-detected default folder (replaces the whole list)',
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
      dragHint: 'Drag the scrollbar on the right, or drag the image',
      panUpHint: 'Move image up',
      panDownHint: 'Move image down',
      trackHint: 'Click here to jump',
      zoomInHint: 'Zoom in (or press +)',
      zoomOutHint: 'Zoom out (or press -)',
      zoomResetHint: 'Reset zoom (or press 0)',
      ctxHint: 'Right-click for more',
      ctxHide: 'Hide (stop listing)',
      ctxUnhide: 'Unhide',
      ctxReveal: 'Open containing folder',
      ctxCopy: 'Copy path',
      ctxDelete: 'Delete file',
      ctxDeleteConfirm: 'Delete permanently? This cannot be undone',
      ctxDeleteYes: 'Delete',
      ctxDeleteNo: 'Cancel',
      ctxHiddenDone: 'Hidden. Restore it in settings later.',
      ctxDeleting: 'Deleting…',
      ctxDeleteFailed: 'Delete failed',
      kindMedia: 'Media',
      emptyMedia: 'No audio or video produced in this period',
      mediaPlay: 'Play',
      mediaOpenExternal: 'Open in system player',
      mediaOpenFolder: 'Open containing folder',
      mediaOpenFolderHint: 'Show the file in the file manager',
      mediaOpenFailed: 'Could not open: {message}',
      mediaOpenOk: 'Handed to the system',
      mediaBinaryHint: 'The browser cannot decode this format; use the buttons above to open it outside the panel.',
      mediaDuration: 'Duration',
      mediaBlobLoading: 'Loading file {pct}% (seekable once loaded)',
      mediaBlobLoadingIndeterminate: 'Loading file… (seekable once loaded)',
      mediaTooBigTitle: 'File is too large for the panel',
      mediaTooBigHint: 'This file is {size}, over the in-panel limit. Open it in the system player to seek right away.',
      mediaBlobReady: 'Loaded — seeking available',
      mediaGrabFrame: 'Save current frame',
      mediaGrabFrameHint: 'Save the frame at the current play position as a PNG',
      mediaGrabFrameOk: 'Saved: {name}',
      mediaGrabFrameFailed: 'Frame grab failed: {message}',
      mediaGrabFrameNoVideo: 'Only video can be grabbed',
      mediaNoPreview: 'The browser cannot decode this format',
      mediaLoadFailed: 'Load failed',
      mediaThumbPending: 'Making a first frame…',
      mediaThumbFailed: 'Cannot make a first frame',
      mediaOpenHint: 'Click to play in the panel; right-click to open in the system player',
      mediaCloseHint: 'Close the player',
      mediaPlaying: 'Playing',
      ctxOpenOriginal: 'View original (full detail)',
      ctxOpenOriginalHint: 'Opens at the image’s own pixel size; large images take longer to load',
      viewerToOriginal: 'Original',
      viewerToPreview: 'Preview',
      viewerOriginalLoading: 'Loading original {pct}%',
      viewerOriginalLoadingIndeterminate: 'Loading original…',
      viewerOriginalReady: 'Original {w} × {h}',
      viewerOriginalFailed: 'Original failed to load',
      viewerSwapHint: 'Right-click or press O to compare the original',
      viewerSwappedToOriginal: 'Original shown — full detail',
      viewerSwappedToPreview: 'Back to the preview',
      hiddenCount: '{count} hidden',
      hiddenClear: 'Restore all',
      hiddenClearing: 'Restoring…',
      hiddenClearHint: 'Show all hidden files again (files are not deleted)',
      hiddenCleared: 'All restored',
      hiddenMore: '{count} more not shown',
      pagerRange: '{start}–{end} of {total}',
      pageTip: 'Go to page {page}',
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
.dg-fieldHead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dg-fieldLabel { font-size: 12px; font-weight: 600; }
.dg-fieldHint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }

/* ===== 多扫描目录列表 ===== */
.dg-rootsList {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 168px;
  overflow: auto;
}
.dg-rootItem {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  font-size: 12px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
}
.dg-rootItemMissing {
  border-color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
}
.dg-rootOk { flex: 0 0 auto; font-size: 12px; color: var(--dsw-alias-brand-primary); }
.dg-rootItemMissing .dg-rootOk { color: var(--dsw-alias-state-error-primary); }
.dg-rootPath {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
}
.dg-rootRemove {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
.dg-rootRemove:hover:not(:disabled) {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
.dg-rootRemove:disabled { opacity: .4; cursor: default; }
.dg-rootAdd { display: flex; gap: 6px; align-items: center; }
.dg-rootInput { flex: 1 1 auto; min-width: 0; }
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

/* ===== 已隐藏管理区块 ===== */
.dg-hiddenBox {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 10px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}
.dg-hiddenRow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dg-hiddenLabel {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dg-hiddenList {
  margin: 0;
  padding: 0 0 0 14px;
  list-style: disc;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 96px;
  overflow: auto;
}
.dg-hiddenItem {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dg-hiddenMore { font-size: 11px; color: var(--dsw-alias-label-secondary); padding-left: 2px; }
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
/* 网格区外层：定位容器，右侧挂滚动辅助列（无滚轮场景） */
.dg-bodyWrap {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  display: flex;
  overflow: hidden;
}
.dg-bodyWrap > .dg-body {
  flex: 1 1 auto;
  min-width: 0;
  /* 右侧留出 38px 给辅助列，避免滑块压住卡片 */
  padding-right: 42px;
}
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

/* ===== 资产分类：三色边框 + 角标 =====
   输入 = 灰蓝、中间 = 橙色、最终 = 绿色。
   边框加粗到 2px 以便一眼分辨。 */
.dg-card { position: relative; }
.dg-cat-final      { border: 2px solid #1A936F; }
.dg-cat-input      { border: 2px solid #8A8F99; }
.dg-cat-intermediate { border: 2px solid #D48806; }
.dg-cat-unknown    { border: 2px solid #C8CDD6; }
.dg-cat-final:hover      { border-color: #157A5C; }
.dg-cat-input:hover      { border-color: #6B7079; }
.dg-cat-intermediate:hover { border-color: #B36F05; }
.dg-cat-unknown:hover    { border-color: #A8AEB8; }

/* 角标：贴在缩略图右上角 */
.dg-catBadge {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  padding: 2px 7px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.5;
  color: #FFFFFF;
  pointer-events: none;
}
.dg-catBadge-final      { background: #1A936F; }
.dg-catBadge-input      { background: #8A8F99; }
.dg-catBadge-intermediate { background: #D48806; }
.dg-catBadge-unknown    { background: #8C93A0; }

/* ===== 图例（分类颜色说明）===== */
.dg-legend {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
  padding: 7px 10px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
}
.dg-legendItem { display: inline-flex; align-items: center; gap: 5px; }
.dg-legendSwatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.dg-legendSwatch-final      { background: #1A936F; }
.dg-legendSwatch-input      { background: #8A8F99; }
.dg-legendSwatch-intermediate { background: #D48806; }
.dg-legendSwatch-unknown    { background: #8C93A0; }

/* ===== 分组（全局按对话）===== */
.dg-groups { display: flex; flex-direction: column; gap: 8px; }
.dg-group {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1);
}
.dg-groupHead {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 11px;
  background: var(--dsw-alias-bg-layer-2);
  border: none;
  border-bottom: 1px solid transparent;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
  appearance: none;
}
.dg-groupHead:hover { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); }
.dg-groupHeadOpen { border-bottom-color: var(--dsw-alias-border-l1); }
.dg-groupArrow {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  transition: transform .15s ease;
  width: 10px;
}
.dg-groupArrowOpen { transform: rotate(90deg); }
.dg-groupTitle {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dg-groupHistory .dg-groupTitle { color: var(--dsw-alias-label-secondary); font-weight: 500; }

/* 当前对话组：置顶 + 左侧强调条 + 徽标，让用户一眼认出「这就是我刚才那次」 */
.dg-groupCurrent {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
}
.dg-groupCurrent .dg-groupHead {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-layer-2));
}
.dg-groupCurrentBadge {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.6;
  color: #FFFFFF;
  background: var(--dsw-alias-brand-primary);
}
.dg-groupCurrent .dg-groupTitle { font-weight: 700; }
.dg-groupDate {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dg-groupChips { display: inline-flex; gap: 5px; flex: 0 0 auto; }
.dg-chip {
  padding: 1px 7px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.6;
  color: #FFFFFF;
}
.dg-chip-final { background: #1A936F; }
.dg-chip-input { background: #8A8F99; }
.dg-chip-intermediate { background: #D48806; }
.dg-chip-unknown { background: #8C93A0; }
.dg-chipMuted {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
  font-weight: 500;
}
.dg-groupBody { padding: 10px; }
.dg-groupEmpty {
  padding: 14px 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  text-align: center;
}
.dg-groupHint {
  padding: 7px 11px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
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

/* ===== 分页条：常驻网格下方 ===== */
.dg-pager {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dg-pagerInfo {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dg-pagerRemain {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dg-pagerBtns {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.dg-pageBtn {
  appearance: none;
  min-width: 28px;
  height: 26px;
  padding: 0 8px;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  cursor: pointer;
  transition: color .15s ease, border-color .15s ease, background .15s ease;
}
.dg-pageBtn:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dg-pageActive {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  font-weight: 600;
  cursor: default;
}
.dg-pageActive:disabled { opacity: 1; }
.dg-pageGap {
  padding: 0 2px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dg-pageBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

/* ===== 右键菜单 ===== */
.dg-ctxLayer { position: fixed; inset: 0; z-index: 60; }
.dg-ctxMenu {
  position: fixed;
  min-width: 180px;
  max-width: 260px;
  padding: 6px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,.22);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dg-ctxHead {
  padding: 5px 8px 7px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  margin-bottom: 3px;
}
.dg-ctxItem {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  text-align: left;
  font: inherit;
  font-size: 12px;
  line-height: 1.3;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.dg-ctxItem:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dg-ctxItem:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dg-ctxIco { flex: 0 0 auto; font-size: 13px; line-height: 1; opacity: .85; }
.dg-ctxDanger { color: var(--dsw-alias-state-error-primary); }
.dg-ctxDanger:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }

/* ===== 删除确认 ===== */
.dg-confirmLayer {
  position: absolute; inset: 0; z-index: 70;
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 72%, transparent);
}
.dg-confirm {
  width: 100%; max-width: 340px;
  padding: 14px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,.24);
  display: flex; flex-direction: column; gap: 10px;
}
.dg-confirmTitle { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dg-confirmName {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  word-break: break-all;
  padding: 7px 9px;
  background: var(--dsw-alias-bg-layer-2);
  border-radius: 6px;
}
.dg-confirmActions { display: flex; justify-content: flex-end; gap: 8px; }
.dg-dangerBtn {
  color: #fff;
  background: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
.dg-dangerBtn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 85%, #000 15%);
  border-color: var(--dsw-alias-state-error-primary);
}

/* ===== 放大预览：舞台 + 右侧平移控制列 ===== */
.dg-viewerStage {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  display: flex;
}
.dg-zoomBadge {
  flex: 0 0 auto;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
  border: 1px solid var(--dsw-alias-brand-primary);
  border-radius: 5px;
  line-height: 1.4;
}
.dg-zoomCtl { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.dg-btnTiny {
  min-width: 26px;
  padding: 2px 6px;
  font-size: 12px;
  line-height: 16px;
}

/* 右侧竖列：▲ 按钮、轨道、▼ 按钮（放大页与列表页共用） */
.dg-panRail {
  position: absolute;
  top: 8px;
  right: 4px;
  bottom: 8px;
  width: 30px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  z-index: 6;
}
/* 列表页的辅助列：贴着网格区右侧，上下各留一点边 */
.dg-bodyWrap > .dg-panRail {
  top: 10px;
  bottom: 10px;
}
.dg-panBtn {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.dg-panBtn:hover:not(:disabled) {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dg-panBtn:disabled { opacity: .35; cursor: default; }
.dg-panBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

.dg-dragTrack {
  flex: 1 1 auto;
  position: relative;
  width: 10px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  cursor: pointer;
  user-select: none;
  touch-action: none;
}
.dg-dragTrack:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.dg-dragThumb {
  position: absolute;
  left: 1px;
  right: 1px;
  top: 0;
  min-height: 24px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);
  border: 1px solid var(--dsw-alias-brand-primary);
  cursor: grab;
  transition: background .15s ease;
}
.dg-dragThumb:hover { background: var(--dsw-alias-brand-primary); }
.dg-dragThumbActive { background: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); }
.dg-dragThumb:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

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
.dg-viewerBody { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; align-items: center; justify-content: center; padding: 10px 42px 10px 10px; }
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
/* 原图/预览切换按钮：远程控制（无鼠标）时的主要入口，要够显眼够大 */
.dg-btnOrig { white-space: nowrap; min-width: 86px; }
.dg-btnOrigActive {
  border-color: var(--dsw-alias-accent-default, #4a7cff) !important;
  color: var(--dsw-alias-accent-default, #4a7cff) !important;
  font-weight: 600;
}
/* 原图加载失败的警示条：不说明原因用户会以为图坏了 */
.dg-viewerWarn {
  flex: 0 0 auto;
  padding: 6px 10px;
  margin: 0 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-error, rgba(220, 60, 60, 0.12));
  color: var(--dsw-alias-label-error, #d93a3a);
  font-size: 11px;
  word-break: break-all;
}
/* ===== 音视频画廊（v0.10.1） ===== */
.dg-mediaGrid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.dg-mediaCard {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  overflow: hidden;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-default, rgba(255,255,255,0.10));
  background: var(--dsw-alias-bg-secondary, rgba(255,255,255,0.03));
  cursor: pointer;
  text-align: left;
  aspect-ratio: 16 / 10;
}
.dg-mediaCard:hover { border-color: var(--dsw-alias-accent-default, #4a7cff); }
.dg-mediaCard:focus-visible { outline: 2px solid var(--dsw-alias-accent-default, #4a7cff); outline-offset: 2px; }
.dg-mediaAudio { aspect-ratio: 16 / 8; }
.dg-mediaThumb {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: repeating-linear-gradient(45deg, rgba(255,255,255,0.03), rgba(255,255,255,0.03) 8px, transparent 8px, transparent 16px);
  overflow: hidden;
}
.dg-mediaThumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dg-mediaPlaceholder { font-size: 26px; opacity: 0.55; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dg-mediaFail { color: var(--dsw-alias-label-error, #d93a3a); }
/* 播放键悬停才明显，避免遮住首帧 */
.dg-mediaPlayIco {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  width: 42px; height: 42px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.55);
  color: #fff; font-size: 16px;
  opacity: 0.85;
  transition: opacity 120ms ease, transform 120ms ease;
  pointer-events: none;
}
.dg-mediaCard:hover .dg-mediaPlayIco { opacity: 1; transform: translate(-50%, -50%) scale(1.08); }
.dg-mediaBadge {
  position: absolute; top: 8px; left: 8px;
  padding: 2px 6px; border-radius: 4px;
  background: rgba(0,0,0,0.62); color: #fff;
  font-size: 10px; font-weight: 600; letter-spacing: 0.4px;
  pointer-events: none;
}
.dg-mediaMeta {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 18px 8px 8px;
  background: linear-gradient(180deg, transparent, rgba(0,0,0,0.78));
  display: flex; flex-direction: column; gap: 2px;
  pointer-events: none;
}
.dg-mediaName {
  font-size: 12px; color: #fff; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dg-mediaSub {
  font-size: 10px; color: rgba(255,255,255,0.72);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 播放器弹层 */
.dg-mediaLayer {
  position: absolute; inset: 0; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.82);
  padding: 16px;
}
.dg-mediaPanel {
  display: flex; flex-direction: column;
  width: 100%; max-width: 720px; max-height: 100%;
  background: var(--dsw-alias-bg-primary, #16181d);
  border-radius: 10px; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-default, rgba(255,255,255,0.12));
  box-shadow: 0 12px 40px rgba(0,0,0,0.55);
}
.dg-mediaBar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  background: #1b1e24;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.dg-mediaPTitle {
  flex: 1 1 auto; min-width: 0;
  font-size: 13px; font-weight: 600;
  /* 强制高对比：不用 alias 变量（DSH 未定义时会 fallback 失效，显得很暗） */
  color: #f0f2f5;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dg-mediaStage {
  display: flex; align-items: center; justify-content: center;
  background: #000; min-height: 120px;
  padding: 0;
}
.dg-mediaPanelVideo .dg-mediaStage video { width: 100%; max-height: 60vh; display: block; }
.dg-mediaPanelAudio .dg-mediaStage { padding: 24px 16px; background: transparent; }
.dg-mediaPanelAudio .dg-mediaStage audio { width: 100%; }
.dg-mediaFoot {
  padding: 8px 12px 10px;
  font-size: 11px;
  color: #a9b1bd;
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  background: #1b1e24;
  border-top: 1px solid rgba(255,255,255,0.08);
}
.dg-mediaFootName {
  color: #e8eaed;
  font-weight: 600; font-size: 12px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dg-mediaFootMeta { word-break: break-all; }
/* 文件过大：引导用系统播放器 */
.dg-mediaTooBig {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 28px 20px; text-align: center;
}
.dg-mediaTooBigIco { font-size: 40px; opacity: 0.7; }
.dg-mediaTooBigTitle { font-size: 14px; font-weight: 600; color: #f0f2f5; }
.dg-mediaTooBigHint { font-size: 12px; color: #a9b1bd; max-width: 380px; line-height: 1.6; }
/* 动作按钮行（不用 dg-btn：媒体弹层里没有那套样式，会显示成灰按钮） */
.dg-mediaActionRow { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; justify-content: center; }
.dg-mediaActBtn {
  appearance: none; border: 1px solid rgba(255,255,255,0.22);
  background: #2a2f38; color: #e8eaed;
  padding: 9px 20px; border-radius: 8px;
  font-size: 13px; font-weight: 500; line-height: 1.2;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, transform 60ms ease;
}
.dg-mediaActBtn:hover { background: #353b45; border-color: rgba(255,255,255,0.35); }
.dg-mediaActBtn:active { transform: translateY(1px); }
.dg-mediaActBtn:focus-visible { outline: 2px solid #4a7cff; outline-offset: 2px; }
.dg-mediaActPrimary {
  background: #2f5bd4; border-color: #4a7cff; color: #ffffff; font-weight: 600;
}
.dg-mediaActPrimary:hover { background: #3a6ae8; border-color: #6b93ff; }
/* blob 载入进度 */
.dg-mediaLoading { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 30px 20px; width: 100%; }
.dg-mediaLoadingText { font-size: 12px; color: #a9b1bd; }
.dg-mediaProgressBar {
  width: 70%; max-width: 320px; height: 6px; border-radius: 3px;
  background: rgba(255,255,255,0.12); overflow: hidden;
}
.dg-mediaProgressFill { height: 100%; background: #4a7cff; transition: width 200ms ease; }
/* 截取当前帧按钮 */
.dg-mediaGrabBtn { white-space: nowrap; font-size: 12px; }
/* 截帧结果提示 */
.dg-mediaNotice {
  padding: 6px 12px; font-size: 11px; text-align: center;
  border-top: 1px solid rgba(255,255,255,0.08);
}
.dg-mediaNoticeOk { color: #6ee7a0; background: rgba(60, 200, 120, 0.10); }
.dg-mediaNoticePending { color: #a9b1bd; background: rgba(255,255,255,0.05); }
.dg-mediaNoticeFail { color: #ff8a8a; background: rgba(220, 60, 60, 0.12); }

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
    /**
     * 右键菜单：隐藏 / 打开位置 / 复制路径 / 删除。
     * 挂在卡片上，位置跟随鼠标；点外部或按 Esc 关闭。
     * 删除需要二次确认（走 ConfirmDialog）。
     */
    function ContextMenu({ t, x, y, item, actions, onClose }) {
      const menuRef = React.useRef(null)
      const [pos, setPos] = React.useState({ left: x, top: y })

      // 边界处理：靠近视口右侧/底部时向内收，避免被截断
      React.useLayoutEffect(() => {
        const node = menuRef.current
        if (node === null) return
        const rect = node.getBoundingClientRect()
        const pad = 8
        let left = x
        let top = y
        if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad
        if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad
        setPos({ left: Math.max(pad, left), top: Math.max(pad, top) })
      }, [x, y])

      React.useEffect(() => {
        const onDown = (event) => {
          if (menuRef.current !== null && menuRef.current.contains(event.target)) return
          onClose()
        }
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        // 捕获阶段监听，确保点击卡片本身也能关闭菜单
        document.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey)
        }
      }, [onClose])

      const entry = (key, label, icon, run, danger) => h('button', {
        type: 'button',
        key,
        className: `dg-ctxItem${danger ? ' dg-ctxDanger' : ''}`,
        'data-gallery-ctx': key,
        onClick: (event) => {
          event.stopPropagation()
          event.preventDefault()
          onClose()
          run()
        },
      }, [
        h('span', { className: 'dg-ctxIco', key: 'i' }, icon),
        h('span', { key: 'l' }, label),
      ])

      return h('div', {
        className: 'dg-ctxLayer',
        key: 'ctxLayer',
        onPointerDown: (event) => event.stopPropagation(),
        onContextMenu: (event) => event.preventDefault(),
      }, h('div', {
        className: 'dg-ctxMenu',
        key: 'menu',
        ref: menuRef,
        role: 'menu',
        'data-gallery-contextmenu': item.relPath,
        style: { left: `${pos.left}px`, top: `${pos.top}px` },
      }, [
        h('div', { className: 'dg-ctxHead', key: 'head' }, item.name),
        // 「查看原图」只对图片出现：文件卡片没有原图概念，避免无效按钮
        actions.onOpenOriginal !== undefined
          ? entry('original', t('ctxOpenOriginal'), '🔍', () => actions.onOpenOriginal())
          : null,
        entry('hide', t('ctxHide'), '🚫', () => actions.onHide()),
        entry('reveal', t('ctxReveal'), '📂', () => actions.onReveal()),
        entry('copy', t('ctxCopy'), '⧉', () => actions.onCopy()),
        entry('delete', t('ctxDelete'), '🗑', () => actions.onDelete(), true),
      ]))
    }

    /** 删除确认弹窗：删除不可逆，必须二次确认。 */
    function ConfirmDialog({ t, name, busy, onCancel, onConfirm }) {
      React.useEffect(() => {
        const onKey = (event) => {
          if (busy) return
          if (event.key === 'Escape') { event.preventDefault(); onCancel() }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [busy, onCancel])

      return h('div', {
        className: 'dg-confirmLayer',
        key: 'confirmLayer',
        onPointerDown: (event) => event.stopPropagation(),
      }, h('div', {
        className: 'dg-confirm',
        role: 'alertdialog',
        'aria-modal': true,
        'data-gallery-confirm-delete': name,
      }, [
        h('div', { className: 'dg-confirmTitle', key: 'title' }, t('ctxDeleteConfirm')),
        h('div', { className: 'dg-confirmName', key: 'name' }, name),
        h('div', { className: 'dg-confirmActions', key: 'actions' }, [
          h('button', {
            type: 'button', key: 'no', className: 'dg-btn',
            disabled: busy,
            onClick: onCancel,
          }, t('ctxDeleteNo')),
          h('button', {
            type: 'button', key: 'yes', className: 'dg-btn dg-dangerBtn',
            disabled: busy,
            'data-gallery-confirm-yes': true,
            onClick: onConfirm,
          }, busy ? t('ctxDeleting') : t('ctxDeleteYes')),
        ]),
      ]))
    }

    /**
     * 音视频卡片（v0.10.1）。
     *
     * 首帧缩略图：视频用 <video> 解码到稍后一帧，再画进 canvas 存成 data URL。
     * 抽帧是**懒加载**的（进入视口才做），否则一页几十个视频会同时解码把面板卡死。
     * 音频没有画面，只显示音符图标。
     */
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
    function MediaPlayer({ item, t, onClose }) {
      const isVideo = item.mediaType === 'video'
      const tooBig = typeof item.size === 'number' && item.size > BLOB_MAX_BYTES
      // blob 状态：loading / ready / failed
      const [blobState, setBlobState] = React.useState({ status: tooBig ? 'too-big' : 'loading' })
      const [failed, setFailed] = React.useState(false)
      const [dims, setDims] = React.useState(null)
      const blobUrlRef = React.useRef(null)
      const videoRef = React.useRef(null)
      // 截帧结果提示（成功/失败），2 秒后自动消失
      const [grabNotice, setGrabNotice] = React.useState(null)

      // 加载完整文件成 blob（≤ 60MB 才做）
      React.useEffect(() => {
        if (tooBig) return undefined
        let alive = true
        const controller = new AbortController()

        fetchRaw(item.relPath, controller.signal, (loaded, total) => {
          if (!alive || tooBig) return
          const pct = total > 0 ? Math.round((loaded / total) * 100) : -1
          setBlobState((cur) => (cur.status === 'loading' ? { status: 'loading', pct } : cur))
        })
          .then((blob) => {
            if (!alive) return
            const url = URL.createObjectURL(blob)
            blobUrlRef.current = url
            setBlobState({ status: 'ready', url, bytes: blob.size })
          })
          .catch((error) => {
            if (!alive || controller.signal.aborted) return
            setBlobState({ status: 'failed', message: String(error?.message ?? error) })
          })

        return () => {
          alive = false
          controller.abort()
        }
      }, [item.relPath, tooBig])

      // 卸载时释放 blob URL（不释放会一直占内存）
      React.useEffect(() => () => {
        if (blobUrlRef.current !== null) {
          URL.revokeObjectURL(blobUrlRef.current)
          blobUrlRef.current = null
        }
      }, [])

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

      // 「用系统播放器打开」
      /**
       * 外部打开（两个动作走不同 mode，Host 侧据此选不同命令）：
       *   play   → cmd start，用文件关联的默认程序打开（媒体文件能直接播）
       *   select → explorer /select，在资源管理器里选中该文件
       *
       * 关键：以前是 .catch(e => console.error(...)) 静默吞错，
       * 用户只看到按钮有动画、什么都没发生。现在把失败原因显示出来。
       */
      const runReveal = React.useCallback((mode) => {
        setGrabNotice({ kind: 'pending', text: mode === 'play' ? '正在打开…' : '正在定位…' })
        void callHost('reveal', { path: item.relPath, mode }).then((resp) => {
          if (resp !== null && resp.ok === false) {
            const msg = resp.error?.message ?? 'unknown'
            setGrabNotice({
              kind: 'failed',
              text: format(t('mediaOpenFailed'), { message: `${resp.error?.code ?? ''} ${msg}`.trim() }),
            })
            console.warn('dsh-gallery: reveal 失败', resp)
            return
          }
          setGrabNotice({ kind: 'ok', text: t('mediaOpenOk') })
        }).catch((error) => {
          setGrabNotice({
            kind: 'failed',
            text: format(t('mediaOpenFailed'), { message: String(error?.message ?? error) }),
          })
          console.error('dsh-gallery: reveal 请求失败', error)
        })
      }, [item.relPath, t])

      const openExternal = React.useCallback(() => runReveal('play'), [runReveal])
      const openFolder = React.useCallback(() => runReveal('select'), [runReveal])

      /**
       * 截取当前帧存成 PNG。
       * 只用 blob URL 时 canvas 才不会被 taint（同源），所以这里依赖 blob 方案。
       * 文件名：原视频名 + 时间码，避免覆盖。
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

          // 时间码：00-12-34
          const sec = Math.floor(v.currentTime || 0)
          const hh = String(Math.floor(sec / 3600)).padStart(2, '0')
          const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
          const ss = String(sec % 60).padStart(2, '0')
          const base = (item.name ?? 'frame').replace(/\.[^.]+$/, '')
          const fname = `${base}_${hh}-${mm}-${ss}.png`

          canvas.toBlob((blob) => {
            if (blob === null) {
              setGrabNotice({ kind: 'failed', text: format(t('mediaGrabFrameFailed'), { message: 'toBlob returned null' }) })
              return
            }
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = fname
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            // 下载触发后再释放，留 1 秒避免竞态
            setTimeout(() => URL.revokeObjectURL(url), 1000)
            setGrabNotice({ kind: 'ok', text: format(t('mediaGrabFrameOk'), { name: fname }) })
          }, 'image/png')
        } catch (error) {
          setGrabNotice({ kind: 'failed', text: format(t('mediaGrabFrameFailed'), { message: String(error?.message ?? error) }) })
        }
      }, [item.name, t])

      // 提示 2.5 秒后自动消失
      React.useEffect(() => {
        if (grabNotice === null) return undefined
        const timer = setTimeout(() => setGrabNotice(null), 2500)
        return () => clearTimeout(timer)
      }, [grabNotice])

      const ready = blobState.status === 'ready'

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
          // 视频：截取当前帧（只在 blob 就绪、视频模式显示）
          isVideo && ready
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
          failed
            ? h('div', { className: 'dg-placeholder dg-error' }, t('mediaNoPreview'))
            : blobState.status === 'too-big'
              ? h('div', { className: 'dg-mediaTooBig', key: 'big' }, [
                  h('div', { className: 'dg-mediaTooBigIco', key: 'ico' }, isVideo ? '🎬' : '🎵'),
                  h('div', { className: 'dg-mediaTooBigTitle', key: 't1' }, t('mediaTooBigTitle')),
                  h('div', { className: 'dg-mediaTooBigHint', key: 't2' }, format(t('mediaTooBigHint'), { size: formatBytes(item.size) })),
                  // 两个动作分开：一个播放、一个定位文件夹。样式独立定义，不用 dg-btn（弹层里没那套样式）
                  h('div', { className: 'dg-mediaActionRow', key: 'actions' }, [
                    h('button', {
                      type: 'button',
                      className: 'dg-mediaActBtn dg-mediaActPrimary',
                      key: 'ext',
                      'data-gallery-open-external': item.relPath,
                      title: t('mediaOpenExternal'),
                      onClick: (event) => { event.stopPropagation(); openExternal() },
                    }, ['▶ ', t('mediaOpenExternal')]),
                    h('button', {
                      type: 'button',
                      className: 'dg-mediaActBtn',
                      key: 'folder',
                      'data-gallery-open-folder': item.relPath,
                      title: t('mediaOpenFolderHint'),
                      onClick: (event) => { event.stopPropagation(); openFolder() },
                    }, ['📂 ', t('mediaOpenFolder')]),
                  ]),
                ])
              : blobState.status === 'loading'
                ? h('div', { className: 'dg-mediaLoading', key: 'load' }, [
                    h('div', { className: 'dg-mediaLoadingText', key: 't' },
                      blobState.pct >= 0
                        ? format(t('mediaBlobLoading'), { pct: blobState.pct })
                        : t('mediaBlobLoadingIndeterminate')),
                    h('div', { className: 'dg-mediaProgressBar', key: 'bar' },
                      h('div', {
                        className: 'dg-mediaProgressFill',
                        key: 'fill',
                        style: { width: `${blobState.pct >= 0 ? blobState.pct : 30}%` },
                      })),
                  ])
                : blobState.status === 'failed'
                  ? h('div', { className: 'dg-mediaTooBig', key: 'fail' }, [
                      h('div', { className: 'dg-mediaTooBigIco', key: 'ico' }, '⚠'),
                      h('div', { className: 'dg-mediaTooBigTitle', key: 't1' }, t('mediaLoadFailed')),
                      h('div', { className: 'dg-mediaTooBigHint', key: 't2' }, blobState.message ?? ''),
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
                        src: blobState.url,
                        controls: true,
                        autoPlay: true,
                        preload: 'auto',
                        key: 'v',
                        'data-gallery-video': item.relPath,
                        onError: () => setFailed(true),
                        onLoadedMetadata: (event) => {
                          const v = event.currentTarget
                          if (v.videoWidth > 0) setDims({ w: v.videoWidth, h: v.videoHeight })
                        },
                      })
                    : h('audio', {
                        src: blobState.url,
                        controls: true,
                        autoPlay: true,
                        preload: 'auto',
                        key: 'a',
                        'data-gallery-audio': item.relPath,
                        onError: () => setFailed(true),
                      })
        )),
        // 底栏：文件名 + 大小 + 时间（+ 视频尺寸）
        h('div', { className: 'dg-mediaFoot', key: 'foot' }, [
          h('span', { className: 'dg-mediaFootName', key: 'name', title: item.relPath }, item.name),
          h('span', { className: 'dg-mediaFootMeta', key: 'meta' },
            `${formatBytes(item.size)} · ${formatTime(item.mtime)}`
            + (dims !== null ? ` · ${dims.w} × ${dims.h}` : '')
            + (ready ? ' · 可拖动进度条' : '')),
        ]),
        // 截帧结果提示（成功绿、失败红），2.5 秒自动消失
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
    function mediaUrlOf(relPath, mtime) {
      const stamp = typeof mtime === 'number' ? mtime : 0
      return MEDIA_ROUTE + '?path=' + encodeURIComponent(relPath) + '&v=' + stamp
    }

    function FileCard({ item, t, absPath, onOpenFolder, onPreview, onContextMenu }) {
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
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (typeof onContextMenu === 'function') onContextMenu(item, absPath, event)
        },
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
    function Card({ item, t, onOpen, limiter, onContextMenu }) {
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
        className: `dg-card dg-cat-${item.category || 'none'}`,
        title: `${item.relPath}${item.category ? `\n[${t('cat' + item.category[0].toUpperCase() + item.category.slice(1))}]` : ''}`,
        'data-gallery-card': item.relPath,
        'data-gallery-category': item.category || '',
        onClick: (event) => onOpen(item, event.currentTarget),
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (typeof onContextMenu === 'function') onContextMenu(item, null, event)
        },
      }, [
        // 分类角标
        item.category
          ? h('span', {
              className: `dg-catBadge dg-catBadge-${item.category}`,
              key: 'badge',
              'data-gallery-badge': item.category,
            }, t('cat' + item.category[0].toUpperCase() + item.category.slice(1)))
          : null,
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
     *
     * 原图对比：预览图压到 VIEW_SIZE（1600px），看细节会糊。
     * 因此提供「原图模式」按需加载（不预加载，避免几千张图拖垮内存/带宽）：
     *   - 右键预览区、按 O、点底部按钮 三种方式切换
     *   - 切换时**保留当前缩放与位置**，否则切过去跳回 1x 就没法对比
     */
    function Viewer({ items, index, onClose, onStep, t, initialOriginal }) {
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
      // 上一次拖动是否真的产生了位移（用于区分「拖图」和「单击关闭」）
      const lastDragMoved = React.useRef(false)

      // ---- 原图模式 ----
      // originalMode: 用户当前是否处在「看原图」状态
      // original: { status: 'idle'|'loading'|'ready'|'failed', url, pct, w, h, message }
      // originalRequestedRef: 一旦开始加载就不再重复发起（切回预览再切回来直接复用）
      const [originalMode, setOriginalMode] = React.useState(initialOriginal === true)
      const [original, setOriginal] = React.useState({ status: 'idle' })
      const originalRequestedRef = React.useRef(false)
      const originalAbortRef = React.useRef(null)
      // 记录当前原图 URL，卸载时释放（object URL 不主动释放会一直占内存）
      const originalRef = React.useRef(null)

      /** 加载原图（幂等：同一张图只拉一次；失败可重试）。 */
      const ensureOriginal = React.useCallback(() => {
        if (originalRequestedRef.current) return
        originalRequestedRef.current = true
        const controller = new AbortController()
        originalAbortRef.current = controller
        setOriginal({ status: 'loading', pct: -1 })
        fetchRaw(item.relPath, controller.signal, (loaded, total) => {
          if (controller.signal.aborted) return
          const pct = total > 0 ? Math.round((loaded / total) * 100) : -1
          setOriginal((cur) => (cur.status === 'loading' ? { status: 'loading', pct } : cur))
        })
          .then(async (blob) => {
            if (controller.signal.aborted) return
            const url = URL.createObjectURL(blob)
            if (controller.signal.aborted) { URL.revokeObjectURL(url); return }
            // 先量尺寸再挂 state：图片解码后可立即按原始像素显示
            const dims = await readImageSize(url, item)
            if (controller.signal.aborted) { URL.revokeObjectURL(url); return }
            setOriginal((cur) => {
              // 替换旧的原图 URL，避免泄漏
              if (cur.status === 'ready' && cur.url) URL.revokeObjectURL(cur.url)
              originalRef.current = url
              return { status: 'ready', url, w: dims.w, h: dims.h }
            })
          })
          .catch((error) => {
            if (controller.signal.aborted) return
            setOriginal({ status: 'failed', message: String(error?.message ?? error) })
            // 失败后允许重试
            originalRequestedRef.current = false
          })
      }, [item.relPath, item.extension])

      // 卸载时释放原图 object URL，避免内存泄漏
      React.useEffect(() => () => {
        const url = originalRef.current
        if (url) URL.revokeObjectURL(url)
      }, [])

      /** 切换原图/预览。切换时保留 zoom 与 pan，才能对比同一点细节。 */
      const toggleOriginal = React.useCallback(() => {
        setOriginalMode((was) => {
          const next = !was
          if (next) ensureOriginal()
          return next
        })
      }, [ensureOriginal])

      // 换图时重置原图状态（不同图片的原图互不复用）。
      // ⚠️ 必须跳过「首次挂载」：本 effect 依赖 item.relPath，挂载时也会跑一次，
      // 若在这里无条件 setOriginalMode(false)，会把 initialOriginal 设的初始状态清掉，
      // 导致「右键查看原图」打开后显示的仍是预览图（已踩过）。
      // 所以只在本组件已经渲染过某张图、且 relPath 变化时才重置。
      const lastRelPathRef = React.useRef(item.relPath)
      React.useEffect(() => {
        if (lastRelPathRef.current === item.relPath) return
        lastRelPathRef.current = item.relPath
        originalRequestedRef.current = false
        setOriginalMode(false)
        setOriginal({ status: 'idle' })
        return () => {
          if (originalAbortRef.current !== null) originalAbortRef.current.abort()
        }
      }, [item.relPath])

      // 首次挂载时如果要求直接看原图，立刻开始加载。
      // 放在「换图重置」之后，顺序上不会再被清掉。
      React.useEffect(() => {
        if (initialOriginal === true) ensureOriginal()
        // 仅打开时报一次；之后用户手动切换由 toggleOriginal 负责
      }, [])

      // 防御：若查看器已在显示时又收到「以原图打开」的请求（比如再次右键同一张），
      // 组件不会重建，initialOriginal 的初值就失效了。这里补一次响应。
      const initialOriginalAppliedRef = React.useRef(initialOriginal === true)
      React.useEffect(() => {
        if (initialOriginal !== true) {
          initialOriginalAppliedRef.current = false
          return
        }
        if (initialOriginalAppliedRef.current) return
        initialOriginalAppliedRef.current = true
        ensureOriginal()
        setOriginalMode(true)
      }, [initialOriginal, ensureOriginal])

      React.useEffect(() => {
        let alive = true
        const controller = new AbortController()
        setState({ status: 'pending' })
        // 既不是文本、也不是图片的二进制文件（pdf/docx/zip 等）不做内联解码
        const isImage = isImageItem(item)
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

      // 滚轮缩放：以鼠标位置为中心，避免放大后目标跑出视野（仅图片模式）。
      // 文本预览用原生滚动，不拦截滚轮。
      React.useEffect(() => {
        const node = bodyRef.current
        if (node === null || state.status !== 'ready' || isText) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const delta = event.deltaY < 0 ? 1 : -1
          const rect = node.getBoundingClientRect()
          // 光标相对预览框中心的偏移
          const cx = event.clientX - (rect.left + rect.width / 2)
          const cy = event.clientY - (rect.top + rect.height / 2)

          setZoom((current) => {
            const next = Math.min(MAX_ZOOM, Math.max(1, current + delta * ZOOM_STEP))
            if (next === 1) { setPan({ x: 0, y: 0 }); return 1 }
            // 以光标为不动点缩放：光标下的像素点在缩放前后保持同一屏幕位置
            const ratio = next / current
            setPan((p) => ({
              x: cx - (cx - p.x) * ratio,
              y: cy - (cy - p.y) * ratio,
            }))
            return next
          })
        }
        node.addEventListener('wheel', onWheel, { passive: false })
        return () => node.removeEventListener('wheel', onWheel)
      }, [state.status, isText])

      /**
       * 拖拽平移：放大后生效。支持**左键拖动**与**中键拖动**。
       * 区分「拖动」与「单击退出」：位移超过阈值才算拖动，否则视为点击关闭。
       */
      const onPointerDown = (event) => {
        if (zoom <= 1) return
        // 左键(0) 与中键(1) 都可拖；中键默认会触发浏览器自动滚动，需拦截
        if (event.button !== 0 && event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          ox: pan.x,
          oy: pan.y,
          moved: false,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
        setDragging(true)
      }
      const onPointerMove = (event) => {
        const d = dragRef.current
        if (d === null) return
        event.preventDefault()
        const dx = event.clientX - d.x
        const dy = event.clientY - d.y
        // 3px 阈值，避免手抖导致「点了却变成微拖」
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
        setPan({ x: d.ox + dx, y: d.oy + dy })
      }
      const endDrag = (event) => {
        const d = dragRef.current
        if (d === null) return
        dragRef.current = null
        // 把「这次是否真的拖动了」记下来，供紧随其后的 click 判断
        lastDragMoved.current = d.moved === true
        setDragging(false)
        if (event !== undefined) {
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
        }
      }
      // 中键按下时阻止浏览器默认的自动滚动
      const onMouseDown = (event) => {
        if (event.button === 1) event.preventDefault()
      }
      /**
       * 点击退出：只在「本次按下没有拖动过」时触发。
       * 放大状态下左键是用来拖图的，松手后若真的移动过就不算点击。
       */
      const onClickBody = (event) => {
        event.preventDefault()
        if (lastDragMoved.current === true) {
          lastDragMoved.current = false
          return
        }
        onClose()
      }

      // 键盘快捷键在 panStep/zoomBy 定义之后再绑定（见下方 effect）

      const dims = item.width !== null && item.height !== null
        ? format(t('dims'), { w: item.width, h: item.height })
        : t('dimsUnknown')

      // ---- 右侧垂直拖动条（zoom > 1 时出现）----
      // 滑块高度 = 视口高 / 缩放倍率；拖动滑块即沿 y 轴平移图片。
      const clampPanY = React.useCallback((y) => {
        const node = bodyRef.current
        if (node === null || zoom <= 1) return 0
        const overflow = Math.max(0, (node.clientHeight * (zoom - 1)) / 2)
        return Math.max(-overflow, Math.min(overflow, y))
      }, [zoom])

      // ---- 缩放与平移的「无鼠标」友好操作 ----
      // 远程控制（如 ToDesk）常常没有实体鼠标，滚轮与精细拖动都难用。
      // 所以提供：点击轨道跳转、上下按钮、键盘方向键、缩放按钮。
      const PAN_STEP = 0.25   // 每次按钮/键盘移动「可视范围」的 25%

      /** 当前竖向可平移范围（居中坐标系，±overflow）。 */
      const vOverflow = React.useCallback(() => {
        const node = bodyRef.current
        if (node === null || zoom <= 1) return 0
        return Math.max(0, (node.clientHeight * (zoom - 1)) / 2)
      }, [zoom])

      /** 按比例平移：ratio 为 +1 → 移到顶部，-1 → 移到底部。 */
      const panTo = React.useCallback((ratio) => {
        const overflow = vOverflow()
        if (overflow <= 0) return
        const r = Math.max(-1, Math.min(1, ratio))
        setPan((p) => ({ x: p.x, y: -r * overflow }))
      }, [vOverflow])

      /** 步进一步：direction = -1 向上、+1 向下。 */
      const panStep = React.useCallback((direction) => {
        const overflow = vOverflow()
        if (overflow <= 0) return
        const step = overflow * PAN_STEP * (direction > 0 ? -1 : 1)
        setPan((p) => ({ x: p.x, y: Math.max(-overflow, Math.min(overflow, p.y + step)) }))
      }, [vOverflow])

      const zoomBy = React.useCallback((direction) => {
        setZoom((current) => {
          const next = Math.min(MAX_ZOOM, Math.max(1, current + direction * ZOOM_STEP))
          if (next === 1) setPan({ x: 0, y: 0 })
          return next
        })
      }, [])

      /**
       * 点击轨道空白处：直接跳到该位置（省去精细拖动）。
       * 远程控制下这比拖滑块好用得多。
       */
      const onTrackClick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        const ratio = (event.clientY - rect.top) / Math.max(1, rect.height)
        // ratio 0 = 轨道顶部 → 图片顶部
        panTo(1 - ratio * 2)
      }

      // 键盘：方向键左右切图、上下平移、+/- 缩放、Esc 退出。
      // 远程控制下键盘比鼠标精确，是主要操作方式。
      React.useEffect(() => {
        const onKey = (event) => {
          const key = event.key
          if (key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (key === 'ArrowLeft') {
            event.preventDefault()
            onStep(-1)
          } else if (key === 'ArrowRight') {
            event.preventDefault()
            onStep(1)
          } else if (key === 'ArrowUp') {
            event.preventDefault()
            panStep(-1)
          } else if (key === 'ArrowDown') {
            event.preventDefault()
            panStep(1)
          } else if (key === '+' || key === '=') {
            event.preventDefault()
            zoomBy(1)
          } else if (key === '-' || key === '_') {
            event.preventDefault()
            zoomBy(-1)
          } else if (key === '0') {
            event.preventDefault()
            setZoom(1)
            setPan({ x: 0, y: 0 })
          } else if (key === 'o' || key === 'O') {
            // 原图/预览切换：保留当前 zoom 与 pan，方便对比同一点细节
            event.preventDefault()
            toggleOriginal()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose, onStep, panStep, zoomBy, toggleOriginal])

      const sliderDragRef = React.useRef(null)
      const onSliderPointerDown = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const node = bodyRef.current
        if (node === null) return
        const trackH = node.clientHeight
        const overflow = Math.max(0, (trackH * (zoom - 1)) / 2)
        if (overflow <= 0) return
        sliderDragRef.current = { startY: event.clientY, startPanY: pan.y, overflow, trackH }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
      }
      const onSliderPointerMove = (event) => {
        const d = sliderDragRef.current
        if (d === null) return
        event.preventDefault()
        const sliderH = Math.max(24, d.trackH / zoom)
        const travel = Math.max(1, d.trackH - sliderH)
        const deltaPx = event.clientY - d.startY
        // 滑块移动整条 travel 对应图片从 +overflow 移到 -overflow
        const nextY = d.startPanY - (deltaPx * (2 * d.overflow)) / travel
        setPan((p) => ({ x: p.x, y: clampPanY(nextY) }))
      }
      const endSliderDrag = (event) => {
        if (sliderDragRef.current === null) return
        sliderDragRef.current = null
        if (event !== undefined) {
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
        }
      }

      // 右侧竖列：↑ 按钮 + 轨道 + ↓ 按钮。远程控制下没有滚轮也能上下移动。
      const slider = (() => {
        if (isText || zoom <= 1 || state.status !== 'ready') return null
        const node = bodyRef.current
        const trackH = node === null ? 0 : node.clientHeight
        if (trackH <= 0) return null
        const overflow = Math.max(0, (trackH * (zoom - 1)) / 2)
        const sliderH = Math.max(24, trackH / zoom)
        const travel = Math.max(1, trackH - sliderH)
        const ratio = overflow <= 0 ? 0.5 : (pan.y + overflow) / (2 * overflow)
        const top = Math.max(0, Math.min(travel, travel * (1 - ratio)))
        const atTop = overflow > 0 && pan.y >= overflow - 1
        const atBottom = overflow > 0 && pan.y <= -overflow + 1

        return h('div', { className: 'dg-panRail', key: 'panRail', 'data-gallery-panrail': true }, [
          h('button', {
            type: 'button',
            className: 'dg-panBtn',
            key: 'up',
            'data-gallery-pan': 'up',
            title: t('panUpHint'),
            'aria-label': t('panUpHint'),
            disabled: atTop,
            onClick: (event) => { event.stopPropagation(); panStep(-1) },
          }, '▲'),
          h('div', {
            className: 'dg-dragTrack',
            key: 'dragTrack',
            'data-gallery-dragtrack': true,
            title: t('trackHint'),
            onPointerDown: (event) => event.stopPropagation(),
            onClick: onTrackClick,
          }, h('div', {
            className: `dg-dragThumb${dragging ? ' dg-dragThumbActive' : ''}`,
            key: 'thumb',
            'data-gallery-dragthumb': true,
            role: 'slider',
            'aria-orientation': 'vertical',
            'aria-label': t('dragHint'),
            style: { height: `${Math.round(sliderH)}px`, transform: `translateY(${Math.round(top)}px)` },
            title: t('dragHint'),
            onPointerDown: onSliderPointerDown,
            onPointerMove: onSliderPointerMove,
            onPointerUp: endSliderDrag,
            onPointerCancel: endSliderDrag,
          })),
          h('button', {
            type: 'button',
            className: 'dg-panBtn',
            key: 'down',
            'data-gallery-pan': 'down',
            title: t('panDownHint'),
            'aria-label': t('panDownHint'),
            disabled: atBottom,
            onClick: (event) => { event.stopPropagation(); panStep(1) },
          }, '▼'),
        ])
      })()

      return h('div', {
        className: 'dg-viewer',
        role: 'dialog',
        'aria-modal': false,
        'aria-label': t('zoomed'),
        'data-gallery-viewer': item.relPath,
      }, [
        h('div', { className: 'dg-viewerBar', key: 'bar' }, [
          h('span', { className: 'dg-viewerTitle', key: 'title' }, item.name),
          zoom > 1
            ? h('span', { className: 'dg-zoomBadge', key: 'zoom', 'data-gallery-zoom-badge': zoom }, `${zoom.toFixed(1)}×`)
            : null,
          // 缩放按钮：远程控制下没有滚轮也能操作
          !isText && h('div', { className: 'dg-zoomCtl', key: 'zoomCtl' }, [
            h('button', {
              type: 'button', className: 'dg-btn dg-btnTiny', key: 'out',
              'data-gallery-zoom-out': true,
              disabled: zoom <= 1,
              title: t('zoomOutHint'), 'aria-label': t('zoomOutHint'),
              onClick: (event) => { event.stopPropagation(); zoomBy(-1) },
            }, '－'),
            h('button', {
              type: 'button', className: 'dg-btn dg-btnTiny', key: 'in',
              'data-gallery-zoom-in': true,
              disabled: zoom >= MAX_ZOOM,
              title: t('zoomInHint'), 'aria-label': t('zoomInHint'),
              onClick: (event) => { event.stopPropagation(); zoomBy(1) },
            }, '＋'),
            h('button', {
              type: 'button', className: 'dg-btn dg-btnTiny', key: 'fit',
              'data-gallery-zoom-reset': true,
              disabled: zoom <= 1,
              title: t('zoomResetHint'), 'aria-label': t('zoomResetHint'),
              onClick: (event) => { event.stopPropagation(); setZoom(1); setPan({ x: 0, y: 0 }) },
            }, '1:1'),
          ]),
          // 原图 / 预览 切换按钮：远程控制（无鼠标）时的唯一入口，必须有
          !isText && h('button', {
            type: 'button',
            key: 'orig',
            className: `dg-btn dg-btnOrig${originalMode ? ' dg-btnOrigActive' : ''}`,
            'data-gallery-original-toggle': originalMode ? 'on' : 'off',
            'data-gallery-original-state': original.status,
            title: `${t('viewerSwapHint')}  ·  ${t('ctxOpenOriginalHint')}`,
            'aria-label': originalMode ? t('viewerToPreview') : t('viewerToOriginal'),
            'aria-pressed': originalMode,
            disabled: original.status === 'loading',
            onClick: (event) => { event.stopPropagation(); toggleOriginal() },
          }, original.status === 'loading'
            ? h('span', { key: 'load' }, original.pct >= 0
                ? format(t('viewerOriginalLoading'), { pct: original.pct })
                : t('viewerOriginalLoadingIndeterminate'))
            : (originalMode ? `◉ ${t('viewerToPreview')}` : `◎ ${t('viewerToOriginal')}`)),
          h('button', { type: 'button', className: 'dg-btn', key: 'prev', onClick: () => onStep(-1), 'aria-label': t('prev') }, '‹'),
          h('button', { type: 'button', className: 'dg-btn', key: 'next', onClick: () => onStep(1), 'aria-label': t('next') }, '›'),
          h('button', { type: 'button', className: 'dg-btn', key: 'close', onClick: onClose, 'aria-label': t('close') }, '✕'),
        ]),
        h('div', { className: 'dg-viewerStage', key: 'stage' }, [
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
            // 右键 = 切换原图/预览（需求 2）。不弹浏览器菜单，避免打断对比
            onContextMenu: isText ? undefined : (event) => {
              event.preventDefault()
              event.stopPropagation()
              toggleOriginal()
            },
          },
            state.status === 'ready'
              ? (isText
                  ? h('pre', { className: 'dg-textPre', key: 'text' }, state.text)
                  : h('img', {
                      // 原图模式下显示原图 URL（按需加载好后才有）；
                      // 未就绪时继续显示预览图，避免黑屏跳变
                      src: originalMode && original.status === 'ready' ? original.url : state.url,
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
          slider,
        ]),
        // 原图加载状态条：失败要能看见并知道原因，否则用户以为图坏了
        original.status === 'failed'
          ? h('div', { className: 'dg-viewerWarn', key: 'origFail', 'data-gallery-original-warn': 'failed' },
              `⚠ ${t('viewerOriginalFailed')}：${original.message ?? ''}`)
          : null,
        h('div', { className: 'dg-viewerFoot', key: 'foot' }, [
          h('span', { key: 'meta' }, [
            originalMode && original.status === 'ready' && original.w > 0
              ? format(t('viewerOriginalReady'), { w: original.w, h: original.h })
              : dims,
            ` · ${formatBytes(item.size)} · ${formatTime(item.mtime)}`,
            zoom > 1 && !isText ? ` · ${t('dragHint')}` : '',
            isText ? '' : ` · ${t('viewerSwapHint')}`,
          ].join('')),
        ]),
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
      // 全部恢复
      const [clearing, setClearing] = React.useState(false)
      const [hiddenCleared, setHiddenCleared] = React.useState(false)
      // 多目录增删
      const [adding, setAdding] = React.useState(false)
      const [removing, setRemoving] = React.useState(null)

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

      /** 追加一个扫描目录。 */
      const addRoot = React.useCallback(async (nextRoot) => {
        if (typeof nextRoot !== 'string' || nextRoot.trim() === '') return
        setAdding(true)
        setError(null)
        try {
          const payload = await callHost('addRoot', { root: nextRoot.trim() })
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
          setInfo(payload.settings)
          setDraft('')
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
          if (typeof onSaved === 'function') onSaved()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setAdding(false)
        }
      }, [t, onSaved])

      /** 移除一个扫描目录（至少保留一个）。 */
      const removeRoot = React.useCallback(async (target) => {
        if (typeof target !== 'string' || target === '') return
        setRemoving(target)
        setError(null)
        try {
          const payload = await callHost('removeRoot', { root: target })
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
          setInfo(payload.settings)
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
          if (typeof onSaved === 'function') onSaved()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setRemoving(null)
        }
      }, [t, onSaved])

      const sourceLabel = React.useMemo(() => {
        if (info === null) return ''
        if (info.rootSource === 'settings') return t('rootSourceSettings')
        if (info.rootSource === 'config') return t('rootSourceConfig')
        return t('rootSourceAuto')
      }, [info, t])

      /** 全部恢复：清空隐藏列表，让被隐藏的条目重新出现在列表里。 */
      const clearHidden = React.useCallback(async () => {
        if (info === null || info.hiddenCount === 0) return
        setClearing(true)
        setError(null)
        setHiddenCleared(false)
        try {
          const payload = await callHost('clearHidden', {})
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
          // 重新拉一次设置，拿到最新的 hiddenCount
          const fresh = await callHost('settings')
          if (fresh?.ok !== false) setInfo(fresh.settings)
          setHiddenCleared(true)
          setTimeout(() => setHiddenCleared(false), 2000)
          if (typeof onSaved === 'function') onSaved()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setClearing(false)
        }
      }, [info, t, onSaved])

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
                // ---- 扫描目录列表（多目录）----
                h('div', { className: 'dg-field', key: 'roots' }, [
                  h('div', { className: 'dg-fieldHead', key: 'head' }, [
                    h('span', { className: 'dg-fieldLabel', key: 'l' },
                      format(t('rootsLabel'), { count: info === null ? 0 : (info.roots?.length ?? 0) })),
                    info === null ? null : h('span', { className: 'dg-fieldHint', key: 'h' },
                      format(t('rootHint'), { source: sourceLabel })),
                  ]),
                  h('ul', { className: 'dg-rootsList', key: 'list', 'data-gallery-roots': info === null ? 0 : info.roots.length },
                    (info?.rootsInfo ?? []).map((r, i) => h('li', {
                      className: `dg-rootItem${r.exists ? '' : ' dg-rootItemMissing'}`,
                      key: r.path,
                      'data-gallery-root-item': r.path,
                      title: r.path,
                    }, [
                      h('span', { className: 'dg-rootOk', key: 'ok' }, r.exists ? '✓' : '✗'),
                      h('span', { className: 'dg-rootPath', key: 'p' }, r.path),
                      (info.roots?.length ?? 0) > 1
                        ? h('button', {
                            type: 'button',
                            className: 'dg-rootRemove',
                            key: 'rm',
                            disabled: saving || removing === r.path,
                            title: t('removeRootHint'),
                            'aria-label': t('removeRootHint'),
                            'data-gallery-root-remove': r.path,
                            onClick: () => { void removeRoot(r.path) },
                          }, '✕')
                        : null,
                    ])),
                  ),
                  // 添加新目录
                  h('div', { className: 'dg-rootAdd', key: 'add' }, [
                    h('input', {
                      type: 'text',
                      className: 'dg-input dg-rootInput',
                      key: 'i',
                      value: draft,
                      spellCheck: false,
                      placeholder: t('rootAddPlaceholder'),
                      'data-gallery-root-input': true,
                      onChange: (event) => setDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && saving === false) { event.preventDefault(); void addRoot(draft) }
                      },
                    }),
                    h('button', {
                      type: 'button',
                      className: 'dg-btn dg-primaryBtn',
                      key: 'btn',
                      disabled: saving || draft.trim() === '',
                      'data-gallery-root-add': true,
                      onClick: () => { void addRoot(draft) },
                    }, adding ? t('addingRoot') : t('addRoot')),
                  ]),
                  h('span', { className: 'dg-fieldHint', key: 'tip' }, t('rootsTip')),
                ]),

                info === null ? null : h('div', { className: 'dg-settingsMeta', key: 'meta' }, [
                  h('span', { key: 'status' },
                    info.rootExists ? t('rootExists') : t('rootMissingShort')),
                  h('span', { key: 'file' },
                    format(t('settingsFileAt'), { path: info.settingsFile })),
                ]),

                // ---- 已隐藏条目管理 ----
                info === null ? null : h('div', { className: 'dg-hiddenBox', key: 'hiddenBox', 'data-gallery-hidden-box': info.hiddenCount }, [
                  h('div', { className: 'dg-hiddenRow', key: 'row' }, [
                    h('span', { className: 'dg-hiddenLabel', key: 'label' },
                      format(t('hiddenCount'), { count: info.hiddenCount })),
                    h('button', {
                      type: 'button',
                      className: 'dg-btn',
                      key: 'clear',
                      'data-gallery-clear-hidden': true,
                      disabled: clearing || info.hiddenCount === 0,
                      title: t('hiddenClearHint'),
                      onClick: () => { void clearHidden() },
                    }, clearing ? t('hiddenClearing') : t('hiddenClear')),
                  ]),
                  info.hiddenCount > 0 && Array.isArray(info.hiddenSample) && info.hiddenSample.length > 0
                    ? h('ul', { className: 'dg-hiddenList', key: 'list' },
                        info.hiddenSample.map((p) => h('li', { className: 'dg-hiddenItem', key: p, title: p }, p)))
                    : null,
                  info.hiddenCount > info.hiddenSample?.length
                    ? h('div', { className: 'dg-hiddenMore', key: 'more' },
                        format(t('hiddenMore'), { count: info.hiddenCount - info.hiddenSample.length }))
                    : null,
                  hiddenCleared
                    ? h('p', { className: 'dg-status dg-ok', key: 'cleared' }, t('hiddenCleared'))
                    : null,
                ]),

                error === null ? null : h('p', { className: 'dg-status dg-error', key: 'err' }, error),
                saved ? h('p', { className: 'dg-status dg-ok', key: 'ok' }, t('savedImmediately')) : null,

                h('div', { className: 'dg-settingsActions', key: 'actions' }, [
                  h('button', {
                    type: 'button', className: 'dg-btn', key: 'reset',
                    disabled: saving || info === null,
                    title: t('resetDefaultHint'),
                    onClick: () => { if (info !== null) { setDraft(info.defaults.root); void save(info.defaults.root) } },
                  }, t('resetDefault')),
                  h('button', {
                    type: 'button', className: 'dg-btn dg-primaryBtn', key: 'close2',
                    onClick: onClose,
                  }, t('done')),
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
      // 音视频播放器（v0.10.1）：独立于图片查看器，因为交互与 DOM 完全不同
      const [mediaPlaying, setMediaPlaying] = React.useState(null)
      // 让回调（如右键菜单）读到最新值而不必重建依赖
      const viewerRef = React.useRef(null)
      React.useEffect(() => { viewerRef.current = viewer }, [viewer])
      const limiter = React.useRef(null)
      if (limiter.current === null) limiter.current = createLimiter(MAX_CONCURRENT)

      const load = React.useCallback(async (signal, kind = 'image', scope = 'global', page = 1) => {
        const payload = await callHost('list', { kind, scope, sessionId, page }, signal)
        if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
        return payload
      }, [t, sessionId])

      const [kind, setKind] = React.useState('image')
      // 分类：全局资产（整个 G 盘产出）/ 当前对话（仅本对话产出过的）
      // 从「当前对话」切回「全局」时保留上次选择，但不持久化，避免误导。
      const [scope, setScope] = React.useState('global')
      // 当前页码（从 1 开始）。切换 kind / scope 时回到第 1 页。
      const [page, setPage] = React.useState(1)
      // 设置面板开关（改产出根目录）
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      // 全局分组：哪些组是展开的（键是 sessionId 或 '__history__'）
      const [openGroups, setOpenGroups] = React.useState(new Set())
      // 分组默认展开只做一次：当前对话组优先，没有则展开第一个。
      // 用 ref 记住「已初始化」，否则用户手动收起后每次渲染又被强制展开。
      const groupsInitRef = React.useRef(false)
      // 全局分组：哪些组显示了中间产物
      const [showInterim, setShowInterim] = React.useState({})
      const toggleGroup = React.useCallback((key) => {
        setOpenGroups((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }, [])
      const toggleInterim = React.useCallback((key) => {
        setShowInterim((prev) => ({ ...prev, [key]: !prev[key] }))
      }, [])
      // 右键菜单：{ item, absPath, x, y }
      const [ctxMenu, setCtxMenu] = React.useState(null)
      // 删除确认：{ item, busy }
      const [deleteTarget, setDeleteTarget] = React.useState(null)
      // 网格滚动位置：打开查看器前记录，关闭后恢复，让视图停在原缩略图处
      const bodyScrollRef = React.useRef(null)
      const savedScrollRef = React.useRef(null)

      /** 打开右键菜单。 */
      const openContextMenu = React.useCallback((item, absPath, event) => {
        setCtxMenu({
          item,
          absPath: absPath ?? buildAbsPath(view.status === 'ready' ? view.data.root : '', item.relPath),
          x: event.clientX,
          y: event.clientY,
        })
      }, [view])

      const closeContextMenu = React.useCallback(() => setCtxMenu(null), [])

      /**
       * 打开某张图：先记住当前滚动位置。
       *
       * @param index - 在 list 里的下标。
       * @param anchorEl - 被点击的卡片元素（用于退出时精确回位）。
       * @param list - 该图片所属的列表快照。**必须传**：
       *   分组视图下卡片来自 `data.groups[i].files`，与当前页的扁平 `items` 是两个不同的集合，
       *   直接用全局 `items` 的索引会「点哪张都跳出同一张图」。
       */
      const openViewer = React.useCallback((index, anchorEl, list, asOriginal) => {
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
        // 只保留查看器需要的字段，避免把整个分组对象塞进 state
        const snapshot = list.map((it) => ({
          relPath: it.relPath,
          name: it.name ?? it.relPath.split('/').pop(),
          extension: it.extension ?? ('.' + (it.relPath.split('.').pop() || '')),
          width: it.width ?? null,
          height: it.height ?? null,
        }))
        setViewer({ index, list: snapshot, asOriginal: asOriginal === true })
      }, [])

      /**
       * 从右键菜单「查看原图」打开：按 relPath 在「打开时记录的列表」里定位。
       * 分组视图与扁平视图的列表不同，所以用 viewer 当前列表优先，
       * 找不到再退回全局 items / 各分组文件，最后兜底单张列表。
       */
      const openViewerByItem = React.useCallback((target, asOriginal) => {
        const samePath = (it) => it.relPath === target.relPath
        // 1) 当前查看器列表
        const cur = viewerRef.current
        if (cur !== null && Array.isArray(cur.list)) {
          const i = cur.list.findIndex(samePath)
          if (i >= 0) { openViewer(i, null, cur.list, true); return }
        }
        // 2) 全局 items（扁平/分页视图）
        const flat = itemsRef.current ?? []
        const j = flat.findIndex(samePath)
        if (j >= 0) { openViewer(j, null, flat, true); return }
        // 3) 任一对话分组的文件列表（全局分组视图）
        const groups = groupsRef.current
        if (Array.isArray(groups)) {
          for (const g of groups) {
            if (!Array.isArray(g.files)) continue
            const k = g.files.findIndex(samePath)
            if (k >= 0) { openViewer(k, null, g.files, true); return }
          }
        }
        // 4) 兜底：单独一张（此时左右切图无意义，但不至于打不开）
        openViewer(0, null, [target], true)
      }, [openViewer])

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

      /** 隐藏当前右键的条目（只从列表移除，不动文件）。 */
      const doHide = React.useCallback(async (item) => {
        try {
          const payload = await callHost('hide', { path: item.relPath })
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
          await load(undefined, kind, scope, page).then((data) => setView({ status: 'ready', data })).catch(() => {})
        } catch (error) {
          console.error('dsh-gallery: 隐藏失败', error)
        }
      }, [load, kind, scope, page, t])

      /** 在资源管理器里定位。 */
      const doReveal = React.useCallback(async (item) => {
        try {
          const payload = await callHost('reveal', { path: item.relPath })
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
        } catch (error) {
          console.error('dsh-gallery: reveal 失败', error)
        }
      }, [t])

      /** 执行删除（需二次确认）。 */
      const doDelete = React.useCallback(async () => {
        const target = deleteTarget
        if (target === null || target.busy === true) return
        setDeleteTarget({ ...target, busy: true })
        try {
          const payload = await callHost('delete', { path: target.item.relPath, confirm: true })
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
          setDeleteTarget(null)
          await load(undefined, kind, scope, page).then((data) => setView({ status: 'ready', data })).catch(() => {})
        } catch (error) {
          console.error('dsh-gallery: 删除失败', error)
          setDeleteTarget(null)
        }
      }, [deleteTarget, load, kind, scope, page, t])

      const refresh = React.useCallback(async () => {
        setRefreshing(true)
        try {
          setView({ status: 'ready', data: await load(undefined, kind, scope, page) })
        } catch (error) {
          if (error?.name === 'AbortError') return
          setView({ status: 'failed', message: String(error?.message ?? error) })
        } finally {
          setRefreshing(false)
        }
      }, [load, kind, scope, page])

      React.useEffect(() => {
        let alive = true
        const controller = new AbortController()
        load(controller.signal, kind, scope, page)
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
      }, [load, kind, scope, page])

      // 自动刷新：定时拉取最新列表；查看器打开时暂停，避免打断放大查看
      React.useEffect(() => {
        if (viewer !== null) return undefined
        let alive = true
        const timer = setInterval(() => {
          if (!alive) return
          load(undefined, kind, scope, page)
            .then((data) => { if (alive) setView({ status: 'ready', data }) })
            .catch(() => { /* 自动刷新失败保持现有列表，避免闪错 */ })
        }, AUTO_REFRESH_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load, kind, scope, page, viewer])

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
      // 右键菜单的回调要在不重建依赖的前提下读到最新的列表，所以同步到 ref
      const itemsRef = React.useRef(items)
      itemsRef.current = items
      const groupsRef = React.useRef(null)
      groupsRef.current = Array.isArray(data?.groups) ? data.groups : null

      // 分组首次渲染时，默认展开「当前对话」那一组（没有则展开第一组）。
      // 只做一次：之后用户手动收起/展开都保留。
      React.useEffect(() => {
        if (groupsInitRef.current) return
        if (data === null || !Array.isArray(data.groups) || data.groups.length === 0) return
        groupsInitRef.current = true
        const target = data.groups.find((g) => g.isCurrent === true) ?? data.groups[0]
        if (target === undefined) return
        setOpenGroups(new Set([target.sessionId ?? '__history__']))
      }, [data])

      const step = React.useCallback((delta) => {
        setViewer((current) => {
          if (current === null) return null
          // 用查看器自己的列表长度（不是全局 items），分组视图下两者不同
          const len = current.list.length
          if (len === 0) return current
          return { ...current, index: (current.index + delta + len) % len }
        })
      }, [])

      // 分类开关：全局资产 / 当前对话
      const scopeSwitch = h('div', { className: 'dg-scopeSwitch', key: 'scope' }, [
        h('button', {
          type: 'button',
          key: 'global',
          className: `dg-scopeBtn${scope === 'global' ? ' dg-scopeActive' : ''}`,
          'data-gallery-scope': 'global',
          title: t('scopeGlobalHint'),
          onClick: () => { if (scope !== 'global') { setScope('global'); setPage(1); setViewer(null) } },
        }, t('scopeGlobal')),
        h('button', {
          type: 'button',
          key: 'session',
          className: `dg-scopeBtn${scope === 'session' ? ' dg-scopeActive' : ''}`,
          'data-gallery-scope': 'session',
          title: t('scopeSessionHint'),
          onClick: () => { if (scope !== 'session') { setScope('session'); setPage(1); setViewer(null) } },
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
        // 图片 / 文件 / 音视频 三画廊切换（v0.10.1）
        h('div', { className: 'dg-switch', key: 'switch' }, [
          h('button', {
            type: 'button',
            key: 'img',
            className: `dg-seg${kind === 'image' ? ' dg-segActive' : ''}`,
            'data-gallery-kind': 'image',
            onClick: () => { setKind('image'); setPage(1); setViewer(null) },
          }, t('kindImage')),
          h('button', {
            type: 'button',
            key: 'file',
            className: `dg-seg${kind === 'file' ? ' dg-segActive' : ''}`,
            'data-gallery-kind': 'file',
            onClick: () => { setKind('file'); setPage(1); setViewer(null) },
          }, t('kindFile')),
          h('button', {
            type: 'button',
            key: 'media',
            className: `dg-seg${kind === 'media' ? ' dg-segActive' : ''}`,
            'data-gallery-kind': 'media',
            onClick: () => { setKind('media'); setPage(1); setViewer(null) },
          }, t('kindMedia')),
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

      // 分类图例：告诉用户三种边框颜色代表什么（只在有数据时显示）
      // 「未归类」只有在确实存在这类文件时才显示，避免图例噪音
      const hasUnknown = data !== null && Array.isArray(data.groups) &&
        data.groups.some((gr) => (gr.counts?.unknown ?? 0) > 0)
      const legend = data !== null && items.length > 0
        ? h('div', { className: 'dg-legend', key: 'legend', title: t('catLegendHint') }, [
            h('span', { className: 'dg-legendItem', key: 'f' }, [
              h('span', { className: 'dg-legendSwatch dg-legendSwatch-final', key: 's' }),
              h('span', { key: 'l' }, t('catLegendFinal')),
            ]),
            h('span', { className: 'dg-legendItem', key: 'i' }, [
              h('span', { className: 'dg-legendSwatch dg-legendSwatch-input', key: 's' }),
              h('span', { key: 'l' }, t('catLegendInput')),
            ]),
            h('span', { className: 'dg-legendItem', key: 'm' }, [
              h('span', { className: 'dg-legendSwatch dg-legendSwatch-intermediate', key: 's' }),
              h('span', { key: 'l' }, t('catLegendIntermediate')),
            ]),
            hasUnknown
              ? h('span', { className: 'dg-legendItem', key: 'u' }, [
                  h('span', { className: 'dg-legendSwatch dg-legendSwatch-unknown', key: 's' }),
                  h('span', { key: 'l' }, t('catLegendUnknown')),
                ])
              : null,
          ])
        : null

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
        let emptyText = kind === 'file' ? t('emptyFile')
          : kind === 'media' ? t('emptyMedia')
            : t('empty')
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
        // 全局模式 + 有分组数据 → 按对话分组渲染（可折叠）
        const useGroups = scope === 'global' && Array.isArray(data.groups) && data.groups.length > 0

        if (useGroups) {
          const cardFor = (item, groupKey, listForViewer) => {
            // 分组里的文件也走同一套卡片组件
            const enriched = {
              ...item,
              name: item.name ?? item.relPath.split('/').pop(),
              extension: item.extension ?? ('.' + (item.relPath.split('.').pop() || '')),
            }
            // 音视频分组视图：必须走 MediaCard，否则会被当成图片卡片渲染（v0.10.1）
            if (kind === 'media') {
              return h(MediaCard, {
                key: `${groupKey}:${item.relPath}`,
                item: {
                  ...enriched,
                  // 分组摘要里可能没有 mediaType，按扩展名兜底推断
                  mediaType: enriched.mediaType
                    ?? (VIDEO_EXTS_CLIENT.has(enriched.extension) ? 'video' : 'audio'),
                },
                t,
                absPath: buildAbsPath(data.root, item.relPath),
                onPlay: (target) => setMediaPlaying(target),
                onContextMenu: openContextMenu,
              })
            }
            if (kind === 'file') {
              return h(FileCard, {
                key: `${groupKey}:${item.relPath}`,
                item: enriched,
                t,
                absPath: buildAbsPath(data.root, item.relPath),
                onOpenFolder: () => { void callHost('reveal', { path: item.relPath }).catch((e) => console.error('dsh-gallery: reveal 失败', e)) },
                onContextMenu: openContextMenu,
                onPreview: (abs) => {
                  const address = sessionFileAddressOf(sessionId, abs)
                  try {
                    ctxRef.current.sidebarRight.openResource(address, { kind: 'text' })
                  } catch (error) {
                    console.error('dsh-gallery: 侧栏预览失败', error, address)
                    void copyText(abs)
                  }
                },
                onCopy: (abs) => { void copyText(abs) },
              })
            }
            return h(Card, {
              key: `${groupKey}:${item.relPath}`,
              item: enriched,
              t,
              limiter: limiter.current,
              onContextMenu: openContextMenu,
              onOpen: (opened, anchorEl) => {
                // 用**该组当前可见的文件**作为查看器列表：
                // 左右切图应在本组内循环，而不是跳到别的对话的图。
                const list = Array.isArray(listForViewer) ? listForViewer : group.files
                let pos = list.indexOf(opened)
                if (pos < 0) {
                  // 对象引用对不上时按 relPath 找（enriched 是浅拷贝，引用可能不同）
                  pos = list.findIndex((f) => f.relPath === opened.relPath)
                }
                if (pos < 0) return
                openViewer(pos, anchorEl ?? null, list)
              },
            })
          }

          const groupNodes = data.groups.map((group, gi) => {
            const groupKey = group.sessionId ?? '__history__'
            const isOpen = openGroups.has(groupKey)
            // 组内中间产物的显隐：
            //   - 当前对话：**默认显示**（用户刚做完的就是要看过程，可选收起）
            //   - 其他对话 / 历史资产：**默认隐藏**（避免别人调试图淹没列表）
            // 用户手动切换后，以 showInterim 里记录的为准（true=显示 / false=隐藏）。
            const interimDefault = group.isCurrent === true
            const stored = showInterim[groupKey]
            const showIntermediate = stored === undefined ? interimDefault : stored
            const visibleFiles = showIntermediate
              ? group.files
              : group.files.filter((f) => f.category !== 'intermediate')
            const hiddenCount = group.files.length - visibleFiles.length

            const chips = []
            if (group.counts.final > 0) {
              chips.push(h('span', { className: 'dg-chip dg-chip-final', key: 'f' }, format(t('groupFinal'), { n: group.counts.final })))
            }
            if (group.counts.input > 0) {
              chips.push(h('span', { className: 'dg-chip dg-chip-input', key: 'i' }, format(t('groupInput'), { n: group.counts.input })))
            }
            if (group.counts.intermediate > 0) {
              chips.push(h('span', { className: 'dg-chip dg-chip-intermediate', key: 'm' }, format(t('groupIntermediate'), { n: group.counts.intermediate })))
            }
            if ((group.counts.unknown ?? 0) > 0) {
              chips.push(h('span', { className: 'dg-chip dg-chip-unknown', key: 'u' }, format(t('groupUnknown'), { n: group.counts.unknown })))
            }

            const headKey = group.sessionId ?? '__history__'
            return h('div', {
              className: `dg-group${group.isHistory ? ' dg-groupHistory' : ''}${group.isCurrent ? ' dg-groupCurrent' : ''}`,
              key: `g:${headKey}`,
              'data-gallery-group': headKey,
              'data-gallery-group-current': group.isCurrent === true ? '1' : '0',
            }, [
              h('button', {
                type: 'button',
                className: `dg-groupHead${isOpen ? ' dg-groupHeadOpen' : ''}`,
                key: 'head',
                onClick: () => toggleGroup(headKey),
                title: group.title || t('groupHistoryTitle'),
              }, [
                h('span', { className: `dg-groupArrow${isOpen ? ' dg-groupArrowOpen' : ''}`, key: 'a' }, '▶'),
                group.isCurrent === true
                  ? h('span', { className: 'dg-groupCurrentBadge', key: 'cur', 'data-gallery-current-badge': true }, t('groupCurrentBadge'))
                  : null,
                h('span', { className: 'dg-groupTitle', key: 't' },
                  group.isHistory ? t('groupHistoryTitle') : (group.title || t('groupUnassigned'))),
                h('span', { className: 'dg-groupDate', key: 'd' },
                  group.isHistory ? format(t('groupFiles'), { n: group.fileCount }) : formatTime(group.createdAt)),
                h('span', { className: 'dg-groupChips', key: 'c' }, chips),
              ]),
              isOpen
                ? [
                    group.isHistory
                      ? h('div', { className: 'dg-groupHint', key: 'hint' }, t('groupHistoryHint'))
                      : null,
                    // 只有该组确实存在中间产物时才给切换按钮：
                    // 否则「显示中间产物」点了也没东西可显示，按钮是死的。
                    (group.counts.intermediate ?? 0) > 0
                      ? h('div', { className: 'dg-groupHint', key: 'toggle' }, [
                          h('button', {
                            type: 'button',
                            className: 'dg-btn dg-btnSmall',
                            'data-gallery-toggle-interim': headKey,
                            'data-gallery-interim-shown': showIntermediate ? '1' : '0',
                            onClick: () => toggleInterim(headKey),
                          }, showIntermediate
                            ? format(t('groupHideIntermediate'), { n: group.counts.intermediate })
                            : format(t('groupShowIntermediate'), { n: hiddenCount })),
                        ])
                      : null,
                    h('div', { className: 'dg-groupBody', key: 'body' }, [
                      visibleFiles.length > 0
                        ? h('div', { className: `dg-grid${kind === 'file' ? ' dg-fileGrid' : ''}`, key: 'grid' },
                            visibleFiles.map((f) => cardFor(f, headKey, visibleFiles)))
                        : h('div', { className: 'dg-groupEmpty', key: 'empty' }, t('groupEmpty')),
                      group.truncated
                        ? h('div', { className: 'dg-groupEmpty', key: 'trunc', style: { marginTop: '8px' } },
                            format(t('groupTruncated'), { shown: group.returnedCount, total: group.fileCount }))
                        : null,
                    ]),
                  ]
                : null,
            ])
          })

          body = h('div', { className: 'dg-bodyWrap', key: 'bodyWrap' }, [
            h('div', {
              className: `dg-body${kind === 'file' ? ' dg-fileBody' : ''}`,
              key: 'body',
              'data-gallery-body': true,
              ref: bodyScrollRef,
            }, [
              h('div', { className: 'dg-groups', key: 'groups' }, groupNodes),
              data.scan.capped
                ? h('div', { className: 'dg-more', key: 'capped' }, t('capped'))
                : null,
            ]),
            h(ScrollRail, {
              key: 'rail',
              scrollerRef: bodyScrollRef,
              t,
              railClassName: kind === 'file' ? 'dg-panRailFiles' : '',
            }),
          ])
        } else {
        // 音视频：卡片直接播放（不走图片查看器）
      const mediaGridChildren = items.map((item) => h(MediaCard, {
        key: item.relPath,
        item,
        t,
        limiter: limiter.current,
        absPath: buildAbsPath(data === null ? '' : data.root, item.relPath),
        onPlay: (target) => setMediaPlaying(target),
        onContextMenu: openContextMenu,
      }))

      const gridChildren = items.map((item) => kind === 'file'
          ? h(FileCard, {
              key: item.relPath,
              item,
              t,
              absPath: buildAbsPath(data.root, item.relPath),
              onOpenFolder: (abs) => { void callHost('reveal', { path: item.relPath }).catch((e) => console.error('dsh-gallery: reveal 失败', e)) },
              onContextMenu: openContextMenu,
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
              onContextMenu: openContextMenu,
              onOpen: (opened, anchorEl) => openViewer(items.indexOf(opened), anchorEl, items),
            }))
        // 网格区外面包一层定位容器，右侧放滚动辅助列（无滚轮场景用）
        body = h('div', { className: 'dg-bodyWrap', key: 'bodyWrap' }, [
          h('div', {
            className: `dg-body${kind === 'file' ? ' dg-fileBody' : ''}`,
            key: 'body',
            'data-gallery-body': true,
            ref: bodyScrollRef,
          }, [
            h('div', { className: `dg-grid${kind === 'file' ? ' dg-fileGrid' : ''}${kind === 'media' ? ' dg-mediaGrid' : ''}`, key: 'grid' }, kind === 'media' ? mediaGridChildren : gridChildren),
            data.scan.capped
              ? h('div', { className: 'dg-more', key: 'capped' }, t('capped'))
              : null,
          ]),
          h(ScrollRail, {
            key: 'rail',
            scrollerRef: bodyScrollRef,
            t,
            railClassName: kind === 'file' ? 'dg-panRailFiles' : '',
          }),
        ])
        }
      }

      // 分页条：常驻显示「还有 X 张」+ 页码。单页时只显示总数，不渲染页码按钮。
      // 全局分组模式下不分页（分组自己带折叠），所以只在「当前对话」与非分组时显示。
      const usePager = scope !== 'global' || (data !== null && !Array.isArray(data.groups))
      const pager = usePager && data !== null && items.length > 0
        ? h(Pager, {
            key: 'pager',
            t,
            page: data.page ?? 1,
            pageCount: data.pageCount ?? 1,
            pageSize: data.pageSize ?? items.length,
            total: data.total,
            remaining: data.hidden,
            onGo: (next) => {
              if (next === page) return
              // 翻页时回到顶部，避免停在新页中段
              const scroller = bodyScrollRef.current
              if (scroller !== null) scroller.scrollTop = 0
              savedScrollRef.current = null
              setViewer(null)
              setPage(next)
            },
          })
        : null

      // 查看器作为覆盖层叠在网格上：网格保持挂载，滚动位置不丢
      // 用 viewer.list（打开时记录的快照），不用全局 items：
      // 分组视图下卡片来自组内文件，与当前页的扁平 items 不是同一个集合。
      const viewerLayer = viewer !== null && Array.isArray(viewer.list) && viewer.list.length > 0
        ? h('div', { className: 'dg-viewerLayer', key: 'viewerLayer' },
            h(Viewer, {
              items: viewer.list,
              index: Math.min(viewer.index, viewer.list.length - 1),
              t,
              initialOriginal: viewer.asOriginal === true,
              onClose: closeViewer,
              onStep: step,
            }))
        : null

      // 音视频播放器层（v0.10.1）
      const mediaLayer = mediaPlaying !== null
        ? h(MediaPlayer, {
            key: 'mediaPlayer',
            item: mediaPlaying,
            t,
            onClose: () => setMediaPlaying(null),
          })
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

      // 右键菜单
      const ctxLayer = ctxMenu !== null
        ? h(ContextMenu, {
            key: 'ctxMenu',
            t,
            x: ctxMenu.x,
            y: ctxMenu.y,
            item: ctxMenu.item,
            onClose: closeContextMenu,
            actions: {
              // 只对图片提供「查看原图」：直接以原图模式打开查看器
              onOpenOriginal: isImageItem(ctxMenu.item)
                ? () => { openViewerByItem(ctxMenu.item, true) }
                : undefined,
              onHide: () => { void doHide(ctxMenu.item) },
              onReveal: () => { void doReveal(ctxMenu.item) },
              onCopy: () => { void copyText(ctxMenu.absPath) },
              onDelete: () => setDeleteTarget({ item: ctxMenu.item, busy: false }),
            },
          })
        : null

      // 删除确认弹窗
      const confirmLayer = deleteTarget !== null
        ? h(ConfirmDialog, {
            key: 'confirmLayer',
            t,
            name: deleteTarget.item.name,
            busy: deleteTarget.busy === true,
            onCancel: () => setDeleteTarget(null),
            onConfirm: () => { void doDelete() },
          })
        : null

      return h('div', { className: 'dg-root', 'data-gallery-root': true }, [
        header,
        legend,
        body,
        pager,
        viewerLayer,
        mediaLayer,
        settingsLayer,
        ctxLayer,
        confirmLayer,
      ])
    }

    /**
     * 分页条：常驻在网格下方。
     * 左边「还有 X 张」说清总量分布，右边页码点击切页。
     * 单页时也渲染（只显示「共 N 张」），保持视觉稳定。
     */
    function Pager({ t, page, pageCount, pageSize, total, remaining, onGo }) {
      const start = total === 0 ? 0 : (page - 1) * pageSize + 1
      const end = Math.min(page * pageSize, total)

      // 页码按钮：页数很多时折叠，始终露出首末页与当前页邻域
      const numbers = React.useMemo(() => {
        if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1)
        const set = new Set([1, pageCount, page, page - 1, page + 1])
        if (page <= 3) [2, 3, 4].forEach((n) => set.add(n))
        if (page >= pageCount - 2) [pageCount - 1, pageCount - 2, pageCount - 3].forEach((n) => set.add(n))
        const sorted = [...set].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b)
        // 插入省略号
        const out = []
        let prev = 0
        for (const n of sorted) {
          if (prev !== 0 && n - prev > 1) out.push('…' + n)
          out.push(n)
          prev = n
        }
        return out
      }, [page, pageCount])

      const kids = []
      kids.push(h('span', {
        className: 'dg-pagerInfo',
        key: 'info',
        'data-gallery-page-info': true,
      }, format(t('pagerRange'), { start, end, total })))

      if (remaining > 0) {
        kids.push(h('span', {
          className: 'dg-pagerRemain',
          key: 'remain',
          'data-gallery-more': remaining,
        }, format(t('more'), { count: remaining })))
      }

      if (pageCount > 1) {
        const btn = (key, label, target, extra) => h('button', {
          type: 'button',
          key,
          className: `dg-pageBtn${extra ? ' ' + extra : ''}${target === page ? ' dg-pageActive' : ''}`,
          'data-gallery-page': target,
          disabled: target === page && extra !== 'nav',
          title: format(t('pageTip'), { page: target }),
          onClick: () => onGo(target),
        }, label)

        kids.push(h('div', { className: 'dg-pagerBtns', key: 'btns' }, [
          btn('prev', '‹', Math.max(1, page - 1), 'nav'),
          ...numbers.map((n) => typeof n === 'number'
            ? btn('p' + n, String(n), n)
            : h('span', { className: 'dg-pageGap', key: 'gap' + n }, '…')),
          btn('next', '›', Math.min(pageCount, page + 1), 'nav'),
        ]))
      }

      return h('div', { className: 'dg-pager', key: 'pagerBar', 'data-gallery-pager': page }, kids)
    }

    /**
     * 通用滚动辅助列：▲ + 轨道 + ▼。
     * 用于没有滚轮的场景（远程控制 / 触屏），列表页与放大页共用同一套交互。
     *
     * @param scrollerRef - 指向上层滚动容器（带 overflow 的那个 div）的 ref。
     * @param t - 文案函数。
     * @param onChange - 可选，滚动位置变化后的回调（放大页用它同步 pan）。
     * @param zoom - 放大页传当前倍率；列表页不传（按 1 处理，滑块按内容比例）。
     */
    function ScrollRail({ scrollerRef, t, onChange, zoom = 1, trackClassName = '', railClassName = '' }) {
      const [metrics, setMetrics] = React.useState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
      const thumbDragRef = React.useRef(null)

      const measure = React.useCallback(() => {
        const el = scrollerRef.current
        if (el === null) return
        setMetrics({
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        })
      }, [scrollerRef])

      // 监听滚动与尺寸变化，让滑块跟手
      React.useEffect(() => {
        const el = scrollerRef.current
        if (el === null) return undefined
        measure()
        el.addEventListener('scroll', measure, { passive: true })
        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (ro !== null) {
          ro.observe(el)
          // 内容（网格）高度变化也要重算：缩略图异步加载会改变 scrollHeight
          for (const child of el.children) ro.observe(child)
        }
        // 缩略图陆续加载完成时高度会跳动，补几个延时测量
        const timers = [80, 300, 900, 2000].map((ms) => setTimeout(measure, ms))
        window.addEventListener('resize', measure)
        return () => {
          el.removeEventListener('scroll', measure)
          if (ro !== null) ro.disconnect()
          for (const t of timers) clearTimeout(t)
          window.removeEventListener('resize', measure)
        }
      }, [scrollerRef, measure])

      const maxScroll = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
      const canScroll = maxScroll > 1
      const trackH = Math.max(1, metrics.clientHeight)
      // 滑块高度按「可视 / 总内容」比例，至少 28px 保证可点
      const thumbH = metrics.scrollHeight <= 0
        ? trackH
        : Math.max(28, Math.min(trackH, (metrics.clientHeight / metrics.scrollHeight) * trackH))
      const travel = Math.max(1, trackH - thumbH)
      const progress = maxScroll <= 0 ? 0 : metrics.scrollTop / maxScroll
      const thumbTop = travel * progress

      /** 滚到指定 scrollTop（0..maxScroll）。 */
      const scrollTo = (value) => {
        const el = scrollerRef.current
        if (el === null) return
        el.scrollTop = Math.max(0, Math.min(maxScroll, value))
        measure()
        if (typeof onChange === 'function') onChange()
      }

      /** 步进：一次半屏，远程操作下比滚轮更省力。 */
      const step = (direction) => scrollTo(metrics.scrollTop + direction * (metrics.clientHeight * 0.75))

      // 点轨道空白处直接跳转
      const onTrackClick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        const ratio = (event.clientY - rect.top) / Math.max(1, rect.height)
        scrollTo(ratio * maxScroll)
      }

      // 拖滑块
      const onThumbDown = (event) => {
        event.preventDefault()
        event.stopPropagation()
        thumbDragRef.current = { startY: event.clientY, startTop: metrics.scrollTop }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
      }
      const onThumbMove = (event) => {
        const d = thumbDragRef.current
        if (d === null) return
        event.preventDefault()
        const deltaPx = event.clientY - d.startY
        scrollTo(d.startTop + (deltaPx * maxScroll) / travel)
      }
      const onThumbUp = (event) => {
        if (thumbDragRef.current === null) return
        thumbDragRef.current = null
        if (event !== undefined) {
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
        }
      }

      const atTop = metrics.scrollTop <= 1
      const atBottom = metrics.scrollTop >= maxScroll - 1

      // 没有可滚动空间时不占位（避免列表很短时多出一列空栏）
      if (!canScroll) return null

      return h('div', {
        className: `dg-panRail ${railClassName}`.trim(),
        key: 'scrollRail',
        'data-gallery-scrollrail': true,
        onPointerDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
      }, [
        h('button', {
          type: 'button', className: 'dg-panBtn', key: 'up',
          'data-gallery-scroll': 'up',
          disabled: atTop,
          title: t('panUpHint'), 'aria-label': t('panUpHint'),
          onClick: (event) => { event.stopPropagation(); step(-1) },
        }, '▲'),
        h('div', {
          className: `dg-dragTrack ${trackClassName}`.trim(),
          key: 'track',
          title: t('trackHint'),
          onClick: onTrackClick,
        }, h('div', {
          className: 'dg-dragThumb',
          key: 'thumb',
          'data-gallery-scrollthumb': true,
          role: 'slider',
          'aria-orientation': 'vertical',
          style: { height: `${Math.round(thumbH)}px`, transform: `translateY(${Math.round(thumbTop)}px)` },
          onPointerDown: onThumbDown,
          onPointerMove: onThumbMove,
          onPointerUp: onThumbUp,
          onPointerCancel: onThumbUp,
        })),
        h('button', {
          type: 'button', className: 'dg-panBtn', key: 'down',
          'data-gallery-scroll': 'down',
          disabled: atBottom,
          title: t('panDownHint'), 'aria-label': t('panDownHint'),
          onClick: (event) => { event.stopPropagation(); step(1) },
        }, '▼'),
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
