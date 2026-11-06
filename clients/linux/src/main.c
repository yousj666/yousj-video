/* Yousj 短视频 — Linux 桌面客户端
 * GTK3 + WebKitGTK (webkit2gtk-4.1) 单文件壳程序：
 * 独立窗口加载 https://video.yousj.cc/，与 Android / Windows 客户端同系列。
 */
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <string.h>
#include <unistd.h>
#include <libgen.h>
#include <limits.h>

#define APP_URL "https://video.yousj.cc/"
#define APP_TITLE "Yousj 短视频"

/* 尝试给窗口设置图标：依次找打包安装路径与 exe 相对路径，找不到就用系统默认。 */
static void set_window_icon(GtkWindow *window)
{
    const char *candidates[3];
    char exe_dir[PATH_MAX];
    static char rel_icon[PATH_MAX];

    candidates[0] = "/usr/share/icons/hicolor/256x256/apps/yousj-video.png";
    candidates[1] = NULL;
    candidates[2] = NULL;

    ssize_t n = readlink("/proc/self/exe", exe_dir, sizeof(exe_dir) - 1);
    if (n > 0) {
        exe_dir[n] = '\0';
        char *slash = strrchr(exe_dir, '/');
        if (slash) *slash = '\0';
        /* .deb 布局：/opt/yousj-video/YousjVideo 同目录备用图标 */
        snprintf(rel_icon, sizeof(rel_icon), "%s/icon.png", exe_dir);
        candidates[1] = rel_icon;
    }

    for (int i = 0; candidates[i]; i++) {
        GError *err = NULL;
        GdkPixbuf *pb = gdk_pixbuf_new_from_file(candidates[i], &err);
        if (pb) {
            gtk_window_set_icon(window, pb);
            g_object_unref(pb);
            return;
        }
        if (err) g_error_free(err);
    }
}

/* 加载失败时把错误打到 stderr，方便命令行排障。 */
static gboolean on_load_failed(WebKitWebView *web_view, WebKitLoadEvent event,
                               const char *uri, GError *error, gpointer user_data)
{
    (void)web_view; (void)event; (void)user_data;
    g_printerr("YousjVideo: 加载失败 %s: %s\n", uri, error ? error->message : "未知错误");
    return FALSE; /* 不拦截，保留 WebKit 默认错误页 */
}

/* target=_blank / window.open 时不要开新窗口，直接在本视图里打开。 */
static WebKitWebView *on_create(WebKitWebView *web_view, WebKitNavigationAction *action, gpointer user_data)
{
    (void)user_data;
    WebKitURIRequest *req = webkit_navigation_action_get_request(action);
    const char *uri = webkit_uri_request_get_uri(req);
    if (uri) webkit_web_view_load_uri(web_view, uri);
    return NULL; /* 返回 NULL 表示不创建新视图 */
}

int main(int argc, char *argv[])
{
    gtk_init(&argc, &argv);

    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), APP_TITLE);
    gtk_window_set_default_size(GTK_WINDOW(window), 430, 860);
    gtk_widget_set_size_request(window, 320, 560); /* 最小尺寸 */
    gtk_window_set_position(GTK_WINDOW(window), GTK_WIN_POS_CENTER);
    set_window_icon(GTK_WINDOW(window));
    g_signal_connect(window, "destroy", G_CALLBACK(gtk_main_quit), NULL);

    WebKitWebView *web_view = WEBKIT_WEB_VIEW(webkit_web_view_new());
    WebKitSettings *settings = webkit_web_view_get_settings(web_view);
    webkit_settings_set_enable_javascript(settings, TRUE);
    webkit_settings_set_enable_html5_local_storage(settings, TRUE);
    webkit_settings_set_enable_html5_database(settings, TRUE);
    /* 短视频信息流：允许视频不经手势自动播放 */
    webkit_settings_set_media_playback_requires_user_gesture(settings, FALSE);
    webkit_settings_set_enable_smooth_scrolling(settings, TRUE);

    g_signal_connect(web_view, "create", G_CALLBACK(on_create), NULL);
    g_signal_connect(web_view, "load-failed", G_CALLBACK(on_load_failed), NULL);

    gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(web_view));
    /* 可用环境变量 YOUSHJ_VIDEO_URL 覆盖加载地址（调试/自托管时用），默认线上站 */
    const char *url = g_getenv("YOUSHJ_VIDEO_URL");
    webkit_web_view_load_uri(web_view, (url && *url) ? url : APP_URL);

    gtk_widget_grab_focus(GTK_WIDGET(web_view));
    gtk_widget_show_all(window);
    gtk_main();
    return 0;
}
