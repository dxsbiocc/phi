import { posix } from 'node:path'

import { REMOTE_RIPGREP_COMPLETE_MARKER } from '../../../shared/remoteRipgrepTypes'
import {
  shellQuote,
  type RemoteExecBoundedResult,
  type RemoteSshSession
} from '../wrappers/remote-ssh-session'

export interface RemoteExecutableCandidate {
  version: string
  executablePath: string
}

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const STATUS_TIMEOUT_MS = 10_000
const MAX_STATUS_OUTPUT_BYTES = 32 * 1024

export async function runBoundedRemoteCommand(
  session: RemoteSshSession,
  command: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal
): Promise<RemoteExecBoundedResult> {
  if (!session.execBounded) throw new Error('bounded exec unavailable')
  return session.execBounded(command, { timeoutMs, maxOutputBytes, signal })
}

export function validRemoteRipgrepRoot(root: string): boolean {
  return (
    Boolean(root) &&
    !/[\0\r\n]/.test(root) &&
    (root.startsWith('/') || root.startsWith('~/')) &&
    !root.split('/').includes('..')
  )
}

function rootAssignment(runtimeRoot: string): string {
  return [
    `phi_root=${shellQuote(runtimeRoot)}`,
    `case "$phi_root" in '~/'*) phi_root=$HOME/\${phi_root#'~/'} ;; esac`
  ].join('\n')
}

export function parseRipgrepVersion(output: string): string | undefined {
  const version = output.match(/^ripgrep\s+([A-Za-z0-9][A-Za-z0-9._+-]*)/m)?.[1]
  return version && VERSION_PATTERN.test(version) ? version : undefined
}

export function parseRemoteCandidates(output: string): RemoteExecutableCandidate[] {
  const fields = output.split('\0')
  const candidates: RemoteExecutableCandidate[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const version = fields[index]
    const executablePath = fields[index + 1]
    if (VERSION_PATTERN.test(version) && executablePath.startsWith('/')) {
      candidates.push({ version, executablePath })
    }
  }
  return candidates.sort((left, right) =>
    right.version.localeCompare(left.version, undefined, { numeric: true })
  )
}

export function buildSystemRipgrepScript(): string {
  return [
    'phi_rg=$(command -v rg 2>/dev/null) || exit 3',
    'case "$phi_rg" in /*) ;; *) exit 4 ;; esac',
    'test -x "$phi_rg" && ! test -d "$phi_rg" || exit 5',
    `printf '%s\\0' "$phi_rg"`,
    '"$phi_rg" --version'
  ].join('\n')
}

export async function findSystemRipgrep(
  session: RemoteSshSession,
  signal?: AbortSignal
): Promise<RemoteExecutableCandidate | undefined> {
  const result = await runBoundedRemoteCommand(
    session,
    buildSystemRipgrepScript(),
    STATUS_TIMEOUT_MS,
    MAX_STATUS_OUTPUT_BYTES,
    signal
  )
  if (result.code !== 0) return undefined
  const separator = result.stdout.indexOf('\0')
  const executablePath = separator >= 0 ? result.stdout.slice(0, separator) : ''
  const version = parseRipgrepVersion(result.stdout.slice(separator + 1))
  return executablePath.startsWith('/') && version ? { executablePath, version } : undefined
}

export function buildManagedRipgrepScanScript(runtimeRoot: string): string {
  return [
    rootAssignment(runtimeRoot),
    'phi_tools="$phi_root/tools"',
    'test -d "$phi_tools" || exit 0',
    'test ! -L "$phi_tools" || exit 6',
    `for phi_marker in "$phi_tools"/ripgrep-*/${REMOTE_RIPGREP_COMPLETE_MARKER}; do`,
    '  test -f "$phi_marker" && test ! -L "$phi_marker" || continue',
    '  phi_dir=${phi_marker%/*}',
    '  test -d "$phi_dir" && test ! -L "$phi_dir" || continue',
    '  phi_version=$(cat "$phi_marker")',
    '  phi_base=${phi_dir##*/}',
    '  test "$phi_base" = "ripgrep-$phi_version" || continue',
    '  phi_rg="$phi_dir/bin/rg"',
    '  test -f "$phi_rg" && test -x "$phi_rg" && test ! -L "$phi_rg" || continue',
    `  printf '%s\\0%s\\0' "$phi_version" "$phi_rg"`,
    'done'
  ].join('\n')
}

export async function verifyRemoteRipgrepCandidate(
  session: RemoteSshSession,
  candidate: RemoteExecutableCandidate,
  signal?: AbortSignal
): Promise<boolean> {
  const result = await runBoundedRemoteCommand(
    session,
    `${shellQuote(candidate.executablePath)} --version`,
    STATUS_TIMEOUT_MS,
    MAX_STATUS_OUTPUT_BYTES,
    signal
  )
  return result.code === 0 && parseRipgrepVersion(result.stdout) === candidate.version
}

export async function findManagedRipgrep(
  session: RemoteSshSession,
  runtimeRoot: string,
  signal?: AbortSignal
): Promise<RemoteExecutableCandidate | undefined> {
  const scan = await runBoundedRemoteCommand(
    session,
    buildManagedRipgrepScanScript(runtimeRoot),
    STATUS_TIMEOUT_MS,
    MAX_STATUS_OUTPUT_BYTES,
    signal
  )
  if (scan.code !== 0) throw new Error('managed ripgrep scan failed')
  for (const candidate of parseRemoteCandidates(scan.stdout)) {
    if (await verifyRemoteRipgrepCandidate(session, candidate, signal)) return candidate
  }
  return undefined
}

export function buildMicromambaScanScript(root: string): string {
  return [
    `phi_root=${shellQuote(root)}`,
    'for phi_mamba in "$phi_root"/bin/micromamba-*/micromamba; do',
    '  test -f "$phi_mamba" && test -x "$phi_mamba" && test ! -L "$phi_mamba" || continue',
    '  phi_release=${phi_mamba%/micromamba}',
    '  phi_release=${phi_release##*/micromamba-}',
    `  printf '%s\\0%s\\0' "$phi_release" "$phi_mamba"`,
    'done'
  ].join('\n')
}

export async function findLatestMicromamba(
  session: RemoteSshSession,
  root: string,
  signal?: AbortSignal
): Promise<RemoteExecutableCandidate | undefined> {
  const scan = await runBoundedRemoteCommand(
    session,
    buildMicromambaScanScript(root),
    STATUS_TIMEOUT_MS,
    MAX_STATUS_OUTPUT_BYTES,
    signal
  )
  if (scan.code !== 0) return undefined
  for (const candidate of parseRemoteCandidates(scan.stdout)) {
    const result = await runBoundedRemoteCommand(
      session,
      `${shellQuote(candidate.executablePath)} --version`,
      STATUS_TIMEOUT_MS,
      MAX_STATUS_OUTPUT_BYTES,
      signal
    )
    if (result.code === 0) return candidate
  }
  return undefined
}

export function buildPrepareRipgrepPrefixScript(root: string, temporaryPrefix: string): string {
  const tools = posix.join(root, 'tools')
  return [
    'umask 077',
    `phi_tools=${shellQuote(tools)}`,
    'test ! -L "$phi_tools" || exit 12',
    'mkdir -p -m 700 "$phi_tools" || exit 13',
    'chmod 700 "$phi_tools" || exit 13',
    `test ! -e ${shellQuote(temporaryPrefix)} && test ! -L ${shellQuote(temporaryPrefix)}`
  ].join('\n')
}

export function buildCreateRipgrepPrefixCommand(
  root: string,
  micromambaPath: string,
  temporaryPrefix: string
): string {
  return `MAMBA_ROOT_PREFIX=${shellQuote(root)} ${shellQuote(micromambaPath)} create -p ${shellQuote(temporaryPrefix)} --override-channels -c conda-forge --yes ripgrep`
}

export function buildWriteRipgrepMarkerCommand(temporaryPrefix: string, version: string): string {
  const marker = posix.join(temporaryPrefix, REMOTE_RIPGREP_COMPLETE_MARKER)
  const partial = `${marker}.partial`
  return `umask 077\nprintf '%s\\n' ${shellQuote(version)} > ${shellQuote(partial)} && chmod 600 ${shellQuote(partial)} && mv ${shellQuote(partial)} ${shellQuote(marker)}`
}

export function buildActivateRipgrepPrefixScript(
  temporaryPrefix: string,
  finalPrefix: string,
  version: string
): string {
  const marker = posix.join(finalPrefix, REMOTE_RIPGREP_COMPLETE_MARKER)
  const executable = posix.join(finalPrefix, 'bin', 'rg')
  const validateExisting = [
    `test -d ${shellQuote(finalPrefix)} && test ! -L ${shellQuote(finalPrefix)} || exit 18`,
    `test "$(cat ${shellQuote(marker)} 2>/dev/null)" = ${shellQuote(version)} || exit 18`,
    `test -x ${shellQuote(executable)} && test ! -L ${shellQuote(executable)} || exit 18`
  ]
  return [
    `if test -e ${shellQuote(finalPrefix)} || test -L ${shellQuote(finalPrefix)}; then`,
    ...validateExisting.map((line) => `  ${line}`),
    '  exit 17',
    'fi',
    `if mv -T -- ${shellQuote(temporaryPrefix)} ${shellQuote(finalPrefix)} 2>/dev/null; then exit 0; fi`,
    `if test -e ${shellQuote(finalPrefix)} || test -L ${shellQuote(finalPrefix)}; then`,
    ...validateExisting.map((line) => `  ${line}`),
    '  exit 17',
    'fi',
    `mv ${shellQuote(temporaryPrefix)} ${shellQuote(finalPrefix)}`
  ].join('\n')
}

export function ripgrepSourceUnavailable(output: string): boolean {
  return /Could not resolve host|conda\.anaconda\.org|repodata|network|connection|timed? out/i.test(
    output
  )
}
