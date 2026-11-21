/**
 * 产出台 · 区域感知（2026-11-16）
 *
 * 为什么要有这个文件：
 *   老板在产出台里框了一块区域（左键逐点多边形 → 进反馈篮），然后跟助手说
 *   「框选区域的字母改为小雨点」。实测下来助手要花 **97 秒翻 7 次文件**才
 *   发现「哦，用户刚框了一块」，再花 150 秒自己写 PIL 反复算坐标。
 *   根因是：批注只在 feedback.json 里，前端看得见，助手看不见 ——
 *   gallery_context 只肯说「你在看哪张图」，不说「这张图上框了哪儿」。
 *
 * 本文件负责把那块坐标变成助手能直接吃的东西：
 *   · 归一化坐标 → 整图像素矩形
 *   · 外扩一圈后的裁剪小图（存临时目录，不登记、不污染产出台）
 *   · 需要时按前端口径生成 RGBA 遮罩（全尺寸、RGB 留原图、选区内 alpha=0）
 *
 * 遮罩口径必须与 client.js 的 buildMaskPng 逐字节对齐，否则 ComfyUI 那边
 * 会拿到一张「框位置正确但 alpha 反了」的图。对齐依据：
 *   · maskPixelRect  —— 归一化 → 整图像素矩形
 *   · maskAlphaAt    —— 框内 0、框外 255
 *   · polygonAlphaLayer —— 多边形填充后强制二值
 *
 * 红线：不写 feedback / 不改标记 / 不发消息。裁剪图只落系统临时目录。
 */
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { execFile } from 'node:child_process'

/** 裁剪图外扩比例：框太小的时候至少留这么一圈上下文，否则看不清框的是啥。 */
const CROP_MARGIN_RATIO = 0.12
const CROP_MARGIN_MIN_PX = 16
/** 遮罩像素上限：超过就不生成，避免一次性吃掉几百 MB。 */
const MASK_MAX_PIXELS = 40_000_000
const PYTHON_TIMEOUT_MS = 20_000

/** 读 PNG / JPEG / GIF 的宽高（不依赖任何图像库，只解析文件头）。 */
export function imageSizeOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  // PNG：8 字节魔数 + 4 长度 + 4 'IHDR'，宽高在 16 / 20
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' }
  }
  // GIF：'GIF87a' / 'GIF89a'，宽高是小端 16 位
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' }
  }
  // JPEG：扫段找 SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue }
      const marker = buf[i + 1]
      // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: 'jpeg' }
      }
      const len = buf.readUInt16BE(i + 2)
      if (len < 2) return null
      i += 2 + len
    }
    return null
  }
  // WebP：VP8X / VP8 / VP8L
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X') {
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
        format: 'webp',
      }
    }
    if (kind === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' }
    }
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' }
    }
  }
  return null
}

const clamp01 = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : (n > 1 ? 1 : n)
}

/**
 * 🔴 两种形态必须都认，否则坐标会抓空：
 *   · 内存形态：{ x, y, w, h, polygon?, shape?, note }        （normalizeAnnotation 产出）
 *   · 落盘形态：{ id, note, region: { x, y, w, h, polygon?, shape? }, markedAt }
 *     —— feedback.json 里存的是这一种（见 client.js 的 toStoredAnnot）。
 *   第一版漏了这一层，读出来的框全是 0×0。这里统一压成平铺，
 *   下游（算像素矩形、算裁剪框、给模型看）只认平铺。
 */
export function flattenAnnotation(a) {
  if (a === null || typeof a !== 'object') return null
  const region = (a.region !== null && typeof a.region === 'object') ? a.region : a
  const x = Number(region.x)
  const y = Number(region.y)
  const w = Number(region.w)
  const h = Number(region.h)
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null
  const polygon = Array.isArray(region.polygon) ? region.polygon : (Array.isArray(a.polygon) ? a.polygon : null)
  const shape = region.shape ?? a.shape ?? (polygon !== null ? 'polygon' : 'rect')
  return {
    x, y, w, h,
    shape: String(shape),
    polygon,
    note: typeof a.note === 'string' ? a.note : '',
    fillColor: typeof region.fillColor === 'string' ? region.fillColor : '',
    id: typeof a.id === 'string' ? a.id : '',
  }
}

/** 从 feedback.json 的若干条目里取出某张图的批注（没有就是空数组）。 */
export function annotationsFor(feedback, relPath) {
  const key = String(relPath ?? '').replace(/\\/g, '/')
  const entry = feedback !== null && typeof feedback === 'object' ? feedback[key] : null
  if (entry === null || typeof entry !== 'object') return []
  const list = Array.isArray(entry.annotations) ? entry.annotations : []
  const flat = list.map(flattenAnnotation).filter((a) => a !== null)
  if (flat.length > 0) return flat
  // 老格式 / 只记了单条 region：退回顶层 region
  const single = flattenAnnotation(entry)
  return single !== null ? [single] : []
}

/**
 * 全库「每张图最后一次被标注」的时间表（relPath → 毫秒）。
 *
 * 为什么要它：老板定的排序口径里「最近标注」排在「生成 / 改动」之前 ——
 * 标注是人主动划的一笔，比文件时间戳更能说明「我在这张图上动脑子了」。
 * 只返回时间，不返回内容：排序只需要一个数，明细留给 annotationsFor。
 */
export function latestAnnotationAt(feedback) {
  const out = new Map()
  if (feedback === null || typeof feedback !== 'object') return out
  for (const [rel, entry] of Object.entries(feedback)) {
    if (entry === null || typeof entry !== 'object') continue
    const list = Array.isArray(entry.annotations) ? entry.annotations : [entry]
    let best = 0
    for (const a of list) {
      if (a === null || typeof a !== 'object') continue
      const t = Number(a.markedAt ?? a.createdAt ?? 0) || 0
      if (t > best) best = t
    }
    // 有的一整条反馈只有一个顶层时间（老格式 / 只记单条 region 的情况）
    const top = Number(entry.markedAt ?? entry.updatedAt ?? 0) || 0
    if (top > best) best = top
    if (best > 0) out.set(String(rel).replace(/\\/g, '/'), best)
  }
  return out
}

/**
 * 与 client.js 的 maskPixelRect 同一算法：归一化框 → 整图像素矩形。
 * 助手拿到的就是这里的数字，必须和前端画出来的那一块严格一致。
 */
export function maskPixelRect(annotation, width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const x = clamp01(annotation?.x)
  const y = clamp01(annotation?.y)
  let nw = clamp01(annotation?.w)
  let nh = clamp01(annotation?.h)
  if (nw > 0 && x + nw > 1) nw = 1 - x
  if (nh > 0 && y + nh > 1) nh = 1 - y
  const x0 = Math.min(w - 1, Math.max(0, Math.round(x * w)))
  const y0 = Math.min(h - 1, Math.max(0, Math.round(y * h)))
  const x1 = Math.min(w, Math.max(x0 + 1, Math.round((x + nw) * w)))
  const y1 = Math.min(h, Math.max(y0 + 1, Math.round((y + nh) * h)))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, width: w, height: h }
}

/** 把一条批注整理成助手看得懂的一行事实。 */
export function describeAnnotation(annotation, index, imageSize) {
  const size = imageSize ?? { width: 0, height: 0 }
  const known = Number(size.width) > 0 && Number(size.height) > 0
  const rect = maskPixelRect(annotation, size.width, size.height)
  const isPolygon = annotation?.shape === 'polygon' && Array.isArray(annotation?.polygon)
  return {
    index: index + 1,
    shape: String(annotation?.shape ?? 'rect'),
    // 归一化（前端存的就是这个）：助手要用现成脚本时按这个算比例
    xPct: Math.round(clamp01(annotation?.x) * 1000) / 10,
    yPct: Math.round(clamp01(annotation?.y) * 1000) / 10,
    wPct: Math.round(clamp01(annotation?.w) * 1000) / 10,
    hPct: Math.round(clamp01(annotation?.h) * 1000) / 10,
    // 整图像素矩形（已换算好，助手不用自己算）。
    // 尺寸未知时给全 0 —— 给个「1×1 在左上角」的假数字比不给更糟，
    // 模型会照着它去裁一块空白。
    px: known
      ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
      : { x: 0, y: 0, w: 0, h: 0 },
    note: typeof annotation?.note === 'string' ? annotation.note : '',
    pointCount: isPolygon ? annotation.polygon.length : 0,
    points: isPolygon
      ? annotation.polygon.map((p) => [
        Math.round(clamp01(Array.isArray(p) ? p[0] : p?.x) * 1000) / 10,
        Math.round(clamp01(Array.isArray(p) ? p[1] : p?.y) * 1000) / 10,
      ])
      : [],
    fillColor: typeof annotation?.fillColor === 'string' ? annotation.fillColor : '',
  }
}

/**
 * 外扩一圈但不越界。框贴着图边时自动收回来。
 */
export function expandBox(px, imageSize, marginRatio = CROP_MARGIN_RATIO) {
  const w = Math.max(1, Math.round(Number(imageSize?.width) || 0))
  const h = Math.max(1, Math.round(Number(imageSize?.height) || 0))
  const mx = Math.max(CROP_MARGIN_MIN_PX, Math.round(px.w * marginRatio))
  const my = Math.max(CROP_MARGIN_MIN_PX, Math.round(px.h * marginRatio))
  const x0 = Math.max(0, px.x - mx)
  const y0 = Math.max(0, px.y - my)
  const x1 = Math.min(w, px.x + px.w + mx)
  const y1 = Math.min(h, px.y + px.h + my)
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

/** 找不到宿主自带 python 时的候选路径（本机实测装在这里，见归档）。 */
function pythonCandidates() {
  const list = []
  if (process.env.DSH_PYTHON) list.push(process.env.DSH_PYTHON)
  const home = os.homedir()
  list.push(path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  list.push(path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'))
  if (process.platform === 'win32') list.push('python.exe')
  else list.push('python3')
  return list
}

// 未探测用 undefined 表示；探不到记成空串（区分「还没探」和「探过没有」）
let pythonCache

/** 探测一个能用 PIL 的 python；探不到返回 null（调用方降级，不能抛）。 */
export async function resolvePython() {
  if (pythonCache !== undefined) return pythonCache === '' ? null : pythonCache
  for (const candidate of pythonCandidates()) {
    const ok = await new Promise((resolve) => {
      try {
        execFile(candidate, ['-c', 'import PIL, numpy'], { timeout: 6000, windowsHide: true }, (err) => {
          resolve(err === null)
        })
      } catch {
        resolve(false)
      }
    })
    if (ok) { pythonCache = candidate; return candidate }
  }
  pythonCache = ''
  return null
}

/** 供测试注入：把探测结果钉死，别让测试依赖本机装没装 python。 */
export function __setPythonForTest(value) {
  pythonCache = value
}

/**
 * 真正干活的一步：把请求写成 JSON 交给 python，拿回裁剪图 / 遮罩。
 * 走文件而不是命令行参数 —— 中文路径 + 引号 + 长度都容易翻车。
 */
function runPythonJob(python, jobFile, timeoutMs = PYTHON_TIMEOUT_MS) {
  const script = String.raw`
import json, sys, os
sys.stdout.reconfigure(encoding="utf-8")
from PIL import Image, ImageDraw
import numpy as np

with open(sys.argv[1], "r", encoding="utf-8") as f:
    job = json.load(f)

src = job["image"]
out = {"ok": True, "regions": [], "image": {}}
try:
    base = Image.open(src)
    base.load()
    base = base.convert("RGBA")
except Exception as e:
    print(json.dumps({"ok": False, "error": "open-failed: %s" % e}, ensure_ascii=False))
    sys.exit(0)

W, H = base.size
out["image"] = {"width": W, "height": H}
os.makedirs(job["cropDir"], exist_ok=True)

# 分支二：用户手动画好的遮罩文件（右键逐点填充 → 导出遮罩）。
# 这时根本不用算坐标 —— 遮罩里 alpha=0 的地方就是他要改的地方，
# 直接量出包围盒 + 裁一张小图给他看清框住哪个字即可。
if job.get("mode") == "mask":
    try:
        mk = Image.open(job["mask"])
        mk.load()
    except Exception as e:
        print(json.dumps({"ok": False, "error": "mask-open-failed: %s" % e}, ensure_ascii=False))
        sys.exit(0)
    if tuple(mk.size) != (W, H):
        print(json.dumps({"ok": False, "error": "mask-size-mismatch: 遮罩 %dx%d 与原图 %dx%d 不一致" % (mk.size[0], mk.size[1], W, H)}, ensure_ascii=False))
        sys.exit(0)
    if "A" in mk.getbands():
        alpha = np.array(mk.convert("RGBA").getchannel("A"))
    else:
        # 没有 alpha 的遮罩（灰度 / 黑白图）：按「黑=要改」处理，与常见约定一致
        gray = np.array(mk.convert("L"))
        alpha = np.where(gray < 128, 0, 255).astype(np.uint8)
    sel = alpha < 128
    n = int(sel.sum())
    if n == 0:
        print(json.dumps({"ok": False, "error": "mask-empty: 遮罩里没有任何选区（整张都是不透明）"}, ensure_ascii=False))
        sys.exit(0)
    ys, xs = np.where(sel)
    bx0, bx1, by0, by1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    bw, bh = bx1 - bx0 + 1, by1 - by0 + 1
    out["px"] = {"x": bx0, "y": by0, "w": bw, "h": bh}
    out["pixels"] = n
    if job.get("withCrop"):
        patch = max(16, int(round(max(bw, bh) * 0.12)))
        cx0 = max(0, bx0 - patch); cy0 = max(0, by0 - patch)
        cx1 = min(W, bx1 + 1 + patch); cy1 = min(H, by1 + 1 + patch)
        crop = base.crop((cx0, cy0, cx1, cy1))
        cp = os.path.join(job["cropDir"], "mask-region.png")
        crop.save(cp, "PNG")
        out["cropPath"] = cp
        out["cropBox"] = {"x": cx0, "y": cy0, "w": cx1 - cx0, "h": cy1 - cy0}
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)

for r in job["regions"]:
    one = {"index": r["index"], "cropPath": "", "maskPath": ""}
    cb = r["cropBox"]
    x0 = max(0, min(W, int(cb["x"]))); y0 = max(0, min(H, int(cb["y"])))
    x1 = max(x0 + 1, min(W, x0 + int(cb["w"])))
    y1 = max(y0 + 1, min(H, y0 + int(cb["h"])))
    if r.get("withCrop"):
        crop = base.crop((x0, y0, x1, y1))
        p = os.path.join(job["cropDir"], "region-%02d.png" % r["index"])
        crop.save(p, "PNG")
        one["cropPath"] = p
        one["cropBox"] = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}
    if r.get("withMask"):
        # 与 client.js 同口径：全尺寸、RGB 保留原图、选区内 alpha=0、框外 255
        alpha = Image.new("L", (W, H), 255)
        d = ImageDraw.Draw(alpha)
        pts = r.get("polygon")
        if pts:
            px = []
            for p2 in pts:
                nx = min(1.0, max(0.0, float(p2[0])))
                ny = min(1.0, max(0.0, float(p2[1])))
                px.append((nx * W, ny * H))
            d.polygon(px, fill=0)
        else:
            pb = r["px"]
            ax0 = max(0, min(W, int(pb["x"]))); ay0 = max(0, min(H, int(pb["y"])))
            ax1 = max(ax0 + 1, min(W, ax0 + int(pb["w"])))
            ay1 = max(ay0 + 1, min(H, ay0 + int(pb["h"])))
            d.rectangle([ax0, ay0, ax1 - 1, ay1 - 1], fill=0)
        masked = base.copy()
        masked.putalpha(alpha)
        mp = os.path.join(job["cropDir"], "mask-%02d.png" % r["index"])
        masked.save(mp, "PNG")
        one["maskPath"] = mp
    out["regions"].append(one)

print(json.dumps(out, ensure_ascii=False))
`
  return new Promise((resolve) => {
    try {
      execFile(python, ['-c', script, jobFile], {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: String(stderr || err.message || err).slice(0, 400) })
          return
        }
        try {
          const text = String(stdout ?? '').trim()
          const lastLine = text.split('\n').filter((l) => l.trim() !== '').pop() ?? ''
          resolve(JSON.parse(lastLine))
        } catch (e) {
          resolve({ ok: false, error: 'parse-failed: ' + String(e?.message ?? e) })
        }
      })
    } catch (e) {
      resolve({ ok: false, error: String(e?.message ?? e) })
    }
  })
}

function hashName(input) {
  let h = 5381
  const s = String(input ?? '')
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/**
 * 主入口：给一张图和它的批注，产出「助手能直接看的东西」。
 *
 * 设计上的取舍：
 *   · python 探不到就**不报错**，返回坐标 + 一句「自己裁」的说明。宁可少给，
 *     也不能让工具调用抛异常把模型这一轮废掉（宿主的 tool 失败代价很高）。
 *   · 裁剪图落系统临时目录，**不进产出台**。派生资产要登记 frame 才算数，
 *     这里只是给模型看的中间物，登记了反而会让用户看到一堆垃圾。
 */
export async function materializeRegions({
  absPath,
  annotations,
  withCrop = true,
  withMask = false,
} = {}) {
  const list = (Array.isArray(annotations) ? annotations : [])
    .map(flattenAnnotation)
    .filter((a) => a !== null)
  const result = {
    ok: true,
    image: { width: 0, height: 0 },
    regions: [],
    degraded: '',
  }
  if (list.length === 0) {
    result.ok = true
    result.degraded = '这张图上没有任何框选批注'
    return result
  }
  let size = null
  try {
    const head = Buffer.alloc(64 * 1024)
    const handle = await fsp.open(absPath, 'r')
    try {
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      size = imageSizeOf(head.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    size = null
  }
  if (size !== null) result.image = { width: size.width, height: size.height }
  const imageSize = size ?? { width: 0, height: 0 }

  const prepared = list.map((a, i) => {
    const fact = describeAnnotation(a, i, imageSize)
    const cropBox = expandBox(fact.px, imageSize)
    return { fact, cropBox, raw: a }
  })
  result.regions = prepared.map((p) => ({
    ...p.fact,
    cropBox: p.cropBox,
    // 先给空串占位：降级路径（没 python）也必须有这两个字段，
    // 否则前端 / 模型拿到 undefined，判断「有没有裁剪图」会出错。
    cropPath: '',
    maskPath: '',
  }))

  const python = await resolvePython()
  if (python === null) {
    result.degraded = '本机没探到可用的 python(PIL)，只给了坐标；裁剪图需要自行生成'
    return result
  }
  const totalPixels = imageSize.width * imageSize.height
  const wantMask = withMask === true && totalPixels > 0 && totalPixels <= MASK_MAX_PIXELS
  if (withMask === true && !wantMask) {
    result.degraded = '图太大，没有生成遮罩（超过 4000 万像素）'
  }

  const cropDir = path.join(os.tmpdir(), 'dsh-gallery-regions', hashName(absPath + '|' + list.length))
  await fsp.mkdir(cropDir, { recursive: true }).catch(() => {})
  const jobFile = path.join(cropDir, `job-${Date.now().toString(36)}.json`)
  const job = {
    image: absPath,
    cropDir,
    regions: prepared.map((p, i) => ({
      index: i + 1,
      px: p.fact.px,
      cropBox: p.cropBox,
      polygon: p.fact.shape === 'polygon' && p.fact.points.length >= 4
        ? p.raw.polygon.map((pt) => [clamp01(Array.isArray(pt) ? pt[0] : pt?.x), clamp01(Array.isArray(pt) ? pt[1] : pt?.y)])
        : null,
      withCrop: withCrop === true,
      withMask: wantMask,
    })),
  }
  try {
    await fsp.writeFile(jobFile, JSON.stringify(job), 'utf8')
  } catch (e) {
    result.degraded = '临时目录不可写：' + String(e?.message ?? e)
    return result
  }
  const ran = await runPythonJob(python, jobFile)
  await fsp.unlink(jobFile).catch(() => {})
  if (ran?.ok !== true) {
    result.degraded = 'python 处理失败（' + String(ran?.error ?? '未知') + '），只给了坐标'
    return result
  }
  const byIndex = new Map((ran.regions ?? []).map((r) => [r.index, r]))
  result.regions = result.regions.map((r) => {
    const got = byIndex.get(r.index) ?? {}
    return { ...r, cropPath: String(got.cropPath ?? ''), maskPath: String(got.maskPath ?? '') }
  })
  return result
}

/**
 * 「用户已经画好遮罩」这条路的入口。
 *
 * 现实场景（2026-11-16 实测 8 分 39 秒那次）：用户在产出台右键逐点填充 → 导出遮罩，
 * 遮罩文件已经躺在产出目录里，gallery_context 也把路径报给了模型 ——
 * 但模型没有「一次拿到范围 + 裁剪图」的通道，只能自己写 PIL 脚本
 * 量 alpha 像素、画包围盒、放大看图，光确认「框住的是哪个字」就耗掉三分半钟。
 *
 * 这里就干一件事：把遮罩读出来，给包围盒 + 一张外扩裁剪图。
 * 遮罩本身**原样复用**，绝不重新生成 —— 用户画的边界以他为准。
 */
export async function materializeMaskRegion({ absPath, maskPath, withCrop = true } = {}) {
  const result = { ok: true, image: { width: 0, height: 0 }, region: null, degraded: '' }
  const python = await resolvePython()
  if (python === null) {
    result.degraded = '本机没探到可用的 python(PIL)，读不出遮罩覆盖范围；遮罩文件本身可以直接用'
    return result
  }
  const cropDir = path.join(os.tmpdir(), 'dsh-gallery-regions', hashName(absPath + '|mask'))
  await fsp.mkdir(cropDir, { recursive: true }).catch(() => {})
  const jobFile = path.join(cropDir, `job-mask-${Date.now().toString(36)}.json`)
  try {
    await fsp.writeFile(jobFile, JSON.stringify({
      mode: 'mask', image: absPath, mask: maskPath, cropDir, withCrop: withCrop === true,
    }), 'utf8')
  } catch (e) {
    result.degraded = '临时目录不可写：' + String(e?.message ?? e)
    return result
  }
  const ran = await runPythonJob(python, jobFile)
  await fsp.unlink(jobFile).catch(() => {})
  if (ran?.ok !== true) {
    result.degraded = '读遮罩失败：' + String(ran?.error ?? '未知')
    return result
  }
  const width = Number(ran?.image?.width) || 0
  const height = Number(ran?.image?.height) || 0
  result.image = { width, height }
  const px = ran?.px ?? { x: 0, y: 0, w: 0, h: 0 }
  // 百分比顺手算好：模型拿它写 prompt 或跟用户对话时不用再乘除
  const pct = (v, base) => (base > 0 ? Math.round((Number(v) || 0) / base * 1000) / 10 : 0)
  result.region = {
    px: { x: Number(px.x) || 0, y: Number(px.y) || 0, w: Number(px.w) || 0, h: Number(px.h) || 0 },
    xPct: pct(px.x, width),
    yPct: pct(px.y, height),
    wPct: pct(px.w, width),
    hPct: pct(px.h, height),
    // 只报数字不报含义：这里是「被选中的像素个数」，不是给模型做覆盖率验收用的
    pixelCount: Number(ran?.pixels) || 0,
    cropPath: String(ran?.cropPath ?? ''),
    cropBox: ran?.cropBox ?? null,
  }
  return result
}

export const REGION_LIMITS = {
  CROP_MARGIN_RATIO,
  CROP_MARGIN_MIN_PX,
  MASK_MAX_PIXELS,
  PYTHON_TIMEOUT_MS,
}
