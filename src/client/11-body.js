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
      // ---- 反馈标记（S3-a）----
      // marks: { [relPath]: { action, reason?, changeOnly?, keep? } }
      const [marks, setMarks] = React.useState({})
      // 反馈篮是否打开
      const [basketOpen, setBasketOpen] = React.useState(false)
      // 编辑中的条目（null 表示不编辑）
      const [editingItem, setEditingItem] = React.useState(null)
      // 网格滚动位置：打开查看器前记录，关闭后恢复，让视图停在原缩略图处
      const bodyScrollRef = React.useRef(null)
      const savedScrollRef = React.useRef(null)

      // 首次挂载时拉取已有标记（持久化在 dsh-gallery-marks.json）
      React.useEffect(() => {
        let alive = true
        callHost('getMarks', {})
          .then((payload) => {
            if (!alive) return
            if (payload?.ok === false) return
            if (payload !== null && typeof payload.marks === 'object' && payload.marks !== null) {
              setMarks(payload.marks)
            }
          })
          .catch((error) => console.warn('dsh-gallery: getMarks 失败', error))
        return () => { alive = false }
      }, [])

      /**
       * 给某卡片设标记 → 进反馈篮。
       * 只改本地状态 + 落盘 marks，**绝不发送任何消息**。
       */
      const doMark = React.useCallback(async (item, action, extra) => {
        const mark = { action, ...(extra ?? {}) }
        setMarks((prev) => ({ ...prev, [item.relPath]: mark }))
        setBasketOpen(true)
        try {
          const payload = await callHost('marks', { path: item.relPath, mark })
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
        } catch (error) {
          console.warn('dsh-gallery: 标记落盘失败', error)
        }
      }, [t])

      /**
       * 更新一条标记的附加字段（理由 / 只改 / 锁死）。
       * 供反馈篮的编辑弹窗调用 —— 让调研结论 4（显式只改 + 其余锁死）真正可填。
       */
      const updateMark = React.useCallback(async (relPath, patch) => {
        let nextMark = null
        setMarks((prev) => {
          const cur = prev[relPath]
          if (cur === undefined) return prev
          nextMark = { ...cur, ...patch }
          return { ...prev, [relPath]: nextMark }
        })
        if (nextMark !== null) {
          try {
            await callHost('marks', { path: relPath, mark: nextMark })
          } catch (error) {
            console.warn('dsh-gallery: 更新标记失败', error)
          }
        }
      }, [])

      /** 移除一条标记。 */
      const removeMark = React.useCallback(async (relPath) => {
        setMarks((prev) => {
          const next = { ...prev }
          delete next[relPath]
          return next
        })
        try {
          await callHost('marks', { path: relPath, mark: null })
        } catch (error) {
          console.warn('dsh-gallery: 清除标记失败', error)
        }
      }, [])

      /** 清空全部标记。 */
      const clearMarks = React.useCallback(async () => {
        const paths = Object.keys(marks)
        setMarks({})
        for (const relPath of paths) {
          try { await callHost('marks', { path: relPath, mark: null }) } catch { /* 忽略单条失败 */ }
        }
      }, [marks])

      /** 打开右键菜单。 */
      const openContextMenu = React.useCallback((item, absPath, event) => {
        // seam 兜底：记下最近右键的卡片，供独立包 getSelection() 用
        lastContextRelPath.current = item.relPath
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
      // 反馈篮独立入口（S3-a）：关闭后能重新打开，不必再标记一张卡
      const markedCount = Object.keys(marks).length
      const basketToggle = h('button', {
        type: 'button',
        className: 'dg-btn dg-basketToggle',
        key: 'basketToggle',
        'data-gallery-open-basket': true,
        'data-gallery-basket-count': markedCount,
        title: t('feedbackBasketToggleHint'),
        'aria-label': t('feedbackBasketToggleHint'),
        onClick: () => setBasketOpen((v) => !v),
      }, markedCount > 0
        ? format(t('feedbackBasketToggleN'), { n: markedCount })
        : t('feedbackBasketToggle'))

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
                    ?? (VIDEO_EXTS.includes(String(enriched.extension ?? '').toLowerCase()) ? 'video' : 'audio'),
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

      // 反馈篮（S3-a）：列出已标记条目 + 生成决策草稿
      const markedList = Object.keys(marks).map((relPath) => {
        // 从当前视图里找该条目，拿 category / sessionId
        const flat = (Array.isArray(data?.items) ? data.items : [])
        const groupsList = Array.isArray(data?.groups)
          ? data.groups.flatMap((gr) => (Array.isArray(gr.files) ? gr.files.map((f) => ({ ...f, sessionId: gr.sessionId })) : []))
          : []
        const found = flat.find((it) => it.relPath === relPath)
          ?? groupsList.find((it) => it.relPath === relPath)
        return {
          relPath,
          category: found?.category ?? 'unknown',
          sessionId: found?.sessionId,
          mark: marks[relPath],
        }
      })
      const feedbackLayer = basketOpen && markedList.length >= 0
        ? h(FeedbackBasket, {
            key: 'feedbackLayer',
            t,
            items: markedList,
            currentSessionId: sessionId ?? '',
            targetSessionTitle: scope === 'global'
              ? (view.status === 'ready' && Array.isArray(view.data?.groups)
                  ? (view.data.groups.find((g) => g.isCurrent)?.title ?? t('feedbackTargetCurrent'))
                  : t('feedbackTargetCurrent'))
              : '',
            onClose: () => { setBasketOpen(false); setEditingItem(null) },
            onRemove: (relPath) => { void removeMark(relPath) },
            onEdit: (it) => { setEditingItem(it) },
            onEditSave: (relPath, patch) => { void updateMark(relPath, patch) },
            onClear: () => { void clearMarks() },
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
              // 6 个反馈动作（S3-a）：选中即进反馈篮，不发送
              onMark: (action) => {
                const target = ctxMenu.item
                closeContextMenu()
                void doMark(target, action)
              },
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
        basketToggle,
        legend,
        body,
        pager,
        viewerLayer,
        mediaLayer,
        settingsLayer,
        ctxLayer,
        confirmLayer,
        feedbackLayer,
      ])
    }

    /**
     * 分页条：常驻在网格下方。
     * 左边「还有 X 张」说清总量分布，右边页码点击切页。
     * 单页时也渲染（只显示「共 N 张」），保持视觉稳定。
     */
