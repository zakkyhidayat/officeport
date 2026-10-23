#!/usr/bin/env python3
"""Shows the app's own name where GenOffice's release shows "GenOffice":
window titles, menus, About, the home tab, help and settings text. The
first-run slides lose GenOffice's GenTeam offer and GitHub star; the second
slide tells where to add fonts instead.

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


FONTS_TITLE = {'id': 'Tambahkan font sendiri', 'en': 'Add your own fonts'}
FONTS_BODY = {
    'id': 'Font bawaan Android sudah tersedia. Untuk font lain, salin file .ttf, .otf, atau .ttc '
          'ke Documents › {name} › Fonts (bukan ke subfolder), lalu buka ulang {name}.',
    'en': "Android's own fonts are ready to use. For others, copy .ttf, .otf or .ttc files "
          'into Documents › {name} › Fonts (not into subfolders), then reopen {name}.',
}
# GenOffice's Indonesian slide title, to tell that locale apart from the others
ID_TITLE2 = 'Ini baru permulaan'


def onboarding(path, name):
    """The first-run slides: no GenTeam offer or GitHub star; slide 2 is about fonts."""
    with open(path, encoding='utf-8') as f:
        text = f.read()
    if 'const SLIDES = [' not in text:
        return False
    text = text.replace('subtitleKey: "onbBody2", showOffer: true, art: "gift"', 'subtitleKey: "onbBody2", art: "check"')
    text = text.replace('    showStar: true,\n', '')

    def title(m):
        lang = 'id' if m.group(1) == ID_TITLE2 else 'en'
        return 'onbTitle2: ' + json.dumps(FONTS_TITLE[lang], ensure_ascii=False)
    locales = []

    def body(m):
        lang = locales.pop(0) if locales else 'en'
        return 'onbBody2: ' + json.dumps(FONTS_BODY[lang].format(name=name), ensure_ascii=False)
    # each locale has onbTitle2 then onbBody2: remember which language each title was
    for m in re.finditer(r'onbTitle2: "((?:[^"\\]|\\.)*)"', text):
        locales.append('id' if m.group(1) == ID_TITLE2 else 'en')
    text = re.sub(r'onbTitle2: "((?:[^"\\]|\\.)*)"', title, text)
    text = re.sub(r'onbBody2: "((?:[^"\\]|\\.)*)"', body, text)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return True


def main():
    app, name = sys.argv[1], sys.argv[2]
    total = 0
    for sub in ('out/main', 'out/preload', 'out/renderer'):
        for root, _, files in os.walk(os.path.join(app, sub)):
            for f in files:
                if f.endswith(('.js', '.mjs', '.cjs', '.html')):
                    total += rebrand(os.path.join(root, f), name)
    slides = 0
    for root, _, files in os.walk(os.path.join(app, 'out/renderer')):
        for f in files:
            if f.endswith('.js') and onboarding(os.path.join(root, f), name):
                slides += 1
    if not slides:
        print('rebrand: first-run slides not found; left as GenOffice ships them')
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
