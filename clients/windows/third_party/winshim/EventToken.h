/* 垫片：WebView2 SDK 的 WebView2.h 写的是 #include "EventToken.h"（大写），
   而 mingw-w64 提供的是小写 eventtoken.h；Windows 上不区分大小写没事，
   在 Linux 交叉编译时对不上，这里转发一层。类型定义与 Windows SDK 一致。 */
#pragma once
#include <eventtoken.h>
