#!/usr/bin/env bash
# Put the GNOME window controls back into GenOffice after an update.
#
# Extracts the installed app.asar, patches it (patch.py), repacks it and
# installs it with sudo. Run it after every GenOffice update; on a version
# already patched it does nothing.
#
#   ./update-genoffice.sh            patch and install
#   ./update-genoffice.sh --no-install   patch into ./app.asar only
#   ./update-genoffice.sh --restore      put back the last unpatched app.asar
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
installed=${GENOFFICE_ASAR:-/opt/GenOffice/resources/app.asar}
asar=(npx --yes @electron/asar@3.2.17)

if [[ ${1:-} == --restore ]]; then
    sudo cp "$here/app.asar.orig" "$installed"
    echo "Restored the unpatched app.asar. Restart GenOffice."
    exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

"${asar[@]}" extract "$installed" "$work/app"
if grep -q gnomeWindow "$work/app/out/preload/index.js"; then
    echo "GenOffice $(rpm -q --qf '%{VERSION}' genoffice 2>/dev/null) is already patched."
    exit 0
fi

cp "$installed" "$here/app.asar.orig"
python3 -I "$here/patch.py" "$work/app"
"${asar[@]}" pack "$work/app" "$here/app.asar"

if [[ ${1:-} == --no-install ]]; then
    echo "Patched app.asar written to $here/app.asar"
    exit 0
fi

sudo cp "$here/app.asar" "$installed"
echo "Installed. Quit GenOffice completely and open it again."
