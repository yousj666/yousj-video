#!/usr/bin/env bash
# Yousj 短视频 Windows 客户端 · 一键交叉编译（Linux 沙箱 -> Windows x86-64）
# 产物：dist/YousjVideo.exe + dist/WebView2Loader.dll
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
SHARED_TC="$HOME/workspace/toolchain"
TOOLS="$ROOT/.tools"
GPP_DEB_URL="http://archive.ubuntu.com/ubuntu/pool/universe/g/gcc-mingw-w64/g++-mingw-w64-x86-64-posix_13.2.0-6ubuntu1+26.1_amd64.deb"

# ---------- 1. 准备 C++ 交叉编译器 ----------
# 共享工具链 (~/workspace/toolchain) 只有 C 编译器、缺 cc1plus；
# 缺时把 Ubuntu 的 g++ deb 解压到本目录 .tools/ 补齐（只读引用共享 sysroot）。
EXTRA_FLAGS=()
if command -v x86_64-w64-mingw32-g++ >/dev/null 2>&1 && \
   echo 'int main(){}' | x86_64-w64-mingw32-g++ -x c++ - -o /dev/null 2>/dev/null; then
  CXX=x86_64-w64-mingw32-g++
else
  [ -f "$SHARED_TC/env.sh" ] && . "$SHARED_TC/env.sh"
  if [ ! -x "$TOOLS/root/usr/bin/x86_64-w64-mingw32-g++-posix" ]; then
    mkdir -p "$TOOLS"
    echo "[build] 下载 g++ 交叉工具链 deb ..."
    curl -sL -o "$TOOLS/g++.deb" "$GPP_DEB_URL"
    dpkg-deb -x "$TOOLS/g++.deb" "$TOOLS/root"
    rm -f "$TOOLS/g++.deb"
  fi
  ln -sfn "$SHARED_TC/root/usr/x86_64-w64-mingw32" "$TOOLS/root/usr/x86_64-w64-mingw32"
  CXX="$TOOLS/root/usr/bin/x86_64-w64-mingw32-g++-posix"
  GCCDIR="$SHARED_TC/root/usr/lib/gcc/x86_64-w64-mingw32/13-posix"
  EXTRA_FLAGS=(-fno-use-linker-plugin -idirafter "$GCCDIR/include" -L "$GCCDIR")
fi
WINDRES=x86_64-w64-mingw32-windres
command -v "$WINDRES" >/dev/null 2>&1 || { [ -f "$SHARED_TC/env.sh" ] && . "$SHARED_TC/env.sh"; }
echo "[build] CXX = $CXX"

# ---------- 2. WebView2 SDK（头文件 + Loader DLL） ----------
WV2="$ROOT/third_party/webview2/build/native"
if [ ! -f "$WV2/include/WebView2.h" ]; then
  echo "[build] 下载 WebView2 SDK ..."
  curl -sL -o "$ROOT/third_party/webview2.nupkg" \
    https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2903.40
  (cd "$ROOT/third_party/webview2" && unzip -o -q ../webview2.nupkg 'build/native/*')
fi

# ---------- 3. 图标 + 资源 ----------
python3 src/gen_icon.py
(cd src && "$WINDRES" -O coff -o app_res.o app.rc)

# ---------- 4. 编译 ----------
mkdir -p dist
# 注：webview 0.10 在运行时用 LoadLibrary 动态加载 WebView2Loader.dll
# （不走导入表），所以链接行不需要它，但必须把 DLL 随 exe 一起交付。
# -static 全静态链接 libgcc/libstdc++/winpthread，免得干净 Windows 缺 DLL 起不来。
"$CXX" -O2 -std=c++17 -mwindows \
  -static -static-libgcc -static-libstdc++ \
  "${EXTRA_FLAGS[@]}" \
  -I third_party -I third_party/winshim -I "$WV2/include" \
  src/main.cpp src/app_res.o \
  -lole32 -loleaut32 -ladvapi32 -luser32 -lgdi32 -lshell32 -lshlwapi -lversion \
  -o dist/YousjVideo.exe
cp "$WV2/x64/WebView2Loader.dll" dist/WebView2Loader.dll
cp README.txt dist/README.txt
echo "[build] 完成："
file dist/YousjVideo.exe
ls -la dist/
