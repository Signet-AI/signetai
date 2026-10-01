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
requirement="$(printf 'designated => anchor apple generic and identifier "%s" and certificate leaf[subject.OU] = "%s"' "$identifier" "$APPLE_TEAM_ID")"
test_requirement="${requirement#designated => }"
temporary_directory="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/signet-macos-signing.XXXXXX")"
keychain_path="${temporary_directory}/signing.keychain-db"
cleanup() {
  security delete-keychain "$keychain_path" >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT
keychain_password="$(openssl rand -hex 32)"

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

printf 'Creating temporary signing keychain.\n'
security create-keychain -p "$keychain_password" "$keychain_path" >/dev/null
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
printf 'Importing Developer ID certificate.\n'
security import "$certificate_path" -k "$keychain_path" -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
printf 'Configuring code-signing key access.\n'
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain_path" >/dev/null

printf 'Inspecting imported Developer ID certificate.\n'
if ! certificate_subject="$(openssl pkcs12 -in "$certificate_path" -clcerts -nokeys -passin env:MACOS_CERTIFICATE_PASSWORD | openssl x509 -noout -subject -nameopt RFC2253)"; then
  echo "::error::Could not inspect the imported signing certificate subject"
  exit 1
fi
certificate_subject="${certificate_subject#subject=}"
if [[ ! "$certificate_subject" =~ (^|,)CN=Developer\ ID\ Application:\ .+\ \(${APPLE_TEAM_ID}\)(,|$) ]] || [[ ! "$certificate_subject" =~ (^|,)OU=${APPLE_TEAM_ID}(,|$) ]]; then
  echo "::error::Imported certificate is not a Developer ID Application identity for the configured team"
  exit 1
fi
if ! identity_fingerprint="$(openssl pkcs12 -in "$certificate_path" -clcerts -nokeys -passin env:MACOS_CERTIFICATE_PASSWORD | openssl x509 -noout -fingerprint -sha1)"; then
  echo "::error::Could not extract the imported signing certificate fingerprint"
  exit 1
fi
identity="${identity_fingerprint#*=}"
identity="${identity//:/}"
identity="${identity//[[:space:]]/}"
if [[ ! "$identity" =~ ^[A-Fa-f0-9]{40}$ ]]; then
  echo "::error::Could not parse the imported signing certificate SHA-1 fingerprint"
  exit 1
fi
printf 'Signing with the imported certificate SHA-1 fingerprint.\n'

codesign --force --timestamp --identifier "$identifier" --requirements "=$requirement" --keychain "$keychain_path" --sign "$identity" "$binary"
codesign --verify --strict --verbose=2 "$binary"
codesign --verify --strict --verbose=2 -R "=$test_requirement" "$binary"
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

printf 'Signed and verified macOS native binary (%s, team %s).\n' "$identifier" "$APPLE_TEAM_ID"
