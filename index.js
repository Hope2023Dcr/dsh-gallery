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

export const inject = ['connection', 'webServer', 'tools']

export function apply(ctx, config) {
  registerMediaRoute(ctx, config)
  registerOpsRoute(ctx, config)
  registerTools(ctx, config)

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
