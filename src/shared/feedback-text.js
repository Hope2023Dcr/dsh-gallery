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
]

/** 动作 → 中文动词（生成草稿正文用）。 */
export const ACTION_LABELS_ZH = {
  approve: '通过',
  reject: '不要这张',
  finalize: '已定稿',
  'redo-one-dim': '单维重做',
  'regenerate-selected': '选择性重生成',
  'set-reference': '设为参照',
}

/** 动作 → 英文动词。 */
export const ACTION_LABELS_EN = {
  approve: 'approve',
  reject: 'reject',
  finalize: 'deliver',
  'redo-one-dim': 'redo one dimension',
  'regenerate-selected': 'regenerate',
  'set-reference': 'set as reference',
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
    lines.push(`【产出画廊反馈 · 共 ${items.length} 条】`)
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
