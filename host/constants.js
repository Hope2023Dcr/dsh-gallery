/**
 * 常量与默认配置。
 *
 * S1 拆分自 index.js（行为零变化）。
 */

import os from 'node:os'
import path from 'node:path'

// 协议常量来自 src/shared/protocol.js（构建时生成 host/protocol.js）。
// 这是 Host 与 Client 的唯一真源，本文件不再重复定义。
export { ROUTE, MEDIA_ROUTE, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS } from './protocol.js'


/** 音视频直链（GET）：给 <video>/<audio> 用，支持 Range。 */


/** 媒体直链的分块阈值：小于它整块返回，大于它走 Range 分块（避免大视频读满内存）。 */

export const STREAM_THRESHOLD = 8 * 1024 * 1024

/** DSH 主目录：优先环境变量，回退 ~/.dsh。 */

export const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** 会话日志根目录（DSH 主目录下的 sessions）。 */

export const DEFAULT_SESSIONS_DIR = path.join(DSH_HOME, 'sessions')

/**
 * 运行时配置文件的默认位置。
 * 用户可在面板内直接改产出根目录，改动写这里；
 * 它的优先级高于 cordis.patch.yml，低于用户显式传入的 root。
 */

export const DEFAULT_SETTINGS_FILE = path.join(DSH_HOME, 'dsh-gallery.json')

/**
 * 会话日志里，哪些工具调用的参数算「本对话的产出」。
 *
 * 分三类：
 * 1. **直接写文件**：write / edit / present 等 —— 路径一定是产出。
 * 2. **脚本产出**：Python/命令行脚本跑出来的图，不在 write 调用里，
 *    但 Agent 一定会用 read_image 打开它看效果 —— 所以「看过的图」也算产出。
 *    这是「过程中即时可见」的关键：不然脚本生成的中间图和成品图都看不见。
 * 3. **不看文件**：read / grep / glob 等纯读取，不算产出（避免把别人的文件算进来）。
 */

export const OUTPUT_TOOLS = new Set([
  'write',
  'edit',
  'present',
  'dsh_im_return_file',
  'ops_write_file',
  'ops_edit_file',
])

/**
 * 「Agent 看过的图片」也算本对话产出。
 * 只对图片生效（read_image 的参数就是图片路径），风险低：
 * Agent 不会无缘无故打开一张与任务无关的图。
 */

export const VIEW_TOOLS = new Set(['read_image'])

/** 只从 VIEW_TOOLS 里接受的图片扩展名。 */

export const VIEW_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif', '.tif', '.tiff'])

/**
 * 命令执行类工具。它参数里的路径只作为「弱证据」：
 * 出现在命令文本里 → 该文件是被处理过的，不算「纯输入」。
 */

export const BASH_TOOLS = new Set(['ops_bash', 'pwsh', 'bash'])

/** zstd 帧起始魔数（小端 0x28B52FFD）。一个 .zstd 文件可能由多帧拼接而成。 */

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export const DEFAULTS = {
  // 扫描时间窗口（小时）。默认一年：全局资产要能覆盖历史对话，
  // 否则「按对话分组」看不到旧成果。24 小时会把历史全滤掉。
  windowHours: 24 * 365,
  maxItems: 60,
  maxDepth: 3,
  extensions: ['.png', '.jpg', '.jpeg', '.webp'],
  /**
   * 音视频画廊（v0.10.1）：视频 + 音频，独立一个 kind。
   * 用浏览器原生 <video>/<audio> 播放，不引入 ffmpeg 等后端转码，保持零依赖。
   * 体积大的片子先不进列表（见 maxMediaBytes），避免一次性拉几十 MB 把面板卡死。
   */
  mediaExtensions: [
    // 视频
    '.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv',
    // 音频
    '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wma',
  ],
  /** 单个音视频文件的大小上限（字节）。超过就不列，避免加载卡顿。 */
  maxMediaBytes: 200 * 1024 * 1024,
  /**
   * 文件画廊：只放「产出文件」——文档、代码、数据、压缩包、链接。
   * 不收任何图片格式（图片归图片画廊），也不收音视频（音视频有独立画廊）。
   */
  fileExtensions: [
    '.md', '.markdown', '.txt', '.log',
    '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.xml', '.toml',
    '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.rtf', '.odt',
    '.html', '.htm', '.mht',
    '.zip', '.7z', '.rar', '.tar', '.gz',
    '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.ps1', '.sh', '.bat', '.cmd', '.sql', '.ipynb',
    '.url', '.lnk', '.webloc',
    '.dxf', '.dwg', '.skp', '.3dm',
  ],
  skipDirs: [
    'library_merged',
    'node_modules',
    '.git',
    '.svn',
    '$RECYCLE.BIN',
    'System Volume Information',
    '__pycache__',
    '.venv',
    'venv',
    '.cache',
  ],
  maxDirectories: 4000,
  maxEntries: 60000,
  maxImageBytes: 64 * 1024 * 1024,
}

/** 读取运行时配置文件（<DSH_HOME>/dsh-gallery.json）；不存在或损坏返回空对象。 */
