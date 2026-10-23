package io.github.officeport.android;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.FileObserver;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * GenOffice's main process works with file paths; Android's pickers give
 * content URIs. A URI on the device's own storage maps to its path (with
 * all-files access); any other (cloud providers, no access) is copied into
 * the app's storage, and each later save of that copy is written back.
 */
final class Paths {
    private static final String TAG = "officeport";
    private final Context context;
    private final List<FileObserver> observers = new ArrayList<>();

    Paths(Context context) {
        this.context = context;
    }

    static boolean hasAllFiles() {
        return Environment.isExternalStorageManager();
    }

    /** The real path of a document URI on local storage, or null. */
    static String direct(Uri uri) {
        if (uri == null) return null;
        if ("file".equals(uri.getScheme())) return uri.getPath();
        if (!hasAllFiles()) return null;
        if (!"com.android.externalstorage.documents".equals(uri.getAuthority())) return null;
        String id;
        try {
            id = DocumentsContract.isTreeUri(uri) && !DocumentsContract.isDocumentUri(null, uri)
                    ? DocumentsContract.getTreeDocumentId(uri)
                    : DocumentsContract.getDocumentId(uri);
        } catch (Exception e) {
            return null;
        }
        int colon = id.indexOf(':');
        if (colon < 0) return null;
        String volume = id.substring(0, colon);
        String rel = id.substring(colon + 1);
        File base;
        if ("primary".equalsIgnoreCase(volume)) base = Environment.getExternalStorageDirectory();
        else if ("home".equalsIgnoreCase(volume)) base = new File(Environment.getExternalStorageDirectory(), "Documents");
        else base = new File("/storage/" + volume);
        return rel.isEmpty() ? base.getPath() : new File(base, rel).getPath();
    }

    String displayName(Uri uri) {
        String name = null;
        try (Cursor c = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) {
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null) name = "document";
        return name.replaceAll("[/\\\\]", "_");
    }

    private File slot(String kind) {
        File dir = new File(new File(context.getFilesDir(), "data/" + kind), Long.toString(System.nanoTime(), 36));
        dir.mkdirs();
        return dir;
    }

    /** A path GenOffice can open for this document. */
    String forOpen(Uri uri, boolean writable) {
        String path = direct(uri);
        if (path != null && new File(path).canRead()) return path;
        ContentResolver cr = context.getContentResolver();
        if (writable) {
            try {
                cr.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) {
            }
        }
        File file = new File(slot("imports"), displayName(uri));
        try (InputStream in = cr.openInputStream(uri); OutputStream out = new FileOutputStream(file)) {
            copy(in, out);
        } catch (Exception e) {
            Log.w(TAG, "import " + uri, e);
            return null;
        }
        if (writable) writeBack(file, uri);
        return file.getPath();
    }

    /** A path GenOffice can save to, standing for this new document. */
    String forSave(Uri uri) {
        String path = direct(uri);
        if (path != null) return path;
        File file = new File(slot("exports"), displayName(uri));
        writeBack(file, uri);
        return file.getPath();
    }

    /** Copies the file to the URI each time it is written or replaced. */
    private void writeBack(final File file, final Uri uri) {
        final String name = file.getName();
        FileObserver o = new FileObserver(file.getParentFile(), FileObserver.CLOSE_WRITE | FileObserver.MOVED_TO) {
            @Override
            public void onEvent(int event, String path) {
                if (!name.equals(path)) return;
                try (InputStream in = new FileInputStream(file);
                     OutputStream out = context.getContentResolver().openOutputStream(uri, "wt")) {
                    copy(in, out);
                    Log.i(TAG, "saved back to " + uri);
                } catch (Exception e) {
                    Log.w(TAG, "save back " + uri, e);
                }
            }
        };
        o.startWatching();
        observers.add(o);
    }

    static void copy(InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    /** Where the user's own fonts go, as on Linux: ~/.local/share/fonts (made
     * here when the app may use shared storage), then the older ~/.fonts; ~
     * being shared storage's root. Subfolders count. */
    static java.util.List<File> userFontDirs() {
        java.util.List<File> dirs = new java.util.ArrayList<>();
        if (!hasAllFiles()) return dirs;
        File home = android.os.Environment.getExternalStorageDirectory();
        File fonts = new File(home, ".local/share/fonts");
        fonts.mkdirs();
        dirs.add(fonts);
        File legacy = new File(home, ".fonts");
        if (legacy.isDirectory()) dirs.add(legacy);
        return dirs;
    }

    /** How userFontDirs()'s first folder reads in a file manager. */
    static final String USER_FONTS_SHOWN = "Internal storage › .local › share › fonts";
}
