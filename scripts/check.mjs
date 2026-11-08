#!/usr/bin/env node
/**
 * 本地校验器 —— 提交 / 发版前跑一遍，挡住会坑到真实用户的问题
 *
 * 用法：
 *   node scripts/check.mjs              # 全部静态检查 + 契约测试 + install --dry-run
 *   node scripts/check.mjs --install    # 额外做一次临时目录里的真实安装实测
 *
 * 为什么不是 GitHub Actions：本仓库的细粒度 token 没有 Workflows 写入权限，
 * 所以 CI 逻辑落在本地脚本里，check.sh 是薄包装，CONTRIBUTING.md 的用法不变。
 *
 * 阶段说明：S0 启用 13 项；分片顺序 / seam schema / marks 原子写等 3 项
 * 随 S2 / S3 落地后启用，当前以 SKIP 显式列出，不假装通过。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WITH_INSTALL = process.argv.includes('--install')
const results = []
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(ROOT, p))

function ok (name, detail) { results.push({ state: 'PASS', name, detail }) }
function bad (name, detail) { results.push({ state: 'FAIL', name, detail }) }
function skip (name, detail) { results.push({ state: 'SKIP', name, detail }) }
function check (name, fn) {
  try {
    const detail = fn()
    ok(name, detail || '')
  } catch (error) {
    bad(name, error?.message ?? String(error))
  }
}
function assert (cond, msg) { if (!cond) throw new Error(msg) }
function run (args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', ...opts,
  })
}
/** 显式枚举测试文件：不依赖 Node 22 的 glob，也不依赖 shell 展开（engines 声明 >=20） */
function findTests (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) findTests(p, out)
    else if (/\.test\.(m?js)$/.test(e.name)) out.push(path.relative(ROOT, p).replace(/\\/g, '/'))
  }
  return out
}

// ---------- 1. 构建产物无漂移 ----------
check('01 构建产物与源码无漂移', () => {
  const r = run(['scripts/build.mjs', '--check'])
  assert(r.status === 0, (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' '))
  return 'scripts/build.mjs --check 通过'
})

// ---------- 2. 语法 ----------
check('02 JS / MJS 语法', () => {
  const files = [
    'index.js', 'client.js', 'session-index.js', 'install.mjs', 'publish.mjs',
    'scripts/build.mjs', 'scripts/check.mjs',
  ]
  for (const f of files) {
    const r = run(['--check', f])
    assert(r.status === 0, `${f}: ${(r.stderr || '').trim().split('\n')[0]}`)
  }
  return `${files.length} 个文件 node --check 通过`
})

// ---------- 3. package.json ----------
check('03 package.json 必填字段', () => {
  const p = JSON.parse(read('package.json'))
  for (const k of ['name', 'version', 'type', 'exports', 'files', 'dsh']) {
    assert(p[k] !== undefined, '缺少字段 ' + k)
  }
  assert(p.dsh?.bundle?.patch, 'dsh.bundle.patch 缺失')
  assert(p.dsh?.client, 'dsh.client 缺失')
  assert(/^\d+\.\d+\.\d+/.test(p.version), 'version 格式异常')
  return `version = ${p.version}`
})

// ---------- 4. cordis.patch.yml 顶层结构（最高优先级） ----------
check('04 cordis.patch.yml 顶层是数组', () => {
  const text = read('cordis.patch.yml')
  const first = text.split(/\r?\n/).map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  assert(first?.startsWith('-'), `首有效行应为 "- insert:"，实际是 "${first}"`)
  assert(/name:\s*'dsh-gallery'/.test(text), "条目 name 不是 'dsh-gallery'")
  return '顶层数组 + name 正确'
})

// ---------- 5. locale ----------
check('05 locale 合法 JSON', () => {
  for (const f of ['locale/zh.json', 'locale/en.json']) {
    const j = JSON.parse(read(f))
    assert(j.meta?.title, `${f} 缺 meta.title`)
  }
  return 'zh / en 均含 meta.title'
})

// ---------- 6. exports 与 files 对齐磁盘 ----------
check('06 exports / files 与实际文件对齐', () => {
  const p = JSON.parse(read('package.json'))
  for (const [key, target] of Object.entries(p.exports)) {
    if (target.includes('*')) continue
    assert(exists(target.replace(/^\.\//, '')), `exports["${key}"] → ${target} 不存在`)
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let exact = 0
  for (const raw of p.files) {
    if (!raw.includes('*')) {
      assert(exists(raw), `files 声明的 ${raw} 不存在`)
      exact++
      continue
    }
    const slash = raw.lastIndexOf('/')
    const dir = slash >= 0 ? raw.slice(0, slash) : ''
    const base = slash >= 0 ? raw.slice(slash + 1) : raw
    if (!exists(dir)) continue // S1 之前的 host/ 等未启用目录
    const re = new RegExp('^' + base.split('*').map(escapeRe).join('.*') + '$')
    const hits = fs.readdirSync(path.join(ROOT, dir)).filter((n) => re.test(n))
    assert(hits.length > 0, `files 通配 ${raw} 没有命中任何文件`)
  }
  return `${Object.keys(p.exports).length} 个 exports + ${p.files.length} 条 files 已核对（${exact} 个精确项）`
})

// ---------- 7. 零第三方运行时依赖 ----------
check('07 零运行时依赖', () => {
  const p = JSON.parse(read('package.json'))
  assert(!p.dependencies || Object.keys(p.dependencies).length === 0, '存在 dependencies')
  assert(!p.peerDependencies || Object.keys(p.peerDependencies).length === 0, '存在 peerDependencies')
  return '无 dependencies / peerDependencies'
})

// ---------- 8. 无硬编码盘符 ----------
check('08 无硬编码盘符路径', () => {
  const files = ['index.js', 'client.js', 'session-index.js', 'install.mjs', 'scripts/build.mjs']
  const hits = []
  for (const f of files) {
    read(f).split(/\r?\n/).forEach((line, i) => {
      const t = line.trim()
      if (/^(\/\/|\*|#|<!--)/.test(t)) return
      if (/[`'"]([A-Za-z]:[\\/][^`'"]*)[`'"]/.test(line) || /^[A-Za-z]:[\\/]/.test(t)) {
        hits.push(`${f}:${i + 1}`)
      }
    })
  }
  assert(hits.length === 0, '疑似本机绝对路径：' + hits.slice(0, 5).join(', '))
  return `${files.length} 个文件扫描通过`
})

// ---------- 9. 无外网请求 ----------
check('09 零外网请求', () => {
  const files = ['index.js', 'client.js', 'session-index.js']
  const allow = ['http://dsh.internal']
  const hits = []
  for (const f of files) {
    read(f).split(/\r?\n/).forEach((line, i) => {
      const t = line.trim()
      if (/^(\/\/|\*|#|<!--)/.test(t)) return
      const urls = line.match(/https?:\/\/[^\s'"`，)）]+/g) || []
      for (const u of urls) {
        if (!allow.some((a) => u.startsWith(a))) hits.push(`${f}:${i + 1} ${u}`)
      }
    })
  }
  assert(hits.length === 0, '发现外部 URL：' + hits.slice(0, 5).join(' | '))
  return `仅允许 ${allow.join(', ')}（URL 解析 base，非网络请求）`
})

// ---------- 10. client 单入口约束 ----------
check('10 client.js 单入口且无 ESM 语句', () => {
  const text = read('client.js')
  const loads = (text.match(/__ModuleLoader__\.load\s*\(/g) || []).length
  assert(loads === 1, `__ModuleLoader__.load 出现 ${loads} 次，应为 1 次`)
  const esm = text.split(/\r?\n/)
    .filter((l) => /^\s*(import|export)\s/.test(l) && !/^\s*(\/\/|\*)/.test(l))
  assert(esm.length === 0, '出现顶层 import/export：' + esm.slice(0, 2).join(' '))
  return `1 个 load，0 条 ESM 语句（${text.split(/\r?\n/).length} 行）`
})

// ---------- 11. Host 相对依赖齐全 ----------
check('11 Host 相对引用存在', () => {
  const text = read('index.js')
  const refs = [...text.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map((m) => m[1])
  for (const r of new Set(refs)) {
    assert(exists(r.replace(/^\.\//, '')), `index.js 引用 ${r} 但文件不存在`)
  }
  return `${new Set(refs).size} 个相对引用齐全`
})

// ---------- 12. install 已白名单化 ----------
check('12 install.mjs 按白名单复制', () => {
  const text = read('install.mjs')
  assert(text.includes('collectFromWhitelist'), '未找到白名单展开函数')
  assert(!text.includes('copy(here, targetDir)'), '仍在使用整目录递归复制')
  assert(text.includes('session-index.js'), 'REQUIRED 未包含 session-index.js')
  return '无递归复制，必需项含 session-index.js'
})

// ---------- 13. install --dry-run ----------
check('13 install --dry-run 输出白名单', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gallery-check-'))
  try {
    fs.mkdirSync(path.join(tmp, 'profiles', 'desktop'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'profiles', 'desktop', 'package.json'), '{"name":"fake","bundles":[]}\n')
    const r = run(['install.mjs', '--dry-run'], { env: { ...process.env, DSH_HOME: tmp } })
    assert(r.status === 0, (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' '))
    assert(r.stdout.includes('未做任何修改'), 'dry-run 未声明零写入')
    assert(!r.stdout.includes('src/') && !r.stdout.includes('scripts/'), '清单里出现开发目录')
    return '零写入，清单不含 src/ 与 scripts/'
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------- 14. 契约测试 ----------
check('14 node --test 契约测试', () => {
  if (!exists('tests')) return 'tests/ 尚未建立（S1 补齐）'
  const files = findTests(path.join(ROOT, 'tests'))
  assert(files.length > 0, 'tests/ 下没有 .test.mjs')
  const r = run(['--test', ...files])
  assert(r.status === 0, (r.stdout + r.stderr).trim().split('\n').slice(-6).join(' '))
  const pass = (r.stdout.match(/^# pass\s+(\d+)/m) || [])[1] || '?'
  return `${files.length} 个文件 / ${pass} 个用例通过`
})

// ---------- 15. 真实安装实测（可选） ----------
if (WITH_INSTALL) {
  check('15 临时 DSH_HOME 真实安装', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gallery-install-'))
    try {
      fs.mkdirSync(path.join(tmp, 'profiles', 'desktop'), { recursive: true })
      fs.writeFileSync(path.join(tmp, 'profiles', 'desktop', 'package.json'), '{"name":"fake","bundles":[]}\n')
      const r = run(['install.mjs'], { env: { ...process.env, DSH_HOME: tmp } })
      assert(r.status === 0, (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' '))
      const target = path.join(tmp, 'profiles', 'desktop', 'node_modules', 'dsh-gallery')
      const p = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
      for (const f of p.files.filter((x) => !x.includes('*'))) {
        assert(fs.existsSync(path.join(target, f)), `安装后缺文件 ${f}`)
      }
      assert(fs.existsSync(path.join(target, 'locale', 'zh.json')), '安装后缺 locale/zh.json')
      assert(!fs.existsSync(path.join(target, 'scripts')), 'scripts/ 被误装进用户机器')
      assert(!fs.existsSync(path.join(target, 'src')), 'src/ 被误装进用户机器')
      const prof = JSON.parse(fs.readFileSync(path.join(tmp, 'profiles', 'desktop', 'package.json'), 'utf8'))
      assert(prof.bundles.includes('dsh-gallery'), 'bundle 未注册')
      const n = fs.readdirSync(target).length
      return `${n} 个顶层条目，bundle 已注册，开发目录未混入`
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
} else {
  skip('15 真实安装实测', '加 --install 或 ./check.sh --install 启用')
}

// ---------- 后续阶段才启用的检查（显式列出，不假装通过） ----------
// ---------- 16 分片顺序 / shared 常量一致（S2 已启用） ----------
{
  const ROOT0 = ROOT
  const manifestPath = path.join(ROOT0, 'src', 'build-manifest.json')
  if (!fs.existsSync(manifestPath)) {
    skip('16 分片标记顺序 / shared 常量一致', 'src/build-manifest.json 不存在（S2 未落地）')
  } else {
    const problems = []
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    // 16a：分片顺序符合依赖方向（数字前缀必须递增）
    const order = m.fragments.map((f) => path.basename(f).slice(0, 2))
    const numeric = order.map((n) => Number(n))
    for (let i = 1; i < numeric.length; i++) {
      if (!Number.isFinite(numeric[i]) || numeric[i] <= numeric[i - 1]) {
        problems.push(`分片前缀非递增：${order[i - 1]} -> ${order[i]}`)
      }
    }

    // 16b：每个分片文件都存在
    for (const frag of m.fragments) {
      if (!fs.existsSync(path.join(ROOT0, frag))) problems.push(`分片缺失：${frag}`)
    }

    // 16c：shared 常量在 client 产物与 host 产物里值一致
    const sharedPath = path.join(ROOT0, m.shared)
    if (!fs.existsSync(sharedPath)) {
      problems.push(`shared 源不存在：${m.shared}`)
    } else {
      const sharedSrc = fs.readFileSync(sharedPath, 'utf8')
      const consts = [...sharedSrc.matchAll(/export const (\w+) = ([^\n]+)/g)]
        .map((x) => ({ name: x[1], value: x[2].trim() }))
      const clientOut = path.join(ROOT0, m.clientOutput || 'client.js')
      const hostOut = path.join(ROOT0, m.protocolOutput || 'host/protocol.js')
      const clientTxt = fs.existsSync(clientOut) ? fs.readFileSync(clientOut, 'utf8') : ''
      const hostTxt = fs.existsSync(hostOut) ? fs.readFileSync(hostOut, 'utf8') : ''

      for (const c of consts) {
        // client 里应是 `const X = ...`（无 export）
        const inClient = new RegExp(`const ${c.name} = ${c.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
        const inHost = new RegExp(`export const ${c.name} = ${c.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
        if (!inClient.test(clientTxt)) problems.push(`client.js 缺 shared 常量 ${c.name}`)
        if (!inHost.test(hostTxt)) problems.push(`host/protocol.js 缺 ${c.name}`)
      }
      // 16d：client 产物里不应残留 shared 占位符
      if (clientTxt.includes(m.sharedMarker || '/*__SHARED_PROTOCOL__*/')) {
        problems.push('client.js 残留 shared 占位符')
      }
      const styleMarker = m.styleMarker || '/*__INLINE_STYLES__*/'
      if (clientTxt.includes(styleMarker)) problems.push('client.js 残留 styles 占位符')
    }

    if (problems.length > 0) {
      bad('16 分片标记顺序 / shared 常量一致', problems.slice(0, 3).join('；'))
    } else {
      ok('16 分片标记顺序 / shared 常量一致',
        `${m.fragments.length} 分片顺序正确，shared 常量已注入 client 与 host`)
    }
  }
}
// ---------- 17 seam schema 版本一致（S3-a 已启用） ----------
{
  const problems = []
  // 17a：client 产物里要有 seam 安装 + version: 1
  const clientPath = path.join(ROOT, 'client.js')
  if (!fs.existsSync(clientPath)) {
    bad('17 seam schema 版本一致', 'client.js 不存在')
  } else {
    const clientTxt = fs.readFileSync(clientPath, 'utf8')
    if (!clientTxt.includes('dshGallerySeam')) problems.push('client.js 缺 window.dshGallerySeam')
    if (!clientTxt.includes('installSeam')) problems.push('client.js 缺 installSeam()')
    // seam 对象里必须有 version: 1
    if (!/version\s*:\s*1/.test(clientTxt)) problems.push('seam 缺 version: 1')

    // 17b：shared 契约的 SCHEMA 必须与 seam version 一致（都是 1）
    const sharedPath = path.join(ROOT, 'src', 'shared', 'feedback-text.js')
    let sharedTxt = ''
    if (!fs.existsSync(sharedPath)) {
      problems.push('缺 src/shared/feedback-text.js')
    } else {
      sharedTxt = fs.readFileSync(sharedPath, 'utf8')
      const m = sharedTxt.match(/export const SCHEMA = (\d+)/)
      if (!m) problems.push('feedback-text.js 缺 SCHEMA 常量')
      else if (m[1] !== '1') problems.push(`SCHEMA 应为 1，实际 ${m[1]}`)
    }

    // 17c：Host 产物 feedback-text.js 必须由 build 生成且含 SCHEMA
    const hostFt = path.join(ROOT, 'host', 'feedback-text.js')
    if (!fs.existsSync(hostFt)) problems.push('缺 host/feedback-text.js（构建产物）')
    else if (!fs.readFileSync(hostFt, 'utf8').includes('SCHEMA')) {
      problems.push('host/feedback-text.js 缺 SCHEMA')
    }

    // 17d：契约里的 action 枚举与 Host marks 的 MARK_ACTIONS 一致
    const marksPath = path.join(ROOT, 'host', 'marks.js')
    if (!fs.existsSync(marksPath)) problems.push('缺 host/marks.js')
    else {
      const marksTxt = fs.readFileSync(marksPath, 'utf8')
      const sharedActions = (() => {
        if (sharedTxt === '') return []
        const mm = sharedTxt.match(/export const ACTIONS = \[([\s\S]*?)\]/)
        if (!mm) return []
        return [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
      })()
      const hostActions = (() => {
        const mm = marksTxt.match(/export const MARK_ACTIONS = \[([\s\S]*?)\]/)
        if (!mm) return []
        return [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
      })()
      for (const a of sharedActions) {
        if (!hostActions.includes(a)) problems.push(`marks.js 缺 action: ${a}`)
      }
    }
  }

  if (problems.length > 0) bad('17 seam schema 版本一致', problems.slice(0, 3).join('；'))
  else ok('17 seam schema 版本一致', 'seam version=1，SCHEMA=1，action 枚举双端一致')
}
// ---------- 18 marks 原子写（S3-a 已启用） ----------
{
  const problems = []
  const marksPath = path.join(ROOT, 'host', 'marks.js')
  if (!fs.existsSync(marksPath)) {
    bad('18 marks 原子写（tmp → rename）', '缺 host/marks.js')
  } else {
    const txt = fs.readFileSync(marksPath, 'utf8')
    // 18a：必须是 tmp → rename 模式
    if (!/writeMarks/.test(txt)) problems.push('缺 writeMarks')
    if (!/tmp-/.test(txt) && !/.tmp/.test(txt)) problems.push('写盘未用 tmp 文件')
    if (!/\.rename|rename\(/.test(txt)) problems.push('写盘未用 rename 原子替换')
    // 18b：marks 必须是独立文件（不能写回 settings 同一文件）
    if (!/dsh-gallery-marks\.json/.test(txt)) problems.push('marks 未使用独立文件 dsh-gallery-marks.json')
    // 18c：settings.js 的写盘也要原子
    const settingsPath = path.join(ROOT, 'host', 'settings.js')
    if (!fs.existsSync(settingsPath)) problems.push('缺 host/settings.js')
    else {
      const st = fs.readFileSync(settingsPath, 'utf8')
      const wf = st.match(/export async function writeSettingsFile[\s\S]*?\n}/)
      if (!wf) problems.push('settings.js 缺 writeSettingsFile')
      else {
        if (!/\.tmp/.test(wf[0]) && !/tmp-/.test(wf[0])) problems.push('writeSettingsFile 未用 tmp')
        if (!/rename/.test(wf[0])) problems.push('writeSettingsFile 未用 rename')
      }
    }
    // 18d：两个 op 都已注册
    const httpPath = path.join(ROOT, 'host', 'http.js')
    if (fs.existsSync(httpPath)) {
      const ht = fs.readFileSync(httpPath, 'utf8')
      if (!ht.includes("op === 'marks'")) problems.push('http.js 缺 marks op')
      if (!ht.includes("op === 'getMarks'")) problems.push('http.js 缺 getMarks op')
    } else problems.push('缺 host/http.js')
  }

  if (problems.length > 0) bad('18 marks 原子写（tmp → rename）', problems.slice(0, 3).join('；'))
  else ok('18 marks 原子写（tmp → rename）', 'marks 独立文件 + tmp→rename；settings 同样原子；marks/getMarks 两个 op 已注册')
}

// ---------- 汇总 ----------
console.log('')
for (const r of results) {
  const tag = r.state === 'PASS' ? '  PASS' : r.state === 'FAIL' ? '  FAIL' : '  SKIP'
  console.log(`${tag} ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
}
const failed = results.filter((r) => r.state === 'FAIL').length
const passed = results.filter((r) => r.state === 'PASS').length
const skipped = results.filter((r) => r.state === 'SKIP').length
console.log('\n' + '='.repeat(48))
console.log(failed === 0
  ? `  ✓ 全部通过（${passed} 项通过 / ${skipped} 项后续启用）`
  : `  ✗ ${failed} 项失败（${passed} 项通过 / ${skipped} 项跳过）`)
console.log('='.repeat(48))
process.exit(failed === 0 ? 0 : 1)
