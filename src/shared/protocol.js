/**
 * 协议常量 —— Host 与 Client 的唯一真源。
 *
 * 拆分前 ROUTE / MEDIA_ROUTE / 扩展名表在 client.js 和 index.js 里各存一份，
 * 改路由要改两处、漏一处就打不通。现在由 scripts/build.mjs 同时生成
 * host/protocol.js 并注入 client bundle，两边不可能再漂移。
 *
 * 注意：本文件是 ESM，注入 client 时构建器会剥掉 export 关键字。
 */

/** 与 Host 半部一致的路由（exact Fetch 路由的 path）。 */
export const ROUTE = '/api/dsh-gallery'

/** 音视频直链（GET，支持 Range）——给 <video>/<audio> 用。 */
export const MEDIA_ROUTE = '/api/dsh-gallery/media'

/** 图片扩展名（缩略图/查看器/原图模式共用）。 */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']

/** 视频扩展名（与 Host 的 VIDEO_EXTS 保持一致）。 */
export const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv']

/** 音频扩展名。 */
export const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wma']
