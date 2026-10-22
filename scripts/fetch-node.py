#!/usr/bin/env python3
"""Node.js for the APK, from Termux's packages (built for Android with the
NDK). Downloads nodejs-lts and the libraries it needs for each ABI, and lays
them out as jniLibs/<abi>/lib*.so: Android extracts only lib*.so files from
an APK, and lets an app execute only what is in its native library
directory. The node binary becomes libgonode.so; every library is renamed
(and the names it is linked against rewritten with patchelf) to
libgo_<name>.so.

    scripts/fetch-node.py OUT_DIR [--cache DIR]

Needs patchelf and llvm-readelf (or readelf) on PATH.
"""
import argparse
import io
import lzma
import os
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request

REPO = 'https://packages.termux.dev/apt/termux-main'
ARCHES = {'aarch64': 'arm64-v8a', 'x86_64': 'x86_64'}
ROOT_PACKAGE = 'nodejs-lts'
PREFIX = 'data/data/com.termux/files/usr/'
# provided by Android itself
SYSTEM_LIBS = {'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so', 'libz.so'}


def fetch(url, cache):
    name = os.path.join(cache, re.sub(r'[^A-Za-z0-9._-]', '_', url.split('://', 1)[1]))
    if not os.path.exists(name):
        print('  download', url, flush=True)
        with urllib.request.urlopen(url) as r, open(name + '.part', 'wb') as f:
            shutil.copyfileobj(r, f)
        os.replace(name + '.part', name)
    return name


def packages_index(arch, cache):
    text = open(fetch(f'{REPO}/dists/stable/main/binary-{arch}/Packages', cache), encoding='utf-8').read()
    index = {}
    for block in text.split('\n\n'):
        fields = dict(re.findall(r'^([\w-]+): (.*)$', block, re.M))
        if 'Package' in fields:
            index[fields['Package']] = fields
    return index


def closure(index, root):
    seen, todo = [], [root]
    while todo:
        name = todo.pop()
        if name in seen or name not in index:
            continue
        seen.append(name)
        for dep in index[name].get('Depends', '').split(','):
            dep = re.sub(r'\(.*?\)', '', dep).split('|')[0].strip()
            if dep:
                todo.append(dep)
    return seen


def deb_data(path):
    """The data.tar.* member of a .deb (an ar archive)."""
    blob = open(path, 'rb').read()
    assert blob[:8] == b'!<arch>\n', path
    pos = 8
    while pos < len(blob):
        name = blob[pos:pos + 16].decode().strip().rstrip('/')
        size = int(blob[pos + 48:pos + 58].decode().strip())
        body = blob[pos + 60:pos + 60 + size]
        if name.startswith('data.tar'):
            if name.endswith('.xz'):
                return tarfile.open(fileobj=io.BytesIO(lzma.decompress(body)))
            return tarfile.open(fileobj=io.BytesIO(body))
        pos += 60 + size + (size & 1)
    raise RuntimeError(f'no data.tar in {path}')


def readelf():
    for tool in ('llvm-readelf', 'readelf'):
        if shutil.which(tool):
            return tool
    sys.exit('readelf not found')


def strip(path):
    for tool in ('llvm-strip', 'strip'):
        if shutil.which(tool):
            subprocess.run([tool, '--strip-unneeded', path], check=True)
            return


def needed(path):
    out = subprocess.run([readelf(), '-d', path], capture_output=True, text=True, check=True).stdout
    return re.findall(r'\(NEEDED\)\s+Shared library: \[(.+?)\]', out)


def go_name(lib):
    base = lib[3:] if lib.startswith('lib') else lib
    base = re.sub(r'\.so(\.|$)', '_', base).strip('_')
    return f'libgo_{re.sub(r"[^A-Za-z0-9_+]", "_", base)}.so'


def build_abi(arch, abi, out, cache):
    print(f'{abi}:', flush=True)
    index = packages_index(arch, cache)
    staging = os.path.join(cache, f'staging-{arch}')
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    version = index[ROOT_PACKAGE]['Version']
    for name in closure(index, ROOT_PACKAGE):
        deb = fetch(f"{REPO}/{index[name]['Filename']}", cache)
        with deb_data(deb) as tar:
            members = [m for m in tar.getmembers() if m.name.lstrip('./').startswith((PREFIX + 'bin/node', PREFIX + 'lib/'))]
            tar.extractall(staging, members=members, filter='tar')
    usr = os.path.join(staging, PREFIX)
    libdir = os.path.join(usr, 'lib')

    def resolve(lib):
        path = os.path.join(libdir, lib)
        return os.path.realpath(path) if os.path.exists(path) else None

    dest = os.path.join(out, abi)
    shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest)
    node = os.path.join(dest, 'libgonode.so')
    shutil.copy(os.path.join(usr, 'bin', 'node'), node)
    strip(node)

    todo, done = [node], set()
    while todo:
        path = todo.pop()
        for lib in needed(path):
            if lib in SYSTEM_LIBS:
                continue
            src = resolve(lib)
            if src is None:
                sys.exit(f'{abi}: {os.path.basename(path)} needs {lib}, not found in the packages')
            target = go_name(lib)
            subprocess.run(['patchelf', '--replace-needed', lib, target, path], check=True)
            if target not in done:
                done.add(target)
                copy = os.path.join(dest, target)
                shutil.copy(src, copy)
                os.chmod(copy, 0o755)
                strip(copy)
                subprocess.run(['patchelf', '--set-soname', target, copy], check=True)
                todo.append(copy)
        subprocess.run(['patchelf', '--remove-rpath', path], check=True)
    os.chmod(node, 0o755)
    with open(os.path.join(dest, '.node-version'), 'w') as f:
        f.write(version + '\n')
    total = sum(os.path.getsize(os.path.join(dest, f)) for f in os.listdir(dest))
    print(f'  node {version}: {len(done)} libraries, {total / 1e6:.1f} MB', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--cache', default=os.path.join(os.path.expanduser('~'), '.cache', 'officeport-termux'))
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    for arch, abi in ARCHES.items():
        build_abi(arch, abi, args.out, args.cache)


if __name__ == '__main__':
    main()
