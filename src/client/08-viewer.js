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
