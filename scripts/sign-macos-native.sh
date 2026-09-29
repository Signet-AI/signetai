#!/usr/bin/env bash
set -euo pipefail

binary="${1:?usage: sign-macos-native.sh <native-binary>}"
: "${MACOS_CERTIFICATE_P12:?MACOS_CERTIFICATE_P12 is required}"
: "${MACOS_CERTIFICATE_PASSWORD:?MACOS_CERTIFICATE_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

if [[ ! "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "::error::APPLE_TEAM_ID must be a 10-character Apple team identifier"
  exit 1
fi
if [[ ! -f "$binary" ]]; then
  echo "::error::Native binary does not exist: $binary"
  exit 1
fi

identifier="ai.signet.cli"
requirement="designated => anchor apple generic and identifier \"${identifier}\" and certificate leaf[subject.OU] = \"${APPLE_TEAM_ID}\""
temporary_directory="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/signet-macos-signing.XXXXXX")"
keychain_path="${temporary_directory}/signing.keychain-db"
keychain_password="$(openssl rand -hex 32)"

cleanup() {
  security delete-keychain "$keychain_path" >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

certificate_path="${temporary_directory}/developer-id.p12"
if [[ "$(uname -s)" == "Darwin" ]]; then
  printf '%s' "$MACOS_CERTIFICATE_P12" | base64 -D > "$certificate_path"
else
  printf '%s' "$MACOS_CERTIFICATE_P12" | base64 --decode > "$certificate_path"
fi
if [[ ! -s "$certificate_path" ]]; then
  echo "::error::MACOS_CERTIFICATE_P12 did not decode to a certificate"
  exit 1
fi

security create-keychain -p "$keychain_password" "$keychain_path" >/dev/null
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security import "$certificate_path" -k "$keychain_path" -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain_path" >/dev/null

identities="$(security find-identity -v -p codesigning "$keychain_path" 2>&1)"
identity="$(printf '%s\n' "$identities" | awk -v team="$APPLE_TEAM_ID" -F '"' '$2 ~ /^Developer ID Application: / && index($2, "(" team ")") > 0 { print $2; exit }')"
if [[ -z "$identity" ]]; then
  echo "::error::No Developer ID Application identity found for the configured team"
  exit 1
fi

codesign --force --timestamp --identifier "$identifier" --requirements "$requirement" --keychain "$keychain_path" --sign "$identity" "$binary"
codesign --verify --strict --verbose=2 "$binary"
signing_details="$(codesign --display --verbose=4 "$binary" 2>&1)"
for expected in "Identifier=${identifier}" "TeamIdentifier=${APPLE_TEAM_ID}" "Authority=Developer ID Application:"; do
  if [[ "$signing_details" != *"$expected"* ]]; then
    echo "::error::Signed native binary is missing expected signing metadata: ${expected}"
    exit 1
  fi
done
if [[ "$signing_details" == *"Signature=adhoc"* ]]; then
  echo "::error::Native binary still has an ad-hoc signature"
  exit 1
fi
actual_requirement="$(codesign --display --requirements - "$binary" 2>&1)"
if [[ "$actual_requirement" != *"$requirement"* ]]; then
  echo "::error::Native binary designated requirement is not team-stable"
  exit 1
fi

printf 'Signed and verified macOS native binary (%s, team %s).\n' "$identifier" "$APPLE_TEAM_ID"
