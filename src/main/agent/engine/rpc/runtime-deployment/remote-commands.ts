import { posix } from 'node:path'
import { shellQuote } from '../../../wrappers/remote-ssh-session'
import type { WorkspaceHost } from '../../../workspace-host/types'
import {
  deploymentReadyMarkerCheckCommand,
  deploymentReadyMarkerPath,
  remoteOmpReadyMarkerIdentity,
  serializeDeploymentReadyMarker
} from '../deployment-ready-marker'
import {
  RemoteOmpDeploymentError,
  type DeploymentErrorCode,
  type RemoteOmpDeployment
} from './types'

export interface DeploymentPaths {
  root: string
  directory: string
  executable: string
  staging: string
  readyMarker: string
  home: string
  agentDir: string
}

export function deploymentPaths(root: string, version: string, sha256: string): DeploymentPaths {
  if (
    !posix.isAbsolute(root) ||
    root === '/' ||
    /[\0\r\n]/.test(root) ||
    posix.normalize(root) !== root
  ) {
    throw new RemoteOmpDeploymentError(
      'INVALID_ARGUMENT',
      'Choose an absolute, canonical server runtime root.'
    )
  }
  const directory = posix.join(root, 'omp', version)
  const home = posix.join(root, 'omp-home')
  return {
    root,
    directory,
    executable: posix.join(directory, 'omp'),
    staging: posix.join(directory, `.omp-${sha256}.staging`),
    readyMarker: deploymentReadyMarkerPath(directory),
    home,
    agentDir: posix.join(home, 'agent')
  }
}

const SHELL_FUNCTIONS = `set -eu
fail() { printf 'PHI_OMP:%s:%s\\n' "$1" "$2" >&2; exit 1; }
safe_dir() {
  [ ! -L "$1" ] || fail PERMISSION_DENIED "Runtime path is a symbolic link: $1"
  mkdir -p -- "$1" || fail PERMISSION_DENIED "Cannot create runtime directory: $1"
  [ -d "$1" ] && [ -w "$1" ] && [ -x "$1" ] || fail PERMISSION_DENIED "Runtime directory is not writable/executable: $1"
}
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1";
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1";
  else fail REMOTE_COMMAND_FAILED "Server requires sha256sum or shasum"; fi
}
umask 077`

function prefix(paths: DeploymentPaths): string {
  return `${SHELL_FUNCTIONS}\n[ "$(pwd -P)" = ${shellQuote(paths.root)} ] || fail INVALID_ARGUMENT "Runtime root must be canonical and match the host root"`
}

function versionCommand(paths: DeploymentPaths, executable: string): string {
  // A bare --version must never discover user OMP configuration or provider credentials.
  return `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=${shellQuote(paths.home)} PI_CODING_AGENT_DIR=${shellQuote(paths.agentDir)} ${shellQuote(executable)} --version`
}

function versionCheck(paths: DeploymentPaths, executable: string, version: string): string {
  return `reported=$(${versionCommand(paths, executable)}) || fail REMOTE_COMMAND_FAILED "OMP --version failed; check server glibc and noexec mount options"
case "$reported" in ${shellQuote(version)}|${shellQuote(`omp/${version}`)}) ;; *) fail VERSION_MISMATCH "OMP reported unexpected version: $reported" ;; esac`
}

export function prepareCommand(paths: DeploymentPaths): string {
  return `${prefix(paths)}
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail REMOTE_COMMAND_FAILED "Server requires sha256sum or shasum"
safe_dir ${shellQuote(posix.join(paths.root, 'omp'))}
safe_dir ${shellQuote(paths.directory)}
safe_dir ${shellQuote(paths.home)}
safe_dir ${shellQuote(paths.agentDir)}
chmod 700 ${shellQuote(posix.join(paths.root, 'omp'))} ${shellQuote(paths.directory)} ${shellQuote(paths.home)} ${shellQuote(paths.agentDir)}
[ ! -L ${shellQuote(paths.executable)} ] && [ ! -d ${shellQuote(paths.executable)} ] || fail PERMISSION_DENIED "OMP destination is not a regular file"
[ ! -L ${shellQuote(paths.staging)} ] && [ ! -d ${shellQuote(paths.staging)} ] || fail PERMISSION_DENIED "OMP staging destination is not a regular file"`
}

export function reuseCommand(paths: DeploymentPaths, sha256: string, version: string): string {
  return `${prefix(paths)}
${deploymentReadyMarkerCheckCommand(
  paths.readyMarker,
  remoteOmpReadyMarkerIdentity(version, sha256),
  'PHI_OMP_REUSABLE'
)}`
}

export function spaceCommand(paths: DeploymentPaths, size: number): string {
  const requiredKiB = Math.ceil((size * 2 + 1024 * 1024) / 1024)
  return `${prefix(paths)}
available=$(df -Pk ${shellQuote(paths.directory)} | awk 'NR==2 {print $4}')
case "$available" in ''|*[!0-9]*) fail REMOTE_COMMAND_FAILED "Cannot determine runtime disk space" ;; esac
[ "$available" -ge ${requiredKiB} ] || fail INSUFFICIENT_SPACE "Runtime root needs ${requiredKiB} KiB free for OMP staging"`
}

export function activateCommand(paths: DeploymentPaths, sha256: string, version: string): string {
  const marker = serializeDeploymentReadyMarker(remoteOmpReadyMarkerIdentity(version, sha256))
  return `${prefix(paths)}
[ -f ${shellQuote(paths.staging)} ] && [ ! -L ${shellQuote(paths.staging)} ] || fail HASH_MISMATCH "Uploaded OMP staging file is missing or not regular"
actual=$(hash_file ${shellQuote(paths.staging)})
case "$actual" in ${shellQuote(sha256)}' '*) ;; *) fail HASH_MISMATCH "Uploaded OMP SHA256 does not match the release manifest" ;; esac
chmod 700 ${shellQuote(paths.staging)}
${versionCheck(paths, paths.staging, version)}
[ ! -L ${shellQuote(paths.executable)} ] && [ ! -d ${shellQuote(paths.executable)} ] || fail PERMISSION_DENIED "OMP destination changed during deployment"
mv -f -- ${shellQuote(paths.staging)} ${shellQuote(paths.executable)}
marker_tmp=${shellQuote(`${paths.readyMarker}.tmp-`)}$$
rm -f -- "$marker_tmp" || fail PERMISSION_DENIED "Cannot clear OMP ready marker staging"
(umask 077; printf '%s' ${shellQuote(marker)} > "$marker_tmp") || fail PERMISSION_DENIED "Cannot stage OMP ready marker"
[ -f "$marker_tmp" ] && [ ! -L "$marker_tmp" ] || fail PERMISSION_DENIED "OMP ready marker staging is not a regular file"
marker_owner=$(stat -c %u -- "$marker_tmp" 2>/dev/null || stat -f %u "$marker_tmp")
[ "$marker_owner" = "$(id -u)" ] || fail PERMISSION_DENIED "OMP ready marker staging has another owner"
chmod 600 "$marker_tmp" || fail PERMISSION_DENIED "Cannot make OMP ready marker private"
[ ! -d ${shellQuote(paths.readyMarker)} ] || [ -L ${shellQuote(paths.readyMarker)} ] || fail PERMISSION_DENIED "OMP ready marker destination is a directory"
mv -f -- "$marker_tmp" ${shellQuote(paths.readyMarker)} || fail PERMISSION_DENIED "Cannot publish OMP ready marker"`
}

export async function runDeploymentCommand(
  host: WorkspaceHost,
  paths: DeploymentPaths,
  command: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  const result = await host.exec.run(['sh', '-c', command], {
    cwd: paths.root,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024,
    signal
  })
  signal?.throwIfAborted()
  if (result.code !== 0 || result.truncated || result.terminationReason) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      result.terminationReason ||
      'remote command failed'
    const marked = detail.match(/PHI_OMP:([A-Z_]+):/)
    const code: DeploymentErrorCode = /no space left|disk quota/i.test(detail)
      ? 'INSUFFICIENT_SPACE'
      : marked
        ? (marked[1] as DeploymentErrorCode)
        : /permission denied|read-only file system/i.test(detail)
          ? 'PERMISSION_DENIED'
          : 'REMOTE_COMMAND_FAILED'
    throw new RemoteOmpDeploymentError(
      code,
      `${detail}. Check the server runtime root setting (${paths.root}).`
    )
  }
  return result.stdout
}

export function deploymentResult(
  paths: DeploymentPaths,
  version: string,
  reused: boolean
): RemoteOmpDeployment {
  return {
    version,
    executablePath: paths.executable,
    homePath: paths.home,
    agentDir: paths.agentDir,
    reused
  }
}
