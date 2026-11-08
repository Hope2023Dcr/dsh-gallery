# 结构迁移记录

> 配套文档：`../README.md`（用户）、`../CONTRIBUTING.md`（开发）、`../RELEASE.md`（发版）。
> 目标形态与论证见工作区报告《dsh-gallery-文件结构规划.md》，本文件只记录**本机可核对的事实与行号映射**。

## 为什么要记这个

三份调研报告（《迭代调研》《游客视角评估》《架构决策》）里引用了大量 `client.js:XXXX` / `index.js:XXXX` 行号。
S2 把 client 拆成分片后，产物行号会整体漂移，这些引用会全部失效。
**S1 / S2 每搬一个模块，必须在本文件补一行映射**，否则以后按旧行号找代码会扑空。

## 阶段表（每步一个 tag，可单独回滚）

| 阶段 | 版本 | 内容 | 运行时产物变化 | 状态 |
|---|---|---|---|---|
| **S0 工具链** | v0.11.2+ | `scripts/build.mjs` noop 版、`scripts/check.mjs`、`install.mjs` 白名单复制、`check.sh` 薄包装、契约测试 | **零字节变化** | ✅ 本次落地（待老板推送） |
| **S1 Host 拆分** | v0.11.3 | `index.js` → `host/` 9 模块（+ session-index 搬入）；根级 `index.js` 34 行薄入口；`session-index.js` 留 re-export | 新增 `host/` 10 文件 | ✅ 已完成 |
| **S2 Client 拆分** | v0.12.0 | CSS / 字典 / 组件 → `src/client/` 13 分片 + `styles.css`；`src/shared/protocol.js` 落地；构建器启用 | `client.js` 行为等价、行号全变 | ✅ 已完成 |
| **S3 表态层** | v0.12.0 / 独立包 v0.1 | marks / decision / seam、原子写、`packages/decision/` 骨架 | +约 610 行 | ⬜ 未开始 |

**回滚**：产物始终是标准文件，回滚 = 切回上一 tag 后重新跑 `node install.mjs` 并重启 DSH。

## S0 基线（2026-11-08 实测，G 盘 open-source 仓库）

运行时 7 个文件的 SHA256（S0 前后保持不变，可用 `sha256sum` 复核）：

| 文件 | 行数 | SHA256 |
|---|---|---|
| `index.js` | 1823 | `2fc0c0216a2ba611cf9f2e2feae8bf7bfaf5e1c00cec8b3f22a78a4758f1f864` |
| `client.js` | 4212 | `0077a602b081cdf0c8c47a12653296db4756e5fd54772a9dae16f9ae3453ab4b` |
| `session-index.js` | 187 | `8836a6f74aa4ec53915e402f175a926c52e16dbd9b6b2ae8d51dc826c2a12ed0` |
| `cordis.patch.yml` | — | `331894a9bdd78ce05b4228e6c1cb59a0cbc27344c064073c43137863c6809955` |
| `locale/zh.json` | — | `4f0736207cf0f0da2fb9fe426edd79dcb3f74051903fcffd23ee839fa781b487` |
| `locale/en.json` | — | `f5226736aa9cbfee945089dbc3e14d3973394a3dffeaaddf919b4fe2ef583a47` |
| `icon.svg` | — | `07393b05bc65b1672838b582f7280be88f3c1224da0a4980ead466f7c3b59d7e` |

> 注：`sha256sum` 在 Git Bash 下输出 `*` 表示二进制模式读取；仓库 `.gitattributes` 会把 CRLF 归一成 LF，
> 因此本地文件与远端 main 可能有换行差异但内容一致（2026-11-08 用 `git diff --ignore-cr-at-eol FETCH_HEAD` 验证为零差异）。

## 行号映射表（S1 / S2 逐项补）

| 旧位置 | 职责 | 新位置 | 完成阶段 |
|---|---|---|---|
| `index.js:619-802` | 资产自动分类（输入 / 中间 / 最终） | `host/classify.js`（71 行） | ✅ S1 |
| `index.js:1484` | `new URL(req.url, 'http://dsh.internal')` 路由解析 | `host/http.js` | ✅ S1 |
| `index.js:19-137` | 常量与默认值（ROUTE / DEFAULTS / 工具集） | `host/constants.js`（149 行） | ✅ S1 |
| `index.js:278-383` | 底层工具（isInside / readHead / 图片尺寸） | `host/fsutil.js`（137 行） | ✅ S1 |
| `index.js:91-435` | 设置读写 + 根目录探测 + 配置解析 | `host/settings.js`（226 行） | ✅ S1 |
| `index.js:478-627` | 会话日志读取（zstd 多帧） | `host/session.js`（193 行） | ✅ S1 |
| `index.js:654-803` | 资产分类 | `host/classify.js`（71 行） | ✅ S1 |
| `index.js:1224` | 按对话分组 | `host/groups.js`（93 行） | ✅ S1 |
| `index.js:679-938` | 扫描与分页 | `host/scan.js`（531 行） | ✅ S1 |
| `index.js:1310-1398` | Range / 流式 / MIME | `host/media.js`（123 行） | ✅ S1 |
| `index.js:1420-1824` | JSON 响应 + 两条路由注册 | `host/http.js`（约 300 行） | ✅ S1 |
| `session-index.js`（187 行） | 会话索引 | `host/session-index.js`（根级留 re-export） | ✅ S1 |
| `index.js:1430-1432` | inject + apply | 根 `index.js`（**34 行薄入口**） | ✅ S1 |
| `client.js:55-380` | 中英 UI 字典（325 行） | `src/client/01-i18n.js`（**仍是 JS 对象字面量，未抽成 JSON**） | S2 |
| `client.js:4128` | `ComposerButton`（仅打开画廊入口） | `src/client/12-entry.js` | S2 |
| `client.js` 内联 CSS 994 行 | 主题样式 | `src/client/03-theme.js` | S2 |


### S2 分片映射（client.js 4213 行 → src/client/ 13 分片）

| 分片 | 原 client.js 行号 | 行数 | 职责 |
|---|---|---|---|
| `00-head.js` | L1-L53 + 新增 | 68 | 包裹头 + 常量 |
| `01-i18n.js` | L55-L379 | 325 | zh/en 字典 |
| `02-util.js` | L381-L557 | 175 | 格式化/压缩/限流 |
| `03-theme.js` | L558-L1551（→ styles.css） | 6 | CSS 占位 |
| `04-paths.js` | L1552-L1621 | 70 | 路径与路由助手 |
| `05-ctxmenu.js` | L1622-L1740 | 119 | ContextMenu + ConfirmDialog |
| `06-media.js` | L1741-L2102 | 362 | MediaCard + MediaPlayer |
| `07-cards.js` | L2103-L2295 | 193 | mediaUrlOf + FileCard + Card |
| `08-viewer.js` | L2296-L2887 | 592 | TEXT_EXTS + Viewer |
| `09-settings.js` | L2888-L3142 | 255 | SettingsPanel |
| `10-body.js` | L3143-L3896 | 754 | GalleryBody |
| `11-chrome.js` | L3897-L4104 | 208 | Pager + ScrollRail |
| `12-entry.js` | L4105-L4212 | 108 | 标题/入口 + 导出 |
| `styles.css` | L559-L1550（CSS 内容） | 994 | 面板样式 |

**做 S3 时按旧行号找代码已失效** —— 请按上面的职责列去 `src/client/` 下找，或
`grep -n "关键词" src/client/*.js`。

## 硬约束（改结构前必读）

1. `dsh-client-modules/lib/index.js:181` 要求 `exports["./client"]` 是**单个字符串**；`:587` 每包只映射一个 bundle →
   **`client.js` 必须是单文件**，源码分模块只能靠构建时拼接，不能拆多入口。
2. `install.mjs` 从 S0 起按 `package.json` 的 `files` 白名单复制；新增运行时目录（如 `host/`）
   **必须同时加进 `files`**，否则装完插件加载失败。
3. `cordis.patch.yml` 顶层必须是数组（`- insert:`），写成对象插件会从面板消失 —— `check.mjs` 第 04 项盯这个。
4. 产物必须提交进 git：Release zip / npm 包 / install.mjs 用的都是产物，用户不会先跑构建。
   `node scripts/build.mjs --check` 负责挡住「改了源码忘了 build」。

## 尚未启用 / 未实测

- `scripts/build.mjs` 的 S2 拼接分支**已启用并实测**：`npm run build` 会生成
  `client.js`（13 分片拼接 + `styles.css` 内联 + `protocol.js` 剥 export 注入）
  与 `host/protocol.js`；`--check` 已验证产物与源码逐字节一致。
- `scripts/check.mjs` 的 **16 项已启用并全过**（13 分片顺序递增、分片存在、
  shared 常量在 client 与 host 两侧值一致、无残留占位符）；
  **仅 17（seam schema）/ 18（marks 原子写）待 S3 启用**。
