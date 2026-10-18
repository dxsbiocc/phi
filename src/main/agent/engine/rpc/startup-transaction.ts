import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import type {
  RemoteExecResult,
  RemoteSshSession,
  RemoteStdioProcess
} from '../../wrappers/remote-ssh-session'
import { shellQuote as q } from '../../wrappers/remote-ssh-session'
import { CodedError } from '../../../../shared/errorCodes'
import { RUN_GUARD_SCRIPT, RUN_HELD_MESSAGE } from './run-guard'
import type { RemoteJournalPreflight } from './session-storage/types'

const STARTUP_PROTOCOL = 'PHI_RPC_STARTUP_V1'
const RESULT_PROTOCOL = 'PHI_RPC_STARTUP_RESULT_V1'
const MAX_MARKER_BYTES = 4 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024
/** 30s lock wait + 10s TERM wait + 5s KILL wait + margin. */
const STARTUP_LOCK_CHANNEL_TIMEOUT_MS = 50_000
const itemPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export interface RpcStartupMarkerCheck {
  readonly item: string
  readonly managedRoot: string
  readonly directory: string
  readonly path: string
  readonly bytes: Buffer
}

export interface RpcStartupDirectory {
  readonly path: string
  readonly ifAbsent?: boolean
}

export interface RpcStartupFile {
  readonly item: string
  readonly path: string
  readonly bytes: Buffer
  readonly mode: 0o600
  readonly ifAbsent?: boolean
}

export interface RpcStartupLock {
  readonly path: string
  readonly waitMs?: number
  /**
   * Absolute OMP executable of this deployment. When set, a busy sibling
   * `run.lock` (a previous OMP that outlived its SSH connection) is verified
   * and stopped inside this same remote command before the lock is handed over.
   */
  readonly runExecutable?: string
}

export interface RpcStartupResumeCheck {
  readonly manifestPath: string
  readonly manifestSha256: string
  readonly manifestBytes: number
  readonly journalPath: string
  readonly ompSessionId: string
}

export interface RpcStartupTransaction {
  readonly runtimeRoot: string
  readonly projectRoot: string
  readonly projectPluginGuardHelper?: string
  readonly lock?: RpcStartupLock
  readonly resume?: RpcStartupResumeCheck
  readonly markers: readonly RpcStartupMarkerCheck[]
  readonly directories: readonly RpcStartupDirectory[]
  readonly files: readonly RpcStartupFile[]
}

export interface RpcStartupTransactionResult {
  readonly status: 'ready' | 'repair'
  /** A previous run of this session was still alive and has been stopped. */
  readonly takeover?: { readonly stoppedPid: number }
  readonly checks: readonly {
    readonly item: 'project_plugin_guard'
    readonly status: 'ready' | 'skipped'
  }[]
  readonly resume?: {
    readonly manifest: {
      readonly path: string
      readonly size: number
      readonly sha256: string
    }
    readonly journal: RemoteJournalPreflight
  }
  readonly markers: readonly {
    readonly item: string
    readonly status: 'ready' | 'repair'
    readonly reason?: string
  }[]
}

export interface RpcStartupHeldLock {
  readonly lost: Promise<never>
  release(): Promise<void>
}

export interface RpcStartupTransactionExecution {
  readonly result: RpcStartupTransactionResult
  readonly lock?: RpcStartupHeldLock
}

export interface RpcStartupTransactionWriter {
  addDirectory(directory: RpcStartupDirectory): void
  addFile(file: RpcStartupFile): void
}

export class RpcStartupTransactionBuilder implements RpcStartupTransactionWriter {
  private readonly directories: RpcStartupDirectory[] = []
  private readonly files: RpcStartupFile[] = []

  constructor(
    private readonly identity: Pick<
      RpcStartupTransaction,
      'runtimeRoot' | 'projectRoot' | 'projectPluginGuardHelper' | 'lock' | 'resume' | 'markers'
    >
  ) {}

  addDirectory(directory: RpcStartupDirectory): void {
    const index = this.directories.findIndex((candidate) => candidate.path === directory.path)
    if (index >= 0) {
      this.directories[index] = Object.freeze({
        path: directory.path,
        ...(this.directories[index]!.ifAbsent || directory.ifAbsent ? { ifAbsent: true } : {})
      })
      return
    }
    this.directories.push(Object.freeze({ ...directory }))
  }

  addFile(file: RpcStartupFile): void {
    if (
      this.files.some((candidate) => candidate.path === file.path || candidate.item === file.item)
    )
      throw new Error('Duplicate RPC startup file')
    this.files.push(Object.freeze({ ...file, bytes: Buffer.from(file.bytes) }))
  }

  build(): RpcStartupTransaction {
    return Object.freeze({
      ...this.identity,
      markers: Object.freeze(
        this.identity.markers.map((marker) =>
          Object.freeze({ ...marker, bytes: Buffer.from(marker.bytes) })
        )
      ),
      directories: Object.freeze([...this.directories]),
      files: Object.freeze([...this.files])
    })
  }
}

function canonicalAbsolute(path: string, label: string): void {
  if (
    !posix.isAbsolute(path) ||
    path === '/' ||
    posix.normalize(path) !== path ||
    /[\0\r\n\t]/u.test(path)
  )
    throw new Error(`Invalid ${label}`)
}

function inside(root: string, path: string): boolean {
  const relative = posix.relative(root, path)
  return relative !== '' && relative !== '..' && !relative.startsWith('../')
}

function encoded(value: string | Buffer): string {
  return Buffer.from(value).toString('base64')
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function serialize(transaction: RpcStartupTransaction): string {
  canonicalAbsolute(transaction.runtimeRoot, 'RPC startup runtime root')
  canonicalAbsolute(transaction.projectRoot, 'RPC startup project root')
  if (transaction.projectPluginGuardHelper)
    canonicalAbsolute(transaction.projectPluginGuardHelper, 'RPC startup project plugin guard')
  if (transaction.lock) {
    canonicalAbsolute(transaction.lock.path, 'RPC startup lock')
    const waitMs = transaction.lock.waitMs ?? 30_000
    if (transaction.lock.runExecutable !== undefined)
      canonicalAbsolute(transaction.lock.runExecutable, 'RPC startup run executable')
    if (
      !inside(transaction.runtimeRoot, transaction.lock.path) ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 30_000
    )
      throw new Error('Invalid RPC startup lock')
  }
  if (transaction.resume) {
    canonicalAbsolute(transaction.resume.manifestPath, 'RPC startup resume manifest')
    canonicalAbsolute(transaction.resume.journalPath, 'RPC startup resume journal')
    if (
      !inside(transaction.runtimeRoot, transaction.resume.manifestPath) ||
      !inside(transaction.runtimeRoot, transaction.resume.journalPath) ||
      !/^[a-f0-9]{64}$/.test(transaction.resume.manifestSha256) ||
      !Number.isSafeInteger(transaction.resume.manifestBytes) ||
      transaction.resume.manifestBytes < 1 ||
      transaction.resume.manifestBytes > 16 * 1024 ||
      !itemPattern.test(transaction.resume.ompSessionId)
    )
      throw new Error('Invalid RPC startup resume expectation')
  }
  const markerItems = new Set<string>()
  const paths = new Set<string>()
  const lines = [
    [
      STARTUP_PROTOCOL,
      encoded(transaction.runtimeRoot),
      encoded(transaction.projectRoot),
      transaction.projectPluginGuardHelper ? encoded(transaction.projectPluginGuardHelper) : '-',
      transaction.lock ? encoded(transaction.lock.path) : '-',
      String(transaction.lock?.waitMs ?? 30_000),
      transaction.lock?.runExecutable ? encoded(transaction.lock.runExecutable) : '-'
    ].join('\t')
  ]
  for (const marker of transaction.markers) {
    if (!itemPattern.test(marker.item) || markerItems.has(marker.item))
      throw new Error('Invalid or duplicate RPC startup marker item')
    markerItems.add(marker.item)
    canonicalAbsolute(marker.managedRoot, 'RPC startup marker root')
    canonicalAbsolute(marker.directory, 'RPC startup marker directory')
    canonicalAbsolute(marker.path, 'RPC startup marker path')
    if (
      marker.bytes.length === 0 ||
      marker.bytes.length > MAX_MARKER_BYTES ||
      (marker.directory !== marker.managedRoot && !inside(marker.managedRoot, marker.directory)) ||
      posix.dirname(marker.path) !== marker.directory
    )
      throw new Error('Invalid RPC startup marker expectation')
    lines.push(
      [
        'M',
        marker.item,
        encoded(marker.managedRoot),
        encoded(marker.directory),
        encoded(marker.path),
        digest(marker.bytes)
      ].join('\t')
    )
  }
  if (
    transaction.projectPluginGuardHelper &&
    !transaction.markers.some(
      (marker) =>
        marker.item === 'helper' &&
        posix.dirname(transaction.projectPluginGuardHelper!) === marker.directory
    )
  )
    throw new Error('RPC startup project plugin guard is not marker-backed')
  lines.push('MARKERS_END')
  if (transaction.resume) {
    lines.push(
      [
        'R',
        encoded(transaction.resume.manifestPath),
        transaction.resume.manifestSha256,
        String(transaction.resume.manifestBytes),
        encoded(transaction.resume.journalPath),
        encoded(transaction.resume.ompSessionId)
      ].join('\t')
    )
  } else lines.push('R_NONE')
  lines.push('RESUME_END')
  for (const directory of transaction.directories) {
    canonicalAbsolute(directory.path, 'RPC startup directory')
    if (!inside(transaction.runtimeRoot, directory.path) || paths.has(directory.path))
      throw new Error('Invalid or duplicate RPC startup directory')
    paths.add(directory.path)
    lines.push(['D', encoded(directory.path), directory.ifAbsent ? '1' : '0'].join('\t'))
  }
  lines.push('DIRECTORIES_END')
  let totalBytes = 0
  for (const file of transaction.files) {
    if (!itemPattern.test(file.item)) throw new Error('Invalid RPC startup file item')
    canonicalAbsolute(file.path, 'RPC startup file')
    totalBytes += file.bytes.length
    if (
      !inside(transaction.runtimeRoot, file.path) ||
      paths.has(file.path) ||
      file.mode !== 0o600 ||
      file.bytes.length > MAX_FILE_BYTES ||
      totalBytes > MAX_TOTAL_FILE_BYTES
    )
      throw new Error('Invalid RPC startup file')
    paths.add(file.path)
    lines.push(
      [
        'F',
        file.item,
        encoded(file.path),
        file.mode.toString(8),
        file.ifAbsent ? '1' : '0',
        digest(file.bytes),
        encoded(file.bytes)
      ].join('\t')
    )
  }
  lines.push('END')
  return `${lines.join('\n')}\n`
}

const STARTUP_SCRIPT = String.raw`set -eu
set -f
tab=$(printf '\t')
decode() { printf '%s' "$1" | base64 -d; }
decode_optional() { if [ "$1" != - ]; then decode "$1"; fi; }
fail() { printf 'PHI_STARTUP:%s\n' "$1" >&2; exit 1; }
owner_of() { stat -c %u -- "$1" 2>/dev/null || stat -f %u "$1"; }
mode_of() { stat -c %a -- "$1" 2>/dev/null || stat -f %Lp "$1"; }
links_of() { stat -c %h -- "$1" 2>/dev/null || stat -f %l "$1"; }
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d ' ' -f1;
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -d ' ' -f1;
  else fail HASH_TOOL_MISSING; fi
}
owned_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  [ "$(owner_of "$1")" = "$(id -u)" ] || return 1
  [ "$(mode_of "$1")" = 700 ] || return 1
  [ "$(cd -- "$1" && pwd -P)" = "$1" ] || return 1
}
managed_root() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  [ "$(owner_of "$1")" = "$(id -u)" ] || return 1
  root_mode=$(mode_of "$1") || return 1
  case "$root_mode" in ''|*[!0-7]*) return 1 ;; esac
  [ "$((0$root_mode & 0022))" = 0 ] || return 1
  [ "$(cd -- "$1" && pwd -P)" = "$1" ] || return 1
}
private_dir() {
  [ ! -L "$1" ] || fail SYMBOLIC_DIRECTORY
  if [ ! -e "$1" ]; then mkdir -m 700 -- "$1" 2>/dev/null || { [ -d "$1" ] && [ ! -L "$1" ]; } || fail CREATE_DIRECTORY; fi
  [ -d "$1" ] || fail INVALID_DIRECTORY
  [ "$(owner_of "$1")" = "$(id -u)" ] || fail DIRECTORY_OWNER
  chmod 700 "$1" || fail DIRECTORY_MODE
  owned_dir "$1" || fail INVALID_DIRECTORY
}
private_file() {
  [ -f "$1" ] && [ ! -L "$1" ] || fail INVALID_FILE
  [ "$(owner_of "$1")" = "$(id -u)" ] || fail FILE_OWNER
  [ "$(links_of "$1")" = 1 ] || fail FILE_LINKS
  [ "$(mode_of "$1")" = 600 ] || fail FILE_MODE
}
managed_path() {
  managed_root=$1
  managed_directory=$2
  managed_root "$managed_root" || return 1
  case "$managed_directory" in
    "$managed_root") return 0 ;;
    "$managed_root"/*) relative=__PHI_DOLLAR_LBRACE__managed_directory#"$managed_root"/} ;;
    *) return 1 ;;
  esac
  old_ifs=$IFS
  IFS=/
  set -- $relative
  IFS=$old_ifs
  current=$managed_root
  for segment do
    [ -n "$segment" ] && [ "$segment" != . ] && [ "$segment" != .. ] || return 1
    current=$current/$segment
    owned_dir "$current" || return 1
  done
  [ "$current" = "$managed_directory" ]
}
IFS="$tab" read -r protocol runtime64 project64 guard64 lock64 lock_wait_ms run_exe64 || fail INPUT_HEADER
[ "$protocol" = PHI_RPC_STARTUP_V1 ] || fail INPUT_PROTOCOL
runtime_root=$(decode "$runtime64") || fail INPUT_ROOT
project_root=$(decode "$project64") || fail INPUT_PROJECT
project_plugin_guard=$(decode_optional "$guard64") || fail INPUT_PROJECT_GUARD
run_exe=$(decode_optional "$run_exe64") || fail INPUT_RUN
lock_path=$(decode_optional "$lock64") || fail INPUT_LOCK
case "$lock_wait_ms" in ''|*[!0-9]*) fail INPUT_LOCK ;; esac
case "$runtime_root" in /*) ;; *) fail INPUT_ROOT ;; esac
[ "$runtime_root" != / ] || fail INPUT_ROOT
[ "$(pwd -P)" = "$runtime_root" ] || fail RUNTIME_ROOT
[ -d "$project_root" ] && [ ! -L "$project_root" ] || fail PROJECT_ROOT
[ "$(cd -- "$project_root" && pwd -P)" = "$project_root" ] || fail PROJECT_ROOT
managed_root "$runtime_root" || fail RUNTIME_ROOT
marker_output=''
needs_repair=0
while IFS="$tab" read -r tag item managed64 directory64 path64 expected; do
  [ "$tag" != MARKERS_END ] || break
  [ "$tag" = M ] || fail INPUT_MARKER
  managed=$(decode "$managed64") || fail INPUT_MARKER
  directory=$(decode "$directory64") || fail INPUT_MARKER
  marker=$(decode "$path64") || fail INPUT_MARKER
  reason=''
  if ! managed_path "$managed" "$directory"; then reason=unsafe_directory
  elif [ "$marker" != "$directory/.phi-ready.json" ]; then reason=invalid_marker_path
  elif [ -L "$marker" ]; then reason=symlink_marker
  elif [ ! -e "$marker" ]; then reason=missing_marker
  elif [ ! -f "$marker" ]; then reason=invalid_marker
  elif [ "$(owner_of "$marker")" != "$(id -u)" ]; then reason=wrong_owner
  elif [ "$(links_of "$marker")" != 1 ]; then reason=linked_marker
  elif [ "$(mode_of "$marker")" != 600 ]; then reason=wrong_mode
  elif [ "$(hash_file "$marker")" != "$expected" ]; then reason=wrong_hash
  fi
  if [ -n "$reason" ]; then
    needs_repair=1
    marker_output="__PHI_DOLLAR_LBRACE__marker_output}ITEM__PHI_DOLLAR_LBRACE__tab}__PHI_DOLLAR_LBRACE__item}__PHI_DOLLAR_LBRACE__tab}repair__PHI_DOLLAR_LBRACE__tab}__PHI_DOLLAR_LBRACE__reason}
"
  else
    marker_output="__PHI_DOLLAR_LBRACE__marker_output}ITEM__PHI_DOLLAR_LBRACE__tab}__PHI_DOLLAR_LBRACE__item}__PHI_DOLLAR_LBRACE__tab}ready
"
  fi
done
if [ "$needs_repair" = 1 ]; then
  while IFS= read -r remaining; do [ "$remaining" != END ] || break; done
  printf '%s\n' PHI_RPC_STARTUP_RESULT_V1
  printf '%s' "$marker_output"
  printf '%s\n' 'CHECK	project_plugin_guard	skipped'
  printf '%s\n' 'STATUS	repair'
  printf '%s\n' PHI_RPC_STARTUP_RESULT_END
  exit 0
fi
if [ -n "$project_plugin_guard" ]; then
  [ -f "$project_plugin_guard" ] && [ ! -L "$project_plugin_guard" ] && [ -x "$project_plugin_guard" ] || fail PROJECT_PLUGIN_GUARD
  [ "$(owner_of "$project_plugin_guard")" = "$(id -u)" ] || fail PROJECT_PLUGIN_GUARD
  [ "$(links_of "$project_plugin_guard")" = 1 ] || fail PROJECT_PLUGIN_GUARD
  guard_result=$("$project_plugin_guard" project-plugin-guard --root "$project_root") || fail PROJECT_PLUGIN_GUARD
  [ "$guard_result" = '{"ok":true}' ] || fail PROJECT_PLUGIN_GUARD
  project_plugin_status=ready
else
  project_plugin_status=skipped
fi
resume_manifest=''
resume_manifest_hash=''
resume_manifest_bytes=''
resume_journal=''
resume_session=''
while IFS="$tab" read -r tag manifest64 manifest_hash manifest_bytes journal64 session64; do
  [ "$tag" != RESUME_END ] || break
  if [ "$tag" = R_NONE ]; then continue; fi
  [ "$tag" = R ] || fail INPUT_RESUME
  [ -z "$resume_manifest" ] || fail INPUT_RESUME
  resume_manifest=$(decode "$manifest64") || fail INPUT_RESUME
  resume_manifest_hash=$manifest_hash
  resume_manifest_bytes=$manifest_bytes
  resume_journal=$(decode "$journal64") || fail INPUT_RESUME
  resume_session=$(decode "$session64") || fail INPUT_RESUME
done
while IFS="$tab" read -r tag path64 absent; do
  [ "$tag" != DIRECTORIES_END ] || break
  [ "$tag" = D ] || fail INPUT_DIRECTORY
  path=$(decode "$path64") || fail INPUT_DIRECTORY
  case "$path" in "$runtime_root"/*) ;; *) fail DIRECTORY_SCOPE ;; esac
  if [ "$absent" = 1 ] && { [ -e "$path" ] || [ -L "$path" ]; }; then fail DIRECTORY_EXISTS; fi
  private_dir "$path"
done
run_stopped=''
if [ -n "$lock_path" ]; then
  case "$lock_path" in "$runtime_root"/*) ;; *) fail LOCK_SCOPE ;; esac
  lock_parent=__PHI_DOLLAR_LBRACE__lock_path%/*}
  owned_dir "$lock_parent" || fail LOCK_PARENT
  command -v flock >/dev/null 2>&1 || fail LOCK_TOOL_MISSING
  if [ ! -e "$lock_path" ] && [ ! -L "$lock_path" ]; then (umask 077; set -C; : > "$lock_path") 2>/dev/null || :; fi
  private_file "$lock_path"
  exec 9<>"$lock_path"
  deadline=$(($(date +%s) + (lock_wait_ms + 999) / 1000))
  while ! flock -x -n 9; do
    [ "$(date +%s)" -lt "$deadline" ] || fail LOCK_BUSY
    sleep 0.05
  done
  __PHI_RUN_GUARD__
fi
resume_output=''
if [ -n "$resume_manifest" ]; then
  [ -n "$project_plugin_guard" ] || fail RESUME_HELPER
  resume_json=$("$project_plugin_guard" remote-session-preflight --root "$runtime_root" --project-root "$project_root" --manifest "$resume_manifest" --manifest-sha256 "$resume_manifest_hash" --manifest-bytes "$resume_manifest_bytes" --journal "$resume_journal" --session-id "$resume_session") || fail RESUME_IDENTITY
  resume_output=$(printf '%s' "$resume_json" | base64 | tr -d '\r\n') || fail RESUME_IDENTITY
fi
temporary=''
cleanup() { if [ -n "$temporary" ]; then rm -f -- "$temporary" 2>/dev/null || :; fi; }
trap cleanup EXIT HUP INT TERM
index=0
while IFS="$tab" read -r tag item path64 mode absent expected data64; do
  [ "$tag" != END ] || break
  [ "$tag" = F ] || fail INPUT_FILE
  [ "$mode" = 600 ] || fail FILE_MODE
  path=$(decode "$path64") || fail INPUT_FILE
  case "$path" in "$runtime_root"/*) ;; *) fail FILE_SCOPE ;; esac
  parent=__PHI_DOLLAR_LBRACE__path%/*}
  owned_dir "$parent" || fail FILE_PARENT
  if [ "$absent" = 1 ] && { [ -e "$path" ] || [ -L "$path" ]; }; then fail FILE_EXISTS; fi
  index=$((index + 1))
  temporary=$parent/.phi-startup-$$-$index.tmp
  [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || fail TEMPORARY_EXISTS
  (umask 077; set -C; : > "$temporary") 2>/dev/null || fail CREATE_FILE
  printf '%s' "$data64" | base64 -d > "$temporary" || fail DECODE_FILE
  [ "$(hash_file "$temporary")" = "$expected" ] || fail FILE_HASH
  chmod 600 "$temporary" || fail FILE_MODE
  private_file "$temporary"
  if [ "$absent" = 1 ]; then
    ln -- "$temporary" "$path" || fail FILE_EXISTS
    rm -- "$temporary" || fail PUBLISH_FILE
  else
    mv -f -- "$temporary" "$path" || fail PUBLISH_FILE
  fi
  temporary=''
  private_file "$path"
  [ "$(hash_file "$path")" = "$expected" ] || fail FILE_HASH
done
trap - EXIT HUP INT TERM
printf '%s\n' PHI_RPC_STARTUP_RESULT_V1
printf '%s' "$marker_output"
printf 'CHECK\tproject_plugin_guard\t%s\n' "$project_plugin_status"
if [ -n "$resume_output" ]; then printf 'RESUME\t%s\n' "$resume_output"; fi
if [ -n "$run_stopped" ]; then printf 'TAKEOVER\t%s\n' "$run_stopped"; fi
printf '%s\n' 'STATUS	ready'
printf '%s\n' PHI_RPC_STARTUP_RESULT_END
if [ -n "$lock_path" ]; then while IFS= read -r _line; do :; done; fi`
  .replace('__PHI_RUN_GUARD__', () => RUN_GUARD_SCRIPT)
  .replaceAll('__PHI_DOLLAR_LBRACE__', '${')

/** Run-guard refusals are domain conflicts the user must see, never generic startup failures. */
function startupFailure(message: string, stderr: string): Error {
  if (/PHI_STARTUP:RUN_(?:HELD_UNVERIFIED|STOP_FAILED)/u.test(stderr))
    return new CodedError('DOMAIN_CONFLICT', RUN_HELD_MESSAGE, { cause: new Error(message) })
  return new Error(message)
}

function parseResult(
  result: RemoteExecResult,
  transaction: RpcStartupTransaction
): RpcStartupTransactionResult {
  if (result.code !== 0 || result.signal) {
    throw startupFailure(
      `Remote RPC startup transaction failed: ${result.stderr.trim() || result.code}`,
      result.stderr
    )
  }
  const lines = result.stdout.trimEnd().split('\n')
  if (lines.shift() !== RESULT_PROTOCOL) throw new Error('Invalid remote RPC startup result')
  if (lines.pop() !== 'PHI_RPC_STARTUP_RESULT_END')
    throw new Error('Incomplete remote RPC startup result')
  const markers: Array<RpcStartupTransactionResult['markers'][number]> = []
  const checks: Array<RpcStartupTransactionResult['checks'][number]> = []
  let resume: RpcStartupTransactionResult['resume']
  let status: RpcStartupTransactionResult['status'] | undefined
  let takeover: RpcStartupTransactionResult['takeover']
  for (const line of lines) {
    const fields = line.split('\t')
    if (fields[0] === 'ITEM') {
      const [, item, markerStatus, reason] = fields
      if (
        !itemPattern.test(item ?? '') ||
        (markerStatus !== 'ready' && markerStatus !== 'repair') ||
        (markerStatus === 'ready' && reason !== undefined) ||
        (markerStatus === 'repair' && !itemPattern.test(reason ?? ''))
      )
        throw new Error('Invalid remote RPC startup marker result')
      if (markers.some((marker) => marker.item === item))
        throw new Error('Duplicate remote RPC startup marker result')
      markers.push({ item: item!, status: markerStatus, ...(reason ? { reason } : {}) })
    } else if (
      fields[0] === 'CHECK' &&
      fields[1] === 'project_plugin_guard' &&
      (fields[2] === 'ready' || fields[2] === 'skipped') &&
      fields.length === 3 &&
      checks.length === 0
    ) {
      checks.push({ item: 'project_plugin_guard', status: fields[2] })
    } else if (fields[0] === 'RESUME' && fields.length === 2 && resume === undefined) {
      let value: unknown
      try {
        value = JSON.parse(Buffer.from(fields[1]!, 'base64').toString('utf8'))
      } catch {
        throw new Error('Invalid remote RPC startup resume result')
      }
      const raw = value as {
        manifest?: Record<string, unknown>
        journal?: Record<string, unknown>
      }
      const manifest = raw?.manifest
      const journal = raw?.journal
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(',') !== 'journal,manifest' ||
        !manifest ||
        Object.keys(manifest).sort().join(',') !== 'path,sha256,size' ||
        typeof manifest.path !== 'string' ||
        !Number.isSafeInteger(manifest.size) ||
        !/^[a-f0-9]{64}$/.test(String(manifest.sha256)) ||
        !journal ||
        Object.keys(journal).sort().join(',') !==
          'cwd,fileIdentity,fingerprint,headerVersion,journalPath,ompSessionId,verification' ||
        typeof journal.journalPath !== 'string' ||
        typeof journal.ompSessionId !== 'string' ||
        typeof journal.cwd !== 'string' ||
        journal.headerVersion !== 3 ||
        !/^[a-f0-9]{64}$/.test(String(journal.fileIdentity)) ||
        !/^[a-f0-9]{64}$/.test(String(journal.fingerprint)) ||
        journal.verification !== 'bounded-header'
      )
        throw new Error('Invalid remote RPC startup resume result')
      resume = {
        manifest: {
          path: manifest.path,
          size: manifest.size as number,
          sha256: manifest.sha256 as string
        },
        journal: journal as unknown as RemoteJournalPreflight
      }
    } else if (
      fields[0] === 'TAKEOVER' &&
      fields.length === 2 &&
      /^[1-9][0-9]{0,9}$/u.test(fields[1] ?? '') &&
      takeover === undefined
    ) {
      takeover = { stoppedPid: Number(fields[1]) }
    } else if (
      fields[0] === 'STATUS' &&
      fields.length === 2 &&
      (fields[1] === 'ready' || fields[1] === 'repair') &&
      status === undefined
    ) {
      status = fields[1]
    } else throw new Error('Invalid remote RPC startup result field')
  }
  const resumeMatches =
    !transaction.resume ||
    status === 'repair' ||
    (resume?.manifest.path === transaction.resume.manifestPath &&
      resume.manifest.size === transaction.resume.manifestBytes &&
      resume.manifest.sha256 === transaction.resume.manifestSha256 &&
      resume.journal.journalPath === transaction.resume.journalPath &&
      resume.journal.ompSessionId === transaction.resume.ompSessionId &&
      resume.journal.cwd === transaction.projectRoot)
  if (
    !status ||
    checks.length !== 1 ||
    Boolean(resume) !== Boolean(transaction.resume && status === 'ready') ||
    !resumeMatches ||
    markers.length !== transaction.markers.length ||
    transaction.markers.some((expected) => !markers.some((item) => item.item === expected.item)) ||
    (status === 'repair') !== markers.some((item) => item.status === 'repair') ||
    (status === 'repair' && checks[0]?.status !== 'skipped')
  )
    throw new Error('Inconsistent remote RPC startup result')
  return Object.freeze({
    status,
    ...(takeover ? { takeover: Object.freeze(takeover) } : {}),
    checks: Object.freeze(checks.map((item) => Object.freeze(item))),
    ...(resume
      ? {
          resume: Object.freeze({
            manifest: Object.freeze({ ...resume.manifest }),
            journal: Object.freeze({ ...resume.journal })
          })
        }
      : {}),
    markers: Object.freeze(markers.map((item) => Object.freeze(item)))
  })
}

export async function runRpcStartupTransaction(
  session: Pick<RemoteSshSession, 'execWithInput' | 'openStdio'>,
  transaction: RpcStartupTransaction,
  signal?: AbortSignal
): Promise<RpcStartupTransactionExecution> {
  if (transaction.lock) return runRpcStartupTransactionWithLock(session, transaction, signal)
  if (!session.execWithInput)
    throw new Error('SSH connection lacks the bounded RPC startup transaction channel')
  signal?.throwIfAborted()
  const result = await session.execWithInput(
    `cd -- ${q(transaction.runtimeRoot)} && /bin/sh -c ${q(STARTUP_SCRIPT)}`,
    serialize(transaction),
    {
      signal,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024
    }
  )
  signal?.throwIfAborted()
  return { result: parseResult(result, transaction) }
}

async function writeStartupInput(channel: RemoteStdioProcess, input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    channel.stdin.write(input, (error?: Error | null) => (error ? reject(error) : resolve()))
  })
}

async function runRpcStartupTransactionWithLock(
  session: Pick<RemoteSshSession, 'openStdio'>,
  transaction: RpcStartupTransaction,
  signal?: AbortSignal
): Promise<RpcStartupTransactionExecution> {
  if (!session.openStdio)
    throw new Error('SSH connection lacks the held RPC startup transaction channel')
  signal?.throwIfAborted()
  const command = `cd -- ${q(transaction.runtimeRoot)} && /bin/sh -c ${q(STARTUP_SCRIPT)}`
  const channel = await session.openStdio(command)
  let released = false
  let closePromise: Promise<void> | undefined
  let stdout = ''
  let stderr = ''
  let resolveOutput!: (value: string) => void
  let rejectOutput!: (error: Error) => void
  const output = new Promise<string>((resolve, reject) => {
    resolveOutput = resolve
    rejectOutput = reject
  })
  const onStdout = (bytes: Buffer): void => {
    stdout += bytes.toString('utf8')
    if (Buffer.byteLength(stdout) > 64 * 1024) {
      rejectOutput(new Error('Remote RPC startup result exceeds its output limit'))
      return
    }
    const marker = 'PHI_RPC_STARTUP_RESULT_END\n'
    const index = stdout.indexOf(marker)
    if (index >= 0) {
      if (index + marker.length !== stdout.length)
        rejectOutput(new Error('Invalid trailing remote RPC startup output'))
      else resolveOutput(stdout)
    }
  }
  const onStderr = (bytes: Buffer): void => {
    stderr = (stderr + bytes.toString('utf8')).slice(-64 * 1024)
  }
  channel.stdout.on('data', onStdout)
  channel.stderr.on('data', onStderr)
  const abort = (): void => rejectOutput(signal?.reason ?? new Error('RPC startup cancelled'))
  signal?.addEventListener('abort', abort, { once: true })
  const ended = channel.closed.then<never>(() => {
    throw startupFailure(`Remote RPC startup transaction ended early: ${stderr.trim()}`, stderr)
  })
  void ended.catch(() => undefined)
  const timer = setTimeout(
    () => rejectOutput(new Error(`Remote RPC startup transaction timed out: ${stderr.trim()}`)),
    STARTUP_LOCK_CHANNEL_TIMEOUT_MS
  )
  try {
    await writeStartupInput(channel, serialize(transaction))
    const complete = await Promise.race([output, ended])
    signal?.throwIfAborted()
    const result = parseResult({ stdout: complete, stderr, code: 0, signal: null }, transaction)
    if (result.status === 'repair') {
      released = true
      await channel.close()
      return { result }
    }
    let rejectLost!: (error: Error) => void
    const lost = new Promise<never>((_, reject) => {
      rejectLost = reject
    })
    void lost.catch(() => undefined)
    void channel.closed.then(
      () => {
        if (!released) rejectLost(new Error('Remote RPC startup lock channel disconnected'))
      },
      (error: Error) => {
        if (!released) rejectLost(error)
      }
    )
    return {
      result,
      lock: {
        lost,
        release() {
          released = true
          closePromise ??= channel.close()
          return closePromise
        }
      }
    }
  } catch (error) {
    released = true
    await channel.close().catch(() => undefined)
    signal?.throwIfAborted()
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    channel.stdout.off('data', onStdout)
    channel.stderr.off('data', onStderr)
    channel.stdout.resume()
    channel.stderr.resume()
  }
}
