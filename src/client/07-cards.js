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
