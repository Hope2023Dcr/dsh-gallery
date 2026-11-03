# 发布信息

## 是什么

DSH 插件「产出画廊」—— 把 Agent 的产出目录变成右侧栏里的实时画廊。图片自动刷新、点开放大；文件一列排放、点一下用 DSH 原生侧栏预览。

## 版本

**v0.4.0** — 2026-11-03

本版重点：**产出根目录可配置**。之前的版本把路径写死在某台机器上，别人装上会显示空白。现在改成三级优先 + 面板内直接改，改完立即生效。

## 包内容

| 文件 | 说明 |
|---|---|
| `README.md` | 完整说明（安装、功能、配置、限制、技术细节） |
| `LICENSE` | MIT |
| `install.mjs` | 一键安装脚本 |
| `package.json` | 插件清单 |
| `index.js` | Host 半部 |
| `client.js` | 浏览器半部 |
| `cordis.patch.yml` | Host 配置 |
| `locale/` | 中英文案 |
| `icon.svg` | 图标 |

## 安装（两种方式）

### 方式一：一键脚本（推荐）

```bash
# 在解压后的目录里运行
node install.mjs

# 指定 profile
node install.mjs --profile desktop

# 只看会做什么，不写入
node install.mjs --dry-run
```

脚本会自动：定位 DSH 主目录 → 选 profile → 复制文件 → 注册 bundle → 备份原 package.json。

### 方式二：手动

见 `README.md` 的「安装」章节。

**两种方式装完都必须重启 DSH**（不是刷新页面）。

## 首次使用

打开面板后，如果提示「目录不存在」，点面板里的 **⚙ 设置**，填入你的产出目录绝对路径。保存立即生效，不用重启。

## 兼容性

- DSH 桌面版 / Web 版均可（bundle 走 `web` 平台）
- 不依赖任何第三方 npm 包
- Windows / macOS / Linux 都能装；仅「在资源管理器里定位文件」是 Windows 专有（其他平台会打开所在目录）

### 已知不兼容

「当前对话」分类功能依赖 DSH 会话日志的内部格式（`session.v4.jsonl.zstd` 里的 `tool/call` 事件）。DSH 大版本升级后这部分可能失效，其余功能不受影响。

## 技术亮点（给同行看）

- **零依赖**：图片尺寸解析手写 PNG IHDR / JPEG SOF / WebP 三种头格式
- **多帧 zstd 解压**：DSH 会话日志是追加写多帧拼接，单次解压只能拿第一帧，按魔数切帧逐帧解
- **tab 保活**：`keepMounted: true`，切 tab 不丢状态
- **原生预览**：`dsh-resource://file/session/<id>/<path>`，文档预览只认 session 作用域
- **缩略图不塞原图**：canvas 压到 200px，并发 4，进视口才加载

## 目录（开发侧）

| 用途 | 路径 |
|---|---|
| 开源发布目录 | `open-source/`（本仓库根目录） |
| 源码 | 本仓库根目录 |
| 版本存档 | `CHANGELOG.md` 记录了全部版本 |
