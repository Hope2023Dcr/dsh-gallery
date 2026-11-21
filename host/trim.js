/**
 * v0.16.0 音视频裁剪核心（从 host/http.js 抽出来，便于真机单测）。
 *
 * 关键事实（实测得出，别凭直觉改）：
 *   · `-c copy` 只能从**关键帧**起切。6 秒 25fps 的测试片切 1.5–4s，
 *     实际得到 0–4s（时长 4.0 而非 2.5）——起点被拉回到上一个关键帧。
 *   · 音频流通常每个包都可切，所以纯音频 copy 基本准确，问题集中在视频。
 *   · 因此策略是「先 copy，再用 ffprobe 量真实时长，偏差 > 0.5s 才重编码」：
 *     常见情况仍是秒级无损裁剪，少数少关键帧素材才付重编码代价。
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

const FFMPEG_CANDIDATES = [
  'G:/Program Files/ffmpeg/bin/ffmpeg.exe',
  'G:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe',
]

/** 找 ffmpeg；找不到返回 'ffmpeg'，交给 PATH 兜底。 */
export async function findFfmpeg() {
  for (const c of FFMPEG_CANDIDATES) {
    try {
      const abs = path.resolve(c)
      await fsp.access(abs, 0)
      return abs
    } catch { /* 换下一个 */ }
  }
  return 'ffmpeg'
}

/** 找同目录 ffprobe；找不到返回 null（退化为不做精度校验）。 */
export async function findFfprobe(ffmpeg) {
  const candidates = []
  if (typeof ffmpeg === 'string' && ffmpeg !== '' && ffmpeg !== 'ffmpeg') {
    const dir = path.dirname(ffmpeg)
    candidates.push(path.join(dir, 'ffprobe.exe'), path.join(dir, 'ffprobe'))
  }
  candidates.push('G:/Program Files/ffmpeg/bin/ffprobe.exe', 'G:/Program Files (x86)/ffmpeg/bin/ffprobe.exe')
  for (const c of candidates) {
    try { await fsp.access(c, 0); return c } catch { /* 换下一个 */ }
  }
  return null
}

/** 跑一次 ffmpeg；收集 stderr，非 0 退出视为失败。 */
export function runFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(ffmpeg, args, { windowsHide: true }) } catch (err) { reject(err); return }
    let stderr = ''
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-800)))
    })
  })
}

/** 读媒体时长（秒）；任何异常都返回 null，不抛。 */
export function probeDuration(ffprobe, file) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(ffprobe, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', file,
      ], { windowsHide: true })
    } catch { resolve(null); return }
    let out = ''
    child.stdout?.on('data', (d) => { out += String(d) })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) { resolve(null); return }
      const n = Number(String(out).trim())
      resolve(Number.isFinite(n) && n > 0 ? n : null)
    })
  })
}

const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'])

/** 精度兜底用的重编码参数（按输出容器选编码器，保证扩展名与流匹配）。 */
export function reencodeArgs(src, start, end, out, outExt, kind) {
  const base = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-to', String(end), '-i', src]
  const ext = String(outExt ?? '').toLowerCase()
  if (AUDIO_EXTS.has(ext) || kind === 'audio') {
    const codec = ext === 'wav' ? ['-c:a', 'pcm_s16le']
      : ext === 'flac' ? ['-c:a', 'flac']
        : (ext === 'ogg' || ext === 'opus') ? ['-c:a', 'libopus', '-b:a', '128k']
          : ext === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k']
            : ['-c:a', 'aac', '-b:a', '192k']
    return [...base, '-vn', ...codec, out]
  }
  if (ext === 'webm') {
    return [...base, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', out]
  }
  return [...base, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]
}

/**
 * 裁一段音视频并写进 `out`。
 *
 * @returns {{ mode: 'copy'|'reencode'|'copy-keyframe', duration: number|null }}
 *   - copy：流拷贝且时长与期望相符（最理想）
 *   - reencode：copy 偏差过大，已重编码到精确切点
 *   - copy-keyframe：copy 有偏差且重编码失败，保留了可用但不精确的片段
 */
export async function cropMediaFile({ ffmpeg, src, start, end, out, outExt, kind }) {
  const expected = end - start
  await runFfmpeg(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(start), '-to', String(end),
    '-i', src,
    '-c', 'copy', '-avoid_negative_ts', 'make_zero',
    out,
  ])

  const ffprobe = await findFfprobe(ffmpeg)
  if (ffprobe === null || !(expected > 0)) return { mode: 'copy', duration: null }

  const got = await probeDuration(ffprobe, out)
  if (got === null || Math.abs(got - expected) <= 0.5) return { mode: 'copy', duration: got }

  try {
    await runFfmpeg(ffmpeg, reencodeArgs(src, start, end, out, outExt, kind))
    const fixed = await probeDuration(ffprobe, out)
    return { mode: 'reencode', duration: fixed }
  } catch {
    return { mode: 'copy-keyframe', duration: got }
  }
}
