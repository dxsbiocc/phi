import { shellQuote } from '../wrappers/remote-ssh-session'
import type { TransferManifest } from './manifest'

export type RemoteHashTool = 'sha256sum' | 'shasum' | 'openssl' | 'perl'

export function shellScriptCommand(script: string): string {
  return `sh -c ${shellQuote(script)}`
}

function hashFunctions(): string {
  return String.raw`
hash_file() {
  case "$hash_tool" in
    sha256sum) sha256sum "$1" | cut -d ' ' -f 1 ;;
    shasum) shasum -a 256 "$1" | cut -d ' ' -f 1 ;;
    openssl) openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1 ;;
    perl) perl -MDigest::SHA -e 'my $s=Digest::SHA->new(256); $s->addfile($ARGV[0], "b"); print $s->hexdigest' "$1" ;;
    *) return 127 ;;
  esac
}
hash_stdin() {
  case "$hash_tool" in
    sha256sum) sha256sum | cut -d ' ' -f 1 ;;
    shasum) shasum -a 256 | cut -d ' ' -f 1 ;;
    openssl) openssl dgst -sha256 -r | cut -d ' ' -f 1 ;;
    perl) perl -MDigest::SHA -e 'my $s=Digest::SHA->new(256); $s->addfile(*STDIN); print $s->hexdigest' ;;
    *) return 127 ;;
  esac
}
file_size() {
  stat -Lc '%s' "$1" 2>/dev/null || stat -f '%z' "$1" 2>/dev/null
}
file_owner() {
  stat -Lc '%u' "$1" 2>/dev/null || stat -f '%u' "$1" 2>/dev/null
}
sync_file() {
  sync "$1" 2>/dev/null || sync
}
`
}

function containmentCheck(parent: string, canonicalRoot: string): string {
  return `actual_parent=$(CDPATH= cd -P ${shellQuote(parent)} 2>/dev/null && pwd -P) || fail INVALID_PATH\ncase "$actual_parent" in ${shellQuote(canonicalRoot)}|${shellQuote(`${canonicalRoot}/`)}*) ;; *) fail INVALID_PATH ;; esac`
}

function exactContainmentCheck(parent: string, canonicalRoot: string): string {
  return `${containmentCheck(parent, canonicalRoot)}\n[ "$actual_parent" = ${shellQuote(parent)} ] || fail INVALID_PATH`
}

function hashToolProbe(): string {
  return `if command -v sha256sum >/dev/null 2>&1; then hash_tool=sha256sum
elif command -v shasum >/dev/null 2>&1; then hash_tool=shasum
elif command -v openssl >/dev/null 2>&1; then hash_tool=openssl
elif command -v perl >/dev/null 2>&1 && perl -MDigest::SHA -e 1 >/dev/null 2>&1; then hash_tool=perl
else fail HASH_UNAVAILABLE
fi`
}

export function buildUploadPreflightScript(paths: {
  destination: string
  partial: string
  manifest: string
  parent: string
  canonicalRoot: string
  probe: string
}): string {
  return `set -eu
fail() { printf 'PHI_ERROR=%s\\n' "$1"; exit 41; }
${containmentCheck(paths.parent, paths.canonicalRoot)}
${hashToolProbe()}
if [ -e ${shellQuote(paths.destination)} ] || [ -L ${shellQuote(paths.destination)} ]; then fail DESTINATION_EXISTS; fi
umask 077
( set -C; : > ${shellQuote(paths.probe)} ) 2>/dev/null || fail WRITE_UNAVAILABLE
rm -f ${shellQuote(paths.probe)}
space=$(df -Pk ${shellQuote(paths.parent)} 2>/dev/null | awk 'NR == 2 { printf "%.0f", $4 * 1024 }')
[ -n "$space" ] || fail SPACE_UNAVAILABLE
printf 'PHI_HASH=%s\\nPHI_SPACE=%s\\n' "$hash_tool" "$space"
if [ -L ${shellQuote(paths.partial)} ]; then fail INVALID_PARTIAL
elif [ -f ${shellQuote(paths.partial)} ]; then
  owner=$(stat -Lc '%u' ${shellQuote(paths.partial)} 2>/dev/null || stat -f '%u' ${shellQuote(paths.partial)} 2>/dev/null) || fail INVALID_PARTIAL
  [ "$owner" = "$(id -u)" ] || fail INVALID_PARTIAL
  size=$(stat -Lc '%s' ${shellQuote(paths.partial)} 2>/dev/null || stat -f '%z' ${shellQuote(paths.partial)} 2>/dev/null) || fail INVALID_PARTIAL
  printf 'PHI_PART=file:%s\\n' "$size"
elif [ -e ${shellQuote(paths.partial)} ]; then fail INVALID_PARTIAL
else printf 'PHI_PART=missing:0\\n'
fi
if [ -L ${shellQuote(paths.manifest)} ]; then fail INVALID_MANIFEST
elif [ -f ${shellQuote(paths.manifest)} ]; then
  owner=$(stat -Lc '%u' ${shellQuote(paths.manifest)} 2>/dev/null || stat -f '%u' ${shellQuote(paths.manifest)} 2>/dev/null) || fail INVALID_MANIFEST
  [ "$owner" = "$(id -u)" ] || fail INVALID_MANIFEST
  size=$(stat -Lc '%s' ${shellQuote(paths.manifest)} 2>/dev/null || stat -f '%z' ${shellQuote(paths.manifest)} 2>/dev/null) || fail INVALID_MANIFEST
  [ "$size" -le 65536 ] || fail INVALID_MANIFEST
  printf 'PHI_MANIFEST_HEX='
  od -An -tx1 -v ${shellQuote(paths.manifest)} | tr -d ' \\n'
  printf '\\n'
elif [ -e ${shellQuote(paths.manifest)} ]; then fail INVALID_MANIFEST
else printf 'PHI_MANIFEST_HEX=\\n'
fi`
}

export function buildReuseUploadDestinationScript(paths: {
  destination: string
  parent: string
  canonicalRoot: string
  expectedHash: string
}): string {
  return `set -eu
fail() { printf 'PHI_ERROR=%s\\n' "$1"; exit 40; }
${containmentCheck(paths.parent, paths.canonicalRoot)}
if [ -L ${shellQuote(paths.destination)} ]; then fail INVALID_DESTINATION
elif [ -f ${shellQuote(paths.destination)} ]; then
  [ "$(stat -Lc '%u' ${shellQuote(paths.destination)} 2>/dev/null || stat -f '%u' ${shellQuote(paths.destination)} 2>/dev/null)" = "$(id -u)" ] || fail INVALID_DESTINATION
elif [ -e ${shellQuote(paths.destination)} ]; then fail INVALID_DESTINATION
else printf 'PHI_REUSE=missing\\n'; exit 0
fi
${hashToolProbe()}
${hashFunctions()}
digest=$(hash_file ${shellQuote(paths.destination)}) || fail HASH_UNAVAILABLE
if [ "$digest" = ${shellQuote(paths.expectedHash)} ]; then
  printf 'PHI_REUSE=valid\\n'
else
  rm -f ${shellQuote(paths.destination)}
  sync ${shellQuote(paths.parent)} 2>/dev/null || sync
  printf 'PHI_REUSE=removed\\n'
fi`
}

export function buildUploadInitializeScript(paths: {
  destination: string
  partial: string
  manifest: string
  manifestTemporary: string
  manifestJson: string
}): string {
  return `set -eu
fail() { printf 'PHI_ERROR=%s\\n' "$1"; exit 42; }
if [ -e ${shellQuote(paths.destination)} ] || [ -L ${shellQuote(paths.destination)} ]; then fail DESTINATION_EXISTS; fi
if [ -e ${shellQuote(paths.partial)} ] || [ -L ${shellQuote(paths.partial)} ]; then fail INVALID_PARTIAL; fi
umask 077
( set -C; : > ${shellQuote(paths.partial)} ) 2>/dev/null || fail INVALID_PARTIAL
chmod 600 ${shellQuote(paths.partial)}
temporary=${shellQuote(paths.manifestTemporary)}.$$
( set -C; printf '%s\\n' ${shellQuote(paths.manifestJson)} > "$temporary" ) 2>/dev/null || { rm -f ${shellQuote(paths.partial)}; fail INVALID_MANIFEST; }
chmod 600 "$temporary"
mv -f "$temporary" ${shellQuote(paths.manifest)}
sync ${shellQuote(paths.partial)} 2>/dev/null || sync
printf 'PHI_OK=1\\n'`
}

export function buildUploadStreamScript(paths: {
  partial: string
  manifestPath: string
  manifestTemporary: string
  truncateTemporary: string
  manifest: TransferManifest
  offset: number
  hashTool: RemoteHashTool
}): string {
  const source = paths.manifest.sourceIdentity
  const prefix = `{"protocolVersion":1,"transferId":${JSON.stringify(paths.manifest.transferId)},"direction":"upload","sourceIdentity":{"kind":${JSON.stringify(source.kind)},"device":${JSON.stringify(source.device)},"inode":${JSON.stringify(source.inode)},"size":${source.size},"mtime":${JSON.stringify(source.mtime)}},"expectedSize":${paths.manifest.expectedSize}${paths.manifest.expectedSha256 ? `,"expectedSha256":${JSON.stringify(paths.manifest.expectedSha256)}` : ''},"durableOffset":`
  const middle = `,"chunkSize":${paths.manifest.chunkSize},"lastChunk":`
  const suffix = `,"createdAt":${paths.manifest.createdAt},"updatedAt":`
  return `set -eu
hash_tool=${shellQuote(paths.hashTool)}
${hashFunctions()}
fail() { printf 'PHI_ERROR=%s\\n' "$1"; exit 43; }
[ ! -L ${shellQuote(paths.partial)} ] && [ -f ${shellQuote(paths.partial)} ] || fail INVALID_PARTIAL
[ "$(file_owner ${shellQuote(paths.partial)})" = "$(id -u)" ] || fail INVALID_PARTIAL
current_size=$(file_size ${shellQuote(paths.partial)}) || fail INVALID_PARTIAL
[ "$current_size" -ge ${shellQuote(String(paths.offset))} ] || fail OFFSET_MISMATCH
if [ "$current_size" -ne ${shellQuote(String(paths.offset))} ]; then
  umask 077
  truncate_temporary=${shellQuote(paths.truncateTemporary)}.$$
  ( set -C; head -c ${shellQuote(String(paths.offset))} ${shellQuote(paths.partial)} > "$truncate_temporary" ) 2>/dev/null || fail INVALID_PARTIAL
  chmod 600 "$truncate_temporary"
  mv -f "$truncate_temporary" ${shellQuote(paths.partial)}
fi
write_manifest() {
  durable=$(file_size ${shellQuote(paths.partial)}) || return 1
  [ "$durable" -le ${shellQuote(String(paths.manifest.expectedSize))} ] || return 1
  if [ "$durable" -eq 0 ]; then
    last_chunk=null
  else
    if [ "$durable" -lt ${shellQuote(String(paths.manifest.chunkSize))} ]; then last_size=$durable; else last_size=${shellQuote(String(paths.manifest.chunkSize))}; fi
    last_offset=$((durable - last_size))
    last_hash=$(tail -c "$last_size" ${shellQuote(paths.partial)} | hash_stdin) || return 1
    last_chunk=$(printf '{"offset":%s,"size":%s,"sha256":"%s"}' "$last_offset" "$last_size" "$last_hash")
  fi
  updated=$(date +%s)
  updated=$((updated * 1000))
  temporary=${shellQuote(paths.manifestTemporary)}.$$
  umask 077
  ( set -C; printf '%s%s%s%s%s%s}\\n' ${shellQuote(prefix)} "$durable" ${shellQuote(middle)} "$last_chunk" ${shellQuote(suffix)} "$updated" > "$temporary" ) 2>/dev/null || return 1
  chmod 600 "$temporary"
  mv -f "$temporary" ${shellQuote(paths.manifestPath)}
}
worker=
stop_worker() {
  # A disconnect can deliver several signals; a second one must not cut the cleanup short.
  trap '' TERM HUP INT
  if [ -n "$worker" ]; then
    kill -TERM "$worker" 2>/dev/null || true
    step=0
    while kill -0 "$worker" 2>/dev/null && [ "$step" -lt 20 ]; do sleep 0.1; step=$((step + 1)); done
    kill -KILL "$worker" 2>/dev/null || true
    wait "$worker" 2>/dev/null || true
  fi
  sync_file ${shellQuote(paths.partial)}
  write_manifest || true
  exit 143
}
trap stop_worker TERM HUP INT
# A background job's stdin is /dev/null in a non-interactive POSIX sh (dash on Debian and
# Ubuntu), even with <&0, so the stream is handed over on its own descriptor.
exec 3<&0
cat <&3 >> ${shellQuote(paths.partial)} &
worker=$!
exec 3<&-
wait "$worker" || fail STREAM_FAILED
worker=
# A cancel that lands now still records the durable offset first, then stops.
cancelled=0
trap 'cancelled=1' TERM HUP INT
sync_file ${shellQuote(paths.partial)}
write_manifest || fail INVALID_MANIFEST
trap - TERM HUP INT
[ "$cancelled" = 0 ] || exit 143
size=$(file_size ${shellQuote(paths.partial)}) || fail INVALID_PARTIAL
digest=$(hash_file ${shellQuote(paths.partial)}) || fail HASH_UNAVAILABLE
printf 'PHI_SIZE=%s\\nPHI_HASH=%s\\n' "$size" "$digest"`
}

export function buildUploadRangeHashScript(paths: {
  partial: string
  offset: number
  size: number
  hashTool: RemoteHashTool
}): string {
  return `set -eu
hash_tool=${shellQuote(paths.hashTool)}
${hashFunctions()}
fail() { printf 'PHI_ERROR=%s\\n' "$1"; exit 48; }
[ ! -L ${shellQuote(paths.partial)} ] && [ -f ${shellQuote(paths.partial)} ] || fail INVALID_PARTIAL
[ "$(file_owner ${shellQuote(paths.partial)})" = "$(id -u)" ] || fail INVALID_PARTIAL
actual=$(file_size ${shellQuote(paths.partial)}) || fail INVALID_PARTIAL
[ "$actual" -ge ${shellQuote(String(paths.offset + paths.size))} ] || fail INVALID_PARTIAL
digest=$(tail -c +${shellQuote(String(paths.offset + 1))} ${shellQuote(paths.partial)} | head -c ${shellQuote(String(paths.size))} | hash_stdin) || fail HASH_UNAVAILABLE
printf 'PHI_HASH=%s\\n' "$digest"`
}

export function buildUploadPublishScript(paths: {
  destination: string
  partial: string
  manifest: string
  expectedSize: number
  expectedHash: string
  hashTool: RemoteHashTool
  parent: string
  canonicalRoot: string
}): string {
  return `set -eu
hash_tool=${shellQuote(paths.hashTool)}
${hashFunctions()}
fail() { printf 'PHI_ERROR=%s\\n' "$1"; exit 44; }
${containmentCheck(paths.parent, paths.canonicalRoot)}
if [ -e ${shellQuote(paths.destination)} ] || [ -L ${shellQuote(paths.destination)} ]; then fail DESTINATION_EXISTS; fi
[ ! -L ${shellQuote(paths.partial)} ] && [ -f ${shellQuote(paths.partial)} ] || fail INVALID_PARTIAL
[ "$(file_owner ${shellQuote(paths.partial)})" = "$(id -u)" ] || fail INVALID_PARTIAL
[ "$(file_size ${shellQuote(paths.partial)})" = ${shellQuote(String(paths.expectedSize))} ] || fail INVALID_PARTIAL
digest=$(hash_file ${shellQuote(paths.partial)}) || fail HASH_UNAVAILABLE
[ "$digest" = ${shellQuote(paths.expectedHash)} ] || fail HASH_MISMATCH
sync_file ${shellQuote(paths.partial)}
ln ${shellQuote(paths.partial)} ${shellQuote(paths.destination)} 2>/dev/null || {
  if [ -e ${shellQuote(paths.destination)} ] || [ -L ${shellQuote(paths.destination)} ]; then fail DESTINATION_EXISTS; fi
  fail PUBLISH_FAILED
}
rm -f ${shellQuote(paths.partial)} ${shellQuote(paths.manifest)}
sync ${shellQuote(paths.parent)} 2>/dev/null || sync
printf 'PHI_HASH=%s\\n' "$digest"`
}

export function buildRemoveUploadStateScript(partial: string, manifest: string): string {
  return `set -eu
for path in ${shellQuote(partial)} ${shellQuote(manifest)}; do
  if [ -L "$path" ]; then exit 45; fi
  if [ -e "$path" ]; then [ -f "$path" ] || exit 45; [ "$(stat -Lc '%u' "$path" 2>/dev/null || stat -f '%u' "$path" 2>/dev/null)" = "$(id -u)" ] || exit 45; rm -f "$path"; fi
done`
}

export function buildDownloadPreflightScript(paths: {
  source: string
  parent: string
  canonicalRoot: string
}): string {
  return `set -eu
fail() { printf 'PHI_ERROR=%s\\n' "$1"; exit 46; }
${exactContainmentCheck(paths.parent, paths.canonicalRoot)}
${hashToolProbe()}
[ ! -L ${shellQuote(paths.source)} ] && [ -f ${shellQuote(paths.source)} ] || fail SOURCE_CHANGED
identity=$(stat -Lc '%d|%i|%s|%y' ${shellQuote(paths.source)} 2>/dev/null || stat -f '%d|%i|%z|%m' ${shellQuote(paths.source)} 2>/dev/null) || fail SOURCE_CHANGED
printf 'PHI_HASH=%s\\nPHI_ID=%s\\n' "$hash_tool" "$identity"`
}

export function buildDownloadStreamScript(paths: {
  source: string
  sourceParent: string
  canonicalRoot: string
  offset: number
  hashTool: RemoteHashTool
}): string {
  return `set -eu
hash_tool=${shellQuote(paths.hashTool)}
${hashFunctions()}
fail() { printf 'PHI_ERROR=%s\\n' "$1" >&2; exit 47; }
identity() { stat -Lc '%d|%i|%s|%y' "$1" 2>/dev/null || stat -f '%d|%i|%z|%m' "$1" 2>/dev/null; }
[ ! -L ${shellQuote(paths.source)} ] && [ -f ${shellQuote(paths.source)} ] || fail SOURCE_CHANGED
${exactContainmentCheck(paths.sourceParent, paths.canonicalRoot)}
before=$(identity ${shellQuote(paths.source)}) || fail SOURCE_CHANGED
digest=$(hash_file ${shellQuote(paths.source)}) || fail HASH_UNAVAILABLE
printf 'PHI_HASH=%s\\nPHI_BEFORE=%s\\n' "$digest" "$before" >&2
worker=
stop_worker() {
  # A disconnect can deliver several signals; a second one must not cut the cleanup short.
  trap '' TERM HUP INT
  if [ -n "$worker" ]; then
    kill -TERM "$worker" 2>/dev/null || true
    step=0
    while kill -0 "$worker" 2>/dev/null && [ "$step" -lt 20 ]; do sleep 0.1; step=$((step + 1)); done
    kill -KILL "$worker" 2>/dev/null || true
    wait "$worker" 2>/dev/null || true
  fi
  exit 143
}
trap stop_worker TERM HUP INT
if [ ${shellQuote(String(paths.offset))} -eq 0 ]; then
  cat ${shellQuote(paths.source)} &
else
  tail -c +${shellQuote(String(paths.offset + 1))} ${shellQuote(paths.source)} &
fi
worker=$!
wait "$worker" || fail STREAM_FAILED
worker=
trap - TERM HUP INT
after=$(identity ${shellQuote(paths.source)}) || fail SOURCE_CHANGED
[ "$after" = "$before" ] || fail SOURCE_CHANGED
printf 'PHI_AFTER=%s\\n' "$after" >&2`
}

export function buildDownloadHashScript(paths: {
  source: string
  hashTool: RemoteHashTool
  sourceParent: string
  canonicalRoot: string
}): string {
  return `set -eu
hash_tool=${shellQuote(paths.hashTool)}
${hashFunctions()}
fail() { printf 'PHI_ERROR=%s\\n' "$1"; exit 49; }
identity() { stat -Lc '%d|%i|%s|%y' "$1" 2>/dev/null || stat -f '%d|%i|%z|%m' "$1" 2>/dev/null; }
[ ! -L ${shellQuote(paths.source)} ] && [ -f ${shellQuote(paths.source)} ] || fail SOURCE_CHANGED
${exactContainmentCheck(paths.sourceParent, paths.canonicalRoot)}
before=$(identity ${shellQuote(paths.source)}) || fail SOURCE_CHANGED
digest=$(hash_file ${shellQuote(paths.source)}) || fail HASH_UNAVAILABLE
after=$(identity ${shellQuote(paths.source)}) || fail SOURCE_CHANGED
[ "$after" = "$before" ] || fail SOURCE_CHANGED
printf 'PHI_HASH=%s\\nPHI_BEFORE=%s\\nPHI_AFTER=%s\\n' "$digest" "$before" "$after"`
}
