#!/usr/bin/env bash
# Builds Officeport, GenOffice for Android desktops (Googlebook, DeX), from
# GenOffice's official Linux release: its resources run unchanged on the
# bundled Node with runtime/ standing in for Electron.
#
#   scripts/build-apk.sh [VERSION]      e.g. 0.12.29; default: the latest release
#
# Environment:
#   ANDROID_HOME        SDK with build-tools and a platform (android.jar)
#   ANDROID_NDK_HOME    NDK, for the xlsx sidecar
#   GENOFFICE_SRC       GenOffice source checkout at the same version
#                       (default: cloned into build/src)
#   KEYSTORE, KEYSTORE_PASS, KEY_ALIAS   release signing key
#                       (default: build/debug.keystore, created if missing)
#   JOBS                build threads (default 4)
#   FORK                this fork's build number for the GenOffice version
#                       (1, 2, ...): the app is VERSION-fFORK (default 0: a
#                       local build, VERSION-f0)
#   UPDATE_REPO         owner/repo whose GitHub releases the app checks for
#                       updates (default: none, no checks)
#
# Output: dist/officeport-VERSION-fFORK-{arm64-v8a,x86_64,universal}.apk
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
build=$here/build
dist=$here/dist
mkdir -p "$build" "$dist"

: "${ANDROID_HOME:?set ANDROID_HOME}"
platform_jar=${ANDROID_JAR:-$(ls -d "$ANDROID_HOME"/platforms/android-*/android.jar | sort -V | tail -1)}
tools=${BUILD_TOOLS:-$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)}
repo=genspark-ai/genoffice

version=${1:-}
if [[ -z $version ]]; then
    version=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')
fi
fork=${FORK:-0}
[[ $fork =~ ^[0-9]+$ && $fork -lt 100 ]] || { echo "FORK must be 0-99" >&2; exit 2; }
app_version=$version-f$fork
echo "== GenOffice $version, $app_version"

# --- GenOffice's Linux release ----------------------------------------------------
deb=$build/genoffice_${version}_amd64.deb
if [[ ! -s $deb ]]; then
    curl -fL --retry 3 -o "$deb.part" "https://github.com/$repo/releases/download/v$version/genoffice_${version}_amd64.deb"
    mv "$deb.part" "$deb"
fi
rel=$build/release-$version
if [[ ! -d $rel/resources ]]; then
    rm -rf "$rel" && mkdir -p "$rel/deb"
    (cd "$rel/deb" && ar x "$deb" && tar -xf data.tar.*)
    mv "$rel/deb/opt/GenOffice/resources" "$rel/resources"
    rm -rf "$rel/deb"
fi

# --- the payload: GenOffice's resources and the runtime --------------------------------
payload=$build/payload-$version
rm -rf "$payload"
mkdir -p "$payload/res/cli" "$payload/runtime"
npx --yes @electron/asar@3.2.17 extract "$rel/resources/app.asar" "$payload/res/app"
# the app's own name (android/res/values/strings.xml) where GenOffice shows its name
app_name=$(sed -n 's|.*<string name="app_name">\(.*\)</string>.*|\1|p' "$here/android/res/values/strings.xml")
python3 -I "$here/scripts/rebrand.py" "$payload/res/app" "$app_name"
cp -a "$rel/resources/modules" "$rel/resources/wasm" "$payload/res/"
[[ -d $rel/resources/gsk ]] && cp -a "$rel/resources/gsk" "$payload/res/"
# the agent skill text (Settings > Integrations); the CLI itself is desktop-only
cp -a "$rel/resources/cli/skills" "$rel/resources/cli/package.json" "$payload/res/cli/"
cp "$here"/runtime/*.js "$payload/runtime/"

assets=$build/assets
rm -rf "$assets" && mkdir -p "$assets"
(cd "$payload" && find . -type f -o -type l | sed 's|^\./||' | sort > "$build/payload.list")
(cd "$payload" && zip -q -X -9 -r "$assets/payload.zip" . )
du -sb "$payload" | cut -f1 > "$assets/payload.size"
stamp="$version-$(sha256sum "$assets/payload.zip" | cut -c1-16)"
echo "$stamp" > "$assets/payload.stamp"
[[ -n ${UPDATE_REPO:-} ]] && echo "$UPDATE_REPO" > "$assets/update.repo"
echo "payload: $(du -sh "$payload" | cut -f1) -> $(du -h "$assets/payload.zip" | cut -f1)"

# --- native: Node and the xlsx sidecar -------------------------------------------------------
if [[ ! -s $build/node/x86_64/libgonode.so || ! -s $build/node/arm64-v8a/libgonode.so ]]; then
    python3 -I "$here/scripts/fetch-node.py" "$build/node"
fi
src=${GENOFFICE_SRC:-$build/src-$version}
if [[ ! -d $src/apps/sheets ]]; then
    git clone -q --depth 1 --branch "v$version" "https://github.com/$repo" "$src" ||
        git clone -q --depth 1 "https://github.com/$repo" "$src"
fi
sidecar=$build/sidecar-$version
if [[ ! -s $sidecar/jniLibs/x86_64/libxlsxsidecar.so || ! -s $sidecar/jniLibs/arm64-v8a/libxlsxsidecar.so ]]; then
    "$here/scripts/build-sidecar.sh" "$src" "$sidecar"
fi

# --- Java ----------------------------------------------------------------------------------------
classes=$build/classes
rm -rf "$classes" "$build/dex" && mkdir -p "$classes" "$build/dex"
javac --release 17 -nowarn -encoding UTF-8 -cp "$platform_jar" -d "$classes" $(find "$here/android/java" -name '*.java')
"$tools/d8" --release --min-api 29 --lib "$platform_jar" --output "$build/dex" $(find "$classes" -name '*.class')

# --- resources and manifest ----------------------------------------------------------------------
IFS=. read -r v1 v2 v3 <<<"${version%%-*}"
# two digits for the fork build: 0.12.29-f3 is 1202903 (above 12029, the code
# builds had before fork numbers)
version_code=$(( (v1 * 1000000 + v2 * 1000 + v3) * 100 + fork ))
sed -e "s/@VERSION_CODE@/$version_code/" -e "s/@VERSION_NAME@/$app_version/" "$here/android/AndroidManifest.xml" > "$build/AndroidManifest.xml"
rm -rf "$build/res.zip"
"$tools/aapt2" compile --dir "$here/android/res" -o "$build/res.zip"

# --- signing key -----------------------------------------------------------------------------------
keystore=${KEYSTORE:-$build/debug.keystore}
pass=${KEYSTORE_PASS:-android}
alias=${KEY_ALIAS:-officeport}
if [[ ! -f $keystore ]]; then
    keytool -genkeypair -keystore "$keystore" -storepass "$pass" -keypass "$pass" -alias "$alias" \
        -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Officeport debug" >/dev/null
fi

package() { # NAME ABI...
    local name=$1; shift
    local work=$build/apk-$name
    rm -rf "$work" && mkdir -p "$work/lib"
    "$tools/aapt2" link -o "$work/base.apk" -I "$platform_jar" --manifest "$build/AndroidManifest.xml" \
        --min-sdk-version 29 --target-sdk-version 34 "$build/res.zip"
    cp "$build/dex/classes.dex" "$work/"
    for abi in "$@"; do
        mkdir -p "$work/lib/$abi"
        cp "$build/node/$abi"/lib*.so "$sidecar/jniLibs/$abi/libxlsxsidecar.so" "$work/lib/$abi/"
    done
    (cd "$work" && zip -q -X base.apk classes.dex && zip -q -X -r base.apk lib)
    # payload.zip is already compressed: stored as is
    (cd "$build" && zip -q -X -0 "$work/base.apk" assets/payload.zip && zip -q -X "$work/base.apk" assets/payload.size assets/payload.stamp)
    "$tools/zipalign" -f -P 16 4 "$work/base.apk" "$work/aligned.apk"
    "$tools/apksigner" sign --ks "$keystore" --ks-pass "pass:$pass" --key-pass "pass:$pass" --ks-key-alias "$alias" \
        --out "$dist/officeport-$app_version-$name.apk" "$work/aligned.apk"
    echo "built dist/officeport-$app_version-$name.apk ($(du -h "$dist/officeport-$app_version-$name.apk" | cut -f1))"
}

package arm64-v8a arm64-v8a
package x86_64 x86_64
package universal arm64-v8a x86_64
