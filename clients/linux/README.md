# Yousj 短视频 — Linux 桌面客户端

与 Android APK、Windows EXE 同系列的第三端：C 语言 + GTK3 + WebKitGTK（webkit2gtk-4.1）
单文件壳程序，打开就是一个独立窗口（默认 430×860、最小 320×560、标题「Yousj 短视频」），
加载 https://video.yousj.cc/，功能与网页版一致。

- 开启 JavaScript、HTML5 本地存储/数据库；视频允许不经手势自动播放（信息流需要）
- `window.open` / `target=_blank` 不开新窗口，在本视图内打开
- 加载失败会把错误打到 stderr；可用环境变量 `YOUSHJ_VIDEO_URL` 覆盖加载地址（调试/自托管用）

## 安装（成品 .deb）

```bash
sudo apt install ./yousj-video_1.0_amd64.deb
```

装到 `/opt/yousj-video/YousjVideo`，并注册桌面入口（应用菜单里搜「Yousj 短视频」）
与 hicolor 多尺寸图标（48/64/128/256）。

## 运行时依赖

只需要 WebKitGTK 运行时和 GTK3 运行时，.deb 的 Depends 已声明，apt 会自动补齐：

```
Depends: libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0, libc6
```

- Debian / Ubuntu 系：上面一条 `apt install ./xxx.deb` 即可；手动装则是
  `sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0`
- Fedora 系：`sudo dnf install webkit2gtk4.1 gtk3`（需自行编译，无现成 rpm 包）
- Arch 系：`sudo pacman -S webkit2gtk-4.1 gtk3`（同上，自行编译）
- 目标站点是竖屏应用，建议窗口保持竖长比例使用

二进制的直接依赖（readelf NEEDED，ldd 完整解析无缺失）：

```
libwebkit2gtk-4.1.so.0, libgtk-3.so.0, libgdk_pixbuf-2.0.so.0,
libglib-2.0.so.0, libgobject-2.0.so.0, libc.so.6
```

其余（libsoup、JavaScriptCore、GStreamer 等）都由 libwebkit2gtk-4.1-0 自身依赖带入。

## 构建

```bash
./build.sh
```

一键完成：生成图标（`src/gen_icon.py`，与 Windows 版同一套画法：暖黑圆角底 + 信号绿圆 + 深 Y）
→ gcc 编译 `src/main.c` → 组装 .deb 到 `dist/`。

构建依赖：`gcc pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev python3-pil dpkg-deb`
（Debian/Ubuntu：`sudo apt install gcc pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev python3-pil dpkg-dev`）。

若系统没有开发包，但同目录 `.tools/root` 下存在一份解压好的 deb 树，build.sh 会自动回退
引用它编译（沙箱构建就是这么做的）。该树的生成方式（下载依赖闭包后解压，不动系统 dpkg）：

```bash
mkdir -p .tools/debs .tools/root
apt-get install --download-only --no-install-recommends -o Dir::Cache::Archives=$PWD/.tools/debs \
    libgtk-3-dev libwebkit2gtk-4.1-dev
for d in .tools/debs/*.deb; do dpkg-deb -x "$d" .tools/root/; done
# 再把 root 里指向系统已有运行时库的悬空 .so 链接改指回 /usr/lib/x86_64-linux-gnu/ 同名文件
```

注意：回退模式只是借头文件和链接路径，产出的二进制只记录标准 soname，
在目标机器上仍走系统库，与正常系统编译的产物没有区别。

## 验证状态（如实）

- ✅ `file`：ELF 64-bit LSB pie executable, x86-64
- ✅ `dpkg-deb --info/--contents`：包结构正确（/opt 程序、.desktop、4 档图标、control 依赖）
- ✅ `ldd`（指向本地解压树时）全部解析，无 not found
- ✅ xvfb 冒烟：主进程持续存活（8 秒+），窗口按 430×860 居中创建，WebKitNetworkProcess 正常拉起
- ⚠️ **页面内容在沙箱里没渲染出来（真机未测）**：沙箱 Xvfb 环境下 WebKit 的 WebProcess
  因 EGL 初始化失败崩溃（日志 `Could not create default EGL display: EGL_BAD_PARAMETER`、
  `WebProcess CRASHED`）。已用 WebKitGTK 自带的 MiniBrowser 做对照实验——同一环境下它以
  完全相同的方式崩溃，确认是本沙箱无 GPU/EGL 的图形环境问题，不是本客户端代码问题；
  但真实桌面机器上的实际打开效果仍需装上后双击确认一次。
