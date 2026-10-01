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
diagnostic_original_keychains=()
diagnostic_keychains_saved=no
diagnostic_keychain_reference=unknown
parse_keychain_entry() {
  local line="$1"
  if [[ "${line:0:1}" != ' ' ]]; then
    return 1
  fi
  line="${line:1}"
  local line_length="${#line}"
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
restore_diagnostic_keychains() {
  if [[ "$diagnostic_keychains_saved" != yes ]]; then
    return 0
  fi
  if ! security list-keychains -d user -s "${diagnostic_original_keychains[@]}" >/dev/null 2>&1; then
    return 1
  fi
  restored_keychain_list="$(security list-keychains -d user 2>/dev/null)" || return 1
  if [[ "$restored_keychain_list" != "$original_keychain_list" ]]; then
    return 1
  fi
  diagnostic_keychains_saved=no
}
inspect_temporary_keychain_reference() {
  local current_keychain_list=""
  local current_keychain_list_hex=""
  local current_keychain_line=""
  local current_keychain_path=""
  diagnostic_keychain_reference=unknown
  if ! security list-keychains -d user > "$current_keychain_list_file" 2>/dev/null; then
    return 0
  fi
  if ! current_keychain_list_hex="$(LC_ALL=C od -An -v -tx1 "$current_keychain_list_file")"; then
    return 0
  fi
  if [[ "$current_keychain_list_hex" =~ (^|[[:space:]])00([[:space:]]|$) ]]; then
    return 0
  fi
  if ! current_keychain_list="$(cat "$current_keychain_list_file")"; then
    return 0
  fi
  while IFS= read -r current_keychain_line; do
    if ! current_keychain_path="$(parse_keychain_entry "$current_keychain_line")"; then
      return 0
    fi
    if [[ "$current_keychain_path" == "$keychain_path" ]]; then
      diagnostic_keychain_reference=referenced
      return 0
    fi
  done <<< "$current_keychain_list"
  diagnostic_keychain_reference=not_referenced
}
report_diagnostic_restore_failure() {
  if [[ "$diagnostic_keychain_reference" == not_referenced ]]; then
    printf '::error::Could not verify original keychain search list, but the current list does not reference the temporary keychain. To restore the original list, run: security list-keychains -d user -s' >&2
  elif [[ "$diagnostic_keychain_reference" == referenced ]]; then
    printf '::error::Temporary keychain remains in the user search list and is preserved at %q. To recover, run: security list-keychains -d user -s' "$keychain_path" >&2
  else
    printf '::error::Could not verify whether the user search list references the temporary keychain. It is preserved at %q. To recover, run: security list-keychains -d user -s' "$keychain_path" >&2
  fi
  printf ' %q' "${diagnostic_original_keychains[@]}" >&2
  if [[ "$diagnostic_keychain_reference" == not_referenced ]]; then
    printf '\n' >&2
  else
    printf '; then remove %q\n' "$temporary_directory" >&2
  fi
}
cleanup() {
  if [[ "$diagnostic_keychains_saved" == yes ]] && ! restore_diagnostic_keychains; then
    inspect_temporary_keychain_reference
    report_diagnostic_restore_failure
    if [[ "$diagnostic_keychain_reference" != not_referenced ]]; then
      if [[ -n "${certificate_path:-}" ]]; then
        rm -f "$certificate_path" || true
      fi
      if [[ -n "${probe_binary:-}" ]]; then
        rm -f "$probe_binary" || true
      fi
      rm -f "$original_keychain_list_file" "$current_keychain_list_file" || true
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

if [[ "${SIGNING_DIAGNOSTIC_PROBE:-}" == true ]]; then
  probe_binary="${temporary_directory}/codesign-probe"
  cp /usr/bin/true "$probe_binary"
  explicit_keychain_status=0
  codesign --force --timestamp --identifier "$identifier" --requirements "=$requirement" --keychain "$keychain_path" --sign "$signing_identity" "$probe_binary" >/dev/null 2>&1 || explicit_keychain_status=$?

  search_list_status=not_run
  search_list_restore_status=not_run
  if ! security list-keychains -d user > "$original_keychain_list_file" 2>/dev/null; then
    echo "::error::Could not read original user keychain search list for diagnostic probe"
    exit 1
  fi
  if ! original_keychain_list_hex="$(LC_ALL=C od -An -v -tx1 "$original_keychain_list_file")"; then
    echo "::error::Could not inspect original user keychain search list for diagnostic probe"
    exit 1
  fi
  if [[ "$original_keychain_list_hex" =~ (^|[[:space:]])00([[:space:]]|$) ]]; then
    echo "::error::Original user keychain search list contains NUL bytes"
    exit 1
  fi
  if ! original_keychain_list="$(cat "$original_keychain_list_file")"; then
    echo "::error::Could not read original user keychain search list for diagnostic probe"
    exit 1
  fi
  keychain_list_valid=yes
  while IFS= read -r keychain_line; do
    if ! original_keychain_path="$(parse_keychain_entry "$keychain_line")"; then
      keychain_list_valid=no
      break
    fi
    diagnostic_original_keychains+=( "$original_keychain_path" )
  done <<< "$original_keychain_list"
  if [[ "$keychain_list_valid" != yes || "${#diagnostic_original_keychains[@]}" -eq 0 ]]; then
    echo "::error::Could not parse original user keychain search list for diagnostic probe"
    exit 1
  fi
  diagnostic_keychains_saved=yes
  if ! security list-keychains -d user -s "$keychain_path" >/dev/null 2>&1; then
    search_list_restore_status=1
    echo "::error::Could not set temporary user keychain search list for diagnostic probe"
    exit 1
  fi
  search_list_status=0
  codesign --force --timestamp --identifier "$identifier" --requirements "=$requirement" --sign "$signing_identity" "$probe_binary" >/dev/null 2>&1 || search_list_status=$?
  if restore_diagnostic_keychains; then
    search_list_restore_status=0
  else
    search_list_restore_status=1
    echo "::error::Could not restore original user keychain search list after diagnostic probe"
    exit 1
  fi
  printf 'Signing diagnostic probe: explicit_keychain_status=%s, search_list_status=%s, search_list_restore_status=%s.\n' "$explicit_keychain_status" "$search_list_status" "$search_list_restore_status"
fi

printf 'Signing with the Keychain identity matched to the imported certificate.\n'

codesign --force --timestamp --identifier "$identifier" --requirements "=$requirement" --keychain "$keychain_path" --sign "$signing_identity" "$binary"
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
