#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <version> <appimage_url> <sha256>"
  exit 1
fi

VER="$1"
URL="$2"
SHA="$3"
ASSET="${URL##*/}"
ASSET="${ASSET%%\?*}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${ROOT}/deploy/aur"

mkdir -p "${OUT_DIR}"

if [ -z "${ASSET}" ]; then
  echo "error: could not derive asset name from URL"
  exit 1
fi

cat > "${OUT_DIR}/PKGBUILD" <<EOF
pkgname=signet-desktop-bin
pkgver=${VER}
pkgrel=1
pkgdesc='Signet desktop application (Tauri) with bundled daemon runtime'
arch=('x86_64')
url='https://github.com/Signet-AI/signetai'
license=('Apache')
depends=('glibc' 'gtk3' 'webkit2gtk-4.1')
optdepends=('libayatana-appindicator: tray icon support')
source=("${ASSET}::${URL}")
sha256sums=('${SHA}')

package() {
  install -d "\${pkgdir}/opt/signet"
  install -Dm755 "\${srcdir}/${ASSET}" "\${pkgdir}/opt/signet/Signet.AppImage"
  install -d "\${pkgdir}/usr/bin"
  ln -sf "/opt/signet/Signet.AppImage" "\${pkgdir}/usr/bin/signet-desktop"
}
EOF

cat > "${OUT_DIR}/.SRCINFO" <<EOF
pkgbase = signet-desktop-bin
	pkgdesc = Signet desktop application (Tauri) with bundled daemon runtime
	pkgver = ${VER}
	pkgrel = 1
	url = https://github.com/Signet-AI/signetai
	arch = x86_64
	license = Apache
	depends = glibc
	depends = gtk3
	depends = webkit2gtk-4.1
	optdepends = libayatana-appindicator: tray icon support
	source = ${ASSET}::${URL}
	sha256sums = ${SHA}

pkgname = signet-desktop-bin
EOF

echo "Generated AUR metadata at ${OUT_DIR}"
