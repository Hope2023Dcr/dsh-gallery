#!/usr/bin/env bash
# 本地校验脚本 —— 薄包装，真正的校验逻辑在 scripts/check.mjs
#
# 用法：
#   ./check.sh              # 全部静态检查 + 契约测试 + install --dry-run
#   ./check.sh --install    # 额外验证安装脚本（临时目录实测，较慢）
#
# 保留这个入口是为了兼容 CONTRIBUTING.md 与 pre-commit 钩子里的既有用法。
# 为什么不是 GitHub Actions？本仓库的细粒度 token 没有 Workflows 写入权限。

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

exec "$NODE" scripts/check.mjs "$@"
