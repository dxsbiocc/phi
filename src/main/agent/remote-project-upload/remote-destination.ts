import { posix } from 'node:path'

import type { RemoteSshSession } from '../wrappers/remote-ssh-session'

export type RemoteDestination = Readonly<{
  path: string
  originalPath: string
  action: 'upload' | 'reuse'
  renamed: boolean
}>

type ResolveRemoteDestinationOptions = Readonly<{
  session: RemoteSshSession
  remoteProjectRoot: string
  canonicalRemoteProjectRoot: string
  destinationDirectory: string
  relativePath: string
  sha256: string
  signal: AbortSignal
}>

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function checkedRelativePath(path: string): string {
  if (
    !path ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path === '..' ||
    path.startsWith('../') ||
    /[\0\r\n]/.test(path)
  ) {
    throw new Error('Remote upload path must stay inside the project root')
  }
  return path
}

function directorySafetyScript(
  remoteRoot: string,
  canonicalRoot: string,
  relativeDirectory: string
): string {
  const checks = [
    `root=${shellQuote(remoteRoot)}`,
    `canonical_root=${shellQuote(canonicalRoot)}`,
    '[ -d "$root" ] || fail INVALID_ROOT',
    '[ ! -L "$root" ] || [ "$(cd -P -- "$root" && pwd)" = "$canonical_root" ] || fail INVALID_ROOT',
    '[ "$(cd -P -- "$root" && pwd)" = "$canonical_root" ] || fail INVALID_ROOT'
  ]
  let remoteDirectory = remoteRoot
  let canonicalDirectory = canonicalRoot
  for (const component of relativeDirectory.split('/').filter(Boolean)) {
    remoteDirectory = posix.join(remoteDirectory, component)
    canonicalDirectory = posix.join(canonicalDirectory, component)
    checks.push(
      `current=${shellQuote(remoteDirectory)}`,
      `expected=${shellQuote(canonicalDirectory)}`,
      '[ ! -L "$current" ] || fail UNSAFE_DIRECTORY',
      'if [ ! -e "$current" ]; then mkdir -- "$current" 2>/dev/null || [ -d "$current" ] || fail CREATE_DIRECTORY; fi',
      '[ -d "$current" ] && [ ! -L "$current" ] || fail UNSAFE_DIRECTORY',
      '[ "$(cd -P -- "$current" && pwd)" = "$expected" ] || fail UNSAFE_DIRECTORY'
    )
  }
  return checks.join('\n')
}

function allocationScript(options: ResolveRemoteDestinationOptions): string {
  const relativePath = checkedRelativePath(
    posix.join(options.destinationDirectory, options.relativePath)
  )
  const relativeDirectory = posix.dirname(relativePath) === '.' ? '' : posix.dirname(relativePath)
  const remoteDirectory = posix.join(options.remoteProjectRoot, relativeDirectory)
  const name = posix.basename(relativePath)
  const extension = posix.extname(name)
  const stem = extension ? name.slice(0, -extension.length) : name
  return `set -eu
fail() { printf 'PHI_ERROR=%s\\n' "$1"; exit 71; }
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else return 1
  fi
}
${directorySafetyScript(options.remoteProjectRoot, options.canonicalRemoteProjectRoot, relativeDirectory)}
directory=${shellQuote(remoteDirectory)}
name=${shellQuote(name)}
stem=${shellQuote(stem)}
extension=${shellQuote(extension)}
expected_hash=${shellQuote(options.sha256)}
index=0
while [ "$index" -le 9999 ]; do
  if [ "$index" -eq 0 ]; then candidate="$directory/$name"; else candidate="$directory/$stem ($index)$extension"; fi
  [ ! -L "$candidate" ] || fail UNSAFE_DESTINATION
  if [ ! -e "$candidate" ]; then action=upload; break; fi
  if [ -f "$candidate" ]; then
    actual_hash=$(hash_file "$candidate") || fail HASH_UNAVAILABLE
    if [ "$actual_hash" = "$expected_hash" ]; then action=reuse; break; fi
  fi
  index=$((index + 1))
done
[ "$index" -le 9999 ] || fail NAME_EXHAUSTED
printf 'PHI_ACTION=%s\\nPHI_RENAMED=%s\\nPHI_PATH_HEX=' "$action" "$( [ "$index" -eq 0 ] && printf 0 || printf 1 )"
printf '%s' "$candidate" | od -An -tx1 -v | tr -d ' \\n'
printf '\\n'`
}

export async function resolveRemoteDestination(
  options: ResolveRemoteDestinationOptions
): Promise<RemoteDestination> {
  if (!options.session.execBounded) throw new Error('SSH connection lacks bounded upload control')
  if (!/^[a-f0-9]{64}$/.test(options.sha256)) throw new Error('Local SHA-256 is invalid')
  options.signal.throwIfAborted()
  const result = await options.session.execBounded(
    `sh -c ${shellQuote(allocationScript(options))}`,
    { timeoutMs: 30 * 60 * 1000, maxOutputBytes: 16 * 1024, signal: options.signal }
  )
  options.signal.throwIfAborted()
  if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    const code = /^PHI_ERROR=([^\r\n]+)$/m.exec(result.stdout)?.[1]
    throw new Error(`Remote upload destination is unsafe or unavailable${code ? ` (${code})` : ''}`)
  }
  const action = /^PHI_ACTION=(upload|reuse)$/m.exec(result.stdout)?.[1]
  const renamed = /^PHI_RENAMED=([01])$/m.exec(result.stdout)?.[1]
  const encodedPath = /^PHI_PATH_HEX=([a-f0-9]+)$/m.exec(result.stdout)?.[1]
  if (!action || !renamed || !encodedPath || encodedPath.length % 2 !== 0) {
    throw new Error('Remote upload destination response is invalid')
  }
  const path = Buffer.from(encodedPath, 'hex').toString('utf8')
  const relative = posix.relative(options.remoteProjectRoot, path)
  if (
    Buffer.from(path).toString('hex') !== encodedPath ||
    !relative ||
    relative === '..' ||
    relative.startsWith('../') ||
    posix.isAbsolute(relative)
  ) {
    throw new Error('Remote upload destination escaped the project root')
  }
  return {
    path,
    originalPath: posix.join(
      options.remoteProjectRoot,
      options.destinationDirectory,
      options.relativePath
    ),
    action: action === 'reuse' ? 'reuse' : 'upload',
    renamed: renamed === '1'
  }
}
