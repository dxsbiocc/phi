import { posix } from 'node:path'

import { shellQuote } from '../../../wrappers/remote-ssh-session'
import {
  deploymentReadyMarkerCheckCommand,
  deploymentReadyMarkerPath,
  phiKernelReadyMarkerIdentity,
  writeDeploymentReadyMarkerCommand
} from '../../rpc/deployment-ready-marker'
import { deploymentShellFunctions } from '../../rpc/runtime-deployment/remote-commands'
import type { KernelBuildManifestFile, RemoteKernelProfile, RemoteKernelVariant } from './types'

export interface RemoteKernelPaths {
  readonly root: string
  readonly kernelRoot: string
  readonly directory: string
  readonly executable: string
  readonly nativeByVariant: Readonly<Record<RemoteKernelVariant, string>>
  readonly stagingKernel: string
  readonly stagingNativeByVariant: Readonly<Record<RemoteKernelVariant, string>>
  readonly readyMarker: string
  readonly home: string
  readonly agentDir: string
}

export function remoteKernelPaths(
  root: string,
  phiVersion: string,
  kernel: KernelBuildManifestFile,
  natives: Readonly<Record<RemoteKernelVariant, KernelBuildManifestFile>>
): RemoteKernelPaths {
  const kernelRoot = posix.join(root, 'kernel')
  const directory = posix.join(kernelRoot, phiVersion, kernel.sha256)
  return {
    root,
    kernelRoot,
    directory,
    executable: posix.join(directory, kernel.name),
    nativeByVariant: {
      modern: posix.join(directory, natives.modern.name),
      baseline: posix.join(directory, natives.baseline.name)
    },
    stagingKernel: posix.join(directory, `.${kernel.name}.${kernel.sha256}.staging`),
    stagingNativeByVariant: {
      modern: posix.join(directory, `.${natives.modern.name}.${natives.modern.sha256}.staging`),
      baseline: posix.join(
        directory,
        `.${natives.baseline.name}.${natives.baseline.sha256}.staging`
      )
    },
    readyMarker: deploymentReadyMarkerPath(directory),
    home: posix.join(root, 'kernel-home'),
    agentDir: posix.join(root, 'kernel-home', 'agent')
  }
}

/** The compiled kernel and its native addon need GLIBC_2.17 (checked in K0-4 on node3). */
export const GLIBC_MINIMUM_CHECK = `glibc_major=\${glibc_version%%.*}
glibc_rest=\${glibc_version#*.}
glibc_minor=\${glibc_rest%%[!0-9]*}
case "$glibc_major" in ''|*[!0-9]*) fail UNSUPPORTED_PLATFORM "Cannot read the glibc version: $glibc_version" ;; esac
case "$glibc_minor" in ''|*[!0-9]*) fail UNSUPPORTED_PLATFORM "Cannot read the glibc version: $glibc_version" ;; esac
if [ "$glibc_major" -lt 2 ] || { [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt 17 ]; }; then
  fail UNSUPPORTED_PLATFORM "Remote kernel requires glibc 2.17 or newer; detected $glibc_version"
fi`

const SHELL_FUNCTIONS = deploymentShellFunctions('PHI_KERNEL')

function prefix(paths: RemoteKernelPaths): string {
  return `${SHELL_FUNCTIONS}
[ "$(pwd -P)" = ${shellQuote(paths.root)} ] || fail INVALID_ARGUMENT "Runtime root must be canonical and match the host root"`
}

export function probePrepareReuseCommand(
  paths: RemoteKernelPaths,
  phiVersion: string,
  kernel: KernelBuildManifestFile,
  natives: Readonly<Record<RemoteKernelVariant, KernelBuildManifestFile>>
): string {
  const largestNative = Math.max(natives.modern.size, natives.baseline.size)
  const requiredKiB = Math.ceil(((kernel.size + largestNative) * 2 + 1024 * 1024) / 1024)
  return `${prefix(paths)}
remote_os=$(uname -s 2>/dev/null || true)
remote_arch=$(uname -m 2>/dev/null || true)
[ "$remote_os" = Linux ] || fail UNSUPPORTED_PLATFORM "Remote kernel requires Linux x64 with glibc; detected $remote_os/$remote_arch"
case "$remote_arch" in x86_64|amd64) ;; *) fail UNSUPPORTED_PLATFORM "Remote kernel requires Linux x64 with glibc; detected $remote_os/$remote_arch" ;; esac
glibc_info=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
case "$glibc_info" in
  glibc\\ *) glibc_version=$(printf '%s' "$glibc_info" | awk '{print $2}') ;;
  *)
    ldd_info=$(ldd --version 2>&1 | sed -n '1p' || true)
    case "$ldd_info" in *musl*|*Musl*|'') fail UNSUPPORTED_PLATFORM "Remote kernel requires glibc" ;; esac
    case "$ldd_info" in *GLIBC*|*glibc*|*GNU*) glibc_version=$(printf '%s' "$ldd_info" | awk '{print $NF}') ;; *) fail UNSUPPORTED_PLATFORM "Remote kernel requires glibc" ;; esac ;;
esac
${GLIBC_MINIMUM_CHECK}
if grep -Eiq '(^|[[:space:]])avx2([[:space:]]|$)' /proc/cpuinfo 2>/dev/null; then variant=modern; else variant=baseline; fi
safe_dir ${shellQuote(paths.kernelRoot)}
safe_dir ${shellQuote(posix.join(paths.kernelRoot, phiVersion))}
safe_dir ${shellQuote(paths.directory)}
safe_dir ${shellQuote(paths.home)}
safe_dir ${shellQuote(paths.agentDir)}
chmod 700 ${shellQuote(paths.kernelRoot)} ${shellQuote(posix.join(paths.kernelRoot, phiVersion))} ${shellQuote(paths.directory)} ${shellQuote(paths.home)} ${shellQuote(paths.agentDir)}
case "$variant" in
  modern)
    expected_kernel=${shellQuote(paths.executable)}
    expected_native=${shellQuote(paths.nativeByVariant.modern)} ;;
  baseline)
    expected_kernel=${shellQuote(paths.executable)}
    expected_native=${shellQuote(paths.nativeByVariant.baseline)} ;;
esac
printf 'PHI_KERNEL_PROFILE:linux:x64:glibc:%s:%s\\n' "${'$'}{glibc_version:-unknown}" "$variant"
marker_status=
if [ -f "$expected_kernel" ] && [ ! -L "$expected_kernel" ] && [ -x "$expected_kernel" ] && [ -f "$expected_native" ] && [ ! -L "$expected_native" ]; then
  case "$variant" in
    modern) marker_status=$(
${deploymentReadyMarkerCheckCommand(
  paths.readyMarker,
  phiKernelReadyMarkerIdentity(phiVersion, kernel.sha256, natives.modern.sha256, 'modern'),
  'PHI_KERNEL_REUSABLE'
)}
    ) ;;
    baseline) marker_status=$(
${deploymentReadyMarkerCheckCommand(
  paths.readyMarker,
  phiKernelReadyMarkerIdentity(phiVersion, kernel.sha256, natives.baseline.sha256, 'baseline'),
  'PHI_KERNEL_REUSABLE'
)}
    ) ;;
  esac
fi
if [ "$marker_status" = PHI_KERNEL_REUSABLE ]; then printf 'PHI_KERNEL_REUSABLE\\n'; exit 0; fi
rm -f -- ${shellQuote(paths.readyMarker)} || fail PERMISSION_DENIED "Cannot clear stale kernel ready marker"
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail REMOTE_COMMAND_FAILED "Server requires sha256sum or shasum"
available=$(df -Pk ${shellQuote(paths.directory)} | awk 'NR==2 {print $4}')
case "$available" in ''|*[!0-9]*) fail REMOTE_COMMAND_FAILED "Cannot determine runtime disk space" ;; esac
[ "$available" -ge ${requiredKiB} ] || fail INSUFFICIENT_SPACE "Runtime root needs ${requiredKiB} KiB free for kernel staging"
printf 'PHI_KERNEL_DEPLOY\\n'`
}

export function activateKernelCommand(
  paths: RemoteKernelPaths,
  phiVersion: string,
  kernel: KernelBuildManifestFile,
  selectedNative: KernelBuildManifestFile,
  variant: RemoteKernelVariant
): string {
  const nativeStaging = paths.stagingNativeByVariant[variant]
  const nativePath = paths.nativeByVariant[variant]
  const otherVariant = variant === 'modern' ? 'baseline' : 'modern'
  return `${prefix(paths)}
[ -f ${shellQuote(paths.stagingKernel)} ] && [ ! -L ${shellQuote(paths.stagingKernel)} ] || fail HASH_MISMATCH "Uploaded kernel staging file is missing or not regular"
[ -f ${shellQuote(nativeStaging)} ] && [ ! -L ${shellQuote(nativeStaging)} ] || fail HASH_MISMATCH "Uploaded native staging file is missing or not regular"
actual_kernel=$(hash_file ${shellQuote(paths.stagingKernel)} | awk '{print $1}')
[ "$actual_kernel" = ${shellQuote(kernel.sha256)} ] || fail HASH_MISMATCH "Uploaded kernel SHA256 does not match its manifest"
actual_native=$(hash_file ${shellQuote(nativeStaging)} | awk '{print $1}')
[ "$actual_native" = ${shellQuote(selectedNative.sha256)} ] || fail HASH_MISMATCH "Uploaded native SHA256 does not match its manifest"
chmod 700 ${shellQuote(paths.stagingKernel)}
chmod 600 ${shellQuote(nativeStaging)}
[ ! -L ${shellQuote(paths.executable)} ] && [ ! -d ${shellQuote(paths.executable)} ] || fail PERMISSION_DENIED "Kernel destination changed during deployment"
[ ! -L ${shellQuote(nativePath)} ] && [ ! -d ${shellQuote(nativePath)} ] || fail PERMISSION_DENIED "Native destination changed during deployment"
mv -f -- ${shellQuote(paths.stagingKernel)} ${shellQuote(paths.executable)}
mv -f -- ${shellQuote(nativeStaging)} ${shellQuote(nativePath)}
rm -f -- ${shellQuote(paths.nativeByVariant[otherVariant])}
${writeDeploymentReadyMarkerCommand(
  paths.readyMarker,
  phiKernelReadyMarkerIdentity(phiVersion, kernel.sha256, selectedNative.sha256, variant),
  'fail PERMISSION_DENIED'
)}`
}

export function cleanupKernelStagingCommand(
  paths: RemoteKernelPaths,
  variant: RemoteKernelVariant
): string {
  return `rm -f -- ${shellQuote(paths.stagingKernel)} ${shellQuote(paths.stagingNativeByVariant[variant])} ${shellQuote(paths.readyMarker)}`
}

export function parseKernelProbeOutput(output: string): {
  profile: RemoteKernelProfile
  reused: boolean
} {
  const match = output.match(/^PHI_KERNEL_PROFILE:linux:x64:glibc:([^:\r\n]+):(modern|baseline)$/m)
  if (
    !match ||
    (!output.includes('PHI_KERNEL_REUSABLE') && !output.includes('PHI_KERNEL_DEPLOY'))
  ) {
    throw new Error('Remote kernel probe returned an invalid response.')
  }
  return {
    profile: {
      os: 'linux',
      arch: 'x64',
      libc: 'glibc',
      ...(match[1] === 'unknown' ? {} : { glibcVersion: match[1] }),
      variant: match[2] as RemoteKernelVariant
    },
    reused: output.includes('PHI_KERNEL_REUSABLE')
  }
}
