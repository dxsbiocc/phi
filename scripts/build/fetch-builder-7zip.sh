#!/usr/bin/env bash
set -euo pipefail

repo=electron-userland/electron-builder-binaries
release=7zip@1.0.0
# Match the toolset and hashes pinned by electron-builder 26.15.3.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    archive=7zip-darwin-arm64.tar.gz
    checksum=496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1
    ;;
  Linux-x86_64)
    archive=7zip-linux-x64.tar.gz
    checksum=d151bb44b2a9d9bfc52813ce4cac042916394a0ab8a56bd5d221a5dc9ef8d5d7
    ;;
  *)
    echo 'No pinned release 7-Zip for this host' >&2
    exit 1
    ;;
esac

destination=${1:?Specify the destination for the verified 7-Zip toolset}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
if ! node -e '
  const { spawnSync } = require("node:child_process");
  const result = spawnSync("gh", process.argv.slice(1), { timeout: 90000, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
' release download "$release" --repo "$repo" --pattern "$archive" --dir "$scratch"; then
  curl --fail --location --silent --show-error --retry 3 --retry-connrefused \
    --connect-timeout 10 --max-time 60 --retry-max-time 180 \
    --output "$scratch/$archive" "https://github.com/$repo/releases/download/$release/$archive"
fi
(
  cd "$scratch"
  printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 --check
) >&2
mkdir -p "$destination"
tar -xzf "$scratch/$archive" -C "$destination" --strip-components 1
test -x "$destination/bin/7za"
printf '%s\n' "$destination/bin/7za"
