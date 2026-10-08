#!/usr/bin/env bash
set -euo pipefail

# Prints the first release-relevant path changed between two refs, or nothing.
# With --since-release, the base is the newest v* tag reachable from head.

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <base-ref|--since-release> <head-ref>" >&2
  exit 2
fi

base="$1"
head="$2"
if [ "${base}" = "--since-release" ]; then
  base=$(git describe --tags --abbrev=0 --match 'v[0-9]*' "${head}")
  echo "Comparing ${base}..${head}" >&2
fi

changed=$(git diff --name-only "${base}" "${head}" -- \
  'platform/**' 'surfaces/**' 'integrations/**' 'libs/**' 'dist/**' 'plugins/**' 'runtimes/**' 'scripts/**' \
  'package.json' 'bunfig.toml' 'tsconfig*.json' \
  '.github/workflows/**')
printf '%s\n' "${changed}" | grep -v -E '(^$|\.(md|jpg|jpeg|png|svg)$)' | head -1 || true
