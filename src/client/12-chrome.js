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
