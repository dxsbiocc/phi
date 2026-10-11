export const RUNTIME_ROOT_CHECK_START_SENTINEL = '__PHI_RUNTIME_ROOT_CHECK_V1_BEGIN__'
export const RUNTIME_ROOT_CHECK_END_SENTINEL = '__PHI_RUNTIME_ROOT_CHECK_V1_END__'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export type RemoteRuntimeRootCapacityProbeFailureMode =
  'edquot' | 'no-space' | 'read-only' | 'other'

export interface RemoteRuntimeRootCheckScriptOptions {
  capacityProbeFailureMode?: RemoteRuntimeRootCapacityProbeFailureMode
  capacityProbeTimeoutSeconds?: number
  capacityProbeDelaySeconds?: number
}

function boundedSeconds(value: number | undefined, fallback: number, maximum: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return String(fallback)
  return String(Math.min(value, maximum))
}

const REMOTE_RUNTIME_ROOT_CHECK_SCRIPT_TEMPLATE = `#!/bin/sh
umask 077
LC_ALL=C
export LC_ALL

phi_configured_root=__PHI_CONFIGURED_ROOT__
phi_capacity_probe_failure_mode=__PHI_CAPACITY_PROBE_FAILURE_MODE__
phi_capacity_probe_timeout=__PHI_CAPACITY_PROBE_TIMEOUT_SECONDS__
phi_capacity_probe_delay=__PHI_CAPACITY_PROBE_DELAY_SECONDS__
phi_probe_file=
phi_capacity_probe_dir=

phi_cleanup() {
  if test -n "$phi_probe_file"; then rm -f "$phi_probe_file"; fi
  if test -n "$phi_capacity_probe_dir"; then rm -rf "$phi_capacity_probe_dir"; fi
}
trap phi_cleanup 0
trap 'phi_cleanup; exit 1' 1 2 3 15

phi_emit() {
  printf '%s=%s\\n' "$1" "$2"
}

phi_hard_error() {
  phi_emit hard.error "$1"
  phi_emit probe.complete 1
  printf '%s\\n' '${RUNTIME_ROOT_CHECK_END_SENTINEL}'
  exit 0
}

phi_emit_capacity_result() {
  phi_emit path.write_capacity "$1"
  case "$1" in
    quota-exceeded|no-space|read-only) phi_hard_error write-capacity-exhausted ;;
  esac
}

phi_capacity_error_value() {
  phi_capacity_error_lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$phi_capacity_error_lower" in
    *"disk quota exceeded"*|*edquot*|*quota*exceeded*) printf '%s' quota-exceeded ;;
    *"no space left on device"*|*enospc*) printf '%s' no-space ;;
    *"read-only file system"*|*erofs*) printf '%s' read-only ;;
    *) printf '%s' other ;;
  esac
}

phi_classify_capacity_error() {
  phi_emit_capacity_result "$(phi_capacity_error_value "$1")"
}

phi_injected_capacity_error() {
  case "$phi_capacity_probe_failure_mode" in
    edquot) printf '%s' 'Disk quota exceeded (EDQUOT)' ;;
    no-space) printf '%s' 'No space left on device (ENOSPC)' ;;
    read-only) printf '%s' 'Read-only file system (EROFS)' ;;
    other) printf '%s' 'Injected write failure' ;;
  esac
}

phi_select_capacity_ancestor() {
  phi_capacity_ancestor=$phi_canonical_ancestor
  if test "$phi_exists" = 1; then
    if test "$phi_canonical_ancestor" = /; then
      phi_capacity_ancestor=
    else
      phi_capacity_ancestor=\${phi_canonical_ancestor%/*}
      test -n "$phi_capacity_ancestor" || phi_capacity_ancestor=/
    fi
  fi
  while test -n "$phi_capacity_ancestor" && ! test -w "$phi_capacity_ancestor"; do
    test "$phi_capacity_ancestor" != / || { phi_capacity_ancestor=; break; }
    phi_capacity_ancestor=\${phi_capacity_ancestor%/*}
    test -n "$phi_capacity_ancestor" || phi_capacity_ancestor=/
  done
}

phi_capacity_probe_task() {
  phi_capacity_result=ok
  phi_capacity_error=$(mkdir "$phi_capacity_probe_dir" 2>&1)
  if test $? -ne 0; then
    phi_capacity_result=$(phi_capacity_error_value "$phi_capacity_error")
  elif test "$phi_capacity_probe_delay" != 0; then
    sleep "$phi_capacity_probe_delay" >/dev/null 2>&1
  fi
  phi_capacity_index=1
  while test "$phi_capacity_result" = ok && test "$phi_capacity_index" -le 8; do
    if test "$phi_capacity_index" = 4 && test -n "$phi_capacity_probe_failure_mode"; then
      phi_capacity_result=$(phi_capacity_error_value "$(phi_injected_capacity_error)")
      break
    fi
    phi_capacity_error=$( (printf '%s\n' x >"$phi_capacity_probe_dir/$phi_capacity_index") 2>&1)
    if test $? -ne 0; then
      phi_capacity_result=$(phi_capacity_error_value "$phi_capacity_error")
      break
    fi
    test -s "$phi_capacity_probe_dir/$phi_capacity_index" || { phi_capacity_result=other; break; }
    phi_capacity_index=$((phi_capacity_index + 1))
  done
  rm -rf "$phi_capacity_probe_dir" 2>/dev/null || return 1
  printf '%s' "$phi_capacity_result"
}

phi_capacity_probe_with_watchdog() {
  phi_capacity_probe_task &
  phi_capacity_pid=$!
  (trap 'kill "$phi_capacity_sleep" 2>/dev/null; exit 0' TERM INT; sleep "$phi_capacity_probe_timeout" & phi_capacity_sleep=$!; wait "$phi_capacity_sleep"; kill "$phi_capacity_pid" 2>/dev/null && printf '%s' timeout) 2>/dev/null &
  phi_capacity_watchdog=$!
  if wait "$phi_capacity_pid"; then phi_capacity_status=0; else phi_capacity_status=$?; fi
  kill "$phi_capacity_watchdog" 2>/dev/null || :
  wait "$phi_capacity_watchdog" 2>/dev/null || :
  printf ':%s' "$phi_capacity_status"
}

phi_probe_write_capacity() {
  phi_select_capacity_ancestor
  test -n "$phi_capacity_ancestor" || { phi_emit_capacity_result other; return; }
  phi_capacity_probe_dir=$phi_capacity_ancestor/.phi-runtime-root-capacity-probe-$$
  phi_capacity_outcome=$(phi_capacity_probe_with_watchdog)
  case "$phi_capacity_outcome" in
    *:0)
      phi_capacity_value=\${phi_capacity_outcome%:*}
      phi_capacity_probe_dir=
      case "$phi_capacity_value" in
        ok|quota-exceeded|no-space|read-only|other) phi_emit_capacity_result "$phi_capacity_value" ;;
        *) phi_emit_capacity_result unknown ;;
      esac
      ;;
    *)
      if rm -rf "$phi_capacity_probe_dir" 2>/dev/null; then phi_capacity_probe_dir=; fi
      phi_emit_capacity_result unknown
      ;;
  esac
}

phi_read_package_cache() {
  phi_pkgs_dir=$phi_expanded/pkgs
  if ! test -d "$phi_pkgs_dir"; then
    phi_emit cache.entry_count 0
    phi_emit cache.bytes 0
    return
  fi
  phi_cache_count=$(find "$phi_pkgs_dir" -mindepth 1 -maxdepth 1 -print 2>/dev/null | awk 'END { print NR + 0 }')
  case "$phi_cache_count" in ''|*[!0-9]*) phi_cache_count=0 ;; esac
  phi_emit cache.entry_count "$phi_cache_count"
  phi_timeout_command=$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null)
  test -n "$phi_timeout_command" || return
  phi_cache_du=$("$phi_timeout_command" 2 du -sk "$phi_pkgs_dir" 2>/dev/null)
  test $? -eq 0 || return
  set -- $phi_cache_du
  case "$1" in ''|*[!0-9]*) return ;; *) phi_emit cache.bytes "$(( $1 * 1024 ))" ;; esac
}

phi_is_group_or_other_writable() {
  phi_mode=$1
  phi_other=\${phi_mode#\${phi_mode%?}}
  phi_without_other=\${phi_mode%?}
  phi_group=\${phi_without_other#\${phi_without_other%?}}
  case "$phi_group$phi_other" in
    *2*|*3*|*6*|*7*) printf '%s\\n' 1 ;;
    *) printf '%s\\n' 0 ;;
  esac
}

printf '%s\\n' '${RUNTIME_ROOT_CHECK_START_SENTINEL}'
case "$phi_configured_root" in
  /*) phi_candidate=$phi_configured_root ;;
  '~/'*)
    case "$HOME" in
      /*) phi_candidate=$HOME/\${phi_configured_root#'~/'} ;;
      *) phi_hard_error unable-to-expand ;;
    esac
    ;;
  *) phi_hard_error unable-to-expand ;;
esac

while test "$phi_candidate" != / && test "\${phi_candidate%/}" != "$phi_candidate"; do
  phi_candidate=\${phi_candidate%/}
done

phi_has_symlink=0
phi_prefix=
phi_old_ifs=$IFS
IFS=/
set -f
set -- $phi_candidate
set +f
IFS=$phi_old_ifs
for phi_component do
  test -n "$phi_component" || continue
  phi_prefix=$phi_prefix/$phi_component
  if test -L "$phi_prefix"; then phi_has_symlink=1; fi
done

phi_exists=0
if test -e "$phi_candidate" || test -L "$phi_candidate"; then phi_exists=1; fi
if test "$phi_exists" = 1 && ! test -d "$phi_candidate"; then
  phi_hard_error unable-to-expand
fi

phi_ancestor=$phi_candidate
phi_suffix=
while ! test -d "$phi_ancestor"; do
  phi_component=\${phi_ancestor##*/}
  if test -n "$phi_component" && test "$phi_component" != .; then
    phi_suffix=/$phi_component$phi_suffix
  fi
  phi_parent=\${phi_ancestor%/*}
  if test -z "$phi_parent"; then phi_parent=/; fi
  if test "$phi_parent" = "$phi_ancestor"; then phi_hard_error unable-to-expand; fi
  phi_ancestor=$phi_parent
done

phi_canonical_ancestor=$(CDPATH= cd -P "$phi_ancestor" 2>/dev/null && pwd -P)
test -n "$phi_canonical_ancestor" || phi_hard_error unable-to-expand
phi_expanded=$phi_canonical_ancestor$phi_suffix
if test "$phi_expanded" != /; then
  while test "\${phi_expanded%/}" != "$phi_expanded"; do phi_expanded=\${phi_expanded%/}; done
fi

phi_emit path.expanded "$phi_expanded"
phi_emit path.exists "$phi_exists"
phi_emit path.ancestor "$phi_canonical_ancestor"
phi_emit path.symlink "$phi_has_symlink"

if ! test -w "$phi_canonical_ancestor"; then
  phi_emit path.ancestor_writable 0
  phi_hard_error ancestor-not-writable
fi

phi_probe_file=$phi_canonical_ancestor/.phi-runtime-root-probe-$$
phi_probe_error=$( (set -C; printf '%s\\n' '#!/bin/sh' 'exit 0' >"$phi_probe_file") 2>&1)
if test $? -ne 0; then
  phi_probe_error_lower=$(printf '%s' "$phi_probe_error" | tr '[:upper:]' '[:lower:]')
  case "$phi_probe_error_lower" in
    *"disk quota exceeded"*|*edquot*|*quota*exceeded*|*"no space left on device"*|*enospc*)
      phi_classify_capacity_error "$phi_probe_error"
      ;;
  esac
  phi_emit path.ancestor_writable 0
  phi_hard_error ancestor-not-writable
fi
phi_emit path.ancestor_writable 1
chmod 700 "$phi_probe_file" 2>/dev/null
if "$phi_probe_file" >/dev/null 2>&1; then phi_emit path.executable 1; else phi_emit path.executable 0; fi
rm -f "$phi_probe_file"
phi_probe_file=

phi_probe_write_capacity

phi_current_uid=$(id -u 2>/dev/null)
phi_owner_uid=$(stat -c %u "$phi_canonical_ancestor" 2>/dev/null || stat -f %u "$phi_canonical_ancestor" 2>/dev/null)
if test -n "$phi_current_uid" && test -n "$phi_owner_uid"; then
  if test "$phi_current_uid" = "$phi_owner_uid"; then phi_emit path.owned 1; else phi_emit path.owned 0; fi
else
  phi_emit path.owned unknown
fi

phi_mode=$(stat -c %a "$phi_canonical_ancestor" 2>/dev/null || stat -f %Lp "$phi_canonical_ancestor" 2>/dev/null)
case "$phi_mode" in
  ''|*[!0-9]*) phi_emit path.group_or_other_writable unknown ;;
  *) phi_emit path.group_or_other_writable "$(phi_is_group_or_other_writable "$phi_mode")" ;;
esac

phi_fs_type=$(LC_ALL=C df -PT "$phi_canonical_ancestor" 2>/dev/null | awk 'NR > 1 { value=$2 } END { print value }')
if test -z "$phi_fs_type"; then
  phi_fs_type=$(stat -f -c %T "$phi_canonical_ancestor" 2>/dev/null || stat -f %T "$phi_canonical_ancestor" 2>/dev/null)
fi
test -n "$phi_fs_type" || phi_fs_type=unknown
phi_emit fs.type "$phi_fs_type"

phi_df=$(LC_ALL=C df -Pk "$phi_canonical_ancestor" 2>/dev/null | awk 'NR > 1 { available=$4; used=$5 } END { print available " " used }')
set -- $phi_df
case "$1" in ''|*[!0-9]*) phi_emit fs.available_kib unknown ;; *) phi_emit fs.available_kib "$1" ;; esac
phi_disk_use=\${2%%%}
case "$phi_disk_use" in ''|*[!0-9]*) phi_emit fs.disk_use_percent unknown ;; *) phi_emit fs.disk_use_percent "$phi_disk_use" ;; esac

phi_inode_use=$(LC_ALL=C df -Pi "$phi_canonical_ancestor" 2>/dev/null | awk 'NR > 1 { value=$5 } END { print value }')
phi_inode_use=\${phi_inode_use%%%}
case "$phi_inode_use" in ''|*[!0-9]*) phi_emit fs.inode_use_percent unknown ;; *) phi_emit fs.inode_use_percent "$phi_inode_use" ;; esac

phi_fs_lower=$(printf '%s' "$phi_fs_type" | tr '[:upper:]' '[:lower:]')
case "$phi_fs_lower" in
  nfs*|lustre*|gpfs*|ceph*|beegfs*|panfs*|afs*|cifs*|smb*|fuse.sshfs*) phi_emit fs.shared 1 ;;
  unknown) phi_emit fs.shared unknown ;;
  *) phi_emit fs.shared 0 ;;
esac

phi_read_package_cache

phi_emit probe.complete 1
printf '%s\\n' '${RUNTIME_ROOT_CHECK_END_SENTINEL}'
`

export function buildRemoteRuntimeRootCheckScript(
  configuredRoot: string,
  options: RemoteRuntimeRootCheckScriptOptions = {}
): string {
  return REMOTE_RUNTIME_ROOT_CHECK_SCRIPT_TEMPLATE.replace(
    '__PHI_CONFIGURED_ROOT__',
    shellQuote(configuredRoot)
  )
    .replace(
      '__PHI_CAPACITY_PROBE_FAILURE_MODE__',
      shellQuote(options.capacityProbeFailureMode ?? '')
    )
    .replace(
      '__PHI_CAPACITY_PROBE_TIMEOUT_SECONDS__',
      shellQuote(boundedSeconds(options.capacityProbeTimeoutSeconds, 4, 30))
    )
    .replace(
      '__PHI_CAPACITY_PROBE_DELAY_SECONDS__',
      shellQuote(boundedSeconds(options.capacityProbeDelaySeconds, 0, 60))
    )
}
