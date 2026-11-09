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


    /**
     * 画廊对外 seam（S3-a v1）。
     *
     * 给独立包 / 未来扩展一个稳定入口，避免依赖 DOM 猜测。
     * 契约版本放在 version 字段，check.mjs 第 17 项会核对。
     *
     * 注意：这是**只读 + 标记**的窄接口，不含发送能力 ——
     * 发送永远由用户在 composer 里手动确认。
     */
    /** 最近一次右键选中的卡片 relPath（seam.getSelection 的兜底来源）。 */
    const lastContextRelPath = { current: null }

    function installSeam() {
      const seam = {
        version: 1,
        /**
         * 当前选中的卡片（查看器打开时是那张图；否则 null）。
         * @returns { relPath: string } | null
         */
        /**
         * 当前选中项。
         *
         * 优先级：
         *   1. 查看器已打开 → 那张图（最明确的「当前选中」）
         *   2. 否则 → 最近一次右键选中的卡片（lastContextRelPath）
         *   3. 都没有 → 用 a11y 焦点/悬停兜底（:focus 的卡片）
         *
         * 每个卡片都挂 data-gallery-relpath，独立包可据此定位。
         */
        getSelection() {
          // 1. 查看器内的图
          const viewerEl = document.querySelector('[data-gallery-viewer] [data-gallery-src-relpath]')
          if (viewerEl !== null) {
            const relPath = viewerEl.getAttribute('data-gallery-src-relpath')
            if (relPath !== null && relPath !== '') return { relPath, source: 'viewer' }
          }
          // 2. 最近右键选中的卡片
          if (lastContextRelPath.current !== null) {
            return { relPath: lastContextRelPath.current, source: 'context-menu' }
          }
          // 3. 焦点中的卡片（键盘/无鼠标场景）
          const focused = document.querySelector('[data-gallery-relpath]:focus')
          if (focused !== null) {
            const relPath = focused.getAttribute('data-gallery-relpath')
            if (relPath !== null && relPath !== '') return { relPath, source: 'focus' }
          }
          return null
        },
        /**
         * 订阅「选中项变化」。返回退订函数。
         * 实现方式：观察 DOM 属性变化（低成本、零依赖）。
         */
        subscribe(fn) {
          if (typeof fn !== 'function') return () => {}
          const target = document.querySelector('[data-gallery-root]')
          if (target === null || typeof MutationObserver !== 'function') return () => {}
          const observer = new MutationObserver(() => { try { fn(seam.getSelection()) } catch { /* 忽略订阅者异常 */ } })
          observer.observe(target, { subtree: true, attributes: true, attributeFilter: ['data-gallery-viewer'] })
          return () => observer.disconnect()
        },
        /** 当前所有标记（异步，来自 Host）。 */
        async getMarks() {
          try {
            const payload = await callHost('getMarks', {})
            return payload?.ok === false ? {} : (payload?.marks ?? {})
          } catch { return {} }
        },
        /** 设/清一条标记。 */
        async setMark(relPath, mark) {
          try {
            const payload = await callHost('marks', { path: relPath, mark: mark ?? null })
            return payload?.ok !== false
          } catch { return false }
        },
        /** 当前反馈草稿文本（若反馈篮已生成过；未生成返回空串）。 */
        getFeedbackDraft() {
          return draftRef.current ?? ''
        },
      }
      window.dshGallerySeam = seam
      return seam
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
      // ⚠️ 不要声明 conversation.input / sessions / agents。
      // 实测：inject 声明 conversation.input 会让 Cordis 插件在 web boot 阶段
      // 一直 pending（"waiting for service: conversation.input"），宿主判定启动失败、
      // 页面永久停在 "Loading plugins…"、主进程退出。
      // 因此草稿写入走零 inject 的纯 DOM 路径（见 05-feedback.js 的 writeDraftToComposer）。
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ctxRef.current = ctx
        ctx.effect(() => () => { ctxRef.current = null }, 'dsh-gallery: context handle')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-gallery: dictionaries')

        // seam v1（S3-a）：对外暴露窄接口，供独立包 / 扩展使用
        ctx.effect(() => {
          const seam = installSeam()
          return () => {
            if (window.dshGallerySeam === seam) delete window.dshGallerySeam
          }
        }, 'dsh-gallery: seam')

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
