#!/usr/bin/env bash
# 本地校验脚本 —— 提交前跑一遍，能挡住绝大多数低级问题
#
# 用法：
#   ./check.sh              # 跑全部检查
#   ./check.sh --install    # 额外验证安装脚本（较慢）
#
# 为什么不是 GitHub Actions？
#   本仓库作者使用的细粒度 token 没有 Workflows 写入权限，
#   无法推送 .github/workflows/ 下的文件。于是把 CI 逻辑落成本地脚本，
#   效果等价，只是需要手动触发（或挂到 pre-commit hook，见文末）。
#
# 对应检查项（与原来 CI 完全一致）：
#   1. 两个主文件语法
#   2. package.json 必填字段
#   3. ⚠️ cordis.patch.yml 顶层必须是数组（最高优先级，坏了插件会消失）
#   4. locale 是合法 JSON 且含 meta.title
#   5. 零第三方运行时依赖
#   6. 无硬编码盘符路径
#   7.（可选）安装脚本实测

set -u

# 找 node：优先 PATH；其次 DSH 桌面版自带的运行时；也可用 NODE 环境变量显式指定
if [ -n "${NODE:-}" ] && [ -x "${NODE:-}" ]; then
  : # 已被调用方指定
elif command -v node >/dev/null 2>&1; then
  NODE="node"
else
  NODE=""
  for cand in \
    "/d/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe" \
    "/c/Program Files/nodejs/node.exe" \
    "/c/Program Files (x86)/nodejs/node.exe"
  do
    if [ -x "$cand" ]; then NODE="$cand"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  echo "找不到 node。三种解法："
  echo "  1) 安装 Node.js"
  echo "  2) 把 node 所在目录加进 PATH"
  echo "  3) 显式指定：NODE=/path/to/node ./check.sh"
  exit 2
fi
echo "使用 node: $NODE"

WITH_INSTALL=0
if [ "${1:-}" = "--install" ]; then WITH_INSTALL=1; fi

PASS=0
FAIL=0

ok()   { echo "  PASS $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
head_() { echo ""; echo "=== $1 ==="; }

# ---------- 1. 语法 ----------
head_ "1. 语法检查"
"$NODE" --check index.js 2>/dev/null && ok "index.js" || bad "index.js 语法错误"
"$NODE" --check client.js 2>/dev/null && ok "client.js" || bad "client.js 语法错误"
if [ -f install.mjs ]; then
  "$NODE" --check install.mjs 2>/dev/null && ok "install.mjs" || bad "install.mjs 语法错误"
fi

# ---------- 2. package.json ----------
head_ "2. package.json 字段"
"$NODE" -e '
  const pkg = require("./package.json");
  const need = ["name","version","type","exports","dsh"];
  for (const k of need) {
    if (pkg[k] === undefined) { console.error("缺少字段: " + k); process.exit(1); }
  }
  if (!pkg.dsh.bundle || !pkg.dsh.bundle.patch) { console.error("dsh.bundle.patch 缺失"); process.exit(1); }
  if (!pkg.dsh.client) { console.error("dsh.client 缺失"); process.exit(1); }
  console.log("version = " + pkg.version);
' 2>&1 | tail -1
if [ $? -eq 0 ]; then ok "必填字段完整"; else bad "缺字段"; fi

# ---------- 3. cordis.patch.yml 顶层结构（最要紧）----------
head_ "3. cordis.patch.yml 顶层必须是数组"
# YAML 解析器不一定有，用结构启发式 + 明确的失败提示
FIRST_LINE=""
while IFS= read -r line; do
  trimmed="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  case "$trimmed" in
    ""|\#*) continue ;;
    *) FIRST_LINE="$trimmed"; break ;;
  esac
done < cordis.patch.yml

echo "  首个有效行: $FIRST_LINE"
case "$FIRST_LINE" in
  -*)
    ok "顶层是数组（以 - 开头）"
    ;;
  insert:*)
    bad "顶层是对象！必须写成 '- insert:'（少一个减号，插件会从面板消失）"
    ;;
  *)
    bad "顶层结构异常，应为 '- insert:'"
    ;;
esac

if grep -q "name: 'dsh-gallery'" cordis.patch.yml; then
  ok "条目 name 正确"
else
  bad "条目 name 不是 'dsh-gallery'"
fi

# ---------- 4. locale ----------
head_ "4. locale 合法 JSON"
for f in locale/zh.json locale/en.json; do
  if [ -f "$f" ]; then
    if "$NODE" -e "
      const j = require('./$f');
      if (!j.meta || !j.meta.title) { process.exit(1); }
    " 2>/dev/null; then
      ok "$f 含 meta.title"
    else
      bad "$f 缺少 meta.title 或不是合法 JSON"
    fi
  else
    bad "$f 不存在"
  fi
done

# ---------- 5. 零依赖 ----------
head_ "5. 零第三方运行时依赖"
if "$NODE" -e '
  const pkg = require("./package.json");
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) { process.exit(1); }
' 2>/dev/null; then
  ok "无 dependencies"
else
  bad "存在 dependencies（本插件应保持零依赖）"
fi

# ---------- 6. 硬编码盘符 ----------
head_ "6. 无硬编码盘符路径"
# 用 node 做检测（比 shell 正则可靠，能正确处理引号/转义）
LEAK_LINES=$("$NODE" -e '
  const fs = require("node:fs");
  const files = ["index.js","client.js","package.json","cordis.patch.yml","locale/zh.json","locale/en.json","install.mjs"];
  let hits = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, "utf8");
    text.split("\n").forEach((line, i) => {
      const t = line.trim();
      // 跳过注释行
      if (t.startsWith("#") || t.startsWith("//") || t.startsWith("*") || t.startsWith("<!--")) return;
      // 找「引号内的盘符路径字面量」或「行首盘符路径」，这是会真被当成实际值的形态
      const inQuotes = /[`\x27"]([A-Za-z]:[\\/][^`\x27"]*)[`\x27"]/.test(line);
      const atStart  = /^[A-Za-z]:[\\/]/.test(t);
      // 排除正则字面量里的写法与无害的说明
      if (/RegExp|\/g\b|test\(|fromCharCode|^\/[^\/]*\/$/.test(line) && !inQuotes) return;
      if (inQuotes || atStart) {
        console.log(f + ":" + (i + 1) + "  " + t.slice(0, 70));
        hits++;
      }
    });
  }
  process.exit(hits > 0 ? 1 : 0);
' 2>&1)
LEAK_RC=$?

if [ "$LEAK_RC" -eq 0 ]; then
  ok "无硬编码盘符"
else
  bad "发现硬编码盘符路径："
  echo "$LEAK_LINES" | head -8 | sed 's/^/    /'
fi

# ---------- 7. 安装实测（可选）----------
if [ "$WITH_INSTALL" -eq 1 ]; then
  head_ "7. 安装脚本实测"
  TMPHOME="$(mktemp -d 2>/dev/null || echo "./.tmpcheck")"
  mkdir -p "$TMPHOME/profiles/desktop"
  printf '{"name":"fake","bundles":[]}' > "$TMPHOME/profiles/desktop/package.json"
  if DSH_HOME="$TMPHOME" "$NODE" install.mjs >/dev/null 2>&1; then
    ok "安装执行成功"
    TARGET="$TMPHOME/profiles/desktop/node_modules/dsh-gallery"
    if [ -f "$TARGET/index.js" ] && [ -f "$TARGET/client.js" ]; then
      ok "文件已安装"
    else
      bad "文件未安装"
    fi
    if "$NODE" -e "
      const p = require('$TMPHOME/profiles/desktop/package.json');
      if (!p.bundles.includes('dsh-gallery')) process.exit(1);
    " 2>/dev/null; then
      ok "bundle 已注册"
    else
      bad "bundle 未注册"
    fi
  else
    bad "安装脚本执行失败"
  fi
  rm -rf "$TMPHOME"
fi

# ---------- 汇总 ----------
echo ""
echo "================================"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✓ 全部通过（$PASS 项）"
  echo "================================"
  exit 0
else
  echo "  ✗ $FAIL 项失败（$PASS 项通过）"
  echo "================================"
  exit 1
fi
