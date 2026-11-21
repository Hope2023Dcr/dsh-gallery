// GENERATED from src/shared/protocol.js — 请勿手改
/**
 * 协议常量 —— Host 与 Client 的唯一真源。
 *
 * 拆分前 ROUTE / MEDIA_ROUTE / 扩展名表在 client.js 和 index.js 里各存一份，
 * 改路由要改两处、漏一处就打不通。现在由 scripts/build.mjs 同时生成
 * host/protocol.js 并注入 client bundle，两边不可能再漂移。
 *
 * 注意：本文件是 ESM，注入 client 时构建器会剥掉 export 关键字。
 */

/** 与 Host 半部一致的路由（exact Fetch 路由的 path）。 */
export const ROUTE = '/api/dsh-gallery'

/** 音视频直链（GET，支持 Range）——给 <video>/<audio> 用。 */
export const MEDIA_ROUTE = '/api/dsh-gallery/media'

/** 图片扩展名（缩略图/查看器/原图模式共用）。 */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']

/** 视频扩展名（与 Host 的 VIDEO_EXTS 保持一致）。 */
export const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv']

/** 音频扩展名。 */
export const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wma']

/**
 * 框选批注的坐标契约（v0.14.0）—— Host 与 Client 的唯一真源。
 *
 * 为什么用归一化坐标：批注要落在「图片的某个位置」上，而不是「屏幕上某个像素」。
 * 写像素值的话，换个窗口尺寸 / 换个缩放比例就全错了。
 * 用相对宽高的 0–1 比例，无论怎么缩放都能还原到同一块区域。
 *
 * 形状类型：
 *   rect  —— 矩形框（最主要，圈出「这块不对」）
 *   arrow —— 箭头（指向具体某点）
 *   text  —— 纯文字标注（钉在某位置，不带框）
 */
export const ANNOTATION_SHAPES = ["rect", "arrow", "text"]

/**
 * 一条批注的数据形态：
 * {
 *   id: string,                  // 稳定 id（同一次会话内唯一）
 *   shape: "rect|arrow|text",
 *   x: number, y: number,        // 起点，归一化 0–1
 *   w: number, h: number,        // 宽高，归一化 0–1（text/arrow 可只用 x,y）
 *   note: string,                // 人写的说明（可为空）
 *   frameMs: number|null,        // 视频帧时间（图片为 null）
 * }
 *
 * 约束：x/y/w/h 必须落在 [0,1]；越界由写入端 clamp。
 */
export const ANNOTATION_LIMITS = { min: 0, max: 1, maxNoteLength: 500, maxPerAsset: 50 }

/** 把任意数值 clamp 到 [0,1]（批注坐标写入前必须过一遍）。 */
export function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** 把数夹到 [min, max] 闭区间内。 */
function clampNum(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * v0.16.0 选段播放决策（纯函数，便于单测）。
 *
 * 老板 2026-11-13 11:56 反馈：播放必须跟选段走 —— **从入点起播、到出点结束**，
 * 而不是播放器自己按整段播（截图里选段是 2:16–3:21，播放头却停在 0:29）。
 * 拖动端点 / 点轨道时（scrubbing）不做钳制，否则播放头会被反复拽回，没法目视选帧。
 *
 * @returns {{ action: 'none' | 'stop' | 'seekIn', seekTo?: number }}
 */
function trimPlaybackDecision(now, inPoint, outPoint, opts) {
  const o = opts || {}
  if (!Number.isFinite(now)) return { action: 'none' }
  // 区间还没初始化（或过短）时不要干预原生播放
  if (!(outPoint > inPoint + 0.05)) return { action: 'none' }
  if (o.scrubbing === true) return { action: 'none' }
  // 到出点：停住，不循环 —— 老板要的是「到出点结束」
  if (now >= outPoint - 0.02) return { action: 'stop', seekTo: Math.min(now, outPoint) }
  // 播放跑到入点之前（例如用原生进度条拖到了区间外）→ 拉回入点
  if (now < inPoint - 0.25 && o.paused !== true) return { action: 'seekIn', seekTo: inPoint }
  return { action: 'none' }
}

/** 校验并规整一条批注；不合法返回 null。 */
export function normalizeAnnotation(a) {
  if (a === null || typeof a !== "object") return null
  const shape = ANNOTATION_SHAPES.includes(a.shape) ? a.shape : "rect"
  const note = typeof a.note === "string" ? a.note.slice(0, ANNOTATION_LIMITS.maxNoteLength) : ""
  const x = clamp01(a.x)
  const y = clamp01(a.y)
  let w = clamp01(a.w)
  let h = clamp01(a.h)
  // 宽高至少留一点，且不越过右/下边界
  if (w > 0 && x + w > 1) w = 1 - x
  if (h > 0 && y + h > 1) h = 1 - y
  const frameMs = Number.isFinite(a.frameMs) ? Math.max(0, Math.floor(a.frameMs)) : null
  return {
    id: typeof a.id === "string" && a.id !== "" ? a.id : ("a" + Math.random().toString(36).slice(2, 10)),
    shape, x, y, w, h, note, frameMs,
  }
}

/**
 * 批注层几何（v0.14.4）：SVG 与 <img> 共用同一布局盒、同一组 translate/scale。
 * 图片按 object-fit:contain 居中后，实际显示盒往往小于预览容器；旧版 SVG 覆盖整个
 * 容器且不带变换，1:1 就可能错位，放大后更彻底脱框。抽成纯函数便于离线钉死契约。
 */
function annotationSvgStyle(imgBox, pan, zoom, transition) {
  return {
    position: 'absolute',
    left: `${imgBox.left}px`,
    top: `${imgBox.top}px`,
    width: `${imgBox.width}px`,
    height: `${imgBox.height}px`,
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transformOrigin: '50% 50%',
    transition,
  }
}

/**
 * 标注态「按下要不要拦冒泡 / 交给谁」的判定（v0.14.4）。
 * 查看器本身就支持中键拖拽平移；标注层过去对所有按键一律 stopPropagation，
 * 把中键吞掉，导致标注时挪不动图。现在：中键放行给查看器平移，左键留给画框。
 */
function annotationPointerRouting(active, button) {
  // 未激活：不拦（图片 pointerEvents:none，事件本就落到查看器）
  if (!active) return 'pass'
  // 中键(1)：放行给查看器的中键拖拽平移，框跟着图走（已画框与图共用 pan/zoom）
  if (button === 1) return 'pan'
  // 左键(0)及其余：拦住，交给标注层画框；顺带防止弹窗输入被查看器拖图抢走
  return 'draw'
}

/** 标注层 SVG 的光标：中键平移进行中显示抓握，否则画框态为十字。 */
function annotationSvgCursor(active, dragging, zoom) {
  if (!active) return 'default'
  if (dragging && zoom > 1) return 'grabbing'
  return 'crosshair'
}

/**
 * 遮罩编码契约（v0.14.5 本机 MVP）—— 本机实证，不是推测：
 *   ComfyUI 官方 LoadImage 与本机孤海 LoadImageGoohai 的 MASK 输出都是 `1 - alpha/255`。
 *   所以「框内 alpha=0、框外 alpha=255」的普通 RGBA PNG 直接就是可用遮罩，
 *   RGB 必须保留原图像素（LoadImage 的 IMAGE 输出仍拿它做局部重绘）。
 *   这与 clipspace-painted-* 涂鸦遮罩等价，但不必复刻 ComfyUI 画布交互。
 *
 * 注意：遮罩是**新资产**（同视频截帧，落盘并登记到当前对话），不是批注；
 * 批注依旧只存内存。导出的路径只进反馈草稿，零自动发送、插件零外部请求。
 */

/** 原图像素上限：超过拒绝生成，避免超大图卡死前端（host 另有 24 MB 兜底）。 */
const MASK_MAX_PIXELS = 24000000

/** 归一化框选批注 → 原图像素矩形（clamp + 至少 1px，不越界）。 */
function maskPixelRect(annotation, width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const x = clamp01(annotation?.x)
  const y = clamp01(annotation?.y)
  let nw = clamp01(annotation?.w)
  let nh = clamp01(annotation?.h)
  if (nw > 0 && x + nw > 1) nw = 1 - x
  if (nh > 0 && y + nh > 1) nh = 1 - y
  const x0 = Math.min(w - 1, Math.max(0, Math.round(x * w)))
  const y0 = Math.min(h - 1, Math.max(0, Math.round(y * h)))
  const x1 = Math.min(w, Math.max(x0 + 1, Math.round((x + nw) * w)))
  const y1 = Math.min(h, Math.max(y0 + 1, Math.round((y + nh) * h)))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, width: w, height: h }
}

/** 单像素 alpha：框内 0（mask=1 待重绘），框外 255（mask=0 保留）。 */
function maskAlphaAt(px, py, rect) {
  const inside = px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h
  return inside ? 0 : 255
}

/* ------------------------------------------------------------------ *
 * v0.14.6 右键多点选区（老板 2026-11-12 拍板）：
 *   标记态下左键仍是矩形批注，右键逐点点击 4–20 个顶点，闭合成实心多边形。
 *   实测口径（见验证报告第九节）：必须是「实心、贴合目标外接框」的块，
 *   描笔画的镂空线框 / 椭圆 / 大矩形都会出白底；多边形天然实心且面积可量。
 * ------------------------------------------------------------------ */
const POLYGON_LIMITS = { min: 4, max: 20, closeRadius: 0.02, minArea: 0.0001 }

/* ------------------------------------------------------------------ *
 * 选区纯色半透明填充（v0.14.7 引入；老板 2026-11-12 20:22 再定版）：
 *   填充 0.4 / 轮廓 0.7，界面选区与「填充预览图」共用红 / 绿 / 蓝三色；
 *   导出的主 alpha 遮罩仍是「RGB 原图 + alpha 二值」，ComfyUI 链路一点不动。
 *   轮廓视觉宽度统一 1.5px：界面 SVG 用 non-scaling-stroke 直接画 1.5px；
 *   导出预览图按「DSH 缩到 200px 长边后仍留 1.5px」反推线宽 —— 固定 2px
 *   描边缩完会消失，过宽的边线又会糊住选区，两端共用同一个基准常量。
 * ------------------------------------------------------------------ */
const MASK_FILL_COLORS = Object.freeze({
  green: { rgb: [94, 214, 150], label: '绿' },
  red: { rgb: [239, 68, 68], label: '红' },
  blue: { rgb: [59, 130, 246], label: '蓝' },
})
const MASK_FILL_KEYS = Object.keys(MASK_FILL_COLORS)
const MASK_FILL_ALPHA = 0.4
const MASK_STROKE_ALPHA = 0.7
/** 轮廓视觉宽度基准（px）：界面直接画，导出预览图按缩略图比例反推。 */
const MASK_STROKE_PX = 1.5

/** 未知颜色一律回落绿色，避免脏值写进文件名 / 元数据。 */
function maskFillColor(key) {
  return Object.prototype.hasOwnProperty.call(MASK_FILL_COLORS, key)
    ? MASK_FILL_COLORS[key] : MASK_FILL_COLORS.green
}

function maskFillRgba(key, alpha = MASK_FILL_ALPHA) {
  const [r, g, b] = maskFillColor(key).rgb
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * 预览图轮廓线宽：以「DSH 缩略图长边 200px 时描边仍约 1.5px」反推，
 * 夹在 6–40px，避免小图线条消失、超大图线条糊成一片。纯函数，测试跑真身。
 */
function maskStrokeWidth(width, height) {
  const w = Math.max(1, Number(width) || 0)
  const h = Math.max(1, Number(height) || 0)
  const scale = Math.max(w, h) / 200
  return Math.max(6, Math.min(40, Math.round(MASK_STROKE_PX * scale)))
}

/** 预览层的填充 / 轮廓描述（纯函数，测试直接跑真身）：多边形优先，矩形回落。 */
function maskOverlayPath(rect, polygonPx, colorKey) {
  const hasPolygon = Array.isArray(polygonPx) && polygonPx.length >= 3
  return {
    key: Object.prototype.hasOwnProperty.call(MASK_FILL_COLORS, colorKey) ? colorKey : 'green',
    label: maskFillColor(colorKey).label,
    rgba: maskFillRgba(colorKey, MASK_FILL_ALPHA),
    strokeRgba: maskFillRgba(colorKey, MASK_STROKE_ALPHA),
    strokeWidth: maskStrokeWidth(rect?.width, rect?.height),
    points: hasPolygon ? polygonPx : null,
    rect: hasPolygon ? null : { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
  }
}

/** 顶点数组的归一外接框；points 既接受 [{x,y}] 也接受 [[x,y]]。 */
function polygonBBox(points) {
  const xs = points.map((p) => clamp01(Array.isArray(p) ? p[0] : p?.x))
  const ys = points.map((p) => clamp01(Array.isArray(p) ? p[1] : p?.y))
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  const x1 = Math.max(...xs)
  const y1 = Math.max(...ys)
  return { x: x0, y: y0, w: clamp01(x1 - x0), h: clamp01(y1 - y0) }
}

/** 鞋带公式：归一化面积，用来挡掉「点成一条线」的退化选区。 */
function polygonArea(points) {
  let sum = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = Array.isArray(points[i]) ? points[i][0] : points[i].x
    const yi = Array.isArray(points[i]) ? points[i][1] : points[i].y
    const xj = Array.isArray(points[j]) ? points[j][0] : points[j].x
    const yj = Array.isArray(points[j]) ? points[j][1] : points[j].y
    sum += (xj * yi) - (xi * yj)
  }
  return Math.abs(sum) / 2
}

/** 射线法（无 canvas 环境兜底，也用于离线断言钉死「多边形内 alpha=0」）。 */
function pointInPolygon(px, py, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i][0]
    const yi = points[i][1]
    const xj = points[j][0]
    const yj = points[j][1]
    const hit = ((yi > py) !== (yj > py))
      && (px < (((xj - xi) * (py - yi)) / (yj - yi)) + xi)
    if (hit) inside = !inside
  }
  return inside
}

/** 归一化顶点 → 原图像素顶点；点不合法或数量越界一律返回 null。 */
function normalizePolygon(value, width, height) {
  if (!Array.isArray(value) || value.length < POLYGON_LIMITS.min || value.length > POLYGON_LIMITS.max) return null
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const pts = []
  for (const p of value) {
    const nx = Number(Array.isArray(p) ? p[0] : p?.x)
    const ny = Number(Array.isArray(p) ? p[1] : p?.y)
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null
    pts.push([clamp01(nx) * w, clamp01(ny) * h])
  }
  return pts
}

/**
 * 多边形 → 全尺寸二值 alpha 层（0 = 待重绘，255 = 保留）。
 * 优先用离屏 canvas 填充（浏览器自动处理自交、抗锯齿与非零环绕），
 * 只在 bbox 子画布上读一次像素，避免全图再开一份 ImageData；
 * 读回后按 >127 强制二值，保持与 ComfyUI `MASK = 1 - alpha/255` 的实证契约一致。
 * Node / 无 canvas 环境退化为射线法，测试可直接跑真身。
 */
function polygonAlphaLayer(points, width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const out = new Uint8Array(w * h).fill(255)
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(Math.min(...xs))))
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(Math.min(...ys))))
  const x1 = Math.min(w, Math.max(x0 + 1, Math.ceil(Math.max(...xs))))
  const y1 = Math.min(h, Math.max(y0 + 1, Math.ceil(Math.max(...ys))))
  const bw = x1 - x0
  const bh = y1 - y0
  let ctx = null
  try {
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(bw, bh)
      ctx = canvas.getContext('2d', { willReadFrequently: true })
    } else if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = bw
      canvas.height = bh
      ctx = canvas.getContext('2d', { willReadFrequently: true })
    }
  } catch { ctx = null }
  if (ctx !== null) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, bw, bh)
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.moveTo(points[0][0] - x0, points[0][1] - y0)
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0] - x0, points[i][1] - y0)
    ctx.closePath()
    ctx.fill()
    const sub = ctx.getImageData(0, 0, bw, bh).data
    for (let py = 0; py < bh; py += 1) {
      for (let px = 0; px < bw; px += 1) {
        if (sub[((py * bw) + px) * 4] > 127) out[((py + y0) * w) + (px + x0)] = 0
      }
    }
  } else {
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        if (pointInPolygon(px + 0.5, py + 0.5, points)) out[(py * w) + px] = 0
      }
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * RGBA 主遮罩 PNG 编码器（v0.14.9 修复 canvas 预乘 alpha 丢 RGB）
 *
 * 本机实证：canvas 内部是预乘 alpha 存储，putImageData → convertToBlob 往返后，
 * alpha=0 的选区内 RGB 会被清零（区内均值差 147.39），而 ComfyUI
 * #369 LoadImageGoohai 的 IMAGE 输出需要原图 RGB。主遮罩必须直接从
 * 「RGB 原图 + 只改过 alpha」的 ImageData 编 PNG，一次也不回写 canvas。
 * ------------------------------------------------------------------ */

/** CRC-32（IEEE 802.3），PNG chunk 校验用。 */
function pngCrc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    c ^= bytes[i]
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC。 */
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, pngCrc32(out.subarray(4, 8 + data.length)))
  return out
}

/** ImageData → PNG 扫描线：每行前置 filter=0，RGBA 四通道原样搬运。 */
function pngScanlines(imageData, width, height) {
  const src = imageData.data
  const stride = width * 4
  const out = new Uint8Array((stride + 1) * height)
  let p = 0
  for (let y = 0; y < height; y += 1) {
    out[p] = 0
    p += 1
    out.set(src.subarray(y * stride, (y + 1) * stride), p)
    p += stride
  }
  return out
}

/** Adler-32，zlib 尾部校验。 */
function pngAdler32(bytes) {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** 拼接若干 Uint8Array。 */
function pngConcat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let p = 0
  for (const part of parts) { out.set(part, p); p += part.length }
  return out
}

/** zlib「stored」无压缩流，同步兜底（CompressionStream 不可用时）。 */
function pngZlibStored(bytes) {
  const parts = [new Uint8Array([0x78, 0x01])]
  let off = 0
  while (off < bytes.length) {
    const len = Math.min(65535, bytes.length - off)
    const last = off + len >= bytes.length ? 1 : 0
    const blk = new Uint8Array(5 + len)
    blk[0] = last
    blk[1] = len & 0xff
    blk[2] = (len >> 8) & 0xff
    blk[3] = (~len) & 0xff
    blk[4] = ((~len) >> 8) & 0xff
    blk.set(bytes.subarray(off, off + len), 5)
    parts.push(blk)
    off += len
  }
  const tail = new Uint8Array(4)
  new DataView(tail.buffer).setUint32(0, pngAdler32(bytes))
  parts.push(tail)
  return pngConcat(parts)
}

/**
 * ImageData → RGBA PNG 字节。优先 CompressionStream('deflate') 出标准 zlib 流，
 * 不可用则退回同步 stored 流；两条路都不经过 canvas，RGB 一像素不丢。
 */
async function encodeMaskPngBytes(imageData, width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const ihdr = new Uint8Array(13)
  const iv = new DataView(ihdr.buffer)
  iv.setUint32(0, w)
  iv.setUint32(4, h)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = pngScanlines(imageData, w, h)
  let idat = null
  if (typeof CompressionStream === 'function' && typeof Blob === 'function' && typeof Response === 'function') {
    try {
      const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))
      idat = new Uint8Array(await new Response(stream).arrayBuffer())
    } catch {
      idat = null
    }
  }
  if (idat === null) idat = pngZlibStored(raw)
  return pngConcat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}


    /** tab 类型的身份；也是正文与标题在 keyed slot 里的 key。 */