/**
 * 底层文件工具：路径越界、读文件头、图片尺寸、参数归一化。
 *
 * S1 拆分自 index.js（行为零变化）。
 */

import { promises as fsp, readFileSync, statSync, createReadStream } from 'node:fs'

export function numberOr(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

export function arrayOfStrings(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const cleaned = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
  return cleaned.length > 0 ? cleaned : [...fallback]
}

/** Windows 路径比较统一小写；用于「必须在根目录内」的判定。 */

export function isInside(root, target) {
  const a = root.toLowerCase().replace(/[\\/]+$/, '')
  const b = target.toLowerCase().replace(/[\\/]+$/, '')
  return b === a || b.startsWith(a + '\\') || b.startsWith(a + '/')
}

/** 只读图片头部若干字节，用于解析尺寸；失败返回 null。 */

export async function readHead(fullPath, byteLimit) {
  let handle
  try {
    handle = await fsp.open(fullPath, 'r')
    const size = (await handle.stat()).size
    const want = Math.min(byteLimit, size)
    const buffer = Buffer.alloc(want)
    const { bytesRead } = await handle.read(buffer, 0, want, 0)
    return buffer.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

/** PNG：IHDR 在固定偏移。 */

export function pngSize(buf) {
  if (buf.length < 24) return null
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** JPEG：顺序找 SOF 段。 */

export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let p = 2
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) {
      p += 1
      continue
    }
    let marker = buf[p + 1]
    while (marker === 0xff && p + 1 < buf.length) {
      p += 1
      marker = buf[p + 1]
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = buf.readUInt16BE(p + 2)
    if (length < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = buf.readUInt16BE(p + 5)
      const width = buf.readUInt16BE(p + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    p += 2 + length
  }
  return null
}

/** WebP：RIFF 容器，VP8 / VP8L / VP8X 三种尺寸布局。 */

export function webpSize(buf) {
  if (buf.length < 32) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') {
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8L') {
    const b0 = buf[21]
    const b1 = buf[22]
    const b2 = buf[23]
    const b3 = buf[24]
    const width = 1 + (((b0 & 0xff) | ((b1 & 0x3f) << 8)) & 0x3fff)
    const height = 1 + ((((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) & 0x3fff)
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8X') {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
    return width > 0 && height > 0 ? { width, height } : null
  }
  return null
}

/** 按扩展名挑选解析器；返回 {width,height} 或 null。 */

export function measureImage(buf, ext) {
  try {
    if (buf === null) return null
    if (ext === '.png') return pngSize(buf)
    if (ext === '.jpg' || ext === '.jpeg') return jpegSize(buf)
    if (ext === '.webp') return webpSize(buf)
    return pngSize(buf) ?? jpegSize(buf) ?? webpSize(buf)
  } catch {
    return null
  }
}

/**
 * 校验用户想设的产出根目录：必须是绝对路径、必须存在、必须是目录。
 * @param candidate - 用户输入的路径。
 * @returns { ok, root?, reason? } —— 通过时 root 是规范化后的绝对路径。
 */
