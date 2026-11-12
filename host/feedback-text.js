// GENERATED from src/shared/feedback-text.js — 请勿手改
/**
 * 反馈契约 v1 —— 纯函数，Host 与 Client 双端复用。
 *
 * 由 scripts/build.mjs 沿用 protocol.js 的做法：
 *  · 剥掉 export 注入 client bundle
 *  · 生成 host/feedback-text.js 供 Host 侧 import
 *
 * 设计原则（调研结论，见 docs/migration.md 与调研报告）：
 *  1. 反馈是**契约**不是自由文本：带锚点（relPath）、动作类型、理由、目标会话。
 *  2. **攒批 + 一次发送**：多条标记合成一条消息，不逐条发。
 *  3. **人确认闸门**：本模块只负责「产出草稿文本」，发送由用户在 composer 里点。
 *  4. **显式 changeOnly / keep**：生成类工作流实证「只改 X、其余锁死」远好于「再改改」。
 *  5. 逐条用 `Annotation N：` 编号，便于模型逐条回应（参考 dsh-quote-annotate-pro 契约）。
 */

/** 首版 6 个动作。值即契约里的 action 字符串，不要随意改（已写进 marks 文件）。 */
export const ACTIONS = [
  'approve',
  'reject',
  'finalize',
  'redo-one-dim',
  'regenerate-selected',
  'set-reference',
  // v0.14.2 手动调整标签的三条反馈语义（旧 6 个保留以兼容历史 marks）
  'finalize-asset',
  'reject-delivery',
  'set-label',
]

/** 动作 → 中文动词（生成草稿正文用）。 */
export const ACTION_LABELS_ZH = {
  approve: '通过',
  reject: '不要这张',
  finalize: '已定稿',
  'redo-one-dim': '单维重做',
  'regenerate-selected': '选择性重生成',
  'set-reference': '设为参照',
  'finalize-asset': '终止枚举，以此图为定稿',
  'reject-delivery': '交付不合格',
  'set-label': '调整产出标签',
}

/** 动作 → 英文动词。 */
export const ACTION_LABELS_EN = {
  approve: 'approve',
  reject: 'reject',
  finalize: 'deliver',
  'redo-one-dim': 'redo one dimension',
  'regenerate-selected': 'regenerate',
  'set-reference': 'set as reference',
  'finalize-asset': 'Stop enumerating; this asset is final',
  'reject-delivery': 'Delivery rejected',
  'set-label': 'Adjust asset label',
}

/** 契约版本。检查项会核对。 */
export const SCHEMA = 1

/** 来源标识。 */
export const SOURCE = 'dsh-gallery'

/** 常用「只改」维度候选（给 UI 做快捷输入，不是强制枚举）。 */
export const CHANGE_CANDIDATES = [
  '色调', '亮度', '材质', '构图', '透视', '比例', '文字', '光线', '风格', '细节',
]

/** 常用的「锁死」项候选。 */
export const KEEP_CANDIDATES = [
  '构图', '人物位置', '主体比例', '透视角度', '文字内容', '整体风格', '配色基调',
]

/**
 * 构造一条反馈项。
 * @param item - { relPath, category, action, reason?, changeOnly?, keep?, preserve?, region?, params? }
 * @returns 规范化后的 feedback item
 */
export function makeItem(item) {
  const out = {
    relPath: String(item?.relPath ?? ''),
    category: String(item?.category ?? 'unknown'),
    action: ACTIONS.includes(item?.action) ? item.action : 'approve',
  }
  if (typeof item?.reason === 'string' && item.reason.trim() !== '') out.reason = item.reason.trim()
  if (Array.isArray(item?.changeOnly) && item.changeOnly.length > 0) {
    out.changeOnly = item.changeOnly.map((x) => String(x)).filter((x) => x !== '')
  }
  if (Array.isArray(item?.keep) && item.keep.length > 0) {
    out.keep = item.keep.map((x) => String(x)).filter((x) => x !== '')
  }
  if (Array.isArray(item?.preserve) && item.preserve.length > 0) {
    out.preserve = item.preserve.map((x) => String(x)).filter((x) => x !== '')
  }
  if (item?.region !== undefined && item.region !== null) out.region = item.region
  if (item?.params !== undefined && item.params !== null) out.params = item.params
  // v0.14.3 截帧来源：随草稿一起带出，模型才知道反馈针对的是哪一帧
  if (item?.frameOf !== undefined && item?.frameOf !== null && typeof item.frameOf === 'object') {
    out.frameOf = {
      videoName: String(item.frameOf.videoName ?? ''),
      videoRelPath: String(item.frameOf.videoRelPath ?? ''),
      timecode: String(item.frameOf.timecode ?? ''),
      frameMs: Number(item.frameOf.frameMs) || 0,
    }
  }
  // v0.14.5 遮罩来源：由本条框选区域生成的 RGBA 遮罩资产，路径只随草稿带出
  // v0.14.6 右键多边形：把外接框 / 顶点像素坐标 / 面积一并带出，供 Agent 精确回填。
  if (item?.maskOf !== undefined && item?.maskOf !== null && typeof item.maskOf === 'object') {
    out.maskOf = {
      relPath: String(item.maskOf.relPath ?? ''),
      sourceName: String(item.maskOf.sourceName ?? ''),
      region: item.maskOf.region ?? null,
      polygon: Array.isArray(item.maskOf.polygon) ? item.maskOf.polygon : null,
      polygonPx: Array.isArray(item.maskOf.polygonPx) ? item.maskOf.polygonPx : null,
      bboxPx: Array.isArray(item.maskOf.bboxPx) ? item.maskOf.bboxPx : null,
      areaPx: Number(item.maskOf.areaPx) || 0,
      imageWidth: Number(item.maskOf.imageWidth) || 0,
      imageHeight: Number(item.maskOf.imageHeight) || 0,
      // v0.14.7 彩色填充预览图：只用于目视核对，工作流仍用主 alpha 遮罩
      overlayRelPath: String(item.maskOf.overlayRelPath ?? ''),
      fillColor: String(item.maskOf.fillColor ?? ''),
    }
  }
  return out
}

/**
 * 构造一份反馈草稿（契约对象）。
 * @param args - { sessionId, items, status? }
 */
export function makeFeedback(args) {
  return {
    schema: SCHEMA,
    source: SOURCE,
    sessionId: String(args?.sessionId ?? ''),
    status: args?.status === 'sent' ? 'sent' : 'draft',
    items: (Array.isArray(args?.items) ? args.items : []).map(makeItem),
    createdAt: typeof args?.createdAt === 'number' ? args.createdAt : Date.now(),
  }
}

/** 文件名取路径末段。 */
function baseName(relPath) {
  const s = String(relPath ?? '')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

/**
 * 把契约渲染成**人类与模型都能读的草稿正文**。
 *
 * 关键要求（调研结论 4）：每条必须同时写「只改 X」与「其余锁死」，
 * 否则模型容易把整张重画。
 *
 * @param feedback - makeFeedback() 的产物
 * @param options - { locale?: 'zh'|'en', targetSessionTitle?: string }
 * @returns 纯文本（可直接 setDraft 进 composer）
 */
export function renderFeedbackText(feedback, options) {
  const locale = options?.locale === 'en' ? 'en' : 'zh'
  const labels = locale === 'en' ? ACTION_LABELS_EN : ACTION_LABELS_ZH
  const items = Array.isArray(feedback?.items) ? feedback.items : []

  if (items.length === 0) {
    return locale === 'en'
      ? '(No items in the feedback basket.)'
      : '（反馈篮里还没有条目。）'
  }

  const lines = []
  if (locale === 'en') {
    lines.push(`[Feedback from dsh-gallery · ${items.length} item(s)]`)
    lines.push('')
    lines.push('Reply item by item using the `Annotation N:` prefix, so each decision maps to one annotation.')
    lines.push('')
  } else {
    lines.push(`【产出台反馈 · 共 ${items.length} 条】`)
    lines.push('')
    lines.push('请按 `Annotation 1：`、`Annotation 2：` … 逐条回应，让每条决定都对应到一个批注。')
    lines.push('')
  }

  items.forEach((item, idx) => {
    const n = idx + 1
    const name = baseName(item.relPath)
    const hasRegion = item.region !== undefined && item.region !== null
    // 带框选区域的条目来自「框选批注」：动词写清楚是「只改这个框里的东西」，
    // 比抽象动作名（单维重做）更贴近用户真正想说的话。
    const verb = hasRegion
      ? (locale === 'en' ? 'Change the boxed area only' : '按框选区域修改')
      : (labels[item.action] ?? item.action)
    lines.push(`Annotation ${n}：${verb} —— ${name}`)
    lines.push(`${locale === 'en' ? 'Path' : '路径'}：${item.relPath}`)
    if (item.frameOf !== undefined && item.frameOf !== null) {
      const f = item.frameOf
      lines.push(locale === 'en'
        ? `Frame source: taken from "${f.videoName}" at ${f.timecode} (${f.frameMs} ms)`
        : `帧来源：取自视频《${f.videoName}》${f.timecode}（第 ${f.frameMs} 毫秒）`)
    }
    // 遮罩来源是「资产路径 + 编码说明」，不是自动指令：模型拿到后自行上传 / 回填 image 输入
    if (item.maskOf !== undefined && item.maskOf !== null && String(item.maskOf.relPath ?? '') !== '') {
      lines.push(locale === 'en'
        ? `Mask source: ${item.maskOf.relPath} — RGBA mask from this box; alpha=0 inside the box, so ComfyUI LoadImage MASK (1 - alpha/255) marks only the area to inpaint`
        : `遮罩来源：${item.maskOf.relPath} —— 由本条框选区域生成的 RGBA 遮罩，框内 alpha=0，ComfyUI LoadImage 的 MASK 输出（1 - alpha/255）即待重绘区域；可用于局部重绘 / 移除流回填 image 输入`)
      const mp = item.maskOf
      // v0.14.7 彩色填充预览图：只供人核对选区位置，别拿去回填工作流
      if (String(mp.overlayRelPath ?? '') !== '') {
        const fillName = { green: '绿', red: '红', blue: '蓝' }[String(mp.fillColor ?? '')] ?? '绿'
        lines.push(locale === 'en'
          ? `Mask preview: ${mp.overlayRelPath} — original image with a solid semi-transparent fill over the selection; visual check only, hand the RGBA mask above to the workflow`
          : `遮罩预览：${mp.overlayRelPath} —— 原图上叠加${fillName}色半透明填充，仅用于目视核对选区位置；工作流请用上面的 RGBA 遮罩`)
      }
      if (Array.isArray(mp.polygonPx) && mp.polygonPx.length > 0) {
        const b = Array.isArray(mp.bboxPx) ? mp.bboxPx : [0, 0, 0, 0]
        const size = `${Number(mp.imageWidth) || 0}×${Number(mp.imageHeight) || 0}`
        const verts = JSON.stringify(mp.polygonPx)
        lines.push(locale === 'en'
          ? `Mask region: ${size}px source · ${mp.polygonPx.length} vertices · bbox (${b[0]},${b[1]})-(${b[2]},${b[3]}) · ~${Number(mp.areaPx) || 0}px · vertex pixels ${verts}`
          : `遮罩区域：原图 ${size}px · ${mp.polygonPx.length} 个顶点 · 外接框 (${b[0]},${b[1]})-(${b[2]},${b[3]}) · 面积约 ${Number(mp.areaPx) || 0}px · 顶点像素坐标 ${verts}`)
        lines.push(locale === 'en'
          ? 'Mask handoff: upload it, then replace the target workflow image input; use ONE short target phrase (e.g. change "X" to "Y", keep the original lettering), do not expand into a whole-word rewrite with extra constraints'
          : '遮罩回填：上传后替换目标工作流的 image 入参；提示词用单目标短句（例如：将图中的「X」，改为「Y」，保持原有字体色调），不要扩写成整词替换加约束')
      }
    }
    if (item.reason !== undefined) {
      lines.push(`${locale === 'en' ? 'Reason' : '理由'}：${item.reason}`)
    }
    if (Array.isArray(item.changeOnly) && item.changeOnly.length > 0) {
      lines.push(locale === 'en'
        ? `changeOnly: ${item.changeOnly.join(' / ')}`
        : `只改：${item.changeOnly.join(' / ')}`)
    }
    if (Array.isArray(item.keep) && item.keep.length > 0) {
      lines.push(locale === 'en'
        ? `keep locked: ${item.keep.join(' / ')}`
        : `锁死（其余不动）：${item.keep.join(' / ')}`)
    }
    if (Array.isArray(item.preserve) && item.preserve.length > 0) {
      lines.push(locale === 'en'
        ? `preserve: ${item.preserve.join(' / ')}`
        : `保留：${item.preserve.join(' / ')}`)
    }
    if (hasRegion) {
      // 人话百分比，别丢 JSON 给模型看：左上角 + 宽高，相对整张图
      const pct = (v) => {
        const num = Number(v)
        return Number.isFinite(num) ? Math.round(Math.max(0, Math.min(1, num)) * 100) : 0
      }
      const r = item.region
      lines.push(locale === 'en'
        ? `Region: left ${pct(r.x)}%, top ${pct(r.y)}%, width ${pct(r.w)}%, height ${pct(r.h)}% (relative to the whole image)`
        : `区域：左 ${pct(r.x)}%、上 ${pct(r.y)}%，宽 ${pct(r.w)}%、高 ${pct(r.h)}%（相对整张图）`)
    }
    if (item.params !== undefined && item.params !== null) {
      lines.push(`${locale === 'en' ? 'Params' : '参数'}：${JSON.stringify(item.params)}`)
    }
    lines.push('')
  })

  // 收口指令：把「锁死」原则再强调一次（防模型整张重画）
  if (locale === 'en') {
    lines.push('Unless an annotation says otherwise, keep everything else unchanged — do not regenerate wholesale.')
  } else {
    lines.push('除上述明确要改的部分外，其余全部保持原样，不要整张重做。')
  }

  return lines.join('\n')
}

/**
 * 把契约序列化成 JSON（导出 / 落盘 / 审计用，与渲染同一个 shape）。
 */
export function serializeFeedback(feedback) {
  return JSON.stringify(feedback, null, 2)
}
