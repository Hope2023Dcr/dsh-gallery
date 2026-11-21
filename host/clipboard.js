/**
 * Windows 系统剪贴板「文件列表」（CF_HDROP / FileDropList）读写。
 *
 * 为什么需要：Chromium 的 paste 事件对「资源管理器里 Ctrl+C 的文件」**不给
 * file item**（浏览器安全限制，文件只能来自拖放或 <input type=file>），所以
 * 纯前端永远粘不到音视频 / DWG / ZIP 等任意文件。而 PowerShell 5.1 自带
 *   Get-Clipboard -Format FileDropList   /   Set-Clipboard -LiteralPath
 * 能直接读写系统剪贴板的文件列表，且不需要 Add-Type 动态编译 .NET。
 *
 * 编码约定（实测踩坑）：
 *   · 命令一律走 -EncodedCommand（UTF-16LE base64），避免命令行里的中文/引号被拆；
 *   · 路径列表经 **UTF-8 临时文件** 往返，绝不从 stdout 取中文路径
 *     （PowerShell 控制台默认 OEM/GBK 代码页，中文会乱码）；
 *   · 单次调用 9 秒超时，任何异常都降级为「插件内部剪贴板」，不让功能整体失败。
 *
 * 非 Windows 平台不调 PowerShell，直接使用内部剪贴板（复制→粘贴仍闭环）。
 */

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { bumpName } from './derive.js'

const PS_TIMEOUT_MS = 9000

/**
 * 系统剪贴板不可用时的进程内兜底；同一 DSH 实例下所有对话共享。
 * 带时间戳：只在写入后 10 分钟内有效，避免之后复制了纯文本却「幽灵粘贴」旧资产。
 */
const INTERNAL_TTL_MS = 10 * 60 * 1000
let internalClipboard = { paths: [], at: 0 }

/** PowerShell 单引号字符串字面量（单引号加倍即可转义）。 */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function encodedCommand(script) {
  // PowerShell -EncodedCommand 要求 UTF-16LE 的 base64
  return Buffer.from(script, 'utf16le').toString('base64')
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let settled = false
    let child
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-STA',
        '-EncodedCommand', encodedCommand(script),
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(reject, new Error('PowerShell 调用超时（9s）'))
    }, PS_TIMEOUT_MS)
    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.stderr?.on('data', (chunk) => { err += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish(reject, error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) finish(resolve, out)
      else finish(reject, new Error('PowerShell exit ' + code + ': ' + err.slice(-600)))
    })
  })
}

function tmpFile(tag) {
  return path.join(
    os.tmpdir(),
    'dsh-gallery-' + tag + '-' + process.pid + '-' +
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) + '.txt',
  )
}

/**
 * 读系统剪贴板里的文件绝对路径列表。
 * 剪贴板没有文件列表 / PowerShell 不可用时返回 []（不抛）。
 * @returns {Promise<string[]>}
 */
export async function readClipboardFilePaths() {
  if (process.platform !== 'win32') return []
  const outFile = tmpFile('clipread')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$items = @()',
    'try {',
    // 🔴 不能用 `Get-Clipboard | ForEach-Object`：cmdlet 把整个 List<PSObject>
    // 作为**单个**管道对象输出，[string] 转换会把多路径空格拼成一行。
    // 先接住集合再 foreach 逐项展开，才是真的多文件。
    '  $raw = Get-Clipboard -Format FileDropList -ErrorAction Stop',
    '  if ($null -ne $raw) { foreach ($x in $raw) { $items += [string]$x } }',
    '} catch { $items = @() }',
    '[System.IO.File]::WriteAllLines(' + psQuote(outFile) + ', [string[]]$items, (New-Object System.Text.UTF8Encoding($false)))',
  ].join('\n')
  try {
    await runPowerShell(script)
    const text = await fsp.readFile(outFile, 'utf8')
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '')
    return [...new Set(lines)]
  } catch {
    return []
  } finally {
    try { await fsp.rm(outFile, { force: true }) } catch { /* 忽略 */ }
  }
}

/**
 * 把文件绝对路径列表写入系统剪贴板（可在资源管理器 / 其它应用 Ctrl+V）。
 * 失败时退化为插件内部剪贴板，保证「复制 → 粘贴」仍然闭环。
 * @param {string[]} paths
 * @returns {Promise<{ ok: boolean, count: number, mode: string }>}
 */
export async function writeClipboardFilePaths(paths) {
  const cleaned = [...new Set((Array.isArray(paths) ? paths : [])
    .map((p) => String(p ?? '').trim()).filter((p) => p !== ''))]
  if (cleaned.length === 0) return { ok: false, count: 0, mode: 'none' }

  // 无论系统剪贴板是否成功，都写一份内部兜底
  internalClipboard = { paths: cleaned, at: Date.now() }
  if (process.platform !== 'win32') {
    return { ok: true, count: cleaned.length, mode: 'internal' }
  }

  const inFile = tmpFile('clipwrite')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$lines = @([System.IO.File]::ReadAllLines(' + psQuote(inFile) + ', [System.Text.Encoding]::UTF8) | Where-Object { $_ -ne \'\' })',
    "if ($lines.Count -eq 0) { exit 3 }",
    'Set-Clipboard -LiteralPath $lines -ErrorAction Stop',
    "Write-Output 'OK'",
  ].join('\n')
  try {
    await fsp.writeFile(inFile, cleaned.join('\n'), 'utf8')
    await runPowerShell(script)
    return { ok: true, count: cleaned.length, mode: 'system' }
  } catch {
    return { ok: true, count: cleaned.length, mode: 'internal' }
  } finally {
    try { await fsp.rm(inFile, { force: true }) } catch { /* 忽略 */ }
  }
}

/** 内部剪贴板（系统剪贴板读不到文件列表时的兜底，10 分钟内有效）。 */
export function internalClipboardPaths() {
  if (Date.now() - internalClipboard.at > INTERNAL_TTL_MS) return []
  return internalClipboard.paths.slice()
}

/**
 * 把剪贴板里的文件批量复制进目标目录（当前对话目录）。
 *
 * 口径与 http.js 的 `pasteFile` 单文件版完全一致：2GB 上限、只收文件、
 * 重名时 `<名>-n.<扩展名>` 自增（**绝不覆盖已有文件**）、返回 roots 相对路径。
 * 抽成独立模块是为了能用真实临时目录做端到端测试（http.js 的 op 路由不便直调）。
 *
 * @param {string[]} srcPaths 源文件绝对路径
 * @param {string} dir 目标目录（当前对话目录）
 * @param {string} root 扫描根目录，用于算 relPath；可为空
 * @returns {Promise<{ files: {name:string, absPath:string, relPath:string}[], failed: {path:string, message:string}[] }>}
 */
export async function pasteFilesIntoDir(srcPaths, dir, root = '') {
  const okFiles = []
  const failed = []
  try { await fsp.mkdir(dir, { recursive: true }) } catch { /* 下面 copyFile 会给真实错误 */ }
  const list = Array.isArray(srcPaths) ? srcPaths.slice(0, 200) : []
  for (const raw of list) {
    const srcAbs = path.resolve(String(raw ?? '').replace(/\\/g, '/'))
    try {
      const st = await fsp.stat(srcAbs)
      if (!st.isFile()) throw new Error('源路径不是文件')
      if (st.size > 2 * 1024 * 1024 * 1024) throw new Error('文件超过 2 GB，粘贴被拒绝')
      const base = path.basename(srcAbs).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim() || 'file'
      // 重名自增（与 http.js 内联的 uniqueName 同口径）
      let name = base
      let abs = path.join(dir, name)
      for (let n = 2; n <= 999; n += 1) {
        let exists = true
        try { await fsp.access(abs) } catch { exists = false }
        if (!exists) break
        name = bumpName(base, n)
        abs = path.join(dir, name)
      }
      await fsp.copyFile(srcAbs, abs)
      // 🔴 Windows 的 CopyFile 会**保留源文件 mtime**（Linux 不会）。画廊 global 视图按
      // mtime 时间窗过滤，保留旧 mtime 会让「刚粘进来的旧素材」在全局视图里根本看不到。
      // 粘贴语义是「现在进入本对话」，所以统一把落盘文件的时间戳刷成当前时间。
      try { const now = new Date(); await fsp.utimes(abs, now, now) } catch { /* 时间戳失败不影响粘贴 */ }
      const relPath = root === '' ? '' : path.relative(root, abs).split(path.sep).join('/')
      okFiles.push({ name, absPath: abs, relPath })
    } catch (error) {
      failed.push({ path: srcAbs, message: String(error?.message ?? error) })
    }
  }
  return { files: okFiles, failed }
}
