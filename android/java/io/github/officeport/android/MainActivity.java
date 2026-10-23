package io.github.officeport.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.print.PdfWriter;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.MotionEvent;
import android.view.SubMenu;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;

/**
 * The host: one activity whose content is GenOffice's windows. Each
 * BrowserWindow is a layer (full size, or a dialog card over its parent);
 * its own page and its WebContentsViews (the tabs) are WebViews placed
 * where the main process puts them. Node (NodeRuntime) runs the main
 * process; commands and events travel over HostChannel.
 */
public final class MainActivity extends Activity implements NodeRuntime.Listener, HostChannel.Commands {
    private static final String TAG = "officeport";

    private final Handler main = new Handler(Looper.getMainLooper());
    private RootLayout root;
    private LinearLayout splash;
    private TextView splashText;
    private ProgressBar splashBar;

    private NodeRuntime runtime;
    private HostChannel host;
    private Paths paths;
    private Spelling spelling;
    private String token;
    private float density;
    private String userAgent;

    private final Map<Integer, WebView> webs = new HashMap<>();
    private final Map<Integer, String> lastUrl = new HashMap<>();
    private final Map<Integer, Win> wins = new LinkedHashMap<>();
    private final Map<Integer, Win> windowOfWc = new HashMap<>();
    private final Map<Integer, Consumer<Intent>> results = new HashMap<>();
    private final List<String> pendingOpen = new ArrayList<>();
    private int requestSeq = 100;
    private boolean connected;

    private static final class Win {
        int id;
        int wc;
        boolean floating;
        boolean visible;
        int width;
        int height;
        FrameLayout layer;
        FrameLayout content;
    }

    /** Remembers the last pointer position (menus open there). */
    private static final class RootLayout extends FrameLayout {
        float lastX = -1;
        float lastY = -1;
        long lastAt;

        RootLayout(Context c) {
            super(c);
        }

        private void note(MotionEvent e) {
            lastX = e.getX();
            lastY = e.getY();
            lastAt = System.currentTimeMillis();
        }

        @Override
        public boolean dispatchTouchEvent(MotionEvent e) {
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) note(e);
            return super.dispatchTouchEvent(e);
        }

        @Override
        public boolean dispatchGenericMotionEvent(MotionEvent e) {
            note(e);
            return super.dispatchGenericMotionEvent(e);
        }
    }

    // --- start ------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        density = getResources().getDisplayMetrics().density;
        root = new RootLayout(this);
        root.setBackgroundColor(themeBackground());
        setContentView(root);
        // loading Chromium's WebView takes a moment the first time: done now, on
        // the main thread's idle time, while Node starts, not when the first page opens
        Looper.myQueue().addIdleHandler(() -> {
            if (webs.isEmpty()) new WebView(this).destroy();
            return false;
        });
        showSplash();
        WebView.setWebContentsDebuggingEnabled(true);
        paths = new Paths(this);
        spelling = new Spelling(this);
        token = NodeRuntime.newToken();
        runtime = new NodeRuntime(this, this);
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            if (r - l != or - ol || b - t != ob - ot) main.post(this::sendSizes);
        });
        handleIntent(getIntent());
        askForFileAccess();
        new Thread(() -> {
            try {
                runtime.unpack();
                main.post(() -> splashText.setText("Starting GenOffice…"));
                Map<String, String> env = new HashMap<>();
                env.put("GO_TOKEN", token);
                env.put("GO_WIDTH", Integer.toString(dp(root.getWidth() > 0 ? root.getWidth() : getResources().getDisplayMetrics().widthPixels)));
                env.put("GO_HEIGHT", Integer.toString(dp(root.getHeight() > 0 ? root.getHeight() : getResources().getDisplayMetrics().heightPixels)));
                env.put("GO_SCALE", Float.toString(density));
                env.put("GO_DARK", isDark() ? "1" : "0");
                env.put("GO_LOCALE", Locale.getDefault().toLanguageTag());
                if (Paths.hasAllFiles()) {
                    File storage = Environment.getExternalStorageDirectory();
                    env.put("GO_DOCUMENTS", new File(storage, Environment.DIRECTORY_DOCUMENTS).getPath());
                    env.put("GO_DOWNLOADS", new File(storage, Environment.DIRECTORY_DOWNLOADS).getPath());
                    env.put("GO_PICTURES", new File(storage, Environment.DIRECTORY_PICTURES).getPath());
                }
                runtime.start(env);
            } catch (Exception e) {
                Log.e(TAG, "start", e);
                main.post(() -> showFailure("GenOffice could not start.", String.valueOf(e)));
            }
        }, "start").start();
    }

    private void showSplash() {
        splash = new LinearLayout(this);
        splash.setOrientation(LinearLayout.VERTICAL);
        splash.setGravity(Gravity.CENTER);
        splashText = new TextView(this);
        splashText.setText("Starting GenOffice…");
        splashText.setTextSize(16);
        splashText.setGravity(Gravity.CENTER);
        splashBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        splashBar.setIndeterminate(true);
        splash.addView(splashText);
        splash.addView(splashBar, new LinearLayout.LayoutParams(px(280), ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(splash, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void hideSplash() {
        if (splash != null) {
            root.removeView(splash);
            splash = null;
        }
    }

    private void showFailure(String title, String details) {
        root.removeAllViews();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(px(24), px(24), px(24), px(24));
        TextView t = new TextView(this);
        t.setText(title);
        t.setTextSize(18);
        box.addView(t);
        TextView hint = new TextView(this);
        hint.setText("Restart to continue. Changes made since the last save may be lost.");
        hint.setPadding(0, px(8), 0, px(8));
        box.addView(hint);
        Button restart = new Button(this);
        restart.setText("Restart");
        restart.setOnClickListener(v -> relaunch());
        box.addView(restart);
        Button more = new Button(this);
        more.setText("Show details");
        box.addView(more);
        TextView log = new TextView(this);
        log.setVisibility(View.GONE);
        more.setOnClickListener(v -> {
            boolean show = log.getVisibility() != View.VISIBLE;
            log.setVisibility(show ? View.VISIBLE : View.GONE);
            more.setText(show ? "Hide details" : "Show details");
        });
        log.setText(details);
        log.setTextIsSelectable(true);
        log.setTypeface(android.graphics.Typeface.MONOSPACE);
        log.setTextSize(11);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(log);
        box.addView(scroll);
        root.addView(box);
    }

    /** Once, when the fonts folder exists (it needs all-files access): where downloaded fonts go. */
    private void showFontsHint() {
        if (!Paths.hasAllFiles()) return;
        SharedPreferences prefs = getSharedPreferences("officeport", MODE_PRIVATE);
        if (prefs.getBoolean("shownFontsHint", false)) return;
        prefs.edit().putBoolean("shownFontsHint", true).apply();
        new AlertDialog.Builder(this)
                .setTitle("Adding fonts")
                .setMessage("GenOffice uses Android's fonts and any font you put in\n\nDocuments › GenOffice › Fonts\n\n"
                        + "Copy downloaded .ttf, .otf or .ttc files there (not into subfolders), then close and reopen GenOffice.")
                .setPositiveButton("OK", null)
                .show();
    }

    private void askForFileAccess() {
        if (Paths.hasAllFiles()) return;
        SharedPreferences prefs = getSharedPreferences("officeport", MODE_PRIVATE);
        if (prefs.getBoolean("askedAllFiles", false)) return;
        prefs.edit().putBoolean("askedAllFiles", true).apply();
        new AlertDialog.Builder(this)
                .setTitle("Open and save documents in place")
                .setMessage("Allow access to all files so documents are opened and saved where they are, as on a computer. Without it, documents are copied in and saved back through Android's file picker.")
                .setPositiveButton("Allow", (d, w) -> {
                    try {
                        startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())));
                    } catch (Exception e) {
                        startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                    }
                })
                .setNegativeButton("Not now", null)
                .show();
    }

    // --- NodeRuntime.Listener (any thread) ----------------------------------------

    @Override
    public void onProgress(String text, int percent) {
        main.post(() -> {
            if (splash == null) return;
            splashText.setText(percent > 0 ? text + " " + percent + "%" : text);
            splashBar.setIndeterminate(percent <= 0);
            splashBar.setProgress(percent);
        });
    }

    @Override
    public void onReady(int port, String nodeToken) {
        main.post(() -> {
            host = new HostChannel(port, nodeToken, this);
            host.open();
            connected = true;
            showFontsHint();
            sendDisplay();
            for (String p : pendingOpen) host.event("open-file", "path", p);
            pendingOpen.clear();
        });
    }

    @Override
    public void onExit(int code, String lastLines) {
        main.post(() -> {
            boolean wasRunning = connected;
            connected = false;
            if (isFinishing()) return;
            // a crash while in use: start again by itself, once every few minutes at
            // most (a crash that repeats goes to the failure screen, not a loop)
            SharedPreferences prefs = getSharedPreferences("officeport", MODE_PRIVATE);
            long now = System.currentTimeMillis();
            if (wasRunning && code != 0 && now - prefs.getLong("autoRestartAt", 0) > 3 * 60_000) {
                prefs.edit().putLong("autoRestartAt", now).commit();
                Toast.makeText(this, "GenOffice stopped unexpectedly. Restarting…", Toast.LENGTH_LONG).show();
                relaunch();
                return;
            }
            showFailure(wasRunning ? "GenOffice stopped unexpectedly." : "GenOffice could not start.",
                    "Exit code " + code + "\n\n" + lastLines);
        });
    }

    @Override
    public void onDisconnected() {
        // the event stream reconnects by itself while Node runs
    }

    private void relaunch() {
        runtime.stop();
        Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (i != null) {
            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        }
        finish();
        main.postDelayed(() -> android.os.Process.killProcess(android.os.Process.myPid()), 300);
    }

    // --- display -------------------------------------------------------------------

    private int px(float dp) {
        return Math.round(dp * density);
    }

    private int dp(int px) {
        return Math.round(px / density);
    }

    private boolean isDark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    private int themeBackground() {
        return isDark() ? 0xff2a2a2a : 0xffebebeb;
    }

    private void sendDisplay() {
        if (host == null) return;
        host.event("display", "width", dp(root.getWidth()), "height", dp(root.getHeight()), "scale", (double) density, "dark", isDark());
        sendSizes();
    }

    private void sendSizes() {
        if (host == null || root.getWidth() == 0) return;
        for (Win w : wins.values()) {
            if (!w.floating) host.event("window-size", "win", w.id, "width", dp(root.getWidth()), "height", dp(root.getHeight()));
        }
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        density = getResources().getDisplayMetrics().density;
        root.setBackgroundColor(themeBackground());
        main.post(this::sendDisplay);
    }

    // --- commands ---------------------------------------------------------------------

    @Override
    public void onCommand(JSONObject c) {
        String name = c.optString("cmd");
        int req = c.optInt("req", 0);
        try {
            switch (name) {
                case "wc.create": createWebView(c.getInt("wc")); break;
                case "wc.load": load(c.getInt("wc"), c.getString("url")); break;
                case "wc.focus": { WebView v = webs.get(c.getInt("wc")); if (v != null) v.requestFocus(); break; }
                case "wc.destroy": destroyWebView(c.getInt("wc")); break;
                case "wc.stop": { WebView v = webs.get(c.getInt("wc")); if (v != null) v.stopLoading(); break; }
                case "wc.edit": edit(c.getInt("wc"), c.getString("action")); break;
                case "wc.find": find(c); break;
                case "wc.print": print(c, req); break;
                case "wc.printToPDF": printToPdf(c, req); break;
                case "wc.capture": capture(c, req); break;
                case "wc.navigate-decision": break;
                case "window.create": createWindow(c); break;
                case "window.show": showWindow(c.getInt("win"), true); break;
                case "window.hide": showWindow(c.getInt("win"), false); break;
                case "window.destroy": destroyWindow(c.getInt("win")); break;
                case "window.focus": focusWindow(c.getInt("win")); break;
                case "window.title": windowTitle(c.getInt("win"), c.optString("title")); break;
                case "window.size": windowSize(c.getInt("win"), c.getInt("width"), c.getInt("height")); break;
                case "window.fullscreen": fullScreen(c.optBoolean("on")); break;
                case "window.minimize": moveTaskToBack(true); break;
                case "window.background": { Win w = wins.get(c.getInt("win")); if (w != null) w.content.setBackgroundColor(parseColor(c.optString("color"), themeBackground())); break; }
                case "view.attach": attachView(c); break;
                case "view.detach": detachView(c.getInt("wc")); break;
                case "view.bounds": viewBounds(c.getInt("wc"), c.getJSONObject("bounds")); break;
                case "view.visible": {
                    WebView v = webs.get(c.getInt("wc"));
                    if (v != null) {
                        boolean visible = c.optBoolean("visible");
                        v.setVisibility(visible ? View.VISIBLE : View.GONE);
                    }
                    break;
                }
                case "view.background": { WebView v = webs.get(c.getInt("wc")); if (v != null) v.setBackgroundColor(parseColor(c.optString("color"), Color.TRANSPARENT)); break; }
                case "dialog.open": openDialog(c, req); break;
                case "dialog.save": saveDialog(c, req); break;
                case "dialog.message": messageBox(c, req); break;
                case "dialog.error": errorBox(c.optString("title"), c.optString("message")); break;
                case "menu.popup": popupMenu(c, req); break;
                case "menu.close": break;
                case "shell.openExternal": openExternal(c.getString("url")); break;
                case "shell.openPath": host.reply(req, openPath(c.getString("path"))); break;
                case "shell.showItemInFolder": Toast.makeText(this, c.optString("path"), Toast.LENGTH_LONG).show(); break;
                case "clipboard.write": clipboardWrite(c); break;
                case "notify": Toast.makeText(this, c.optString("title") + (c.optString("body").isEmpty() ? "" : "\n" + c.optString("body")), Toast.LENGTH_LONG).show(); break;
                case "app.quit": quit(); break;
                case "app.relaunch": relaunch(); break;
                case "theme.set": break;
                case "net.fetch": new Thread(() -> netFetch(c, req), "net-fetch").start(); break;
                case "spell.check": spelling.check(c.optString("word"), c.optString("language"), r -> host.reply(req, r)); break;
                default:
                    Log.w(TAG, "unknown command " + name);
                    if (req > 0) host.fail(req, "unsupported on Android: " + name);
            }
        } catch (Exception e) {
            Log.e(TAG, "command " + name, e);
            if (req > 0 && host != null) host.fail(req, String.valueOf(e));
        }
    }

    private static int parseColor(String s, int fallback) {
        if (s == null || s.isEmpty()) return fallback;
        try {
            if (s.startsWith("#") && s.length() == 9) {
                // CSS #RRGGBBAA -> Android #AARRGGBB
                return Color.parseColor("#" + s.substring(7, 9) + s.substring(1, 7));
            }
            return Color.parseColor(s);
        } catch (Exception e) {
            return fallback;
        }
    }

    // --- WebViews -------------------------------------------------------------------------

    private final class PageBridge {
        private final int wc;

        PageBridge(int wc) {
            this.wc = wc;
        }

        @JavascriptInterface
        public int wcId() {
            return wc;
        }

        @JavascriptInterface
        public String token() {
            return host != null ? host.token : "";
        }
    }

    private String userAgent(WebSettings s) {
        if (userAgent == null) {
            String def = s.getUserAgentString();
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("Chrome/([\\d.]+)").matcher(def);
            String chrome = m.find() ? m.group(1) : "130.0.0.0";
            String arch = Build.SUPPORTED_ABIS[0].startsWith("arm") ? "aarch64" : "x86_64";
            userAgent = "Mozilla/5.0 (X11; Linux " + arch + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chrome + " Safari/537.36 Electron/39.0.0";
        }
        return userAgent;
    }

    private void createWebView(int wc) {
        if (webs.containsKey(wc)) return;
        // no floating Cut/Copy toolbar over the app's own context menu (as on a desktop)
        WebView v = new WebView(this) {
            @Override
            public android.view.ActionMode startActionMode(android.view.ActionMode.Callback callback, int type) {
                return type == android.view.ActionMode.TYPE_FLOATING ? null : super.startActionMode(callback, type);
            }
        };
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setTextZoom(100);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setOffscreenPreRaster(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(userAgent(s));
        v.setBackgroundColor(themeBackground());
        v.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // a visible page's renderer is as important as the app; hidden tabs' are not
        v.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        // the page draws its own scrollbars; WebView's Android-style ones on top look like a phone browser
        v.setVerticalScrollBarEnabled(false);
        v.setHorizontalScrollBarEnabled(false);
        v.setFocusable(true);
        v.setFocusableInTouchMode(true);
        v.addJavascriptInterface(new PageBridge(wc), "GenOfficeHost");
        v.setWebViewClient(new Client(wc));
        v.setWebChromeClient(new Chrome(wc));
        webs.put(wc, v);
    }

    private void load(int wc, String url) {
        WebView v = webs.get(wc);
        if (v == null) {
            createWebView(wc);
            v = webs.get(wc);
        }
        lastUrl.put(wc, url);
        // hidden until the new page has painted (Client reveals it): no blank or
        // half-drawn frame while the document loads, the way a native screen appears
        v.animate().cancel();
        v.setAlpha(0f);
        v.loadUrl(url);
    }

    private void destroyWebView(int wc) {
        WebView v = webs.remove(wc);
        lastUrl.remove(wc);
        if (v == null) return;
        ViewGroup parent = (ViewGroup) v.getParent();
        if (parent != null) parent.removeView(v);
        v.destroy();
    }

    private boolean isLocal(Uri u) {
        String h = u.getHost();
        return h != null && host != null && u.getPort() == host.port && (h.equals("127.0.0.1") || h.equals("localhost") || h.endsWith(".localhost"));
    }

    private final class Client extends WebViewClient {
        private final int wc;

        Client(int wc) {
            this.wc = wc;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest r) {
            Uri u = r.getUrl();
            if (isLocal(u)) return false;
            openExternal(u.toString());
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest r) {
            String scheme = r.getUrl().getScheme();
            if (scheme == null || host == null) return null;
            switch (scheme) {
                case "http": case "https": case "data": case "blob": case "about": case "javascript": case "file":
                    return null;
            }
            // a custom scheme the page names itself (img src="genoffice-docx-media://..."):
            // fetched from the main process's protocol handler
            try {
                HttpURLConnection c = host.fetch(r.getUrl().toString());
                int status = c.getResponseCode();
                String type = c.getContentType();
                String mime = type == null ? "application/octet-stream" : type.split(";")[0].trim();
                String charset = null;
                if (type != null && type.contains("charset=")) charset = type.substring(type.indexOf("charset=") + 8).trim();
                Map<String, String> headers = new HashMap<>();
                for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                    if (e.getKey() != null && !e.getValue().isEmpty()) headers.put(e.getKey(), e.getValue().get(0));
                }
                headers.put("Access-Control-Allow-Origin", "*");
                InputStream body = status >= 400 ? c.getErrorStream() : c.getInputStream();
                return new WebResourceResponse(mime, charset, status, status >= 400 ? "Error" : "OK", headers, body);
            } catch (Exception e) {
                Log.w(TAG, "fetch " + r.getUrl(), e);
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), null);
            }
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            reveal(view);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            reveal(view);
        }

        private void reveal(WebView view) {
            if (view.getAlpha() < 1f && view.animate() != null) view.animate().alpha(1f).setDuration(120).start();
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (host != null) host.event("wc", "wc", wc, "name", "did-navigate", "url", url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest r, android.webkit.WebResourceError error) {
            if (r.isForMainFrame()) view.setAlpha(1f);
            if (r.isForMainFrame() && host != null) {
                host.event("wc", "wc", wc, "name", "did-fail-load", "code", error.getErrorCode(), "description", String.valueOf(error.getDescription()), "url", r.getUrl().toString());
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.e(TAG, "renderer gone for wc " + wc + (detail.didCrash() ? " (crashed)" : " (killed)"));
            if (host != null) host.event("wc", "wc", wc, "name", "render-process-gone", "reason", detail.didCrash() ? "crashed" : "killed");
            // a window's own page comes back in a new WebView; the main process closes crashed tabs
            Win w = windowOfWc.get(wc);
            ViewGroup parent = (ViewGroup) view.getParent();
            int index = parent != null ? parent.indexOfChild(view) : -1;
            ViewGroup.LayoutParams lp = view.getLayoutParams();
            if (parent != null) parent.removeView(view);
            webs.remove(wc);
            view.destroy();
            String url = lastUrl.get(wc);
            if (w != null && url != null) {
                createWebView(wc);
                WebView fresh = webs.get(wc);
                w.content.addView(fresh, Math.max(0, index), lp);
                fresh.loadUrl(url);
            }
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        private final int wc;

        Chrome(int wc) {
            this.wc = wc;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            try {
                startForResult(params.createIntent(), data -> callback.onReceiveValue(FileChooserParams.parseResult(data == null ? RESULT_CANCELED : RESULT_OK, data)));
                return true;
            } catch (Exception e) {
                callback.onReceiveValue(null);
                return true;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.grant(request.getResources());
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            int level = m.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? Log.ERROR : m.messageLevel() == ConsoleMessage.MessageLevel.WARNING ? Log.WARN : Log.DEBUG;
            Log.println(level, "page", "[wc " + wc + "] " + m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            return true;
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
            // window.open: the main process decides (setWindowOpenHandler)
            final WebView probe = new WebView(MainActivity.this);
            probe.setWebViewClient(new WebViewClient() {
                private boolean sent;

                private void send(String url) {
                    if (sent) return;
                    sent = true;
                    if (host != null) host.event("wc", "wc", wc, "name", "window-open", "url", url);
                    main.post(probe::destroy);
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                    send(r.getUrl().toString());
                    return true;
                }

                @Override
                public void onPageStarted(WebView v, String url, Bitmap favicon) {
                    send(url);
                }
            });
            ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
            resultMsg.sendToTarget();
            return true;
        }
    }

    private void edit(int wc, String action) {
        WebView v = webs.get(wc);
        if (v == null) return;
        String js;
        switch (action) {
            case "paste": {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                ClipData clip = cm.getPrimaryClip();
                String text = clip != null && clip.getItemCount() > 0 ? String.valueOf(clip.getItemAt(0).coerceToText(this)) : "";
                js = "document.execCommand('insertText', false, " + JSONObject.quote(text) + ")";
                break;
            }
            case "unselect":
                js = "window.getSelection().removeAllRanges()";
                break;
            default:
                js = "document.execCommand(" + JSONObject.quote(action) + ")";
        }
        v.evaluateJavascript(js, null);
    }

    private void find(JSONObject c) throws Exception {
        WebView v = webs.get(c.getInt("wc"));
        if (v == null) return;
        String text = c.optString("text");
        if (text.isEmpty()) v.clearMatches();
        else if (c.optBoolean("findNext")) v.findNext(c.optBoolean("forward", true));
        else v.findAllAsync(text);
    }

    private void print(JSONObject c, int req) throws Exception {
        WebView v = webs.get(c.getInt("wc"));
        if (v == null) {
            host.fail(req, "no such page");
            return;
        }
        PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
        String title = c.optString("title", "Document");
        pm.print(title, v.createPrintDocumentAdapter(title), new PrintAttributes.Builder().build());
        host.reply(req, true);
    }

    private static PrintAttributes.MediaSize mediaSize(Object size) {
        if (size instanceof JSONObject) {
            JSONObject o = (JSONObject) size;
            // Electron gives inches
            int w = (int) Math.round(o.optDouble("width", 8.27) * 1000);
            int h = (int) Math.round(o.optDouble("height", 11.69) * 1000);
            return new PrintAttributes.MediaSize("custom", "Custom", w, h);
        }
        switch (String.valueOf(size)) {
            case "Letter": return PrintAttributes.MediaSize.NA_LETTER;
            case "Legal": return PrintAttributes.MediaSize.NA_LEGAL;
            case "Tabloid": return PrintAttributes.MediaSize.NA_TABLOID;
            case "Ledger": return PrintAttributes.MediaSize.NA_LEDGER;
            case "A0": return PrintAttributes.MediaSize.ISO_A0;
            case "A1": return PrintAttributes.MediaSize.ISO_A1;
            case "A2": return PrintAttributes.MediaSize.ISO_A2;
            case "A3": return PrintAttributes.MediaSize.ISO_A3;
            case "A5": return PrintAttributes.MediaSize.ISO_A5;
            case "A6": return PrintAttributes.MediaSize.ISO_A6;
            default: return PrintAttributes.MediaSize.ISO_A4;
        }
    }

    private void printToPdf(JSONObject c, int req) throws Exception {
        WebView v = webs.get(c.getInt("wc"));
        if (v == null) {
            host.fail(req, "no such page");
            return;
        }
        PrintAttributes.MediaSize size = mediaSize(c.opt("pageSize"));
        if (c.optBoolean("landscape")) size = size.asLandscape();
        PrintAttributes attrs = new PrintAttributes.Builder()
                .setMediaSize(size)
                .setResolution(new PrintAttributes.Resolution("pdf", "pdf", 300, 300))
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .build();
        File out = new File(getCacheDir(), "print-" + System.nanoTime() + ".pdf");
        PdfWriter.write(v.createPrintDocumentAdapter("document"), attrs, out, error -> main.post(() -> {
            if (error != null) {
                host.fail(req, "printToPDF: " + error);
                return;
            }
            new Thread(() -> {
                try {
                    String b64 = Base64.encodeToString(Files.readAllBytes(out.toPath()), Base64.NO_WRAP);
                    host.reply(req, b64);
                } catch (Exception e) {
                    host.fail(req, String.valueOf(e));
                } finally {
                    out.delete();
                }
            }).start();
        }));
    }

    private void capture(JSONObject c, int req) throws Exception {
        WebView v = webs.get(c.getInt("wc"));
        if (v == null || v.getWidth() == 0) {
            host.fail(req, "nothing to capture");
            return;
        }
        Bitmap bmp = Bitmap.createBitmap(v.getWidth(), v.getHeight(), Bitmap.Config.ARGB_8888);
        v.draw(new Canvas(bmp));
        JSONObject r = c.optJSONObject("rect");
        if (r != null) {
            int x = px(r.optInt("x")), y = px(r.optInt("y"));
            int w = Math.min(px(r.optInt("width")), bmp.getWidth() - x), h = Math.min(px(r.optInt("height")), bmp.getHeight() - y);
            if (w > 0 && h > 0) bmp = Bitmap.createBitmap(bmp, x, y, w, h);
        }
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.PNG, 100, png);
        host.reply(req, Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP));
    }

    // --- windows and views -------------------------------------------------------------------

    private void createWindow(JSONObject c) throws Exception {
        Win w = new Win();
        w.id = c.getInt("win");
        w.wc = c.getInt("wc");
        w.floating = c.optBoolean("floating");
        w.width = c.optInt("width", 800);
        w.height = c.optInt("height", 600);
        w.layer = new FrameLayout(this);
        if (w.floating) {
            w.layer.setBackgroundColor(0x66000000);
            w.layer.setClickable(true);
            w.content = new FrameLayout(this);
            GradientDrawable card = new GradientDrawable();
            card.setCornerRadius(px(12));
            card.setColor(parseColor(c.optString("backgroundColor"), themeBackground()));
            w.content.setBackground(card);
            w.content.setClipToOutline(true);
            w.content.setElevation(px(24));
            w.layer.addView(w.content, cardParams(w));
        } else {
            w.content = w.layer;
            w.layer.setBackgroundColor(parseColor(c.optString("backgroundColor"), themeBackground()));
        }
        createWebView(w.wc);
        WebView page = webs.get(w.wc);
        w.content.addView(page, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        windowOfWc.put(w.wc, w);
        wins.put(w.id, w);
        w.visible = c.optBoolean("show", true);
        w.layer.setVisibility(w.visible ? View.VISIBLE : View.INVISIBLE);
        root.addView(w.layer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (splash != null) splash.bringToFront();
        if (w.visible) {
            hideSplash();
            windowTitle(w.id, c.optString("title"));
        }
        main.post(this::sendSizes);
    }

    private FrameLayout.LayoutParams cardParams(Win w) {
        int maxW = Math.max(px(320), root.getWidth() - px(32));
        int maxH = Math.max(px(240), root.getHeight() - px(32));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.min(px(w.width), maxW), Math.min(px(w.height), maxH));
        lp.gravity = Gravity.CENTER;
        return lp;
    }

    private void showWindow(int id, boolean show) {
        Win w = wins.get(id);
        if (w == null) return;
        w.visible = show;
        w.layer.setVisibility(show ? View.VISIBLE : View.INVISIBLE);
        if (show) {
            hideSplash();
            w.layer.bringToFront();
            WebView page = webs.get(w.wc);
            if (page != null) page.requestFocus();
        }
    }

    private void focusWindow(int id) {
        Win w = wins.get(id);
        if (w == null || !w.visible) return;
        w.layer.bringToFront();
    }

    private void destroyWindow(int id) {
        Win w = wins.remove(id);
        if (w == null) return;
        windowOfWc.remove(w.wc);
        // the main process destroys the window's webContents too (wc.destroy)
        for (int i = w.content.getChildCount() - 1; i >= 0; i--) {
            View child = w.content.getChildAt(i);
            if (child instanceof WebView) w.content.removeView(child);
        }
        root.removeView(w.layer);
        if (wins.isEmpty()) quit();
    }

    private void windowTitle(int id, String title) {
        Win top = topWindow();
        if (top != null && top.id == id && title != null && !title.isEmpty()) {
            setTitle(title);
            setTaskDescription(new android.app.ActivityManager.TaskDescription(title));
        }
    }

    private void windowSize(int id, int width, int height) {
        Win w = wins.get(id);
        if (w == null || !w.floating) return;
        w.width = width;
        w.height = height;
        w.content.setLayoutParams(cardParams(w));
    }

    private void fullScreen(boolean on) {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        if (on) {
            c.hide(WindowInsets.Type.systemBars());
            c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        } else {
            c.show(WindowInsets.Type.systemBars());
        }
    }

    private Win topWindow() {
        for (int i = root.getChildCount() - 1; i >= 0; i--) {
            View layer = root.getChildAt(i);
            for (Win w : wins.values()) if (w.layer == layer && w.visible) return w;
        }
        return null;
    }

    private void attachView(JSONObject c) throws Exception {
        int wc = c.getInt("wc");
        Win w = wins.get(c.getInt("win"));
        if (w == null) return;
        createWebView(wc);
        WebView v = webs.get(wc);
        ViewGroup parent = (ViewGroup) v.getParent();
        if (parent != null) parent.removeView(v);
        int index = Math.min(w.content.getChildCount(), 1 + Math.max(0, c.optInt("index", 0)));
        w.content.addView(v, index, boundsParams(c.getJSONObject("bounds")));
        v.setVisibility(c.optBoolean("visible", true) ? View.VISIBLE : View.GONE);
    }

    private void detachView(int wc) {
        WebView v = webs.get(wc);
        if (v == null) return;
        ViewGroup parent = (ViewGroup) v.getParent();
        if (parent != null) parent.removeView(v);
    }

    private FrameLayout.LayoutParams boundsParams(JSONObject b) {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(px(b.optInt("width")), px(b.optInt("height")));
        lp.leftMargin = px(b.optInt("x"));
        lp.topMargin = px(b.optInt("y"));
        lp.gravity = Gravity.TOP | Gravity.START;
        return lp;
    }

    private void viewBounds(int wc, JSONObject b) {
        WebView v = webs.get(wc);
        if (v != null && v.getParent() != null) v.setLayoutParams(boundsParams(b));
    }

    // --- dialogs ---------------------------------------------------------------------------------

    private void startForResult(Intent intent, Consumer<Intent> done) {
        int code = ++requestSeq;
        results.put(code, done);
        startActivityForResult(intent, code);
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        Consumer<Intent> done = results.remove(code);
        if (done != null) done.accept(result == RESULT_OK ? data : null);
        else super.onActivityResult(code, result, data);
    }

    private static String mimeFor(String ext) {
        ext = ext.toLowerCase(Locale.ROOT);
        switch (ext) {
            case "md": case "markdown": return "text/markdown";
            case "csv": return "text/csv";
            case "tsv": return "text/tab-separated-values";
        }
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
    }

    private void openDialog(JSONObject c, int req) throws Exception {
        JSONArray props = c.optJSONArray("properties");
        boolean dir = false, multi = false;
        for (int i = 0; props != null && i < props.length(); i++) {
            String p = props.getString(i);
            if (p.equals("openDirectory")) dir = true;
            if (p.equals("multiSelections")) multi = true;
        }
        if (dir) {
            startForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), data -> {
                String path = data == null ? null : Paths.direct(data.getData());
                if (data != null && path == null) Toast.makeText(this, "Allow all files access in Settings to choose folders.", Toast.LENGTH_LONG).show();
                host.reply(req, path == null ? new JSONArray() : new JSONArray().put(path));
            });
            return;
        }
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        List<String> mimes = new ArrayList<>();
        boolean all = false;
        JSONArray filters = c.optJSONArray("filters");
        for (int f = 0; filters != null && f < filters.length(); f++) {
            JSONArray exts = filters.getJSONObject(f).optJSONArray("extensions");
            for (int e = 0; exts != null && e < exts.length(); e++) {
                String ext = exts.getString(e);
                String m = ext.equals("*") ? null : mimeFor(ext);
                if (m == null) all = true;
                else if (!mimes.contains(m)) mimes.add(m);
            }
        }
        if (!all && !mimes.isEmpty()) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multi);
        startForResult(i, data -> {
            if (data == null) {
                host.reply(req, new JSONArray());
                return;
            }
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            new Thread(() -> {
                JSONArray out = new JSONArray();
                for (Uri u : uris) {
                    String p = paths.forOpen(u, true);
                    if (p != null) out.put(p);
                }
                host.reply(req, out);
            }).start();
        });
    }

    private void saveDialog(JSONObject c, int req) {
        String def = c.optString("defaultPath");
        String name = def.isEmpty() ? "Untitled" : new File(def).getName();
        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1) : "";
        if (ext.isEmpty()) {
            JSONArray filters = c.optJSONArray("filters");
            JSONArray exts = filters != null && filters.length() > 0 ? filters.optJSONObject(0).optJSONArray("extensions") : null;
            if (exts != null && exts.length() > 0 && !exts.optString(0).equals("*")) {
                ext = exts.optString(0);
                name = name + "." + ext;
            }
        }
        String mime = ext.isEmpty() ? null : mimeFor(ext);
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime != null ? mime : "application/octet-stream");
        i.putExtra(Intent.EXTRA_TITLE, name);
        startForResult(i, data -> host.reply(req, data == null || data.getData() == null ? null : paths.forSave(data.getData())));
    }

    private void messageBox(JSONObject c, int req) throws Exception {
        JSONArray buttons = c.optJSONArray("buttons");
        if (buttons == null || buttons.length() == 0) buttons = new JSONArray().put("OK");
        final int cancelId = c.optInt("cancelId", buttons.length() > 1 ? buttons.length() - 1 : 0);
        final int defaultId = c.optInt("defaultId", 0);
        String title = c.optString("title");
        String message = c.optString("message");
        String detail = c.optString("detail");
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        if (!title.isEmpty() && !title.equals(message)) {
            b.setTitle(title);
            b.setMessage(detail.isEmpty() ? message : message + "\n\n" + detail);
        } else {
            b.setTitle(message);
            if (!detail.isEmpty()) b.setMessage(detail);
        }
        final CheckBox check = c.optString("checkboxLabel").isEmpty() ? null : new CheckBox(this);
        if (check != null) {
            check.setText(c.optString("checkboxLabel"));
            check.setChecked(c.optBoolean("checkboxChecked"));
            FrameLayout pad = new FrameLayout(this);
            pad.setPadding(px(20), px(8), px(20), 0);
            pad.addView(check);
            b.setView(pad);
        }
        final boolean[] answered = {false};
        final Consumer<Integer> answer = index -> {
            if (answered[0]) return;
            answered[0] = true;
            try {
                host.reply(req, new JSONObject().put("response", index).put("checkboxChecked", check != null && check.isChecked()));
            } catch (Exception ignored) {
            }
        };
        if (buttons.length() <= 3) {
            List<Integer> rest = new ArrayList<>();
            for (int i = 0; i < buttons.length(); i++) if (i != defaultId && i != cancelId) rest.add(i);
            final JSONArray labels = buttons;
            b.setPositiveButton(labels.getString(defaultId < labels.length() ? defaultId : 0), (d, w) -> answer.accept(defaultId));
            if (cancelId != defaultId && cancelId < labels.length()) b.setNegativeButton(labels.getString(cancelId), (d, w) -> answer.accept(cancelId));
            if (!rest.isEmpty()) {
                final int other = rest.get(0);
                b.setNeutralButton(labels.getString(other), (d, w) -> answer.accept(other));
            }
        } else {
            String[] items = new String[buttons.length()];
            for (int i = 0; i < items.length; i++) items[i] = buttons.getString(i);
            b.setItems(items, (d, w) -> answer.accept(w));
        }
        b.setOnCancelListener(d -> answer.accept(cancelId));
        b.setOnDismissListener(d -> answer.accept(cancelId));
        b.show();
    }

    private void errorBox(String title, String message) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(message).setPositiveButton("OK", null).show();
    }

    // --- menus -------------------------------------------------------------------------------------

    private void popupMenu(JSONObject c, int req) throws Exception {
        Win w = wins.get(c.optInt("win"));
        if (w == null) w = topWindow();
        if (w == null) {
            host.reply(req, null);
            return;
        }
        float x, y;
        int[] origin = new int[2];
        int[] rootOrigin = new int[2];
        w.content.getLocationInWindow(origin);
        root.getLocationInWindow(rootOrigin);
        boolean recent = System.currentTimeMillis() - root.lastAt < 1500 && root.lastX >= 0;
        if (recent || c.isNull("x")) {
            x = root.lastX - (origin[0] - rootOrigin[0]);
            y = root.lastY - (origin[1] - rootOrigin[1]);
        } else {
            x = px(c.optInt("x"));
            y = px(c.optInt("y"));
        }
        final View anchor = new View(this);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(1, 1);
        lp.leftMargin = Math.max(0, Math.round(x));
        lp.topMargin = Math.max(0, Math.round(y));
        lp.gravity = Gravity.TOP | Gravity.START;
        w.content.addView(anchor, lp);
        final FrameLayout container = w.content;
        anchor.post(() -> {
            PopupMenu popup = new PopupMenu(this, anchor, Gravity.NO_GRAVITY);
            Menu menu = popup.getMenu();
            menu.setGroupDividerEnabled(true);
            final Map<Integer, String> keys = new HashMap<>();
            try {
                addItems(menu, c.getJSONArray("items"), keys, new int[]{1, 1});
            } catch (Exception e) {
                Log.e(TAG, "menu", e);
            }
            final boolean[] answered = {false};
            popup.setOnMenuItemClickListener(item -> {
                String key = keys.get(item.getItemId());
                if (key == null) return false;
                answered[0] = true;
                host.reply(req, key);
                return true;
            });
            popup.setOnDismissListener(p -> {
                container.removeView(anchor);
                main.post(() -> {
                    if (!answered[0]) {
                        answered[0] = true;
                        host.reply(req, null);
                    }
                });
            });
            popup.show();
        });
    }

    private void addItems(Menu menu, JSONArray items, Map<Integer, String> keys, int[] seq) throws Exception {
        int group = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.getJSONObject(i);
            String type = it.optString("type");
            if (type.equals("separator")) {
                group++;
                continue;
            }
            int id = seq[0]++;
            String label = it.optString("label");
            JSONArray sub = it.optJSONArray("submenu");
            if (sub != null) {
                SubMenu sm = menu.addSubMenu(group, id, i, label);
                sm.getItem().setEnabled(it.optBoolean("enabled", true));
                addItems(sm, sub, keys, seq);
                continue;
            }
            MenuItem mi = menu.add(group, id, i, label);
            mi.setEnabled(it.optBoolean("enabled", true));
            if (type.equals("checkbox") || type.equals("radio")) {
                mi.setCheckable(true);
                mi.setChecked(it.optBoolean("checked"));
            }
            setShortcut(mi, it.optString("accelerator"));
            keys.put(id, it.optString("key"));
        }
    }

    private static void setShortcut(MenuItem mi, String accel) {
        if (accel == null || accel.isEmpty()) return;
        String[] parts = accel.split("\\+");
        String key = parts[parts.length - 1];
        if (key.length() != 1) return;
        int mods = 0;
        for (int i = 0; i < parts.length - 1; i++) {
            String p = parts[i].toLowerCase(Locale.ROOT);
            if (p.equals("ctrl") || p.equals("control")) mods |= KeyEvent.META_CTRL_ON;
            else if (p.equals("shift")) mods |= KeyEvent.META_SHIFT_ON;
            else if (p.equals("alt")) mods |= KeyEvent.META_ALT_ON;
            else if (p.equals("meta") || p.equals("super")) mods |= KeyEvent.META_META_ON;
        }
        char ch = Character.toLowerCase(key.charAt(0));
        if (Character.isDigit(ch)) mi.setNumericShortcut(ch, mods);
        else mi.setAlphabeticShortcut(ch, mods);
    }

    // --- shell, clipboard ---------------------------------------------------------------------------

    private void openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            Toast.makeText(this, "No app can open " + url, Toast.LENGTH_LONG).show();
        }
    }

    /** A request Node could not make itself (runtime/electron.js hostFetch), on Android's HTTP stack. */
    private void netFetch(JSONObject c, int req) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new java.net.URL(c.getString("url")).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestMethod(c.optString("method", "GET"));
            JSONObject headers = c.optJSONObject("headers");
            if (headers != null) {
                for (java.util.Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String k = it.next();
                    if (!k.equalsIgnoreCase("content-length") && !k.equalsIgnoreCase("host")) conn.setRequestProperty(k, headers.getString(k));
                }
            }
            String body = c.optString("body");
            if (!body.isEmpty()) {
                byte[] bytes = Base64.decode(body, Base64.DEFAULT);
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream os = conn.getOutputStream()) {
                    os.write(bytes);
                }
            }
            int status = conn.getResponseCode();
            JSONObject outHeaders = new JSONObject();
            for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                // the body arrives decoded and whole
                if (e.getKey() == null || e.getKey().equalsIgnoreCase("content-encoding") || e.getKey().equalsIgnoreCase("content-length") || e.getKey().equalsIgnoreCase("transfer-encoding")) continue;
                outHeaders.put(e.getKey().toLowerCase(Locale.ROOT), android.text.TextUtils.join(", ", e.getValue()));
            }
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            if (in != null) {
                try (InputStream is = in) {
                    byte[] b = new byte[16384];
                    for (int n; (n = is.read(b)) > 0; ) {
                        buf.write(b, 0, n);
                        if (buf.size() > (32 << 20)) throw new java.io.IOException("response over 32 MB");
                    }
                }
            }
            JSONObject r = new JSONObject().put("status", status).put("headers", outHeaders)
                    .put("body", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
            if (host != null) host.reply(req, r);
        } catch (Exception e) {
            if (host != null) host.fail(req, String.valueOf(e));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String openPath(String path) {
        File f = new File(path);
        if (!f.exists()) return "not found: " + path;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(FilesProvider.uriFor(f), FilesProvider.mimeOf(f.getName()));
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(Intent.createChooser(i, f.getName()));
            return "";
        } catch (Exception e) {
            return String.valueOf(e);
        }
    }

    private void clipboardWrite(JSONObject c) {
        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        String text = c.optString("text");
        String html = c.optString("html");
        cm.setPrimaryClip(html.isEmpty() ? ClipData.newPlainText("text", text) : ClipData.newHtmlText("text", text, html));
    }

    // --- lifecycle --------------------------------------------------------------------------------------

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_EDIT.equals(action)) return;
        final Uri uri = intent.getData();
        if (uri == null) return;
        final boolean writable = (intent.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0 || Intent.ACTION_EDIT.equals(action);
        new Thread(() -> {
            String path = paths.forOpen(uri, writable);
            if (path == null) return;
            main.post(() -> {
                if (connected && host != null) host.event("open-file", "path", path);
                else pendingOpen.add(path);
            });
        }).start();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    public void onBackPressed() {
        Win top = topWindow();
        Win first = wins.isEmpty() ? null : wins.values().iterator().next();
        if (top != null && host != null && (top.floating || top != first)) {
            host.event("close-request", "win", top.id);
        } else {
            moveTaskToBack(true);
        }
    }

    private void quit() {
        if (host != null) host.close();
        runtime.stop();
        finishAndRemoveTask();
        main.postDelayed(() -> android.os.Process.killProcess(android.os.Process.myPid()), 500);
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        // in the background, or critically short of memory in the foreground: Node
        // collects garbage (a full collection pauses it, so not on milder warnings)
        if (host != null && connected && level >= TRIM_MEMORY_RUNNING_CRITICAL) {
            host.event("memory", "level", level);
        }
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) {
            if (host != null) host.close();
            if (runtime != null) runtime.stop();
        }
        for (WebView v : webs.values()) v.destroy();
        webs.clear();
        if (spelling != null) spelling.close();
        super.onDestroy();
    }
}
