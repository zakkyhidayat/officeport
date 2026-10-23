#!/usr/bin/env python3
"""Shows the app's own name where GenOffice's release shows "GenOffice":
window titles, menus, About, the home tab, help and settings text. The
first-run slides lose GenOffice's GenTeam offer and GitHub star (the second
slide tells where to add fonts instead), the home page its star prompt, and
GenOffice's logo images become the app's (branding/).

    scripts/rebrand.py APP_DIR NAME

APP_DIR is the extracted app.asar. Only the word as a name changes
(aboutGenOffice, genoffice-app:// and paths stay), and not where Genspark's
servers or AI tools see it: the user agent and the MCP client name.
"""
import glob
import json
import shutil
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


BRANDING = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'branding')
# the O of the app icon, in a 512 box (android/res/drawable/ic_foreground.xml)
O_PATH = "M256 0C372 0 446 28 446 150V362C446 484 372 512 256 512S66 484 66 362V150C66 28 140 0 256 0ZM207.7 181.62v189.33h29.94c23.19 0 40.1-2.41 50.72-7.24 10.63-4.83 15.94-15.94 15.94-33.33V141.05h-29.94c-23.19 0-40.1 2.4-50.72 7.24-10.63 4.83-15.94 15.94-15.94 33.33z"


def lockup(name):
    """GenOffice's logo lockup (mark and wordmark, 1091x240, black) with the app's."""
    return f'''<svg width="1091" height="240" viewBox="0 0 1091 240" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="0" y="0" width="240" height="240" rx="52" fill="black"/>
<path fill="white" transform="translate(60 60) scale(0.234375)" d="{O_PATH}"/>
<text x="282" y="166" fill="black" font-family="Roboto, Inter, Arial, sans-serif" font-size="140" font-weight="700" letter-spacing="-3">{name}</text>
</svg>
'''


def logos(app, name):
    """GenOffice's logo files under their hashed names, so references stay as built."""
    assets = os.path.join(app, 'out/renderer/assets')
    n = 0
    for f in glob.glob(os.path.join(assets, 'app-icon-*.png')):
        shutil.copyfile(os.path.join(BRANDING, 'app-icon.png'), f)
        n += 1
    for f in glob.glob(os.path.join(assets, 'genoffice-logo-*.svg')):
        with open(f, 'w', encoding='utf-8') as out:
            out.write(lockup(name))
        n += 1
    return n


def no_star_prompt(path):
    """The home page's "star us on GitHub" card never shows."""
    with open(path, encoding='utf-8') as f:
        text = f.read()
    old = 'starPromptDocOpens !== null && !showOnboarding && homeActive && '
    if old not in text:
        return False
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text.replace(old, 'false && '))
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
            if f.endswith('.js'):
                no_star_prompt(os.path.join(root, f))
    print(f'rebrand: {logos(app, name)} logo files')
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
