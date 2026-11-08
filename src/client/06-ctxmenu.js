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
        // ---- 反馈标记（S3-a）：6 个动作，选中后进反馈篮，不直接发送 ----
        actions.onMark !== undefined
          ? h('div', { className: 'dg-ctxDivider', key: 'markDivider' }, t('ctxMarkSection'))
          : null,
        actions.onMark !== undefined
          ? entry('mark-approve', t('ctxMarkApprove'), '✓', () => actions.onMark('approve'))
          : null,
        actions.onMark !== undefined
          ? entry('mark-reject', t('ctxMarkReject'), '✕', () => actions.onMark('reject'))
          : null,
        actions.onMark !== undefined
          ? entry('mark-finalize', t('ctxMarkFinalize'), '★', () => actions.onMark('finalize'))
          : null,
        actions.onMark !== undefined
          ? entry('mark-redo', t('ctxMarkRedo'), '↻', () => actions.onMark('redo-one-dim'))
          : null,
        actions.onMark !== undefined
          ? entry('mark-regen', t('ctxMarkRegen'), '⟳', () => actions.onMark('regenerate-selected'))
          : null,
        actions.onMark !== undefined
          ? entry('mark-ref', t('ctxMarkReference'), '◎', () => actions.onMark('set-reference'))
          : null,
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
