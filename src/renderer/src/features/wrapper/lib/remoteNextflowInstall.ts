import type {
  RemoteDoctorOptions,
  RemoteDoctorReport,
  RemoteNextflowInstallResult
} from '../../../../../shared/remoteDoctorTypes'

interface RemoteNextflowInstallFlowInput {
  hostProfileId: string
  projectRoot: string
  doctorOptions: RemoteDoctorOptions
}

interface RemoteNextflowInstallFlowDependencies {
  install: (hostProfileId: string) => Promise<RemoteNextflowInstallResult>
  probe: (
    hostProfileId: string,
    projectRoot: string,
    options: RemoteDoctorOptions
  ) => Promise<RemoteDoctorReport>
  onInstalled?: (result: RemoteNextflowInstallResult) => void
}

interface RemoteNextflowInstallFlowResult {
  installResult: RemoteNextflowInstallResult
  report: RemoteDoctorReport
}

/** The explicit install action always refreshes the capability profile for its exact project root. */
export async function installRemoteNextflowAndRefreshProfile(
  input: RemoteNextflowInstallFlowInput,
  dependencies: RemoteNextflowInstallFlowDependencies
): Promise<RemoteNextflowInstallFlowResult> {
  const installResult = await dependencies.install(input.hostProfileId)
  dependencies.onInstalled?.(installResult)
  const report = await dependencies.probe(input.hostProfileId, input.projectRoot, {
    ...input.doctorOptions,
    nextflowBin: installResult.path,
    refreshCapabilities: true
  })
  return { installResult, report }
}
