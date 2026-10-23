package io.github.officeport.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Looks for a newer release of the app on GitHub (the repository the build
 * names in assets/update.repo), at most twice a day, and offers it. The APK
 * downloads in the browser; Android installs it over this one when it is
 * signed with the same key.
 */
final class Updates {
    private static final String TAG = "officeport";
    private static final long EVERY_MS = 12 * 3600_000L;

    private Updates() {
    }

    static void check(Activity activity) {
        String repo;
        try (InputStream in = activity.getAssets().open("update.repo")) {
            repo = new String(NodeRuntime.readAll(in), StandardCharsets.UTF_8).trim();
        } catch (Exception e) {
            return; // a build without a repository to check
        }
        if (!repo.matches("[\\w.-]+/[\\w.-]+")) return;
        SharedPreferences prefs = activity.getSharedPreferences("officeport", Activity.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (now - prefs.getLong("updateCheckedAt", 0) < EVERY_MS) return;
        prefs.edit().putLong("updateCheckedAt", now).apply();
        String current;
        try {
            current = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return;
        }
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL("https://api.github.com/repos/" + repo + "/releases/latest").openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);
                c.setRequestProperty("Accept", "application/vnd.github+json");
                // a private repository answers 404 here: nothing to offer
                if (c.getResponseCode() != 200) return;
                JSONObject release;
                try (InputStream in = c.getInputStream()) {
                    release = new JSONObject(new String(NodeRuntime.readAll(in), StandardCharsets.UTF_8));
                }
                String latest = release.optString("tag_name").replaceFirst("^v", "");
                String page = release.optString("html_url");
                if (latest.isEmpty() || !page.startsWith("https://github.com/")) return;
                if (compare(latest, current) <= 0 || latest.equals(prefs.getString("updateSkipped", ""))) return;
                activity.runOnUiThread(() -> offer(activity, prefs, latest, page));
            } catch (Exception e) {
                Log.i(TAG, "update check: " + e);
            } finally {
                if (c != null) c.disconnect();
            }
        }, "update-check").start();
    }

    private static void offer(Activity activity, SharedPreferences prefs, String latest, String page) {
        if (activity.isFinishing()) return;
        String name = activity.getApplicationInfo().loadLabel(activity.getPackageManager()).toString();
        new AlertDialog.Builder(activity)
                .setTitle("Update available")
                .setMessage(name + " " + latest + " is out. Download the APK for your device and install it over this one.")
                .setPositiveButton("Download", (d, w) -> {
                    try {
                        activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(page)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    } catch (Exception ignored) {
                    }
                })
                .setNeutralButton("Skip this version", (d, w) -> prefs.edit().putString("updateSkipped", latest).apply())
                .setNegativeButton("Later", null)
                .show();
    }

    /** 0.12.29-f3 against 0.12.30-f1: number by number. */
    static int compare(String a, String b) {
        List<Long> x = numbers(a), y = numbers(b);
        for (int i = 0; i < Math.max(x.size(), y.size()); i++) {
            long p = i < x.size() ? x.get(i) : 0, q = i < y.size() ? y.get(i) : 0;
            if (p != q) return p < q ? -1 : 1;
        }
        return 0;
    }

    private static List<Long> numbers(String s) {
        List<Long> out = new ArrayList<>();
        Matcher m = Pattern.compile("\\d+").matcher(s == null ? "" : s);
        while (m.find()) out.add(Long.parseLong(m.group()));
        return out;
    }
}
