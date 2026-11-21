/**
 * 原子写 + 残留清理（2026-11-19）
 *
 * 为什么单独抽出来：
 *   原先 context / feedback / marks / labels / frames 五个文件各写一遍
 *   「writeFile(tmp) → rename(tmp, file)」，五处都**没有失败清理**。
 *   2026-11-19 实测：~/.dsh 里积了 54 个 .tmp-* 文件、680 KB，
 *   最久的从 11-14 留到 11-19 —— 每次进程被杀 / rename 被占用就漏一个。
 *
 * 这里的纪律：
 *   · 写 tmp 或 rename 任一步失败，立刻删掉 tmp；
 *   · 删 tmp 本身失败也不能盖住原始错误（原始错误才是要报给调用方的）；
 *   · sweepStaleTmp 只在插件启动时跑一次，只清「本模块命名格式」的旧残留，
 *     且只清超过 1 小时的（避免误删正在写的）。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** tmp 文件名格式：<目标文件>.tmp-<pid>-<ts36>-<rand>；清洗时靠它识别 */
const TMP_RE = /\.tmp-\d+-[a-z0-9]+-[a-z0-9]+$/

/** 只清超过这个年龄的残留 */
const STALE_MS = 60 * 60 * 1000

function tmpNameFor(file) {
  return `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 原子写：写临时文件 → rename 覆盖。
 * 任一步失败都会尝试删掉临时文件，然后把原始错误抛出去。
 *
 * @param file - 目标绝对路径
 * @param content - 字符串（按 utf8 写）
 */
export async function writeFileAtomic(file, content) {
  const tmp = tmpNameFor(file)
  let wrote = false
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(tmp, content, 'utf8')
    wrote = true
    await fsp.rename(tmp, file)
    wrote = false // rename 成功，tmp 已不存在
  } catch (error) {
    if (wrote) {
      try { await fsp.rm(tmp, { force: true }) } catch { /* 删不掉也不能盖住原始错误 */ }
    }
    throw error
  }
}

/**
 * 清掉目录里「本模块命名格式」且已过期的残留 tmp。只扫一层，只清超龄的。
 * 供插件启动时调用一次，用来收拾历史泄漏（修复前留下的那批）。
 */
export async function sweepStaleTmp(dir) {
  const out = { scanned: 0, removed: 0 }
  let names
  try { names = await fsp.readdir(dir) } catch { return out }
  const now = Date.now()
  for (const name of names) {
    if (!TMP_RE.test(name)) continue
    out.scanned += 1
    const full = path.join(dir, name)
    try {
      const st = await fsp.stat(full)
      if (now - st.mtimeMs < STALE_MS) continue
      await fsp.unlink(full)
      out.removed += 1
    } catch { /* 单个失败不影响其它 */ }
  }
  return out
}
