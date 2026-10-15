#!/usr/bin/env bash
# Installs the shared libraries that headless Chromium needs, without root.
#
# The browser binary itself comes from:
#   npm install                      # installs playwright (devDependency)
#   npx playwright install chromium
#
# Then this script downloads the required Ubuntu packages and unpacks them into
# ~/.local/chromium-deps, which scripts/e2e.js adds to LD_LIBRARY_PATH.
set -euo pipefail

LIBS="${HOME}/.local/chromium-deps"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

PACKAGES=(
  libnspr4
  libnss3
  libatk1.0-0t64
  libatk-bridge2.0-0t64
  libxcomposite1
  libxdamage1
  libxfixes3
  libxrandr2
  libxkbcommon0
  libasound2t64
  libatspi2.0-0t64
  libxrender1
  libxi6
)

mkdir -p "${LIBS}"
pushd "${WORK}" >/dev/null
apt-get download "${PACKAGES[@]}"
for deb in ./*.deb; do
  dpkg-deb -x "${deb}" "${LIBS}"
done
popd >/dev/null

echo "Chromium dependencies unpacked into ${LIBS}"
