#!/bin/bash
# Yousj 短视频 Linux 客户端 — 一键编译 + 打包 .deb
# 依赖（构建时）：gcc、pkg-config、libgtk-3-dev、libwebkit2gtk-4.1-dev、python3+PIL、dpkg-deb
# 若系统没装开发包，但同目录 .tools/root 下有解压好的 deb 树（沙箱构建用），会自动回退引用它。
set -euo pipefail
cd "$(dirname "$0")"

PKG_NAME="yousj-video"
PKG_VERSION="1.0"
PKG_ARCH="amd64"
BUILD_DIR="build"
DIST_DIR="dist"
TOOLS_ROOT=".tools/root"

EXTRA_CFLAGS=""
EXTRA_LIBS=""
PKGC_CFLAGS=""
PKGC_LIBS=""
if pkg-config --exists webkit2gtk-4.1 gtk+-3.0 2>/dev/null; then
    echo "使用系统开发包：webkit2gtk-4.1 $(pkg-config --modversion webkit2gtk-4.1) / gtk+-3.0 $(pkg-config --modversion gtk+-3.0)"
elif [ -d "$TOOLS_ROOT/usr/lib/x86_64-linux-gnu/pkgconfig" ]; then
    export PKG_CONFIG_PATH="$PWD/$TOOLS_ROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$PWD/$TOOLS_ROOT/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
    EXTRA_LIBS="-L$PWD/$TOOLS_ROOT/usr/lib/x86_64-linux-gnu -Wl,-rpath-link,$PWD/$TOOLS_ROOT/usr/lib/x86_64-linux-gnu"
    echo "系统无开发包，回退本地 deb 解压树：$TOOLS_ROOT（webkit2gtk-4.1 $(pkg-config --modversion webkit2gtk-4.1)）"
else
    echo "缺少开发包：请先安装 libgtk-3-dev libwebkit2gtk-4.1-dev（Debian/Ubuntu: sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev）" >&2
    exit 1
fi

mkdir -p "$BUILD_DIR" "$DIST_DIR"

echo "== 生成图标 =="
python3 src/gen_icon.py

echo "== 编译 =="
PKGC_CFLAGS="$(pkg-config --cflags gtk+-3.0 webkit2gtk-4.1)"
PKGC_LIBS="$(pkg-config --libs gtk+-3.0 webkit2gtk-4.1)"
if [ -n "$EXTRA_LIBS" ]; then
    # 回退模式：.pc 里的 -I/usr/... 指向系统路径（不存在），逐条映射到解压树下并排在前面；
    # 原路径保留兜底（glibconfig.h 等只在系统里的头文件仍能找到）。
    for flag in $PKGC_CFLAGS; do
        case "$flag" in
            -I/usr/*) EXTRA_CFLAGS="$EXTRA_CFLAGS -I$PWD/$TOOLS_ROOT${flag#-I}" ;;
        esac
    done
fi
# shellcheck disable=SC2086
gcc -O2 -Wall -Wextra -o "$BUILD_DIR/YousjVideo" src/main.c \
    $EXTRA_CFLAGS $PKGC_CFLAGS \
    $EXTRA_LIBS $PKGC_LIBS
file "$BUILD_DIR/YousjVideo"

echo "== 组装 .deb =="
STAGE="$BUILD_DIR/pkgroot"
rm -rf "$STAGE"
mkdir -p "$STAGE/opt/yousj-video" \
         "$STAGE/usr/share/applications" \
         "$STAGE/DEBIAN"
for size in 256 128 64 48; do
    mkdir -p "$STAGE/usr/share/icons/hicolor/${size}x${size}/apps"
    cp "src/icons/yousj-video-${size}.png" "$STAGE/usr/share/icons/hicolor/${size}x${size}/apps/yousj-video.png"
done
install -m 0755 "$BUILD_DIR/YousjVideo" "$STAGE/opt/yousj-video/YousjVideo"
cp "src/icons/yousj-video-256.png" "$STAGE/opt/yousj-video/icon.png"
install -m 0644 src/yousj-video.desktop "$STAGE/usr/share/applications/yousj-video.desktop"

INSTALLED_KB=$(du -sk "$STAGE" | cut -f1)
cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG_NAME
Version: $PKG_VERSION
Section: net
Priority: optional
Architecture: $PKG_ARCH
Installed-Size: $INSTALLED_KB
Maintainer: Yousj <hello@yousj.cc>
Depends: libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0, libc6
Homepage: https://video.yousj.cc
Description: Yousj 短视频 Linux 桌面客户端
 类抖音短视频应用的 Linux 桌面壳（GTK3 + WebKitGTK），
 打开即加载 https://video.yousj.cc/，与网页版功能一致。
EOF

DEB_OUT="$DIST_DIR/${PKG_NAME}_${PKG_VERSION}_${PKG_ARCH}.deb"
# 工作区目录带 setgid 2770，dpkg-deb 要求 DEBIAN 目录权限在 0755..0775 内，统一规整
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f ! -name YousjVideo -exec chmod 0644 {} +
chmod 0644 "$STAGE/DEBIAN/control"
dpkg-deb --build --root-owner-group "$STAGE" "$DEB_OUT"
echo "== 完成 =="
ls -la "$DEB_OUT"
dpkg-deb --info "$DEB_OUT" | head -12
