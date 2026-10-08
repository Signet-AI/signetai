#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <package> <version> <dist-tag>" >&2
  exit 2
fi

package="$1"
version="$2"
tag="$3"
if ! current=$(npm view "${package}" "dist-tags.${tag}" 2>/dev/null); then
  echo "::warning::Could not read ${package}@${tag}; setting it to ${version} without an ordering check"
  current=""
fi
plain='^[0-9]+\.[0-9]+\.[0-9]+$'
if [ -n "${current}" ] && { [[ ! "${current}" =~ ${plain} ]] || [[ ! "${version}" =~ ${plain} ]]; }; then
  echo "::warning::Not ordering ${package}@${tag} (${current}) against ${version}; setting it to ${version}"
  current=""
fi
if [ -n "${current}" ] && [ "${current}" != "${version}" ]; then
  newest=$(printf '%s\n%s\n' "${current}" "${version}" | sort -V | tail -n1)
  if [ "${newest}" = "${current}" ]; then
    echo "${package}@${tag} is already ${current}; leaving it ahead of ${version}"
    exit 0
  fi
fi

npm dist-tag add "${package}@${version}" "${tag}"
