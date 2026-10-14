import { posix } from 'node:path'
import { shellQuote as q } from '../../../wrappers/remote-ssh-session'
import type { PhiExtensionBundle } from './types'

export const PRIVATE_REMOTE_FUNCTIONS = `set -eu
umask 077
fail() { printf 'PHI_EXT:%s\\n' "$*" >&2; exit 1; }
owned() {
  [ ! -L "$1" ] || fail "Symbolic managed path: $1"
  owner=$(stat -c %u -- "$1" 2>/dev/null || stat -f %u "$1")
  [ "$owner" = "$(id -u)" ] || fail "Managed path has another owner: $1"
}
private_dir() {
  [ ! -L "$1" ] || fail "Symbolic managed directory: $1"
  if [ ! -e "$1" ]; then
    mkdir -- "$1" 2>/dev/null || { [ -d "$1" ] && [ ! -L "$1" ]; } || fail "Cannot create managed directory: $1"
  fi
  [ -d "$1" ] || fail "Managed path is not a directory: $1"
  owned "$1"
  chmod 700 "$1" || fail "Cannot make managed directory private: $1"
  mode=$(stat -c %a -- "$1" 2>/dev/null || stat -f %Lp "$1")
  [ "$mode" = 700 ] || fail "Managed directory permissions are not private: $1"
}
private_file() {
  [ -f "$1" ] && [ ! -L "$1" ] || fail "Managed path is not a regular file: $1"
  owned "$1"
  links=$(stat -c %h -- "$1" 2>/dev/null || stat -f %l "$1")
  [ "$links" = 1 ] || fail "Managed file has multiple links: $1"
  chmod 600 "$1" || fail "Cannot make managed file private: $1"
  mode=$(stat -c %a -- "$1" 2>/dev/null || stat -f %Lp "$1")
  [ "$mode" = 600 ] || fail "Managed file permissions are not private: $1"
}
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d ' ' -f1;
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -d ' ' -f1;
  else fail 'SHA256 utility is unavailable'; fi
}`

export function assertRemoteRoot(root: string): void {
  if (
    !posix.isAbsolute(root) ||
    root === '/' ||
    posix.normalize(root) !== root ||
    /[\0\r\n]/.test(root)
  ) {
    throw new Error('Choose an absolute canonical server runtime root')
  }
}

export function privateRemotePrefix(root: string): string {
  assertRemoteRoot(root)
  return `${PRIVATE_REMOTE_FUNCTIONS}\n[ "$(pwd -P)" = ${q(root)} ] || fail 'Runtime root must be canonical and match the host root'
owned ${q(root)}
root_mode=$(stat -c %a -- ${q(root)} 2>/dev/null || stat -f %Lp ${q(root)})
case "$root_mode" in ''|*[!0-7]*) fail 'Cannot inspect runtime root permissions';; esac
[ "$((0$root_mode & 0022))" = 0 ] || fail 'Runtime root is writable by another user or group'`
}

export function bundleDirectories(bundle: PhiExtensionBundle): string[] {
  const paths = new Set<string>()
  for (const file of bundle.files) {
    let directory = posix.dirname(file.path)
    while (directory !== '.') {
      paths.add(directory)
      directory = posix.dirname(directory)
    }
  }
  return [...paths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}

/** Return status only after every expected file, directory and the manifest has been checked. */
export function verifyBundleCommand(
  directory: string,
  bundle: PhiExtensionBundle,
  manifestHash: string
): string {
  const directories = bundleDirectories(bundle)
  return `verify_bundle() (
  [ -d ${q(directory)} ] && [ ! -L ${q(directory)} ] || exit 1
  private_dir ${q(directory)}
  ${directories.map((path) => `private_dir ${q(posix.join(directory, path))}`).join('\n  ')}
  ${[
    ...bundle.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    { path: 'manifest.json', sha256: manifestHash }
  ]
    .map(
      (file) =>
        `private_file ${q(posix.join(directory, file.path))}\n  [ "$(hash_file ${q(posix.join(directory, file.path))})" = ${q(file.sha256)} ] || exit 1`
    )
    .join('\n  ')}
  count=$(find ${q(directory)} -mindepth 1 -print | wc -l | tr -d ' ')
  [ "$count" = ${q(String(bundle.files.length + directories.length + 1))} ] || exit 1
)
if verify_bundle; then printf 'PHI_EXTENSION_VALID\\n'; fi`
}
