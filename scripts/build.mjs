#!/usr/bin/env node
/**
 * 构建器 —— src/client 分片 → 唯一 client.js；src/shared/protocol.js → host/protocol.js
 *
 * 阶段说明：
 *   S0（v0.11.2）：src/ 尚不存在，产物即源码，本脚本只确认运行时产物齐全。
 *   S2（v0.12.0，已启用）：按 src/build-manifest.json 拼接 client.js、
 *       内联 styles.css、剥离 shared/protocol.js 的 export 注入 client、
 *       同时生成 host/protocol.js 供 Host 侧 import。
 *
 * 用法：
 *   node scripts/build.mjs
 *   node scripts/build.mjs --check   # 只读对比；产物与源码不一致 → 退出码 1
 *
 * 硬约束（DSH 加载器本机实证，见 docs/migration.md）：
 *   client.js 必须是单文件、单个 __ModuleLoader__.load、无 ESM import/export。
 *   因此这里只做字符串拼接，不引入 esbuild / vite / rollup 或任何第三方依赖。
 *
 * 注意：S2 分支是为后续阶段预留的框架，S0 阶段不会执行，也尚未做过端到端实测。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.includes('--check')
const MANIFEST = path.join(ROOT, 'src', 'build-manifest.json')

// S0 阶段必须存在的运行时产物（package.json files 的运行时子集）
const S0_ARTIFACTS = [
  'index.js', 'client.js', 'session-index.js', 'cordis.patch.yml',
  'locale/zh.json', 'locale/en.json', 'icon.svg',
]

const read = (p) => fs.readFileSync(p, 'utf8')
const equal = (a, b) => Buffer.from(a, 'utf8').equals(Buffer.from(b, 'utf8'))

/** S0：没有源码分片，产物即源码，什么都不写 */
function s0 () {
  const missing = S0_ARTIFACTS.filter((f) => !fs.existsSync(path.join(ROOT, f)))
  if (missing.length > 0) {
    console.error('✗ S0 运行时产物缺失：' + missing.join(', '))
    return 1
  }
  console.log(`✓ S0：无 src/build-manifest.json，产物即源码，无需构建（${S0_ARTIFACTS.length} 个运行时文件齐全）`)
  console.log('  本次未写入任何文件，发布产物保持 v0.11.2 原样。')
  return 0
}

/**
 * S2 起启用：按 manifest 顺序拼接分片。
 * manifest 形态（S2 创建时才生效）：
 * {
 *   "clientOutput": "client.js",
 *   "header": "// GENERATED ...",
 *   "fragments": ["src/client/00-head.js", "..."],
 *   "shared": "src/shared/protocol.js",
 *   "protocolOutput": "host/protocol.js",
 *   "sharedMarker": "<分片里的注入占位注释，默认值见下方 marker 常量>"
 * }
 */
function buildFromManifest () {
  const m = JSON.parse(read(MANIFEST))
  const marker = m.sharedMarker || '/*__SHARED_PROTOCOL__*/'
  const styleMarker = m.styleMarker || '/*__INLINE_STYLES__*/'
  const shared = m.shared ? read(path.join(ROOT, m.shared)) : ''
  const styles = m.styles ? read(path.join(ROOT, m.styles)) : ''

  // 多 shared 支持（S3-a）：sharedText 与 protocol 各自有注入占位与 Host 产物
  const sharedList = Array.isArray(m.sharedList) ? m.sharedList : []
  const loadedShared = sharedList.map((entry) => {
    const src = read(path.join(ROOT, entry.source))
    return {
      ...entry,
      source: src,
      // 注入 client 时必须剥 export（client 不允许顶层 ESM 语句）
      injectable: src.replace(/^export\s+/gm, ''),
    }
  })

  // shared/protocol.js 是 ESM，注入 client 时必须去掉 export 关键字，
  // 否则会违反「client.js 无顶层 import/export」的加载器约束。
  const injectable = shared.replace(/^export\s+/gm, '')

  const parts = []
  if (m.header) parts.push(m.header)
  if (!Array.isArray(m.fragments) || m.fragments.length === 0) {
    throw new Error('manifest.fragments 为空')
  }
  for (const frag of m.fragments) {
    const p = path.join(ROOT, frag)
    if (!fs.existsSync(p)) throw new Error('分片不存在：' + frag)
    let text = read(p)
    if (text.includes(marker)) {
      if (!shared) throw new Error(`${frag} 需要 shared 注入，但 manifest 未声明 shared`)
      text = text.replace(marker, injectable)
    }
    if (text.includes(styleMarker)) {
      if (!styles) throw new Error(`${frag} 需要 styles 注入，但 manifest 未声明 styles`)
      // CSS 里的反引号和 ${} 会破坏模板字符串，必须转义
      const escaped = styles.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
      text = text.replace(styleMarker, escaped)
    }
    for (const entry of loadedShared) {
      const mk = entry.marker || `/*__${String(entry.name || 'SHARED').toUpperCase()}__*/`
      if (text.includes(mk)) text = text.replace(mk, entry.injectable)
    }
    parts.push(text)
  }

  const outputs = [{ file: m.clientOutput || 'client.js', content: parts.join('\n') }]
  if (m.protocolOutput && shared) {
    outputs.push({
      file: m.protocolOutput,
      content: '// GENERATED from ' + m.shared + ' — 请勿手改\n' + shared,
    })
  }
  // 多 shared 的 Host 产物（S3-a 起）
  for (const entry of loadedShared) {
    if (entry.hostOutput === undefined) continue
    outputs.push({
      file: entry.hostOutput,
      content: '// GENERATED from ' + entry.source_path + ' — 请勿手改\n' + entry.source,
    })
  }

  const drift = []
  for (const o of outputs) {
    const target = path.join(ROOT, o.file)
    const current = fs.existsSync(target) ? read(target) : null
    if (current === null || !equal(current, o.content)) {
      drift.push(o.file)
      if (!CHECK_ONLY) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, o.content, 'utf8')
        console.log('  写入 ' + o.file)
      }
    }
  }

  if (CHECK_ONLY) {
    if (drift.length > 0) {
      console.error('✗ 产物与源码有漂移（忘了跑 build）：' + drift.join(', '))
      return 1
    }
    console.log('✓ 产物与源码逐字节一致（' + outputs.length + ' 个产物）')
    return 0
  }
  console.log(`✓ 构建完成：${drift.length} 个产物更新，${outputs.length - drift.length} 个无变化`)
  return 0
}

try {
  const rc = fs.existsSync(MANIFEST) ? buildFromManifest() : s0()
  process.exit(rc)
} catch (error) {
  console.error('✗ 构建失败：' + (error?.message ?? String(error)))
  process.exit(1)
}
