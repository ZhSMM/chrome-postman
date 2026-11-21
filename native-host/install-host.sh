#!/usr/bin/env bash
#
# 注册 Chrome Postman 的 Native Messaging 伴生程序（Linux / macOS）。
#
# 【这个脚本做什么】
#   1. 把 bridge.mjs 和 host manifest 复制到浏览器约定的目录
#   2. 给 bridge.mjs 加上可执行权限（Chrome 在 POSIX 上要求脚本有 shebang + 可执行位）
#   3. 把 manifest 里的 allowed_origins 换成你真实的扩展 ID
#      【为什么必须精确到扩展 ID】Chrome 不允许通配符，写错了扩展连不上伴生程序。
#   4. 顺带修好 manifest 里 path 字段（POSIX 上必须是绝对路径）
#
# 【两种用法】
#   ./install-host.sh -ExtensionId abcdefghijklmnopabcdefghijklmnop
#   ./install-host.sh --extension-id abcdefghijklmnopabcdefghijklmnop
#
# 【装完必须完全退出并重启 Chrome】Chrome 只在启动时读取这些目录，运行中改不会立刻生效。
#
set -euo pipefail

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------

EXTENSION_ID=""
HOST_NAME="com.chrome_postman.bridge"

usage() {
  cat <<'EOF'
用法: ./install-host.sh -ExtensionId <扩展ID>

  -ExtensionId, --extension-id   Chrome 扩展 ID（32 位，只含 a-p）
  -h, --help                     显示本帮助

拿 ID 的方法:
  1. 浏览器打开 chrome://extensions
  2. 找到 "Chrome Postman"，打开「开发者模式」
  3. 复制卡片上的「ID」
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -ExtensionId|--extension-id)
      [ $# -ge 2 ] || { echo "✗ $1 后面缺少扩展 ID" >&2; exit 1; }
      EXTENSION_ID="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "✗ 未知参数：$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------

if [ -z "$EXTENSION_ID" ]; then
  echo "" >&2
  echo "✗ 缺少扩展 ID。Chrome 不允许在 allowed_origins 里使用通配符，必须写死你的扩展 ID。" >&2
  echo "" >&2
  usage >&2
  exit 1
fi

# Chrome 扩展 ID 固定是 32 个 a-p 字符
if ! printf '%s' "$EXTENSION_ID" | grep -Eq '^[a-p]{32}$'; then
  echo "✗ 扩展 ID 格式不对：'$EXTENSION_ID'" >&2
  echo "  扩展 ID 必须是 32 个字符，且只能包含 a-p。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 找不到 node 命令，伴生程序需要 Node.js 18 以上版本。" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_SRC="$SCRIPT_DIR/bridge.mjs"
MANIFEST_SRC="$SCRIPT_DIR/$HOST_NAME.json"

for f in "$BRIDGE_SRC" "$MANIFEST_SRC"; do
  if [ ! -f "$f" ]; then
    echo "✗ 找不到文件：$f" >&2
    echo "  请在 native-host/ 目录下运行这个脚本。" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 决定安装目录
#
# 【各浏览器的查找顺序】
#   Chrome 会依次找下面几个目录，第一个命中的生效，所以同一个浏览器只需要装一份。
# ---------------------------------------------------------------------------

detect_target_dir() {
  case "$(uname -s)" in
    Darwin)
      # macOS
      local candidates=(
        "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
        "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
      )
      ;;
    *)
      # Linux
      local candidates=(
        "$HOME/.config/google-chrome/NativeMessagingHosts"
        "$HOME/.config/chromium/NativeMessagingHosts"
        "$HOME/.config/microsoft-edge/NativeMessagingHosts"
      )
      ;;
  esac
  # 装到第一个已经存在的那个（说明用户真的在用这个浏览器）；都不存在就用 Chrome 的
  for d in "${candidates[@]}"; do
    if [ -d "$(dirname "$d")" ]; then
      echo "$d"
      return
    fi
  done
  echo "${candidates[0]}"
}

TARGET_DIR="$(detect_target_dir)"
TARGET_MANIFEST="$TARGET_DIR/$HOST_NAME.json"

echo "✓ Node.js：$(command -v node)"
echo "✓ 安装目录：$TARGET_DIR"

mkdir -p "$TARGET_DIR"

# ---------------------------------------------------------------------------
# 复制文件 + 加执行权限
# ---------------------------------------------------------------------------

cp -f "$BRIDGE_SRC" "$TARGET_DIR/bridge.mjs"
chmod +x "$TARGET_DIR/bridge.mjs"
echo "✓ 已安装 bridge.mjs（已加可执行权限）"

# ---------------------------------------------------------------------------
# 改写 manifest
#
# 【为什么用 sed 而不是别的】
#   只需要替换两个确定的位置，sed 够用，而且不依赖 python/jq。
#   path 要换成绝对路径：POSIX 上 Chrome 只认绝对路径。
# ---------------------------------------------------------------------------

sed \
  -e "s|REPLACE_WITH_YOUR_EXTENSION_ID|$EXTENSION_ID|g" \
  -e "s|\"path\": *\"bridge.mjs\"|\"path\": \"$TARGET_DIR/bridge.mjs\"|" \
  "$MANIFEST_SRC" > "$TARGET_MANIFEST"

echo "✓ 已写入 allowed_origins：chrome-extension://$EXTENSION_ID/"
echo "✓ 已写入 path：$TARGET_DIR/bridge.mjs"

# ---------------------------------------------------------------------------
# 收尾提示
# ---------------------------------------------------------------------------

echo ""
echo "安装完成！接下来：" 
echo "  1. 完全退出 Chrome（关掉所有窗口，不只是关标签页）"
echo "  2. 重新打开 Chrome"
echo "  3. 在扩展里打开「跳过证书校验」开关，它会显示「本地桥接 v1.0.0 已就绪」"
echo ""
echo "排查："
echo "  cat \"$TARGET_MANIFEST\""
echo "  \"$TARGET_DIR/bridge.mjs\" < /dev/null"
echo ""
