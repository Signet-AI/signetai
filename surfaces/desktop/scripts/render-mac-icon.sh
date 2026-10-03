#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dev_dir="${DEVELOPER_DIR:-$(xcode-select -p)}"
ictool="$dev_dir/../Applications/Icon Composer.app/Contents/Executables/ictool"
[[ -x "$ictool" ]] || { echo "ictool not found under $dev_dir; set DEVELOPER_DIR to Xcode 26+" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp -R "$root/icons/Signet.icon" "$work/Icon.icon"
mkdir "$work/catalog"
DEVELOPER_DIR="$dev_dir" xcrun actool "$work/Icon.icon" --compile "$work/catalog" \
	--output-format human-readable-text --notices --warnings \
	--output-partial-info-plist "$work/catalog/info.plist" \
	--app-icon Icon --include-all-app-icons --enable-on-demand-resources NO \
	--development-region en --target-device mac --minimum-deployment-target 26.0 --platform macosx >/dev/null
cp "$work/catalog/Assets.car" "$root/build/Assets.car"

iconset="$work/icon.iconset"
mkdir "$iconset"
"$ictool" "$root/icons/Signet.icon" --export-image --output-file "$work/body.png" \
	--platform macOS --rendition Default --width 824 --height 824 --scale 1 >/dev/null
sips -p 1024 1024 "$work/body.png" --out "$work/full.png" >/dev/null

for size in 16 32 128 256 512; do
	sips -z "$size" "$size" "$work/full.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
	sips -z "$((size * 2))" "$((size * 2))" "$work/full.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$iconset" -o "$root/icons/icon.icns"
echo "wrote $root/build/Assets.car and $root/icons/icon.icns"
