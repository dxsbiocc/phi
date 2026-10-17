import { posix } from 'node:path'
import { shellQuote } from '../../wrappers/remote-ssh-session'

export const DEPLOYMENT_READY_MARKER_FILENAME = '.phi-ready.json'
export const DEPLOYMENT_READY_MARKER_SCHEMA = 1 as const

export interface RemoteOmpReadyMarkerIdentity {
  readonly schema: typeof DEPLOYMENT_READY_MARKER_SCHEMA
  readonly kind: 'remote-omp'
  readonly version: string
  readonly sha256: string
}

export interface PhiExtensionReadyMarkerIdentity {
  readonly schema: typeof DEPLOYMENT_READY_MARKER_SCHEMA
  readonly kind: 'phi-extension'
  readonly contentHash: string
}

export type DeploymentReadyMarkerIdentity =
  RemoteOmpReadyMarkerIdentity | PhiExtensionReadyMarkerIdentity

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid deployment ready marker hash')
}

export function remoteOmpReadyMarkerIdentity(
  version: string,
  sha256: string
): RemoteOmpReadyMarkerIdentity {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid remote OMP marker version')
  assertSha256(sha256)
  return { schema: DEPLOYMENT_READY_MARKER_SCHEMA, kind: 'remote-omp', version, sha256 }
}

export function phiExtensionReadyMarkerIdentity(
  contentHash: string
): PhiExtensionReadyMarkerIdentity {
  assertSha256(contentHash)
  return { schema: DEPLOYMENT_READY_MARKER_SCHEMA, kind: 'phi-extension', contentHash }
}

export function deploymentReadyMarkerPath(directory: string): string {
  if (
    !posix.isAbsolute(directory) ||
    directory === '/' ||
    posix.normalize(directory) !== directory ||
    /[\0\r\n]/.test(directory)
  ) {
    throw new Error('Invalid deployment ready marker directory')
  }
  return posix.join(directory, DEPLOYMENT_READY_MARKER_FILENAME)
}

export function serializeDeploymentReadyMarker(identity: DeploymentReadyMarkerIdentity): string {
  return JSON.stringify(identity)
}

export function deploymentReadyMarkerCheckCommand(
  path: string,
  identity: DeploymentReadyMarkerIdentity,
  successToken: string
): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(successToken)) throw new Error('Invalid ready marker token')
  const expected = serializeDeploymentReadyMarker(identity)
  return `ready_marker_valid() (
  [ -f ${shellQuote(path)} ] && [ ! -L ${shellQuote(path)} ] || exit 1
  marker_owner=$(stat -c %u -- ${shellQuote(path)} 2>/dev/null || stat -f %u ${shellQuote(path)})
  [ "$marker_owner" = "$(id -u)" ] || exit 1
  marker_mode=$(stat -c %a -- ${shellQuote(path)} 2>/dev/null || stat -f %Lp ${shellQuote(path)})
  [ "$marker_mode" = 600 ] || exit 1
  marker_links=$(stat -c %h -- ${shellQuote(path)} 2>/dev/null || stat -f %l ${shellQuote(path)})
  [ "$marker_links" = 1 ] || exit 1
  marker_size=$(wc -c < ${shellQuote(path)} | tr -d ' ')
  [ "$marker_size" = ${shellQuote(String(Buffer.byteLength(expected)))} ] || exit 1
  [ "$(cat ${shellQuote(path)})" = ${shellQuote(expected)} ] || exit 1
)
if ready_marker_valid; then printf '${successToken}\\n'; fi`
}

export function writeDeploymentReadyMarkerCommand(
  path: string,
  identity: DeploymentReadyMarkerIdentity,
  failCommand: 'fail' | 'fail PERMISSION_DENIED' = 'fail'
): string {
  const content = serializeDeploymentReadyMarker(identity)
  const fail = (message: string): string => `${failCommand} ${shellQuote(message)}`
  return `marker_tmp=${shellQuote(`${path}.tmp-`)}$$
rm -f -- "$marker_tmp" || ${fail('Cannot clear ready marker staging')}
(umask 077; printf '%s' ${shellQuote(content)} > "$marker_tmp") || ${fail('Cannot stage ready marker')}
[ -f "$marker_tmp" ] && [ ! -L "$marker_tmp" ] || ${fail('Ready marker staging is not a regular file')}
marker_owner=$(stat -c %u -- "$marker_tmp" 2>/dev/null || stat -f %u "$marker_tmp")
[ "$marker_owner" = "$(id -u)" ] || ${fail('Ready marker staging has another owner')}
marker_links=$(stat -c %h -- "$marker_tmp" 2>/dev/null || stat -f %l "$marker_tmp")
[ "$marker_links" = 1 ] || ${fail('Ready marker staging has multiple links')}
chmod 600 "$marker_tmp" || ${fail('Cannot make ready marker private')}
[ ! -d ${shellQuote(path)} ] || [ -L ${shellQuote(path)} ] || ${fail('Ready marker destination is a directory')}
mv -f -- "$marker_tmp" ${shellQuote(path)} || ${fail('Cannot publish ready marker')}`
}
