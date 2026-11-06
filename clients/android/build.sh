#!/usr/bin/env bash
# Yousj 短视频 Android 客户端一键构建：纯 SDK build-tools 手工链，无 Gradle、无第三方依赖。
# 流程：签名材料准备 → aapt2 compile/link → javac → d8 → 加 dex → zipalign → apksigner 签名+验证。
set -euo pipefail
cd "$(dirname "$0")"

# ---------- 工具链定位 ----------
if [ -z "${JAVA_HOME:-}" ]; then
  if [ -x "$HOME/workspace/toolchain/jdk-21.0.13+9/bin/javac" ]; then
    JAVA_HOME="$HOME/workspace/toolchain/jdk-21.0.13+9"
  else
    JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
  fi
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

ANDROID_SDK="${ANDROID_SDK:-$HOME/android-sdk}"
BT="$ANDROID_SDK/build-tools/34.0.0"
ANDROID_JAR="$ANDROID_SDK/platforms/android-34/android.jar"
for f in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$ANDROID_JAR" "$JAVA_HOME/bin/javac" "$JAVA_HOME/bin/keytool"; do
  [ -e "$f" ] || { echo "缺少工具: $f" >&2; exit 1; }
done

APP_NAME="YousjVideo-1.0.apk"
BUILD=build
DIST=dist
KS=signing/yousj-video.jks
KS_PASS_FILE=signing/keystore-password.txt
KS_ALIAS=yousjvideo

# ---------- 签名材料（不存在则生成；密码只存本地 600 文件） ----------
if [ ! -f "$KS_PASS_FILE" ]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 28 > "$KS_PASS_FILE"
  chmod 600 "$KS_PASS_FILE"
  echo "已生成密钥库密码文件: $KS_PASS_FILE (600)"
fi
if [ ! -f "$KS" ]; then
  PW="$(cat "$KS_PASS_FILE")"
  keytool -genkeypair -keystore "$KS" -alias "$KS_ALIAS" -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=Yousj Video" -storepass "$PW" -keypass "$PW"
  echo "已生成自签名密钥库: $KS (CN=Yousj Video, 10000 天)"
fi

# ---------- 构建 ----------
rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$DIST"

echo "[1/6] aapt2 compile + link"
"$BT/aapt2" compile --dir res -o "$BUILD/compiled.zip"
"$BT/aapt2" link -o "$BUILD/app-nodesx.apk" \
  -I "$ANDROID_JAR" \
  --manifest AndroidManifest.xml \
  --java "$BUILD/gen" \
  "$BUILD/compiled.zip"

echo "[2/6] javac"
find src "$BUILD/gen" -name '*.java' > "$BUILD/sources.txt"
# 用 --release 11（class v55 + nestmates）：本机 d8(R8 8.2) 不支持 v65，
# 且对 JDK21 javac 产出的非静态内部类 class 会 NPE（源码已全用 static 嵌套类）
javac --release 11 -encoding UTF-8 \
  -cp "$ANDROID_JAR" -d "$BUILD/classes" @"$BUILD/sources.txt"

echo "[3/6] d8"
"$BT/d8" --min-api 24 --output "$BUILD/dex" $(find "$BUILD/classes" -name '*.class')

echo "[4/6] 打包 dex + zipalign"
cp "$BUILD/app-nodesx.apk" "$BUILD/app.apk"
( cd "$BUILD/dex" && "$JAVA_HOME/bin/jar" uf ../app.apk classes.dex )
"$BT/zipalign" -f -p 4 "$BUILD/app.apk" "$BUILD/aligned.apk"

echo "[5/6] apksigner 签名"
# 密码走 env 传（file: 方式下 store/key 双读同一文件会 EOF 报错，实测）
KS_PW="$(head -n 1 "$KS_PASS_FILE")"
export KS_PW
"$BT/apksigner" sign \
  --ks "$KS" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "env:KS_PW" --key-pass "env:KS_PW" \
  --out "$DIST/$APP_NAME" "$BUILD/aligned.apk"
unset KS_PW

echo "[6/6] 验证"
"$BT/apksigner" verify --verbose "$DIST/$APP_NAME"
"$BT/aapt" dump badging "$DIST/$APP_NAME" | grep -E "package:|application-label:|sdkVersion|targetSdkVersion" || true
ls -la "$DIST/$APP_NAME"
echo "完成: $DIST/$APP_NAME"
