#!/usr/bin/env bash
# Cross-compile GenOffice's xlsx sidecar (Rust, apps/sheets/native/xlsx-engine)
# for Android. The binary goes into jniLibs as libxlsxsidecar.so: Android
# only lets an app run executables from its native library directory.
#
#   scripts/build-sidecar.sh GENOFFICE_SOURCE_DIR OUT_DIR
#
# Needs rustup with the aarch64-linux-android and x86_64-linux-android
# targets, and the NDK (ANDROID_NDK_HOME).
set -euo pipefail

src=$(cd "$1" && pwd)/apps/sheets/native/xlsx-engine
out=$(mkdir -p "$2" && cd "$2" && pwd)
api=${ANDROID_API:-26}
ndk=${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME}
jobs=${JOBS:-4}
tc=$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin

for pair in aarch64-linux-android:arm64-v8a x86_64-linux-android:x86_64; do
    target=${pair%%:*}
    abi=${pair##*:}
    up=$(echo "$target" | tr 'a-z-' 'A-Z_')
    export "CC_${target//-/_}=$tc/$target$api-clang"
    export "AR_${target//-/_}=$tc/llvm-ar"
    export "CARGO_TARGET_${up}_LINKER=$tc/$target$api-clang"
    cargo build --release --locked -j "$jobs" --manifest-path "$src/Cargo.toml" \
        --target "$target" --target-dir "$out/target"
    mkdir -p "$out/jniLibs/$abi"
    cp "$out/target/$target/release/xlsx-sidecar" "$out/jniLibs/$abi/libxlsxsidecar.so"
    "$tc/llvm-strip" "$out/jniLibs/$abi/libxlsxsidecar.so"
done
ls -la "$out"/jniLibs/*/libxlsxsidecar.so
