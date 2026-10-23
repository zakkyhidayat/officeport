# Officeport

[GenOffice](https://github.com/genspark-ai/genoffice) for Android desktops:
Googlebook, Samsung DeX, and other Android devices with a keyboard and a
large screen. arm64-v8a and x86_64.

This is an unofficial port, not affiliated with Genspark or Mainfunc. GenOffice
is Apache-2.0; its name and logo are Mainfunc's trademarks, so the port has its
own name and icon.

## How it works

GenOffice is an Electron app. Electron does not run on Android, but almost
all of GenOffice runs on plain Node and Chromium, so the port runs
GenOffice's own release files unchanged:

| Electron | Officeport |
| --- | --- |
| main process (Node) | Node 24 from Termux's packages, a child process of the app |
| `require('electron')` | `runtime/electron.js`, a stand-in for Electron's API |
| windows, tabs (`BrowserWindow`, `WebContentsView`) | Android WebViews, placed where the main process puts them |
| preload scripts, `ipcRenderer` | `runtime/page.js`, injected into each page; IPC over loopback HTTP (`runtime/bus.js`) |
| custom schemes (`genoffice-app://docs/…`) | `http://docs.genoffice-app.localhost:PORT/…`, served by the main process's own protocol handlers |
| dialogs, menus, printing | Android's file picker, AlertDialog, PopupMenu, PrintManager |
| `xlsx-sidecar` (Rust) | cross-compiled for Android with the NDK |
| window buttons | none: Android's window caption draws them |

## Build

Needs the Android SDK (build-tools, a platform), the NDK, Rust with the
`aarch64-linux-android` and `x86_64-linux-android` targets, JDK 17+,
Node (for `npx @electron/asar`), `patchelf`, `zip` and `ar`.

```bash
ANDROID_HOME=~/Android/Sdk ANDROID_NDK_HOME=~/Android/Sdk/ndk/29.0.14206865 scripts/build-apk.sh 0.12.29
```

The APKs are written to `dist/`: one per ABI and a universal one.

On GitHub, `.github/workflows/build.yml` builds on demand, on a `v*` tag, and
daily when GenOffice has a new release. To sign with your own key, set the
secrets `KEYSTORE_BASE64` (`base64 -w0 release.keystore`), `KEYSTORE_PASS`
and `KEY_ALIAS`; without them each build uses a throwaway key, and an APK
signed with one key does not update an install signed with another.

## Use

On first start the app unpacks GenOffice (about 170 MB) and asks for access to
all files, so documents are opened and saved where they are. Without it,
documents go through Android's file picker: they are copied in, and each
save is written back.

## Not available on Android

Spell checking, screen capture, the `genoffice` command-line tool, and
auto-update (install a newer APK instead). Printing goes through Android's
print dialog.

## GNOME window buttons for desktop GenOffice (Linux)

Separate from the Android port: `desktop/gnome/` replaces the window buttons
of the installed desktop GenOffice (Electron's title bar overlay) with
GNOME's, laid out as libadwaita lays them out (24 px circles in 34 px buttons 3 px apart, 7 px
from the edge, Adwaita icons, dimmed when the window is not focused) and on
the side GNOME's `button-layout` setting puts them.

```bash
desktop/gnome/update-genoffice.sh
```

It patches `/opt/GenOffice/resources/app.asar` (asking for sudo) and keeps the
unpatched one as `app.asar.orig`. Run it again after each GenOffice update; a
version already patched is left alone. `--no-install` only writes the patched
`app.asar`; `--restore` puts the unpatched one back.
