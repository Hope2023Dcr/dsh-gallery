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
