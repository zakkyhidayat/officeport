#!/usr/bin/env python3
"""Shows the app's own name where GenOffice's release shows "GenOffice":
window titles, menus, About, the home tab, help and settings text.

    scripts/rebrand.py APP_DIR NAME

APP_DIR is the extracted app.asar. Only the word as a name changes
(aboutGenOffice, genoffice-app:// and paths stay), and not where Genspark's
servers or AI tools see it: the user agent and the MCP client name.
"""
import json
import os
import re
import sys

# a word in text (and German genitive GenOffices), also after a "\n" escape or joined by a hyphen (GenOffice-Update)
WORD = re.compile(r'(?:(?<=\\n)|(?<![A-Za-z0-9_$./]))GenOffice(?=s\b|[^A-Za-z0-9_$]|$)')
# what other systems see, as GenOffice sends it
KEEP = ['AI_DEFAULT_USER_AGENT = "GenOffice"', 'title: "GenOffice", version: "0.1.0"']


def rebrand(path, name):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    kept = {f'\0keep{i}\0': k for i, k in enumerate(KEEP) if k in text}
    for token, k in kept.items():
        text = text.replace(k, token)
    new, n = WORD.subn(name, text)
    for token, k in kept.items():
        new = new.replace(token, k)
    if n:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new)
    return n


def main():
    app, name = sys.argv[1], sys.argv[2]
    total = 0
    for sub in ('out/main', 'out/preload', 'out/renderer'):
        for root, _, files in os.walk(os.path.join(app, sub)):
            for f in files:
                if f.endswith(('.js', '.mjs', '.cjs', '.html')):
                    total += rebrand(os.path.join(root, f), name)
    pkg_path = os.path.join(app, 'package.json')
    with open(pkg_path, encoding='utf-8') as f:
        pkg = json.load(f)
    pkg['productName'] = name
    with open(pkg_path, 'w', encoding='utf-8') as f:
        json.dump(pkg, f, indent=2)
        f.write('\n')
    print(f'rebrand: GenOffice -> {name} ({total} places)')


if __name__ == '__main__':
    main()
