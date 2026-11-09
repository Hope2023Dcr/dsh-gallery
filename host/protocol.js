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
