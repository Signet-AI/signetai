#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <tag>" >&2
  exit 2
fi

tag="$1"
state=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/releases?per_page=100" --jq ".[] | select(.tag_name == \"${tag}\") | .draft")
if [ "${state}" != "true" ]; then
  echo "::error::${tag} is not exactly one draft release; published releases are never rebuilt or re-uploaded"
  exit 1
fi
