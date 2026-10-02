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
original_keychain_list_file="${temporary_directory}/original-keychain-search-list.txt"
current_keychain_list_file="${temporary_directory}/current-keychain-search-list.txt"
original_user_keychains=()
parsed_user_keychains=()
current_user_keychains=()
user_keychain_list_saved=no
user_keychain_list_state=unknown
parse_keychain_entry() {
  local line="$1"
  local line_length=0
  local character=""
  local horizontal_tab=$'\t'
  while [[ -n "$line" ]]; do
    character="${line:0:1}"
    if [[ "$character" != ' ' && "$character" != "$horizontal_tab" ]]; then
      break
    fi
    line="${line:1}"
  done
  while [[ -n "$line" ]]; do
    line_length=${#line}
    character="${line:$((line_length - 1)):1}"
    if [[ "$character" != ' ' && "$character" != "$horizontal_tab" ]]; then
      break
    fi
    line="${line:0:$((line_length - 1))}"
  done
  line_length="${#line}"
  local keychain_path=""
  if [[ "$line_length" -lt 2 || "${line:0:1}" != '"' || "${line:$((line_length - 1)):1}" != '"' ]]; then
    return 1
  fi
  keychain_path="${line:1:$((line_length - 2))}"
  if [[ -z "$keychain_path" || "$keychain_path" == *'"'* ]]; then
    return 1
  fi
  printf '%s' "$keychain_path"
}
parse_user_keychain_list_file() {
  local list_file="$1"
  local list_hex=""
  local list_text=""
  local keychain_line=""
  local keychain_path=""
  parsed_user_keychains=()
  if ! list_hex="$(LC_ALL=C od -An -v -tx1 "$list_file")"; then
    return 1
  fi
  if [[ "$list_hex" =~ (^|[[:space:]])00([[:space:]]|$) ]]; then
    return 1
  fi
  if ! list_text="$(cat "$list_file")"; then
    return 1
  fi
  if [[ ! -s "$list_file" ]]; then
    return 0
  fi
  while IFS= read -r keychain_line; do
    if ! keychain_path="$(parse_keychain_entry "$keychain_line")"; then
      return 1
    fi
    parsed_user_keychains+=( "$keychain_path" )
  done <<< "$list_text"
}
user_keychain_lists_equal() {
  local index=0
  if [[ "${#original_user_keychains[@]}" -ne "${#parsed_user_keychains[@]}" ]]; then
    return 1
  fi
  for index in "${!original_user_keychains[@]}"; do
    if [[ "${original_user_keychains[$index]}" != "${parsed_user_keychains[$index]}" ]]; then
      return 1
    fi
  done
}
capture_original_user_keychains() {
  local original_list_hex=""
  if ! security list-keychains -d user > "$original_keychain_list_file" 2>/dev/null; then
    echo "::error::Could not read original user keychain search list"
    return 1
  fi
  if ! original_list_hex="$(LC_ALL=C od -An -v -tx1 "$original_keychain_list_file")"; then
    echo "::error::Could not inspect original user keychain search list"
    return 1
  fi
  if [[ "$original_list_hex" =~ (^|[[:space:]])00([[:space:]]|$) ]]; then
    echo "::error::Original user keychain search list contains NUL bytes"
    return 1
  fi
  if ! parse_user_keychain_list_file "$original_keychain_list_file"; then
    echo "::error::Could not parse original user keychain search list"
    return 1
  fi
  original_user_keychains=( "${parsed_user_keychains[@]}" )
}
read_current_user_keychains() {
  if ! security list-keychains -d user > "$current_keychain_list_file" 2>/dev/null; then
    return 1
  fi
  if ! parse_user_keychain_list_file "$current_keychain_list_file"; then
    return 1
  fi
  current_user_keychains=( "${parsed_user_keychains[@]}" )
}
classify_current_user_keychain_list() {
  local current_keychain_path=""
  parsed_user_keychains=( "${current_user_keychains[@]}" )
  if user_keychain_lists_equal; then
    user_keychain_list_state=restored
    user_keychain_list_saved=no
    return 0
  fi
  user_keychain_list_state=different
  for current_keychain_path in "${current_user_keychains[@]}"; do
    if [[ "$current_keychain_path" == "$keychain_path" ]]; then
      user_keychain_list_state=referenced
      return 0
    fi
  done
}
restore_user_keychain_list() {
  if [[ "$user_keychain_list_saved" != yes ]]; then
    return 0
  fi
  if ! read_current_user_keychains; then
    user_keychain_list_state=unknown
    return 1
  fi
  classify_current_user_keychain_list
  if [[ "$user_keychain_list_state" == restored ]]; then
    return 0
  fi
  if [[ "${#current_user_keychains[@]}" -ne 1 || "${current_user_keychains[0]}" != "$keychain_path" ]]; then
    return 1
  fi
  if ! security list-keychains -d user -s "${original_user_keychains[@]}" >/dev/null 2>&1; then
    return 1
  fi
  if ! read_current_user_keychains; then
    user_keychain_list_state=unknown
    return 1
  fi
  classify_current_user_keychain_list
  [[ "$user_keychain_list_state" == restored ]]
}
inspect_current_user_keychain_list() {
  if ! read_current_user_keychains; then
    user_keychain_list_state=unknown
    return 0
  fi
  classify_current_user_keychain_list
}
report_user_keychain_restore_failure() {
  printf '::error::Could not restore the original user keychain search list; state=%s. The temporary keychain and recovery files are preserved at %q. Restore the original list with: security list-keychains -d user -s' "$user_keychain_list_state" "$temporary_directory" >&2
  if [[ "${#original_user_keychains[@]}" -gt 0 ]]; then
    printf ' %q' "${original_user_keychains[@]}" >&2
  fi
  printf '\nAfter verifying the original list is restored, remove the temporary keychain with: security delete-keychain %q && rm -rf %q\n' "$keychain_path" "$temporary_directory" >&2
}
cleanup() {
  if [[ "$user_keychain_list_saved" == yes ]] && ! restore_user_keychain_list; then
    inspect_current_user_keychain_list
    if [[ "$user_keychain_list_state" != restored ]]; then
      report_user_keychain_restore_failure
      if [[ -n "${certificate_path:-}" ]]; then
        rm -f "$certificate_path" || true
      fi
      return 0
    fi
  fi
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
pkcs12_help="$(openssl pkcs12 -help 2>&1 || true)"
pkcs12_legacy_supported=no
if [[ "$pkcs12_help" == *"-legacy"* ]]; then
  pkcs12_legacy_supported=yes
fi
read_pkcs12() {
  if [[ "$pkcs12_legacy_supported" == yes ]]; then
    openssl pkcs12 -legacy "$@"
  else
    openssl pkcs12 "$@"
  fi
}
if ! certificate_subject="$(read_pkcs12 -in "$certificate_path" -clcerts -nokeys -passin env:MACOS_CERTIFICATE_PASSWORD | openssl x509 -noout -subject -nameopt RFC2253)"; then
  echo "::error::Could not inspect the imported signing certificate subject"
  exit 1
fi
certificate_subject="${certificate_subject#subject=}"
if [[ ! "$certificate_subject" =~ (^|,)CN=Developer\ ID\ Application:\ .+\ \(${APPLE_TEAM_ID}\)(,|$) ]] || [[ ! "$certificate_subject" =~ (^|,)OU=${APPLE_TEAM_ID}(,|$) ]]; then
  echo "::error::Imported certificate is not a Developer ID Application identity for the configured team"
  exit 1
fi
if ! identity_fingerprint="$(read_pkcs12 -in "$certificate_path" -clcerts -nokeys -passin env:MACOS_CERTIFICATE_PASSWORD | openssl x509 -noout -fingerprint -sha1)"; then
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
identity="$(printf '%s' "$identity" | LC_ALL=C tr '[:lower:]' '[:upper:]')"
identity_lookup_status=0
identity_listing="$(security find-identity -v -p codesigning "$keychain_path" 2>&1)" || identity_lookup_status=$?
identity_listed=no
signing_identity=""
matching_identity_count=0
identity_entry_regex='^[[:space:]]*[0-9]+\)[[:space:]]+([[:xdigit:]]{40})[[:space:]]+"([^"]+)"[[:space:]]*$'
if [[ "$identity_lookup_status" -eq 0 ]]; then
  while IFS= read -r identity_line; do
    if [[ "$identity_line" =~ $identity_entry_regex ]]; then
      listed_fingerprint="${BASH_REMATCH[1]}"
      listed_identity="${BASH_REMATCH[2]}"
      listed_fingerprint="$(printf '%s' "$listed_fingerprint" | LC_ALL=C tr '[:lower:]' '[:upper:]')"
      if [[ "$listed_fingerprint" == "$identity" ]]; then
        signing_identity="$listed_identity"
        matching_identity_count=$((matching_identity_count + 1))
      fi
    fi
  done <<< "$identity_listing"
fi
if [[ "$identity_lookup_status" -eq 0 && "$matching_identity_count" -eq 1 ]]; then
  matching_name_count=0
  while IFS= read -r identity_line; do
    if [[ "$identity_line" =~ $identity_entry_regex ]] && [[ "${BASH_REMATCH[2]}" == "$signing_identity" ]]; then
      matching_name_count=$((matching_name_count + 1))
    fi
  done <<< "$identity_listing"
  if [[ "$matching_name_count" -eq 1 ]]; then
    identity_listed=yes
  fi
fi
printf 'Keychain identity diagnostic: query_status=%s, expected_identity_listed=%s.\n' "$identity_lookup_status" "$identity_listed"
if [[ "$identity_listed" != yes ]]; then
  echo "::error::Imported certificate does not resolve to a unique valid code-signing identity in the temporary keychain"
  exit 1
fi
capture_original_user_keychains

printf 'Signing with the Keychain identity matched to the imported certificate.\n'

user_keychain_list_saved=yes
if ! security list-keychains -d user -s "$keychain_path" >/dev/null 2>&1; then
  echo "::error::Could not set temporary user keychain search list for signing"
  exit 1
fi
signing_status=0
codesign --force --timestamp --identifier "$identifier" --requirements "=$requirement" --sign "$signing_identity" "$binary" || signing_status=$?
if ! restore_user_keychain_list; then
  echo "::error::Could not restore original user keychain search list after signing"
  exit 1
fi
if [[ "$signing_status" -ne 0 ]]; then
  exit "$signing_status"
fi
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
