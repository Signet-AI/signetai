#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 7 ]; then
  echo "usage: $0 <version> <mac_arm_url> <mac_arm_sha> <mac_x64_url> <mac_x64_sha> <win_url> <win_sha>"
  exit 1
fi

VER="$1"
MAC_ARM_URL="$2"
MAC_ARM_SHA="$3"
MAC_X64_URL="$4"
MAC_X64_SHA="$5"
WIN_URL="$6"
WIN_SHA="$7"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${ROOT}/deploy/channels"
mkdir -p "${OUT}/homebrew" "${OUT}/winget"

cat > "${OUT}/homebrew/signet.rb" <<EOF
cask "signet" do
  version "${VER}"

  on_arm do
    url "${MAC_ARM_URL}"
    sha256 "${MAC_ARM_SHA}"
  end

  on_intel do
    url "${MAC_X64_URL}"
    sha256 "${MAC_X64_SHA}"
  end

  name "Signet"
  desc "Portable AI agent identity desktop app"
  homepage "https://github.com/Signet-AI/signetai"

  app "Signet.app"
end
EOF

cat > "${OUT}/winget/SignetAI.Signet.yaml" <<EOF
PackageIdentifier: SignetAI.Signet
PackageVersion: ${VER}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.9.0
EOF

cat > "${OUT}/winget/SignetAI.Signet.locale.en-US.yaml" <<EOF
PackageIdentifier: SignetAI.Signet
PackageVersion: ${VER}
PackageLocale: en-US
Publisher: Signet AI
PublisherUrl: https://signetai.sh
PackageName: Signet
License: Apache-2.0
ShortDescription: Portable AI agent identity desktop app
ManifestType: defaultLocale
ManifestVersion: 1.9.0
EOF

cat > "${OUT}/winget/SignetAI.Signet.installer.yaml" <<EOF
PackageIdentifier: SignetAI.Signet
PackageVersion: ${VER}
InstallerType: wix
Installers:
  - Architecture: x64
    InstallerUrl: ${WIN_URL}
    InstallerSha256: ${WIN_SHA}
ManifestType: installer
ManifestVersion: 1.9.0
EOF

echo "Generated channel manifests at ${OUT}"
