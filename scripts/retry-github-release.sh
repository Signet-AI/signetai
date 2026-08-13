#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 command [args...]" >&2
  exit 2
fi

max_attempts=3
retry_delay_seconds="${RELEASE_API_RETRY_DELAY_SECONDS:-5}"
if ! [[ "${retry_delay_seconds}" =~ ^[0-9]+$ ]]; then
  echo "RELEASE_API_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
  exit 2
fi

is_retryable_failure() {
  local output="$1"
  [[ "${output}" =~ (^|[^0-9])HTTP[[:space:]]+5[0-9][0-9]([^0-9]|$) ]]
}

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  set +e
  output=$("$@" 2>&1)
  status=$?
  set -e

  if [ "${status}" -eq 0 ]; then
    printf '%s\n' "${output}"
    exit 0
  fi

  printf '%s\n' "${output}" >&2
  if ! is_retryable_failure "${output}" || [ "${attempt}" -eq "${max_attempts}" ]; then
    exit "${status}"
  fi

  delay=$((attempt * retry_delay_seconds))
  echo "Retryable GitHub API failure on attempt ${attempt}/${max_attempts}; retrying in ${delay}s" >&2
  sleep "${delay}"
done

exit 1
