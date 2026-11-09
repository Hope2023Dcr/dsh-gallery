/**
 * 框选批注层（v0.14.2）—— 在查看器图片上圈出「哪儿不对」。
 *
 * 设计要点：
 *   · 坐标全部归一化（0–1，相对图片宽高），见 shared/protocol.js 的 ANNOTATION_* 契约
 *   · SVG 覆盖在图片之上；不干扰查看器原有的缩放/平移（只有「批注模式」下才接管指针）
 *   · 拖拽画矩形 → 亮框**一直留着**直到保存/取消 → 输入框写说明 → 存进批注列表
 *   · 已存在的批注按归一化坐标还原绘制，带编号，缩放/换屏都不失真
 *   · 批注不发送任何东西；出口是与决策草稿同一通道（见 05-feedback.js）
 *
 * v0.14.1 修：
 *   ① 局部变量 h 遮蔽 React.createElement（画框直接崩面板）→ 全部改名 boxH
 *   ② 拖完松手就把草稿框清掉，图上没有任何边界标志 → 草稿保留到保存/取消
 *   ③ 输入框里按方向键/字母被查看器全局快捷键抢走 → 本层拦事件 + 查看器侧判焦点
 *   ④ 放大状态下查看器 pointerdown 会捕获指针，弹窗里的按钮点不动 → 弹窗拦冒泡
 *
 * v0.14.2 修：
 *   ⑤ 弹窗开着时第二处按不下：改为一按下就先把当前草稿存档，可连续圈多处
 *   ⑥ 只认「按住拖拽」：补「点两下」定义矩形（点起点 → 点终点），两种习惯都能用
 */

function AnnotationLayer({ t, annotations, onAdd, onRemove, active, frameMs, stageRef }) {
  const [draft, setDraft] = React.useState(null)
  const [editing, setEditing] = React.useState(null)
  /** 已点下第一下、等第二下定终点时的起点（归一化坐标）。 */
  const [pendingStart, setPendingStart] = React.useState(null)
  const svgRef = React.useRef(null)

  /** 退出标注模式时清掉未保存的草稿，避免输入框/虚线框残留。 */
  React.useEffect(() => {
    if (active) return undefined
    setDraft(null)
    setEditing(null)
    setPendingStart(null)
    return undefined
  }, [active])

  /** 客户坐标 → 归一化（相对 SVG 的实际渲染盒） */
  const toNorm = (event) => {
    const el = svgRef.current
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    }
  }

  const rectFrom = (p0, p1) => ({
    x: Math.min(p0.x, p1.x),
    y: Math.min(p0.y, p1.y),
    w: Math.abs(p1.x - p0.x),
    h: Math.abs(p1.y - p0.y),
  })

  /** 太小当成误点，不产生批注（避免满屏碎框）。 */
  const isValidBox = (box) => box.w >= 0.01 && box.h >= 0.01

  const clearPending = () => {
    setDraft(null)
    setEditing(null)
    setPendingStart(null)
  }

  /**
   * 把正在编辑的草稿直接存档（说明可留空）。
   * 用于「弹窗还开着就在图上圈下一处」：不丢当前这处，也不卡住下一处。
   */
  const commitEditing = () => {
    if (editing === null) return
    const normalized = normalizeAnnotation(editing)
    if (normalized !== null) onAdd(normalized)
    setEditing(null)
  }

  const beginEdit = (box) => {
    // draft 的形态必须是 {x0,y0,x1,y1}（绘制层按这四个角算框），
    // 不能直接塞 {x,y,w,h}，否则 Math.min(undefined) → NaN%，框画不出来。
    setDraft({ x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h })
    setEditing({ shape: 'rect', ...box, note: '', frameMs: frameMs ?? null })
    setPendingStart(null)
  }

  const onPointerDown = (event) => {
    if (!active) return
    // 放大状态下查看器会在 pointerdown 里 setPointerCapture；这里必须拦住冒泡，
    // 否则弹窗内的输入框/按钮会被「拖图」逻辑抢走，表现为点击无反应。
    event.stopPropagation()
    if (event.button !== 0) return
    const p = toNorm(event)
    if (p === null) return
    event.preventDefault()
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }

    // 上一处还在输入 → 先存档，第二处才按得下去（v0.14.2 ⑤）
    if (editing !== null) commitEditing()

    // 已经点过第一下 → 这一下当终点，直接成框（v0.14.2 ⑥）
    if (pendingStart !== null) {
      const box = rectFrom(pendingStart, p)
      if (isValidBox(box)) {
        beginEdit(box)
      } else {
        // 两次点到同一处：把起点挪到新位置，继续等第二下
        setPendingStart(p)
        setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      }
      return
    }

    setPendingStart(p)
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }

  const onPointerMove = (event) => {
    if (!active || draft === null || editing !== null) return
    event.stopPropagation()
    const p = toNorm(event)
    if (p === null) return
    event.preventDefault()
    setDraft((d) => (d === null ? null : { ...d, x1: p.x, y1: p.y }))
  }

  const finishDraft = (event) => {
    if (draft === null || editing !== null) return
    event.preventDefault()
    event.stopPropagation()
    const box = rectFrom({ x: draft.x0, y: draft.y0 }, { x: draft.x1, y: draft.y1 })
    if (!isValidBox(box)) {
      // 只是点了一下、还没拖：保留起点，等第二下点终点（v0.14.2 ⑥）
      setPendingStart({ x: draft.x0, y: draft.y0 })
      setDraft(null)
      return
    }
    // 草稿框不清：输入框弹出期间，图上必须仍然看得见刚才圈的位置
    beginEdit(box)
  }

  const saveEditing = () => {
    if (editing === null) return
    const normalized = normalizeAnnotation(editing)
    if (normalized !== null) onAdd(normalized)
    clearPending()
  }

  /**
   * 双层描边矩形：白色外线 + 彩色内线。
   * vectorEffect=non-scaling-stroke 让线宽固定为屏幕像素，缩放时既不糊也不粗得离谱。
   */
  const rectPair = (key, a, color, dashed) => {
    const box = {
      x: (a.x * 100) + '%', y: (a.y * 100) + '%',
      width: (a.w * 100) + '%', height: (a.h * 100) + '%',
      rx: 3,
    }
    const dash = dashed ? { strokeDasharray: '7 5' } : {}
    return h('g', { key }, [
      h('rect', {
        ...box, key: 'outer', fill: 'none', stroke: '#ffffff', strokeWidth: 4,
        vectorEffect: 'non-scaling-stroke', opacity: 0.92, ...dash,
      }),
      h('rect', {
        ...box, key: 'inner',
        fill: dashed ? 'rgba(255, 209, 102, 0.20)' : 'rgba(74, 124, 255, 0.18)',
        stroke: color, strokeWidth: 2, vectorEffect: 'non-scaling-stroke', ...dash,
      }),
    ])
  }

  // ---- 绘制已有批注 ----
  const shapes = (annotations ?? []).map((a, idx) => {
    if (a.shape === 'text') {
      return h('g', { key: a.id }, [
        h('circle', {
          key: 'dot', cx: (a.x * 100) + '%', cy: (a.y * 100) + '%', r: 4,
          fill: '#ffd166', stroke: '#000', strokeWidth: 1,
        }),
        h('text', {
          key: 'txt', x: (a.x * 100) + '%', y: (a.y * 100) + '%',
          dx: 8, dy: 4, fill: '#fff', fontSize: 12, stroke: '#000', strokeWidth: 0.6,
          style: { paintOrder: 'stroke' },
        }, a.note || ''),
      ])
    }
    // rect / arrow 都先按矩形画（arrow 后续可细化），带编号与说明文字
    return h('g', { key: a.id }, [
      rectPair('r', a, '#4a7cff', false),
      h('text', {
        key: 'n',
        x: (a.x * 100) + '%', y: (a.y * 100) + '%',
        dx: 4, dy: -6, fill: '#fff', fontSize: 12, stroke: '#000', strokeWidth: 0.6,
        style: { paintOrder: 'stroke' },
      }, `#${idx + 1}${a.note !== '' ? ' ' + a.note : ''}`),
    ])
  })

  // ---- 正在画的框 / 已点下的起点（保存前一直可见）----
  const draftShape = draft !== null
    ? (() => {
        const x = Math.min(draft.x0, draft.x1)
        const y = Math.min(draft.y0, draft.y1)
        const w = Math.abs(draft.x1 - draft.x0)
        const boxH = Math.abs(draft.y1 - draft.y0)
        return h('g', { key: 'draft' }, [
          rectPair('box', { x, y, w, h: boxH }, '#ffd166', true),
          h('text', {
            key: 'tag', x: (x * 100) + '%', y: (y * 100) + '%',
            dx: 4, dy: -6, fill: '#ffe08a', fontSize: 12, stroke: '#000', strokeWidth: 0.6,
            style: { paintOrder: 'stroke' },
          }, t('annotPendingTag')),
        ])
      })()
    : (pendingStart !== null
        ? h('g', { key: 'startPoint' }, [
            h('circle', {
              cx: (pendingStart.x * 100) + '%', cy: (pendingStart.y * 100) + '%', r: 5,
              fill: '#ffd166', stroke: '#000', strokeWidth: 1.5,
            }),
            h('text', {
              x: (pendingStart.x * 100) + '%', y: (pendingStart.y * 100) + '%',
              dx: 9, dy: 4, fill: '#ffe08a', fontSize: 12, stroke: '#000', strokeWidth: 0.6,
              style: { paintOrder: 'stroke' },
            }, t('annotStartTag')),
          ])
        : null)

  /** 弹窗与批注列表：一律拦住指针/点击冒泡，别让查看器抢事件。 */
  const blockViewer = {
    onPointerDown: (e) => e.stopPropagation(),
    onPointerUp: (e) => e.stopPropagation(),
    onClick: (e) => e.stopPropagation(),
    onContextMenu: (e) => { e.preventDefault(); e.stopPropagation() },
  }

  const editor = editing === null ? null : h('div', {
    className: 'dg-annotEditor',
    key: 'editor',
    'data-gallery-annot-editor': true,
    ...blockViewer,
  }, [
    h('div', { className: 'dg-annotEditorHead', key: 'h' }, t('annotNotePrompt')),
    h('div', { className: 'dg-annotPendingHint', key: 'p' }, t('annotPendingHint')),
    h('input', {
      type: 'text',
      key: 'inp',
      className: 'dg-annotInput',
      'data-gallery-annot-input': true,
      autoFocus: true,
      placeholder: t('annotNotePlaceholder'),
      value: editing.note,
      maxLength: 500,
      onChange: (e) => setEditing((cur) => (cur === null ? null : { ...cur, note: e.target.value })),
      onKeyDown: (e) => {
        // 方向键/字母键属于输入内容，不能被查看器的全局快捷键截走
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); saveEditing() }
        if (e.key === 'Escape') { e.preventDefault(); clearPending() }
      },
    }),
    h('div', { className: 'dg-annotEditorOps', key: 'o' }, [
      h('button', {
        type: 'button', className: 'dg-btn dg-btnSmall', key: 'c',
        onClick: (e) => { e.stopPropagation(); e.preventDefault(); clearPending() },
      }, t('cancel')),
      h('button', {
        type: 'button', className: 'dg-btn dg-btnSmall dg-annotSave', key: 's',
        'data-gallery-annot-save': true,
        onClick: (e) => { e.stopPropagation(); e.preventDefault(); saveEditing() },
      }, t('save')),
    ]),
  ])

  const list = (annotations ?? []).length === 0 ? null : h('div', {
    className: 'dg-annotList', key: 'list', 'data-gallery-annot-list': true,
    ...blockViewer,
  }, (annotations ?? []).map((a, idx) => h('div', {
    className: 'dg-annotItem', key: a.id, 'data-gallery-annot-id': a.id,
  }, [
    h('span', { className: 'dg-annotIndex', key: 'i' }, `#${idx + 1}`),
    h('span', { className: 'dg-annotText', key: 't' }, a.note || t('annotNoNote')),
    h('button', {
      type: 'button', className: 'dg-btn dg-btnSmall dg-btnIcon', key: 'x',
      title: t('delete'), 'data-gallery-annot-remove': a.id,
      onClick: (e) => { e.stopPropagation(); e.preventDefault(); onRemove(a.id) },
    }, '✕'),
  ])))

  return h('div', {
    className: 'dg-annotWrap', key: 'annot',
    style: { position: 'absolute', inset: 0, zIndex: 3 },
  }, [
    h('svg', {
      key: 'svg',
      ref: svgRef,
      className: `dg-annotSvg${active ? ' dg-annotActive' : ''}`,
      'data-gallery-annot-svg': true,
      'data-gallery-annot-active': active ? '1' : '0',
      // 不设 viewBox：坐标本来就是百分比（相对 SVG 视口），去掉 viewBox 后
      // 线宽与字号按屏幕像素计算，否则 12 号字会被放大成几十像素、盖住整张图。
      style: {
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: active ? 'auto' : 'none',
        cursor: active ? 'crosshair' : 'default',
      },
      onPointerDown,
      onPointerMove,
      onPointerUp: finishDraft,
      onPointerCancel: () => { setDraft(null); setPendingStart(null) },
      onClick: active ? (event) => { event.preventDefault(); event.stopPropagation() } : undefined,
      onContextMenu: active ? (event) => { event.preventDefault(); event.stopPropagation() } : undefined,
    }, [draftShape, ...shapes]),
    list,
    editor,
  ])
}
