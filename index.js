/**
 * 产出台 · DSH 插件 —— Host 半入口。
 *
 * S1 拆分后本文件只做四件事：
 *   1. 声明 inject
 *   2. 把 config 交给各模块
 *   3. 注册两条路由
 *   4. 注册 Agent 工具（B1）
 *
 * 实际逻辑分布在 host/ 下：
 *   constants.js  常量与默认值
 *   fsutil.js     路径/文件头/图片尺寸
 *   settings.js   设置读写 + 根目录探测 + 配置解析
 *   session.js    会话日志读取（zstd 多帧）
 *   classify.js   资产分类
 *   scan.js       扫描与分页
 *   groups.js     按对话分组
 *   media.js      Range / 流式 / MIME
 *   http.js       路由注册
 *   tools.js      Agent 工具（gallery_find，Host 进程内，模型可直接调用）
 */

import { registerMediaRoute, registerOpsRoute, setChangeTracker } from './host/http.js'
import { createChangeTracker } from './host/changes.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveOptions } from './host/settings.js'
import { registerTools } from './host/tools.js'
import os from 'node:os'
import { sweepStaleTmp } from './host/atomic.js'
import { sweepExpiredFeedback } from './host/feedback.js'
import { sweepContext } from './host/context.js'

export const inject = ['connection', 'webServer', 'tools']

export function apply(ctx, config) {
  registerMediaRoute(ctx, config)
  registerOpsRoute(ctx, config)
  registerTools(ctx, config)

  // ---- 启动时清一次历史残留（2026-11-19）----
  // 修复前五处「写 tmp → rename」都没有失败清理，~/.dsh 下积了 54 个 .tmp-* 残留。
  // 这里只清「本模块命名格式」且超过 1 小时的，避免误删正在写的；
  // 过期反馈同理，只在这里删，读路径永远纯读。
  // 全程 best-effort：失败绝不影响插件启动。
  try {
    void sweepStaleTmp(path.join(os.homedir(), '.dsh')).then((r) => {
      if (r.removed > 0) ctx?.logger?.info?.(`dsh-gallery: 清掉 ${r.removed} 个残留 tmp`)
    }).catch(() => {})
  } catch { /* 忽略 */ }
  // v1.5.0：浏览记录按 TTL 清扫（默认 0＝不自动清，用户开了才跑）
  try {
    const opts = resolveOptions(config)
    if (Number(opts.contextTtlHours) > 0) {
      void sweepContext(opts.settingsFile, opts.contextTtlHours).then((r) => {
        if (r.removed > 0) ctx?.logger?.info?.(`dsh-gallery: 清掉 ${r.removed} 条过期浏览记录`)
      }).catch(() => {})
    }
  } catch { /* 忽略 */ }
  try {
    const opts = resolveOptions(config)
    void sweepExpiredFeedback(opts.settingsFile, opts).then((r) => {
      if (r.removed > 0) ctx?.logger?.info?.(`dsh-gallery: 清掉 ${r.removed} 条过期反馈`)
    }).catch(() => {})
  } catch { /* 忽略 */ }

  // ---- 资产变动追踪（增量刷新，2026-11-16）----
  // 任何进程往产出根里写资产，都会被 fs.watch 感知；前端凭版本号做增量刷新。
  // 全程 best-effort：失败只记日志，绝不影响面板本身。
  try {
    const opts = resolveOptions(config)
    const roots = (opts.roots ?? []).filter((r) => typeof r === 'string' && r !== '')

    // 变动文件 → 所属会话：只查 frames.json（内存里已有，零成本）。
    // 插件自己写的资产（粘贴 / 裁剪 / 遮罩 / 截帧）都登记在里面，能定位到组；
    // Agent 写的资产查不到就归 ''，前端会退化成整表刷新兜底 —— 这种情况少，
    // 不值得为它每次变动去读会话日志（几百 KB zstd 解压）。
    let frameRelToSid = null
    const sessionOfPath = (rel) => {
      if (rel === '' || rel === null || rel === undefined) return ''
      try {
        if (frameRelToSid === null) {
          frameRelToSid = new Map()
          // readFrames 是同步语义的辅助读取，这里用同步 fs 读一次即可
          const file = opts.settingsFile
          const dir = path.dirname(String(file ?? ''))
          const p = path.join(dir, 'dsh-gallery-frames.json')
          const j2 = JSON.parse(readFileSync(p, 'utf8'))
          const frames = j2?.frames ?? j2 ?? {}
          for (const [k, v] of Object.entries(frames)) {
            if (v !== null && typeof v === 'object' && typeof v.sessionId === 'string' && v.sessionId !== '') {
              frameRelToSid.set(String(k).toLowerCase(), v.sessionId)
            }
          }
        }
        return frameRelToSid.get(String(rel).toLowerCase()) ?? ''
      } catch { return '' }
    }

    const tracker = createChangeTracker({ roots, sessionOfPath })
    const n = tracker.start()
    setChangeTracker(tracker)
    ctx?.logger?.info?.(`dsh-gallery: 资产变动监听已启动（${n}/${roots.length} 个产出根）`)
    // 插件卸载时停掉监听
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => { try { tracker.stop() } catch { /* 忽略 */ } })
    }
  } catch (error) {
    ctx?.logger?.warn?.('dsh-gallery: 资产变动监听未启动（不影响面板）', error)
  }
}

// 对外再导出（保持与拆分前的公开接口一致）
export { ROUTE, MEDIA_ROUTE } from './host/constants.js'
export { scanGallery } from './host/scan.js'
export { validateRootCandidate, writeSettingsFile } from './host/settings.js'
