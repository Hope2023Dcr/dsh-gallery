/**
 * 媒体支撑：路径解析、HTTP Range、流式下发、MIME。
 *
 * S1 拆分自 index.js（行为零变化）。
 */

import { promises as fsp, readFileSync, statSync, createReadStream } from 'node:fs'
import path from 'node:path'
import { isInside } from './fsutil.js'

export async function resolveReadable(roots, relPath, opts, byteCap) {
  const list = Array.isArray(roots) ? roots : [roots]
  if (typeof relPath !== 'string' || relPath === '') return null
  const cap = typeof byteCap === 'number' && byteCap > 0 ? byteCap : opts.maxImageBytes
  const normalized = relPath.replace(/\\/g, '/')
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) return null
  for (const root of list) {
    const absolute = path.resolve(root, ...normalized.split('/'))
    if (!isInside(root, absolute)) continue
    try {
      const stat = await fsp.stat(absolute)
      if (!stat.isFile() || stat.size <= 0 || stat.size > cap) continue
      return { absolute, stat, root }
    } catch {
      // 换下一个 root
    }
  }
  return null
}

/**
 * 解析 `Range: bytes=...` 头。
 * 支持：常规 (0-99)、开放 (100-)、后缀 (-50)、不可满足 (416)。
 * 多区间取第一个（HTTP 规范允许）。
 */

export function parseMediaRange(raw, size) {
  if (raw === undefined) return null
  const m = /^bytes=(.+)$/i.exec(String(raw).trim())
  if (!m) return null
  const spec = m[1].split(',')[0].trim()
  if (spec === '') return null
  if (spec.startsWith('-')) {
    const suffix = Number(spec.slice(1))
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    if (suffix >= size) return { start: 0, end: size - 1 }
    return { start: size - suffix, end: size - 1 }
  }
  const dash = spec.indexOf('-')
  if (dash === -1) return null
  const startText = spec.slice(0, dash)
  const endText = spec.slice(dash + 1)
  const start = startText === '' ? 0 : Number(startText)
  const end = endText === '' ? size - 1 : Number(endText)
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end)) return null
  if (start >= size) return { unsatisfiable: true }
  return { start, end: Math.min(end, size - 1) }
}

/**
 * 用 Node 原生 res 输出一个媒体文件，支持 HTTP Range。
 * 这是 206 能工作的关键：req/res 直写，不经过 DSH 的 fetch 网关。
 */

export function serveMedia(req, res, filePath, size, type) {
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  }
  const range = parseMediaRange(req.headers.range, size)

  if (range !== null && range.unsatisfiable === true) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
    res.end()
    return
  }

  if (range !== null) {
    const { start, end } = range
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    })
    if (req.method === 'HEAD') { res.end(); return }
    const stream = createReadStream(filePath, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }

  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(filePath)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

export function contentTypeFor(ext) {
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  // 音视频（v0.10.1）：让浏览器 <video>/<audio> 能直接解码
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.ogv') return 'video/ogg'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.mkv') return 'video/x-matroska'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a' || ext === '.aac') return 'audio/mp4'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg'
  if (ext === '.opus') return 'audio/opus'
  return 'application/octet-stream'
}

/** 统一 JSON 响应。 */
