import { posix } from 'node:path'

import type { RemoteHashTool } from '../transfer/ssh-data-plane-scripts'
import { shellQuote } from '../wrappers/remote-ssh-session'
import type { RemoteProjectDownloadContext } from './remote-project-download-data-plane-state'

const CONTROL_BYTES = 160 * 1024

export type Paths = Readonly<{
  destination: string
  parent: string
  partial: string
  manifest: string
  auxiliary: readonly string[]
}>

export function pathsForValues(destination: string, transferId: string): Paths {
  const parent = posix.dirname(destination)
  const name = posix.basename(destination)
  const partial = posix.join(parent, `.${name}.phi-transfer-${transferId}.part`)
  const manifest = `${partial}.json`
  const head = posix.join(parent, `.${name}.phi-http-head-${transferId}.tmp`)
  const copy = posix.join(parent, `.${name}.phi-http-copy-${transferId}`)
  const hash = posix.join(parent, `.${name}.phi-http-hash-${transferId}`)
  return {
    destination,
    parent,
    partial,
    manifest,
    auxiliary: [
      `${manifest}.${transferId}.tmp`,
      `${manifest}.${transferId}.checkpoint`,
      `${partial}.${transferId}.truncate`,
      head,
      `${copy}.headers`,
      `${copy}.code`,
      `${copy}.stderr`,
      `${hash}.fifo`,
      `${hash}.digest`,
      `${hash}.code`,
      `${hash}.stderr`
    ]
  }
}

export function pathsFor(context: RemoteProjectDownloadContext): Paths {
  return pathsForValues(context.destination, context.transferId)
}

function httpArguments(context: RemoteProjectDownloadContext): string {
  return context.curlResolve ? ` --resolve ${shellQuote(context.curlResolve)}` : ''
}

export function headCommand(context: RemoteProjectDownloadContext, paths: Paths): string {
  const headers = posix.join(
    paths.parent,
    `.${posix.basename(paths.destination)}.phi-http-head-${context.transferId}.tmp`
  )
  return [
    'set +e',
    securityPreamble(context, paths),
    'umask 077',
    `phi_headers=${shellQuote(headers)}`,
    '[ ! -L "$phi_headers" ] || fail INVALID_PARTIAL',
    'if [ -e "$phi_headers" ]; then safe_file "$phi_headers" || fail INVALID_PARTIAL; rm -f -- "$phi_headers"; fi',
    '( set -C; : > "$phi_headers" ) 2>/dev/null || exit 84',
    'trap \'rm -f -- "$phi_headers"\' EXIT HUP INT TERM',
    "command -v curl >/dev/null 2>&1 || { printf 'PHI_ERROR=CURL_UNAVAILABLE\\n'; exit 81; }",
    `phi_code=$(curl -q --head --silent --show-error --noproxy '*' --proto '=https' --max-redirs 0 --connect-timeout 20 --max-time 120${httpArguments(context)} --dump-header "$phi_headers" --output /dev/null --write-out '%{http_code}' ${shellQuote(context.url)})`,
    'phi_status=$?',
    "case \"$phi_status\" in 0) ;; 6|7|28) printf 'PHI_ERROR=NETWORK\\n'; exit 83 ;; *) printf 'PHI_ERROR=HTTP\\n'; exit 84 ;; esac",
    'phi_header_size=$(wc -c < "$phi_headers" | tr -d \' \')',
    '[ "$phi_header_size" -le 65536 ] || { printf \'PHI_ERROR=HTTP_HEADERS\\n\'; exit 84; }',
    'header_hex() {',
    '  phi_name=$1',
    `  awk -v wanted="$phi_name" 'BEGIN { count=0 } { line=$0; sub(/\\r$/, "", line); colon=index(line, ":"); if (colon > 0 && tolower(substr(line, 1, colon - 1)) == tolower(wanted)) { value=substr(line, colon + 1); sub(/^[ \\t]*/, "", value); count += 1; found=value } } END { if (count == 1) printf "%s", found; else if (count > 1) exit 2 }' "$phi_headers" | od -An -tx1 -v | tr -d ' \\n'`,
    '}',
    `phi_size=$(awk '{ line=$0; sub(/\\r$/, "", line); colon=index(line, ":"); if (colon > 0 && tolower(substr(line, 1, colon - 1)) == "content-length") { value=substr(line, colon + 1); sub(/^[ \\t]*/, "", value); count += 1; found=value } } END { if (count == 1 && found ~ /^[0-9]+$/) print found; else exit 2 }' "$phi_headers") || { printf 'PHI_ERROR=HTTP_HEADERS\\n'; exit 84; }`,
    'printf \'PHI_HTTP_CODE=%s\\nPHI_HTTP_SIZE=%s\\n\' "$phi_code" "$phi_size"',
    "printf 'PHI_HTTP_ETAG_HEX='; header_hex etag || exit 84; printf '\\n'",
    "printf 'PHI_HTTP_LAST_MODIFIED_HEX='; header_hex last-modified || exit 84; printf '\\n'",
    "printf 'PHI_HTTP_SHA256_HEX='; header_hex x-checksum-sha256 || exit 84; printf '\\n'",
    "printf 'PHI_HTTP_DIGEST_HEX='; header_hex content-digest || exit 84; printf '\\n'"
  ].join('\n')
}

export function hashFileScript(tool: RemoteHashTool, path: string): string {
  const quoted = shellQuote(path)
  switch (tool) {
    case 'sha256sum':
      return `sha256sum ${quoted} | cut -d ' ' -f 1`
    case 'shasum':
      return `shasum -a 256 ${quoted} | cut -d ' ' -f 1`
    case 'openssl':
      return `openssl dgst -sha256 -r ${quoted} | cut -d ' ' -f 1`
    case 'perl':
      return `perl -MDigest::SHA -e 'my $s=Digest::SHA->new(256); $s->addfile($ARGV[0], "b"); print $s->hexdigest' ${quoted}`
  }
}

export function securityPreamble(
  context: Pick<RemoteProjectDownloadContext, 'canonicalRoot'>,
  paths: Paths
): string {
  return [
    'fail() { printf \'PHI_ERROR=%s\\n\' "$1"; exit 49; }',
    'file_meta() { stat -Lc \'%u:%a:%h\' "$1" 2>/dev/null || stat -f \'%u:%Lp:%l\' "$1" 2>/dev/null; }',
    'file_identity() { stat -Lc \'%d:%i:%s:%Y:%u:%a\' "$1" 2>/dev/null || stat -f \'%d:%i:%z:%m:%u:%Lp\' "$1" 2>/dev/null; }',
    'safe_file() {',
    '  [ ! -L "$1" ] && [ -f "$1" ] || return 1',
    '  [ "$(file_meta "$1")" = "$(id -u):600:1" ] || return 1',
    '}',
    'safe_node() {',
    '  if [ -p "$1" ]; then [ ! -L "$1" ] && [ "$(file_meta "$1")" = "$(id -u):600:1" ]; else safe_file "$1"; fi',
    '}',
    `phi_parent=${shellQuote(paths.parent)}`,
    'actual_parent=$(CDPATH= cd -P -- "$phi_parent" 2>/dev/null && pwd -P) || fail INVALID_PATH',
    '[ "$actual_parent" = "$phi_parent" ] || fail INVALID_PATH',
    `case "$actual_parent" in ${shellQuote(context.canonicalRoot)}|${shellQuote(`${context.canonicalRoot}/`)}*) ;; *) fail INVALID_PATH ;; esac`
  ].join('\n')
}

function hashStdinScript(tool: RemoteHashTool): string {
  switch (tool) {
    case 'sha256sum':
      return "sha256sum | cut -d ' ' -f 1"
    case 'shasum':
      return "shasum -a 256 | cut -d ' ' -f 1"
    case 'openssl':
      return "openssl dgst -sha256 -r | cut -d ' ' -f 1"
    case 'perl':
      return "perl -MDigest::SHA -e 'my $s=Digest::SHA->new(256); $s->addfile(*STDIN); print $s->hexdigest'"
  }
}

export function copyCommand(
  context: RemoteProjectDownloadContext,
  paths: Paths,
  offset: number,
  expectedSize: number,
  ifRange: string,
  hashTool: RemoteHashTool
): string {
  const ifRangeArgument = ifRange ? ` --header ${shellQuote(`If-Range: ${ifRange}`)}` : ''
  const prefix = posix.join(
    paths.parent,
    `.${posix.basename(paths.destination)}.phi-http-copy-${context.transferId}`
  )
  return [
    'set +e',
    securityPreamble(context, paths),
    `phi_part=${shellQuote(paths.partial)}`,
    `phi_dest=${shellQuote(paths.destination)}`,
    `phi_url=${shellQuote(context.url)}`,
    `phi_headers=${shellQuote(`${prefix}.headers`)}`,
    `phi_code_file=${shellQuote(`${prefix}.code`)}`,
    `phi_error_file=${shellQuote(`${prefix}.stderr`)}`,
    '[ ! -e "$phi_dest" ] && [ ! -L "$phi_dest" ] || fail DESTINATION_EXISTS',
    'safe_file "$phi_part" || fail INVALID_PARTIAL',
    'for phi_aux in "$phi_headers" "$phi_code_file" "$phi_error_file"; do [ ! -L "$phi_aux" ] || fail INVALID_PARTIAL; if [ -e "$phi_aux" ]; then safe_file "$phi_aux" || fail INVALID_PARTIAL; rm -f -- "$phi_aux"; fi; done',
    `test "$(wc -c < "$phi_part" | tr -d ' ')" -eq ${offset} || fail OFFSET_MISMATCH`,
    'umask 077',
    '( set -C; : > "$phi_headers" ) 2>/dev/null || fail INVALID_PARTIAL',
    '( set -C; : > "$phi_code_file" ) 2>/dev/null || fail INVALID_PARTIAL',
    '( set -C; : > "$phi_error_file" ) 2>/dev/null || fail INVALID_PARTIAL',
    'phi_worker=',
    `phi_last=${offset}`,
    'phi_last_at=$(date +%s)',
    'cleanup_copy() { rm -f -- "$phi_headers" "$phi_code_file" "$phi_error_file"; }',
    'emit_progress() {',
    '  phi_force=$1',
    '  phi_current=$(wc -c < "$phi_part" | tr -d \' \') || return 1',
    `  [ "$phi_current" -le ${expectedSize} ] || return 1`,
    '  phi_now=$(date +%s)',
    '  phi_delta=$((phi_current - phi_last))',
    '  if [ "$phi_current" -gt "$phi_last" ] && { [ "$phi_force" -eq 1 ] || [ "$phi_delta" -ge 67108864 ] || [ $((phi_now - phi_last_at)) -ge 5 ]; }; then',
    '    sync "$phi_part" 2>/dev/null || sync',
    `    phi_chunk_hash=$(tail -c +$((phi_last + 1)) "$phi_part" | head -c "$phi_delta" | ${hashStdinScript(hashTool)}) || return 1`,
    '    printf \'PHI_PROGRESS_V1\\t%s\\t%s\\t%s\\t%s\\n\' "$phi_current" "$phi_last" "$phi_delta" "$phi_chunk_hash"',
    '    phi_last=$phi_current',
    '    phi_last_at=$phi_now',
    '  fi',
    '}',
    'stop_copy() {',
    '  trap - HUP INT TERM',
    '  if [ -n "$phi_worker" ]; then',
    '    kill -TERM "$phi_worker" 2>/dev/null || true',
    '    phi_step=0',
    '    while kill -0 "$phi_worker" 2>/dev/null && [ "$phi_step" -lt 20 ]; do sleep 0.1; phi_step=$((phi_step + 1)); done',
    '    kill -KILL "$phi_worker" 2>/dev/null || true',
    '    wait "$phi_worker" 2>/dev/null || true',
    '  fi',
    '  emit_progress 1 || true',
    '  cleanup_copy',
    '  exit 143',
    '}',
    'trap stop_copy HUP INT TERM',
    `curl -q --fail --silent --show-error --noproxy '*' --proto '=https' --max-redirs 0 --connect-timeout 20 --max-time 600 --max-filesize ${context.maxFileBytes} --continue-at -${ifRangeArgument}${httpArguments(context)} --dump-header "$phi_headers" --write-out '%{http_code}' --output "$phi_part" "$phi_url" > "$phi_code_file" 2> "$phi_error_file" &`,
    'phi_worker=$!',
    'while kill -0 "$phi_worker" 2>/dev/null; do sleep 0.25; emit_progress 0 || { kill -TERM "$phi_worker" 2>/dev/null || true; }; done',
    'wait "$phi_worker"',
    'phi_status=$?',
    'phi_worker=',
    'emit_progress 1 || fail INVALID_PARTIAL',
    'trap - HUP INT TERM',
    'phi_code=$(cat "$phi_code_file")',
    'case "$phi_status" in 0) ;; 6|7|28) cleanup_copy; fail NETWORK ;; 33) cleanup_copy; fail SOURCE_CHANGED ;; 63) cleanup_copy; fail TOO_LARGE ;; *) cleanup_copy; fail HTTP ;; esac',
    'phi_header_size=$(wc -c < "$phi_headers" | tr -d \' \')',
    '[ "$phi_header_size" -le 65536 ] || { cleanup_copy; fail HTTP_HEADERS; }',
    `if [ ${offset} -gt 0 ]; then`,
    '  [ "$phi_code" = 206 ] || { cleanup_copy; fail SOURCE_CHANGED; }',
    `  phi_range=$(awk '{ line=$0; sub(/\\r$/, "", line); colon=index(line, ":"); if (colon > 0 && tolower(substr(line, 1, colon - 1)) == "content-range") { value=substr(line, colon + 1); sub(/^[ \\t]*/, "", value); count += 1; found=value } } END { if (count == 1) print found; else exit 2 }' "$phi_headers") || { cleanup_copy; fail SOURCE_CHANGED; }`,
    `  [ "$phi_range" = ${shellQuote(`bytes ${offset}-${expectedSize - 1}/${expectedSize}`)} ] || { cleanup_copy; fail SOURCE_CHANGED; }`,
    'else',
    '  [ "$phi_code" = 200 ] || { cleanup_copy; fail SOURCE_CHANGED; }',
    'fi',
    'phi_size=$(wc -c < "$phi_part" | tr -d \' \') || { cleanup_copy; fail INVALID_PARTIAL; }',
    `test "$phi_size" -eq ${expectedSize} || { cleanup_copy; fail SOURCE_CHANGED; }`,
    `phi_hash=$(${hashFileScript(hashTool, paths.partial)}) || { cleanup_copy; fail HASH_UNAVAILABLE; }`,
    'cleanup_copy',
    'printf \'PHI_REMOTE_DOWNLOAD_V2\\t%s\\t%s\\n\' "$phi_size" "$phi_hash"'
  ].join('\n')
}

export function sourceHashCommand(
  context: RemoteProjectDownloadContext,
  paths: Paths,
  expectedSize: number,
  hashTool: RemoteHashTool
): string {
  const prefix = posix.join(
    paths.parent,
    `.${posix.basename(paths.destination)}.phi-http-hash-${context.transferId}`
  )
  return [
    'set +e',
    securityPreamble(context, paths),
    `phi_fifo=${shellQuote(`${prefix}.fifo`)}`,
    `phi_hash_file=${shellQuote(`${prefix}.digest`)}`,
    `phi_code_file=${shellQuote(`${prefix}.code`)}`,
    `phi_error_file=${shellQuote(`${prefix}.stderr`)}`,
    'umask 077',
    'for phi_aux in "$phi_hash_file" "$phi_code_file" "$phi_error_file"; do [ ! -L "$phi_aux" ] || fail INVALID_PARTIAL; if [ -e "$phi_aux" ]; then safe_file "$phi_aux" || fail INVALID_PARTIAL; rm -f -- "$phi_aux"; fi; done',
    'if [ -e "$phi_fifo" ] || [ -L "$phi_fifo" ]; then [ ! -L "$phi_fifo" ] && [ -p "$phi_fifo" ] && [ "$(file_meta "$phi_fifo")" = "$(id -u):600:1" ] || fail INVALID_PARTIAL; rm -f -- "$phi_fifo"; fi',
    'mkfifo -m 600 "$phi_fifo" || fail INVALID_PARTIAL',
    '( set -C; : > "$phi_hash_file" ) 2>/dev/null || fail INVALID_PARTIAL',
    '( set -C; : > "$phi_code_file" ) 2>/dev/null || fail INVALID_PARTIAL',
    '( set -C; : > "$phi_error_file" ) 2>/dev/null || fail INVALID_PARTIAL',
    'phi_hash_worker=',
    'phi_curl_worker=',
    'cleanup_hash() { rm -f -- "$phi_fifo" "$phi_hash_file" "$phi_code_file" "$phi_error_file"; }',
    'stop_process() {',
    '  phi_pid=$1',
    '  [ -n "$phi_pid" ] || return 0',
    '  kill -TERM "$phi_pid" 2>/dev/null || true',
    '  phi_step=0',
    '  while kill -0 "$phi_pid" 2>/dev/null && [ "$phi_step" -lt 20 ]; do sleep 0.1; phi_step=$((phi_step + 1)); done',
    '  kill -KILL "$phi_pid" 2>/dev/null || true',
    '  wait "$phi_pid" 2>/dev/null || true',
    '}',
    'stop_hash() { trap - HUP INT TERM; stop_process "$phi_curl_worker"; stop_process "$phi_hash_worker"; cleanup_hash; exit 143; }',
    'trap stop_hash HUP INT TERM',
    `(${hashStdinScript(hashTool)}) < "$phi_fifo" > "$phi_hash_file" &`,
    'phi_hash_worker=$!',
    `curl -q --fail --silent --show-error --noproxy '*' --proto '=https' --max-redirs 0 --connect-timeout 20 --max-time 600 --max-filesize ${context.maxFileBytes}${httpArguments(context)} --write-out '%{http_code} %{size_download}' --output "$phi_fifo" ${shellQuote(context.url)} > "$phi_code_file" 2> "$phi_error_file" &`,
    'phi_curl_worker=$!',
    'wait "$phi_curl_worker"',
    'phi_status=$?',
    'phi_curl_worker=',
    'wait "$phi_hash_worker"',
    'phi_hash_status=$?',
    'phi_hash_worker=',
    'trap - HUP INT TERM',
    'case "$phi_status" in 0) ;; 6|7|28) cleanup_hash; fail NETWORK ;; 63) cleanup_hash; fail TOO_LARGE ;; *) cleanup_hash; fail HTTP ;; esac',
    '[ "$phi_hash_status" -eq 0 ] || { cleanup_hash; fail HASH_UNAVAILABLE; }',
    'read phi_code phi_size < "$phi_code_file" || { cleanup_hash; fail HTTP; }',
    'case "$phi_code" in 2??) ;; 3??) cleanup_hash; fail SOURCE_CHANGED ;; *) cleanup_hash; fail HTTP ;; esac',
    `test "$phi_size" -eq ${expectedSize} || { cleanup_hash; fail SOURCE_CHANGED; }`,
    'phi_hash=$(cat "$phi_hash_file")',
    'cleanup_hash',
    'printf \'PHI_HASH=%s\\n\' "$phi_hash"'
  ].join('\n')
}

export async function drainBounded(stream: NodeJS.ReadableStream): Promise<void> {
  let bytes = 0
  for await (const value of stream) {
    bytes += Buffer.byteLength(value)
    if (bytes > CONTROL_BYTES) break
  }
}

export function initializeCommand(
  context: RemoteProjectDownloadContext,
  paths: Paths,
  temporary: string,
  manifestJson: string
): string {
  return [
    'set -eu',
    securityPreamble(context, paths),
    `phi_part=${shellQuote(paths.partial)}`,
    `phi_manifest=${shellQuote(paths.manifest)}`,
    `phi_dest=${shellQuote(paths.destination)}`,
    `temporary=${shellQuote(temporary)}`,
    '[ ! -e "$phi_dest" ] && [ ! -L "$phi_dest" ] || fail DESTINATION_EXISTS',
    '[ ! -L "$temporary" ] || fail INVALID_MANIFEST',
    'if [ -e "$temporary" ]; then safe_file "$temporary" || fail INVALID_MANIFEST; rm -f -- "$temporary"; fi',
    '[ ! -e "$phi_part" ] && [ ! -L "$phi_part" ] || fail INVALID_PARTIAL',
    '[ ! -e "$phi_manifest" ] && [ ! -L "$phi_manifest" ] || fail INVALID_MANIFEST',
    'umask 077',
    '( set -C; : > "$phi_part" ) 2>/dev/null || fail INVALID_PARTIAL',
    'chmod 600 "$phi_part"',
    'safe_file "$phi_part" || { rm -f -- "$phi_part"; fail INVALID_PARTIAL; }',
    `( set -C; printf '%s\\n' ${shellQuote(manifestJson)} > "$temporary" ) 2>/dev/null || { rm -f -- "$phi_part"; fail INVALID_MANIFEST; }`,
    'chmod 600 "$temporary"',
    '[ "$(file_meta "$temporary")" = "$(id -u):600:1" ] || { rm -f -- "$phi_part" "$temporary"; fail INVALID_MANIFEST; }',
    'mv -f "$temporary" "$phi_manifest"',
    'safe_file "$phi_manifest" || fail INVALID_MANIFEST',
    'sync "$phi_part" 2>/dev/null || sync'
  ].join('\n')
}

export function inspectPartialCommand(context: RemoteProjectDownloadContext, paths: Paths): string {
  return [
    'set -eu',
    securityPreamble(context, paths),
    `phi_part=${shellQuote(paths.partial)}`,
    'if [ -L "$phi_part" ]; then fail INVALID_PARTIAL',
    'elif [ -f "$phi_part" ]; then',
    '  safe_file "$phi_part" || fail INVALID_PARTIAL',
    '  phi_size=$(wc -c < "$phi_part" | tr -d \' \') || fail INVALID_PARTIAL',
    '  printf \'PHI_PART=file:%s\\n\' "$phi_size"',
    'elif [ -e "$phi_part" ]; then fail INVALID_PARTIAL',
    "else printf 'PHI_PART=missing:0\\n'",
    'fi'
  ].join('\n')
}

export function truncateCommand(
  context: RemoteProjectDownloadContext,
  paths: Paths,
  temporary: string,
  size: number
): string {
  return [
    'set -eu',
    securityPreamble(context, paths),
    `phi_part=${shellQuote(paths.partial)}`,
    `phi_dest=${shellQuote(paths.destination)}`,
    `temporary=${shellQuote(temporary)}`,
    '[ ! -e "$phi_dest" ] && [ ! -L "$phi_dest" ] || fail DESTINATION_EXISTS',
    'safe_file "$phi_part" || fail INVALID_PARTIAL',
    '[ ! -L "$temporary" ] || fail INVALID_PARTIAL',
    'if [ -e "$temporary" ]; then safe_file "$temporary" || fail INVALID_PARTIAL; rm -f -- "$temporary"; fi',
    'umask 077',
    `( set -C; ${size === 0 ? ':' : `head -c ${size} "$phi_part"`} > "$temporary" ) || fail INVALID_PARTIAL`,
    'chmod 600 "$temporary"',
    '[ "$(file_meta "$temporary")" = "$(id -u):600:1" ] || fail INVALID_PARTIAL',
    'mv -f "$temporary" "$phi_part"'
  ].join('\n')
}

export function removeStateCommand(
  context: Pick<RemoteProjectDownloadContext, 'canonicalRoot'>,
  paths: Paths,
  expectedManifestJson?: string
): string {
  return [
    'set -eu',
    securityPreamble(context, paths),
    `for path in ${[paths.partial, paths.manifest, ...paths.auxiliary].map((path) => shellQuote(path)).join(' ')}; do`,
    '  if [ -L "$path" ]; then fail INVALID_PARTIAL; fi',
    '  if [ -e "$path" ]; then safe_node "$path" || fail INVALID_PARTIAL; fi',
    'done',
    ...(expectedManifestJson === undefined
      ? []
      : [
          `[ "$(cat ${shellQuote(paths.manifest)})" = ${shellQuote(expectedManifestJson)} ] || fail INVALID_MANIFEST`
        ]),
    `rm -f -- ${[paths.partial, paths.manifest, ...paths.auxiliary].map((path) => shellQuote(path)).join(' ')}`
  ].join('\n')
}

export function publishCommand(
  context: RemoteProjectDownloadContext,
  paths: Paths,
  expectedSize: number,
  expectedHash: string,
  hashTool: RemoteHashTool
): string {
  return [
    'set -eu',
    securityPreamble(context, paths),
    `phi_part=${shellQuote(paths.partial)}`,
    `phi_manifest=${shellQuote(paths.manifest)}`,
    `phi_dest=${shellQuote(paths.destination)}`,
    '[ ! -e "$phi_dest" ] && [ ! -L "$phi_dest" ] || fail DESTINATION_EXISTS',
    'safe_file "$phi_part" || fail INVALID_PARTIAL',
    'safe_file "$phi_manifest" || fail INVALID_MANIFEST',
    `test "$(wc -c < "$phi_part" | tr -d ' ')" -eq ${expectedSize} || fail INVALID_PARTIAL`,
    'phi_before=$(file_identity "$phi_part") || fail INVALID_PARTIAL',
    `phi_hash=$(${hashFileScript(hashTool, paths.partial)}) || fail HASH_UNAVAILABLE`,
    `[ "$phi_hash" = ${shellQuote(expectedHash)} ] || fail HASH_MISMATCH`,
    '[ "$(file_identity "$phi_part")" = "$phi_before" ] || fail INVALID_PARTIAL',
    'sync "$phi_part" 2>/dev/null || sync',
    'ln -- "$phi_part" "$phi_dest" 2>/dev/null || { [ ! -e "$phi_dest" ] && [ ! -L "$phi_dest" ] || fail DESTINATION_EXISTS; fail PUBLISH_FAILED; }',
    'phi_published=$(file_identity "$phi_dest") || fail PUBLISH_FAILED',
    'if [ "$phi_published" != "$phi_before" ]; then phi_current=$(file_identity "$phi_part" 2>/dev/null || true); [ "$phi_published" != "$phi_current" ] || rm -f -- "$phi_dest"; fail INVALID_PARTIAL; fi',
    'if [ "$(file_identity "$phi_part" 2>/dev/null || true)" != "$phi_before" ]; then [ "$(file_identity "$phi_dest" 2>/dev/null || true)" != "$phi_before" ] || rm -f -- "$phi_dest"; fail INVALID_PARTIAL; fi',
    'rm -f -- "$phi_part" "$phi_manifest"',
    'sync "$phi_parent" 2>/dev/null || sync',
    'printf \'PHI_HASH=%s\\n\' "$phi_hash"'
  ].join('\n')
}
