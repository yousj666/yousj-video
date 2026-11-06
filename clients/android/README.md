# Yousj 短视频 · Android 客户端

WebView 壳 APK，加载线上网页应用 https://video.yousj.cc（网页更新即客户端更新，无需重打 APK）。

- 应用名：Yousj 短视频
- 包名：`com.yousj.video`
- versionCode 1 / versionName 1.0，minSdk 24，targetSdk 34
- 成品：`dist/YousjVideo-1.0.apk`（约 37 KB）

## 构建

```bash
./build.sh   # 一键：aapt2 → javac → d8 → zipalign → apksigner 签名+验证
```

工具链（无 Gradle、无第三方依赖，纯 SDK build-tools 手工链）：

- JDK 21：默认找 `~/workspace/toolchain/jdk-21.0.13+9`，或用已设置的 `$JAVA_HOME`
- Android SDK：`~/android-sdk`（build-tools 34.0.0、platform android-34），可用 `$ANDROID_SDK` 覆盖

图标重新生成：`python3 tools_make_icons.py`（PIL 绘制，深底 #0b0d0c + 绿圆 #1ed760 + 深色 Y，与网页版 auth-logo 同款，五档 mipmap）。

## 功能要点（MainActivity.java）

- WebView：JavaScript / DOM storage / 数据库开启，`setMediaPlaybackRequiresUserGesture(false)` 视频自动播放，Cookie 持久化
- `onShowFileChooser` 已实现：发布页选视频走系统文件选择器，取消回传 null（不实现的话 App 里发不了作品）
- 链接分流：本站（video.yousj.cc）留在 WebView，外站 http(s) 交系统浏览器，tel/mailto 等交系统应用
- 主框架加载失败：Toast + 内置重试页（点「重新加载」重连失败地址）
- 返回键：WebView 可后退则后退，否则退出；旋转不重载（configChanges）
- 沉浸外观：无标题栏，状态栏/导航栏颜色与底色一致（#0b0d0c）

## 签名

- 自签名长期证书：`signing/yousj-video.jks`，别名 `yousjvideo`，CN=Yousj Video，RSA 2048，有效期 10000 天（至 2054 年）
- 证书 SHA-256 指纹：`E9:CA:AA:19:02:37:59:EC:99:98:47:F5:4D:55:0B:0D:60:C3:F6:EA:62:B3:2F:DE:48:F9:12:BD:91:0C:00:41`
- 密码存 `signing/keystore-password.txt`（权限 600，勿入库/勿外发）；`build.sh` 首次运行会自动生成密码与密钥库，后续构建复用同一证书（保证升级安装不冲突）
- **密钥库和密码文件丢了就无法再给同包名发升级版**，请连同源码一起备份

## 构建避坑（实测结论）

1. 本机 d8（build-tools 34 的 R8 8.2.2-dev）不支持 class 文件 v65（JDK 21 默认），且对
   JDK 21 javac 产出的**非静态内部类 / 匿名类** class 文件会 NPE
   （`String.length() because <parameter1> is null`，匿名类名为空所致）。
   对策：javac 用 `--release 11`，源码内部类全用 static 嵌套类、不写匿名类。
2. apksigner 的 `--ks-pass file:` 在 store/key 双密码共读同一文件时会 EOF 报错，
   脚本改用 `env:` 方式传密码。
3. aapt2 的 compiled.zip 给 `link` 时作位置参数传，不要用 `-R`（那是 overlay 用法）。

## 验证状态

- `apksigner verify`：v2/v3 方案均通过，签名者证书与上指纹一致
- `aapt dump badging`：包名/版本/应用名/sdk 均如上
- ⚠️ 未做真机安装测试（沙箱无设备），首次装机请留意 WebView 内核版本差异（发布选文件、视频自动播放两处重点看）
