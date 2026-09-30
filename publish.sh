#!/usr/bin/env bash
# publish.sh — 写稿 → 部署 一条命令
#
#   bash publish.sh "文章标题"        # 新建一篇（自动带好 front-matter）
#   bash publish.sh --preview         # 本地预览（改完随手看）
#   bash publish.sh --push "说明"     # 提交 + 推送 + 部署上线
#   bash publish.sh --check           # 上线前自检，不推任何东西
#
# 设计原则：**默认什么都不做危险的**。只有 --push 才碰远程，
# 而且推送前强制自检，自检不过直接中止。
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"

# 占位 / 测试文件的前缀，上线前必须为空（否则会被搜索引擎抓走）
BLOCKED_PREFIXES=("tmp-ph-" "tmp-wallpaper-test")
PORT="${PREVIEW_PORT:-4000}"

# --- 颜色（管道里自动降级） -------------------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YEL=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  B=""; DIM=""; RED=""; GRN=""; YEL=""; CYN=""; RST=""
fi

ok()   { echo "  ${GRN}✓${RST} $*"; }
warn() { echo "  ${YEL}!${RST} $*"; }
die()  { echo "${RED}✗ $*${RST}" >&2; exit 1; }
step() { echo; echo "${B}${CYN}▸ $*${RST}"; }

# --- 找 wrangler -------------------------------------------------------------
find_wrangler() {
  if [ -n "${WRANGLER_BIN:-}" ]; then echo "$WRANGLER_BIN"; return; fi
  local managed="C:/Users/29537/.workbuddy/binaries/node/workspace/node_modules/wrangler/wrangler-dist/cli.js"
  local nodeexe="C:/Users/29537/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
  if [ -f "$managed" ] && [ -f "$nodeexe" ]; then echo "$nodeexe $managed"; return; fi
  if [ -x node_modules/.bin/wrangler ]; then echo "node_modules/.bin/wrangler"; return; fi
  echo ""
}

# --- 扫描会被误上线的占位/测试文件 -------------------------------------------
scan_blocked() {
  local hits=""
  for p in "${BLOCKED_PREFIXES[@]}"; do
    while IFS= read -r f; do
      [ -n "$f" ] && hits="$hits$f"$'\n'
    done < <(find source/_posts -name "${p}*" -type f 2>/dev/null)
  done
  # 顺带查出被它们引用的测试图
  while IFS= read -r d; do
    [ -n "$d" ] && hints="${hints:-}${d}"$'\n'
  done < <(find source/images/posts -maxdepth 1 -type d \( -name 'tmp-*' \) 2>/dev/null)
  printf '%s' "$hits"
}

# =============================================================================
# 1) 新建文章
# =============================================================================
new_post() {
  local title="$1"
  [ -z "$title" ] && die "用法：bash publish.sh \"文章标题\""
  command -v node >/dev/null 2>&1 || true
  ./node_modules/.bin/hexo new "$title"
  # 找出刚生成的文件（最新修改的那个 .md）
  local f
  f="$(ls -t source/_posts/*.md | head -1)"
  step "新文章已创建"
  ok "$f"
  echo
  echo "${DIM}接下来：${RST}"
  echo "  1. 编辑上面这个文件（title / date 已填好）"
  echo "  2. 正文里插图：${CYN}python tools/add-image.py 图片.png --slug $(basename "$f" .md)${RST}"
  echo "  3. 想看效果：${CYN}bash publish.sh --preview${RST}"
  echo "  4. 满意后发布：${CYN}bash publish.sh --push \"写一句说明\"${RST}"
  echo
  echo "${DIM}可选 front-matter：${RST}"
  echo "  description: 一句话摘要（首页预览用）"
  echo "  wallpaper:   /images/posts/<slug>/xxx.webp   # 本页背景壁纸 + 首页预览封面"
  echo "  categories:  - DEVLOG                        # 决定首页分组"
}

# =============================================================================
# 2) 本地预览
# =============================================================================
preview() {
  step "构建"
  rm -rf public db.json
  ./node_modules/.bin/hexo generate >/dev/null 2>&1 || die "构建失败，跑 ./node_modules/.bin/hexo generate 看详情"
  ok "产物 $(find public -type f | wc -l) 个文件"

  local blocked
  blocked="$(scan_blocked)"
  if [ -n "$blocked" ]; then
    warn "检测到占位/测试文章（预览无妨，但 --push 会上线）："
    echo "$blocked" | sed 's/^/      /'
  fi

  step "本地服务"
  echo "  ${B}http://127.0.0.1:$PORT${RST}"
  echo "  ${DIM}Ctrl+C 停止${RST}"
  echo
  local py="C:/Users/29537/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
  [ -x "$py" ] || py="python"
  exec "$py" -m http.server "$PORT" --directory public
}

# =============================================================================
# 3) 上线前自检
# =============================================================================
run_checks() {
  local fail=0
  step "上线前自检"

  # 3.1 占位文件
  local blocked
  blocked="$(scan_blocked)"
  if [ -n "$blocked" ]; then
    echo "${RED}  ✗ 发现占位/测试文章，拒绝上线：${RST}"
    echo "$blocked" | sed 's/^/      /'
    echo "      ${DIM}清理：rm source/_posts/tmp-ph-*.md source/_posts/tmp-wallpaper-test*.md${RST}"
    echo "      ${DIM}测试图：rm -rf source/images/posts/tmp-*${RST}"
    fail=1
  else
    ok "无占位/测试文章"
  fi

  # 3.2 date 字段（缺失会让 Hexo 用 mtime，CI 上日期漂移）
  local missing
  missing="$(grep -L '^date:' source/_posts/*.md 2>/dev/null || true)"
  if [ -n "$missing" ]; then
    echo "${RED}  ✗ 以下文章缺 date: 字段（日期会漂移）：${RST}"
    echo "$missing" | sed 's/^/      /'
    fail=1
  else
    ok "所有文章都有 date:"
  fi

  # 3.3 构建
  # Hexo 的坑：YAML / 模板出错时它只打印 "ERROR Process failed: xxx.md"，
  # **退出码仍然是 0**，而且那行 ERROR 淹没在几百行 "INFO Generated" 里。
  # 结果就是残缺站点静默上线（首页少文章、页面没生成）。所以这里不能只看
  # 退出码，必须把输出抓下来自己找 ERROR，并核对产物数量是否合理。
  rm -rf public db.json
  local build_log build_rc
  build_log="$(./node_modules/.bin/hexo generate 2>&1)" && build_rc=0 || build_rc=$?

  local errs
  errs="$(printf '%s\n' "$build_log" | grep -E '^ERROR|Process failed|Error:' || true)"
  if [ -n "$errs" ]; then
    echo "${RED}  ✗ 构建报告了错误（Hexo 退出码是 $build_rc，但内容不可信）：${RST}"
    printf '%s\n' "$errs" | head -12 | sed 's/^/      /'
    fail=1
  fi

  local nfiles full_log
  nfiles="$(find public -type f 2>/dev/null | wc -l | tr -d ' ')"
  full_log="$(printf '%s\n' "$build_log" | grep -oE '[0-9]+ files generated' | grep -oE '[0-9]+' | tail -1)"
  if [ "$build_rc" != "0" ]; then
    echo "${RED}  ✗ 构建退出码 $build_rc${RST}"; fail=1
  elif [ -n "$errs" ]; then
    : # 上面已报
  elif [ "${full_log:-0}" -lt 20 ]; then
    echo "${RED}  ✗ 只生成了 ${full_log:-0} 个文件（预期 ≥20），产物可能残缺${RST}"; fail=1
  else
    ok "构建成功（${full_log} 个文件生成，产物 ${nfiles} 个）"
  fi

  # 3.3b 文章数是否与源文件一致（防止「少了文章却没人发现」）
  if [ -f public/index.html ] && [ "$build_rc" = "0" ]; then
    local src_posts page_posts
    src_posts="$(ls source/_posts/*.md 2>/dev/null | wc -l | tr -d ' ')"
    page_posts="$(grep -c 'class="stream-row"' public/index.html 2>/dev/null || echo 0)"
    # 首页列出的是全部文章（per_page: 0），两者应一致
    if [ "$src_posts" != "$page_posts" ]; then
      echo "${RED}  ✗ 源文件 ${src_posts} 篇，首页只列出 ${page_posts} 篇 —— 有文章没渲染出来${RST}"
      fail=1
    else
      ok "文章数一致（${src_posts} 篇全部渲染）"
    fi
  fi

  # 3.4 CNAME（历史上被写成过 willow.site，少 xi）
  if [ -f public/CNAME ]; then
    local cn; cn="$(cat public/CNAME)"
    if [ "$cn" = "willowxi.site" ]; then ok "CNAME = willowxi.site"
    else echo "${RED}  ✗ CNAME 内容异常：[${cn}]${RST}"; fail=1; fi
  else
    warn "public/CNAME 不存在"
  fi

  # 3.5 关键产物
  for f in index.html 404.html _headers; do
    [ -f "public/$f" ] && ok "产物含 $f" || { echo "${RED}  ✗ 产物缺 $f${RST}"; fail=1; }
  done

  # 3.6 _headers 换行符（CRLF 会让 CF 解析失败）
  if [ -f source/_headers ] && grep -q $'\r' source/_headers 2>/dev/null; then
    echo "${RED}  ✗ source/_headers 含 CRLF，Cloudflare 会解析失败${RST}"; fail=1
  else
    ok "_headers 换行符正常（LF）"
  fi

  # 3.7 wrangler 与令牌
  local wr; wr="$(find_wrangler)"
  [ -n "$wr" ] && ok "wrangler 就绪" || { echo "${RED}  ✗ 找不到 wrangler${RST}"; fail=1; }
  if [ -f "$HOME/.cf/willowxi-pages-deploy.token" ]; then ok "部署令牌就绪"
  else warn "未找到 $HOME/.cf/willowxi-pages-deploy.token"; fi

  if [ "$fail" != "0" ]; then
    return 1
  fi
  return 0
}

# =============================================================================
# 4) 提交 + 推送 + 部署
# =============================================================================
push_live() {
  local msg="${1:-}"
  run_checks || die "自检未通过，已中止（没有推送任何东西）"

  step "变更预览"
  git status --short | sed 's/^/  /'
  if [ -z "$(git status --porcelain)" ]; then
    warn "工作区没有变更，只做部署"
  fi

  if [ -n "$(git status --porcelain)" ]; then
    [ -z "$msg" ] && die "有变更需要提交，请给一句说明：bash publish.sh --push \"说明\""
    local stamp="backup-before-$(date +%Y%m%d-%H%M%S)"
    git add -A
    git commit -q -m "$msg"
    ok "已提交：$(git log --oneline -1)"

    step "还原点"
    git tag -f "$stamp" HEAD~1 >/dev/null 2>&1 || true
    if git push -q origin "$stamp" 2>/dev/null; then ok "tag $stamp（推送前状态）"
    else warn "tag $stamp 本地已建，推送失败（不影响主流程）"; fi

    git push origin main 2>&1 | tail -2 | sed 's/^/  /'
    ok "已推送 origin/main"
  fi

  step "部署到 Cloudflare Pages"
  local wr; wr="$(find_wrangler)"
  WRANGLER_BIN="$wr" bash deploy-cf.sh --no-clean 2>&1 | grep -E 'Uploading|Success|Deployment complete|_headers|完成|文件数' | sed 's/^/  /'
  ok "部署完成"

  echo
  echo "${B}${GRN}线上地址：https://willowxi.site${RST}"
  echo "${DIM}缓存已设为跟随源站，改样式后立刻生效。${RST}"
}

# =============================================================================
case "${1:-}" in
  "")           new_post "" ;;
  --preview|-p) preview ;;
  --check|-c)   if run_checks; then echo; echo "${GRN}自检全部通过，可以 --push 了${RST}"
                else echo; echo "${RED}自检未通过，先修上面的问题${RST}"; exit 1; fi ;;
  --push)       push_live "${2:-}" ;;
  -h|--help)
    cat <<'EOF'
publish.sh — 写稿到部署，一条命令

  bash publish.sh "文章标题"        新建文章（自动生成 front-matter）
  bash publish.sh --preview         本地预览 http://127.0.0.1:4000
  bash publish.sh --check           上线前自检（不推任何东西）
  bash publish.sh --push "说明"     自检 → 提交 → 还原点 → 推送 → 部署

典型流程：
  bash publish.sh "又一次重构首页"
  #  …编辑 source/_posts/…md…
  bash publish.sh --preview          # 看效果
  bash publish.sh --push "新增一篇文章"   # 上线

自动拦下的坑：
  · 占位/测试文章（tmp-ph-* / tmp-wallpaper-test*）混上线
  · 文章缺 date: 导致日期漂移
  · CNAME 写错（历史事故：willow.site 少 xi）
  · _headers 被 CRLF 破坏
  · 构建失败 / 缺 404.html
EOF
    ;;
  *)            new_post "$1" ;;
esac
