/**
 * 框选批注层（v0.14.0）—— 在查看器图片上圈出「哪儿不对」。
 *
 * 设计要点：
 *   · 坐标全部归一化（0–1，相对图片宽高），见 shared/protocol.js 的 ANNOTATION_* 契约
 *   · SVG 覆盖在图片之上；不干扰查看器原有的缩放/平移（只有「批注模式」下才接管指针）
 *   · 拖拽画矩形 → 立刻弹出输入框写说明 → 存进批注列表
 *   · 已存在的批注按归一化坐标还原绘制，缩放/换屏都不失真
 *   · 批注不发送任何东西；出口是与决策草稿同一通道（见 05-feedback.js）
 */

function AnnotationLayer({ t, annotations, onAdd, onRemove, active, frameMs, stageRef }) {
  const [draft, setDraft] = React.useState(null)
  const [editing, setEditing] = React.useState(null)
  const svgRef = React.useRef(null)

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

  const onPointerDown = (event) => {
    if (!active) return
    // 只响应主键；左键拖拽画框
    if (event.button !== 0) return
    const p = toNorm(event)
    if (p === null) return
    event.preventDefault()
    event.stopPropagation()
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }

  const onPointerMove = (event) => {
    if (draft === null) return
    const p = toNorm(event)
    if (p === null) return
    event.preventDefault()
    event.stopPropagation()
    setDraft((d) => (d === null ? null : { ...d, x1: p.x, y1: p.y }))
  }

  const finishDraft = (event) => {
    if (draft === null) return
    event.preventDefault()
    event.stopPropagation()
    const x = Math.min(draft.x0, draft.x1)
    const y = Math.min(draft.y0, draft.y1)
    const w = Math.abs(draft.x1 - draft.x0)
    const h = Math.abs(draft.y1 - draft.y0)
    setDraft(null)
    // 太小当成误点，不产生批注（避免满屏碎框）
    if (w < 0.01 || h < 0.01) return
    setEditing({ shape: 'rect', x, y, w, h, note: '', frameMs: frameMs ?? null })
  }

  const saveEditing = () => {
    if (editing === null) return
    const normalized = normalizeAnnotation(editing)
    if (normalized !== null) onAdd(normalized)
    setEditing(null)
  }

  // ---- 绘制已有批注 ----
  const shapes = (annotations ?? []).map((a) => {
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
    // rect / arrow 都先按矩形画（arrow 后续可细化），带说明文字
    return h('g', { key: a.id }, [
      h('rect', {
        key: 'r',
        x: (a.x * 100) + '%', y: (a.y * 100) + '%',
        width: (a.w * 100) + '%', height: (a.h * 100) + '%',
        fill: 'rgba(74, 124, 255, 0.14)', stroke: '#4a7cff', strokeWidth: 2,
        rx: 3,
      }),
      a.note !== ''
        ? h('text', {
            key: 'n',
            x: (a.x * 100) + '%', y: (a.y * 100) + '%',
            dx: 4, dy: -6, fill: '#fff', fontSize: 12, stroke: '#000', strokeWidth: 0.6,
            style: { paintOrder: 'stroke' },
          }, a.note)
        : null,
    ])
  })

  // ---- 正在画的框 ----
  const draftShape = draft === null ? null : (() => {
    const x = Math.min(draft.x0, draft.x1)
    const y = Math.min(draft.y0, draft.y1)
    const w = Math.abs(draft.x1 - draft.x0)
    const h = Math.abs(draft.y1 - draft.y0)
    return h('rect', {
      key: 'draft',
      x: (x * 100) + '%', y: (y * 100) + '%',
      width: (w * 100) + '%', height: (h * 100) + '%',
      fill: 'rgba(74, 124, 255, 0.22)', stroke: '#4a7cff', strokeWidth: 2, strokeDasharray: '5 3',
    })
  })()

  const editor = editing === null ? null : h('div', {
    className: 'dg-annotEditor',
    key: 'editor',
    'data-gallery-annot-editor': true,
  }, [
    h('div', { className: 'dg-annotEditorHead', key: 'h' }, t('annotNotePrompt')),
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
        if (e.key === 'Enter') { e.preventDefault(); saveEditing() }
        if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
      },
    }),
    h('div', { className: 'dg-annotEditorOps', key: 'o' }, [
      h('button', { type: 'button', className: 'dg-btn dg-btnSmall', key: 'c', onClick: () => setEditing(null) }, t('cancel')),
      h('button', {
        type: 'button', className: 'dg-btn dg-btnSmall dg-primaryBtn', key: 's',
        'data-gallery-annot-save': true, onClick: saveEditing,
      }, t('save')),
    ]),
  ])

  const list = (annotations ?? []).length === 0 ? null : h('div', {
    className: 'dg-annotList', key: 'list', 'data-gallery-annot-list': true,
  }, (annotations ?? []).map((a) => h('div', {
    className: 'dg-annotItem', key: a.id, 'data-gallery-annot-id': a.id,
  }, [
    h('span', { className: 'dg-annotIndex', key: 'i' }, '#'),
    h('span', { className: 'dg-annotText', key: 't' }, a.note || t('annotNoNote')),
    h('button', {
      type: 'button', className: 'dg-btn dg-btnSmall dg-btnIcon', key: 'x',
      title: t('delete'), 'data-gallery-annot-remove': a.id,
      onClick: () => onRemove(a.id),
    }, '✕'),
  ])))

  return h('div', { className: 'dg-annotWrap', key: 'annot', style: { position: 'absolute', inset: 0 } }, [
    h('svg', {
      key: 'svg',
      ref: svgRef,
      className: `dg-annotSvg${active ? ' dg-annotActive' : ''}`,
      'data-gallery-annot-svg': true,
      'data-gallery-annot-active': active ? '1' : '0',
      viewBox: '0 0 100 100',
      preserveAspectRatio: 'none',
      style: {
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: active ? 'auto' : 'none',
        cursor: active ? 'crosshair' : 'default',
      },
      onPointerDown,
      onPointerMove,
      onPointerUp: finishDraft,
      onPointerCancel: () => setDraft(null),
    }, [draftShape, ...shapes]),
    list,
    editor,
  ])
}
