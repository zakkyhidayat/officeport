package io.github.officeport.android;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The host end of the bus (runtime/bus.js): commands arrive on an event
 * stream and run on the main thread; replies and events go back as POSTs, in
 * order.
 */
final class HostChannel {
    interface Commands {
        void onCommand(JSONObject cmd);
        void onDisconnected();
    }

    final int port;
    final String token;
    private final Commands commands;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService out = Executors.newSingleThreadExecutor();
    private volatile boolean closed;

    HostChannel(int port, String token, Commands commands) {
        this.port = port;
        this.token = token;
        this.commands = commands;
    }

    String base() {
        return "http://127.0.0.1:" + port;
    }

    void open() {
        Thread t = new Thread(this::read, "host-events");
        t.setDaemon(true);
        t.start();
    }

    private void read() {
        while (!closed) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base() + "/__go/host/events?token=" + token).openConnection();
                c.setReadTimeout(0);
                c.setRequestProperty("accept", "text/event-stream");
                try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8), 1 << 16)) {
                    String line;
                    StringBuilder data = new StringBuilder();
                    while ((line = r.readLine()) != null) {
                        if (line.startsWith("data: ")) {
                            data.append(line, 6, line.length());
                        } else if (line.isEmpty() && data.length() > 0) {
                            final JSONObject cmd = new JSONObject(data.toString());
                            data.setLength(0);
                            main.post(() -> commands.onCommand(cmd));
                        }
                    }
                }
            } catch (Exception e) {
                if (!closed) Log.w("officeport", "host channel", e);
            }
            if (closed) break;
            main.post(commands::onDisconnected);
            try {
                Thread.sleep(500);
            } catch (InterruptedException ignored) {
                return;
            }
        }
    }

    void send(final JSONObject message) {
        if (closed) return;
        out.execute(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base() + "/__go/host/msg?token=" + token).openConnection();
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json");
                byte[] body = message.toString().getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body);
                }
                try (InputStream in = c.getInputStream()) {
                    while (in.read() >= 0) { /* drain */ }
                }
            } catch (Exception e) {
                Log.w("officeport", "host send", e);
            }
        });
    }

    void event(String type, Object... kv) {
        try {
            JSONObject m = new JSONObject().put("type", type);
            for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
            send(m);
        } catch (Exception e) {
            Log.w("officeport", "event", e);
        }
    }

    void reply(int req, Object value) {
        if (req <= 0) return;
        try {
            send(new JSONObject().put("type", "reply").put("req", req).put("value", value == null ? JSONObject.NULL : value));
        } catch (Exception e) {
            Log.w("officeport", "reply", e);
        }
    }

    void fail(int req, String error) {
        if (req <= 0) return;
        try {
            send(new JSONObject().put("type", "reply").put("req", req).put("error", error));
        } catch (Exception e) {
            Log.w("officeport", "reply", e);
        }
    }

    /** A resource fetched for a WebView, synchronously (WebView worker threads). */
    HttpURLConnection fetch(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base() + "/__go/host/fetch?token=" + token + "&url=" + java.net.URLEncoder.encode(url, "UTF-8")).openConnection();
        c.connect();
        return c;
    }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    void close() {
        closed = true;
        out.shutdown();
    }
}
