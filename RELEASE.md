# 发布信息

## 是什么

DSH 插件「产出画廊」—— 把 Agent 任务过程中散落在磁盘上的产出变成右侧栏里的实时画廊，解决「任务过程黑箱、只有结尾才列出产出」的问题。任务进行中即可看到图片、文件、音视频（含中间尝试的产出），便于当场校验与及时干预。

## 当前版本

**v0.13.6** — 2026-11-08

- **v0.11.0**：音视频独立 `kind` + 首帧缩略图 + 面板内播放 + 一键截取当前帧；新增独立 HTTP Range 媒体路由。
- v0.11.1 / v0.11.2：修 README 三处会坑到真实用户的问题；调整表述力度（纯文档）。
- **v0.11.3（S1）**：Host 半部拆分 —— `index.js` 从 1824 行降到 **34 行薄入口**，逻辑搬进 `host/` 模块。**零构建**（Node 原生 ESM 多文件）。
- **v0.12.0（S2）**：Client 半部拆分 —— `client.js` 4213 行拆成 `src/client/` 13 个分片 + 独立 `styles.css`；新增 `src/shared/protocol.js` 作为 **Host 与 Client 的协议单一真源**；`scripts/build.mjs` 从 noop 切到真拼接（零依赖）。
- **v0.12.1**：面板内播放改用 blob，真正修好「视频进度条能拖」（此前因 DSH 桌面宿主转发时剥掉 `Content-Length`，`<video>.seekable` 恒为 `[0,0]`）；同时修 3 个回归。
- **v0.13.0（S3-a）**：**结构化反馈契约 v1 + 反馈篮**。右键给卡片打判定（通过 / 不要 / 定稿 / 单维重做 / 选择性重生成 / 设为参照）→ 攒进反馈篮（自动编号、可编辑理由 / 只改 / 锁死、可删清空）→ 「生成决策草稿」按 `Annotation N` 编号逐条列出，**只写进 composer 输入框、由人确认后手动发送**（零自动发送）。附 `seam v1`（`window.dshGallerySeam`）、设置写盘改 `tmp → rename` 原子写、`marks` 独立成 `dsh-gallery-marks.json`。
- **v0.13.1–v0.13.4**：修反馈篮与草稿链路的 4 个真机问题 —— 编辑弹窗、seam 卡片属性、**Lexical 异步 flush 导致判据假阴性（草稿被写 4 份）**、**双事件导致 2 份**（改为只发 `beforeinput` 后收敛为 1 份）。
- **v0.13.5**：反馈篮从**全屏模态遮罩**改为**右下角非模态浮层**（`z-index: 50` 低于右键菜单、`pointer-events: none` 让面板外可继续标记卡片）；配色改**硬编码高对比**（宿主 `--dsw-alias-*` 变量为空时 `var()` fallback 不生效，导致文字与背景同为深色）；新增「反馈篮 · N 条」**独立重开入口**；禁用原因写进按钮文案。
- **v0.13.6（本次）**：修「**打开所在文件夹**」一律指向「文档」—— 旧实现 `/select,"<path>"` 的手写引号经 Node spawn + `cmd start` 两层转义后残留在路径里；同时 `windowsHide: true` 会抑制 explorer 窗口显示。改为直接交给 Node quoting。

完整版本记录见 `CHANGELOG.md`。

## 包内容

| 文件 | 说明 |
|---|---|
| `package.json` | 插件清单（含 `files` 发布白名单、`scripts` 的 build / check / test） |
| `index.js` | **Host 半部入口，34 行薄入口**（只做 inject + 注册两条路由） |
| **`host/*.js`** | **Host 逻辑本体，13 个 .js**：`constants` / `fsutil` / `settings` / `session` / `classify` / `groups` / `scan` / `media` / `http` / `session-index` / **`marks`（v0.13.0 标记存储）** / **`protocol.js`** / **`feedback-text.js`**（后两个由 `build.mjs` 生成）。手写模块源码即产物，**无需构建** |
| **`host/protocol.js`** | 协议常量的 Host 侧副本，**由 `build.mjs` 从 `src/shared/protocol.js` 生成**（请勿手改） |
| `client.js` | 浏览器半部，**已拼好的构建产物**（4213 行源码 → 13 分片 → 单文件；用户无需构建） |
| `session-index.js` | 根级 **re-export**，实际实现在 `host/session-index.js`（保留是为了旧引用仍可用） |
| `cordis.patch.yml` | Host 配置（⚠️ 顶层必须是数组） |
| `locale/zh.json` / `locale/en.json` | 插件管理器显示名（meta），UI 字典内联在 `client.js` |
| `icon.svg` | 图标 |
| `install.mjs` | 一键安装脚本（按 `files` 白名单复制） |
| `README.md` / `LICENSE` / `CHANGELOG.md` | 说明、MIT 许可、版本记录 |

> 开发期文件 `src/`、`scripts/`、`tests/`、`docs/`、`packages/` 只在 GitHub 仓库里，**不会装进用户机器**。

## 安装（两种方式）

### 方式一：一键脚本（推荐）

```bash
# 在解压后的目录里运行
node install.mjs

# 指定 profile
node install.mjs --profile desktop

# 只看会做什么，不写入（会列出白名单里的全部文件）
node install.mjs --dry-run
```

脚本会：定位 DSH 主目录 → 选 profile → 按 `package.json` 的 `files` 白名单复制文件 → 在 profile 的 `package.json` 注册 `bundles` → 备份原文件。

`DSH_HOME` 环境变量可覆盖默认的 `~/.dsh`。

### 方式二：手动

见 `README.md` 的「安装」章节。

**两种方式装完都必须重启 DSH**（不是刷新页面）——Host 半部只在进程启动时加载。

## 首次使用

打开面板后，如果提示「目录不存在」，点面板里的 **⚙ 设置**，填入你的产出目录绝对路径。保存立即生效，不用重启。

## 兼容性

- DSH 桌面版（bundle 走 `web` 平台），本机已在 0.2.1-rc.5 上验证。
- 不依赖任何第三方 npm 包；Node >= 20（仅安装 / 校验脚本需要）。
- Windows / macOS / Linux 都能装；仅「在资源管理器里定位文件」是 Windows 专有（其他平台打开所在目录）。

### 已知不兼容

- 「当前对话」分类与自动标记（输入 / 中间 / 最终）依赖 DSH 会话日志的内部格式
  （`session.v4.jsonl.zstd` 里的 `tool/call` 事件）。DSH 大版本升级后这部分可能失效，其余功能不受影响。
- **媒体走双通道**：独立 Range 路由（`ctx.webServer.register`）用于缩略图抽取与分段读取；
  **面板内播放**走 `/api` 网关的 `raw` 分支 + blob。若后续 DSH 改了自定义路由注册方式，
  或改了 `/api` 网关的转发行为，需同步适配。
- **DSH 桌面宿主会剥掉 `Content-Length`**（`app.asar` 的 `lib/main.js`，`WITHHELD_RESPONSE_HEADERS`）。
  这是本版改用 blob 的直接原因；若未来宿主修掉这一点，可考虑回到直链播放以减少内存占用。

## 技术亮点（给同行看）

- **零依赖**：图片尺寸解析手写 PNG IHDR / JPEG SOF / WebP 三种头格式。
- **多帧 zstd 解压**：DSH 会话日志是追加写多帧拼接，单次解压只能拿第一帧，按魔数切帧逐帧解。
- **媒体双通道**：独立 Range 路由（206 / 416 / 后缀区间）负责缩略图抽取与分段读取；
  播放走 `raw` + `blob` 以绕过宿主丢 `Content-Length` 的问题，换来真正可拖动的进度条
  （代价是播放时整包载入内存，127 MB 实测 502 ms）。
- **协议单一真源**：`src/shared/protocol.js` 由 `build.mjs` 一份源生成两处 ——
  剥掉 `export` 注入 client bundle、生成 `host/protocol.js` 供 Host import，
  两侧协议常量不可能再漂移。
- **tab 保活**：`keepMounted: true`，切 tab 不丢状态。
- **原生预览**：`dsh-resource://file/session/<id>/<path>`，文档预览只认 session 作用域。
- **缩略图不塞原图**：canvas 压到 200px，并发 4，进视口才加载。
- **零外网请求**：client 只打本机 Host 路由，Host 只做本地文件读取。

## 结构说明（S0 / S1 / S2 三段）

| 阶段 | 版本 | 做了什么 |
|---|---|---|
| **S0** | v0.11.2+ | 工具链落地：`scripts/build.mjs`（noop 版）、`scripts/check.mjs`、`install.mjs` 白名单复制、`check.sh` 薄包装、契约测试。零字节运行时变化 |
| **S1** | v0.11.3 | **Host 拆分**：`index.js` 1824 → 34 行，逻辑进 `host/` 10 模块。Node 原生 ESM 多文件，**不需要构建** |
| **S2** | v0.12.0 | **Client 拆分**：13 分片 + `styles.css` + `src/shared/protocol.js`；构建器从 noop 切到真拼接 |

**为什么 Host 不用构建、Client 必须构建**：Host 是标准 Node ESM，支持相对 `import`，
多文件是原生能力；Client 受 DSH 加载器硬约束 —— `client.js` 必须是**单文件、
单个 `__ModuleLoader__.load`、无 ESM import/export**，所以源码可以分模块、产物必须合并。

**用户不需要构建**：发布目录里的 `client.js` 与 `host/protocol.js` 都是**已拼好并提交进 git 的产物**。
Release zip / npm 包 / `install.mjs` 用的都是这些产物。

## 开发侧

| 用途 | 路径 |
|---|---|
| 仓库根目录 | 本目录（GitHub 仓库 = 发布目录，路径不要改） |
| 构建（**改 src/ 后必跑**） | `npm run build`（生成 `client.js` + `host/protocol.js`）；`npm run build -- --check` 只读比对 |
| 校验 | `node scripts/check.mjs`（或 `./check.sh --install`，18 项中 16 项启用） |
| 契约测试 | `npm test`（显式枚举 `tests/contract/install-whitelist.test.mjs`；Node >= 20） |
| 迁移与行号映射 | `docs/migration.md` |
| 版本存档 | `CHANGELOG.md` |
