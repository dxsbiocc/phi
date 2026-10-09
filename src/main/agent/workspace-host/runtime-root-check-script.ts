export const RUNTIME_ROOT_CHECK_START_SENTINEL = '__PHI_RUNTIME_ROOT_CHECK_V1_BEGIN__'
export const RUNTIME_ROOT_CHECK_END_SENTINEL = '__PHI_RUNTIME_ROOT_CHECK_V1_END__'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const REMOTE_RUNTIME_ROOT_CHECK_SCRIPT_TEMPLATE = `#!/bin/sh
umask 077

phi_configured_root=__PHI_CONFIGURED_ROOT__
phi_probe_file=
trap 'if test -n "$phi_probe_file"; then rm -f "$phi_probe_file"; fi' 0 1 2 3 15

phi_emit() {
  printf '%s=%s\\n' "$1" "$2"
}

phi_hard_error() {
  phi_emit hard.error "$1"
  phi_emit probe.complete 1
  printf '%s\\n' '${RUNTIME_ROOT_CHECK_END_SENTINEL}'
  exit 0
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
if ! (set -C; printf '%s\\n' '#!/bin/sh' 'exit 0' >"$phi_probe_file") 2>/dev/null; then
  phi_emit path.ancestor_writable 0
  phi_hard_error ancestor-not-writable
fi
phi_emit path.ancestor_writable 1
chmod 700 "$phi_probe_file" 2>/dev/null
if "$phi_probe_file" >/dev/null 2>&1; then phi_emit path.executable 1; else phi_emit path.executable 0; fi
rm -f "$phi_probe_file"
phi_probe_file=

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

phi_emit probe.complete 1
printf '%s\\n' '${RUNTIME_ROOT_CHECK_END_SENTINEL}'
`

export function buildRemoteRuntimeRootCheckScript(configuredRoot: string): string {
  return REMOTE_RUNTIME_ROOT_CHECK_SCRIPT_TEMPLATE.replace(
    '__PHI_CONFIGURED_ROOT__',
    shellQuote(configuredRoot)
  )
}
