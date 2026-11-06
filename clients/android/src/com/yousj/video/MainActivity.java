package com.yousj.video;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * Yousj 短视频 Android 客户端：单 WebView 壳，加载 https://video.yousj.cc。
 * 关键点：文件选择（发布上传）、本站/外站链接分流、加载失败重试页、返回键回退。
 * 注意：内部类一律用 static 嵌套类、且不用匿名类（本机 d8/R8 8.2 对 JDK21
 * javac 产出的非静态内部类/匿名类 class 文件会 NPE，构建实测结论，见 README）。
 */
public class MainActivity extends Activity {

    static final String HOME_URL = "https://video.yousj.cc";
    static final String HOME_HOST = "video.yousj.cc";
    private static final int REQ_FILE_CHOOSER = 1001;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean errorPageShown = false;
    private String failedUrl = HOME_URL;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0b0d0c"));
        setContentView(webView);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false); // 视频自动播放
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        ws.setBuiltInZoomControls(false);
        ws.setSupportZoom(false);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new RetryBridge(this), "AndroidBridge");
        webView.setWebViewClient(new ShellWebViewClient(this));
        webView.setWebChromeClient(new ShellWebChromeClient(this));

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(HOME_URL);
        }
    }

    /* ---------------- 文件选择（发布页选视频上传必须实现） ---------------- */

    private static class ShellWebChromeClient extends WebChromeClient {
        private final MainActivity act;

        ShellWebChromeClient(MainActivity act) {
            this.act = act;
        }

        @Override
        public boolean onShowFileChooser(WebView view,
                                         ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            // 上一个未完成的选择先取消，避免回调泄漏
            if (act.filePathCallback != null) {
                act.filePathCallback.onReceiveValue(null);
            }
            act.filePathCallback = callback;

            Intent intent = null;
            try {
                intent = params.createIntent();
            } catch (Exception ignored) {
                // 兜底：createIntent 异常时手工拼一个 GET_CONTENT
            }
            if (intent == null) {
                intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                String[] accept = params.getAcceptTypes();
                intent.setType(accept != null && accept.length > 0 && accept[0] != null
                        && !accept[0].isEmpty() ? accept[0] : "*/*");
            }
            try {
                act.startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE_CHOOSER);
            } catch (ActivityNotFoundException e) {
                act.filePathCallback = null;
                callback.onReceiveValue(null);
                Toast.makeText(act, "找不到可用的文件选择器", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE_CHOOSER) return;
        ValueCallback<Uri[]> cb = filePathCallback;
        filePathCallback = null;
        if (cb == null) return;
        if (resultCode != RESULT_OK || data == null) {
            cb.onReceiveValue(null); // 取消必须回传 null，否则网页端会一直等待
            return;
        }
        Uri[] results = null;
        if (data.getClipData() != null) {
            int n = data.getClipData().getItemCount();
            results = new Uri[n];
            for (int i = 0; i < n; i++) {
                results[i] = data.getClipData().getItemAt(i).getUri();
            }
        } else if (data.getData() != null) {
            results = new Uri[]{data.getData()};
        }
        cb.onReceiveValue(results);
    }

    /* ---------------- 链接分流 + 加载失败重试 ---------------- */

    private static class ShellWebViewClient extends WebViewClient {
        private final MainActivity act;

        ShellWebViewClient(MainActivity act) {
            this.act = act;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();
            if ("http".equals(scheme) || "https".equals(scheme)) {
                if (HOME_HOST.equals(uri.getHost())) {
                    return false; // 本站留在 WebView 里
                }
                act.openExternal(uri); // 外站交给系统浏览器
                return true;
            }
            if ("about".equals(scheme) || "data".equals(scheme) || "blob".equals(scheme)) {
                return false;
            }
            // tel: / mailto: / intent: 等交给系统处理
            try {
                act.startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request,
                                    WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (!request.isForMainFrame()) return;
            act.failedUrl = request.getUrl() != null ? request.getUrl().toString() : HOME_URL;
            Toast.makeText(act, "网络加载失败", Toast.LENGTH_SHORT).show();
            act.showErrorPage();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (url != null && url.startsWith("https://" + HOME_HOST)) {
                act.errorPageShown = false;
            }
        }
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "没有可打开该链接的应用", Toast.LENGTH_SHORT).show();
        }
    }

    private void showErrorPage() {
        if (errorPageShown) return;
        errorPageShown = true;
        String html = "<!DOCTYPE html><html><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{background:#0b0d0c;color:#f2f4f2;font-family:sans-serif;"
                + "display:flex;flex-direction:column;align-items:center;justify-content:center;"
                + "height:100vh;margin:0;text-align:center;padding:0 24px}"
                + "p{color:#9aa39c;line-height:1.6}"
                + "button{background:#1ed760;color:#04160a;border:none;border-radius:999px;"
                + "padding:13px 34px;font-size:16px;font-weight:700;margin-top:14px}</style></head>"
                + "<body><h2>加载失败</h2><p>网络好像不太顺畅，检查一下连接再重试。</p>"
                + "<button onclick='AndroidBridge.retry()'>重新加载</button></body></html>";
        webView.loadDataWithBaseURL(HOME_URL, html, "text/html", "UTF-8", null);
    }

    private static class RetryBridge implements Runnable {
        private final MainActivity act;

        RetryBridge(MainActivity act) {
            this.act = act;
        }

        @JavascriptInterface
        public void retry() {
            act.runOnUiThread(this);
        }

        @Override
        public void run() {
            act.errorPageShown = false;
            act.webView.loadUrl(act.failedUrl != null ? act.failedUrl : HOME_URL);
        }
    }

    /* ---------------- 返回键 & 生命周期 ---------------- */

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
