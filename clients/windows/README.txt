Yousj 短视频 · Windows 客户端
============================

用法
----
把 YousjVideo.exe 和 WebView2Loader.dll 放在同一个文件夹里，
双击 YousjVideo.exe 即可，打开就是 Yousj 短视频（https://video.yousj.cc）。
两个文件要一直放一起，DLL 删了程序就起不来。

系统要求
--------
- Windows 10 / 11，64 位
- 需要 Microsoft Edge WebView2 运行时（Runtime）：
  Win11 和装了新版 Edge 的 Win10 一般都自带，不用管。
  如果打开时报错说找不到 WebView2，去微软官网装一次 Evergreen 运行时即可：
  https://developer.microsoft.com/zh-cn/microsoft-edge/webview2/
  （页面里找「Evergreen Bootstrapper」下载安装，装完再开 exe）

其他
----
- 窗口默认 430×860（手机比例），可以自由缩放，最小 380×640。
- 登录状态保存在 exe 旁边的 YousjVideo.exe.WebView2 文件夹里，
  想彻底清除登录数据删掉这个文件夹就行。
- 卸载：直接删掉整个文件夹，不写注册表、不留后台进程。
