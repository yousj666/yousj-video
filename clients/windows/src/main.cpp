// Yousj 短视频 · Windows 桌面客户端
// 一个 WebView2 壳窗口，加载 https://video.yousj.cc ，像独立 App 一样使用。
// 基于 webview/webview 0.10.0 单头文件库（MIT）+ Microsoft WebView2 SDK。
#include "webview.h"

#include <windows.h>

int WINAPI WinMain(HINSTANCE /*hInstance*/, HINSTANCE /*hPrevInstance*/,
                   LPSTR /*lpCmdLine*/, int /*nCmdShow*/) {
  webview::webview w(false, nullptr);
  w.set_title("Yousj 短视频");
  w.set_size(430, 860, WEBVIEW_HINT_NONE);  // 默认窗口：手机比例
  w.set_size(380, 640, WEBVIEW_HINT_MIN);   // 最小尺寸，别缩到没法用
  w.navigate("https://video.yousj.cc/");
  w.run();
  return 0;
}
