/**
 * v0.16.0 派生资产相关的纯函数（无副作用、可单测）。
 * 粘贴 / 裁剪产出的文件名与 PNG 校验都走这里，避免逻辑散落。
 */

/**
 * 派生资产命名：`<前缀>_<时间戳>[-n].<ext>`。
 * 时间戳用本地可读串（非冒号，避免 Windows 文件名非法），重复时加 -n 由调用方决定。
 * @param {string} prefix 前缀（如「粘贴」「裁剪-原图名」）
 * @param {string} ext 扩展名（不含点）
 * @param {string} suffix 重名后缀（如 `-2`）
 */
export function makeDerivedName(prefix, ext, suffix = '') {
  const safe = String(prefix).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'asset'
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const e = String(ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6) || 'png'
  return `${safe}_${ts}${suffix}.${e}`
}

/**
 * 文件名重名时的自增：在 stem 后追加 `-2 / -3 …`，保留扩展名。
 * @param {string} base 原始文件名
 * @param {number} n 自增序号（>=2）
 */
export function bumpName(base, n) {
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  return `${stem}-${n}${ext}`
}

/**
 * 原子写用的临时路径：**必须保留扩展名**。
 *
 * 🔴 ffmpeg 靠扩展名推断输出容器。写成 `xxx.mp4.tmp-123` 会直接报
 * "Unable to choose an output format" → HTTP 500（2026-11-13 12:15 真机实测，
 * 视频和音频同时失败）。随机串必须放在扩展名**之前**：`xxx.tmp-123.mp4`。
 *
 * @param {string} abs 最终绝对路径
 * @param {string} tag 区分并发的标记（默认 pid-时间戳）
 */
export function tmpPathFor(abs, tag = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`) {
  const s = String(abs)
  const dot = s.lastIndexOf('.')
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  // 点必须在最后一个路径分隔符之后才算扩展名，否则目录名里的点会误判
  if (dot <= slash + 1) return `${s}.tmp-${tag}`
  return `${s.slice(0, dot)}.tmp-${tag}${s.slice(dot)}`
}

/**
 * PNG 合法性校验 + base64 解码；非法（空 / 超 24MB / 非 PNG 魔数）返回 null。
 * @param {string} data base64 字符串
 */
export function pngBufferFrom(data) {
  const buf = Buffer.from(data, 'base64')
  if (buf.length < 8 || buf.length > 24 * 1024 * 1024) return null
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return null
  return buf
}
/**
 * 放宽版：识别常见图片魔数，返回 `{ buf, ext }`；非法返回 null。
 *
 * 为什么需要它（2026-11-15 老板实测）：剪贴板位图不一定是 PNG —— 浏览器 /
 * 微信 / 画图工具复制的常是 JPEG，从资源管理器复制的 JPG 文件也可能是 JPEG。
 * 只认 PNG 会让这些图全部报「非 PNG」，素材根本进不来。扩展名以**真实魔数**为准，
 * 不信任前端传的 ext（避免「png 扩展名 + jpeg 内容」这种坏文件）。
 *
 * 裁剪（cropImage）仍走 pngBufferFrom：那是前端 canvas 转出来的，必然是 PNG。
 * @param {string} data base64 字符串
 */
export function imageBufferFrom(data) {
  const buf = Buffer.from(data, 'base64')
  if (buf.length < 8 || buf.length > 24 * 1024 * 1024) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { buf, ext: 'png' }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { buf, ext: 'jpg' }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { buf, ext: 'webp' }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { buf, ext: 'gif' }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return { buf, ext: 'bmp' }
  return null
}
