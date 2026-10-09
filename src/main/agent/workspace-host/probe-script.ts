export const PROBE_START_SENTINEL = '__PHI_CAPABILITY_PROBE_V1_BEGIN__'
export const PROBE_END_SENTINEL = '__PHI_CAPABILITY_PROBE_V1_END__'
export const FAST_PROBE_START_SENTINEL = '__PHI_CAPABILITY_PROBE_V2_FAST_BEGIN__'
export const FAST_PROBE_END_SENTINEL = '__PHI_CAPABILITY_PROBE_V2_FAST_END__'
export const SLOW_PROBE_START_SENTINEL = '__PHI_CAPABILITY_PROBE_V2_SLOW_BEGIN__'
export const SLOW_PROBE_END_SENTINEL = '__PHI_CAPABILITY_PROBE_V2_SLOW_END__'

export const HOST_CAPABILITY_FAST_PROBE_SCRIPT = `#!/bin/sh
umask 077

phi_emit() {
  printf '%s=%s\\n' "$1" "$2"
}

phi_home_probe_dir="$HOME/.phi-capability-probe-$$"
phi_home_probe="$phi_home_probe_dir/run"
trap 'rm -f "$phi_home_probe"; rmdir "$phi_home_probe_dir" 2>/dev/null' 0 1 2 3 15

printf '%s\\n' '${FAST_PROBE_START_SENTINEL}'
phi_uname=$(uname -sm 2>/dev/null)
set -- $phi_uname
phi_emit platform.os "$1"
phi_emit platform.arch "$2"

phi_libc=$(getconf GNU_LIBC_VERSION 2>/dev/null)
case "$phi_libc" in
  glibc\\ *)
    set -- $phi_libc
    phi_emit libc.name glibc
    phi_emit libc.version "$2"
    ;;
  *)
    phi_ldd=$(ldd --version 2>&1 | head -n 2)
    case "$phi_ldd" in
      *musl*)
        phi_emit libc.name musl
        phi_musl_version=$(printf '%s\\n' "$phi_ldd" | awk '/Version/{print $NF; exit}')
        phi_emit libc.version "$phi_musl_version"
        ;;
      *GLIBC*|*glibc*|*GNU*)
        phi_emit libc.name glibc
        phi_glibc_version=$(printf '%s\\n' "$phi_ldd" | awk 'NR == 1 { print $NF }')
        phi_emit libc.version "$phi_glibc_version"
        ;;
      *) phi_emit libc.name unknown ;;
    esac
    ;;
esac

for phi_prerequisite in perl python3 tar sha256sum; do
  if command -v "$phi_prerequisite" >/dev/null 2>&1; then
    phi_emit "prerequisite.$phi_prerequisite.available" 1
  else
    phi_emit "prerequisite.$phi_prerequisite.available" 0
  fi
done

if mkdir "$phi_home_probe_dir" 2>/dev/null && ( : >"$phi_home_probe" ) 2>/dev/null; then
  phi_emit storage.home_writable 1
  printf '#!/bin/sh\\nexit 0\\n' >"$phi_home_probe"
  chmod 700 "$phi_home_probe" 2>/dev/null
  if "$phi_home_probe" >/dev/null 2>&1; then
    phi_emit storage.home_executable 1
  else
    phi_emit storage.home_executable 0
  fi
else
  phi_emit storage.home_writable 0
  phi_emit storage.home_executable unknown
fi
rm -f "$phi_home_probe"
rmdir "$phi_home_probe_dir" 2>/dev/null

phi_space=$(df -Pk "$HOME" 2>/dev/null | awk 'NR > 1 { value=$4 } END { print value }')
case "$phi_space" in
  ''|*[!0-9]*) phi_emit storage.available_kib unknown ;;
  *) phi_emit storage.available_kib "$phi_space" ;;
esac

phi_emit probe.fast_complete 1
printf '%s\\n' '${FAST_PROBE_END_SENTINEL}'
`

export const HOST_CAPABILITY_SLOW_PROBE_SCRIPT = `#!/bin/sh
umask 077

phi_emit() {
  printf '%s=%s\\n' "$1" "$2"
}

phi_version() {
  phi_key=$1
  shift
  if test -z "$phi_tmp_dir"; then
    phi_emit "tool.$phi_key.version_unavailable" 1
    return 1
  fi
  phi_out="$phi_tmp_dir/$phi_key.version"
  phi_timed_out="$phi_tmp_dir/$phi_key.timeout"
  "$@" >"$phi_out" 2>&1 &
  phi_command_pid=$!
  (
    sleep 3
    if kill -0 "$phi_command_pid" 2>/dev/null; then
      : >"$phi_timed_out"
      kill "$phi_command_pid" 2>/dev/null
    fi
  ) &
  phi_guard_pid=$!
  wait "$phi_command_pid" 2>/dev/null
  phi_command_status=$?
  kill "$phi_guard_pid" 2>/dev/null
  wait "$phi_guard_pid" 2>/dev/null
  if test -f "$phi_timed_out"; then
    phi_emit "tool.$phi_key.version_timeout" 1
    phi_status=124
  elif ! test -f "$phi_out" || test "$phi_command_status" -ne 0; then
    phi_emit "tool.$phi_key.version_unavailable" 1
    phi_status=1
  else
    phi_line=$(awk '{ for (i=1; i<=NF; i++) { token=$i; sub(/^[^0-9]*/, "", token); sub(/[^0-9A-Za-z.+_-].*$/, "", token); if (token ~ /^[0-9]+([.][0-9A-Za-z+_-]+)+$/) { print token; exit } } }' "$phi_out")
    if test -n "$phi_line"; then
      phi_emit "tool.$phi_key.version" "$phi_line"
      phi_status=0
    else
      phi_emit "tool.$phi_key.version_unavailable" 1
      phi_status=1
    fi
  fi
  rm -f "$phi_out" "$phi_timed_out"
  return "$phi_status"
}

phi_tool() {
  phi_key=$1
  phi_command=$2
  shift 2
  if command -v "$phi_command" >/dev/null 2>&1; then
    phi_emit "tool.$phi_key.available" 1
    phi_version "$phi_key" "$@"
  else
    phi_emit "tool.$phi_key.available" 0
  fi
}

phi_module() {
  phi_login_shell=$SHELL
  if test -z "$phi_login_shell" || ! test -x "$phi_login_shell"; then
    phi_login_shell=/bin/sh
  fi
  phi_version module "$phi_login_shell" -lc 'command -v module >/dev/null 2>&1 && module --version'
  phi_module_status=$?
  if test "$phi_module_status" -eq 0; then
    phi_emit tool.module.available 1
  elif test "$phi_module_status" -eq 124; then
    phi_emit tool.module.available unknown
  else
    phi_emit tool.module.available 0
  fi
}

phi_tmp_dir="\${TMPDIR:-/tmp}/.phi-capability-probe-$$"
if ! mkdir "$phi_tmp_dir" 2>/dev/null; then
  phi_tmp_dir=
fi
trap 'if test -n "$phi_tmp_dir"; then rm -f "$phi_tmp_dir"/*; rmdir "$phi_tmp_dir" 2>/dev/null; fi' 0 1 2 3 15

printf '%s\\n' '${SLOW_PROBE_START_SENTINEL}'
phi_fs=$(stat -f -c %T "$HOME" 2>/dev/null || stat -f %T "$HOME" 2>/dev/null)
case "$phi_fs" in
  nfs*|NFS*|cifs*|smb*|afs*|lustre*|gpfs*|panfs*|ceph*|fuse.sshfs*)
    phi_emit storage.shared 1
    ;;
  ext*|xfs*|btrfs*|tmpfs*|overlay*|apfs*|ufs*)
    phi_emit storage.shared 0
    ;;
  *) phi_emit storage.shared unknown ;;
esac

if test -n "$phi_tmp_dir"; then
  phi_tool git git git --version >"$phi_tmp_dir/git.rows" &
  if test -x "$HOME/.local/bin/nextflow"; then
    (phi_emit tool.nextflow.available 1; phi_version nextflow "$HOME/.local/bin/nextflow" -version) >"$phi_tmp_dir/nextflow.rows" &
  else
    phi_tool nextflow nextflow nextflow -version >"$phi_tmp_dir/nextflow.rows" &
  fi
  phi_tool java java java -version >"$phi_tmp_dir/java.rows" &
  phi_tool conda conda conda --version >"$phi_tmp_dir/conda.rows" &
  phi_tool sbatch sbatch sbatch --version >"$phi_tmp_dir/sbatch.rows" &
  phi_tool container.docker docker docker --version >"$phi_tmp_dir/docker.rows" &
  phi_tool container.singularity singularity singularity --version >"$phi_tmp_dir/singularity.rows" &
  phi_tool container.apptainer apptainer apptainer --version >"$phi_tmp_dir/apptainer.rows" &
  phi_tool container.podman podman podman --version >"$phi_tmp_dir/podman.rows" &
  phi_module >"$phi_tmp_dir/module.rows" &
  wait
  for phi_rows in git nextflow java conda sbatch docker singularity apptainer podman module; do
    if test -f "$phi_tmp_dir/$phi_rows.rows"; then
      cat "$phi_tmp_dir/$phi_rows.rows"
    fi
  done
else
  for phi_key in git nextflow java conda sbatch container.docker container.singularity container.apptainer container.podman module; do
    phi_emit "tool.$phi_key.available" unknown
  done
fi

phi_emit probe.slow_complete 1
printf '%s\\n' '${SLOW_PROBE_END_SENTINEL}'
`

export const HOST_CAPABILITY_PROBE_SCRIPT = `${HOST_CAPABILITY_FAST_PROBE_SCRIPT}
${HOST_CAPABILITY_SLOW_PROBE_SCRIPT}`
