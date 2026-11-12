/**
 * 产出台 · DSH 插件 —— Host 半入口。
 *
 * S1 拆分后本文件只做三件事：
 *   1. 声明 inject
 *   2. 把 config 交给各模块
 *   3. 注册两条路由
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
 */

import { registerMediaRoute, registerOpsRoute } from './host/http.js'

export const inject = ['connection', 'webServer']

export function apply(ctx, config) {
  registerMediaRoute(ctx, config)
  registerOpsRoute(ctx, config)
}

// 对外再导出（保持与拆分前的公开接口一致）
export { ROUTE, MEDIA_ROUTE } from './host/constants.js'
export { scanGallery } from './host/scan.js'
export { validateRootCandidate, writeSettingsFile } from './host/settings.js'
