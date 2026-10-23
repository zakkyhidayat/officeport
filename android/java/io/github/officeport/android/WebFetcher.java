package io.github.officeport.android;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * Requests made from inside a page of the site, in a hidden WebView: for a
 * site whose CDN turns away Node and Android's HTTP stack by how they speak
 * TLS (Cloudflare and the like). Desktop GenOffice makes these requests on
 * Chromium's network stack, which such checks let through; WebView is
 * Chromium too, and solves a JS challenge by itself.
 *
 * The page cannot read Set-Cookie or send Cookie itself: cookies go through
 * WebView's cookie jar, in both directions.
 */
final class WebFetcher {
    private static final long TIMEOUT_MS = 60_000;

    /** result: status, headers (lowercase name -> value), set-cookie list, body; or error */
    interface Result {
        void done(JSONObject response, String error);
    }

    private final android.app.Activity context;
    /** the user agent the app's own pages send (a desktop Chrome's, not WebView's "; wv") */
    String userAgent;
    private android.app.AlertDialog shown;
    /** set when the user cancels the check: what the requests waiting for it get */
    private String failReason;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView view;
    private String origin;
    private boolean ready;
    private final List<Runnable> waiting = new ArrayList<>();
    private final Map<Integer, Result> pending = new HashMap<>();
    private int seq;

    WebFetcher(android.app.Activity context) {
        this.context = context;
    }

    /** On the main thread. */
    void fetch(JSONObject req, Result result) {
        String url = req.optString("url");
        android.net.Uri u = android.net.Uri.parse(url);
        if (!"https".equals(u.getScheme()) || u.getHost() == null) {
            result.done(null, "not an https URL");
            return;
        }
        String o = "https://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        if (!o.equals(origin)) open(o);
        Runnable run = () -> run(req, result);
        if (ready) run.run();
        else waiting.add(run);
    }

    private void open(String o) {
        if (view != null) view.destroy();
        origin = o;
        ready = false;
        failReason = null;
        view = new WebView(context);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        if (userAgent != null) s.setUserAgentString(userAgent);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        view.addJavascriptInterface(new Bridge(), "OfficeportFetch");
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                if (v != view) return;
                // a CDN challenge page finishes too, then moves on to the real one
                v.evaluateJavascript("document.title", title -> {
                    if (title != null && title.toLowerCase().contains("just a moment")) {
                        // most challenges pass by themselves; one that waits for a
                        // person ("verify you are human") is shown to the user
                        main.postDelayed(() -> showIfStillChallenged(v), 5000);
                        return;
                    }
                    ready = true;
                    if (shown != null) {
                        shown.dismiss();
                        shown = null;
                    }
                    List<Runnable> runs = new ArrayList<>(waiting);
                    waiting.clear();
                    for (Runnable r : runs) r.run();
                });
            }
        });
        // a small page of the site: the origin the requests are made from
        view.loadUrl(o + "/robots.txt");
    }

    private void showIfStillChallenged(WebView v) {
        if (v != view || ready || shown != null || context.isFinishing()) return;
        if (v.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) v.getParent()).removeView(v);
        android.widget.FrameLayout box = new android.widget.FrameLayout(context);
        int px = (int) (420 * context.getResources().getDisplayMetrics().density);
        box.addView(v, new android.widget.FrameLayout.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, px));
        shown = new android.app.AlertDialog.Builder(context)
                .setTitle("Check by " + android.net.Uri.parse(origin).getHost())
                .setView(box)
                .setNegativeButton("Cancel", (d, w) -> cancelAll("check cancelled"))
                .setOnCancelListener(d -> cancelAll("check cancelled"))
                .show();
    }

    private void cancelAll(String why) {
        shown = null;
        if (view != null && view.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) view.getParent()).removeView(view);
        for (Result r : new ArrayList<>(pending.values())) r.done(null, why);
        pending.clear();
        // the requests still waiting for the page get the same answer
        failReason = why;
        List<Runnable> runs = new ArrayList<>(waiting);
        waiting.clear();
        for (Runnable r : runs) r.run();
        close();
    }

    private void run(JSONObject req, Result result) {
        if (failReason != null) {
            result.done(null, failReason);
            return;
        }
        final int id = ++seq;
        pending.put(id, result);
        main.postDelayed(() -> {
            Result r = pending.remove(id);
            if (r != null) r.done(null, "timed out");
        }, TIMEOUT_MS);
        String url = req.optString("url");
        JSONObject headers = new JSONObject();
        JSONObject in = req.optJSONObject("headers");
        if (in != null) {
            for (Iterator<String> it = in.keys(); it.hasNext(); ) {
                String k = it.next();
                String v = in.optString(k);
                switch (k.toLowerCase()) {
                    case "cookie":
                        // sent by the cookie jar, not by the page
                        for (String c : v.split(";")) if (!c.trim().isEmpty()) CookieManager.getInstance().setCookie(url, c.trim());
                        break;
                    case "user-agent": case "host": case "content-length": case "connection": case "origin": case "referer":
                        break;
                    default:
                        try {
                            headers.put(k, v);
                        } catch (Exception ignored) {
                        }
                }
            }
        }
        CookieManager.getInstance().flush();
        String js = "(function(){var id=" + id + ";var b=" + JSONObject.quote(req.optString("body")) + ";"
                + "var init={method:" + JSONObject.quote(req.optString("method", "GET")) + ",headers:" + headers + ",credentials:'include',redirect:'follow'};"
                + "if(b){var s=atob(b),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);init.body=a;}"
                + "fetch(" + JSONObject.quote(url) + ",init).then(function(r){var h={};r.headers.forEach(function(v,k){h[k]=v;});"
                + "return r.arrayBuffer().then(function(buf){var u=new Uint8Array(buf),t='';for(var i=0;i<u.length;i+=32768)t+=String.fromCharCode.apply(null,u.subarray(i,i+32768));"
                + "OfficeportFetch.done(id,r.status,JSON.stringify(h),btoa(t));});})"
                + ".catch(function(e){OfficeportFetch.fail(id,String(e));});})()";
        view.evaluateJavascript(js, null);
    }

    void close() {
        if (view != null) view.destroy();
        view = null;
        origin = null;
    }

    private final class Bridge {
        @JavascriptInterface
        public void done(int id, int status, String headers, String body) {
            main.post(() -> {
                Result r = pending.remove(id);
                if (r == null) return;
                try {
                    JSONObject h = new JSONObject(headers);
                    h.remove("content-encoding");
                    h.remove("content-length");
                    // what the page cannot read: the cookies the site set, from the jar
                    org.json.JSONArray setCookies = new org.json.JSONArray();
                    String jar = CookieManager.getInstance().getCookie(origin);
                    if (jar != null) for (String c : jar.split(";")) if (!c.trim().isEmpty()) setCookies.put(c.trim());
                    r.done(new JSONObject().put("status", status).put("headers", h).put("setCookies", setCookies).put("body", body), null);
                } catch (Exception e) {
                    r.done(null, String.valueOf(e));
                }
            });
        }

        @JavascriptInterface
        public void fail(int id, String error) {
            main.post(() -> {
                Result r = pending.remove(id);
                if (r != null) r.done(null, error);
            });
        }
    }
}
