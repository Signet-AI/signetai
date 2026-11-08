#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <package> <version> <dist-tag>" >&2
  exit 2
fi

package="$1"
version="$2"
tag="$3"
current=$(npm view "${package}" "dist-tags.${tag}")
order=$(bun -e '
  const [version, current] = process.argv.slice(1);
  for (const value of [version, current].filter(Boolean)) {
    Bun.semver.order(value, value);
  }
  console.log(current ? Bun.semver.order(version, current) : 1);
' "${version}" "${current}")
if [ "${order}" -lt 0 ]; then
  echo "${package}@${tag} is already ${current}; leaving it ahead of ${version}"
  exit 0
fi

npm dist-tag add "${package}@${version}" "${tag}"
