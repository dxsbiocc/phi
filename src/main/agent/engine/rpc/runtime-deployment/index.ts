export { ensureRemoteOmpDeployment } from './deployment'
export { REMOTE_OMP_MANIFEST, selectRemoteOmpAsset } from './manifest'
export { RemoteOmpDeploymentError } from './types'
export {
  DEPLOYMENT_READY_MARKER_FILENAME,
  deploymentReadyMarkerCheckCommand,
  deploymentReadyMarkerPath,
  remoteOmpReadyMarkerIdentity,
  serializeDeploymentReadyMarker
} from '../deployment-ready-marker'
export type {
  RemoteOmpAsset,
  RemoteOmpManifest,
  RemoteOmpDeployment,
  RemoteOmpDeploymentOptions,
  RemoteOmpDeploymentProgress
} from './types'
export type { RemoteOmpDownloadProgress } from './artifact-cache'
