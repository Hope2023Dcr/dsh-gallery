/**
 * 视频截帧登记（v0.14.3）：独立文件 dsh-gallery-frames.json。
 *
 * 为什么需要它：
 *   画廊按「会话日志里出现过的资产路径」判断某个文件属于哪个对话。
 *   新截出来的 PNG 不可能出现在历史日志里，直接写进磁盘会被归到
 *   「历史资产」组，老板在当前对话里根本找不到，也就没法给它写反馈。
 *   这里只登记 { 文件 → 来源视频 / 帧时间 / 所属对话 }，不写宿主会话日志，
 *   扫描时据此把截帧挂回当前对话。
 *
 * 与 marks.json（反馈篮）、labels.json（手动标签）分开：
 *   · 帧归属是**文件身份**，不随清空反馈篮或改标签而消失；
 *   · 文件被删掉后留下孤儿记录无害（扫描只对存在的生效）。
 *
 * 数据形态：
 * {
 *   "schema": 1,
 *   "frames": {
 *     "<relPath>": {
 *       "sessionId": "...", "sessionTitle": "", "sessionCreatedAt": 0,
 *       "videoRelPath": "...", "videoName": "...", "frameMs": 60000,
 *       "timecode": "00-01-00-000", "savedAt": 1700000000000
 *     }
 *   }
 * }
 *
 * 键用 relPath（与 marks / labels 一致），文件被移动后不误命中。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

const FRAMES_FILENAME = 'dsh-gallery-frames.json'

/** 进程内写队列：把「读-改-写」串起来，避免连续截帧互相覆盖。 */
let writeChain = Promise.resolve()

function enqueue(fn) {
  const next = writeChain.then(fn, fn)
  writeChain = next.catch(() => {})
  return next
}

export function framesFilePath(settingsFile) {
  return path.join(path.dirname(settingsFile), FRAMES_FILENAME)
}

/** 读登记。文件不存在 / 格式坏都返回空对象，绝不抛错。 */
export async function readFrames(settingsFile) {
  try {
    const raw = await fsp.readFile(framesFilePath(settingsFile), 'utf8')
    const parsed = JSON.parse(raw)
    const frames = (parsed !== null && typeof parsed === 'object' &&
      typeof parsed.frames === 'object' && parsed.frames !== null) ? parsed.frames : {}
    return { schema: 1, frames }
  } catch {
    return { schema: 1, frames: {} }
  }
}

/** 原子写（tmp → rename），tmp 名带 pid + 随机数，并发不互踩。 */
async function writeFrames(settingsFile, frames) {
  const file = framesFilePath(settingsFile)
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(tmp, JSON.stringify({ schema: 1, frames: frames ?? {} }, null, 2))
  await fsp.rename(tmp, file)
}

/** 登记一帧（同 relPath 覆盖，避免重复截同一帧留下多条）。 */
export async function registerFrame(settingsFile, frame) {
  return enqueue(async () => {
    const current = await readFrames(settingsFile)
    const next = { ...current.frames, [String(frame.relPath)]: { ...frame, savedAt: Date.now() } }
    await writeFrames(settingsFile, next)
    return next
  })
}

/** 文件被删除后清掉登记，保持文件干净。 */
export async function deleteFrames(settingsFile, relPaths) {
  if (!Array.isArray(relPaths) || relPaths.length === 0) return {}
  return enqueue(async () => {
    const current = await readFrames(settingsFile)
    const next = { ...current.frames }
    for (const p of relPaths) delete next[String(p)]
    await writeFrames(settingsFile, next)
    return next
  })
}

/**
 * 帧时间码：HH-MM-SS-mmm。
 * 用「-」而不是「:」，Windows 文件名不允许冒号；精确到毫秒，
 * 同一秒内连截多帧也能分清先后。
 */
export function frameTimecode(frameMs) {
  const total = Math.max(0, Math.round(Number(frameMs) || 0))
  const hh = String(Math.floor(total / 3600000)).padStart(2, '0')
  const mm = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0')
  const ss = String(Math.floor((total % 60000) / 1000)).padStart(2, '0')
  const ms = String(total % 1000).padStart(3, '0')
  return `${hh}-${mm}-${ss}-${ms}`
}

/**
 * 截帧文件名：`<视频名>_帧_<时间码>.png`。
 * 例：`卖斋翁_EP01_这是救命钱_帧_00-01-00-500.png`
 * 视频名里 Windows 不允许的字符一律换掉，并限长避免超长路径。
 */
export function makeFrameName(videoName, frameMs, suffix = '') {
  const raw = String(videoName ?? 'video').replace(/\.[^.]+$/, '')
  const safe = raw.replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video'
  return `${safe}_帧_${frameTimecode(frameMs)}${suffix}.png`
}

/**
 * 遮罩文件名（v0.14.5）：`<原图名>_遮罩_x<左>-y<上>-w<宽>-h<高>.png`。
 * 坐标用归一化百分比整数，肉眼就能看出框选位置；同框重复导出加 -2 / -3，不覆盖旧遮罩。
 * 复用 frames.json 登记（kind:'mask'），扫描时据此把遮罩挂回产出它的当前对话。
 */
export function makeMaskName(imageName, region, suffix = '') {
  const raw = String(imageName ?? 'image').replace(/\.[^.]+$/, '')
  const safe = raw.replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'image'
  const pct = (v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return 0
    return Math.round(Math.min(1, Math.max(0, n)) * 100)
  }
  const r = region ?? {}
  return `${safe}_遮罩_x${pct(r.x)}-y${pct(r.y)}-w${pct(r.w)}-h${pct(r.h)}${suffix}.png`
}

/**
 * 多边形遮罩元数据（v0.14.6）：校验归一化顶点（4–20 点），换算成原图像素坐标，
 * 并给出外接框与选区面积。老板要的「记录这个区域在图片的准确位置」就落在这里——
 * 像素坐标只在 Host 侧按原图真实尺寸计算，前端显示的百分比不作为准。
 * 返回 null 表示不合法，调用方直接 400，绝不把脏坐标写进 frames.json。
 */
export function maskPolygonMeta(polygon, width, height) {
  if (!Array.isArray(polygon) || polygon.length < 4 || polygon.length > 20) return null
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const pts = []
  for (const p of polygon) {
    const nx = Number(Array.isArray(p) ? p[0] : p?.x)
    const ny = Number(Array.isArray(p) ? p[1] : p?.y)
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null
    pts.push([Math.round(nx * w), Math.round(ny * h)])
  }
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  // 右/下用开区间（与 PIL getbbox 一致），草稿里 (x0,y0)-(x1,y1) 才不会少算一列/一行。
  const bboxPx = [
    Math.min(...xs), Math.min(...ys),
    Math.min(w, Math.max(...xs) + 1), Math.min(h, Math.max(...ys) + 1),
  ]
  let sum = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    sum += (pts[j][0] * pts[i][1]) - (pts[i][0] * pts[j][1])
  }
  return {
    polygon: polygon.map((p) => [
      Number(Array.isArray(p) ? p[0] : p.x),
      Number(Array.isArray(p) ? p[1] : p.y),
    ]),
    polygonPx: pts,
    bboxPx,
    areaPx: Math.round(Math.abs(sum) / 2),
    imageWidth: w,
    imageHeight: h,
  }
}
