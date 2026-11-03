#!/usr/bin/env python3
"""生成 README 用的架构示意图（纯 PIL，无外部依赖）。"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1100, 620
BG = (250, 250, 252)
INK = (28, 30, 36)
MUTED = (110, 116, 128)
BRAND = (59, 108, 232)
BRAND_SOFT = (232, 238, 253)
GREY_BOX = (242, 243, 246)
BORDER = (218, 221, 228)


def font(size, bold=False):
    candidates = [
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                continue
    return ImageFont.load_default()


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# 标题
d.text((40, 28), "产出画廊 · 数据流", font=font(30, True), fill=INK)
d.text((40, 72), "浏览器半部负责界面，Host 半部负责读盘，通过一条 POST 路由通信", font=font(15), fill=MUTED)

TOP = 130

# ---- 左：Agent 产出目录 ----
lx, ly, lw, lh = 40, TOP, 230, 400
d.rounded_rectangle([lx, ly, lx + lw, ly + lh], 12, fill=GREY_BOX, outline=BORDER, width=1)
d.text((lx + 18, ly + 16), "你的产出目录", font=font(17, True), fill=INK)
d.text((lx + 18, ly + 42), "路径在设置面板里指定", font=font(12), fill=MUTED)

files = [("PNG", "图片产出"), ("MD", "文档"), ("PY", "脚本"), ("JSON", "数据"), ("ZIP", "归档")]
for i, (tag, label) in enumerate(files):
    y = ly + 76 + i * 62
    d.rounded_rectangle([lx + 18, y, lx + 74, y + 44], 7, fill=(255, 255, 255), outline=BORDER, width=1)
    d.text((lx + 30, y + 14), tag, font=font(13, True), fill=BRAND)
    d.text((lx + 86, y + 15), label, font=font(14), fill=INK)

d.text((lx + 18, ly + lh - 40), "最近 24 小时 · 深度 3 层", font=font(12), fill=MUTED)

# ---- 中：Host ----
hx, hy, hw, hh = 330, TOP, 330, 400
d.rounded_rectangle([hx, hy, hx + hw, hy + hh], 12, fill=(255, 255, 255), outline=BRAND, width=2)
d.text((hx + 18, hy + 16), "index.js · Host 半部", font=font(17, True), fill=BRAND)
d.text((hx + 18, hy + 42), "Node 环境，能读磁盘", font=font(12), fill=MUTED)

blocks = [
    ("扫描目录", "广度优先 · 跳过批量目录 · 有预算"),
    ("图片尺寸", "手写 PNG/JPEG/WebP 头解析"),
    ("会话日志", "多帧 zstd 解压 + 缓存"),
    ("POST 路由", "/api/dsh-gallery"),
]
for i, (title, sub) in enumerate(blocks):
    y = hy + 76 + i * 78
    d.rounded_rectangle([hx + 18, y, hx + hw - 18, y + 64], 8, fill=BRAND_SOFT, outline=None)
    d.text((hx + 32, y + 12), title, font=font(14, True), fill=INK)
    d.text((hx + 32, y + 36), sub, font=font(11), fill=MUTED)

# ---- 右：Client ----
cx, cy, cw, ch = 740, TOP, 320, 400
d.rounded_rectangle([cx, cy, cx + cw, cy + ch], 12, fill=(255, 255, 255), outline=BRAND, width=2)
d.text((cx + 18, cy + 16), "client.js · 浏览器半部", font=font(17, True), fill=BRAND)
d.text((cx + 18, cy + 42), "渲染 UI，不直接碰磁盘", font=font(12), fill=MUTED)

blocks2 = [
    ("图片画廊", "缩略图 200px · 放大 8× · 自动刷新"),
    ("文件画廊", "48 种扩展名 · 原生侧栏预览"),
    ("分类开关", "全局资产 / 当前对话"),
    ("设置面板", "改根目录，立即生效"),
]
for i, (title, sub) in enumerate(blocks2):
    y = cy + 76 + i * 78
    d.rounded_rectangle([cx + 18, y, cx + cw - 18, y + 64], 8, fill=BRAND_SOFT)
    d.text((cx + 32, y + 12), title, font=font(14, True), fill=INK)
    d.text((cx + 32, y + 36), sub, font=font(11), fill=MUTED)

# ---- 箭头 ----
MID = TOP + 250


def arrow(x1, y1, x2, y2, color=BRAND, width=3, dash=False):
    if not dash:
        d.line([x1, y1, x2, y2], fill=color, width=width)
        # 箭头
        if x2 > x1:
            d.polygon([(x2, y2), (x2 - 11, y2 - 6), (x2 - 11, y2 + 6)], fill=color)
        else:
            d.polygon([(x2, y2), (x2 + 11, y2 - 6), (x2 + 11, y2 + 6)], fill=color)


# 左 → 中
arrow(lx + lw + 6, MID, hx - 6, MID)
d.text((lx + lw + 14, MID - 34), "扫描", font=font(12, True), fill=BRAND)

# ---- 中 ← → 右（请求 / 响应两条独立通道） ----
UP_Y = MID - 52
DOWN_Y = MID + 6
F12B = font(12, True)

arrow(hx + hw + 6, UP_Y, cx - 6, UP_Y)
req_label = "请求"
d.text(((hx + hw + cx) / 2 - d.textlength(req_label, font=F12B) / 2, UP_Y - 22),
       req_label, font=F12B, fill=BRAND)

arrow(cx - 6, DOWN_Y, hx + hw + 6, DOWN_Y)
resp_label = "JSON / 字节"
# 两条箭头之间的空白带，居中放置，避免撞到边框
d.text(((hx + hw + cx) / 2 - d.textlength(resp_label, font=F12B) / 2, UP_Y + 14),
       resp_label, font=F12B, fill=BRAND)

# ---- 底部：三入口 ----
by = 578
d.rounded_rectangle([40, by - 10, W - 40, by + 46], 9, fill=GREY_BOX, outline=BORDER, width=1)
d.text((58, by), "三个入口", font=font(13, True), fill=INK)
entries = ["左侧栏脚部按钮", "对话输入框右侧按钮", "右侧栏「开始」页卡片"]
x = 178
for e in entries:
    d.text((x, by), "· " + e, font=font(13), fill=MUTED)
    x += 258

# 保存
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "architecture.png")
img.save(out, "PNG", optimize=True)
print("saved:", out, os.path.getsize(out), "bytes")
