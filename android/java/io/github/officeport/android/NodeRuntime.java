package io.github.officeport.android;

import android.content.Context;
import android.content.res.AssetManager;
import android.system.Os;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * GenOffice's main process: unpacks the payload (GenOffice's resources and
 * the runtime scripts, assets/payload.zip) once per version, then runs it
 * on the bundled Node (libgonode.so in the native library directory).
 */
final class NodeRuntime {
    private static final String TAG = "officeport";

    interface Listener {
        void onProgress(String text, int percent);
        void onReady(int port, String token);
        void onExit(int code, String lastLines);
    }

    private final Context context;
    private final Listener listener;
    private Process process;
    private String stamp = "";
    private Map<String, String> lastEnv;
    private final StringBuilder tail = new StringBuilder();

    NodeRuntime(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
    }

    File root() {
        return new File(context.getFilesDir(), "go");
    }

    File resources() {
        return new File(root(), "res");
    }

    /** Unpacks assets/payload.zip unless this version already did. */
    void unpack() throws IOException {
        AssetManager assets = context.getAssets();
        try (InputStream in = assets.open("payload.stamp")) {
            stamp = new String(readAll(in), StandardCharsets.UTF_8).trim();
        }
        File root = root();
        File stampFile = new File(root, ".stamp");
        if (stampFile.exists() && stamp.equals(new String(java.nio.file.Files.readAllBytes(stampFile.toPath()), StandardCharsets.UTF_8).trim())) {
            linkNative();
            return;
        }
        listener.onProgress("Preparing GenOffice…", 0);
        deleteTree(root);
        if (!root.mkdirs() && !root.isDirectory()) throw new IOException("cannot create " + root);
        long total;
        try (InputStream in = assets.open("payload.size")) {
            total = Long.parseLong(new String(readAll(in), StandardCharsets.UTF_8).trim());
        }
        long done = 0;
        int lastPercent = -1;
        byte[] buf = new byte[1 << 16];
        try (ZipInputStream zip = new ZipInputStream(assets.open("payload.zip", AssetManager.ACCESS_STREAMING))) {
            ZipEntry e;
            String rootPath = root.getCanonicalPath() + File.separator;
            while ((e = zip.getNextEntry()) != null) {
                File out = new File(root, e.getName());
                if (!out.getCanonicalPath().startsWith(rootPath)) throw new IOException("bad entry " + e.getName());
                if (e.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                out.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zip.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        done += n;
                    }
                }
                int percent = (int) (done * 100 / Math.max(1, total));
                if (percent != lastPercent) {
                    lastPercent = percent;
                    listener.onProgress("Preparing GenOffice…", percent);
                }
            }
        }
        linkNative();
        try (OutputStream os = new FileOutputStream(stampFile)) {
            os.write(stamp.getBytes(StandardCharsets.UTF_8));
        }
    }

    /** resources/native/xlsx-sidecar -> the sidecar in the native library
     * directory, which moves when the app is updated. */
    private void linkNative() throws IOException {
        File nativeDir = new File(resources(), "native");
        nativeDir.mkdirs();
        File link = new File(nativeDir, "xlsx-sidecar");
        link.delete();
        try {
            Os.symlink(new File(context.getApplicationInfo().nativeLibraryDir, "libxlsxsidecar.so").getPath(), link.getPath());
        } catch (Exception e) {
            throw new IOException("symlink: " + e);
        }
    }

    static String newToken() {
        byte[] b = new byte[16];
        new SecureRandom().nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    void start(Map<String, String> extraEnv) throws IOException {
        lastEnv = extraEnv;
        String libDir = context.getApplicationInfo().nativeLibraryDir;
        File data = new File(context.getFilesDir(), "data");
        File home = new File(data, "home");
        File tmp = new File(context.getCacheDir(), "tmp");
        home.mkdirs();
        tmp.mkdirs();
        linkFonts(new File(home, ".fonts"));
        java.util.List<String> cmd = new java.util.ArrayList<>(java.util.Arrays.asList(
                libDir + "/libgonode.so",
                "--max-old-space-size=" + heapMb(),
                "--disable-warning=ExperimentalWarning",
                "--expose-gc"));
        if (jitless()) cmd.add("--jitless");
        cmd.add(new File(root(), "runtime/main.js").getPath());
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(home);
        pb.redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.put("LD_LIBRARY_PATH", libDir);
        env.put("HOME", home.getPath());
        env.put("TMPDIR", tmp.getPath());
        env.put("GO_RES", resources().getPath());
        env.put("GO_DATA", data.getPath());
        env.put("NODE_OPTIONS", "");
        // the same port on every launch keeps the pages' origins, so WebView's
        // cache and storage carry over; one per Android user (40000-49999)
        env.put("GO_PORT", Integer.toString(40000 + android.os.Process.myUid() % 10000));
        // the payload's version: bus.js tags GenOffice's static files with it
        env.put("GO_STAMP", stamp);
        // libuv's pool runs file reads, zlib and crypto: one thread per core (4-16)
        env.put("UV_THREADPOOL_SIZE", Integer.toString(Math.max(4, Math.min(16, Runtime.getRuntime().availableProcessors()))));
        // V8 code cache for GenOffice's large main bundle: later launches skip most compiling
        env.put("NODE_COMPILE_CACHE", new File(context.getCacheDir(), "node-compile-cache").getPath());
        File certs = writeCaCerts();
        if (certs != null) {
            // Termux's OpenSSL looks under /data/data/com.termux, which is not there
            env.put("SSL_CERT_FILE", certs.getPath());
            env.put("NODE_EXTRA_CA_CERTS", certs.getPath());
        }
        env.putAll(extraEnv);
        process = pb.start();
        Thread reader = new Thread(this::pump, "node-output");
        reader.setDaemon(true);
        reader.start();
    }

    private void pump() {
        boolean ready = false;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                Log.i("node", line);
                synchronized (tail) {
                    tail.append(line).append('\n');
                    if (tail.length() > 6000) tail.delete(0, tail.length() - 6000);
                }
                if (!ready && line.startsWith("GO_READY ")) {
                    String[] parts = line.split(" ");
                    ready = true;
                    listener.onReady(Integer.parseInt(parts[1]), parts[2]);
                }
            }
        } catch (IOException e) {
            Log.w(TAG, "node output", e);
        }
        int code;
        try {
            code = process.waitFor();
        } catch (InterruptedException e) {
            code = -1;
        }
        String last;
        synchronized (tail) {
            last = tail.toString();
        }
        // a segfault before GenOffice ran, with V8's JIT on: some CPUs and kernels
        // reject the JIT's code, so the next start goes without it (slower, but runs)
        if (!ready && code == 139 && !jitless()) {
            Log.w(TAG, "node crashed at startup (139); restarting with --jitless");
            prefs().edit().putBoolean("jitless", true).apply();
            synchronized (tail) {
                tail.setLength(0);
            }
            try {
                start(lastEnv);
                return;
            } catch (IOException e) {
                last += "\nrestart: " + e;
            }
        }
        String mode = jitless() ? "(ran with --jitless)\n" : "";
        // --jitless did not help either: the JIT was not the cause, keep it on next time
        if (!ready && code == 139 && jitless()) prefs().edit().remove("jitless").apply();
        if (code != 0) last += "\n" + diagnose() + mode;
        listener.onExit(code, last);
    }

    private android.content.SharedPreferences prefs() {
        return context.getSharedPreferences("officeport", Context.MODE_PRIVATE);
    }

    private boolean jitless() {
        return prefs().getBoolean("jitless", false);
    }

    /** GenOffice finds a computer's fonts in ~/.fonts, among Linux's folders;
     * Android keeps them elsewhere. ~/.fonts gets a link to each font file in
     * Documents/GenOffice/Fonts (the user's own, created when the app may use
     * shared storage; they win a name clash), /system/fonts and /product/fonts.
     * Flat, since one of GenOffice's scanners does not look into folders.
     * Rebuilt each start: fonts added there show up after a restart. */
    private void linkFonts(File dir) {
        dir.mkdirs();
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) if (java.nio.file.Files.isSymbolicLink(f.toPath())) f.delete();
        java.util.List<File> sources = new java.util.ArrayList<>();
        if (Paths.hasAllFiles()) {
            File user = new File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS), "GenOffice/Fonts");
            user.mkdirs();
            sources.add(user);
        }
        sources.add(new File("/system/fonts"));
        sources.add(new File("/product/fonts"));
        int linked = 0;
        for (File src : sources) {
            File[] fonts = src.listFiles((d, name) -> name.matches("(?i).+\\.(ttf|otf|ttc|otc)"));
            if (fonts == null) continue;
            for (File f : fonts) {
                File link = new File(dir, f.getName());
                if (link.exists()) continue;
                try {
                    Os.symlink(f.getPath(), link.getPath());
                    linked++;
                } catch (Exception e) {
                    Log.w(TAG, "font link " + f, e);
                }
            }
        }
        Log.i(TAG, "fonts linked: " + linked);
    }

    /** Node's heap limit: a quarter of the device's memory, 1.5-3 GB. */
    private int heapMb() {
        android.app.ActivityManager am = (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        long mb = mi.totalMem / (4L << 20);
        return (int) Math.max(1536, Math.min(3072, mb));
    }

    /** Android's trusted CAs (system and user-installed) as a PEM bundle. */
    private File writeCaCerts() {
        File out = new File(context.getFilesDir(), "cacerts.pem");
        try {
            java.security.KeyStore ks = java.security.KeyStore.getInstance("AndroidCAStore");
            ks.load(null, null);
            StringBuilder pem = new StringBuilder();
            java.util.Enumeration<String> aliases = ks.aliases();
            while (aliases.hasMoreElements()) {
                java.security.cert.Certificate c = ks.getCertificate(aliases.nextElement());
                if (c == null) continue;
                pem.append("-----BEGIN CERTIFICATE-----\n")
                        .append(android.util.Base64.encodeToString(c.getEncoded(), android.util.Base64.DEFAULT))
                        .append("-----END CERTIFICATE-----\n");
            }
            try (OutputStream os = new FileOutputStream(out)) {
                os.write(pem.toString().getBytes(StandardCharsets.US_ASCII));
            }
            return out;
        } catch (Exception e) {
            Log.w(TAG, "CA certificates", e);
            return null;
        }
    }

    /** After a crash: device facts and the exit codes of stripped-down Node
     * runs, to tell a broken binary from a crash in GenOffice's code. */
    String diagnose() {
        String libDir = context.getApplicationInfo().nativeLibraryDir;
        String node = libDir + "/libgonode.so";
        StringBuilder s = new StringBuilder("--- diagnostics ---\n");
        s.append("android ").append(android.os.Build.VERSION.RELEASE)
                .append(" sdk ").append(android.os.Build.VERSION.SDK_INT)
                .append(", ").append(android.os.Build.MANUFACTURER).append(' ').append(android.os.Build.MODEL).append('\n');
        s.append("abis ").append(String.join(",", android.os.Build.SUPPORTED_ABIS)).append('\n');
        s.append("uid ").append(android.os.Process.myUid())
                .append(" user ").append(android.os.Process.myUid() / 100000).append('\n');
        s.append("data ").append(context.getApplicationInfo().dataDir).append('\n');
        s.append("lib ").append(libDir).append('\n');
        try {
            s.append("page ").append(Os.sysconf(android.system.OsConstants._SC_PAGESIZE)).append('\n');
        } catch (Exception e) {
            s.append("page ? ").append(e).append('\n');
        }
        String[] files = new File(libDir).list();
        s.append("libs ").append(files == null ? "none" : String.join(",", files)).append('\n');
        String[][] probes = {
                {node, "--version"},
                {node, "-e", "console.log(process.arch, process.versions.v8)"},
                {node, "--jitless", "-e", "console.log('jitless ok')"},
                {node, "-e", "require('crypto').randomBytes(8);require('zlib').gzipSync('x');console.log('crypto zlib ok')"},
        };
        for (String[] probe : probes) {
            s.append("$ ").append(String.join(" ", probe).replace(libDir + "/", "")).append('\n');
            s.append(probe(probe, libDir)).append('\n');
        }
        return s.toString();
    }

    private String probe(String[] cmd, String libDir) {
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            File log = new File(context.getCacheDir(), "probe.log");
            pb.redirectOutput(log);
            File tmp = new File(context.getCacheDir(), "tmp");
            tmp.mkdirs();
            pb.directory(tmp);
            Map<String, String> env = pb.environment();
            env.put("LD_LIBRARY_PATH", libDir);
            env.put("HOME", tmp.getPath());
            env.put("TMPDIR", tmp.getPath());
            env.put("NODE_OPTIONS", "");
            Process p = pb.start();
            p.getOutputStream().close();
            if (!p.waitFor(20, java.util.concurrent.TimeUnit.SECONDS)) {
                p.destroyForcibly();
                return "  (timeout)";
            }
            String text = new String(java.nio.file.Files.readAllBytes(log.toPath()), StandardCharsets.UTF_8).trim();
            if (text.length() > 400) text = text.substring(text.length() - 400);
            return "  exit " + p.exitValue() + (text.isEmpty() ? "" : "\n  " + text.replace("\n", "\n  "));
        } catch (Exception e) {
            return "  " + e;
        }
    }

    void stop() {
        if (process != null) process.destroy();
    }

    static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    static void deleteTree(File f) {
        if (!f.exists()) return;
        File[] children = f.isDirectory() && !isSymlink(f) ? f.listFiles() : null;
        if (children != null) for (File c : children) deleteTree(c);
        f.delete();
    }

    private static boolean isSymlink(File f) {
        try {
            return java.nio.file.Files.isSymbolicLink(f.toPath());
        } catch (Exception e) {
            return false;
        }
    }
}
