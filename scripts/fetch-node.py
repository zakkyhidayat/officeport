#!/usr/bin/env python3
"""Node.js for the APK, from Termux's packages (built for Android with the
NDK). Downloads nodejs-lts and the libraries it needs for each ABI, and lays
them out as jniLibs/<abi>/lib*.so: Android extracts only lib*.so files from
an APK, and lets an app execute only what is in its native library
directory. The node binary becomes libgonode.so; a library whose name is not
lib*.so (libssl.so.3) gets one (libgossl.so).

The new names are written over the old ones inside each file's own string
table (DT_NEEDED, DT_SONAME), no longer than them, so the files keep the
layout Termux built: Android's linker rejects files that tools like patchelf
have rearranged, depending on the tool's version.

    scripts/fetch-node.py OUT_DIR [--cache DIR]

Needs llvm-readelf (or readelf) on PATH.
"""
import argparse
import io
import lzma
import os
import re
import shutil
import struct
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


def needed(path):
    out = subprocess.run([readelf(), '-d', path], capture_output=True, text=True, check=True).stdout
    return re.findall(r'\(NEEDED\)\s+Shared library: \[(.+?)\]', out)


def go_name(lib):
    """An Android-installable name for a library, no longer than its own."""
    if re.fullmatch(r'lib[A-Za-z0-9_+-]+\.so', lib) and lib not in SYSTEM_LIBS:
        return lib
    base = re.sub(r'\.so(\..*)?$', '', lib[3:] if lib.startswith('lib') else lib)
    for name in (f'libgo{base}.so', f'libg{base}.so', f'lib{base}.so'):
        if len(name) <= len(lib) and name not in SYSTEM_LIBS:
            return name
    sys.exit(f'no short enough name for {lib}')


def rename_in_elf(path, names):
    """Rewrites DT_NEEDED and DT_SONAME strings of a 64-bit ELF in place."""
    data = bytearray(open(path, 'rb').read())
    if data[:4] != b'\x7fELF' or data[4] != 2 or data[5] != 1:
        sys.exit(f'{path}: not a 64-bit little-endian ELF')
    phoff, = struct.unpack_from('<Q', data, 0x20)
    phentsize, phnum = struct.unpack_from('<HH', data, 0x36)
    loads, dynamic = [], None
    for i in range(phnum):
        p_type, _flags, offset, vaddr, _paddr, filesz, _memsz, _align = struct.unpack_from('<IIQQQQQQ', data, phoff + i * phentsize)
        if p_type == 1:
            loads.append((vaddr, offset, filesz))
        elif p_type == 2:
            dynamic = (offset, filesz)

    def file_offset(vaddr):
        for v, o, size in loads:
            if v <= vaddr < v + size:
                return o + vaddr - v
        sys.exit(f'{path}: address {vaddr:#x} outside the file')

    entries, strtab = [], None
    for j in range(dynamic[1] // 16):
        tag, value = struct.unpack_from('<qQ', data, dynamic[0] + 16 * j)
        if tag == 0:
            break
        entries.append((tag, value))
        if tag == 5:  # DT_STRTAB
            strtab = file_offset(value)
    changed = False
    for tag, value in entries:
        if tag not in (1, 14):  # DT_NEEDED, DT_SONAME
            continue
        start = strtab + value
        end = data.index(0, start)
        old = data[start:end].decode()
        new = names.get(old, old)
        if new != old:
            data[start:end] = new.encode() + b'\0' * (len(old) - len(new))
            changed = True
    if changed:
        with open(path, 'wb') as f:
            f.write(data)


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

    # every library node needs, directly or not, renamed where Android needs it
    names, files, todo = {}, [node], [node]
    while todo:
        path = todo.pop()
        for lib in needed(path):
            if lib in SYSTEM_LIBS or lib in names:
                continue
            src = resolve(lib)
            if src is None:
                sys.exit(f'{abi}: {os.path.basename(path)} needs {lib}, not found in the packages')
            names[lib] = go_name(lib)
            copy = os.path.join(dest, names[lib])
            shutil.copy(src, copy)
            files.append(copy)
            todo.append(copy)
    for path in files:
        rename_in_elf(path, names)
        os.chmod(path, 0o755)
    done = set(names.values())
    for lib, name in sorted(names.items()):
        print(f'  {lib} -> {name}')
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
