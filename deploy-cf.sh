#!/usr/bin/env bash
# 一键发布到 Cloudflare Pages
#   hexo clean -> hexo generate -> wrangler pages deploy
#
# 用法：
#   bash deploy-cf.sh
#
# 令牌来源（按优先级）：
#   1) 环境变量 CLOUDFLARE_API_TOKEN
#   2) 文件 $HOME/.cf/willowxi-pages-deploy.token
#
# wrangler 来源（按优先级）：
#   1) 环境变量 WRANGLER_BIN
#   2) 仓库内 node_modules/.bin/wrangler（若已 npm i -D wrangler）
#   3) npx --yes wrangler@4（联网下载）
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
PROJECT="willowxi"
BRANCH="main"
TOKEN_FILE="${CLOUDFLARE_TOKEN_FILE:-$HOME/.cf/willowxi-pages-deploy.token}"

# ---------- 令牌 ----------
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  :
elif [ -f "$TOKEN_FILE" ]; then
  CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
else
  echo "错误：找不到 Cloudflare API 令牌。" >&2
  echo "  请设置环境变量 CLOUDFLARE_API_TOKEN，或把令牌写入：$TOKEN_FILE" >&2
  exit 1
fi
export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-a563c8f9badbf26807b7f7ef0f066452}"

cd "$REPO"

# ---------- wrangler ----------
WR=""
if [ -n "${WRANGLER_BIN:-}" ]; then
  WR="$WRANGLER_BIN"
elif [ -x node_modules/.bin/wrangler ] && node_modules/.bin/wrangler --version >/dev/null 2>&1; then
  WR="node_modules/.bin/wrangler"
else
  WR="npx --yes wrangler@4"
fi
echo "==> wrangler：$WR"

# ---------- 构建 ----------
# 默认始终 clean：hexo generate 不清理 public/，不 clean 会把旧文件（例如写错的 CNAME）
# 一起发布上线。--no-clean 仅用于调试/重部署，日常发布不要用。
if [ "${1:-}" = "--no-clean" ]; then
  echo "==> 跳过 clean（--no-clean）"
  npm run build
else
  echo "==> 清理并构建"
  npm run clean
  npm run build
fi

echo "==> 产物自检"
FILES=$(find public -type f | wc -l)
echo "    文件数：$FILES"
if [ ! -f public/index.html ]; then
  echo "    错误：public/index.html 缺失，构建可能失败" >&2
  exit 1
fi
echo "    CNAME：[$(cat public/CNAME 2>/dev/null)]"

# ---------- 发布 ----------
echo "==> 发布到 Cloudflare Pages（项目 $PROJECT / 分支 $BRANCH）"
$WR pages deploy public --project-name "$PROJECT" --branch "$BRANCH" --commit-dirty=true

echo "==> 完成。生产地址：https://$PROJECT.pages.dev"
