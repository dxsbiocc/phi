import { shellQuote } from '../wrappers/remote-ssh-session'

import type {
  RemoteMicromambaDownloadCapability,
  RemoteMicromambaDownloadTool
} from '../../../shared/remoteRuntimeRootTypes'

const HASH_MARKER = '__PHI_MICROMAMBA_HASH__='
const HASH_ERROR_MARKER = '__PHI_MICROMAMBA_HASH_ERROR__='
const NETWORK_MARKER = '__PHI_MICROMAMBA_NETWORK__='
const SIZE_MARKER = '__PHI_MICROMAMBA_SIZE__='
const VERSION_MARKER = '__PHI_MICROMAMBA_VERSION__='
const PLATFORM_MARKER = '__PHI_MICROMAMBA_PLATFORM__='
const STATUS_MARKER = '__PHI_MICROMAMBA_STATUS__='
const ROOT_MARKER = '__PHI_MICROMAMBA_ROOT__='
const RELEASE_MARKER = '__PHI_MICROMAMBA_RELEASE__='

export interface ParsedRemoteHash {
  hash?: string
  error?: 'missing-tool' | 'failed'
}

export interface ParsedMicromambaVerification {
  version: string | null
  platform: string | null
  runnable: boolean
}

export interface ParsedMicromambaStatusScan {
  state: 'ok' | 'missing' | 'failed'
  root?: string
  versions: readonly string[]
}

export function buildPrepareRuntimeScript(root: string): string {
  return [
    'set -eu',
    `phi_root=${shellQuote(root)}`,
    'phi_bin=$phi_root/bin',
    'if [ -e "$phi_root" ] || [ -L "$phi_root" ]; then',
    '  [ -d "$phi_root" ] || exit 20',
    'else',
    '  (umask 077; mkdir -p "$phi_root") || exit 21',
    '  chmod 700 "$phi_root" || exit 21',
    'fi',
    'if [ -e "$phi_bin" ] || [ -L "$phi_bin" ]; then',
    '  [ -d "$phi_bin" ] || exit 22',
    'else',
    '  (umask 077; mkdir "$phi_bin") || exit 23',
    '  chmod 700 "$phi_bin" || exit 23',
    'fi'
  ].join('\n')
}

export function buildHashScript(path: string): string {
  return [
    'set +e',
    `phi_file=${shellQuote(path)}`,
    'phi_hash=',
    'phi_tool=0',
    'phi_valid_hash() { printf %s "$1" | grep -Eq \x27^[0-9a-fA-F]{64}$\x27; }',
    'if command -v sha256sum >/dev/null 2>&1; then',
    '  phi_tool=1',
    '  phi_hash=$(sha256sum -- "$phi_file" 2>/dev/null | awk \x27{print $1}\x27)',
    'fi',
    'if ! phi_valid_hash "$phi_hash" && command -v shasum >/dev/null 2>&1; then',
    '  phi_tool=1',
    '  phi_hash=$(shasum -a 256 "$phi_file" 2>/dev/null | awk \x27{print $1}\x27)',
    'fi',
    'if ! phi_valid_hash "$phi_hash" && command -v openssl >/dev/null 2>&1; then',
    '  phi_tool=1',
    '  phi_hash=$(openssl dgst -sha256 "$phi_file" 2>/dev/null | sed \x27s/^.*= *//\x27)',
    'fi',
    'if ! phi_valid_hash "$phi_hash" && command -v perl >/dev/null 2>&1 && perl -MDigest::SHA -e 1 >/dev/null 2>&1; then',
    '  phi_tool=1',
    '  phi_hash=$(perl -MDigest::SHA=sha256_hex -e \x27open my $fh, "<", $ARGV[0] or exit 2; binmode $fh; print sha256_hex(do { local $/; <$fh> })\x27 "$phi_file" 2>/dev/null)',
    'fi',
    'if [ "$phi_tool" = 0 ]; then',
    `  printf '%s\\n' '${HASH_ERROR_MARKER}missing-tool'`,
    'elif phi_valid_hash "$phi_hash"; then',
    `  printf '%s%s\\n' '${HASH_MARKER}' "$(printf %s "$phi_hash" | tr A-F a-f)"`,
    'else',
    `  printf '%s\\n' '${HASH_ERROR_MARKER}failed'`,
    'fi'
  ].join('\n')
}

export function parseRemoteHash(stdout: string): ParsedRemoteHash {
  const hash = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(HASH_MARKER))
    ?.slice(HASH_MARKER.length)
  if (hash && /^[a-f0-9]{64}$/.test(hash)) return { hash }
  const error = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(HASH_ERROR_MARKER))
    ?.slice(HASH_ERROR_MARKER.length)
  return { error: error === 'missing-tool' ? 'missing-tool' : 'failed' }
}

export function buildNetworkProbeScript(url: string): string {
  return [
    'set +e',
    `phi_url=${shellQuote(url)}`,
    'phi_has_tool=0',
    'if command -v curl >/dev/null 2>&1; then',
    '  phi_has_tool=1',
    '  if curl -fsSIL --connect-timeout 8 --max-time 8 -- "$phi_url" >/dev/null 2>&1; then',
    `    printf '%s\\n' '${NETWORK_MARKER}reachable:curl'`,
    '    exit 0',
    '  fi',
    'fi',
    'if command -v wget >/dev/null 2>&1; then',
    '  phi_has_tool=1',
    '  if wget -q --spider -T 8 --tries=1 -- "$phi_url" >/dev/null 2>&1; then',
    `    printf '%s\\n' '${NETWORK_MARKER}reachable:wget'`,
    '    exit 0',
    '  fi',
    'fi',
    `if [ "$phi_has_tool" = 0 ]; then printf '%s\\n' '${NETWORK_MARKER}no-tool';`,
    `else printf '%s\\n' '${NETWORK_MARKER}unreachable'; fi`
  ].join('\n')
}

export function parseNetworkProbe(stdout: string): RemoteMicromambaDownloadCapability {
  const value = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(NETWORK_MARKER))
    ?.slice(NETWORK_MARKER.length)
  if (value === 'reachable:curl') return { status: 'reachable', tool: 'curl' }
  if (value === 'reachable:wget') return { status: 'reachable', tool: 'wget' }
  return { status: value === 'no-tool' ? 'no-tool' : 'unreachable' }
}

export function buildDownloadScript(
  url: string,
  stagingPath: string,
  tool: RemoteMicromambaDownloadTool
): string {
  const command =
    tool === 'curl'
      ? 'curl -fL --connect-timeout 8 --max-time 300 -o "$phi_staging" -- "$phi_url"'
      : 'wget -q --timeout=8 --tries=2 -O "$phi_staging" -- "$phi_url"'
  return [
    'set -eu',
    `phi_url=${shellQuote(url)}`,
    `phi_staging=${shellQuote(stagingPath)}`,
    'umask 077',
    command
  ].join('\n')
}

export function buildFileSizeScript(path: string): string {
  return [
    'set +e',
    `phi_file=${shellQuote(path)}`,
    'phi_size=$(wc -c < "$phi_file" 2>/dev/null) || exit 1',
    `printf '%s%s\\n' '${SIZE_MARKER}' "$(printf %s "$phi_size" | tr -d '[:space:]')"`
  ].join('\n')
}

export function parseRemoteFileSize(stdout: string): number | undefined {
  const value = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(SIZE_MARKER))
    ?.slice(SIZE_MARKER.length)
  if (!value || !/^[0-9]+$/.test(value)) return undefined
  const size = Number(value)
  return Number.isSafeInteger(size) ? size : undefined
}

export function buildActivateScript(stagingPath: string, finalPath: string): string {
  return [
    'set -eu',
    `phi_staging=${shellQuote(stagingPath)}`,
    `phi_final=${shellQuote(finalPath)}`,
    'chmod 755 "$phi_staging"',
    'mv -f "$phi_staging" "$phi_final"'
  ].join('\n')
}

export function buildCleanupScript(path: string): string {
  return ['set +e', `phi_staging=${shellQuote(path)}`, 'rm -f "$phi_staging"'].join('\n')
}

export function buildVerificationScript(path: string, root: string): string {
  return [
    'set +e',
    `phi_binary=${shellQuote(path)}`,
    `phi_root=${shellQuote(root)}`,
    'phi_home=${HOME:-/}',
    'phi_version=$(env -i HOME="$phi_home" MAMBA_ROOT_PREFIX="$phi_root" CONDARC= MAMBARC= "$phi_binary" --version 2>/dev/null)',
    'phi_version_status=$?',
    'phi_info=$(env -i HOME="$phi_home" MAMBA_ROOT_PREFIX="$phi_root" CONDARC= MAMBARC= "$phi_binary" --rc-file /dev/null info 2>/dev/null)',
    'phi_info_status=$?',
    'phi_platform=$(printf \x27%s\\n\x27 "$phi_info" | sed -n \x27s/^[[:space:]]*platform[[:space:]]*:[[:space:]]*//p\x27 | head -n 1)',
    'if [ "$phi_version_status" -eq 0 ]; then',
    `  printf '%s%s\\n' '${VERSION_MARKER}' "$(printf %s "$phi_version" | head -n 1)"`,
    'fi',
    'if [ "$phi_info_status" -eq 0 ] && [ -n "$phi_platform" ]; then',
    `  printf '%s%s\\n' '${PLATFORM_MARKER}' "$phi_platform"`,
    'fi',
    '[ "$phi_version_status" -eq 0 ] && [ "$phi_info_status" -eq 0 ]'
  ].join('\n')
}

export function parseVerification(
  stdout: string,
  exitCode: number | null
): ParsedMicromambaVerification {
  const lines = stdout.split(/\r?\n/)
  const version = lines
    .find((line) => line.startsWith(VERSION_MARKER))
    ?.slice(VERSION_MARKER.length)
  const platform = lines
    .find((line) => line.startsWith(PLATFORM_MARKER))
    ?.slice(PLATFORM_MARKER.length)
  return { version: version || null, platform: platform || null, runnable: exitCode === 0 }
}

export function buildStatusScanScript(configuredRoot: string): string {
  return [
    'set +e',
    `phi_configured=${shellQuote(configuredRoot)}`,
    'case "$phi_configured" in',
    '  /*) phi_root=$phi_configured ;;',
    "  '~/'*) phi_root=${HOME:-}/${phi_configured#'~/'} ;;",
    `  *) printf '%s\\n' '${STATUS_MARKER}failed'; exit 0 ;;`,
    'esac',
    'if [ ! -e "$phi_root" ] && [ ! -L "$phi_root" ]; then',
    `  printf '%s\\n' '${STATUS_MARKER}missing'`,
    '  exit 0',
    'fi',
    'if [ ! -d "$phi_root" ]; then',
    `  printf '%s\\n' '${STATUS_MARKER}failed'`,
    '  exit 0',
    'fi',
    'phi_root=$(CDPATH= cd -P "$phi_root" 2>/dev/null && pwd -P)',
    'if [ -z "$phi_root" ]; then',
    `  printf '%s\\n' '${STATUS_MARKER}failed'`,
    '  exit 0',
    'fi',
    `printf '%s\\n' '${STATUS_MARKER}ok'`,
    `printf '%s%s\\n' '${ROOT_MARKER}' "$phi_root"`,
    'if [ -d "$phi_root/bin" ]; then',
    '  for phi_file in "$phi_root"/bin/micromamba-*; do',
    '    [ -f "$phi_file" ] || continue',
    '    phi_release=${phi_file##*/micromamba-}',
    `    printf '%s%s\\n' '${RELEASE_MARKER}' "$phi_release"`,
    '  done',
    'fi'
  ].join('\n')
}

export function parseStatusScan(stdout: string): ParsedMicromambaStatusScan {
  const lines = stdout.split(/\r?\n/)
  const stateValue = lines
    .find((line) => line.startsWith(STATUS_MARKER))
    ?.slice(STATUS_MARKER.length)
  const state = stateValue === 'ok' || stateValue === 'missing' ? stateValue : 'failed'
  const root = lines.find((line) => line.startsWith(ROOT_MARKER))?.slice(ROOT_MARKER.length)
  const versions = lines
    .filter((line) => line.startsWith(RELEASE_MARKER))
    .map((line) => line.slice(RELEASE_MARKER.length))
    .filter((version) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version))
  return { state, root, versions: [...new Set(versions)].sort() }
}
