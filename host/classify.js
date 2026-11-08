/**
 * 资产分类：最终交付物 / 输入素材 / 中间产物。
 *
 * S1 拆分自 index.js（行为零变化）。
 */

import { promises as fsp, readFileSync, statSync, createReadStream } from 'node:fs'
import path from 'node:path'

export const ASSET_CATEGORY = {
  INPUT: 'input',
  INTERMEDIATE: 'intermediate',
  FINAL: 'final',
  UNKNOWN: 'unknown',
}

/** 中文/英文标签映射（客户端也可自行翻译，这里只给分类值）。 */

export const CATEGORY_ORDER = ['final', 'input', 'intermediate']

/**
 * 从会话日志里读出「本对话产出过的绝对路径 + 分类」。
 *
 * 覆盖两类来源：
 * 1. `write` / `edit` / `present` 等直接写文件的调用 —— 路径必是产出。
 * 2. `read_image` 打开过的图片 —— 脚本（Python 等）生成的图不在 write 调用里，
 *    但 Agent 一定会打开看效果。不纳入这一条，「过程中生成的图」在
 *    「当前对话」里就完全看不见（只有全局资产能看到）。
 *
 * @param logText - 解压后的日志文本（每行一个 JSON）。
 * @param sessionStartMs - 本会话开始时间（毫秒时间戳）。
 *   用于区分「用户提供的素材」和「会话期间生成的产物」：
 *   前者必定早于会话开始就存在。传 0 表示拿不到，此时不做输入判定。
 * @returns Map<绝对路径, { category, presented, written, viewed, bashMentioned }>
 */

export function classifyAsset(abs, info, sessionStartMs) {
  info.path = abs

  if (info.presented) {
    info.category = ASSET_CATEGORY.FINAL
    return
  }

  const looksLikeInput = info.viewed === true && info.written !== true && info.bashMentioned !== true
  if (!looksLikeInput) {
    info.category = ASSET_CATEGORY.INTERMEDIATE
    return
  }

  let mtimeMs = null
  try {
    mtimeMs = statSync(abs).mtimeMs
  } catch {
    mtimeMs = null
  }

  if (mtimeMs !== null && sessionStartMs > 0 && mtimeMs < sessionStartMs) {
    info.category = ASSET_CATEGORY.INPUT
  } else {
    // 会话开始后才出现（或文件已不存在）→ 归中间，不冒充用户素材
    info.category = ASSET_CATEGORY.INTERMEDIATE
  }
}

/**
 * 从会话日志里读出「本对话产出过的绝对路径」。
 * @param logText - 解压后的日志文本（每行一个 JSON）。
 * @returns 绝对路径的 Set。
 */
