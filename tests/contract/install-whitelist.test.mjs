import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectFromWhitelist, REQUIRED } from '../../install.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function fakeHome () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gallery-test-'))
  fs.mkdirSync(path.join(tmp, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'profiles', 'desktop', 'package.json'),
    '{"name":"fake","bundles":[]}\n',
  )
  return tmp
}

test('files 白名单展开出来的文件都真实存在', () => {
  const plan = collectFromWhitelist(ROOT)
  assert.equal(plan.missing.length, 0, '精确声明的文件有缺失：' + plan.missing.join(', '))
  for (const f of plan.files) {
    assert.ok(fs.existsSync(path.join(ROOT, ...f.split('/'))), '文件不存在：' + f)
  }
  assert.ok(plan.files.length >= 9, '展开结果过少，白名单可能被改坏')
})

test('必需运行时文件全部在白名单里', () => {
  const plan = collectFromWhitelist(ROOT)
  for (const f of REQUIRED) {
    assert.ok(plan.files.includes(f), '必需项缺失：' + f)
  }
  assert.ok(REQUIRED.includes('session-index.js'), 'session-index.js 必须列为必需项')
})

test('通配目录按预期展开，且不会把开发目录装进去', () => {
  const plan = collectFromWhitelist(ROOT, ['locale/*.json', 'host/*.js'])
  assert.ok(plan.files.includes('locale/zh.json'))
  assert.ok(plan.files.includes('locale/en.json'))
  assert.ok(!plan.files.some((f) => f.startsWith('src/') || f.startsWith('scripts/')))
  // S1 之后 host/ 真实存在，应被展开成 10 个 .js 文件（不再是 optionalMissing）
  assert.ok(!plan.missing.includes('host/*.js'))
  const hostFiles = plan.files.filter((f) => f.startsWith('host/'))
  // S2 后 host/ 有 11 个 .js：10 个手写模块 + 1 个 protocol.js（由 build.mjs 从 src/shared 生成）
  assert.equal(hostFiles.length, 11, 'host/ 应展开为 11 个 .js 文件（10 模块 + protocol.js 生成物）')
  assert.ok(hostFiles.includes('host/protocol.js'), 'host/protocol.js 必须在白名单里')
  assert.ok(hostFiles.includes('host/http.js'), 'host/http.js 必须在白名单里')
  assert.ok(hostFiles.includes('host/scan.js'))
  assert.ok(!plan.optionalMissing.includes('host/*.js'), 'host/ 已存在，不应算 optionalMissing')
})

test('精确声明缺失会被报告为 missing', () => {
  const plan = collectFromWhitelist(ROOT, ['index.js', 'this-file-does-not-exist.js'])
  assert.ok(plan.files.includes('index.js'))
  assert.deepEqual(plan.missing, ['this-file-does-not-exist.js'])
})

test('install --dry-run 不写任何文件', () => {
  const tmp = fakeHome()
  try {
    const profilePkg = path.join(tmp, 'profiles', 'desktop', 'package.json')
    const before = fs.readFileSync(profilePkg, 'utf8')
    const r = spawnSync(process.execPath, ['install.mjs', '--dry-run'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_HOME: tmp },
    })
    assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''))
    assert.equal(fs.readFileSync(profilePkg, 'utf8'), before, 'dry-run 改写了 profile package.json')
    assert.ok(!fs.existsSync(path.join(tmp, 'profiles', 'desktop', 'node_modules')),
      'dry-run 创建了 node_modules 目录')
    assert.match(r.stdout, /未做任何修改/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
