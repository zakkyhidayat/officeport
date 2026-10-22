package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;

import java.io.File;

/**
 * webContents.printToPDF: writes a WebView's print document to a file
 * without the print dialog. The result callbacks have no public
 * constructor, hence this package.
 */
public final class PdfWriter {
    public interface Done {
        void onDone(String error);
    }

    public static void write(final PrintDocumentAdapter adapter, PrintAttributes attributes, final File out, final Done done) {
        adapter.onStart();
        adapter.onLayout(null, attributes, new CancellationSignal(), new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                ParcelFileDescriptor fd;
                try {
                    fd = ParcelFileDescriptor.open(out, ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE);
                } catch (Exception e) {
                    done.onDone(String.valueOf(e));
                    return;
                }
                final ParcelFileDescriptor file = fd;
                adapter.onWrite(new PageRange[]{PageRange.ALL_PAGES}, file, new CancellationSignal(), new PrintDocumentAdapter.WriteResultCallback() {
                    @Override
                    public void onWriteFinished(PageRange[] pages) {
                        close(file);
                        adapter.onFinish();
                        done.onDone(null);
                    }

                    @Override
                    public void onWriteFailed(CharSequence error) {
                        close(file);
                        adapter.onFinish();
                        done.onDone(String.valueOf(error));
                    }

                    @Override
                    public void onWriteCancelled() {
                        close(file);
                        adapter.onFinish();
                        done.onDone("cancelled");
                    }
                });
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                adapter.onFinish();
                done.onDone(String.valueOf(error));
            }

            @Override
            public void onLayoutCancelled() {
                adapter.onFinish();
                done.onDone("cancelled");
            }
        }, null);
    }

    private static void close(ParcelFileDescriptor fd) {
        try {
            fd.close();
        } catch (Exception ignored) {
        }
    }
}
